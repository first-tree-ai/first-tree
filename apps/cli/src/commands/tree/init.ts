import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

import {
  type ContextTreeActiveBinding,
  type ContextTreeProvider,
  canonicalGitRepoUrl,
  classifyContextTreeSetting,
  contextTreeActiveBindingSchema,
  contextTreeBranchSchema,
  contextTreeInstallationInfoResponseSchema,
  sameContextTreeRepository,
} from "@first-tree/shared";
import type { Command } from "commander";
import { accessTokenForOrigin } from "../../core/access-token.js";
import { resolveServerUrl } from "../../core/bootstrap.js";
import { channelConfig } from "../../core/channel.js";
import { cliFetch } from "../../core/cli-fetch.js";
import {
  adoptContextTreeRemote,
  createContextTreeRemote,
  resolveContextTreeForgeCoordinate,
  verifyContextTreeForgeAuth,
} from "../../core/context-tree-forge/index.js";
import {
  type ContextTreeSeedAuthorityReader,
  type ContextTreeSeedPreflight,
  ContextTreeSeedPreflightCliError,
  preflightContextTreeSeed,
} from "../../core/context-tree-seed.js";
import { CredentialOriginMismatchError } from "../../core/credential-origin.js";
import { createMemberSdk } from "../_shared/member.js";
import type { CommandContext, SubcommandModule } from "../types.js";
import {
  memberNodeContent,
  membersIndexContent,
  rootNodeContent,
  validateTreeWorkflowContent,
} from "./scaffold-templates.js";
import { ensureTrailingNewline, runCommand } from "./shared.js";
import { type VerifySummary, verifyTreeRoot } from "./verify.js";

const REPO_SUFFIX = "-context-tree";
const GITHUB_REPO_NAME_MAX_LENGTH = 100;
const DEFAULT_BRANCH = "main";

export type TreeInitOptions = {
  provider?: ContextTreeProvider;
  repo?: string;
  branch?: string;
  create: boolean;
  adopt: boolean;
  owner?: string;
  name?: string;
  title?: string;
  public: boolean;
  dir?: string;
  withWorkflow: boolean;
  bind: boolean;
  rebind: boolean;
  org?: string;
  team?: string;
};

export type ScaffoldFile = { relPath: string; content: string };

// Mirror the server's `slugifyRepoBase` byte-for-byte (NFKD strip + hyphenate +
// collapse), including the `team` fallback, so agent-created and Cloud-created
// trees derive the same repo name from the same team name.
function slugifyRepoBase(value: string): string {
  const ascii = value.normalize("NFKD").replace(/[̀-ͯ]/gu, "");
  const slug = ascii
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .replace(/-{2,}/gu, "-");
  return slug || "team";
}

/**
 * `<slug>-context-tree`, capped at GitHub's 100-char repo-name limit. Mirrors
 * the server-side `contextTreeRepoName` so agent-created and Cloud-created trees
 * are named identically.
 */
export function defaultRepoName(title: string): string {
  const maxBaseLength = GITHUB_REPO_NAME_MAX_LENGTH - REPO_SUFFIX.length;
  const base = slugifyRepoBase(title).slice(0, maxBaseLength).replace(/-+$/gu, "") || "team";
  return `${base}${REPO_SUFFIX}`;
}

/**
 * The minimal file set that makes a fresh tree pass `first-tree tree verify`:
 * a root `NODE.md`, the `members/` domain index, and one member node for the
 * creator (verify hard-fails on a `members/` dir with no member nodes). The node
 * bodies are rendered from `./templates/*.ejs` (see `scaffold-templates.ts`).
 */
export function buildScaffoldFiles(opts: {
  title: string;
  ownerLogin: string;
  withWorkflow: boolean;
  branch?: string;
}): ScaffoldFile[] {
  const files: ScaffoldFile[] = [
    { relPath: "NODE.md", content: rootNodeContent(opts.title, opts.ownerLogin) },
    { relPath: join("members", "NODE.md"), content: membersIndexContent(opts.ownerLogin) },
    { relPath: join("members", opts.ownerLogin, "NODE.md"), content: memberNodeContent(opts.ownerLogin) },
  ];
  if (opts.withWorkflow) {
    files.push({
      relPath: join(".github", "workflows", "validate-tree.yml"),
      content: validateTreeWorkflowContent(opts.branch ?? DEFAULT_BRANCH),
    });
  }
  return files;
}

function writeScaffold(dir: string, files: ScaffoldFile[]): void {
  for (const file of files) {
    const abs = join(dir, file.relPath);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, ensureTrailingNewline(file.content.trimEnd()));
  }
}

