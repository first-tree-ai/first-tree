import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import {
  AGENT_BRIEFING_GENERATED_MARKER,
  type AgentRuntimeConfigPayload,
  type PromptSection,
} from "@first-tree/shared";
import type * as ejs from "ejs";
import type { PredeclaredSourceRepo } from "./bootstrap.js";
import { getCliBinding } from "./cli-binding.js";
import type { ContextSourceKind } from "./context-source.js";
import type { AgentIdentity } from "./handler.js";

// EJS is published as CommonJS at runtime even though its types expose named
// exports, so native ESM cannot import `render` directly. Load lazily so
// `provider-support/index` can re-export preparation without forcing EJS (and
// so capability tests that mock `createRequire` can still import binaries).
let ejsRuntime: typeof ejs | null = null;

function getEjsRuntime(): typeof ejs {
  if (!ejsRuntime) {
    ejsRuntime = createRequire(import.meta.url)("ejs") as typeof ejs;
  }
  return ejsRuntime;
}
const AGENT_BRIEFING_TEMPLATE_FILENAME = "agent-briefing.ejs";
const TEMPLATE_CANDIDATE_URLS = [
  // Source execution and root-level client/CLI chunks keep templates beside
  // this module.
  new URL(`./templates/${AGENT_BRIEFING_TEMPLATE_FILENAME}`, import.meta.url),
  // The shipped CLI entry lives in dist/cli/ (portable: app/cli/) while its
  // copied runtime assets remain at the dist/app root.
  new URL(`../templates/${AGENT_BRIEFING_TEMPLATE_FILENAME}`, import.meta.url),
] as const;
const CONTEXT_TREE_POLICY_CANDIDATE_URLS = [
  // Source execution: packages/client/src/runtime/agent-briefing.ts
  new URL("./assets/context-tree-policy.md", import.meta.url),
  // Root-level client/CLI chunks. This non-discoverable runtime asset is
  // copied beside the built chunks; it is never installed as a Skill.
  new URL("./runtime-assets/context-tree-policy.md", import.meta.url),
  // Shipped CLI and portable entries are nested one level below the copied
  // runtime asset directories.
  new URL("../runtime-assets/context-tree-policy.md", import.meta.url),
] as const;
const CONTEXT_TREE_WRITE_ROUTING_CANDIDATE_URLS = [
  // Source execution: packages/client/src/runtime/agent-briefing.ts
  new URL("./assets/context-tree-write-routing.md", import.meta.url),
  // Root-level client/CLI chunks.
  new URL("./runtime-assets/context-tree-write-routing.md", import.meta.url),
  // Shipped CLI and portable entries are nested one level below the copied
  // runtime asset directories.
  new URL("../runtime-assets/context-tree-write-routing.md", import.meta.url),
] as const;

type CachedTemplate = {
  filename: string;
  source: string;
};

type NamedPromptRow = Readonly<{
  name: string;
  body: string;
}>;

type PromptBodyRow = Readonly<{
  body: string;
}>;

type SourceRepositoryRow = Readonly<{
  absolutePath: string;
  url: string;
  ref: string | null;
  branch: string | null;
}>;

type ContextTreeRenderModel = Readonly<{
  source: "remote" | "local" | "none" | "external";
  bound: boolean;
  /** GitHub OWNER/REPO in external mode; null in every other mode. */
  repository: string | null;
  path: string | null;
  upstreamUrl: string | null;
  branch: string;
  // Null only in external mode, where the `context-tree-*` Skills own tree
  // verification and hierarchy browsing and no render site is reached.
  verifyCommand: string | null;
  hierarchyHelpCommand: string | null;
  localResolveReadCommand: string | null;
  localResolveWriteCommand: string | null;
  cloneCommand: string | null;
  removeSymlinkCommand: string | null;
  pullCommand: string | null;
  addWorktreeCommand: string | null;
}>;

export type TeamSkillBriefingRow = Readonly<{
  name: string;
  description: string;
}>;

type AgentBriefingRenderModel = Readonly<{
  bin: string;
  generatedMarker: string;
  identityName: string;
  identityKind: string;
  agentId: string;
  teamPromptRows: ReadonlyArray<NamedPromptRow>;
  agentPromptRows: ReadonlyArray<PromptBodyRow>;
  agentPromptOverrideRows: ReadonlyArray<NamedPromptRow>;
  legacyPrompt: string | null;
  workspacePath: string;
  sourceRepositoryRows: ReadonlyArray<SourceRepositoryRow>;
  exampleSourcePath: string;
  readWorktreePath: string;
  taskWorktreePath: string;
  contextTree: ContextTreeRenderModel;
  contextTreePolicy: string;
  contextTreeWriteRouting: string;
  resourceSkillRows: ReadonlyArray<TeamSkillBriefingRow>;
}>;

let templateCache: CachedTemplate | null = null;
let contextTreePolicyCache: string | null = null;
let contextTreeWriteRoutingCache: string | null = null;

/** Wrap a runtime value in canonical POSIX-safe single quotes. */
function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

