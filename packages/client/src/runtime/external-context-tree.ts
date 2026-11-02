import type { ChildProcess } from "node:child_process";
import {
  chmodSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { defaultDataDir, normalizeContextTreeRef, readContextTreeRefSetting } from "@first-tree/shared/config";
import { getChildProcessRegistry } from "./child-process-registry.js";
import { retireLegacyContextTreeInstallOnce } from "./external-context-tree-legacy.js";
import { CORE_SKILL_NAMES } from "./first-tree-skills/installer.js";

/**
 * The external Context Tree CLI (`@first-tree-ai/context-tree`, 1.x).
 *
 * It ships the `context-tree-*` Skill family and the command surface those
 * Skills call by name. First Tree pins it as a normal dependency rather than
 * relying on a global install, so every machine runs the release it was tested
 * with. We never import it as a module — we resolve its bin and spawn it, so the
 * bundler never pulls it into `dist/`.
 *
 * Everything 1.x needs is per project: Skills are installed into each Agent
 * workspace (`.claude/skills`, `.agents/skills`) and the connection is the
 * workspace's own `.context-tree.json`. Nothing here writes to the account-level
 * Skill directories or a global connection store; what earlier releases left
 * there is retired by `external-context-tree-legacy.ts`.
 */
export const CONTEXT_TREE_PACKAGE = "@first-tree-ai/context-tree";

/** `connect` and `git ls-remote` reach the network, so allow for a slow one. */
const CONTEXT_TREE_TIMEOUT_MS = 3 * 60 * 1000;

/**
 * Workspace Skill roots that receive the packaged Skills: Claude Code reads
 * `.claude/skills`, Codex reads `.agents/skills`, and one workspace may run
 * either provider.
 */
const WORKSPACE_SKILL_ROOTS = [join(".claude", "skills"), join(".agents", "skills")] as const;

/** Marker identifying a shim First Tree wrote; anything without it is left alone. */
export const CONTEXT_TREE_SHIM_MARKER = "first-tree-managed context-tree shim";

/** First Tree's record of the tree it declared in each workspace. */
const CONNECTIONS_FILENAME = "context-tree-connections.json";
const CONNECTIONS_SCHEMA_VERSION = 1;

export type ContextTreeCliInvocation = { command: string; args: string[] };

export type ContextTreeCliResult =
  | { ok: true; payload: unknown }
  // `reasonCode` is the external CLI's own `error.code` (`NO_CONNECTION`,
  // `CONTEXT_TREE_FAILED`, …) when it produced a structured envelope, and absent
  // when the failure happened before or outside one.
  | { ok: false; reason: string; reasonCode?: string };

/** The tree First Tree declares in a workspace: always a whole Git repository. */
export type ExternalContextTreeTarget = { repository: string; ref: string };

export type ExternalContextTreeWorkspaceResult =
  | { ok: true; connected: boolean }
  | { ok: false; reason: string; reasonCode?: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/**
 * Locate the packaged `context-tree` bin.
 *
 * Invoked as `process.execPath <bin>` rather than through a bin shim, which
 * avoids the Windows `.cmd` EINVAL problem. Returns `null` when the dependency
 * is absent — the portable build prunes deps — so callers report a skip, not a
 * failure.
 */
export function resolveContextTreeCli(): ContextTreeCliInvocation | null {
  try {
    const require = createRequire(import.meta.url);
    const manifestPath = require.resolve(`${CONTEXT_TREE_PACKAGE}/package.json`);
    const binPath = join(dirname(manifestPath), "dist", "cli", "index.mjs");
    if (!existsSync(binPath)) return null;
    return { command: process.execPath, args: [binPath] };
  } catch {
    return null;
  }
}

/** The packaged CLI's version, or null when it is not installed. */
export function contextTreeCliVersion(): string | null {
  const entry = resolveContextTreeCli()?.args[0];
  if (entry === undefined) return null;
  try {
    const manifest: unknown = JSON.parse(readFileSync(join(dirname(entry), "..", "..", "package.json"), "utf8"));
    return isRecord(manifest) && typeof manifest.version === "string" ? manifest.version : null;
  } catch {
    return null;
  }
}

/**
 * Run one `context-tree` subcommand and parse its single-line JSON result.
 *
 * Commands that print text by default must be invoked with `--json`;
 * `skills install|uninstall` always print JSON. A failure is an
 * `{ok:false,error:{code,message}}` envelope, which the CLI does not always pair
 * with a non-zero exit code, so the envelope wins over the exit code.
 */
export async function runContextTreeCommand(
  args: readonly string[],
  options: { cwd?: string } = {},
): Promise<ContextTreeCliResult> {
  const cli = resolveContextTreeCli();
  if (!cli) {
    return {
      ok: false,
      reason: `${CONTEXT_TREE_PACKAGE} is not installed beside this CLI.`,
      reasonCode: "context_tree_cli_missing",
    };
  }
  const result = await spawnForStdout(cli.command, [...cli.args, ...args], `context-tree ${args.join(" ")}`, {
    ...options,
    // The CLI clones and fetches with `git`; a daemon has no terminal to prompt on.
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  });
  if ("reason" in result) return { ok: false, reason: result.reason };

  const payload = parseJsonLine(result.stdout);
  const envelopeError = isRecord(payload) && isRecord(payload.error) ? payload.error : undefined;
  if (result.code === 0 && payload !== undefined && !(isRecord(payload) && payload.ok === false)) {
    return { ok: true, payload };
  }
  const envelopeCode = typeof envelopeError?.code === "string" ? envelopeError.code : undefined;
  const envelopeMessage = typeof envelopeError?.message === "string" ? envelopeError.message : undefined;
  if (envelopeMessage !== undefined) {
    return { ok: false, reason: envelopeMessage, ...(envelopeCode ? { reasonCode: envelopeCode } : {}) };
  }
  if (result.code === 0) {
    return {
      ok: false,
      reason: "context-tree returned no parseable JSON result.",
      reasonCode: "context_tree_bad_payload",
    };
  }
  const detail = result.stderr ? `: ${result.stderr.split("\n").slice(-3).join(" | ")}` : "";
  return result.timedOut
    ? {
        ok: false,
        reason: `context-tree killed by signal ${result.signal} (timeout)${detail}`,
        reasonCode: "context_tree_timeout",
      }
    : { ok: false, reason: `context-tree exited with code ${result.code}${detail}` };
}

type SpawnOutcome =
  | { code: number | null; signal: NodeJS.Signals | null; timedOut: boolean; stdout: string; stderr: string }
  | { reason: string };

function spawnForStdout(
  command: string,
  args: readonly string[],
  label: string,
  options: { cwd?: string; env?: NodeJS.ProcessEnv },
): Promise<SpawnOutcome> {
  return new Promise((resolvePromise) => {
    let child: ChildProcess;
    try {
      ({ child } = getChildProcessRegistry().spawn(command, args, {
        category: "other",
        label,
        timeoutMs: CONTEXT_TREE_TIMEOUT_MS,
        stdio: ["ignore", "pipe", "pipe"],
        ...(options.cwd ? { cwd: options.cwd } : {}),
        ...(options.env ? { env: options.env } : {}),
      }));
    } catch (err) {
      resolvePromise({ reason: err instanceof Error ? err.message : String(err) });
      return;
    }
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    child.stdout?.on("data", (chunk: Buffer) => stdoutChunks.push(chunk));
    child.stderr?.on("data", (chunk: Buffer) => stderrChunks.push(chunk));
    child.on("error", (err) => resolvePromise({ reason: err.message }));
    child.on("exit", (code, signal) => {
      resolvePromise({
        code,
        signal,
        timedOut: code === null && signal !== null,
        stdout: Buffer.concat(stdoutChunks).toString("utf8").trim(),
        stderr: Buffer.concat(stderrChunks).toString("utf8").trim(),
      });
    });
  });
}

function parseJsonLine(stdout: string): unknown {
  if (stdout.length === 0) return undefined;
  // The payload is one line; take the last so a stray warning ahead of it
  // does not defeat parsing.
  const lines = stdout.split("\n").filter((line) => line.trim().length > 0);
  const last = lines[lines.length - 1];
  if (last === undefined) return undefined;
  try {
    return JSON.parse(last);
  } catch {
    return undefined;
  }
}

/**
 * Directory holding First Tree's own `context-tree` shim.
 *
 * It is First Tree-owned on purpose: a shared bin directory would make the
 * Agent run whichever `context-tree` the user installed globally, and a global
 * release from a different major version silently breaks the Skills this
 * machine installed. {@link buildAgentEnv} puts this directory first on every
 * Agent's `PATH`.
 */
export function contextTreeShimDir(): string {
  return join(defaultDataDir(), "context-tree", "bin");
}

/** Shim file name for this platform. */
export function contextTreeShimName(): string {
  return process.platform === "win32" ? "context-tree.cmd" : "context-tree";
}

/**
 * Write the `context-tree` shim the installed Skills invoke by name.
 *
 * Absolute paths are baked in deliberately: the Agent's `PATH` is a controlled
 * list that need not contain `node`. Every call rewrites it, so a Node version
 * bump or a First Tree upgrade heals itself.
 */
export function writeContextTreeShim(): { path: string } | { reason: string } {
  const cli = resolveContextTreeCli();
  const target = cli?.args[0];
  if (!cli || target === undefined) return { reason: `${CONTEXT_TREE_PACKAGE} is not installed beside this CLI` };
  const directory = contextTreeShimDir();
  const shimPath = join(directory, contextTreeShimName());
  const body =
    process.platform === "win32"
      ? `@echo off\r\nrem ${CONTEXT_TREE_SHIM_MARKER}\r\n"${cli.command}" "${target}" %*\r\n`
      : `#!/bin/sh\n# ${CONTEXT_TREE_SHIM_MARKER}\nexec "${cli.command}" "${target}" "$@"\n`;
  try {
    mkdirSync(directory, { recursive: true });
    if (existsSync(shimPath) && readFileSync(shimPath, "utf8") === body) return { path: shimPath };
    const staging = `${shimPath}.${process.pid}.tmp`;
    writeFileSync(staging, body, "utf8");
    if (process.platform !== "win32") chmodSync(staging, 0o755);
    renameSync(staging, shimPath);
    return { path: shimPath };
  } catch (err) {
    return {
      reason: `could not write the context-tree shim in ${directory}: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

const defaultBranchCache = new Map<string, string>();

/**
 * The branch to connect: the configured `context_tree.ref`, or the repository's
 * default branch. 1.x `connect` requires an explicit ref, and resolving it from
 * the remote keeps the zero-configuration behaviour of the 0.1 CLI, which
 * followed the default branch on its own.
 */
export async function resolveContextTreeRef(
  repository: string,
  configuredRef: string | null,
): Promise<{ ref: string } | { reason: string }> {
  if (configuredRef !== null) return { ref: configuredRef };
  const cached = defaultBranchCache.get(repository);
  if (cached !== undefined) return { ref: cached };
  const result = await spawnForStdout(
    "git",
    ["ls-remote", "--symref", `https://github.com/${repository}.git`, "HEAD"],
    `git ls-remote ${repository}`,
    // A daemon has no terminal; fail on missing credentials instead of waiting for one.
    { env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } },
  );
  if ("reason" in result)
    return { reason: `could not run git to find ${repository}'s default branch: ${result.reason}` };
  const match = /^ref: refs\/heads\/(\S+)\tHEAD$/mu.exec(result.stdout);
  const ref = match?.[1] ? normalizeContextTreeRef(match[1]) : null;
  if (result.code !== 0 || ref === null) {
    const detail = result.stderr ? `: ${result.stderr.split("\n").slice(-1)[0]}` : "";
    return { reason: `could not find ${repository}'s default branch${detail}; set context_tree.ref` };
  }
  defaultBranchCache.set(repository, ref);
  return { ref };
}

type ConnectionRecords = Map<string, ExternalContextTreeTarget>;

function connectionsPath(): string {
  return join(defaultDataDir(), CONNECTIONS_FILENAME);
}

function readConnectionRecords(): ConnectionRecords {
  const records: ConnectionRecords = new Map();
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(connectionsPath(), "utf8"));
  } catch {
    return records;
  }
  if (!isRecord(value) || value.schemaVersion !== CONNECTIONS_SCHEMA_VERSION || !isRecord(value.workspaces)) {
    return records;
  }
  for (const [workspace, target] of Object.entries(value.workspaces)) {
    if (isRecord(target) && typeof target.repository === "string" && typeof target.ref === "string") {
      records.set(workspace, { repository: target.repository, ref: target.ref });
    }
  }
  return records;
}