function collectVerifyErrors(summary: VerifySummary): string[] {
  return Object.values(summary.checks).flatMap((check) => check.errors ?? []);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function ensureToolAvailable(tool: string): void {
  try {
    runCommand(tool, ["--version"], process.cwd());
  } catch {
    throw new Error(`\`${tool}\` is required but was not found on PATH. Install it and try again.`);
  }
}

function ensureGhAuthenticated(): void {
  try {
    runCommand("gh", ["auth", "status"], process.cwd());
  } catch {
    throw new Error("GitHub CLI is not authenticated. Run `gh auth login` and try again.");
  }
}

function ghApiText(args: string[]): string {
  return runCommand("gh", ["api", ...args], process.cwd());
}

function ghApiJson(endpoint: string): Record<string, unknown> {
  const raw = ghApiText([endpoint]);
  const parsed: unknown = JSON.parse(raw);
  if (!isRecord(parsed)) {
    throw new Error(`Unexpected GitHub API response for ${endpoint}`);
  }
  return parsed;
}

function canonicalizeGithubOwnerLogin(owner: string): string {
  try {
    const login = ghApiText([`users/${encodeURIComponent(owner)}`, "--jq", ".login"]).trim();
    if (!login) {
      throw new Error("empty login");
    }
    return login;
  } catch {
    throw new Error(`Could not resolve the canonical GitHub login for ${owner}.`);
  }
}

type BindContext = { orgId: string; isAdmin: boolean };

// Resolve the org to bind AND whether the caller administers it, from a single
// `/me` read. Binding (`settings/context_tree`) is admin-only, so knowing this
// up front lets the command fail before it creates any remote GitHub state.
async function resolveBindContext(serverUrl: string, accessToken: string, override?: string): Promise<BindContext> {
  const res = await cliFetch(`${serverUrl}/api/v1/me`, {
    headers: { Authorization: `Bearer ${accessToken}` },
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) {
    throw new Error(`server returned ${res.status} on /me while resolving the org to bind`);
  }
  const me = (await res.json()) as {
    memberships?: Array<{ organizationId: string; role?: string }>;
    defaultOrganizationId?: string | null;
  };
  const memberships = me.memberships ?? [];

  const explicit = override?.trim();
  let orgId: string;
  if (explicit) {
    orgId = explicit;
  } else if (me.defaultOrganizationId && memberships.some((m) => m.organizationId === me.defaultOrganizationId)) {
    orgId = me.defaultOrganizationId;
  } else if (memberships.length === 1 && memberships[0]) {
    orgId = memberships[0].organizationId;
  } else if (memberships.length === 0) {
    throw new Error("You don't belong to any organization; nothing to bind the tree to.");
  } else {
    throw new Error("Multiple organizations — pass --org <orgId> explicitly or set a default in the web UI first.");
  }

  const membership = memberships.find((m) => m.organizationId === orgId);
  return { orgId, isAdmin: membership?.role === "admin" };
}

type CoverageStatus = "guided" | "no_installation" | "suspended" | "lookup_failed";

type CoverageResult = {
  status: CoverageStatus;
  appSettingsUrl: string | null;
  note: string;
};

function appInstallationSettingsUrl(installation: {
  installationId: number;
  accountLogin: string;
  accountType: string;
}): string {
  // GitHub's "configure installation" page — where a repo-admin edits which
  // repositories a selected-repositories installation can access.
  return installation.accountType === "Organization"
    ? `https://github.com/organizations/${installation.accountLogin}/settings/installations/${installation.installationId}`
    : `https://github.com/settings/installations/${installation.installationId}`;
}

type InstallationInfo = { installationId: number; accountLogin: string; accountType: string; suspended: boolean };
type InstallationLookup = { kind: "ok"; data: InstallationInfo } | { kind: "none" } | { kind: "error"; status: number };

// Never throws: a network/timeout/parse failure returns `{ kind: "error" }` so
// the caller decides (bound path fails closed rather than guessing the owner; a
// pure informational read would degrade to a note).
async function fetchInstallation(serverUrl: string, accessToken: string, orgId: string): Promise<InstallationLookup> {
  let res: Response;
  try {
    res = await cliFetch(`${serverUrl}/api/v1/orgs/${encodeURIComponent(orgId)}/context-tree/installation`, {
      headers: { Authorization: `Bearer ${accessToken}` },
      signal: AbortSignal.timeout(10_000),
    });
  } catch (error) {
    // A credential-origin refusal is not a transient read failure; the caller
    // must surface it instead of degrading to "installation unknown" (SEC-023).
    if (error instanceof CredentialOriginMismatchError) throw error;
    return { kind: "error", status: 0 };
  }
  if (res.status === 404) {
    try {
      const body: unknown = await res.json();
      if (body && typeof body === "object" && "code" in body && body.code === "no_installation") {
        return { kind: "none" };
      }
    } catch {
      // An unrelated or malformed 404 must remain fail-closed.
    }
    return { kind: "error", status: res.status };
  }
  if (!res.ok) {
    return { kind: "error", status: res.status };
  }
  try {
    return { kind: "ok", data: contextTreeInstallationInfoResponseSchema.parse(await res.json()) };
  } catch {
    return { kind: "error", status: res.status };
  }
}

/**
 * The tree repo must live under the *same GitHub account as the App
 * installation* — an installation is scoped to one account, so a repo under any
 * other account can never be covered (not even by an all-repositories install).
 * In the bound path we therefore default the owner to the installation account
 * and reject a mismatching `--owner`. Only `--no-bind` / no-installation flows
 * fall back to the local `gh` user, where the repo is explicitly unverified.
 */
export function resolveRepoOwner(args: {
  optionOwner?: string;
  creatorLogin: string;
  installationAccount: string | null;
}): string {
  const explicit = args.optionOwner?.trim();
  if (args.installationAccount) {
    // GitHub account names are case-insensitive, so compare case-folded; always
    // return the installation account's canonical casing.
    if (explicit && explicit.toLowerCase() !== args.installationAccount.toLowerCase()) {
      throw new Error(
        `--owner ${explicit} does not match this team's GitHub App installation account (${args.installationAccount}). The tree repo must live under ${args.installationAccount} so the App can cover it — omit --owner to use it, or pass --no-bind to create it elsewhere without binding.`,
      );
    }
    return args.installationAccount;
  }
  return explicit || args.creatorLogin;
}

/**
 * Web snapshots and the Context Tree reviewer read the tree through the team's
 * GitHub App installation, so a newly created repo must be within its reach.
 * When the App itself creates a repo (via its installation token) GitHub
 * auto-attaches it — but `tree init` creates the repo as the *user* with local
 * `gh`, so a *selected-repositories* installation does NOT auto-cover it. Neither
 * the App (no self-add API) nor the local `gh` token (not authorized for this App
 * — `/user/installations/*` returns 403) can add it programmatically, so the
 * reliable path is explicit guidance: point the admin at the installation
 * settings page to include the repo. All-repositories installations already cover
 * it. This never fails the command — the repo is created and bound regardless.
 */
function buildCoverage(lookup: InstallationLookup, repoFullName: string): CoverageResult {
  if (lookup.kind === "none") {
    return {
      status: "no_installation",
      appSettingsUrl: null,
      note: `No GitHub App installation is connected for this team yet — web snapshots and the Context Tree reviewer will not see ${repoFullName} until an admin installs the First Tree GitHub App and grants it access to this repo.`,
    };
  }
  if (lookup.kind === "error") {
    return {
      status: "lookup_failed",
      appSettingsUrl: null,
      note: `Could not read the team's GitHub App installation (server returned ${lookup.status}). Make sure the First Tree GitHub App can access ${repoFullName}.`,
    };
  }
  const installation = lookup.data;
  const settingsUrl = appInstallationSettingsUrl(installation);
  if (installation.suspended) {
    return {
      status: "suspended",
      appSettingsUrl: settingsUrl,
      note: `The team's GitHub App installation is suspended; reactivate it and include ${repoFullName} before web snapshots and the reviewer can see the tree: ${settingsUrl}`,
    };
  }
  return {
    status: "guided",
    appSettingsUrl: settingsUrl,
    note: `If the First Tree GitHub App is installed on selected repositories, add ${repoFullName} to it so web snapshots and the Context Tree reviewer can read the tree: ${settingsUrl} (all-repositories installations already include it).`,
  };
}

// Read the raw `context_tree` repair view so `tree init` can retain a valid
// unbound branch while rejecting active or invalid historical settings. A
// missing raw endpoint marks an old Server that cannot offer conflict-safe
// finalization, so non-rebind callers fail before creating a GitHub repository.
async function readContextTreeBinding(
  serverUrl: string,
  accessToken: string,
  orgId: string,
): Promise<{ repo: string | null; branch: string; supportsConditionalFinalize: boolean }> {
  const raw = await cliFetch(`${serverUrl}/api/v1/orgs/${encodeURIComponent(orgId)}/settings/context_tree/raw`, {
    headers: { Authorization: `Bearer ${accessToken}` },
    signal: AbortSignal.timeout(10_000),
  });
  const rawSupported = raw.status !== 404;
  const res = rawSupported
    ? raw
    : await cliFetch(`${serverUrl}/api/v1/orgs/${encodeURIComponent(orgId)}/settings/context_tree`, {
        headers: { Authorization: `Bearer ${accessToken}` },
        signal: AbortSignal.timeout(10_000),
      });
  if (!res.ok) {
    throw new Error(
      `Could not read the team's current Context Tree binding (server returned ${res.status}); refusing to proceed so an existing tree is not replaced. Retry, or pass --no-bind.`,
    );
  }
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    body = undefined;
  }
  const state = classifyContextTreeSetting(body);
  if (state.kind === "invalid") {
    throw new Error(
      "The team's current Context Tree setting contains invalid historical data; refusing to create a repository until an admin repairs both its repo and branch.",
    );
  }
  return state.kind === "bound"
    ? {
        repo: state.binding.repo,
        branch: state.binding.branch,
        supportsConditionalFinalize: raw.status !== 404,
      }
    : { repo: null, branch: state.branch, supportsConditionalFinalize: raw.status !== 404 };
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

function explicitBindCommand(repoUrl: string, orgId: string, branch: string): string {
  return `${channelConfig.binName} org bind-tree ${shellQuote(repoUrl)} --org ${shellQuote(orgId)} --branch ${shellQuote(branch)}`;
}

function createdButNotBoundGuidance(repoUrl: string): string {
  return `The repo was created but not bound: ${repoUrl}. If it is empty and you want to abandon this attempt, delete it manually; the CLI does not auto-delete created repositories by default.`;
}

function bindingsMatch(left: ContextTreeActiveBinding, repoUrl: string, branch: string): boolean {
  const leftRepo = canonicalGitRepoUrl(left.repo);
  const rightRepo = canonicalGitRepoUrl(repoUrl);
  return leftRepo !== null && rightRepo !== null && leftRepo === rightRepo && left.branch === branch;
}

async function bindOrgToTree(args: {
  serverUrl: string;
  accessToken: string;
  orgId: string;
  repoUrl: string;
  branch: string;
  provider?: ContextTreeProvider;
  expectedUnboundBranch: string;
  rebind: boolean;
}): Promise<void> {
  const path = args.rebind ? "settings/context_tree" : "settings/context_tree/initialize";
  const endpoint = `${args.serverUrl}/api/v1/orgs/${encodeURIComponent(args.orgId)}/${path}`;
  const requestBody = args.rebind
    ? {
        ...(args.provider ? { provider: args.provider } : {}),
        repo: args.repoUrl,
        branch: args.branch,
      }
    : {
        ...(args.provider ? { provider: args.provider } : {}),
        repo: args.repoUrl,
        branch: args.branch,
        expectedUnboundBranch: args.expectedUnboundBranch,
      };
  const createdButNotBound = createdButNotBoundGuidance(args.repoUrl);
  let res: Response;
  try {
    res = await cliFetch(endpoint, {
      method: args.rebind ? "PUT" : "POST",
      headers: { Authorization: `Bearer ${args.accessToken}`, "Content-Type": "application/json" },
      body: JSON.stringify(requestBody),
      signal: AbortSignal.timeout(10_000),
    });
  } catch (error) {
    if (error instanceof CredentialOriginMismatchError) throw error;
    const retry = explicitBindCommand(args.repoUrl, args.orgId, args.branch);
    throw new Error(
      `${createdButNotBound} Repo created and pushed, but the binding outcome is unknown for organization ${args.orgId} after a network or timeout failure. Do not retry the write until you read back /api/v1/orgs/${encodeURIComponent(args.orgId)}/settings/context_tree. The intended binding is repo ${args.repoUrl} at branch ${args.branch}. If that setting is still unbound and you intentionally want to bind it, run \`${retry}\`.`,
    );
  }
  if (!res.ok) {
    if (!args.rebind && res.status === 409) {
      throw new Error(
        `${createdButNotBound} Repo created and pushed, but organization ${args.orgId}'s Context Tree setting changed before finalization (server returned 409). The competing setting was preserved; do not retry or overwrite it at branch ${args.branch}. Read back /api/v1/orgs/${encodeURIComponent(args.orgId)}/settings/context_tree first.`,
      );
    }
    if (!args.rebind && res.status === 404) {
      throw new Error(
        `${createdButNotBound} This server does not support conflict-safe tree init finalization for organization ${args.orgId}. Upgrade the server, then read back /api/v1/orgs/${encodeURIComponent(args.orgId)}/settings/context_tree before deciding how to bind repo ${args.repoUrl} at branch ${args.branch}.`,
      );
    }
    const retry = explicitBindCommand(args.repoUrl, args.orgId, args.branch);
    throw new Error(
      `${createdButNotBound} Repo created and pushed, but binding failed (server returned ${res.status}) for organization ${args.orgId}. Read back /api/v1/orgs/${encodeURIComponent(args.orgId)}/settings/context_tree before any retry. The intended binding is repo ${args.repoUrl} at branch ${args.branch}. If that setting is still unbound and you intentionally want to bind it, run \`${retry}\`.`,
    );
  }
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    body = undefined;
  }
  const hasExplicitBindingFields =
    body !== null &&
    typeof body === "object" &&
    "repo" in body &&
    typeof body.repo === "string" &&
    "branch" in body &&
    typeof body.branch === "string";
  const binding = contextTreeActiveBindingSchema.safeParse(body);
  if (
    !hasExplicitBindingFields ||
    !binding.success ||
    (args.provider !== undefined && binding.data.provider !== args.provider) ||
    binding.data.repo !== args.repoUrl ||
    binding.data.branch !== args.branch
  ) {
    const retry = explicitBindCommand(args.repoUrl, args.orgId, args.branch);
    throw new Error(
      `${createdButNotBound} Repo created and pushed, but the binding outcome is unknown because the server did not confirm the requested Context Tree binding for organization ${args.orgId}. Do not retry the write until you read back /api/v1/orgs/${encodeURIComponent(args.orgId)}/settings/context_tree. The intended binding is repo ${args.repoUrl} at branch ${args.branch}. If that setting is still unbound and you intentionally want to bind it, run \`${retry}\`.`,
    );
  }
}

type TreeInitSummary = {
  outcome: "created" | "converged";
  teamId: string | null;
  repo: string;
  htmlUrl: string;
  owner: string;
  name: string;
  treeRoot: string;
  branch: string;
  withWorkflow: boolean;
  bound: boolean;
  coverage: CoverageResult | null;
};

type ExistingTreeInitSummary = {
  outcome: "existing" | "converged";
  teamId: string;
  repo: string;
  branch: string;
  bound: true;
};

function readOptions(command: Command): TreeInitOptions {
  const raw = command.opts() as {
    provider?: ContextTreeProvider;
    repo?: string;
    branch?: string;
    create?: boolean;
    adopt?: boolean;
    owner?: string;
    name?: string;
    title?: string;
    public?: boolean;
    dir?: string;
    withWorkflow?: boolean;
    bind?: boolean;
    rebind?: boolean;
    org?: string;
    team?: string;
  };
  return {
    provider: raw.provider,
    repo: raw.repo,
    branch: raw.branch,
    create: raw.create === true,
    adopt: raw.adopt === true,
    owner: raw.owner,
    name: raw.name,
    title: raw.title,
    public: raw.public === true,
    dir: raw.dir,
    withWorkflow: raw.withWorkflow === true,
    // commander maps `--no-bind` to `bind: false`; default is bind: true.
    bind: raw.bind !== false,
    rebind: raw.rebind === true,
    org: raw.org,
    team: raw.team,
  };
}

type ProviderInitSummary = {
  outcome: "created" | "adopted" | "converged" | "existing";
  provider: ContextTreeProvider;
  mode: "create" | "adopt";
  teamId: string;
  repo: string;
  branch: string;
  treeRoot: string | null;
  bound: true;
  withWorkflow: boolean;
  coverage: CoverageResult | null;
};

function usesProviderInitContract(options: TreeInitOptions): boolean {
  return (
    options.provider !== undefined ||
    options.repo !== undefined ||
    options.branch !== undefined ||
    options.create ||
    options.adopt
  );
}

function parseProviderInitOptions(options: TreeInitOptions): {
  provider: ContextTreeProvider;
  repo: string;
  branch: string;
  mode: "create" | "adopt";
  teamId: string;
} {
  if (options.provider !== "github" && options.provider !== "gitlab") {
    throw new Error("--provider must be exactly github or gitlab.");
  }
  const repo = options.repo?.trim();
  if (!repo || repo !== options.repo) {
    throw new Error("--repo must be one exact repository URL without surrounding whitespace.");
  }
  const branch = contextTreeBranchSchema.safeParse(options.branch);
  if (!branch.success) {
    throw new Error("--branch must be an explicit valid branch name.");
  }
  const teamId = options.team?.trim();
  if (!teamId || teamId !== options.team) {
    throw new Error("--team is required by the provider-aware Seed contract.");
  }
  if (options.create === options.adopt) {
    throw new Error("Pass exactly one repository mode: --create or --adopt.");
  }
  if (
    !options.bind ||
    options.rebind ||
    options.org !== undefined ||
    options.owner !== undefined ||
    options.name !== undefined
  ) {
    throw new Error(
      "The provider-aware Seed contract cannot be combined with --no-bind, --rebind, --org, --owner, or --name.",
    );
  }
  if (options.adopt && (options.public || options.withWorkflow || options.title !== undefined)) {
    throw new Error("--adopt cannot be combined with --public, --with-workflow, or --title.");
  }
  if (options.provider === "gitlab" && options.withWorkflow) {
    throw new Error("GitLab Seed does not create a GitHub Actions workflow; omit --with-workflow.");
  }
  return {
    provider: options.provider,
    repo,
    branch: branch.data,
    mode: options.create ? "create" : "adopt",
    teamId,
  };
}

function providerBindingsMatch(
  binding: ContextTreeActiveBinding,
  provider: ContextTreeProvider,
  repo: string,
  branch: string,
): boolean {
  return (
    binding.provider === provider &&
    binding.branch === branch &&
    sameContextTreeRepository({ left: binding.repo, right: repo, provider })
  );
}

function gitlabSeedConnectionMatches(
  provider: ContextTreeProvider,
  expected: ContextTreeSeedPreflight["gitlabConnection"],
  current: ContextTreeSeedPreflight["gitlabConnection"],
): boolean {
  return (
    provider !== "gitlab" ||
    (expected !== null &&
      current !== null &&
      expected.id === current.id &&
      expected.instanceOrigin === current.instanceOrigin)
  );
}

function forgeActorLogin(provider: ContextTreeProvider, host: string): string {
  let login: string;
  if (provider === "github") {
    login = runCommand("gh", ["api", "user", "--hostname", host, "--jq", ".login"], process.cwd()).trim();
  } else {
    const output = runCommand("glab", ["api", "user", "--hostname", host], process.cwd(), {
      GITLAB_HOST: host,
    });
    let parsed: unknown;
    try {
      parsed = JSON.parse(output);
    } catch {
      throw new Error("GitLab CLI returned an invalid current-user response.");
    }
    const username = typeof parsed === "object" && parsed !== null ? Reflect.get(parsed, "username") : null;
    login = typeof username === "string" ? username.trim() : "";
  }
  const hasControlCharacter = [...login].some((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint <= 0x1f || codePoint === 0x7f;
  });
  if (!login || hasControlCharacter) {
    throw new Error(`Could not resolve the authenticated ${provider === "github" ? "GitHub" : "GitLab"} username.`);
  }
  return login;
}

function printProviderInitSummary(context: CommandContext, summary: ProviderInitSummary): void {
  if (context.options.json) {
    console.log(JSON.stringify(summary, null, 2));
    return;
  }
  console.log("Context Tree Init\n");
  console.log(`  Team:         ${summary.teamId}`);
  console.log(`  Provider:     ${summary.provider}`);
  console.log(`  Repository:   ${summary.repo}`);
  console.log(`  Branch:       ${summary.branch}`);
  console.log(`  Mode:         ${summary.mode}`);
  console.log(`  Local tree:   ${summary.treeRoot ?? "not created (binding already exists)"}`);
  console.log(`  Bound:        yes`);
  if (summary.coverage) {
    console.log("\nGitHub App coverage:");
    console.log(`  ! ${summary.coverage.note}`);
  }
  console.log(
    summary.outcome === "existing"
      ? "\nThe exact Context Tree binding already exists; no local or remote mutation was attempted."
      : `\nContext Tree ${summary.outcome} and bound.`,
  );
}

async function runProviderInitCommand(context: CommandContext, options: TreeInitOptions): Promise<void> {
  const input = parseProviderInitOptions(options);
  const requestedCoordinate = resolveContextTreeForgeCoordinate(input.provider, input.repo);
  const reader = createMemberSdk();
  const admission = await preflightContextTreeSeed(reader, { teamId: input.teamId });
  if (admission.state.status === "bound") {
    if (!providerBindingsMatch(admission.state.binding, input.provider, requestedCoordinate.repoUrl, input.branch)) {
      throw new Error(
        `Team ${input.teamId} is already bound to ${admission.state.binding.repo}#${admission.state.binding.branch}; provider-aware Seed never replaces an existing binding.`,
      );
    }
    printProviderInitSummary(context, {
      outcome: "existing",
      provider: input.provider,
      mode: input.mode,
      teamId: input.teamId,
      repo: admission.state.binding.repo,
      branch: admission.state.binding.branch,
      treeRoot: null,
      bound: true,
      withWorkflow: input.provider === "github" && options.withWorkflow,
      coverage: null,
    });
    return;
  }
  if (admission.state.branch !== input.branch) {
    throw new Error(
      `Team ${input.teamId}'s current unbound branch is ${admission.state.branch}, not requested branch ${input.branch}. Update the Team setting first or use that exact branch.`,
    );
  }
  if (input.provider === "gitlab" && !admission.gitlabConnection) {
    throw new Error(
      "GitLab Context Tree initialization requires the Team's current GitLab connection before any remote mutation.",
    );
  }
  const coordinate = resolveContextTreeForgeCoordinate(
    input.provider,
    input.repo,
    admission.gitlabConnection?.instanceOrigin,
  );

  // Resolve all Server authority and local credential prerequisites before a
  // remote create. The Cloud never receives or uses the forge credentials.
  const serverUrl = resolveServerUrl();
  const accessToken = await accessTokenForOrigin(serverUrl);
  ensureToolAvailable("git");
  ensureToolAvailable(input.provider === "github" ? "gh" : "glab");
  verifyContextTreeForgeAuth(coordinate, process.cwd(), runCommand);
  const actorLogin = forgeActorLogin(input.provider, coordinate.host);

  let coverage: CoverageResult | null = null;
  if (input.provider === "github") {
    const lookup = await fetchInstallation(serverUrl, accessToken, input.teamId);
    if (lookup.kind === "error") {
      throw new Error(
        `Could not read the Team's GitHub App installation before repository initialization (server ${lookup.status || "unreachable"}).`,
      );
    }
    coverage = buildCoverage(lookup, coordinate.path);
  }

  const repoName = coordinate.path.split("/").at(-1);
  if (!repoName) throw new Error("The exact repository URL does not contain a repository name.");
  const treeRoot = resolve(process.cwd(), options.dir?.trim() || repoName);
  if (existsSync(treeRoot) && readdirSync(treeRoot).length > 0) {
    throw new Error(`Target directory is not empty: ${treeRoot}. Pass --dir to choose another path.`);
  }

  if (input.mode === "create") {
    mkdirSync(treeRoot, { recursive: true });
    writeScaffold(
      treeRoot,
      buildScaffoldFiles({
        title: options.title?.trim() || repoName,
        ownerLogin: actorLogin,
        withWorkflow: input.provider === "github" && options.withWorkflow,
        branch: input.branch,
      }),
    );
    runCommand("git", ["init", "-b", input.branch], treeRoot);
    const verifySummary = verifyTreeRoot(treeRoot);
    if (!verifySummary.ok) {
      throw new Error(
        `Scaffolded tree failed \`tree verify\`:\n  - ${collectVerifyErrors(verifySummary).join("\n  - ")}`,
      );
    }
    runCommand("git", ["add", "-A"], treeRoot);
    runCommand("git", ["commit", "-m", "chore: bootstrap context tree"], treeRoot);
  } else {
    mkdirSync(treeRoot, { recursive: true });
  }

  const beforeRemote = await preflightContextTreeSeed(reader, { teamId: input.teamId });
  if (beforeRemote.state.status === "bound") {
    if (providerBindingsMatch(beforeRemote.state.binding, input.provider, coordinate.repoUrl, input.branch)) {
      printProviderInitSummary(context, {
        outcome: "converged",
        provider: input.provider,
        mode: input.mode,
        teamId: input.teamId,
        repo: beforeRemote.state.binding.repo,
        branch: beforeRemote.state.binding.branch,
        treeRoot,
        bound: true,
        withWorkflow: input.provider === "github" && options.withWorkflow,
        coverage,
      });
      return;
    }
    throw new Error(
      `Team ${input.teamId} became bound to ${beforeRemote.state.binding.repo}#${beforeRemote.state.binding.branch} before repository ${input.mode}. No remote mutation was attempted.`,
    );
  }
  if (beforeRemote.state.branch !== input.branch) {
    throw new Error(
      `Team ${input.teamId}'s unbound branch changed from ${input.branch} to ${beforeRemote.state.branch} before repository ${input.mode}. No remote mutation was attempted.`,
    );
  }
  if (!gitlabSeedConnectionMatches(input.provider, admission.gitlabConnection, beforeRemote.gitlabConnection)) {
    throw new Error(
      `Team ${input.teamId}'s GitLab connection changed before repository ${input.mode}. No remote mutation was attempted.`,
    );
  }

  try {
    if (input.mode === "create") {
      createContextTreeRemote({ coordinate, branch: input.branch, public: options.public, treeRoot }, runCommand);
    } else {
      adoptContextTreeRemote({ coordinate, branch: input.branch, treeRoot }, runCommand);
      const verifySummary = verifyTreeRoot(treeRoot);
      if (!verifySummary.ok) {
        throw new Error(
          `Adopted repository failed \`tree verify\`:\n  - ${collectVerifyErrors(verifySummary).join("\n  - ")}`,
        );
      }
    }
  } catch (error) {
    if (input.mode === "adopt") throw error;
    const current = await preflightContextTreeSeed(reader, { teamId: input.teamId }).catch(() => null);
    const bindingTruth =
      current?.state.status === "bound"
        ? ` Team ${input.teamId} is now bound to ${current.state.binding.repo}#${current.state.binding.branch}.`
        : current?.state.status === "unbound"
          ? ` Team ${input.teamId} remains unbound at branch ${current.state.branch}.`
          : " The Team binding could not be reconciled.";
    throw new Error(
      `${input.provider === "github" ? "GitHub" : "GitLab"} create/push did not complete cleanly for ${coordinate.webUrl}; the remote repository may exist and no rollback is claimed.${bindingTruth} Inspect the exact remote and binding before retrying. Cause: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const beforeFinalize = await preflightContextTreeSeed(reader, { teamId: input.teamId });
  if (beforeFinalize.state.status === "bound") {
    if (!providerBindingsMatch(beforeFinalize.state.binding, input.provider, coordinate.repoUrl, input.branch)) {
      throw new Error(
        `${createdButNotBoundGuidance(coordinate.webUrl)} Team ${input.teamId} became bound to ${beforeFinalize.state.binding.repo}#${beforeFinalize.state.binding.branch}. That binding was preserved.`,
      );
    }
    printProviderInitSummary(context, {
      outcome: "converged",
      provider: input.provider,
      mode: input.mode,
      teamId: input.teamId,
      repo: beforeFinalize.state.binding.repo,
      branch: beforeFinalize.state.binding.branch,
      treeRoot,
      bound: true,
      withWorkflow: input.provider === "github" && options.withWorkflow,
      coverage,
    });
    return;
  }
  if (beforeFinalize.state.branch !== input.branch) {
    throw new Error(
      `${createdButNotBoundGuidance(coordinate.webUrl)} Team ${input.teamId}'s unbound branch changed from ${input.branch} to ${beforeFinalize.state.branch}.`,
    );
  }
  if (!gitlabSeedConnectionMatches(input.provider, admission.gitlabConnection, beforeFinalize.gitlabConnection)) {
    throw new Error(
      `${createdButNotBoundGuidance(coordinate.webUrl)} Team ${input.teamId}'s GitLab connection changed after the remote mutation.`,
    );
  }

  let outcome: ProviderInitSummary["outcome"] = input.mode === "create" ? "created" : "adopted";
  try {
    await bindOrgToTree({
      serverUrl,
      accessToken,
      orgId: input.teamId,
      repoUrl: coordinate.repoUrl,
      branch: input.branch,
      provider: input.provider,
      expectedUnboundBranch: input.branch,
      rebind: false,
    });
  } catch (error) {
    // A lost response has unknown mutation status. Reconcile once, read-only,
    // and converge only when the exact provider/repo/branch is now authoritative.
    const current = await preflightContextTreeSeed(reader, { teamId: input.teamId }).catch(() => null);
    if (
      current?.state.status === "bound" &&
      providerBindingsMatch(current.state.binding, input.provider, coordinate.repoUrl, input.branch)
    ) {
      outcome = "converged";
    } else {
      throw error;
    }
  }

  printProviderInitSummary(context, {
    outcome,
    provider: input.provider,
    mode: input.mode,
    teamId: input.teamId,
    repo: coordinate.repoUrl,
    branch: input.branch,
    treeRoot,
    bound: true,
    withWorkflow: input.provider === "github" && options.withWorkflow,
    coverage,
  });
}

