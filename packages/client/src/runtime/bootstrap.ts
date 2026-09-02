import { randomBytes } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  renameSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import type { FirstTreeHubSDK } from "../cloud/sdk.js";
import { type ContextSourceKind, resolveAgentContextSource } from "./context-source.js";
import type { AgentIdentity } from "./handler.js";
import { requireTrustedDirectory } from "./trusted-workspace-paths.js";
import { atomicWriteText, workspaceHasRemoteLatch } from "./workspace-manifest.js";

/**
 * Resolved Context Tree binding the runtime threads through every layer:
 * the agent-local checkout path AND the upstream coordinates.
 *
 * Per the agent-managed-repos design the runtime performs **no git
 * operations** on this path — the agent itself clones and refreshes
 * `<agentHome>/context-tree` following the protocol injected into its
 * briefing (clone-if-missing; `git pull --ff-only` before every tree
 * read). The runtime only *names* the path (briefing, workspace manifest,
 * identity.json) and *observes* it read-only (`git rev-parse` HEAD-drift
 * detection in `agent-bootstrap.ts`). The upstream URL and branch are
 * surfaced in the briefing so the agent knows what to clone.
 */
export type ContextTreeBinding = {
  path: string;
  repoUrl: string;
  branch: string;
};

/**
 * Resolve a remote Context Tree binding for the authenticated runtime agent.
 * Local and unknown sources return `null` — callers that need the discriminant
 * should use {@link resolveAgentContextSource}.
 */
export async function resolveAgentContextTreeBinding(
  sdk: FirstTreeHubSDK,
  workspaceRoot: string,
  log: (msg: string) => void,
): Promise<ContextTreeBinding | null> {
  const source = await resolveAgentContextSource(sdk, workspaceRoot, log);
  if (source.kind !== "remote") return null;
  return { path: source.path, repoUrl: source.repoUrl, branch: source.branch };
}

/**
 * Marker directory written into every workspace so the Codex CLI's
 * project-root detection (configured via
 * `project_root_markers: [".first-tree-workspace"]`) stops at the workspace
 * boundary instead of walking up the filesystem and loading an unintended
 * `AGENTS.md` from the operator's home or repo root.
 */
export const FIRST_TREE_WORKSPACE_MARKER = ".first-tree-workspace";
export const FIRST_TREE_RUNTIME_DIR = FIRST_TREE_WORKSPACE_MARKER;
export const LEGACY_AGENT_RUNTIME_DIR = ".agent";
export const IDENTITY_JSON_REL = join(FIRST_TREE_RUNTIME_DIR, "identity.json");

/**
 * Materialise the unified agent briefing at `<workspacePath>/AGENTS.md` and
 * keep `<workspacePath>/CLAUDE.md` as a relative symlink to it where the host
 * permits symlink creation. Windows hosts without symlink privileges fall back
 * to a regular `CLAUDE.md` copy so Claude Code can still read the briefing.
 *
 * One file, both providers: Codex's `project_root_markers` walk finds
 * `AGENTS.md` directly; Claude Code's `settingSources: ["project"]` follows
 * the `CLAUDE.md` symlink. Edits to the briefing layout only need to land in
 * the {@link buildAgentBriefing} producer.
 */
export function writeAgentBriefing(workspacePath: string, content: string): void {
  atomicWriteText(join(workspacePath, "AGENTS.md"), content);
  ensureClaudeMdSymlink(workspacePath, content);
}