export type BuildAgentBriefingOptions = {
  identity: AgentIdentity;
  payload: AgentRuntimeConfigPayload | null;
  workspacePath: string;
  sourceRepos: ReadonlyArray<PredeclaredSourceRepo>;
  /** Successful current-provider rows from the same reconcile result. */
  teamSkills?: ReadonlyArray<TeamSkillBriefingRow>;
  contextTreePath: string | null;
  /** Upstream coordinates used by the agent-managed Context Tree clone. */
  contextTreeRepoUrl?: string | null;
  contextTreeBranch?: string | null;
  contextSourceKind?: ContextSourceKind;
  /** GitHub OWNER/REPO driving external Context Tree mode, when it is on. */
  contextTreeRepository?: string | null;
};

/** Build the unified agent-level briefing materialized as `AGENTS.md`. */
export function buildAgentBriefing(opts: BuildAgentBriefingOptions): string {
  return renderAgentBriefingTemplate(buildAgentBriefingRenderModel(opts));
}

function buildAgentBriefingRenderModel(opts: BuildAgentBriefingOptions): AgentBriefingRenderModel {
  const { binName: bin } = getCliBinding();
  const promptSections = opts.payload?.prompt.sections ?? [];
  const teamPromptRows = buildNamedPromptRows(
    promptSections.filter((section) => section.scope === "team"),
    "Team prompt",
  );
  const agentPromptRows = promptSections
    .filter((section) => section.scope === "agent" && section.editable === true && section.body.trim().length > 0)
    .map((section) => ({ body: section.body.trim() }));
  const agentPromptOverrideRows = buildNamedPromptRows(
    promptSections.filter((section) => section.scope === "agent" && section.editable !== true),
    "Agent prompt override",
  );
  const hasStructuredPrompt =
    teamPromptRows.length > 0 || agentPromptRows.length > 0 || agentPromptOverrideRows.length > 0;
  const legacyPrompt = hasStructuredPrompt ? null : opts.payload?.prompt.append?.trim() || null;

  const sourceRepositoryRows = opts.sourceRepos.map((repo) => ({
    absolutePath: repo.absolutePath,
    url: repo.url,
    ref: repo.ref ?? null,
    branch: repo.branch ?? null,
  }));
  const quotedWorkspacePath = shellQuote(opts.workspacePath);
  const exampleSourcePath = sourceRepositoryRows[0]
    ? shellQuote(sourceRepositoryRows[0].absolutePath)
    : `${quotedWorkspacePath}/source-repos/<source-repo>`;

  return {
    bin,
    generatedMarker: AGENT_BRIEFING_GENERATED_MARKER,
    identityName: opts.identity.displayName ?? opts.identity.agentId,
    identityKind: opts.identity.visibility === "private" ? "a personal assistant agent" : "an autonomous agent",
    agentId: opts.identity.agentId,
    teamPromptRows,
    agentPromptRows,
    agentPromptOverrideRows,
    legacyPrompt,
    workspacePath: opts.workspacePath,
    sourceRepositoryRows,
    exampleSourcePath,
    readWorktreePath: shellQuote(`${opts.workspacePath}/worktrees/<name>-read`),
    taskWorktreePath: shellQuote(`${opts.workspacePath}/worktrees/<task-name>`),
    contextTree: buildContextTreeRenderModel(
      bin,
      opts.contextTreePath,
      opts.contextTreeRepoUrl ?? null,
      opts.contextTreeBranch ?? null,
      opts.contextSourceKind,
      opts.contextTreeRepository ?? null,
    ),
    contextTreePolicy: readCanonicalContextTreePolicy(),
    contextTreeWriteRouting: readCanonicalContextTreeWriteRouting(),
    resourceSkillRows: (opts.teamSkills ?? []).map((skill) => ({
      name: skill.name,
      description: skill.description,
    })),
  };
}

function buildNamedPromptRows(promptSections: ReadonlyArray<PromptSection>, fallbackName: string): NamedPromptRow[] {
  return promptSections
    .filter((section) => section.body.trim().length > 0)
    .map((section) => ({
      name: section.name.trim() || fallbackName,
      body: section.body.trim(),
    }));
}