async function runInitCommand(context: CommandContext): Promise<void> {
  try {
    const options = readOptions(context.command);
    if (usesProviderInitContract(options)) {
      await runProviderInitCommand(context, options);
      return;
    }

    const usesExplicitTeam = options.team !== undefined;
    if (usesExplicitTeam && options.org !== undefined) {
      throw new Error(
        "Pass exactly one Team selector: use --team for portable Seed, or --org for the legacy managed path.",
      );
    }
    if (usesExplicitTeam && !options.bind) {
      throw new Error(
        "--team cannot be combined with --no-bind because portable Seed must converge on that Team's binding.",
      );
    }
    if (usesExplicitTeam && options.rebind) {
      throw new Error(
        "--team cannot be combined with --rebind; portable Seed never replaces an existing Team binding.",
      );
    }

    let seedReader: ContextTreeSeedAuthorityReader | null = null;
    let seedTeamId: string | null = null;
    let initialSeedBranch: string | null = null;
    if (usesExplicitTeam) {
      seedReader = createMemberSdk();
      const admission = await preflightContextTreeSeed(seedReader, { teamId: options.team ?? "" });
      seedTeamId = admission.teamId;
      if (admission.state.status === "bound") {
        printExistingSummary(context, {
          outcome: "existing",
          teamId: admission.teamId,
          repo: admission.state.binding.repo,
          branch: admission.state.binding.branch,
          bound: true,
        });
        return;
      }
      initialSeedBranch = admission.state.branch;
    }

    ensureToolAvailable("git");
    ensureToolAvailable("gh");
    ensureGhAuthenticated();

    const creatorLogin = ghApiText(["user", "--jq", ".login"]).trim();
    if (!creatorLogin) {
      throw new Error("Could not resolve your GitHub login from `gh api user`.");
    }

    // Resolve EVERY First Tree bind precondition (auth, org, admin, no existing
    // binding, and the installation account) BEFORE any remote GitHub write, so a
    // logged-out / multi-org / non-admin caller — or one that would clobber an
    // existing tree or bind an uncoverable repo — fails without leaving an orphan.
    let bindContext: { serverUrl: string; accessToken: string; orgId: string } | null = null;
    let lookup: InstallationLookup | null = null;
    let installationAccount: string | null = null;
    let treeBranch = DEFAULT_BRANCH;
    if (options.bind) {
      const serverUrl = resolveServerUrl();
      const accessToken = await accessTokenForOrigin(serverUrl);
      let orgId: string;
      if (seedTeamId && initialSeedBranch) {
        orgId = seedTeamId;
        treeBranch = initialSeedBranch;
      } else {
        const resolved = await resolveBindContext(serverUrl, accessToken, options.org);
        orgId = resolved.orgId;
        if (!resolved.isAdmin) {
          throw new Error(
            `Binding the team Context Tree requires admin of org ${orgId}. Re-run with --no-bind to only create the repo, or have an admin bind it later with \`${channelConfig.binName} org bind-tree <url>\`.`,
          );
        }
        const existing = await readContextTreeBinding(serverUrl, accessToken, orgId);
        treeBranch = existing.branch;
        if (existing.repo && !options.rebind) {
          throw new Error(
            `This team is already bound to a Context Tree (${existing.repo}). \`tree init\` will not replace it — pass --rebind to intentionally replace it, or --no-bind to only create a repo.`,
          );
        }
        if (!options.rebind && !existing.supportsConditionalFinalize) {
          throw new Error(
            `Server support for conflict-safe tree init finalization is required for organization ${orgId}. Upgrade the server before retrying; no repository was created.`,
          );
        }
      }
      lookup = await fetchInstallation(serverUrl, accessToken, orgId);
      if (lookup.kind === "error") {
        throw new Error(
          `Could not read the team's GitHub App installation to place the repo under the coverable account (server ${lookup.status || "unreachable"}). Retry, or pass --no-bind to create the repo without binding.`,
        );
      }
      // "ok" → the repo must live under the installation account; "none" (no App
      // installed yet) → fall back to the user default (an explicitly unverified repo).
      installationAccount = lookup.kind === "ok" ? lookup.data.accountLogin : null;
      bindContext = { serverUrl, accessToken, orgId };
    }

    const explicitOwner = options.owner?.trim();
    const resolvedRepoOwner = resolveRepoOwner({ optionOwner: explicitOwner, creatorLogin, installationAccount });
    const repoOwner = explicitOwner ? canonicalizeGithubOwnerLogin(explicitOwner) : resolvedRepoOwner;
    const title = options.title?.trim() || repoOwner;
    const repoName = options.name?.trim() || defaultRepoName(title);
    const repoFullName = `${repoOwner}/${repoName}`;
    const treeRoot = resolve(process.cwd(), options.dir?.trim() || repoName);
    if (existsSync(treeRoot) && readdirSync(treeRoot).length > 0) {
      throw new Error(`Target directory is not empty: ${treeRoot}. Pass --dir to choose another path.`);
    }
    const coverage = lookup ? buildCoverage(lookup, repoFullName) : null;

    // Local scaffold + self-verify (reversible) before touching the remote — a
    // bad seed never reaches GitHub.
    mkdirSync(treeRoot, { recursive: true });
    writeScaffold(
      treeRoot,
      buildScaffoldFiles({ title, ownerLogin: creatorLogin, withWorkflow: options.withWorkflow, branch: treeBranch }),
    );
    runCommand("git", ["init", "-b", treeBranch], treeRoot);

    const verifySummary = verifyTreeRoot(treeRoot);
    if (!verifySummary.ok) {
      throw new Error(
        `Scaffolded tree failed \`tree verify\`:\n  - ${collectVerifyErrors(verifySummary).join("\n  - ")}`,
      );
    }

    runCommand("git", ["add", "-A"], treeRoot);
    runCommand("git", ["commit", "-m", "chore: bootstrap context tree"], treeRoot);

    const intendedRepoUrl = `https://github.com/${repoFullName}`;
    if (seedReader && seedTeamId) {
      const fresh = await preflightContextTreeSeed(seedReader, { teamId: seedTeamId });
      if (fresh.state.status === "bound") {
        if (bindingsMatch(fresh.state.binding, intendedRepoUrl, treeBranch)) {
          printExistingSummary(context, {
            outcome: "converged",
            teamId: seedTeamId,
            repo: fresh.state.binding.repo,
            branch: fresh.state.binding.branch,
            bound: true,
          });
          return;
        }
        throw new Error(
          `Team ${seedTeamId} became bound to ${fresh.state.binding.repo}#${fresh.state.binding.branch} before GitHub creation. No remote mutation was attempted by this run, and that current binding was preserved.`,
        );
      }
      if (fresh.state.branch !== treeBranch) {
        throw new Error(
          `Team ${seedTeamId}'s unbound branch changed from ${treeBranch} to ${fresh.state.branch} before GitHub creation. No remote mutation was attempted.`,
        );
      }
    }

    // Irreversible remote write: create + push in one shot.
    const visibility = options.public ? "--public" : "--private";
    let htmlUrl: string;
    try {
      runCommand(
        "gh",
        ["repo", "create", repoFullName, visibility, "--source", treeRoot, "--remote", "origin", "--push"],
        treeRoot,
      );

      const repo = ghApiJson(`repos/${repoFullName}`);
      htmlUrl = typeof repo.html_url === "string" ? repo.html_url : "";
      if (htmlUrl !== intendedRepoUrl) {
        throw new Error(`GitHub did not confirm the expected URL for ${repoFullName}.`);
      }
    } catch (error) {
      if (!seedReader || !seedTeamId) throw error;
      let current: ContextTreeSeedPreflight;
      try {
        current = await preflightContextTreeSeed(seedReader, { teamId: seedTeamId });
      } catch {
        throw new Error(
          `GitHub create/push did not complete cleanly for ${intendedRepoUrl}, and Team ${seedTeamId}'s binding could not be read back. The remote repository may exist; no rollback is claimed. Inspect GitHub and the Server binding before retrying.`,
        );
      }
      if (current.state.status === "bound" && bindingsMatch(current.state.binding, intendedRepoUrl, treeBranch)) {
        printExistingSummary(context, {
          outcome: "converged",
          teamId: seedTeamId,
          repo: current.state.binding.repo,
          branch: current.state.binding.branch,
          bound: true,
        });
        return;
      }
      if (current.state.status === "bound") {
        throw new Error(
          `GitHub create/push did not complete cleanly for ${intendedRepoUrl}. Team ${seedTeamId} is now bound to ${current.state.binding.repo}#${current.state.binding.branch}; that binding was preserved and no rollback is claimed.`,
        );
      }
      throw new Error(
        `GitHub create/push did not complete cleanly for ${intendedRepoUrl}. Team ${seedTeamId} remains unbound at branch ${current.state.branch}; the remote repository may exist and no rollback is claimed. Inspect that exact repository before retrying.`,
      );
    }

    let bound = false;
    let outcome: TreeInitSummary["outcome"] = "created";
    if (bindContext) {
      let shouldBind = true;
      if (seedReader && seedTeamId) {
        let fresh: ContextTreeSeedPreflight;
        try {
          fresh = await preflightContextTreeSeed(seedReader, { teamId: seedTeamId });
        } catch (error) {
          const reason = error instanceof Error ? error.message : String(error);
          throw new Error(
            `${createdButNotBoundGuidance(htmlUrl)} Team ${seedTeamId}'s current Seed authority could not be revalidated before binding: ${reason}`,
          );
        }
        if (fresh.state.status === "bound") {
          if (!bindingsMatch(fresh.state.binding, htmlUrl, treeBranch)) {
            throw new Error(
              `${createdButNotBoundGuidance(htmlUrl)} Team ${seedTeamId} became bound to ${fresh.state.binding.repo}#${fresh.state.binding.branch} before finalization. That current binding was preserved.`,
            );
          }
          shouldBind = false;
          outcome = "converged";
        } else if (fresh.state.branch !== treeBranch) {
          throw new Error(
            `${createdButNotBoundGuidance(htmlUrl)} Team ${seedTeamId}'s unbound branch changed from ${treeBranch} to ${fresh.state.branch} before finalization.`,
          );
        }
      }

      if (shouldBind) {
        try {
          await bindOrgToTree({
            serverUrl: bindContext.serverUrl,
            accessToken: bindContext.accessToken,
            orgId: bindContext.orgId,
            repoUrl: htmlUrl,
            branch: treeBranch,
            provider: "github",
            expectedUnboundBranch: treeBranch,
            rebind: options.rebind,
          });
        } catch (error) {
          if (!seedReader || !seedTeamId) throw error;
          let current: ContextTreeSeedPreflight;
          try {
            current = await preflightContextTreeSeed(seedReader, { teamId: seedTeamId });
          } catch {
            throw error;
          }
          if (current.state.status === "bound" && bindingsMatch(current.state.binding, htmlUrl, treeBranch)) {
            outcome = "converged";
          } else if (current.state.status === "bound") {
            throw new Error(
              `${createdButNotBoundGuidance(htmlUrl)} Team ${seedTeamId} is currently bound to ${current.state.binding.repo}#${current.state.binding.branch}; that binding was preserved.`,
            );
          } else {
            throw new Error(
              `${createdButNotBoundGuidance(htmlUrl)} Team ${seedTeamId} remains unbound at branch ${current.state.branch}; the failed finalization did not create a binding.`,
            );
          }
        }
      }
      bound = true;
    }

    printSummary(context, {
      outcome,
      teamId: seedTeamId,
      repo: htmlUrl,
      htmlUrl,
      owner: repoOwner,
      name: repoName,
      treeRoot,
      branch: treeBranch,
      withWorkflow: options.withWorkflow,
      bound,
      coverage,
    });
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = error instanceof ContextTreeSeedPreflightCliError ? error.exitCode : 1;
  }
}

