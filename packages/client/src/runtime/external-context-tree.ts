import type { ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import type { Dirent } from "node:fs";
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
import { dirname, join, sep } from "node:path";
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

/**
 * `preservedSkillPaths` are workspace Skill directories under a packaged name
 * that First Tree did not write, or that were edited since, and so were left
 * as they are while differing from the packaged payload.
 */
export type ExternalContextTreeWorkspaceResult =
  | { ok: true; connected: boolean; preservedSkillPaths: string[] }
  | { ok: false; reason: string; reasonCode?: string; preservedSkillPaths?: string[] };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
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

/**
 * What First Tree created in one workspace, and nothing else.
 *
 * `declared` is set only when First Tree's own `connect` created the
 * declaration; a matching declaration that was already there stays the
 * operator's or Agent's. `skills` maps each Skill directory First Tree wrote
 * (workspace-relative) to the digest it wrote, which is what proves a later
 * replace or remove touches an unedited First Tree copy.
 */
type WorkspaceRecord = { declared: ExternalContextTreeTarget | null; skills: Record<string, string> };
type WorkspaceRecords = Map<string, WorkspaceRecord>;

function connectionsPath(): string {
  return join(defaultDataDir(), CONNECTIONS_FILENAME);
}

function readWorkspaceRecords(): WorkspaceRecords {
  const records: WorkspaceRecords = new Map();
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(connectionsPath(), "utf8"));
  } catch {
    return records;
  }
  if (!isRecord(value) || value.schemaVersion !== CONNECTIONS_SCHEMA_VERSION || !isRecord(value.workspaces)) {
    return records;
  }
  for (const [workspace, entry] of Object.entries(value.workspaces)) {
    if (!isRecord(entry)) continue;
    const declared =
      isRecord(entry.declared) &&
      typeof entry.declared.repository === "string" &&
      typeof entry.declared.ref === "string"
        ? { repository: entry.declared.repository, ref: entry.declared.ref }
        : null;
    const skills: Record<string, string> = {};
    if (isRecord(entry.skills)) {
      for (const [path, digest] of Object.entries(entry.skills)) if (typeof digest === "string") skills[path] = digest;
    }
    records.set(workspace, { declared, skills });
  }
  return records;
}

/**
 * Read-modify-write one workspace's record. Re-reads the file at write time:
 * callers await CLI commands between deciding and writing, and concurrent
 * session starts for other workspaces may have written in the meantime. An
 * empty record is dropped.
 */
