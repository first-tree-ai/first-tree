import { AsyncLocalStorage } from "node:async_hooks";
import { realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  agentContextTreeInfoSchema,
  contextTreeActiveBindingSchema,
  contextTreeBranchSchema,
  contextTreeRepoSchema,
} from "@first-tree/shared";
import { readContextTreeRepository } from "@first-tree/shared/config";
import type { FirstTreeHubSDK } from "../cloud/sdk.js";
import type { HandlerConfig } from "./handler.js";
import {
  atomicWriteTrustedFile,
  ensureTrustedChildDirectory,
  ensureTrustedWorkspaceRoot,
} from "./trusted-workspace-paths.js";
import { acquireWorkspaceFileLock } from "./workspace-file-lock.js";
import {
  AGENT_RUNTIME_STATE_DIRNAME,
  CONTEXT_SOURCE_LOCK_FILENAME,
  CONTEXT_SOURCE_LOCK_REL,
  CONTEXT_TREE_DIRNAME,
  inspectRemoteLatch,
  LOCAL_CONTEXT_DIRNAME,
  type RemoteLatchInspection,
  type RemoteLatchState,
  SOURCE_STATE_FILENAME,
  SOURCE_STATE_SCHEMA_VERSION,
  workspaceHasRemoteLatch,
} from "./workspace-manifest.js";

const SOURCE_PUBLICATION_LOCK_TIMEOUT_MS = 10_000;

export const SOURCE_STATE_REL = join(AGENT_RUNTIME_STATE_DIRNAME, SOURCE_STATE_FILENAME);
export type { RemoteLatchInspection, RemoteLatchState };
export { CONTEXT_SOURCE_LOCK_REL, inspectRemoteLatch, workspaceHasRemoteLatch };

export type ContextSourceKind = "remote" | "local" | "none" | "external";

export type ContextSourceNoneReason = "unknown" | "invalid" | "frozen" | "unbound";

export type ContextSource =
  | { kind: "remote"; path: string; repoUrl: string; branch: string }
  | { kind: "local"; path: string }
  | { kind: "none"; reason: ContextSourceNoneReason }
  /**
   * External Context Tree mode: this machine delegates Context Tree reads and
   * writes to the `@first-tree-ai/context-tree` CLI and its `context-tree-*`
   * Skills, keyed by a GitHub OWNER/REPO. First Tree projects no Context Tree
   * path of its own — the external CLI owns the checkout under
   * `~/.context-tree/trees/` and resolves it per project.
   */
  | { kind: "external"; repository: string };

export type ContextTreeCoordinates = {
  kind?: ContextSourceKind;
  path: string | null;
  repoUrl: string | null;
  branch: string | null;
  /**
   * GitHub OWNER/REPO in external mode, null otherwise.
   *
   * It travels with the coordinates rather than being re-read from config at
   * render time because the briefing is compared byte-for-byte during admission:
   * both the expected and the published briefing must derive it identically.
   */
  repository?: string | null;
};

export function contextSourceKey(source: ContextSource): string {
  if (source.kind === "remote") return `remote\0${source.path}\0${source.repoUrl}\0${source.branch}`;
  if (source.kind === "local") return `local\0${source.path}`;
  if (source.kind === "external") return `external\0${source.repository}`;
  return "none";
}

/**
 * Immutable Context-source capture taken at a provider-admission boundary.
 * The handler factory that wins the boundary builds from this exact snapshot;
 * a later source change can never mutate an already-captured admission.
 */
export type ContextSourceAdmissionSnapshot = Readonly<{
  source: ContextSource;
  sourceKey: string;
}>;

export function captureContextSourceAdmission(source: ContextSource): ContextSourceAdmissionSnapshot {
  const captured: ContextSource =
    source.kind === "remote"
      ? Object.freeze({
          kind: "remote",
          path: source.path,
          repoUrl: source.repoUrl,
          branch: source.branch,
        })
      : source.kind === "local"
        ? Object.freeze({ kind: "local", path: source.path })
        : source.kind === "external"
          ? Object.freeze({ kind: "external", repository: source.repository })
          : Object.freeze({ kind: "none", reason: source.reason });
  return Object.freeze({ source: captured, sourceKey: contextSourceKey(captured) });
}