/**
 * Make `<workspacePath>/CLAUDE.md` a relative symlink to `AGENTS.md` where
 * possible. Replaces a stale regular file or broken/mis-targeted symlink left
 * from earlier bootstrap formats; a no-op when the symlink is already correct.
 * On Windows symlink permission failures (`EPERM` / `EACCES`), falls back to a
 * regular file copy carrying the same briefing content.
 *
 * Atomically swaps in the new symlink via `rename` so two concurrent
 * same-agent starts can't race the unlink/symlink pair into an `EEXIST`
 * (PR #797 review nit #3). We materialise the new link at a unique
 * sibling path, then `rename` it onto `CLAUDE.md` — POSIX makes that
 * atomic, and the rename overwrites any existing file or symlink in place.
 * The temp file is cleaned up on any failure so a crashed write does not
 * leak siblings.
 *
 * ⚠️ SDK assumption (regression-watch on `@anthropic-ai/claude-agent-sdk`
 * version bumps): this layout relies on the Claude Code SDK enumerating
 * ONLY `<cwd>/CLAUDE.md` as a Project memory file — the SDK does not look
 * for `<cwd>/AGENTS.md` separately, so the symlink is resolved
 * transparently with no double-load. Verified on 0.2.84 (`grep -c
 * '"AGENTS.md"' cli.js` → 0; `grep -c '"CLAUDE.md"' cli.js` → 13, all on
 * Project / User / Local / Managed memory paths). If a future SDK adds
 * AGENTS.md as a sibling Project memory entry, the briefing would
 * double-load — re-run the manual probes documented in tree-context PR
 * #397 before upgrading the SDK major version.
 */