function printSummary(context: CommandContext, summary: TreeInitSummary): void {
  if (context.options.json) {
    const payload =
      summary.teamId === null
        ? {
            repo: summary.repo,
            htmlUrl: summary.htmlUrl,
            owner: summary.owner,
            name: summary.name,
            treeRoot: summary.treeRoot,
            branch: summary.branch,
            withWorkflow: summary.withWorkflow,
            bound: summary.bound,
            coverage: summary.coverage,
          }
        : summary;
    console.log(JSON.stringify(payload, null, 2));
    return;
  }

  console.log("Context Tree Init\n");
  console.log(`  Repository:   ${summary.owner}/${summary.name}`);
  console.log(`  URL:          ${summary.htmlUrl}`);
  console.log(`  Local tree:   ${summary.treeRoot}`);
  console.log(`  Branch:       ${summary.branch}`);
  console.log(
    `  Validate CI:  ${summary.withWorkflow ? "seeded" : "not seeded (optional; needs gh `workflow` scope)"}`,
  );
  console.log(`  Bound to org: ${summary.bound ? "yes" : "no (--no-bind)"}`);

  if (summary.coverage) {
    console.log("\nGitHub App coverage:");
    console.log(`  ! ${summary.coverage.note}`);
  }

  console.log(summary.bound ? "\nContext Tree created and bound." : "\nContext Tree created.");
}

