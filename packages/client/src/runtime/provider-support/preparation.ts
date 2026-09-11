/**
 * Runtime-owned managed-session preparation for provider adapters.
 *
 * Owns the pre-provider admission sequence every normal start/resume shares.
 * Providers keep protocol / MCP / prompt translation and process admission;
 * this module does not spawn providers, create ACK authority, or load
 * provider config caches (callers pass already-resolved payload state).
 */

import { lstatSync, readdirSync, readFileSync, readlinkSync } from "node:fs";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import {
  type AgentRuntimeConfig,
  type AgentRuntimeConfigPayload,
  normalizeTeamSkillTargetSlug,
  type RuntimeProvider,
  WORKSPACE_MANIFEST_FILENAME,
  WORKSPACE_STATE_DIRNAME,
} from "@first-tree/shared";
import { ensureAgentBootstrap } from "../agent-bootstrap.js";
import { buildAgentBriefing } from "../agent-briefing.js";
import { bootstrapWorkspace, type PredeclaredSourceRepo, writeAgentBriefing } from "../bootstrap.js";
import { type ChatContext, fetchChatContext } from "../chat-context.js";
import {
  type ContextSourceKind,
  inspectRemoteLatch,
  recordRemoteBindingObservation,
  resolveAgentContextSource,
  runSourcePublicationTestHook,
  withSourcePublicationLock,
} from "../context-source.js";
import type { SessionContext } from "../handler.js";
import {
  allowedTargetRootsFromProjection,
  ManagedSkillsUnsafeDiscoveryError,
  type ProviderSkillRootProjection,
  providerSkillRoot,
  type ReconciledTeamSkill,
  reconcileManagedSkillsForConfig,
  type VerifiedManagedSkillsProjection,
  verifyManagedSkillsProjectionForAdmission,
} from "../managed-skills.js";
import { MANAGED_STATE_REL, readManagedStateResult } from "../managed-state.js";
import { currentSourceRepoNamesFromPayload, declaredSourceRepos } from "../source-repos.js";
import { teamSkillBundleResolverFromSdk } from "../team-skill-bundle-resolver.js";
import { ensureTrustedChildDirectory, ensureTrustedWorkspaceRoot } from "../trusted-workspace-paths.js";
import { acquireAgentHome, markWorkspaceInitComplete } from "../workspace.js";
import {
  AGENT_RUNTIME_STATE_DIRNAME,
  CONTEXT_TREE_DIRNAME,
  ensureWorkspaceManifest,
  LOCAL_CONTEXT_DIRNAME,
  type WorkspaceTreeName,
} from "../workspace-manifest.js";

/**
 * Context Tree coordinates carried into the briefing and the stable workspace
 * identity. Grouped because callers always supply the three values together.
 */
export type ContextTreeCoordinates = {
  kind?: ContextSourceKind;
  path: string | null;
  repoUrl: string | null;
  branch: string | null;
};

function contextSourceKindFromCoordinates(tree: ContextTreeCoordinates): ContextSourceKind {
  if (tree.kind === "local" || tree.kind === "remote" || tree.kind === "none") return tree.kind;
  if (tree.path && tree.repoUrl) return "remote";
  return "none";
}

function workspaceTreeName(kind: ContextSourceKind): WorkspaceTreeName | null {
  if (kind === "remote") return CONTEXT_TREE_DIRNAME;
  if (kind === "local") return LOCAL_CONTEXT_DIRNAME;
  return null;
}

function requirePublicationAgentName(agentName: string): string {
  if (typeof agentName !== "string" || agentName.length === 0) {
    throw new Error(
      "managed workspace publication requires AgentSlot config.name; refusing to infer from displayName or workspace path",
    );
  }
  return agentName;
}

export type PrepareManagedSessionParams = {
  sessionCtx: SessionContext;
  /** Absolute agent-home root passed to {@link acquireAgentHome}. */
  workspaceRoot: string;
  runtimeProvider: RuntimeProvider;
  /** Composition-owned provider → native skill-root projection (fail-closed). */
  providerSkillRoots: ProviderSkillRootProjection;
  /**
   * Live agent runtime config, or `null` when the caller had no config cache.
   * Supplies the Team Skill snapshot to the reconciler.
   */
  runtimeConfig: AgentRuntimeConfig | null;
  /** Effective payload — the caller's provider-specific default when unresolved. */
  payload: AgentRuntimeConfigPayload;
  /** Exact payload that produced an already-admitted active projection. */
  existingPayload?: AgentRuntimeConfigPayload;
  /**
   * `false` when {@link payload} is a provider default rather than a resolved
   * config. Gates the authoritative workspace-manifest write so a fallback
   * empty repo set is never published as truth.
   */
  payloadResolved: boolean;
  contextTree: ContextTreeCoordinates;
  /** Stable AgentSlot `config.name`. Never inferred from displayName or path. */
  agentName: string;
  /**
   * Optional provider-owned **synchronous** checkpoint at Managed Skills
   * projection entry (first statement inside {@link projectManagedWorkspace},
   * before any await).
   *
   * Contract (enforced):
   * - Return type is `undefined` (not `void`) so `async` callbacks are a
   *   TypeScript error — `async () => …` is assignable to `() => void` but
   *   not to `() => undefined`.
   * - Runtime fail-closed: a returned thenable throws before reconcile.
   *
   * An `await` boundary here would reopen a microtask window where `suspend()`
   * can advance lifecycle generation before reconcile begins.
   */
  atProjectionEntry?: (args: { workspace: string; chatContext: ChatContext | undefined }) => undefined;
  /** Test seam: override the packaged Skill bundle root. */
  bundledSkillsRoot?: string;
  /**
   * Optional provider-owned work after Managed Skills settle and before the
   * shared briefing / bootstrap / init-complete sentinel. Callers use this for
   * lifecycle fences (e.g. Pi generation checkpoints) and landing-campaign
   * sandbox env setup (Codex app-server) so cancellation/failure still leaves
   * no sentinel and no provider admission.
   */
  beforeBriefing?: (args: {
    workspace: string;
    chatContext: ChatContext | undefined;
    sourceRepos: readonly PredeclaredSourceRepo[];
    teamSkills: readonly ReconciledTeamSkill[];
  }) => void | Promise<void>;
};