export function ensureClaudeMdSymlink(workspacePath: string, fallbackContent?: string): void {
  const claudeMd = join(workspacePath, "CLAUDE.md");
  const targetRel = "AGENTS.md";
  try {
    const stats = lstatSync(claudeMd);
    if (stats.isSymbolicLink() && readlinkSync(claudeMd) === targetRel) return;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
  const tempPath = join(workspacePath, `.CLAUDE.md.${randomBytes(6).toString("hex")}.tmp`);
  try {
    symlinkSync(targetRel, tempPath);
  } catch (err) {
    try {
      rmSync(tempPath, { force: true, recursive: true });
    } catch {
      // Best-effort cleanup — surface the original symlink failure unless
      // Windows can use the regular-file fallback below.
    }
    if (!isWindowsSymlinkPermissionError(err)) throw err;
    writeClaudeMdFallbackFile(workspacePath, fallbackContent);
    return;
  }
  try {
    renameSync(tempPath, claudeMd);
  } catch (err) {
    try {
      unlinkSync(tempPath);
    } catch {
      // Best-effort cleanup — surface the original rename failure.
    }
    throw err;
  }
}

function writeClaudeMdFallbackFile(workspacePath: string, content?: string): void {
  const claudeMd = join(workspacePath, "CLAUDE.md");
  const nextContent = content ?? readFileSync(join(workspacePath, "AGENTS.md"), "utf8");
  const tempPath = join(workspacePath, `.CLAUDE.md.${randomBytes(6).toString("hex")}.tmp`);
  writeFileSync(tempPath, nextContent, "utf-8");
  try {
    renameSync(tempPath, claudeMd);
  } catch (err) {
    try {
      unlinkSync(tempPath);
    } catch {
      // Best-effort cleanup — surface the original rename failure.
    }
    throw err;
  }
}

function isWindowsSymlinkPermissionError(err: unknown): boolean {
  if (process.platform !== "win32") return false;
  const code = (err as NodeJS.ErrnoException | undefined)?.code;
  return code === "EPERM" || code === "EACCES";
}

function lstatIfExists(path: string) {
  try {
    return lstatSync(path);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

/**
 * Merge legacy `.agent/` entries into `.first-tree-workspace/`.
 *
 * Conflict policy is intentionally "target wins": if a path already exists in
 * the target, the legacy source entry at that path is pruned instead of
 * overwriting newer runtime state. That keeps partial upgrades and repeated
 * bootstraps idempotent.
 */
function mergeLegacyRuntimeDir(sourceDir: string, targetDir: string): void {
  mkdirSync(targetDir, { recursive: true });
  for (const entry of readdirSync(sourceDir)) {
    const sourcePath = join(sourceDir, entry);
    const targetPath = join(targetDir, entry);
    const sourceStats = lstatSync(sourcePath);
    if (sourceStats.isDirectory()) {
      if (existsSync(targetPath) && lstatSync(targetPath).isDirectory()) {
        mergeLegacyRuntimeDir(sourcePath, targetPath);
      } else if (!existsSync(targetPath)) {
        renameSync(sourcePath, targetPath);
      } else {
        rmSync(sourcePath, { recursive: true, force: true });
      }
      continue;
    }
    if (!existsSync(targetPath)) {
      renameSync(sourcePath, targetPath);
    } else {
      rmSync(sourcePath, { recursive: true, force: true });
    }
  }
  rmSync(sourceDir, { recursive: true, force: true });
}

/**
 * Converge the runtime state onto the current `.first-tree-workspace/` layout.
 *
 * Legacy states we still heal automatically:
 *
 * - root marker file `.first-tree-workspace` from the pre-directory layout
 * - stable runtime dir `.agent/` from the pre-rename layout
 *
 * The resulting directory both stores the stable runtime files and acts as the
 * root marker Codex uses for project detection.
 *
 * Note: apps/cli still has a separate W1 migration path that reasons about a
 * legacy file marker named `.first-tree-workspace` inside user workspaces.
 * This helper only heals the per-agent runtime home under
 * `<dataDir>/workspaces/<agent>/`, so replacing a pre-existing file or symlink
 * here does not participate in CLI workspace detection.
 */
export function ensureWorkspaceRuntimeDir(workspacePath: string): string {
  const workspaceRoot = requireTrustedDirectory(workspacePath, "Agent workspace root");
  const runtimeDir = join(workspaceRoot, FIRST_TREE_RUNTIME_DIR);
  const legacyAgentDir = join(workspaceRoot, LEGACY_AGENT_RUNTIME_DIR);
  const runtimeStats = lstatIfExists(runtimeDir);

  if (runtimeStats?.isSymbolicLink()) {
    throw new Error(`refusing to use symlinked Agent runtime directory: ${runtimeDir}`);
  }
  if (runtimeStats && !runtimeStats.isDirectory()) {
    if (!runtimeStats.isFile()) {
      throw new Error(`refusing to replace special Agent runtime entry: ${runtimeDir}`);
    }
    unlinkSync(runtimeDir);
  }

  const legacyAgentStats = lstatIfExists(legacyAgentDir);
  const currentRuntimeStats = lstatIfExists(runtimeDir);
  if (legacyAgentStats?.isDirectory()) {
    if (currentRuntimeStats?.isDirectory()) {
      mergeLegacyRuntimeDir(legacyAgentDir, runtimeDir);
    } else if (!currentRuntimeStats) {
      renameSync(legacyAgentDir, runtimeDir);
    }
  }

  mkdirSync(runtimeDir, { recursive: true });
  requireTrustedDirectory(runtimeDir, "Agent runtime directory");
  return runtimeDir;
}

/**
 * Apply the legacy runtime-layout migration without rewriting identity or any
 * other bootstrap-managed files. Shared by handler bootstrap and the client
 * startup migration so both converge on the same cleanup: move `.agent/`
 * into `.first-tree-workspace/`, then prune legacy `.agent/context/` and
 * `.agent/tools.md` payloads that the unified briefing replaced.
 */
export function migrateLegacyRuntimeLayout(workspacePath: string): string {
  const runtimeDir = ensureWorkspaceRuntimeDir(workspacePath);
  const legacyContextDir = join(runtimeDir, "context");
  if (existsSync(legacyContextDir)) {
    rmSync(legacyContextDir, { recursive: true, force: true });
  }
  const legacyToolsMd = join(runtimeDir, "tools.md");
  if (existsSync(legacyToolsMd)) {
    rmSync(legacyToolsMd, { force: true });
  }
  return runtimeDir;
}

export type BootstrapOptions = {
  workspacePath: string;
  identity: AgentIdentity;
  /** Stable AgentSlot `config.name`. Never inferred from displayName or path. */
  agentName: string;
  contextTreePath: string | null;
  contextSourceKind?: ContextSourceKind;
  serverUrl: string;
};

/**
 * Bootstrap the agent's home directory with stable, agent-level files inside
 * the workspace-root marker directory.
 *
 * Writes identity.json into `.first-tree-workspace/`. Per the
 * agent-session-cwd-redesign (proposals/2026-05-19) **only agent-level stable
 * fields** live in identity.json; per-chat data (chatId, participants) flows
 * through provider/session prompt injection, not through identity.json or the
 * shared briefing written by {@link writeAgentBriefing}.
 *
 * The bootstrap no longer stages AGENT.md / NODE.md copies under the legacy
 * `.agent/context/` tree and no longer emits `.agent/tools.md`. The unified
 * briefing owns all of that content; the runtime briefing is the single source
 * of agent-level instructions on disk.
 *
 * Idempotent: safe to call on every handler start() / resume(), though in
 * the per-agent-home model the handler short-circuits this when the
 * `.first-tree-workspace/init-complete` sentinel is already present.
 */
export function bootstrapWorkspace(options: BootstrapOptions): void {
  const { workspacePath, identity, agentName, contextTreePath, contextSourceKind, serverUrl } = options;
  if (typeof agentName !== "string" || agentName.length === 0) {
    throw new Error(
      "bootstrap requires AgentSlot config.name; refusing to infer agentName from displayName or workspace path",
    );
  }
  const agentDir = migrateLegacyRuntimeLayout(workspacePath);
  const resolvedKind = contextSourceKind ?? "none";
  if (resolvedKind === "local" && workspaceHasRemoteLatch(workspacePath)) {
    return;
  }

  // 1. Write identity.json — agent-level stable fields only. chatId /
  //    chatContext used to live here but are now injected per turn so a
  //    different chat resuming this same cwd doesn't see another chat's
  //    cached participants.
  const identityData = {
    agentId: identity.agentId,
    agentName,
    displayName: identity.displayName,
    type: identity.type,
    visibility: identity.visibility,
    delegateMention: identity.delegateMention,
    metadata: identity.metadata,
    serverUrl,
    contextTreePath,
    contextSourceKind: resolvedKind,
  };
  atomicWriteText(join(agentDir, "identity.json"), JSON.stringify(identityData, null, 2));
}

/**
 * One predeclared source repository the agent config declares under the agent
 * home's `source-repos/` directory (e.g. `<agentHome>/source-repos/<localPath>/`).
 * Pure declaration — the agent itself clones/refreshes it per its briefing
 * protocol (the runtime never runs git on it). Surfaced in the per-chat system
 * prompt so the LLM knows the absolute path and upstream coordinates.
 *
 * Note: the old "PredeclaredWorktree" model put these under
 * `<agentHome>/worktrees/<name>/`. Source clones now sit under `source-repos/`
 * so the `worktrees/` subdir is reserved **entirely** for agent-on-demand
 * worktrees the LLM creates per task.
 */
export type PredeclaredSourceRepo = {
  /** Absolute path on the host filesystem (under the agent home's `source-repos/` dir). */
  absolutePath: string;
  url: string;
  ref?: string;
  branch?: string;
};

/**
 * Field-by-field equality for the identity record both handlers write into
 * `.first-tree-workspace/identity.json`. Implemented manually so a missing
 * key on disk from an older bootstrap is treated as drift even when
 * `JSON.stringify` happens to match by chance.
 *
 * Shared between claude-code and codex handlers — both call
 * `ensureStableIdentity` / `ensureCodexBootstrap` to hash-check before
 * skipping the bootstrap rewrite.
 */
export function deepEqualIdentity(a: unknown, b: unknown): boolean {
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return a === b;
  const aRec = a as Record<string, unknown>;
  const bRec = b as Record<string, unknown>;
  const keys = new Set([...Object.keys(aRec), ...Object.keys(bRec)]);
  for (const k of keys) {
    const av = aRec[k];
    const bv = bRec[k];
    if (typeof av === "object" && typeof bv === "object") {
      if (JSON.stringify(av) !== JSON.stringify(bv)) return false;
    } else if (av !== bv) {
      return false;
    }
  }
  return true;
}