/**
 * Set or clear one workspace's record. Re-reads the file at write time: the
 * callers await CLI commands between deciding and writing, and concurrent
 * session starts for other workspaces may have written in the meantime.
 */
function updateConnectionRecord(workspace: string, target: ExternalContextTreeTarget | null): void {
  const records = readConnectionRecords();
  const current = records.get(workspace);
  if (
    target === null ? current === undefined : current?.repository === target.repository && current.ref === target.ref
  ) {
    return;
  }
  if (target === null) records.delete(workspace);
  else records.set(workspace, target);
  writeConnectionRecords(records);
}

function writeConnectionRecords(records: ConnectionRecords): void {
  mkdirSync(defaultDataDir(), { recursive: true });
  const staging = `${connectionsPath()}.${process.pid}.tmp`;
  writeFileSync(
    staging,
    JSON.stringify({ schemaVersion: CONNECTIONS_SCHEMA_VERSION, workspaces: Object.fromEntries(records) }),
  );
  renameSync(staging, connectionsPath());
}

/** The tree declarations in a workspace's `.context-tree.json`, or [] when it has none. */
function declaredTrees(workspace: string): Record<string, unknown>[] {
  try {
    const value: unknown = JSON.parse(readFileSync(join(workspace, ".context-tree.json"), "utf8"));
    if (!isRecord(value) || !Array.isArray(value.trees)) return [];
    return value.trees.filter(isRecord);
  } catch {
    return [];
  }
}