function printExistingSummary(context: CommandContext, summary: ExistingTreeInitSummary): void {
  if (context.options.json) {
    console.log(JSON.stringify(summary, null, 2));
    return;
  }

  console.log("Context Tree Init\n");
  console.log(`  Team:         ${summary.teamId}`);
  console.log(`  Binding:      ${summary.repo}`);
  console.log(`  Branch:       ${summary.branch}`);
  console.log(
    summary.outcome === "existing"
      ? "\nContext Tree is already bound; no local or remote mutation was attempted."
      : "\nContext Tree init converged on the Server's current binding; no second binding was created.",
  );
}

function configureInitCommand(command: Command): void {
  command
    .option("--provider <provider>", "repository provider for the portable Seed contract: github or gitlab")
    .option("--repo <url>", "exact Context Tree repository URL")
    .option("--branch <branch>", "exact Context Tree branch")
    .option("--create", "create the exact repository and push a verified scaffold")
    .option("--adopt", "adopt an existing readable Context Tree repository without overwriting history")
    .option(
      "--owner <login>",
      "deprecated legacy GitHub owner (removed in 0.6.0); use --provider/--repo/--branch/--create",
    )
    .option("--name <repo>", "deprecated legacy GitHub repo name (removed in 0.6.0); use --repo")
    .option("--title <team>", "team display name used in the root node title; defaults to the owner")
    .option("--public", "create a public repository (default: private)")
    .option("--dir <path>", "local directory to scaffold and push from; defaults to ./<name>")
    .option("--with-workflow", "also seed .github/workflows/validate-tree.yml (needs gh `workflow` scope)")
    .option("--no-bind", "deprecated legacy GitHub-only mode (removed in 0.6.0)")
    .option("--rebind", "deprecated legacy direct rebind (removed in 0.6.0)")
    .option("--org <orgId>", "deprecated legacy org selector (removed in 0.6.0); use --team")
    .option("--team <team-id>", "explicit Team for portable Seed; never falls back to default/current Team state");
}

export const initCommand: SubcommandModule = {
  name: "init",
  alias: "",
  summary: "",
  description: "Create or adopt a GitHub/GitLab Context Tree repo with local forge credentials and bind it.",
  action: runInitCommand,
  configure: configureInitCommand,
};