function buildContextTreeRenderModel(
  bin: string,
  path: string | null,
  upstreamUrl: string | null,
  configuredBranch: string | null,
  sourceKind?: ContextSourceKind,
  repository?: string | null,
): ContextTreeRenderModel {
  const branch = configuredBranch ?? "main";
  const source = sourceKind ?? (path && upstreamUrl ? "remote" : path ? "remote" : "none");

  // External mode must be decided before the `path === null` short-circuit
  // below: it deliberately has no First Tree tree path, so it would otherwise
  // render as an unbound tree and re-introduce the `first-tree-*` prose.
  if (source === "external") {
    return {
      source: "external",
      bound: repository !== undefined && repository !== null,
      repository: repository ?? null,
      path: null,
      upstreamUrl: null,
      branch,
      // Every command field is null here: the external `context-tree-*` Skills
      // carry their own operating instructions, and each render site for these
      // fields lives in a `remote` / `local` branch that external mode skips.
      verifyCommand: null,
      hierarchyHelpCommand: null,
      localResolveReadCommand: null,
      localResolveWriteCommand: null,
      cloneCommand: null,
      removeSymlinkCommand: null,
      pullCommand: null,
      addWorktreeCommand: null,
    };
  }

  if (source === "none" || path === null) {
    return {
      source: "none",
      bound: false,
      repository: null,
      path: null,
      upstreamUrl: null,
      branch,
      verifyCommand: `${bin} tree verify`,
      hierarchyHelpCommand: `${bin} tree tree --help`,
      localResolveReadCommand: null,
      localResolveWriteCommand: null,
      cloneCommand: null,
      removeSymlinkCommand: null,
      pullCommand: null,
      addWorktreeCommand: null,
    };
  }

  const quotedPath = shellQuote(path);
  if (source === "local") {
    return {
      source: "local",
      bound: true,
      repository: null,
      path,
      upstreamUrl: null,
      branch,
      verifyCommand: `${bin} tree verify --tree-path ${quotedPath}`,
      hierarchyHelpCommand: `${bin} tree tree --tree-path ${quotedPath} --help`,
      localResolveReadCommand: `${bin} tree local resolve --ensure --intent read`,
      localResolveWriteCommand: `${bin} tree local resolve --ensure --intent write`,
      cloneCommand: null,
      removeSymlinkCommand: null,
      pullCommand: null,
      addWorktreeCommand: null,
    };
  }

  return {
    source: "remote",
    bound: true,
    repository: null,
    path,
    upstreamUrl,
    branch,
    verifyCommand: `${bin} tree verify`,
    hierarchyHelpCommand: `${bin} tree tree --help`,
    localResolveReadCommand: null,
    localResolveWriteCommand: null,
    cloneCommand: upstreamUrl
      ? `git clone --branch ${shellQuote(branch)} --single-branch ${shellQuote(upstreamUrl)} ${quotedPath}`
      : `git clone --branch <branch> --single-branch <tree-repo-url> ${quotedPath}`,
    removeSymlinkCommand: `rm ${quotedPath}`,
    pullCommand: `git -C ${quotedPath} pull --ff-only`,
    addWorktreeCommand: `git -C ${quotedPath} worktree add …`,
  };
}

function renderAgentBriefingTemplate(model: AgentBriefingRenderModel): string {
  const template = readAgentBriefingTemplate();
  return getEjsRuntime().render(template.source, model, { filename: template.filename });
}

function readAgentBriefingTemplate(): CachedTemplate {
  if (templateCache) return templateCache;
  const filename = resolveAgentBriefingTemplatePath();
  templateCache = {
    filename,
    source: readFileSync(filename, "utf8"),
  };
  return templateCache;
}

export function resolveAgentBriefingTemplatePath(): string {
  for (const url of TEMPLATE_CANDIDATE_URLS) {
    const filename = fileURLToPath(url);
    if (existsSync(filename)) return filename;
  }
  throw new Error(
    `Agent briefing EJS template is missing. Expected ${AGENT_BRIEFING_TEMPLATE_FILENAME} in the client runtime templates assets.`,
  );
}

export function resolveCanonicalContextTreePolicyPath(): string {
  for (const url of CONTEXT_TREE_POLICY_CANDIDATE_URLS) {
    const filename = fileURLToPath(url);
    if (existsSync(filename)) return filename;
  }
  throw new Error("Canonical Context Tree policy is missing from the First Tree skill bundle.");
}

export function readCanonicalContextTreePolicy(): string {
  if (contextTreePolicyCache !== null) return contextTreePolicyCache;
  contextTreePolicyCache = readFileSync(resolveCanonicalContextTreePolicyPath(), "utf8");
  return contextTreePolicyCache;
}

export function resolveCanonicalContextTreeWriteRoutingPath(): string {
  for (const url of CONTEXT_TREE_WRITE_ROUTING_CANDIDATE_URLS) {
    const filename = fileURLToPath(url);
    if (existsSync(filename)) return filename;
  }
  throw new Error("Canonical Context Tree write routing contract is missing from the client runtime assets.");
}

/** Read the provider-neutral source-artifact to Tree-write routing contract. */
export function readCanonicalContextTreeWriteRouting(): string {
  if (contextTreeWriteRoutingCache !== null) return contextTreeWriteRoutingCache;
  contextTreeWriteRoutingCache = readFileSync(resolveCanonicalContextTreeWriteRoutingPath(), "utf8").trim();
  return contextTreeWriteRoutingCache;
}

/** Names of the First Tree skills listed by both routing tables. */
export const FIRST_TREE_FAMILY_SKILL_NAMES = [
  "first-tree-welcome",
  "first-tree-write",
  "first-tree-read",
  "first-tree-seed",
  "first-tree-file-bug",
  "context-tree-review",
  "context-tree-audit",
  "first-tree-qa",
] as const;