function declares(workspace: string, target: ExternalContextTreeTarget): boolean {
  return declaredTrees(workspace).some(
    (tree) =>
      tree.kind === "git" &&
      typeof tree.repository === "string" &&
      tree.repository.toLowerCase() === target.repository.toLowerCase() &&
      (tree.path ?? ".") === "." &&
      tree.ref === target.ref,
  );
}

/** Repository name, which is how 1.x `--tree` selects a declared Git source. */
function treeSelector(repository: string): string {
  return repository.slice(repository.indexOf("/") + 1);
}

/** The packaged `context-tree-*` Skill directory (`<pkg>/skills`), or null when absent. */
function packagedSkillsRoot(): string | null {
  const entry = resolveContextTreeCli()?.args[0];
  if (entry === undefined) return null;
  // …/dist/cli/index.mjs -> …/skills
  const root = join(dirname(entry), "..", "..", "skills");
  return existsSync(root) ? root : null;
}

/**
 * Names of the packaged Skills First Tree may place in a workspace.
 *
 * First Tree's own Core Skills `context-tree-review` / `context-tree-audit`
 * share the `context-tree-` prefix and are owned by the Managed Skills ledger,
 * so a packaged name that collides with a Core Skill is never written or
 * removed here. That is also why the CLI's own `skills install|uninstall
 * --project` is not used: both delete every `context-tree-*` directory in the
 * destination, Core Skills included.
 */