function updateWorkspaceRecord(
  workspace: string,
  update: (current: WorkspaceRecord) => WorkspaceRecord,
): WorkspaceRecord {
  const records = readWorkspaceRecords();
  const before = records.get(workspace) ?? { declared: null, skills: {} };
  const after = update({ declared: before.declared, skills: { ...before.skills } });
  if (JSON.stringify(after) === JSON.stringify(before) && records.has(workspace)) return after;
  if (after.declared === null && Object.keys(after.skills).length === 0) {
    if (!records.delete(workspace)) return after;
  } else {
    records.set(workspace, after);
  }
  mkdirSync(defaultDataDir(), { recursive: true });
  const staging = `${connectionsPath()}.${process.pid}.tmp`;
  writeFileSync(
    staging,
    JSON.stringify({ schemaVersion: CONNECTIONS_SCHEMA_VERSION, workspaces: Object.fromEntries(records) }),
  );
  renameSync(staging, connectionsPath());
  return after;
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

function sameTarget(left: ExternalContextTreeTarget | null, right: ExternalContextTreeTarget): boolean {
  return left !== null && left.repository.toLowerCase() === right.repository.toLowerCase() && left.ref === right.ref;
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

/**
 * A content digest of one Skill directory: its shape, names and bytes, in a
 * stable order. Returns null for anything that is not a plain tree of regular
 * files and directories — a linked-in Skill is never one we own.
 */
export function skillTreeDigest(root: string): string | null {
  const hash = createHash("sha256");
  const visit = (directory: string, prefix: string): boolean => {
    let entries: Dirent[];
    try {
      entries = readdirSync(directory, { withFileTypes: true });
    } catch {
      return false;
    }
    entries.sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
    for (const entry of entries) {
      const relative = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
      if (entry.isSymbolicLink()) return false;
      if (entry.isDirectory()) {
        hash.update(`d\0${relative}\0`);
        if (!visit(join(directory, entry.name), relative)) return false;
      } else if (entry.isFile()) {
        const bytes = readFileSync(join(directory, entry.name));
        hash.update(`f\0${relative}\0${bytes.length}\0`);
        hash.update(bytes);
      } else {
        return false;
      }
    }
    return true;
  };
  try {
    const entry = lstatSync(root, { throwIfNoEntry: false });
    if (entry === undefined || entry.isSymbolicLink() || !entry.isDirectory()) return null;
    return visit(root, "") ? hash.digest("hex") : null;
  } catch {
    return null;
  }
}

/** Workspaces whose Skills were reconciled by this process, keyed by CLI version. */
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

type SkillInstallResult = { ok: true; preserved: string[] } | { ok: false; reason: string };

/**
 * Place the packaged Skills in both workspace Skill roots.
 *
 * A target is written only when it is absent, or when the record proves First
 * Tree wrote it and its bytes still match what was written. Anything else under
 * a packaged name — hand-maintained, edited, or installed by someone else — is
 * left exactly as it is; one that differs from the payload is reported.
 */
function installWorkspaceSkills(workspace: string): SkillInstallResult {
  const version = contextTreeCliVersion() ?? "unknown";
  if (installedSkills.get(workspace) === version) return { ok: true, preserved: [] };
  const source = packagedSkillsRoot();
  const names = packagedContextTreeSkillNames();
  if (source === null || names.length === 0) {
    return { ok: false, reason: `${CONTEXT_TREE_PACKAGE} ships no Skills; reinstall First Tree` };
  }
  const recorded = readWorkspaceRecords().get(workspace)?.skills ?? {};
  const written: Record<string, string> = {};
  const disowned: string[] = [];
  const preserved: string[] = [];
  let failure: string | undefined;
  try {
    for (const relative of WORKSPACE_SKILL_ROOTS) {
      const root = realSkillRoot(workspace, relative);
      for (const name of names) {
        const key = join(relative, name);
        const target = join(root, name);
        const payloadDigest = skillTreeDigest(join(source, name));
        if (payloadDigest === null) throw new Error(`packaged Skill ${name} is not a plain directory`);
        if (lstatSync(target, { throwIfNoEntry: false }) !== undefined) {
          const currentDigest = skillTreeDigest(target);
          if (recorded[key] === undefined || currentDigest !== recorded[key]) {
            if (recorded[key] !== undefined) disowned.push(key);
            if (currentDigest !== payloadDigest) preserved.push(target);
            continue;
          }
          if (currentDigest === payloadDigest) {
            written[key] = payloadDigest;
            continue;
          }
        }
        // Stage beside the target and swap, so a crash never leaves a half-copied Skill.
        const staging = join(root, `.${name}.${process.pid}.staging`);
        rmSync(staging, { recursive: true, force: true });
        cpSync(join(source, name), staging, { recursive: true, verbatimSymlinks: true });
        rmSync(target, { recursive: true, force: true });
        renameSync(staging, target);
        written[key] = payloadDigest;
      }
    }
  } catch (err) {
    failure = `could not install Context Tree Skills in ${workspace}: ${describeError(err)}`;
  }
  // Record what was written even when a later target failed, so revert can find it.
  try {
    updateWorkspaceRecord(workspace, (current) => {
      for (const key of disowned) delete current.skills[key];
      return { ...current, skills: { ...current.skills, ...written } };
    });
  } catch (err) {
    failure ??= `could not record Context Tree Skills for ${workspace}: ${describeError(err)}`;
  }
  if (failure !== undefined) return { ok: false, reason: failure };
  installedSkills.set(workspace, version);
  return { ok: true, preserved };
}

/**
 * The on-disk path of a recorded Skill target, or null when it cannot be
 * proven to still live inside the workspace.
 *
 * A digest match alone does not prove that: if `.claude` or `.claude/skills`
 * has been replaced by a symlink since, the same bytes may now sit outside the
 * workspace. So the key must name one of the Skill roots plus a single plain
 * segment, and the workspace and every directory down to the Skill root must
 * be real directories — the same rule {@link realSkillRoot} applies on install.
 */
function containedSkillTarget(workspace: string, key: string): string | null {
  const root = WORKSPACE_SKILL_ROOTS.find((candidate) => key.startsWith(`${candidate}${sep}`));
  if (root === undefined) return null;
  const name = key.slice(root.length + 1);
  if (name.length === 0 || name === "." || name === ".." || /[\\/]/u.test(name)) return null;
  let current = workspace;
  for (const segment of ["", ...root.split(/[\\/]/u)]) {
    current = segment === "" ? current : join(current, segment);
    const entry = lstatSync(current, { throwIfNoEntry: false });
    if (entry === undefined || entry.isSymbolicLink() || !entry.isDirectory()) return null;
  }
  return join(current, name);
}

/**
 * Remove the Skill directories the record proves First Tree wrote and nobody
 * edited since, and that still live inside the workspace. Anything else is
 * preserved and reported.
 */
function removeWorkspaceSkills(workspace: string): { removed: string[]; preserved: string[] } {
  installedSkills.delete(workspace);
  const removed: string[] = [];
  const preserved: string[] = [];
  const skills = readWorkspaceRecords().get(workspace)?.skills ?? {};
  for (const [key, digest] of Object.entries(skills)) {
    const target = containedSkillTarget(workspace, key);
    if (target === null) {
      // A redirected or invalid Skill root: whatever is there is not provably ours.
      if (lstatSync(join(workspace, key), { throwIfNoEntry: false }) !== undefined)
        preserved.push(join(workspace, key));
      continue;
    }
    if (lstatSync(target, { throwIfNoEntry: false }) === undefined) continue;
    if (skillTreeDigest(target) !== digest) {
      preserved.push(target);
      continue;
    }
    try {
      rmSync(target, { recursive: true, force: true });
      removed.push(target);
    } catch {
      preserved.push(target);
    }
  }
  updateWorkspaceRecord(workspace, (current) => ({ ...current, skills: {} }));
  return { removed, preserved };
}

async function disconnectOwned(workspace: string, declared: ExternalContextTreeTarget): Promise<ContextTreeCliResult> {
  if (!declares(workspace, declared)) return { ok: true, payload: null };
  return runContextTreeCommand([
    "disconnect",
    "--tree",
    treeSelector(declared.repository),
    "--project-path",
    workspace,
    "--json",
  ]);
}

/**
 * Give one Agent workspace the `context-tree-*` Skills and a connection to the
 * configured tree.
 *
 * Skills go into both workspace Skill roots, because the same workspace may run
 * Claude Code (`.claude/skills`) or Codex (`.agents/skills`). The connection is
 * only made when the workspace does not already declare the target, so a
 * session start normally costs no network round trip. A matching declaration
 * that First Tree did not create is used as it is and never adopted. A
 * previous target that First Tree declared — a changed repository or ref — is
 * disconnected first; trees anyone else connected are left alone.
 *
 * Never throws: an Agent without a tree still runs, and its Skills report
 * `NO_CONNECTION` to it.
 */
export async function ensureExternalContextTreeWorkspace(
  workspace: string,
  target: ExternalContextTreeTarget,
): Promise<ExternalContextTreeWorkspaceResult> {
  try {
    return await ensureWorkspace(workspace, target);
  } catch (err) {
    // Persistence or filesystem errors stay a per-workspace failure: login
    // carries on with the next workspace and a session still starts.
    return { ok: false, reason: `could not prepare Context Tree for ${workspace}: ${describeError(err)}` };
  }
}

async function ensureWorkspace(
  workspace: string,
  target: ExternalContextTreeTarget,
): Promise<ExternalContextTreeWorkspaceResult> {
  if (!resolveContextTreeCli())
    return { ok: false, reason: `${CONTEXT_TREE_PACKAGE} is not installed beside this CLI` };
  const shim = writeContextTreeShim();
  if ("reason" in shim) return { ok: false, reason: shim.reason };
  const skills = installWorkspaceSkills(workspace);
  if (!skills.ok) return skills;
  const preservedSkillPaths = skills.preserved;

  const previous = readWorkspaceRecords().get(workspace)?.declared ?? null;
  if (previous !== null && !sameTarget(previous, target)) {
    // Best-effort: a stale declaration that will not go away still leaves the
    // new tree connected, and the Skills ask the Agent to pick with `--tree`.
    await disconnectOwned(workspace, previous);
    updateWorkspaceRecord(workspace, (current) => ({ ...current, declared: null }));
  }
  if (declares(workspace, target)) return { ok: true, connected: false, preservedSkillPaths };

  const connect = await runContextTreeCommand(
    ["connect", target.repository, "--ref", target.ref, "--project-path", workspace, "--json"],
    { cwd: workspace },
  );
  if (!connect.ok) return { ...connect, preservedSkillPaths };
  updateWorkspaceRecord(workspace, (current) => ({ ...current, declared: target }));
  return { ok: true, connected: true, preservedSkillPaths };
}

/**
 * Undo {@link ensureExternalContextTreeWorkspace} for one workspace once
 * external mode is switched off: remove the Skill directories First Tree wrote
 * and nobody edited, and the declaration First Tree created. Everything else —
 * edited Skills, declarations someone else made, snapshots and write sessions —
 * stays.
 */
export async function removeExternalContextTreeWorkspace(
  workspace: string,
): Promise<{ ok: true; preservedSkillPaths: string[] } | { ok: false; reason: string }> {
  try {
    return await removeWorkspace(workspace);
  } catch (err) {
    return { ok: false, reason: `could not revert Context Tree for ${workspace}: ${describeError(err)}` };
  }
}

async function removeWorkspace(
  workspace: string,
): Promise<{ ok: true; preservedSkillPaths: string[] } | { ok: false; reason: string }> {
  if (!resolveContextTreeCli())
    return { ok: false, reason: `${CONTEXT_TREE_PACKAGE} is not installed beside this CLI` };
  const { preserved } = removeWorkspaceSkills(workspace);
  const declared = readWorkspaceRecords().get(workspace)?.declared ?? null;
  if (declared !== null) {
    const disconnect = await disconnectOwned(workspace, declared);
    if (!disconnect.ok && disconnect.reasonCode !== "NO_CONNECTION") return disconnect;
    updateWorkspaceRecord(workspace, (current) => ({ ...current, declared: null }));
  }
  return { ok: true, preservedSkillPaths: preserved };
}

/** Workspaces First Tree wrote Skills or a declaration into, for revert. */
export function recordedExternalContextTreeWorkspaces(): string[] {
  return [...readWorkspaceRecords().keys()];
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
  try {
    await prepareForSession(workspace, repository, log);
  } catch (err) {
    log(`Context Tree: could not prepare ${repository}: ${describeError(err)}`);
  }
}

async function prepareForSession(workspace: string, repository: string, log: (message: string) => void): Promise<void> {
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
  if (result.preservedSkillPaths?.length) {
    log(`Context Tree: left Skills First Tree did not write in place: ${result.preservedSkillPaths.join(", ")}`);
  }
  if (!result.ok) log(`Context Tree: could not prepare ${repository}@${ref.ref}: ${result.reason}`);
  else if (result.connected) log(`Context Tree: connected ${repository}@${ref.ref}`);
}