export type RemoteGitAttribution = {
  contextTreePath: string | null;
  contextTreeRepoUrl: string | null;
};

const sourcePublicationHeld = new AsyncLocalStorage<Set<string>>();
const sourcePublicationTails = new Map<string, Promise<void>>();

let sourcePublicationTestHook: ((workspace: string) => Promise<void>) | undefined;

/**
 * Test-only seam. Invoked after the synchronous projection-entry fence and
 * before the source-publication lock is acquired, so a Remote publisher can
 * finish while a stale Local session is still between resolve and publish.
 */
export function setSourcePublicationTestHook(hook: ((workspace: string) => Promise<void>) | null): void {
  sourcePublicationTestHook = hook ?? undefined;
}

export function runSourcePublicationTestHook(workspace: string): void | Promise<void> {
  return sourcePublicationTestHook?.(workspace);
}

function sourcePublicationKey(workspaceRoot: string): string {
  try {
    return realpathSync(resolve(workspaceRoot));
  } catch {
    return resolve(workspaceRoot);
  }
}

/**
 * Workspace-scoped exclusive lock for context-source publication.
 *
 * Protects runtime metadata only: latch, Managed Skill projection, manifest,
 * identity, briefing, and sentinel. It is not a Local Context content lock.
 * Same-process re-entry is allowed so observation and full publication can
 * share one held lock. Callers that also take `managed-skills.lock` must
 * acquire this lock first.
 */
export async function withSourcePublicationLock<T>(workspaceRoot: string, fn: () => Promise<T>): Promise<T> {
  const trustedWorkspaceRoot = ensureTrustedWorkspaceRoot(workspaceRoot);
  const key = sourcePublicationKey(trustedWorkspaceRoot);
  const held = sourcePublicationHeld.getStore();
  if (held?.has(key)) return fn();

  const previous = sourcePublicationTails.get(key) ?? Promise.resolve();
  let releaseTail = (): void => {};
  const current = new Promise<void>((resolveTail) => {
    releaseTail = resolveTail;
  });
  const tail = previous.then(() => current);
  sourcePublicationTails.set(key, tail);
  await previous;
  try {
    const runtimeDir = ensureTrustedChildDirectory(
      trustedWorkspaceRoot,
      AGENT_RUNTIME_STATE_DIRNAME,
      "Context source runtime directory",
    );
    const lockPath = join(runtimeDir, CONTEXT_SOURCE_LOCK_FILENAME);
    const lock = await acquireWorkspaceFileLock(lockPath, { timeoutMs: SOURCE_PUBLICATION_LOCK_TIMEOUT_MS });
    const nextHeld = new Set(held);
    nextHeld.add(key);
    try {
      return await sourcePublicationHeld.run(nextHeld, fn);
    } finally {
      await lock.release();
    }
  } finally {
    releaseTail();
    if (sourcePublicationTails.get(key) === tail) {
      sourcePublicationTails.delete(key);
    }
  }
}

/**
 * Parse an Agent-scoped Context Tree info payload. Missing `bindingState`,
 * schema failure, and state/repo/branch/provider conflicts all fail closed as
 * `unknown`.
 */
export function classifyAgentContextTreeInfo(config: unknown): {
  status: "bound" | "unbound" | "invalid" | "unknown";
  repoUrl: string | null;
  branch: string | null;
} {
  const parsed = agentContextTreeInfoSchema.safeParse(config);
  if (!parsed.success) {
    return { status: "unknown", repoUrl: null, branch: null };
  }

  if (parsed.data.bindingState === "invalid") {
    return { status: "invalid", repoUrl: null, branch: null };
  }

  if (parsed.data.bindingState === "unbound") {
    return { status: "unbound", repoUrl: null, branch: parsed.data.branch };
  }

  const binding = contextTreeActiveBindingSchema.safeParse({
    repo: parsed.data.repo,
    branch: parsed.data.branch,
    ...(parsed.data.provider ? { provider: parsed.data.provider } : {}),
  });
  if (!binding.success) {
    return { status: "unknown", repoUrl: null, branch: null };
  }
  return { status: "bound", repoUrl: binding.data.repo, branch: binding.data.branch };
}

export function hasRemoteLatch(workspaceRoot: string): boolean {
  return workspaceHasRemoteLatch(workspaceRoot);
}