export type PreparedManagedSession = {
  workspace: string;
  /**
   * Raw chat context, or `undefined` when the fetch failed or returned
   * nothing. Deliberately unrendered: per-chat context belongs to the caller's
   * provider/session prompt path, never to the shared agent-level briefing.
   */
  chatContext: ChatContext | undefined;
  /** Shared agent-level briefing already written to `<workspace>/AGENTS.md`. */
  briefing: string;
  sourceRepos: readonly PredeclaredSourceRepo[];
  /** Successful current-provider rows from the reconcile that gated this start. */
  teamSkills: readonly ReconciledTeamSkill[];
  /** Team Resource fence version from the reconcile that gated this start. */
  resourceConfigVersion: number;
};

export type ProjectManagedWorkspaceParams = {
  sessionCtx: SessionContext;
  /** Already-acquired agent home (no re-acquire). */
  workspace: string;
  /**
   * Agent workspace that owns source authority (latch, source lock, and LKG).
   * Legacy transcript resumes may project Skills/briefing into a chat cwd,
   * but must still authorize that publication from the Agent workspace.
   */
  sourceAuthorityRoot?: string;
  /** Re-authorize source for an in-provider restart/config hot switch. */
  reresolveSource?: boolean;
  /**
   * Payload that produced the currently admitted on-disk projection.
   * Active handlers may refresh ordinary Agent config under their captured
   * Context source only after this exact projection is proven and while the
   * remote-observed latch is still absent.
   */
  existingPayload?: AgentRuntimeConfigPayload;
  runtimeProvider: RuntimeProvider;
  /** Composition-owned provider → native skill-root projection (fail-closed). */
  providerSkillRoots: ProviderSkillRootProjection;
  runtimeConfig: AgentRuntimeConfig | null;
  payload: AgentRuntimeConfigPayload;
  payloadResolved: boolean;
  contextTree: ContextTreeCoordinates;
  /** Stable AgentSlot `config.name`. Never inferred from displayName or path. */
  agentName: string;
  /**
   * Required: whether to write the init-complete sentinel after bootstrap.
   * Full admission passes true; mid-session refresh paths that historically
   * skipped the sentinel must pass false explicitly (no default footgun).
   */
  markInitComplete: boolean;
  /** Test seam: override the packaged Skill bundle root. */
  bundledSkillsRoot?: string;
  /**
   * Legacy chat-dir resume must project Skills and rewrite the briefing
   * without minting agent-home identity/manifest/sentinel into that cwd.
   */
  writeIdentityAndManifest?: boolean;
  /** Legacy chat targets omit Agent-home source-repository rows. */
  suppressSourceRepos?: boolean;
  /** Admit the pre-redesign legacy target shape during its first projection. */
  allowLegacyTargetUpgrade?: boolean;
  /**
   * Optional provider-owned **synchronous** checkpoint at projection entry —
   * invoked before any await (including Managed Skills reconcile).
   * Return `undefined` (not `void`); runtime rejects thenables. See
   * {@link PrepareManagedSessionParams.atProjectionEntry}.
   */
  atProjectionEntry?: (args: { workspace: string }) => undefined;
  /**
   * Optional provider-owned checkpoint after Managed Skills settle and before
   * briefing / bootstrap / sentinel. Used for lifecycle fences and landing
   * sandbox env setup so cancellation/failure leaves no sentinel.
   */
  beforeBriefing?: (args: {
    workspace: string;
    sourceRepos: readonly PredeclaredSourceRepo[];
    teamSkills: readonly ReconciledTeamSkill[];
  }) => void | Promise<void>;
};

type ExistingProjectionState =
  | Readonly<{ kind: "fresh" }>
  | Readonly<{ kind: "consistent-none"; managed: VerifiedManagedSkillsProjection }>
  | Readonly<{ kind: "unsafe" }>;

// Keep the read-only admission preflight independent from bootstrap/workspace
// module exports. Provider tests intentionally mock those mutation modules;
// source-authority inspection must still examine the canonical on-disk paths.
const IDENTITY_JSON_REL = join(AGENT_RUNTIME_STATE_DIRNAME, "identity.json");
const INIT_COMPLETE_SENTINEL_REL = join(AGENT_RUNTIME_STATE_DIRNAME, "init-complete");