export function packagedContextTreeSkillNames(): string[] {
  const root = packagedSkillsRoot();
  if (root === null) return [];
  const core = new Set<string>(CORE_SKILL_NAMES);
  return readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name.startsWith("context-tree-") && !core.has(entry.name))
    .map((entry) => entry.name)
    .sort();
}

/** Workspaces whose Skills were installed by this process, keyed by CLI version. */
const installedSkills = new Map<string, string>();

/** Refuse to write through a symlinked or non-directory Skill root. */
function realSkillRoot(workspace: string, relative: string): string {
  let current = workspace;
  for (const segment of relative.split(/[\\/]/u)) {
    current = join(current, segment);
    const entry = lstatSync(current, { throwIfNoEntry: false });
    if (entry === undefined) {
      mkdirSync(current);
      continue;
    }
    if (entry.isSymbolicLink() || !entry.isDirectory()) {
      throw new Error(`Skill directory must be a real directory: ${current}`);
    }
  }
  return current;
}

function installWorkspaceSkills(workspace: string): ContextTreeCliResult {
  const version = contextTreeCliVersion() ?? "unknown";
  if (installedSkills.get(workspace) === version) return { ok: true, payload: null };
  const source = packagedSkillsRoot();
  const names = packagedContextTreeSkillNames();
  if (source === null || names.length === 0) {
    return { ok: false, reason: `${CONTEXT_TREE_PACKAGE} ships no Skills; reinstall First Tree` };
  }
  try {
    for (const relative of WORKSPACE_SKILL_ROOTS) {
      const root = realSkillRoot(workspace, relative);
      for (const name of names) {
        // Stage beside the target and swap, so a crash never leaves a half-copied Skill.
        const staging = join(root, `.${name}.${process.pid}.staging`);
        rmSync(staging, { recursive: true, force: true });
        cpSync(join(source, name), staging, { recursive: true, verbatimSymlinks: true });
        rmSync(join(root, name), { recursive: true, force: true });
        renameSync(staging, join(root, name));
      }
    }
  } catch (err) {
    return {
      ok: false,
      reason: `could not install Context Tree Skills in ${workspace}: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  installedSkills.set(workspace, version);
  return { ok: true, payload: null };
}

function removeWorkspaceSkills(workspace: string): ContextTreeCliResult {
  installedSkills.delete(workspace);
  try {
    for (const relative of WORKSPACE_SKILL_ROOTS) {
      const root = join(workspace, relative);
      const entry = lstatSync(root, { throwIfNoEntry: false });
      if (entry === undefined || entry.isSymbolicLink() || !entry.isDirectory()) continue;
      for (const name of packagedContextTreeSkillNames()) rmSync(join(root, name), { recursive: true, force: true });
    }
  } catch (err) {
    return {
      ok: false,
      reason: `could not remove Context Tree Skills from ${workspace}: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  return { ok: true, payload: null };
}

/**
 * Give one Agent workspace the `context-tree-*` Skills and a connection to the
 * configured tree.
 *
 * Skills go into both workspace Skill roots, because the same workspace may run
 * Claude Code (`.claude/skills`) or Codex (`.agents/skills`). The connection is
 * only re-made when the workspace does not already declare the target, so a
 * session start normally costs no network round trip. A previous target that
 * First Tree declared — a changed repository or ref — is disconnected first;
 * trees the Agent connected itself are left alone.
 *
 * Never throws: an Agent without a tree still runs, and its Skills report
 * `NO_CONNECTION` to it.
 */
export async function ensureExternalContextTreeWorkspace(
  workspace: string,
  target: ExternalContextTreeTarget,
): Promise<ExternalContextTreeWorkspaceResult> {
  if (!resolveContextTreeCli())
    return { ok: false, reason: `${CONTEXT_TREE_PACKAGE} is not installed beside this CLI` };
  const shim = writeContextTreeShim();
  if ("reason" in shim) return { ok: false, reason: shim.reason };
  const skills = installWorkspaceSkills(workspace);
  if (!skills.ok) return skills;

  // Recorded as soon as the Skills land, before connecting, so a revert finds
  // every workspace First Tree wrote into even when the connect failed.
  const previous = readConnectionRecords().get(workspace);
  if (declares(workspace, target)) {
    updateConnectionRecord(workspace, target);
    return { ok: true, connected: false };
  }
  if (
    previous &&
    (previous.repository !== target.repository || previous.ref !== target.ref) &&
    declaredTrees(workspace).length > 0
  ) {
    // Best-effort: a stale declaration that will not go away still leaves the
    // new tree connected, and the Skills ask the Agent to pick with `--tree`.
    await runContextTreeCommand([
      "disconnect",
      "--tree",
      treeSelector(previous.repository),
      "--project-path",
      workspace,
      "--json",
    ]);
  }
  updateConnectionRecord(workspace, target);
  const connect = await runContextTreeCommand(
    ["connect", target.repository, "--ref", target.ref, "--project-path", workspace, "--json"],
    { cwd: workspace },
  );
  if (!connect.ok) return connect;
  return { ok: true, connected: true };
}

/**
 * Undo {@link ensureExternalContextTreeWorkspace} for one workspace once
 * external mode is switched off: remove the workspace's `context-tree-*` Skills
 * and the declaration First Tree recorded. Content, snapshots and write
 * sessions stay where the CLI keeps them.
 */
export async function removeExternalContextTreeWorkspace(
  workspace: string,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  if (!resolveContextTreeCli())
    return { ok: false, reason: `${CONTEXT_TREE_PACKAGE} is not installed beside this CLI` };
  const skills = removeWorkspaceSkills(workspace);
  if (!skills.ok) return skills;
  const previous = readConnectionRecords().get(workspace);
  if (previous) {
    if (declaredTrees(workspace).length > 0) {
      const disconnect = await runContextTreeCommand([
        "disconnect",
        "--tree",
        treeSelector(previous.repository),
        "--project-path",
        workspace,
        "--json",
      ]);
      if (!disconnect.ok && disconnect.reasonCode !== "NO_CONNECTION") return disconnect;
    }
    updateConnectionRecord(workspace, null);
  }
  return { ok: true };
}

/** Workspaces First Tree installed Context Tree Skills into, for revert. */
export function recordedExternalContextTreeWorkspaces(): string[] {
  return [...readConnectionRecords().keys()];
}

/**
 * Session-start entry point for an Agent workspace in external mode.
 *
 * Login connects every existing workspace up front; this covers Agents created
 * since, a ref changed in config, and a First Tree upgrade that ships new
 * Skills. Failures are logged, never thrown: the session still starts, and the
 * Skills report `NO_CONNECTION` to the Agent.
 */
export async function prepareExternalContextTreeForSession(
  workspace: string,
  repository: string,
  log: (message: string) => void,
): Promise<void> {
  retireLegacyContextTreeInstallOnce(log);
  const { raw, ref: configuredRef } = readContextTreeRefSetting();
  if (raw !== null && configuredRef === null) {
    log(`Context Tree: context_tree.ref value ${JSON.stringify(raw)} is unusable; using the default branch`);
  }
  const ref = await resolveContextTreeRef(repository, configuredRef);
  if ("reason" in ref) {
    log(`Context Tree: ${ref.reason}`);
    return;
  }
  const result = await ensureExternalContextTreeWorkspace(workspace, { repository, ref: ref.ref });
  if (!result.ok) log(`Context Tree: could not prepare ${repository}@${ref.ref}: ${result.reason}`);
  else if (result.connected) log(`Context Tree: connected ${repository}@${ref.ref}`);
}