function persistRemoteLatch(workspaceRoot: string, coords: { repoUrl: string; branch: string }): void {
  const repoUrl = contextTreeRepoSchema.parse(coords.repoUrl);
  const branch = contextTreeBranchSchema.parse(coords.branch);
  const inspection = inspectRemoteLatch(workspaceRoot);
  if (inspection.status === "observed") return;
  if (inspection.status === "unreadable") {
    throw new Error(`refusing to overwrite unreadable Context source state (${inspection.reason})`);
  }
  const trustedWorkspaceRoot = ensureTrustedWorkspaceRoot(workspaceRoot);
  const runtimeDir = ensureTrustedChildDirectory(
    trustedWorkspaceRoot,
    AGENT_RUNTIME_STATE_DIRNAME,
    "Context source runtime directory",
  );
  const payload: RemoteLatchState = {
    schemaVersion: SOURCE_STATE_SCHEMA_VERSION,
    remoteObserved: true,
    observedAt: new Date().toISOString(),
    repoUrl,
    branch,
  };
  atomicWriteTrustedFile(join(runtimeDir, SOURCE_STATE_FILENAME), `${JSON.stringify(payload, null, 2)}\n`);
}

/**
 * Record a remote-observed latch under the workspace source-publication lock.
 *
 * CLI Local resolve and runtime source resolution must both go through this
 * helper so a stale Local session cannot publish after the latch is on disk.
 * The sync latch writer is module-private; this is the only public writer.
 */
export async function recordRemoteBindingObservation(
  workspaceRoot: string,
  coords: { repoUrl: string; branch: string },
): Promise<void> {
  await withSourcePublicationLock(workspaceRoot, async () => {
    persistRemoteLatch(workspaceRoot, coords);
  });
}

function sourceFromLatchOrReason(
  workspaceRoot: string,
  reason: ContextSourceNoneReason,
  log: (msg: string) => void,
  frozenMessage: string,
): ContextSource {
  if (inspectRemoteLatch(workspaceRoot).status !== "absent") {
    log(frozenMessage);
    return { kind: "none", reason: "frozen" };
  }
  return { kind: "none", reason };
}

export async function resolveAgentContextSource(
  sdk: FirstTreeHubSDK,
  workspaceRoot: string,
  log: (msg: string) => void,
): Promise<ContextSource> {
  // AgentSlot resolves before provider preparation acquires the home. Create
  // only the immediate workspace directory here, under a trusted real parent;
  // a symlink/non-directory root remains a hard fail-closed error.
  ensureTrustedWorkspaceRoot(workspaceRoot);

  // External mode wins outright, before the server binding is even fetched:
  // the operator has delegated this machine's Context Tree to the external CLI,
  // so a Team binding must not also project First Tree's own Tree Skills. The
  // remote latch is deliberately not consulted — it exists to stop a stale Local
  // session publishing the private Local Skill variants after a remote binding
  // was seen, and external mode publishes neither.
  const externalRepository = readContextTreeRepository();
  if (externalRepository) {
    log(`Context source external: delegating to the context-tree CLI for ${externalRepository}`);
    return { kind: "external", repository: externalRepository };
  }

  const frozenMessage = "Context source frozen: remote binding was previously observed or source-state is unreadable";
  let classified: ReturnType<typeof classifyAgentContextTreeInfo>;
  try {
    classified = classifyAgentContextTreeInfo(await sdk.getAgentContextTreeConfig());
  } catch {
    log("Context source unresolved: failed to fetch agent Context Tree config");
    return sourceFromLatchOrReason(workspaceRoot, "unknown", log, frozenMessage);
  }

  if (classified.status === "unknown") {
    log("Context source unresolved: missing, conflicting, or unreadable bindingState");
    return sourceFromLatchOrReason(workspaceRoot, "unknown", log, frozenMessage);
  }
  if (classified.status === "invalid") {
    log("Context source unresolved: server reported an invalid Context Tree binding");
    return sourceFromLatchOrReason(workspaceRoot, "invalid", log, frozenMessage);
  }
  if (classified.status === "bound" && classified.repoUrl) {
    if (!classified.branch) {
      log("Context source unresolved: bound response omitted an explicit branch");
      return sourceFromLatchOrReason(workspaceRoot, "unknown", log, frozenMessage);
    }
    await recordRemoteBindingObservation(workspaceRoot, {
      repoUrl: classified.repoUrl,
      branch: classified.branch,
    });
    return {
      kind: "remote",
      path: join(workspaceRoot, CONTEXT_TREE_DIRNAME),
      repoUrl: classified.repoUrl,
      branch: classified.branch,
    };
  }
  if (inspectRemoteLatch(workspaceRoot).status !== "absent") {
    log(frozenMessage);
    return { kind: "none", reason: "frozen" };
  }
  if (classified.status === "unbound") {
    return { kind: "local", path: join(workspaceRoot, LOCAL_CONTEXT_DIRNAME) };
  }
  return { kind: "none", reason: "unknown" };
}