function lstatOrNull(path: string): ReturnType<typeof lstatSync> | null {
  try {
    return lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

function readRegularJson(path: string): Record<string, unknown> | null {
  const stat = lstatOrNull(path);
  if (!stat || stat.isSymbolicLink() || !stat.isFile()) return null;
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function assertRuntimeConfigCanPublish(
  targetWorkspace: string,
  sourceAuthorityRoot: string,
  runtimeConfig: AgentRuntimeConfig | null,
  hasCapturedPayload: boolean,
): void {
  let highestPublishedVersion: number | null = null;
  for (const root of new Set([targetWorkspace, sourceAuthorityRoot])) {
    const statePath = join(root, MANAGED_STATE_REL);
    const stateStat = lstatOrNull(statePath);
    if (!stateStat) continue;
    if (stateStat.isSymbolicLink() || !stateStat.isFile()) {
      throw new ManagedSkillsUnsafeDiscoveryError(
        "Managed Skills state is not a trusted regular file; preserving the existing projection",
      );
    }
    const state = readManagedStateResult(root);
    // Schema v1 state predates the Team Resource fence, so it publishes at
    // version 0; reconcile migrates it in place once the session is admitted.
    // Only future/invalid state is unsafe to mutate.
    const publishedVersion =
      state.kind === "current" ? state.state.resourceConfigVersion : state.kind === "legacy" ? 0 : null;
    if (publishedVersion === null) {
      throw new ManagedSkillsUnsafeDiscoveryError(
        "Managed Skills state is unreadable or from an unsupported version; preserving the existing projection",
      );
    }
    highestPublishedVersion = Math.max(highestPublishedVersion ?? 0, publishedVersion);
  }
  if (highestPublishedVersion === null) return;
  if (runtimeConfig === null && !hasCapturedPayload) {
    throw new ManagedSkillsUnsafeDiscoveryError(
      "Agent runtime config is unavailable while a managed projection already exists; preserving last-known-safe bytes",
    );
  }
  if (runtimeConfig && runtimeConfig.version < highestPublishedVersion) {
    throw new ManagedSkillsUnsafeDiscoveryError(
      `Agent runtime config v${runtimeConfig.version} is older than managed projection v${highestPublishedVersion}`,
    );
  }
}

async function verifyCompleteCapturedProjection(
  authorityRoot: string,
  targetWorkspace: string,
  runtimeProvider: RuntimeProvider,
  providerSkillRoots: ProviderSkillRootProjection,
  expected: {
    sessionCtx: SessionContext;
    agentName: string;
    payload: AgentRuntimeConfigPayload;
    suppressSourceRepos: boolean;
    contextTree: ContextTreeCoordinates;
  },
): Promise<VerifiedManagedSkillsProjection | null> {
  const kind = contextSourceKindFromCoordinates(expected.contextTree);
  const expectedIdentity = JSON.parse(
    JSON.stringify({
      agentId: expected.sessionCtx.agent.agentId,
      agentName: expected.agentName,
      displayName: expected.sessionCtx.agent.displayName,
      type: expected.sessionCtx.agent.type,
      visibility: expected.sessionCtx.agent.visibility,
      delegateMention: expected.sessionCtx.agent.delegateMention,
      metadata: expected.sessionCtx.agent.metadata,
      serverUrl: expected.sessionCtx.sdk.serverUrl,
      contextTreePath: expected.contextTree.path,
      contextSourceKind: kind,
    }),
  ) as Record<string, unknown>;
  if (!isDeepStrictEqual(readRegularJson(join(authorityRoot, IDENTITY_JSON_REL)), expectedIdentity)) return null;

  const manifestPath = join(authorityRoot, WORKSPACE_STATE_DIRNAME, WORKSPACE_MANIFEST_FILENAME);
  const manifestStat = lstatOrNull(manifestPath);
  const expectedTree = workspaceTreeName(kind);
  if (expectedTree === null) {
    if (manifestStat !== null) return null;
  } else {
    if (!manifestStat?.isFile() || manifestStat.isSymbolicLink()) return null;
    if (readRegularJson(manifestPath)?.tree !== expectedTree) return null;
  }

  const sentinel = readRegularJson(join(authorityRoot, INIT_COMPLETE_SENTINEL_REL));
  if (sentinel?.schemaVersion !== 1 || typeof sentinel.completedAt !== "string" || sentinel.completedAt.length === 0) {
    return null;
  }
  const managed = await verifyManagedSkillsProjectionForAdmission({
    workspace: targetWorkspace,
    provider: runtimeProvider,
    providerSkillRoots,
  });
  if (!managed) return null;

  const sourceRepos = expected.suppressSourceRepos ? [] : declaredSourceRepos(targetWorkspace, expected.payload);
  const expectedBriefing = buildAgentBriefing({
    identity: expected.sessionCtx.agent,
    payload: expected.payload,
    workspacePath: targetWorkspace,
    sourceRepos,
    contextTreePath: expected.contextTree.path,
    contextTreeRepoUrl: expected.contextTree.repoUrl,
    contextTreeBranch: expected.contextTree.branch,
    contextSourceKind: kind,
    teamSkills: managed.teamSkills,
  });
  const agentsPath = join(targetWorkspace, "AGENTS.md");
  const agentsStat = lstatOrNull(agentsPath);
  if (!agentsStat?.isFile() || agentsStat.isSymbolicLink() || readFileSync(agentsPath, "utf8") !== expectedBriefing) {
    return null;
  }
  const claudePath = join(targetWorkspace, "CLAUDE.md");
  const claudeStat = lstatOrNull(claudePath);
  const claudeComplete =
    process.platform === "win32"
      ? claudeStat?.isFile() === true &&
        !claudeStat.isSymbolicLink() &&
        readFileSync(claudePath, "utf8") === expectedBriefing
      : claudeStat?.isSymbolicLink() === true && readlinkSync(claudePath) === "AGENTS.md";
  return claudeComplete ? managed : null;
}

async function existingProjectionState(
  authorityRoot: string,
  targetWorkspace: string,
  runtimeProvider: RuntimeProvider,
  providerSkillRoots: ProviderSkillRootProjection,
  expected: {
    sessionCtx: SessionContext;
    agentName: string;
    payload: AgentRuntimeConfigPayload;
    suppressSourceRepos: boolean;
    allowLegacyTargetUpgrade: boolean;
  },
): Promise<ExistingProjectionState> {
  const authorityStat = lstatOrNull(authorityRoot);
  const targetStat = lstatOrNull(targetWorkspace);
  if (
    !authorityStat?.isDirectory() ||
    authorityStat.isSymbolicLink() ||
    !targetStat?.isDirectory() ||
    targetStat.isSymbolicLink()
  ) {
    return { kind: "unsafe" };
  }
  const identityPath = join(authorityRoot, IDENTITY_JSON_REL);
  const manifestPath = join(authorityRoot, WORKSPACE_STATE_DIRNAME, WORKSPACE_MANIFEST_FILENAME);
  const identityStat = lstatOrNull(identityPath);
  const manifestStat = lstatOrNull(manifestPath);
  const identity = readRegularJson(identityPath);

  if (identityStat && !identity) return { kind: "unsafe" };
  if (manifestStat && (!manifestStat.isFile() || manifestStat.isSymbolicLink())) return { kind: "unsafe" };

  const manifest = manifestStat ? readRegularJson(manifestPath) : null;
  if (manifestStat && !manifest) return { kind: "unsafe" };

  const agentsPath = join(targetWorkspace, "AGENTS.md");
  const claudePath = join(targetWorkspace, "CLAUDE.md");
  const sentinelPath = join(authorityRoot, INIT_COMPLETE_SENTINEL_REL);
  const skillBase = join(targetWorkspace, providerSkillRoot(runtimeProvider, providerSkillRoots));
  const readSkill = join(skillBase, "first-tree-read");
  const writeSkill = join(skillBase, "first-tree-write");

  const managed = await verifyCompleteCapturedProjection(
    authorityRoot,
    targetWorkspace,
    runtimeProvider,
    providerSkillRoots,
    {
      sessionCtx: expected.sessionCtx,
      agentName: expected.agentName,
      payload: expected.payload,
      suppressSourceRepos: expected.suppressSourceRepos,
      contextTree: { kind: "none", path: null, repoUrl: null, branch: null },
    },
  );
  if (managed) return { kind: "consistent-none", managed };

  if (identityStat === null && manifestStat === null) {
    const visibleArtifacts = [agentsPath, sentinelPath, readSkill, writeSkill];
    if (!expected.allowLegacyTargetUpgrade) visibleArtifacts.push(claudePath);
    const rootsEmpty = [...allowedTargetRootsFromProjection(providerSkillRoots)].every(
      (root) => lstatOrNull(join(targetWorkspace, ...root.split("/"))) === null,
    );
    const authorityRuntime = join(authorityRoot, AGENT_RUNTIME_STATE_DIRNAME);
    const authorityRuntimeEntries = lstatOrNull(authorityRuntime)?.isDirectory()
      ? readdirSync(authorityRuntime).filter((name) => name !== "context-source.lock")
      : ["unsafe"];
    const targetRuntimeClean =
      targetWorkspace === authorityRoot || lstatOrNull(join(targetWorkspace, AGENT_RUNTIME_STATE_DIRNAME)) === null;
    const workspaceStateClean =
      lstatOrNull(join(authorityRoot, WORKSPACE_STATE_DIRNAME)) === null &&
      (targetWorkspace === authorityRoot || lstatOrNull(join(targetWorkspace, WORKSPACE_STATE_DIRNAME)) === null);
    if (
      visibleArtifacts.every((path) => lstatOrNull(path) === null) &&
      rootsEmpty &&
      authorityRuntimeEntries.length === 0 &&
      targetRuntimeClean &&
      workspaceStateClean
    ) {
      return { kind: "fresh" };
    }
  }
  return { kind: "unsafe" };
}

function assertPublishedRegularFile(path: string, label: string): void {
  const stat = lstatSync(path);
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new Error(`${label} must be a regular non-symlink file after publication: ${path}`);
  }
}

function assertPublishedClaudeBriefing(targetWorkspace: string, expectedBriefing: string): void {
  const claudePath = join(targetWorkspace, "CLAUDE.md");
  const stat = lstatSync(claudePath);
  if (process.platform === "win32") {
    if (stat.isSymbolicLink() || !stat.isFile() || readFileSync(claudePath, "utf8") !== expectedBriefing) {
      throw new Error("Claude briefing fallback final verification failed");
    }
    return;
  }
  if (!stat.isSymbolicLink() || readlinkSync(claudePath) !== "AGENTS.md") {
    throw new Error("Claude briefing link final verification failed");
  }
}

function assertCompletedProjection(params: {
  authorityRoot: string;
  targetWorkspace: string;
  agentName: string;
  kind: ContextSourceKind;
  contextTreePath: string | null;
  expectManifest: boolean;
  expectSentinel: boolean;
}): void {
  const identityPath = join(params.authorityRoot, IDENTITY_JSON_REL);
  assertPublishedRegularFile(identityPath, "Agent identity");
  const identity = readRegularJson(identityPath);
  if (
    identity?.agentName !== params.agentName ||
    identity.contextSourceKind !== params.kind ||
    identity.contextTreePath !== params.contextTreePath
  ) {
    throw new Error("Agent identity final verification failed");
  }
  assertPublishedRegularFile(join(params.targetWorkspace, "AGENTS.md"), "Agent briefing");
  if (params.expectManifest) {
    const manifestPath = join(params.authorityRoot, WORKSPACE_STATE_DIRNAME, WORKSPACE_MANIFEST_FILENAME);
    assertPublishedRegularFile(manifestPath, "Workspace manifest");
    const manifest = readRegularJson(manifestPath);
    if (manifest?.tree !== workspaceTreeName(params.kind)) {
      throw new Error("Workspace manifest final verification failed");
    }
  }
  if (params.expectSentinel) {
    assertPublishedRegularFile(join(params.authorityRoot, INIT_COMPLETE_SENTINEL_REL), "Init-complete sentinel");
  }
}

function sameContextCoordinates(left: ContextTreeCoordinates, right: ContextTreeCoordinates): boolean {
  return (
    contextSourceKindFromCoordinates(left) === contextSourceKindFromCoordinates(right) &&
    left.path === right.path &&
    left.repoUrl === right.repoUrl &&
    left.branch === right.branch
  );
}

function coordinatesFromResolvedSource(
  source: Awaited<ReturnType<typeof resolveAgentContextSource>>,
): ContextTreeCoordinates {
  return source.kind === "remote"
    ? { kind: "remote", path: source.path, repoUrl: source.repoUrl, branch: source.branch }
    : source.kind === "local"
      ? { kind: "local", path: source.path, repoUrl: null, branch: null }
      : { kind: "none", path: null, repoUrl: null, branch: null };
}

export type ProjectedManagedWorkspace = {
  briefing: string;
  sourceRepos: readonly PredeclaredSourceRepo[];
  teamSkills: readonly ReconciledTeamSkill[];
  /** Team Resource fence version from the reconcile that produced this projection. */
  resourceConfigVersion: number;
};

/**
 * A live provider captured different Context coordinates than the current
 * authority. This is a handler-generation transition, not recoverable
 * Managed-Skill drift; callers must let SessionManager replace the handler.
 */
class ContextSourceTransitionError extends Error {
  constructor() {
    super("Context source changed while this provider handler was active; replacement is required");
    this.name = "ContextSourceTransitionError";
  }
}

export function isContextSourceTransitionError(error: unknown): error is ContextSourceTransitionError {
  return error instanceof ContextSourceTransitionError;
}

export { ContextSourceTransitionError };

/**
 * Re-authorize a captured source immediately before a provider opens a new
 * native process/query/thread. Healthy live injections do not call this;
 * restart paths do so under the same source-publication lock as projection.
 */
export async function assertContextSourceCurrent(params: {
  sessionCtx: SessionContext;
  sourceAuthorityRoot: string;
  contextTree: ContextTreeCoordinates;
}): Promise<void> {
  await withSourcePublicationLock(params.sourceAuthorityRoot, async () => {
    const source = await resolveAgentContextSource(
      params.sessionCtx.sdk,
      params.sourceAuthorityRoot,
      params.sessionCtx.log,
    );
    if (!sameContextCoordinates(params.contextTree, coordinatesFromResolvedSource(source))) {
      throw new ContextSourceTransitionError();
    }
  });
}

/**
 * Best-effort chat-context fetch. A failure degrades to no context with a log
 * rather than blocking the session: chat context enriches a prompt, it is not
 * an admission requirement.
 */
export async function fetchChatContextOrLog(sessionCtx: SessionContext): Promise<ChatContext | undefined> {
  try {
    return await fetchChatContext(sessionCtx.sdk, sessionCtx.chatId, sessionCtx.agent);
  } catch (err) {
    sessionCtx.log(`fetchChatContext failed: ${err instanceof Error ? err.message : String(err)}`);
    return undefined;
  }
}

function isThenable(value: unknown): value is PromiseLike<unknown> {
  return (
    value !== null &&
    (typeof value === "object" || typeof value === "function") &&
    typeof (value as PromiseLike<unknown>).then === "function"
  );
}

/**
 * Invoke a projection-entry checkpoint without awaiting. TypeScript already
 * rejects `async` callbacks via the `() => undefined` return type; runtime
 * rejects any non-`undefined` return (including thenables) so a type-escape
 * cannot reopen the microtask race.
 */
function invokeSyncProjectionEntry(hook: (() => undefined) | undefined): void {
  if (!hook) return;
  const result: unknown = hook();
  if (result !== undefined) {
    throw new Error(
      `atProjectionEntry must be synchronous (must return undefined; got ${
        isThenable(result) ? "thenable" : typeof result
      })`,
    );
  }
}

/**
 * Reconcile Managed Skills, build the shared briefing, run agent bootstrap, and
 * optionally mark init-complete — without acquiring a home or fetching chat
 * context. Used by mid-session projection refresh paths that are not a full
 * start/resume admission.
 *
 * Source publication (latch, Skills, manifest, identity, briefing, sentinel)
 * runs under the workspace source-publication lock. Managed Skills still take
 * their inner journal lock afterwards (fixed order: source-publication →
 * managed-skills).
 */
export async function projectManagedWorkspace(
  params: ProjectManagedWorkspaceParams,
): Promise<ProjectedManagedWorkspace> {
  const {
    sessionCtx,
    workspace,
    sourceAuthorityRoot = workspace,
    runtimeProvider,
    providerSkillRoots,
    runtimeConfig,
    payload,
    payloadResolved,
    contextTree: requestedContextTree,
    markInitComplete,
    writeIdentityAndManifest = true,
    suppressSourceRepos = false,
    existingPayload,
    allowLegacyTargetUpgrade = false,
    atProjectionEntry,
    beforeBriefing,
    bundledSkillsRoot,
    reresolveSource = false,
  } = params;
  const agentName = requirePublicationAgentName(params.agentName);
  let contextTree = requestedContextTree;

  // Sync fence — must run before any await so a queued suspend after a prior
  // await boundary cannot enter reconcile on a stale generation.
  if (atProjectionEntry) {
    invokeSyncProjectionEntry(() => atProjectionEntry({ workspace }));
  }

  const publicationHook = runSourcePublicationTestHook(sourceAuthorityRoot);
  if (publicationHook) {
    await publicationHook;
  }

  return withSourcePublicationLock(sourceAuthorityRoot, async () => {
    if (reresolveSource) {
      const source = await resolveAgentContextSource(sessionCtx.sdk, sourceAuthorityRoot, sessionCtx.log);
      const resolvedTree = coordinatesFromResolvedSource(source);
      if (!sameContextCoordinates(requestedContextTree, resolvedTree)) {
        throw new ContextSourceTransitionError();
      }
      contextTree = resolvedTree;
    }
    const requestedKind = contextSourceKindFromCoordinates(contextTree);
    const latch = inspectRemoteLatch(sourceAuthorityRoot);

    assertRuntimeConfigCanPublish(workspace, sourceAuthorityRoot, runtimeConfig, existingPayload !== undefined);

    if (existingPayload) {
      const managedProjection = await verifyManagedSkillsProjectionForAdmission({
        workspace,
        provider: runtimeProvider,
        providerSkillRoots,
      });
      if (!managedProjection) {
        throw new ManagedSkillsUnsafeDiscoveryError(
          "The active managed projection cannot be verified and must remain unchanged",
        );
      }
      const captured = await verifyCompleteCapturedProjection(
        sourceAuthorityRoot,
        workspace,
        runtimeProvider,
        providerSkillRoots,
        {
          sessionCtx,
          agentName,
          payload: existingPayload,
          suppressSourceRepos,
          contextTree,
        },
      );
      if (!captured) throw new ContextSourceTransitionError();
      if (requestedKind === "local" && latch.status !== "absent") {
        throw new ContextSourceTransitionError();
      }
    }

    if (latch.status === "unreadable" && requestedKind !== "none") {
      throw new ManagedSkillsUnsafeDiscoveryError(
        "Context source-state is unreadable; refusing to mutate last-known-safe projection",
      );
    }

    if (requestedKind === "local" && latch.status !== "absent") {
      throw new ManagedSkillsUnsafeDiscoveryError(
        "Local Context publication cannot proceed after a remote binding has been observed or source-state is unreadable",
      );
    }

    if (requestedKind === "remote") {
      if (!contextTree.path || !contextTree.repoUrl || !contextTree.branch) {
        throw new ManagedSkillsUnsafeDiscoveryError(
          "Remote Context publication requires an explicit path, repository, and branch",
        );
      }
      await recordRemoteBindingObservation(sourceAuthorityRoot, {
        repoUrl: contextTree.repoUrl,
        branch: contextTree.branch,
      });
    } else if (requestedKind === "none") {
      const projectionState = await existingProjectionState(
        sourceAuthorityRoot,
        workspace,
        runtimeProvider,
        providerSkillRoots,
        {
          sessionCtx,
          agentName,
          payload: existingPayload ?? payload,
          suppressSourceRepos,
          allowLegacyTargetUpgrade,
        },
      );
      if (projectionState.kind === "unsafe") {
        throw new ManagedSkillsUnsafeDiscoveryError(
          "Context source is unresolved and an existing non-none or partial workspace projection must remain unchanged",
        );
      }
      if (projectionState.kind === "consistent-none") {
        if (existingPayload && latch.status === "absent") {
          // A healthy active handler may refresh its ordinary Agent config
          // under the same captured `none` source. The exact old projection
          // was proven above; any remote observation stops this mutation.
        } else {
          if (atProjectionEntry) {
            invokeSyncProjectionEntry(() => atProjectionEntry({ workspace }));
          }
          const sourceRepos = suppressSourceRepos ? [] : declaredSourceRepos(workspace, payload);
          const teamSkills = projectionState.managed.teamSkills;
          // Keep the slash-command registry current on this read-only path
          // too: the verified projection is complete, so every retained
          // Team Skill has a verified target by construction.
          sessionCtx.publishTeamSkillCommands(
            teamSkills.map((skill) => ({
              requestedSlug: skill.requestedSlug,
              resourceId: skill.key.slice("resource:".length),
              effectiveName: skill.name,
            })),
            projectionState.managed.resourceConfigVersion,
          );
          if (beforeBriefing) {
            const result = beforeBriefing({ workspace, sourceRepos, teamSkills });
            if (result) await result;
          }
          return {
            briefing: readFileSync(join(workspace, "AGENTS.md"), "utf8"),
            sourceRepos,
            teamSkills,
            resourceConfigVersion: projectionState.managed.resourceConfigVersion,
          };
        }
      }
      if (latch.status !== "absent") {
        throw new ManagedSkillsUnsafeDiscoveryError(
          "Remote source state exists without a complete safe none projection; refusing provider admission",
        );
      }
    }

    if (atProjectionEntry) {
      invokeSyncProjectionEntry(() => atProjectionEntry({ workspace }));
    }
    const trustedTarget = ensureTrustedWorkspaceRoot(workspace);
    const trustedAuthority = ensureTrustedWorkspaceRoot(sourceAuthorityRoot);
    const publishesAuthorityMetadata = writeIdentityAndManifest || trustedAuthority !== trustedTarget;
    if (writeIdentityAndManifest) {
      ensureTrustedChildDirectory(trustedTarget, AGENT_RUNTIME_STATE_DIRNAME, "Agent runtime publication directory");
    }
    if (publishesAuthorityMetadata && requestedKind !== "none") {
      ensureTrustedChildDirectory(trustedAuthority, WORKSPACE_STATE_DIRNAME, "Workspace manifest directory");
    }

    const skillKind: ContextSourceKind = requestedKind === "local" ? "local" : "remote";
    const sourceRepos = suppressSourceRepos ? [] : declaredSourceRepos(workspace, payload);

    const { teamSkills, teamSkillCommands, resourceConfigVersion, staleTeamSnapshot } =
      await reconcileManagedSkillsForConfig(
        workspace,
        runtimeProvider,
        providerSkillRoots,
        runtimeConfig,
        sessionCtx.log,
        teamSkillBundleResolverFromSdk(sessionCtx.sdk),
        skillKind,
        bundledSkillsRoot,
      );

    // Publish the complete command registry BEFORE any provider turn is
    // formatted from this context: a local collision may have installed a
    // Team Skill under a suffixed name, and a configured-but-uninstalled
    // base must fail closed. The publisher is a required SessionContext
    // capability — a missing one would let a configured-but-colliding
    // base command fall through to a same-named unmanaged Skill.
    //
    // `null` from reconcile means no authoritative publication (stale or
    // unavailable snapshot, or a clean top-level failure), so exact
    // command identities are unproven. The CURRENT runtime config outranks
    // the ledger when it is both known and current: every configured Team
    // base fails closed — a verified older ledger may predate newly added
    // Skills, and its coverage of the current desired set is unprovable
    // because the reconciler advances the state version before installing.
    // Zero Team rows stay unpublished rather than verified-empty: a
    // not-yet-cleaned stale projection could still exist on disk. A stale
    // snapshot (config older than the ledger) or an unresolved config both
    // fall through to the verified ledger as last-known-good command
    // identity; without a verifiable ledger the registry publishes UNKNOWN
    // and strict slash commands stay blocked.
    if (teamSkillCommands !== null) {
      sessionCtx.publishTeamSkillCommands(teamSkillCommands, resourceConfigVersion);
    } else if (runtimeConfig && !staleTeamSnapshot) {
      const fallback: { requestedSlug: string; resourceId: string; effectiveName: string | null }[] = [];
      for (const skill of runtimeConfig.payload.resourceSkills ?? []) {
        try {
          fallback.push({
            requestedSlug: normalizeTeamSkillTargetSlug(skill.name),
            resourceId: skill.resourceId,
            effectiveName: null,
          });
        } catch {
          // A name with no portable slug never had a typable command.
        }
      }
      if (fallback.length > 0) {
        sessionCtx.log(
          "Team Skill reconcile produced no authoritative registry; marking configured Team commands unavailable until a verified projection lands",
        );
        sessionCtx.publishTeamSkillCommands(fallback, runtimeConfig.version);
      } else {
        sessionCtx.publishTeamSkillCommands(null, null);
      }
    } else {
      const verified = await verifyManagedSkillsProjectionForAdmission({
        workspace,
        provider: runtimeProvider,
        providerSkillRoots,
      });
      sessionCtx.publishTeamSkillCommands(
        verified
          ? verified.teamSkills.map((skill) => ({
              requestedSlug: skill.requestedSlug,
              resourceId: skill.key.slice("resource:".length),
              effectiveName: skill.name,
            }))
          : null,
        verified ? verified.resourceConfigVersion : null,
      );
    }

    if (beforeBriefing) {
      const result = beforeBriefing({ workspace, sourceRepos, teamSkills });
      if (result) {
        await result;
      }
    }

    const briefing = buildAgentBriefing({
      identity: sessionCtx.agent,
      payload,
      workspacePath: workspace,
      sourceRepos,
      contextTreePath: contextTree.path,
      contextTreeRepoUrl: contextTree.repoUrl,
      contextTreeBranch: contextTree.branch,
      contextSourceKind: requestedKind,
      teamSkills,
    });
    const publicationSourceNames = currentSourceRepoNamesFromPayload(payload, payloadResolved);

    if (writeIdentityAndManifest) {
      ensureAgentBootstrap({
        workspace,
        sessionCtx,
        agentName,
        contextTreePath: contextTree.path,
        contextSourceKind: requestedKind,
        briefing,
        currentSourceRepoNames: publicationSourceNames,
      });
      if (markInitComplete) {
        markWorkspaceInitComplete(workspace);
      }
    } else if (trustedAuthority !== trustedTarget) {
      const treeName = workspaceTreeName(requestedKind);
      if (treeName !== null && publicationSourceNames !== null) {
        ensureWorkspaceManifest(trustedAuthority, [...publicationSourceNames], sessionCtx.log, treeName, true);
      }
      bootstrapWorkspace({
        workspacePath: trustedAuthority,
        identity: sessionCtx.agent,
        agentName,
        contextTreePath: contextTree.path,
        contextSourceKind: requestedKind,
        serverUrl: sessionCtx.sdk.serverUrl,
      });
      writeAgentBriefing(trustedTarget, briefing);
      markWorkspaceInitComplete(trustedAuthority);
    } else {
      writeAgentBriefing(trustedTarget, briefing);
    }

    if (writeIdentityAndManifest || trustedAuthority !== trustedTarget) {
      assertCompletedProjection({
        authorityRoot: trustedAuthority,
        targetWorkspace: trustedTarget,
        agentName,
        kind: requestedKind,
        contextTreePath: contextTree.path,
        expectManifest: workspaceTreeName(requestedKind) !== null && publicationSourceNames !== null,
        expectSentinel: markInitComplete || trustedAuthority !== trustedTarget,
      });
    }
    assertPublishedClaudeBriefing(trustedTarget, briefing);

    return { briefing, sourceRepos, teamSkills, resourceConfigVersion };
  });
}

/**
 * Run the provider-neutral managed-session preparation that every normal
 * start/resume shares, in the order the runtime contract requires:
 *
 * 1. acquire the per-agent home;
 * 2. best-effort raw chat context (degrades to none on failure);
 * 3. declare the payload's source repos (after sync `atProjectionEntry`);
 * 4. settle Managed Skills — this gates provider admission, so a reconcile
 *    that cannot prove discovery safe throws here and leaves the delivery as
 *    unacked recovery debt;
 * 5. optional provider-owned `beforeBriefing` work (e.g. landing sandbox env);
 * 6. build the briefing from *that same* reconcile result;
 * 7. run the shared agent bootstrap;
 * 8. mark the workspace init-complete.
 *
 * Lifecycle fences that must close the post-await / pre-reconcile window use
 * synchronous {@link PrepareManagedSessionParams.atProjectionEntry} (invoked
 * as the first statement of {@link projectManagedWorkspace}, before any await).
 *
 * Preparation failure remains pre-provider: no provider process/session is
 * opened here, and no new ACK authority is created.
 */
export async function prepareManagedSession(params: PrepareManagedSessionParams): Promise<PreparedManagedSession> {
  const {
    sessionCtx,
    workspaceRoot,
    runtimeProvider,
    providerSkillRoots,
    runtimeConfig,
    payload,
    existingPayload,
    payloadResolved,
    contextTree,
    agentName,
    atProjectionEntry,
    beforeBriefing,
  } = params;

  const workspace = acquireAgentHome(workspaceRoot);
  const chatContext = await fetchChatContextOrLog(sessionCtx);

  const projected = await projectManagedWorkspace({
    sessionCtx,
    workspace,
    runtimeProvider,
    providerSkillRoots,
    runtimeConfig,
    payload,
    existingPayload,
    payloadResolved,
    contextTree,
    reresolveSource: true,
    agentName,
    markInitComplete: true,
    bundledSkillsRoot: params.bundledSkillsRoot,
    atProjectionEntry: atProjectionEntry
      ? () => {
          // Must not discard a non-undefined return — that would recreate the
          // `async () => …` assignable-to-void escape the sync contract forbids.
          const result: unknown = atProjectionEntry({ workspace, chatContext });
          if (result !== undefined) {
            throw new Error(
              `atProjectionEntry must be synchronous (must return undefined; got ${
                isThenable(result) ? "thenable" : typeof result
              })`,
            );
          }
          return undefined;
        }
      : undefined,
    beforeBriefing: beforeBriefing ? (args) => beforeBriefing({ ...args, chatContext }) : undefined,
  });

  return {
    workspace,
    chatContext,
    briefing: projected.briefing,
    sourceRepos: projected.sourceRepos,
    teamSkills: projected.teamSkills,
    resourceConfigVersion: projected.resourceConfigVersion,
  };
}

export type { AgentBootstrapParams } from "../agent-bootstrap.js";
// Lower-level Runtime-owned preparation symbols for hot-switch / legacy paths
// that are not a full admission. Re-export owner bindings so identity is
// preserved (no façade wrappers).
export { ensureAgentBootstrap } from "../agent-bootstrap.js";
export type { BuildAgentBriefingOptions } from "../agent-briefing.js";
export { buildAgentBriefing } from "../agent-briefing.js";
export type { ChatContext } from "../chat-context.js";
export { fetchChatContext } from "../chat-context.js";
export type {
  ProviderSkillRootProjection,
  ReconciledTeamSkill,
  ReconcileManagedSkillsResult,
} from "../managed-skills.js";
export {
  isManagedSkillsUnsafeDiscoveryError,
  reconcileManagedSkills,
  reconcileManagedSkillsForConfig,
} from "../managed-skills.js";
export { currentSourceRepoNamesFromPayload, declaredSourceRepos } from "../source-repos.js";
export { teamSkillBundleResolverFromSdk } from "../team-skill-bundle-resolver.js";
export { acquireAgentHome, markWorkspaceInitComplete } from "../workspace.js";