export function applyContextSourceToHandlerConfig(config: HandlerConfig, source: ContextSource): HandlerConfig {
  config.contextSourceKind = source.kind;
  config.contextTreeRepository = source.kind === "external" ? source.repository : null;
  if (source.kind === "remote") {
    config.contextTreePath = source.path;
    config.contextTreeRepoUrl = source.repoUrl;
    config.contextTreeBranch = source.branch;
    return config;
  }
  if (source.kind === "local") {
    config.contextTreePath = source.path;
    config.contextTreeRepoUrl = null;
    config.contextTreeBranch = null;
    return config;
  }
  // External mode projects no First Tree Tree path: the external CLI owns its
  // own checkout under `~/.context-tree/trees/` and resolves it per project.
  config.contextTreePath = null;
  config.contextTreeRepoUrl = null;
  config.contextTreeBranch = null;
  return config;
}

export function contextSourceFromHandlerConfig(config: HandlerConfig): ContextSource {
  const kind = config.contextSourceKind;
  const path =
    typeof config.contextTreePath === "string" && config.contextTreePath.length > 0 ? config.contextTreePath : null;
  const repoUrl =
    typeof config.contextTreeRepoUrl === "string" && config.contextTreeRepoUrl.length > 0
      ? config.contextTreeRepoUrl
      : null;
  const branch =
    typeof config.contextTreeBranch === "string" && config.contextTreeBranch.length > 0
      ? config.contextTreeBranch
      : null;

  if (kind === "external") {
    const repository =
      typeof config.contextTreeRepository === "string" && config.contextTreeRepository.length > 0
        ? config.contextTreeRepository
        : null;
    if (!repository) return { kind: "none", reason: "unknown" };
    return { kind: "external", repository };
  }
  if (kind === "local") {
    if (!path) return { kind: "none", reason: "unknown" };
    return { kind: "local", path };
  }
  if (kind === "none") {
    return { kind: "none", reason: "unknown" };
  }
  if (kind === "remote") {
    if (!path || !repoUrl || !branch) return { kind: "none", reason: "unknown" };
    return { kind: "remote", path, repoUrl, branch };
  }
  if (path && repoUrl && branch) {
    return { kind: "remote", path, repoUrl, branch };
  }
  return { kind: "none", reason: "unknown" };
}

export function preparationCoordinatesFromSource(source: ContextSource): ContextTreeCoordinates {
  if (source.kind === "remote") {
    return { kind: "remote", path: source.path, repoUrl: source.repoUrl, branch: source.branch };
  }
  if (source.kind === "local") {
    return { kind: "local", path: source.path, repoUrl: null, branch: null };
  }
  if (source.kind === "external") {
    return { kind: "external", path: null, repoUrl: null, branch: null, repository: source.repository };
  }
  return { kind: "none", path: null, repoUrl: null, branch: null };
}

export function remoteGitAttributionFromSource(source: ContextSource): RemoteGitAttribution {
  if (source.kind !== "remote" || !source.repoUrl) {
    return { contextTreePath: null, contextTreeRepoUrl: null };
  }
  return { contextTreePath: source.path, contextTreeRepoUrl: source.repoUrl };
}

export function requireSlotAgentName(config: HandlerConfig): string {
  if (typeof config.agentName !== "string" || config.agentName.length === 0) {
    throw new Error(
      "handler config is missing AgentSlot config.name; refusing to infer agentName from displayName or workspace path",
    );
  }
  return config.agentName;
}
