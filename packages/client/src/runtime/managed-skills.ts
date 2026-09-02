import { createHash, randomBytes } from "node:crypto";
import { createWriteStream, lstatSync, realpathSync } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  readdir,
  readFile,
  readlink,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import {
  type AgentRuntimeConfig,
  foldPortableTeamSkillPath,
  getPortableTeamSkillRelativePathError,
  getPortableTeamSkillSegmentError,
  normalizeTeamSkillTargetSlug,
  parseStrictTeamSkillMarkdown,
  type RuntimeProvider,
  type RuntimeResourceSkill,
  type RuntimeSkillBundle,
  recordPortableTeamSkillPath,
  TEAM_SKILL_BUNDLE_LIMITS,
  TEAM_SKILL_OWNERSHIP_MARKER,
} from "@first-tree/shared";
import { parseDocument } from "yaml";
import yauzl, { type Entry, type ZipFile } from "yauzl";
import type { ContextSourceKind } from "./context-source.js";
import {
  CORE_SKILL_NAMES,
  type CoreSkillName,
  localContextVariantSourcePath,
  resolveBundledSkillsRoot,
} from "./first-tree-skills/installer.js";
import {
  clearManagedSkillsJournal,
  emptyManagedState,
  MANAGED_SKILLS_JOURNAL_REL,
  MANAGED_SKILLS_LOCK_REL,
  MANAGED_STATE_REL,
  type ManagedSkillEntry,
  type ManagedSkillsJournal,
  type ManagedSkillsJournalPhase,
  type ManagedState,
  readManagedSkillsJournal,
  readManagedStateResult,
  writeManagedSkillsJournal,
  writeManagedState,
} from "./managed-state.js";
import { acquireWorkspaceFileLock, type WorkspaceFileLock } from "./workspace-file-lock.js";
import { workspaceHasRemoteLatch } from "./workspace-manifest.js";

const OWNERSHIP_MARKER = TEAM_SKILL_OWNERSHIP_MARKER;
const LEGACY_RESOURCE_SKILLS_ROOT = ".first-tree/resources/skills";
const MAX_SKILL_FILES = TEAM_SKILL_BUNDLE_LIMITS.maxMaterializedFiles;
const MAX_SKILL_TOTAL_BYTES = TEAM_SKILL_BUNDLE_LIMITS.maxMaterializedBytes;
const MAX_SKILL_FILE_BYTES = TEAM_SKILL_BUNDLE_LIMITS.maxUncompressedBytes;
const MAX_SKILL_DEPTH = TEAM_SKILL_BUNDLE_LIMITS.maxDepth;
const DEFAULT_LOCK_TIMEOUT_MS = 10_000;
const MANAGED_SKILLS_QUARANTINE_PREFIX = ".managed-skill-quarantine-";

export type ProviderSkillRootProjection = Readonly<Record<RuntimeProvider, string>>;

export function allowedTargetRootsFromProjection(projection: ProviderSkillRootProjection): ReadonlySet<string> {
  return new Set([...Object.values(projection), LEGACY_RESOURCE_SKILLS_ROOT]);
}

const RETIRED_CORE_SKILL_NAMES = ["first-tree-guide", "first-tree-kickoff", "first-tree-gitlab"] as const;
const ALL_KNOWN_CORE_SKILL_NAMES = [...CORE_SKILL_NAMES, ...RETIRED_CORE_SKILL_NAMES] as const;

/**
 * Core Skills the external `context-tree-*` family supersedes.
 *
 * In external mode these are not projected, so the Agent is never offered two
 * ways to read or write a Context Tree. They are stood down, not retired: the
 * payloads still ship and a machine with `context_tree.repository` unset keeps
 * projecting them. Because `ALL_KNOWN_CORE_SKILL_NAMES` still lists them, the
 * adoption/prune path below recognizes and REMOVES any already-installed copy on
 * the next session — that is what makes the switch clean rather than additive.
 *
 * Review and Audit are here for a second reason: both operate on a First Tree
 * Team binding that external mode bypasses, and both SKILL.md bodies route
 * through `first-tree-read` / `first-tree-write`. Leaving them projected would
 * hand the Agent instructions pointing at Skills this machine just removed.
 */
const EXTERNAL_SUPERSEDED_CORE_SKILL_NAMES: readonly string[] = [
  "first-tree-read",
  "first-tree-write",
  "first-tree-seed",
  "context-tree-review",
  "context-tree-audit",
];
const EXTERNAL_SUPERSEDED_CORE_SKILLS = new Set<string>(EXTERNAL_SUPERSEDED_CORE_SKILL_NAMES);

/**
 * Core Skills projected for one context-source mode.
 *
 * `buildDesiredSkills` and `verifyManagedSkillsProjectionForAdmission` MUST both
 * go through this. If they disagree, a workspace projects a ledger its own
 * admission proof then rejects, and the Agent fails to start.
 */
function activeCoreSkillNames(contextSourceKind: ContextSourceKind | undefined): readonly CoreSkillName[] {
  if (contextSourceKind !== "external") return CORE_SKILL_NAMES;
  return CORE_SKILL_NAMES.filter((name) => !EXTERNAL_SUPERSEDED_CORE_SKILLS.has(name));
}
const WINDOWS_RESERVED_NAMES = new Set<string>([
  "con",
  "prn",
  "aux",
  "nul",
  "com1",
  "com2",
  "com3",
  "com4",
  "com5",
  "com6",
  "com7",
  "com8",
  "com9",
  "lpt1",
  "lpt2",
  "lpt3",
  "lpt4",
  "lpt5",
  "lpt6",
  "lpt7",
  "lpt8",
  "lpt9",
]);

export type TeamSkillSnapshot =
  | Readonly<{
      kind: "authoritative";
      resourceConfigVersion: number;
      skills: readonly RuntimeResourceSkill[];
    }>
  | Readonly<{ kind: "unavailable" }>;

export type ReconciledTeamSkill = Readonly<{
  key: `resource:${string}`;
  name: string;
  /** Cloud-declared base slug the user types — retained so the inbound
   *  slash-command rewrite can map it to the final `name` when a local
   *  collision pushed the install to a suffixed target. */
  requestedSlug: string;
  description: string;
  target: string;
  revision: string;
  installedDigest: `sha256:${string}`;
}>;

/**
 * One Cloud-configured Team Skill's command identity after reconcile.
 * `effectiveName` is null when no verified target exists for the base
 * slug (install failed, quarantined, or dropped during publication
 * verification) — the inbound rewrite must fail closed for such a
 * command rather than pass it to a possibly identically-named unmanaged
 * Skill.
 */
export type ReconciledTeamSkillCommand = Readonly<{
  requestedSlug: string;
  /**
   * The exact Team resource this command identity belongs to. The inbound
   * rewrite requires a marker's resourceId to match — a deleted-then-
   * recreated resource reusing the same slug must NOT inherit the old
   * invocation.
   */
  resourceId: string;
  effectiveName: string | null;
}>;

export type ManagedSkillFailure = Readonly<{
  key: string;
  reason: string;
}>;

export type ReconcileManagedSkillsResult = Readonly<{
  ok: boolean;
  resourceConfigVersion: number;
  installed: readonly string[];
  skipped: readonly string[];
  removed: readonly string[];
  teamSkills: readonly ReconciledTeamSkill[];
  /**
   * Complete Team Skill command registry from an authoritative snapshot:
   * every desired base slug with its verified effective name (or null).
   * `null` means this result carries no proven publication
   * (stale/unavailable snapshot or failed reconcile) — preparation then
   * publishes its own fail-closed replacement (current-config unavailable
   * fallback, verified ledger, or explicit unknown), so the session
   * registry is always replaced deliberately, never silently kept.
   */
  teamSkillCommands: readonly ReconciledTeamSkillCommand[] | null;
  failures: readonly ManagedSkillFailure[];
  staleTeamSnapshot: boolean;
}>;

/**
 * Read-only proof that an already-published Managed Skills projection is a
 * complete, internally consistent v2 ledger. This is deliberately stricter
 * than normal reconciliation recovery: callers use it before deciding that
 * an unresolved Context source may safely keep running a previously
 * published `none` projection, so it must never repair, quarantine, or write.
 */
export type VerifiedManagedSkillsProjection = Readonly<{
  resourceConfigVersion: number;
  teamSkills: readonly ReconciledTeamSkill[];
}>;

export async function verifyManagedSkillsProjectionForAdmission(options: {
  workspace: string;
  provider: RuntimeProvider;
  providerSkillRoots: ProviderSkillRootProjection;
  /**
   * Must match the mode the projection was built with. External mode projects
   * fewer Core Skills, so a proof that demanded the full set would reject a
   * perfectly healthy external-mode ledger and refuse to admit the Agent.
   */
  contextSourceKind?: ContextSourceKind;
}): Promise<VerifiedManagedSkillsProjection | null> {
  const { workspace, provider, providerSkillRoots } = options;
  const allowedRoots = allowedTargetRootsFromProjection(providerSkillRoots);
  const expectedCoreNames = activeCoreSkillNames(options.contextSourceKind);

  try {
    const workspaceStat = await lstat(workspace);
    if (!workspaceStat.isDirectory() || workspaceStat.isSymbolicLink()) return null;
    if ((await realpath(workspace)) !== resolve(workspace)) return null;

    const statePath = join(workspace, MANAGED_STATE_REL);
    const stateStat = await lstat(statePath);
    if (!stateStat.isFile() || stateStat.isSymbolicLink()) return null;
    const stateResult = readManagedStateResult(workspace);
    if (stateResult.kind !== "current") return null;

    try {
      await lstat(join(workspace, MANAGED_SKILLS_JOURNAL_REL));
      return null;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") return null;
    }

    const activeRoot = providerSkillRoot(provider, providerSkillRoots);
    const activePrefix = `${activeRoot}/`;
    const activeEntries = stateResult.state.skills.filter((entry) => entry.target.startsWith(activePrefix));
    if (activeEntries.length !== stateResult.state.skills.length) return null;
    const ledgerKeys = new Set<string>();
    const ledgerTargets = new Set<string>();
    const verifiedTeamSkills = new Map<ManagedSkillEntry["key"], ReconciledTeamSkill>();
    for (const entry of stateResult.state.skills) {
      if (ledgerKeys.has(entry.key) || ledgerTargets.has(entry.target)) return null;
      ledgerKeys.add(entry.key);
      ledgerTargets.add(entry.target);
    }
    for (const coreName of expectedCoreNames) {
      const expected = activeEntries.filter(
        (entry) => entry.key === `core:${coreName}` && entry.target === `${activeRoot}/${coreName}`,
      );
      if (expected.length !== 1) return null;
    }
    const expectedCoreKeys = new Set(expectedCoreNames.map((name) => `core:${name}`));
    const ledgerCoreEntries = stateResult.state.skills.filter((entry) => entry.key.startsWith("core:"));
    if (
      ledgerCoreEntries.length !== expectedCoreKeys.size ||
      ledgerCoreEntries.some((entry) => !expectedCoreKeys.has(entry.key))
    ) {
      return null;
    }

    for (const entry of stateResult.state.skills) {
      const targetPath = resolveWorkspacePath(workspace, entry.target, "target", allowedRoots);
      const targetStat = await lstat(targetPath);
      if (!targetStat.isDirectory() || targetStat.isSymbolicLink()) return null;

      const markerPath = join(targetPath, OWNERSHIP_MARKER);
      const markerStat = await lstat(markerPath);
      if (!markerStat.isFile() || markerStat.isSymbolicLink()) return null;
      const marker: unknown = JSON.parse(await readFile(markerPath, "utf8"));
      if (
        !isRecord(marker) ||
        marker.schemaVersion !== 1 ||
        marker.key !== entry.key ||
        marker.revision !== entry.revision
      ) {
        return null;
      }

      const digest = await digestDirectory(targetPath);
      if (digest !== entry.installedDigest) return null;
      if (entry.key.startsWith("resource:")) {
        const raw = await readFile(join(targetPath, "SKILL.md"));
        const markdown = new TextDecoder("utf-8", { fatal: true }).decode(raw);
        const frontmatter = parseStrictTeamSkillMarkdown(markdown).frontmatter;
        if (
          typeof frontmatter.name !== "string" ||
          frontmatter.name !== entry.effectiveName ||
          typeof frontmatter.description !== "string" ||
          frontmatter.description.trim().length === 0
        ) {
          return null;
        }
        const resourceKey = entry.key as `resource:${string}`;
        verifiedTeamSkills.set(resourceKey, {
          key: resourceKey,
          name: frontmatter.name,
          requestedSlug: entry.requestedSlug,
          description: frontmatter.description,
          target: entry.target,
          revision: entry.revision,
          installedDigest: entry.installedDigest,
        });
      }
    }

    for (const root of allowedRoots) {
      let entries: string[];
      try {
        const rootPath = resolveWorkspacePath(workspace, root, "root", allowedRoots);
        const rootStat = await lstat(rootPath);
        if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) return null;
        entries = await readdir(rootPath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
        return null;
      }
      if (entries.some((name) => /^\..+\.ft-[a-f0-9]+\.(?:staging|backup)$/.test(name))) return null;
      for (const name of entries) {
        const target = `${root}/${name}`;
        const ledgerEntry = stateResult.state.skills.find((entry) => entry.target === target);
        const targetPath = join(workspace, ...target.split("/"));
        const targetStat = await lstat(targetPath);
        if (!targetStat.isDirectory() || targetStat.isSymbolicLink()) {
          if (ledgerEntry || ALL_KNOWN_CORE_SKILL_NAMES.includes(name as (typeof ALL_KNOWN_CORE_SKILL_NAMES)[number]))
            return null;
          continue;
        }
        let hasOwnershipMarker = false;
        try {
          const markerStat = await lstat(join(targetPath, OWNERSHIP_MARKER));
          if (!markerStat.isFile() || markerStat.isSymbolicLink()) return null;
          hasOwnershipMarker = true;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") return null;
        }
        if (
          (hasOwnershipMarker ||
            ALL_KNOWN_CORE_SKILL_NAMES.includes(name as (typeof ALL_KNOWN_CORE_SKILL_NAMES)[number])) &&
          !ledgerEntry
        ) {
          return null;
        }
      }
    }

    const runtimeRoot = join(workspace, ".first-tree-workspace");
    const runtimeEntries = await readdir(runtimeRoot);
    if (runtimeEntries.some((name) => name.startsWith(MANAGED_SKILLS_QUARANTINE_PREFIX))) return null;
    const resourceEntries = stateResult.state.skills.filter((entry) => entry.key.startsWith("resource:"));
    if (verifiedTeamSkills.size !== resourceEntries.length) return null;
    return {
      resourceConfigVersion: stateResult.state.resourceConfigVersion,
      teamSkills: resourceEntries
        .filter((entry): entry is typeof entry & { key: `resource:${string}` } => entry.key.startsWith("resource:"))
        .map((entry) => verifiedTeamSkills.get(entry.key))
        .filter((entry): entry is ReconciledTeamSkill => entry !== undefined),
    };
  } catch {
    return null;
  }
}

export type ManagedSkillsCheckpoint =
  | "prepared"
  | "target_backed_up"
  | "target_installed"
  | "state_committed"
  | "backup_cleaned"
  | "quarantine_rename"
  | "quarantine_moved"
  | "remove_target"
  | "journal_recovery"
  | "provider_root_read";

export type TeamSkillBundleResolver = (bundle: RuntimeSkillBundle) => Promise<Buffer>;

export type ReconcileManagedSkillsOptions = Readonly<{
  workspace: string;
  provider: RuntimeProvider;
  /** Composition-owned provider → native skill-root projection (required; fail-closed lookup). */
  providerSkillRoots: ProviderSkillRootProjection;
  teamSnapshot: TeamSkillSnapshot;
  log?: (message: string) => void;
  /** Test/build override. Production resolves the bundled client skills directory. */
  bundledSkillsRoot?: string;
  /** Resolves immutable Team Skill ZIP bytes through the authenticated SDK. */
  bundleResolver?: TeamSkillBundleResolver;
  /**
   * Trusted Context source for this reconcile. Only `local` projects the
   * private Local Read/Write payloads; `remote` and `none` keep the public
   * inventory.
   */
  contextSourceKind?: ContextSourceKind;
  lockTimeoutMs?: number;
  /** Fault-injection seam used by deterministic crash-recovery tests. */
  testCrashAt?: ManagedSkillsCheckpoint;
  /** Ordinary failure seam used to exercise in-process rollback paths. */
  testFailureAt?: ManagedSkillsCheckpoint;
  /** Forces the rollback path to preserve its journal and abort reconciliation. */
  testRecoveryFailure?: boolean;
  /** Test-only platform override for the POSIX mode-safety gate. */
  testModePlatform?: NodeJS.Platform;
  /** Mutates test state immediately before the universal provider-publication digest gate. */
  testBeforePublication?: () => void | Promise<void>;
  /** @deprecated Use testBeforePublication. */
  testBeforeTeamRows?: () => void | Promise<void>;
}>;

type DesiredManagedSkill = Readonly<{
  key: ManagedSkillEntry["key"];
  kind: "core" | "team";
  requestedSlug: string;
  description: string;
  revision: string;
  validationError: string | null;
  source:
    | Readonly<{ kind: "bundled-directory"; path: string }>
    | Readonly<{ kind: "inline-skill"; skill: RuntimeResourceSkill }>
    | Readonly<{ kind: "preserved-attachment"; entry: ManagedSkillEntry }>
    | Readonly<{
        kind: "attachment-zip";
        bundle: RuntimeSkillBundle;
        manifestName: string;
      }>;
}>;

type AllocatedManagedSkill = Readonly<{
  desired: DesiredManagedSkill;
  effectiveName: string;
  target: string;
}>;

type StagedManagedSkill = Readonly<{
  allocated: AllocatedManagedSkill;
  staging: string;
  entry: ManagedSkillEntry;
}>;

type MutableReconcileResult = {
  installed: string[];
  skipped: string[];
  removed: string[];
  teamSkills: ReconciledTeamSkill[];
  teamSkillCommands: ReconciledTeamSkillCommand[] | null;
  failures: ManagedSkillFailure[];
  staleTeamSnapshot: boolean;
};

type SkillTreeStats = {
  files: number;
  bytes: number;
};

type SkillTreeModePolicy = "enforce-safe" | "normalize-bundled";

class ManagedSkillsFatalError extends Error {}
export class ManagedSkillsUnsafeDiscoveryError extends Error {
  override readonly name = "ManagedSkillsUnsafeDiscoveryError";
}
class ManagedSkillsSimulatedCrash extends Error {}

export function isManagedSkillsUnsafeDiscoveryError(error: unknown): error is ManagedSkillsUnsafeDiscoveryError {
  return error instanceof ManagedSkillsUnsafeDiscoveryError;
}

function assertLocalSkillPublicationAuthorized(options: ReconcileManagedSkillsOptions): void {
  if (options.contextSourceKind !== "local") return;
  if (!workspaceHasRemoteLatch(options.workspace)) return;
  throw new ManagedSkillsUnsafeDiscoveryError(
    "Local Context Read/Write Skill variants cannot be published after a remote binding has been observed",
  );
}

const processMutexTails = new Map<string, Promise<void>>();

export function providerSkillRoot(provider: RuntimeProvider, projection: ProviderSkillRootProjection): string {
  const root = projection[provider];
  if (typeof root !== "string" || root.length === 0) {
    throw new ManagedSkillsFatalError(`provider skill root projection missing for ${provider}`);
  }
  return root;
}

export function authoritativeTeamSkillSnapshot(
  resourceConfigVersion: number,
  skills: readonly RuntimeResourceSkill[],
): TeamSkillSnapshot {
  return { kind: "authoritative", resourceConfigVersion, skills };
}

export function teamSkillSnapshotFromConfig(config: AgentRuntimeConfig | null | undefined): TeamSkillSnapshot {
  return config
    ? authoritativeTeamSkillSnapshot(config.version, config.payload.resourceSkills)
    : { kind: "unavailable" };
}

export async function reconcileManagedSkillsForConfig(
  workspace: string,
  provider: RuntimeProvider,
  providerSkillRoots: ProviderSkillRootProjection,
  config: AgentRuntimeConfig | null | undefined,
  log?: (message: string) => void,
  bundleResolver?: TeamSkillBundleResolver,
  contextSourceKind: ContextSourceKind = "remote",
  bundledSkillsRoot?: string,
): Promise<ReconcileManagedSkillsResult> {
  return reconcileManagedSkills({
    workspace,
    provider,
    providerSkillRoots,
    teamSnapshot: teamSkillSnapshotFromConfig(config),
    log,
    bundleResolver,
    contextSourceKind,
    bundledSkillsRoot,
  });
}

export async function reconcileManagedSkills(
  options: ReconcileManagedSkillsOptions,
): Promise<ReconcileManagedSkillsResult> {
  return withProcessMutex(processMutexKey(options.workspace), async () => {
    const mutable: MutableReconcileResult = {
      installed: [],
      skipped: [],
      removed: [],
      teamSkills: [],
      teamSkillCommands: null,
      failures: [],
      staleTeamSnapshot: false,
    };
    let lock: WorkspaceFileLock | null = null;
    try {
      assertManagedWorkspaceRootsSafe(options.workspace, allowedTargetRootsFromProjection(options.providerSkillRoots));
      lock = await acquireWorkspaceLock(options);
      assertLocalSkillPublicationAuthorized(options);
      await recoverPendingJournal(options);
      let state = await loadOrMigrateManagedState(options);

      const authoritative =
        options.teamSnapshot.kind === "authoritative" &&
        options.teamSnapshot.resourceConfigVersion >= state.resourceConfigVersion;
      if (
        options.teamSnapshot.kind === "authoritative" &&
        options.teamSnapshot.resourceConfigVersion < state.resourceConfigVersion
      ) {
        mutable.staleTeamSnapshot = true;
        options.log?.(
          `Managed skills ignored stale Team Resource snapshot v${options.teamSnapshot.resourceConfigVersion}; ` +
            `workspace fence is v${state.resourceConfigVersion}`,
        );
      }
      if (
        options.teamSnapshot.kind === "authoritative" &&
        options.teamSnapshot.resourceConfigVersion > state.resourceConfigVersion
      ) {
        state = persistStateMonotonic(options.workspace, {
          ...state,
          resourceConfigVersion: options.teamSnapshot.resourceConfigVersion,
        });
      }
      if (authoritative && options.teamSnapshot.kind === "authoritative") {
        state = await adoptLegacyResourceSkills(
          options.workspace,
          state,
          options.teamSnapshot.skills,
          allowedTargetRootsFromProjection(options.providerSkillRoots),
          options.log,
        );
      } else if (options.teamSnapshot.kind === "unavailable") {
        options.log?.(
          "Managed skills Team Resource snapshot unavailable; preserving last-known-good Team Skills until control-plane recovery",
        );
      }
      if (!authoritative) {
        await verifyPreservedTeamTargets(options, state);
      }

      const desiredSkills = await buildDesiredSkills(options, state, authoritative);
      if (options.contextSourceKind === "local") {
        const missingLocal = desiredSkills.filter(
          (skill) =>
            (skill.key === "core:first-tree-read" || skill.key === "core:first-tree-write") && skill.validationError,
        );
        if (missingLocal.length > 0) {
          throw new ManagedSkillsUnsafeDiscoveryError(
            `Local Context Read/Write Skill variants are required before admission: ${missingLocal
              .map((skill) => skill.key)
              .join(", ")}`,
          );
        }
      }
      const allocations = await allocateTargets(options, state, desiredSkills);
      const successfulTargets = new Map<ManagedSkillEntry["key"], string>();
      const desiredKeys = new Set<ManagedSkillEntry["key"]>(desiredSkills.map((skill) => skill.key));

      for (const desired of desiredSkills) {
        const allocated = allocations.get(desired.key);
        if (!allocated) {
          mutable.failures.push({
            key: desired.key,
            reason: desired.validationError ?? "no safe provider-native target is available",
          });
          continue;
        }
        try {
          state = await ensureTargetOwnership(
            options.workspace,
            state,
            allocated,
            allowedTargetRootsFromProjection(options.providerSkillRoots),
          );
          const current = state.skills.find(
            (entry) => entry.key === allocated.desired.key && entry.target === allocated.target,
          );
          const existing = current?.revision === allocated.desired.revision ? current : undefined;
          if (current) {
            let actualDigest: `sha256:${string}` | null = null;
            try {
              actualDigest = await digestManagedTarget(
                options.workspace,
                current.target,
                allowedTargetRootsFromProjection(options.providerSkillRoots),
                {
                  modePlatform: options.testModePlatform,
                },
              );
            } catch (error) {
              options.log?.(
                `Managed skill target cannot be verified (${current.key}): ${
                  error instanceof Error ? error.message.slice(0, 300) : String(error)
                }`,
              );
            }
            if (actualDigest !== current.installedDigest) {
              await quarantineDriftedManagedTarget(options, current);
            } else if (existing) {
              const expectedDigest =
                allocated.desired.source.kind === "bundled-directory"
                  ? await digestBundledFinalTree(
                      allocated.desired.source.path,
                      allocated.desired.key,
                      allocated.desired.revision,
                      options.testModePlatform,
                    )
                  : allocated.desired.source.kind === "inline-skill" ||
                      allocated.desired.source.kind === "preserved-attachment"
                    ? existing.installedDigest
                    : actualDigest;
              if (expectedDigest === existing.installedDigest) {
                mutable.skipped.push(existing.key);
                successfulTargets.set(existing.key, existing.target);
                continue;
              }
            }
          }
          assertLocalSkillPublicationAuthorized(options);
          const staged = await stageManagedSkill(options, allocated);
          state = await installStagedSkill(options, state, staged);
          mutable.installed.push(staged.entry.key);
          successfulTargets.set(staged.entry.key, staged.entry.target);
        } catch (error) {
          if (
            error instanceof ManagedSkillsSimulatedCrash ||
            error instanceof ManagedSkillsFatalError ||
            error instanceof ManagedSkillsUnsafeDiscoveryError
          ) {
            throw error;
          }
          const reason = error instanceof Error ? error.message : String(error);
          mutable.failures.push({ key: desired.key, reason });
          options.log?.(`Managed skill reconcile failed (${desired.key}): ${reason.slice(0, 300)}`);
        }
      }

      const entriesToRemove = state.skills.filter((entry) => {
        if (entry.key.startsWith("core:")) {
          if (!desiredKeys.has(entry.key)) return true;
          const successfulTarget = successfulTargets.get(entry.key);
          return successfulTarget !== undefined && successfulTarget !== entry.target;
        }
        if (!authoritative) return false;
        if (!desiredKeys.has(entry.key)) return true;
        const successfulTarget = successfulTargets.get(entry.key);
        return successfulTarget !== undefined && successfulTarget !== entry.target;
      });

      for (const entry of entriesToRemove) {
        try {
          state = await removeManagedEntry(options, state, entry);
          mutable.removed.push(`${entry.key}@${entry.target}`);
        } catch (error) {
          if (error instanceof ManagedSkillsSimulatedCrash) throw error;
          if (
            await managedTargetExistsAfterFailedRemoval(
              options.workspace,
              entry.target,
              allowedTargetRootsFromProjection(options.providerSkillRoots),
            )
          ) {
            throw new ManagedSkillsUnsafeDiscoveryError(
              `Managed Skill target ${entry.target} could not be removed from provider discovery`,
              { cause: error },
            );
          }
          if (error instanceof ManagedSkillsFatalError) throw error;
          const reason = error instanceof Error ? error.message : String(error);
          mutable.failures.push({ key: entry.key, reason: `cleanup ${entry.target}: ${reason}` });
          options.log?.(`Managed skill cleanup failed (${entry.key} at ${entry.target}): ${reason.slice(0, 300)}`);
        }
      }

      await (options.testBeforePublication ?? options.testBeforeTeamRows)?.();
      assertLocalSkillPublicationAuthorized(options);
      const publication = await verifyLedgerTargetsForPublication(options, state);
      for (const invalidated of publication.invalidated) {
        mutable.installed = mutable.installed.filter((key) => key !== invalidated.key);
        mutable.skipped = mutable.skipped.filter((key) => key !== invalidated.key);
        mutable.failures.push({
          key: invalidated.key,
          reason: "managed Skill changed during final provider publication verification and was quarantined",
        });
      }
      if (authoritative && options.teamSnapshot.kind === "authoritative") {
        mutable.teamSkills = buildReconciledTeamRows(
          state,
          desiredSkills,
          successfulTargets,
          publication.verifiedTargets,
        );
        mutable.teamSkillCommands = buildTeamSkillCommandEntries(desiredSkills, mutable.teamSkills);
      }
      return freezeResult(state.resourceConfigVersion, mutable);
    } catch (error) {
      if (error instanceof ManagedSkillsUnsafeDiscoveryError) throw error;
      if (
        !(error instanceof ManagedSkillsSimulatedCrash) &&
        (await providerDiscoveryMayContainManagedContent(options))
      ) {
        throw new ManagedSkillsUnsafeDiscoveryError(
          "Managed Skill reconciliation did not reach verified publication while provider discovery may contain managed content",
          { cause: error },
        );
      }
      const reason = error instanceof Error ? error.message : String(error);
      mutable.failures.push({ key: "workspace", reason });
      options.log?.(`Managed skills reconcile skipped: ${reason.slice(0, 300)}`);
      let resourceConfigVersion = 0;
      try {
        assertManagedWorkspaceRootsSafe(
          options.workspace,
          allowedTargetRootsFromProjection(options.providerSkillRoots),
        );
        const stateResult = readManagedStateResult(options.workspace);
        if (stateResult.kind === "current") resourceConfigVersion = stateResult.state.resourceConfigVersion;
      } catch {
        // The original failure may itself be an unsafe managed root. Do not
        // follow that root merely to enrich a best-effort result field.
      }
      return freezeResult(resourceConfigVersion, mutable);
    } finally {
      try {
        await lock?.release();
      } catch (error) {
        // A cleanup failure must not turn a settled provider preflight into a
        // rejected handler start. Closing the descriptor releases only this
        // process's kernel lock and never removes a successor's lock path.
        options.log?.(
          `Managed skills lock cleanup failed: ${error instanceof Error ? error.message.slice(0, 300) : String(error)}`,
        );
      }
    }
  });
}

function freezeResult(resourceConfigVersion: number, result: MutableReconcileResult): ReconcileManagedSkillsResult {
  return Object.freeze({
    ok: result.failures.length === 0,
    resourceConfigVersion,
    installed: Object.freeze([...result.installed]),
    skipped: Object.freeze([...result.skipped]),
    removed: Object.freeze([...result.removed]),
    teamSkills: Object.freeze([...result.teamSkills]),
    teamSkillCommands: result.teamSkillCommands === null ? null : Object.freeze([...result.teamSkillCommands]),
    failures: Object.freeze([...result.failures]),
    staleTeamSnapshot: result.staleTeamSnapshot,
  });
}

function processMutexKey(workspace: string): string {
  try {
    return realpathSync(resolve(workspace));
  } catch {
    // The guarded reconcile reports the original workspace error. The
    // lexical fallback only keeps concurrent failing calls serialized.
    return resolve(workspace);
  }
}

async function withProcessMutex<T>(workspace: string, task: () => Promise<T>): Promise<T> {
  const previous = processMutexTails.get(workspace) ?? Promise.resolve();
  let releaseTail = (): void => {};
  const current = new Promise<void>((resolveTail) => {
    releaseTail = resolveTail;
  });
  const tail = previous.then(() => current);
  processMutexTails.set(workspace, tail);
  await previous;
  try {
    return await task();
  } finally {
    releaseTail();
    if (processMutexTails.get(workspace) === tail) {
      processMutexTails.delete(workspace);
    }
  }
}

async function acquireWorkspaceLock(options: ReconcileManagedSkillsOptions): Promise<WorkspaceFileLock> {
  const lockRel = toPortablePath(MANAGED_SKILLS_LOCK_REL);
  const lockPath = resolveWorkspacePath(
    options.workspace,
    lockRel,
    "lock",
    allowedTargetRootsFromProjection(options.providerSkillRoots),
  );
  const timeoutMs = options.lockTimeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS;
  await mkdir(dirname(lockPath), { recursive: true });
  // The file is deliberately permanent: removing or renaming a lock inode
  // creates a publication race where two owners can hold different inodes.
  return acquireWorkspaceFileLock(lockPath, { timeoutMs });
}

async function loadOrMigrateManagedState(options: ReconcileManagedSkillsOptions): Promise<ManagedState> {
  const result = readManagedStateResult(options.workspace);
  if (result.kind === "current") return result.state;
  if (result.kind === "future") {
    throw new ManagedSkillsFatalError(
      `managed state schema v${result.schemaVersion} is newer than this client; refusing filesystem changes`,
    );
  }
  if (result.kind === "invalid") {
    throw new ManagedSkillsFatalError(`managed state is invalid; refusing filesystem changes: ${result.reason}`);
  }

  const legacyNames = result.kind === "legacy" ? result.state.skills : [];
  let bundledRoot: string | null = null;
  try {
    bundledRoot = options.bundledSkillsRoot ?? resolveBundledSkillsRoot();
  } catch {
    // Pair/ledger/marker ownership proofs still work without the current bundle.
  }
  const adopted: ManagedSkillEntry[] = [];
  const explicitlyManaged = new Set(legacyNames);
  for (const name of ALL_KNOWN_CORE_SKILL_NAMES) {
    const agentsTarget = `.agents/skills/${name}`;
    const claudeTarget = `.claude/skills/${name}`;
    const pairOwned = await isLegacyCorePair(
      options.workspace,
      name,
      allowedTargetRootsFromProjection(options.providerSkillRoots),
    );
    const bundledPath = bundledRoot ? join(bundledRoot, name) : null;
    for (const target of [agentsTarget, claudeTarget]) {
      const digest = await digestLegacyTargetIfOwned(
        options.workspace,
        target,
        `core:${name}`,
        explicitlyManaged.has(name) || pairOwned,
        bundledPath,
        allowedTargetRootsFromProjection(options.providerSkillRoots),
      );
      if (!digest) continue;
      adopted.push({
        key: `core:${name}`,
        target,
        requestedSlug: name,
        effectiveName: name,
        revision: "legacy-v1",
        installedDigest: digest,
      });
    }
  }
  for (const name of legacyNames) {
    if (ALL_KNOWN_CORE_SKILL_NAMES.includes(name as (typeof ALL_KNOWN_CORE_SKILL_NAMES)[number])) continue;
    if (!isSafeSkillName(name)) continue;
    for (const root of [".agents/skills", ".claude/skills"]) {
      const target = `${root}/${name}`;
      const digest = await digestManagedTarget(
        options.workspace,
        target,
        allowedTargetRootsFromProjection(options.providerSkillRoots),
        { followExpectedLegacySymlink: true },
      );
      if (!digest) continue;
      adopted.push({
        key: `core:${name}`,
        target,
        requestedSlug: name,
        effectiveName: name,
        revision: "legacy-v1",
        installedDigest: digest,
      });
    }
  }
  const migrated = writeManagedState(options.workspace, {
    ...emptyManagedState(),
    skills: adopted,
  });
  options.log?.(`Managed skills state migrated to v2 (${adopted.length} proven legacy target(s) adopted)`);
  return migrated;
}

async function isLegacyCorePair(workspace: string, name: string, allowedRoots: ReadonlySet<string>): Promise<boolean> {
  const claudePath = resolveWorkspacePath(workspace, `.claude/skills/${name}`, "target", allowedRoots);
  try {
    const linkStat = await lstat(claudePath);
    if (!linkStat.isSymbolicLink()) return false;
    const target = toPortablePath(await readlink(claudePath));
    return target === `../../.agents/skills/${name}`;
  } catch {
    return false;
  }
}

async function digestLegacyTargetIfOwned(
  workspace: string,
  target: string,
  key: ManagedSkillEntry["key"],
  ownershipProven: boolean,
  bundledPath: string | null,
  allowedRoots: ReadonlySet<string>,
): Promise<`sha256:${string}` | null> {
  const marker = await readOwnershipMarker(workspace, target, allowedRoots);
  if (marker?.key === key) {
    return digestManagedTarget(workspace, target, allowedRoots, {
      followExpectedLegacySymlink: true,
      modePolicy: "normalize-bundled",
    });
  }
  const targetDigest = await digestManagedTarget(workspace, target, allowedRoots, {
    followExpectedLegacySymlink: true,
    modePolicy: "normalize-bundled",
  });
  if (!targetDigest) return null;
  if (ownershipProven) return targetDigest;
  const bundledDigest = bundledPath
    ? await digestDirectoryIfPresent(bundledPath, undefined, "normalize-bundled")
    : null;
  if (bundledDigest === targetDigest) return targetDigest;

  // Normalized mode comparison is only an ownership probe. If no ownership
  // evidence matches, retain the ordinary strict digest gate so an unsafe
  // same-name target cannot remain in provider discovery unnoticed.
  await digestManagedTarget(workspace, target, allowedRoots, { followExpectedLegacySymlink: true });
  return null;
}

async function adoptLegacyResourceSkills(
  workspace: string,
  state: ManagedState,
  skills: readonly RuntimeResourceSkill[],
  allowedRoots: ReadonlySet<string>,
  log?: (message: string) => void,
): Promise<ManagedState> {
  const additions: ManagedSkillEntry[] = [];
  for (const skill of skills) {
    if (skill.bundle) continue;
    if (!isSafeLegacyResourceId(skill.resourceId)) continue;
    const target = `${LEGACY_RESOURCE_SKILLS_ROOT}/${skill.resourceId}`;
    if (state.skills.some((entry) => entry.target === target)) continue;
    let actual: string;
    try {
      actual = await readFile(
        resolveWorkspacePath(workspace, `${target}/SKILL.md`, "legacy-resource-file", allowedRoots),
        "utf-8",
      );
    } catch {
      continue;
    }
    if (actual !== buildLegacyResourceSkillMarkdown(skill)) continue;
    const digest = await digestManagedTarget(workspace, target, allowedRoots);
    if (!digest) continue;
    let requestedSlug: string;
    try {
      requestedSlug = normalizeTeamSkillTargetSlug(skill.name);
    } catch {
      continue;
    }
    additions.push({
      key: `resource:${skill.resourceId}`,
      target,
      requestedSlug,
      effectiveName: requestedSlug,
      revision: inlineSkillRevision(skill),
      installedDigest: digest,
    });
  }
  if (additions.length === 0) return state;
  log?.(`Managed skills adopted ${additions.length} legacy Team Skill target(s) for safe migration`);
  return persistStateMonotonic(workspace, { ...state, skills: [...state.skills, ...additions] });
}

function isSafeLegacyResourceId(resourceId: string): boolean {
  if (resourceId.length === 0 || resourceId.length > 255) return false;
  if (resourceId === "." || resourceId === "..") return false;
  return /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(resourceId);
}

async function buildDesiredSkills(
  options: ReconcileManagedSkillsOptions,
  state: ManagedState,
  authoritativeTeamSnapshot: boolean,
): Promise<DesiredManagedSkill[]> {
  let bundledRoot: string;
  try {
    bundledRoot = options.bundledSkillsRoot ?? resolveBundledSkillsRoot();
  } catch (error) {
    bundledRoot = join(options.workspace, ".first-tree-workspace", ".missing-bundled-skills");
    options.log?.(`Managed Core Skill bundle unavailable: ${error instanceof Error ? error.message : String(error)}`);
  }
  const desired: DesiredManagedSkill[] = [];
  const localVariants = options.contextSourceKind === "local";
  for (const name of activeCoreSkillNames(options.contextSourceKind)) {
    const useLocalVariant = localVariants && (name === "first-tree-read" || name === "first-tree-write");
    const sourcePath = useLocalVariant ? localContextVariantSourcePath(bundledRoot, name) : join(bundledRoot, name);
    let revision = "unavailable";
    let validationError: string | null = null;
    try {
      const version = await readRequiredVersion(sourcePath, name);
      revision = useLocalVariant ? `local-context:${version}` : version;
    } catch (error) {
      validationError = error instanceof Error ? error.message : String(error);
      options.log?.(`Managed Core Skill rejected (core:${name}): ${validationError}`);
    }
    desired.push({
      key: `core:${name}`,
      kind: "core",
      requestedSlug: name,
      description: "",
      revision,
      validationError,
      source: { kind: "bundled-directory", path: sourcePath },
    });
  }
  if (!authoritativeTeamSnapshot || options.teamSnapshot.kind !== "authoritative") return desired;

  const sorted = [...options.teamSnapshot.skills].sort((left, right) =>
    left.resourceId.localeCompare(right.resourceId),
  );
  const resourceIdCounts = new Map<string, number>();
  for (const skill of sorted) {
    resourceIdCounts.set(skill.resourceId, (resourceIdCounts.get(skill.resourceId) ?? 0) + 1);
  }
  const emittedDuplicateIds = new Set<string>();
  for (const skill of sorted) {
    const key = `resource:${skill.resourceId}` as const;
    const priorAttachment = !skill.bundle
      ? state.skills.find((entry) => entry.key === key && entry.revision.startsWith("attachment:"))
      : undefined;
    const source: DesiredManagedSkill["source"] = priorAttachment
      ? { kind: "preserved-attachment", entry: priorAttachment }
      : teamSkillSource(skill);
    const revision = priorAttachment?.revision ?? teamSkillRevision(skill);
    if ((resourceIdCounts.get(skill.resourceId) ?? 0) > 1) {
      if (!emittedDuplicateIds.has(skill.resourceId)) {
        emittedDuplicateIds.add(skill.resourceId);
        options.log?.(`Managed Team Skill rejected (${key}): duplicate resourceId in authoritative snapshot`);
        desired.push({
          key,
          kind: "team",
          requestedSlug: "",
          description: skill.description || "No description",
          revision,
          validationError: "duplicate resourceId in authoritative snapshot",
          source,
        });
      }
      continue;
    }
    try {
      const requestedSlug = priorAttachment?.requestedSlug ?? normalizeTeamSkillTargetSlug(skill.name);
      if (priorAttachment) {
        options.log?.(
          `Managed Team Skill preserved attachment authority (${key}); current snapshot omitted its bundle descriptor`,
        );
      }
      desired.push({
        key,
        kind: "team",
        requestedSlug,
        description: skill.description || "No description",
        revision,
        validationError: null,
        source,
      });
    } catch (error) {
      options.log?.(`Managed Team Skill rejected (${key}): ${error instanceof Error ? error.message : String(error)}`);
      // Keep the key in desired cleanup semantics by using an allocation that
      // cannot succeed. The caller records the failure and preserves old entries.
      desired.push({
        key,
        kind: "team",
        requestedSlug: "",
        description: skill.description || "No description",
        revision,
        validationError: error instanceof Error ? error.message : String(error),
        source,
      });
    }
  }
  return desired;
}

async function allocateTargets(
  options: ReconcileManagedSkillsOptions,
  state: ManagedState,
  desired: readonly DesiredManagedSkill[],
): Promise<Map<ManagedSkillEntry["key"], AllocatedManagedSkill>> {
  const { workspace, provider } = options;
  const allowedRoots = allowedTargetRootsFromProjection(options.providerSkillRoots);
  const root = providerSkillRoot(provider, options.providerSkillRoots);
  const occupied = new Map<string, ManagedSkillEntry["key"] | "unmanaged">();
  const onDiskSpellings = new Map<string, string>();
  try {
    maybeFault(options, "provider_root_read");
    for (const entry of await readdir(resolveWorkspacePath(workspace, root, "root", allowedRoots), {
      withFileTypes: true,
    })) {
      const folded = foldPortableTeamSkillPath(entry.name);
      occupied.set(folded, "unmanaged");
      onDiskSpellings.set(folded, entry.name);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  for (const entry of state.skills) {
    if (!entry.target.startsWith(`${root}/`)) continue;
    occupied.set(foldPortableTeamSkillPath(entry.effectiveName), entry.key);
  }

  const allocations = new Map<ManagedSkillEntry["key"], AllocatedManagedSkill>();
  for (const skill of desired) {
    if (!skill.requestedSlug || skill.validationError) continue;
    if (skill.kind === "core") {
      const target = `${root}/${skill.requestedSlug}`;
      const folded = foldPortableTeamSkillPath(skill.requestedSlug);
      const owner = occupied.get(folded);
      if (owner === "unmanaged" && onDiskSpellings.get(folded) !== skill.requestedSlug) {
        // Do not create a second spelling that collides on case-insensitive
        // filesystems, even when the current test host is case-sensitive.
        continue;
      }
      if (
        owner !== undefined &&
        owner !== "unmanaged" &&
        owner !== skill.key &&
        !(await targetMarkerMatches(workspace, target, skill.key, allowedRoots))
      ) {
        continue;
      }
      allocations.set(skill.key, { desired: skill, effectiveName: skill.requestedSlug, target });
      occupied.set(foldPortableTeamSkillPath(skill.requestedSlug), skill.key);
      continue;
    }

    const reusable = state.skills.find(
      (entry) =>
        entry.key === skill.key &&
        entry.requestedSlug === skill.requestedSlug &&
        entry.target.startsWith(`${root}/`) &&
        isSafeSkillName(entry.effectiveName),
    );
    if (reusable) {
      allocations.set(skill.key, {
        desired: skill,
        effectiveName: reusable.effectiveName,
        target: reusable.target,
      });
      occupied.set(foldPortableTeamSkillPath(reusable.effectiveName), skill.key);
      continue;
    }

    for (let suffix = 0; suffix < 10_000; suffix++) {
      const effectiveName =
        suffix === 0
          ? skill.requestedSlug
          : suffix === 1
            ? suffixSkillName(skill.requestedSlug, "-first-tree")
            : suffixSkillName(skill.requestedSlug, `-first-tree-${suffix}`);
      const target = `${root}/${effectiveName}`;
      const key = foldPortableTeamSkillPath(effectiveName);
      const owner = occupied.get(key);
      if (
        owner === undefined ||
        owner === skill.key ||
        (await targetMarkerMatches(workspace, target, skill.key, allowedRoots))
      ) {
        allocations.set(skill.key, { desired: skill, effectiveName, target });
        occupied.set(key, skill.key);
        break;
      }
    }
  }
  return allocations;
}

async function ensureTargetOwnership(
  workspace: string,
  state: ManagedState,
  allocated: AllocatedManagedSkill,
  allowedRoots: ReadonlySet<string>,
): Promise<ManagedState> {
  if (state.skills.some((entry) => entry.key === allocated.desired.key && entry.target === allocated.target)) {
    return state;
  }
  const targetPath = resolveWorkspacePath(workspace, allocated.target, "target", allowedRoots);
  let targetExists = true;
  try {
    await lstat(targetPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") targetExists = false;
    else throw error;
  }
  if (!targetExists) return state;

  const marker = await readOwnershipMarker(workspace, allocated.target, allowedRoots);
  if (marker?.key !== allocated.desired.key) {
    if (allocated.desired.kind === "core") {
      const sourceDigest =
        allocated.desired.source.kind === "bundled-directory"
          ? await digestDirectoryIfPresent(allocated.desired.source.path, undefined, "normalize-bundled")
          : null;
      const targetDigest = await digestManagedTarget(workspace, allocated.target, allowedRoots, {
        followExpectedLegacySymlink: true,
      });
      if (!sourceDigest || sourceDigest !== targetDigest) {
        throw new Error(`refusing to overwrite unowned Core Skill target ${allocated.target}`);
      }
    } else {
      throw new Error(`refusing to overwrite unowned Team Skill target ${allocated.target}`);
    }
  }
  const digest = await digestManagedTarget(workspace, allocated.target, allowedRoots, {
    followExpectedLegacySymlink: true,
  });
  if (!digest) throw new Error(`cannot adopt unreadable managed target ${allocated.target}`);
  return persistStateMonotonic(workspace, {
    ...state,
    skills: [
      ...state.skills,
      {
        key: allocated.desired.key,
        target: allocated.target,
        requestedSlug: allocated.desired.requestedSlug,
        effectiveName: allocated.effectiveName,
        revision: marker?.revision ?? "adopted",
        installedDigest: digest,
      },
    ],
  });
}

async function stageManagedSkill(
  options: ReconcileManagedSkillsOptions,
  allocated: AllocatedManagedSkill,
): Promise<StagedManagedSkill> {
  const workspace = options.workspace;
  const targetPath = resolveWorkspacePath(
    workspace,
    allocated.target,
    "target",
    allowedTargetRootsFromProjection(options.providerSkillRoots),
  );
  await mkdir(dirname(targetPath), { recursive: true });
  const stagingName = `.${basename(targetPath)}.ft-${randomBytes(8).toString("hex")}.staging`;
  const stagingPath = join(dirname(targetPath), stagingName);
  const staging = portableRelative(workspace, stagingPath);
  await rm(stagingPath, { recursive: true, force: true });
  await mkdir(stagingPath, { recursive: false, mode: 0o700 });
  await chmod(stagingPath, 0o700);
  try {
    if (allocated.desired.source.kind === "bundled-directory") {
      await copySanitizedSkillTree(allocated.desired.source.path, stagingPath);
    } else if (allocated.desired.source.kind === "inline-skill") {
      await writeInlineSkillTree(stagingPath, allocated);
    } else if (allocated.desired.source.kind === "preserved-attachment") {
      throw new Error(
        `Team Skill bundle descriptor is unavailable for previously bundle-backed ${allocated.desired.key}`,
      );
    } else {
      if (!options.bundleResolver) {
        throw new Error(`Team Skill bundle resolver is unavailable for ${allocated.desired.key}`);
      }
      const bytes = await options.bundleResolver(allocated.desired.source.bundle);
      if (bytes.byteLength !== allocated.desired.source.bundle.sizeBytes) {
        throw new Error(
          `Team Skill bundle ${allocated.desired.source.bundle.attachmentId} size mismatch: ` +
            `expected ${allocated.desired.source.bundle.sizeBytes}, received ${bytes.byteLength}`,
        );
      }
      await extractSkillZip(bytes, stagingPath);
      await validateSkillManifest(stagingPath, allocated.desired.source.manifestName);
      await rewriteSkillManifestName(stagingPath, allocated.effectiveName);
    }
    await writeOwnershipMarker(stagingPath, allocated.desired.key, allocated.desired.revision);
    const metadata = await validateSkillManifest(stagingPath, allocated.effectiveName);
    if (allocated.desired.kind === "core" && metadata.name !== allocated.desired.requestedSlug) {
      throw new Error(
        `bundled Core Skill manifest name "${metadata.name}" does not match "${allocated.desired.requestedSlug}"`,
      );
    }
    const installedDigest = await digestDirectory(stagingPath, options.testModePlatform);
    return {
      allocated,
      staging,
      entry: {
        key: allocated.desired.key,
        target: allocated.target,
        requestedSlug: allocated.desired.requestedSlug,
        effectiveName: allocated.effectiveName,
        revision: allocated.desired.revision,
        installedDigest,
      },
    };
  } catch (error) {
    await rm(stagingPath, { recursive: true, force: true });
    throw error;
  }
}

async function quarantineDriftedManagedTarget(
  options: ReconcileManagedSkillsOptions,
  entry: ManagedSkillEntry,
): Promise<void> {
  try {
    const targetPath = resolveWorkspacePath(
      options.workspace,
      entry.target,
      "target",
      allowedTargetRootsFromProjection(options.providerSkillRoots),
    );
    const quarantinePath = managedTargetQuarantinePath(
      options.workspace,
      entry.target,
      allowedTargetRootsFromProjection(options.providerSkillRoots),
    );
    if (!(await pathExists(targetPath))) {
      try {
        await rm(quarantinePath, { recursive: true, force: true });
      } catch (error) {
        options.log?.(
          `Managed skill stale quarantine cleanup deferred (${entry.target}): ${
            error instanceof Error ? error.message.slice(0, 300) : String(error)
          }`,
        );
      }
      return;
    }
    // One stable slot per ledger target prevents repeated drift from growing
    // an unbounded quarantine set. A stale slot must be removed before reuse.
    await rm(quarantinePath, { recursive: true, force: true });
    maybeFault(options, "quarantine_rename");
    await rename(targetPath, quarantinePath);
    options.log?.(`Managed skill quarantined unverified target ${entry.target}`);
    maybeFault(options, "quarantine_moved");
    try {
      await rm(quarantinePath, { recursive: true, force: true });
    } catch (error) {
      options.log?.(
        `Managed skill quarantine cleanup deferred (${entry.target}): ${
          error instanceof Error ? error.message.slice(0, 300) : String(error)
        }`,
      );
    }
  } catch (error) {
    if (error instanceof ManagedSkillsSimulatedCrash) throw error;
    throw new ManagedSkillsUnsafeDiscoveryError(
      `Managed Skill target ${entry.target} cannot be verified or quarantined outside provider discovery`,
      { cause: error },
    );
  }
}

function managedTargetQuarantinePath(workspace: string, target: string, allowedRoots: ReadonlySet<string>): string {
  const quarantineKey = createHash("sha256").update(target).digest("hex").slice(0, 24);
  const quarantine = `.first-tree-workspace/${MANAGED_SKILLS_QUARANTINE_PREFIX}${quarantineKey}`;
  return resolveWorkspacePath(workspace, quarantine, "quarantine", allowedRoots);
}

async function removeManagedTargetQuarantine(
  workspace: string,
  target: string,
  allowedRoots: ReadonlySet<string>,
): Promise<void> {
  await rm(managedTargetQuarantinePath(workspace, target, allowedRoots), { recursive: true, force: true });
}

async function verifyPreservedTeamTargets(options: ReconcileManagedSkillsOptions, state: ManagedState): Promise<void> {
  const providerRoot = `${providerSkillRoot(options.provider, options.providerSkillRoots)}/`;
  for (const entry of state.skills) {
    if (!entry.key.startsWith("resource:") || !entry.target.startsWith(providerRoot)) continue;
    let actualDigest: `sha256:${string}` | null = null;
    try {
      actualDigest = await digestManagedTarget(
        options.workspace,
        entry.target,
        allowedTargetRootsFromProjection(options.providerSkillRoots),
        {
          modePlatform: options.testModePlatform,
        },
      );
    } catch (error) {
      options.log?.(
        `Preserved Team Skill target cannot be verified (${entry.key}): ${
          error instanceof Error ? error.message.slice(0, 300) : String(error)
        }`,
      );
    }
    if (actualDigest !== entry.installedDigest) {
      await quarantineDriftedManagedTarget(options, entry);
    }
  }
}

async function providerDiscoveryMayContainManagedContent(options: ReconcileManagedSkillsOptions): Promise<boolean> {
  try {
    const providerRoot = resolveWorkspacePath(
      options.workspace,
      providerSkillRoot(options.provider, options.providerSkillRoots),
      "root",
      allowedTargetRootsFromProjection(options.providerSkillRoots),
    );
    const rootStat = await lstat(providerRoot);
    if (!rootStat.isDirectory()) return true;
    return (await readdir(providerRoot)).length > 0;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    // If the discovery root itself cannot be inspected safely, absence of
    // managed content cannot be proven.
    return true;
  }
}

async function managedTargetExistsAfterFailedRemoval(
  workspace: string,
  target: string,
  allowedRoots: ReadonlySet<string>,
): Promise<boolean> {
  try {
    return await pathExists(resolveWorkspacePath(workspace, target, "target", allowedRoots));
  } catch {
    // An unsafe/unresolvable discovery path is not proof that the provider
    // cannot see it, so provider preflight must fail closed.
    return true;
  }
}

async function installStagedSkill(
  options: ReconcileManagedSkillsOptions,
  beforeState: ManagedState,
  staged: StagedManagedSkill,
): Promise<ManagedState> {
  const afterState = replaceEntry(beforeState, staged.entry);
  const targetPath = resolveWorkspacePath(
    options.workspace,
    staged.entry.target,
    "target",
    allowedTargetRootsFromProjection(options.providerSkillRoots),
  );
  const stagingPath = resolveWorkspacePath(
    options.workspace,
    staged.staging,
    "temporary",
    allowedTargetRootsFromProjection(options.providerSkillRoots),
  );
  const backupPath = join(dirname(targetPath), `.${basename(targetPath)}.ft-${randomBytes(8).toString("hex")}.backup`);
  const backup = portableRelative(options.workspace, backupPath);
  const targetExists = await pathExists(targetPath);
  let journal: ManagedSkillsJournal = {
    schemaVersion: 1,
    operationId: randomBytes(16).toString("hex"),
    operation: "install",
    phase: "prepared",
    target: staged.entry.target,
    staging: staged.staging,
    backup: targetExists ? backup : null,
    expectedInstalledDigest: staged.entry.installedDigest,
    beforeState,
    afterState,
  };
  writeManagedSkillsJournal(options.workspace, journal);
  maybeFault(options, "prepared");
  try {
    if (targetExists) {
      await rename(targetPath, backupPath);
      journal = writeJournalPhase(options.workspace, journal, "target_backed_up");
      maybeFault(options, "target_backed_up");
    }
    await rename(stagingPath, targetPath);
    journal = writeJournalPhase(options.workspace, journal, "target_installed");
    maybeFault(options, "target_installed");
    const persisted = persistStateMonotonic(options.workspace, afterState);
    journal = {
      ...journal,
      afterState: persisted,
      phase: "state_committed",
    };
    writeManagedSkillsJournal(options.workspace, journal);
    maybeFault(options, "state_committed");
    if (targetExists) await rm(backupPath, { recursive: true, force: true });
    maybeFault(options, "backup_cleaned");
    clearManagedSkillsJournal(options.workspace);
    return persisted;
  } catch (error) {
    if (error instanceof ManagedSkillsSimulatedCrash) throw error;
    await recoverFailedTransaction(options, "install");
    throw error;
  }
}

async function removeManagedEntry(
  options: ReconcileManagedSkillsOptions,
  beforeState: ManagedState,
  entry: ManagedSkillEntry,
): Promise<ManagedState> {
  assertManagedTarget(entry.target, allowedTargetRootsFromProjection(options.providerSkillRoots));
  const afterState = removeEntry(beforeState, entry);
  const targetPath = resolveWorkspacePath(
    options.workspace,
    entry.target,
    "target",
    allowedTargetRootsFromProjection(options.providerSkillRoots),
  );
  // A previous drift quarantine may have moved the target out of discovery
  // before the process stopped. Clear that one stable, target-derived slot
  // while the ledger entry still exists so a failed cleanup is retried rather
  // than orphaned by authoritative removal.
  await removeManagedTargetQuarantine(
    options.workspace,
    entry.target,
    allowedTargetRootsFromProjection(options.providerSkillRoots),
  );
  if (!(await pathExists(targetPath))) {
    return persistStateMonotonic(options.workspace, afterState);
  }
  const backupPath = join(dirname(targetPath), `.${basename(targetPath)}.ft-${randomBytes(8).toString("hex")}.backup`);
  const backup = portableRelative(options.workspace, backupPath);
  let journal: ManagedSkillsJournal = {
    schemaVersion: 1,
    operationId: randomBytes(16).toString("hex"),
    operation: "remove",
    phase: "prepared",
    target: entry.target,
    staging: null,
    backup,
    expectedInstalledDigest: null,
    beforeState,
    afterState,
  };
  writeManagedSkillsJournal(options.workspace, journal);
  maybeFault(options, "prepared");
  try {
    maybeFault(options, "remove_target");
    await rename(targetPath, backupPath);
    journal = writeJournalPhase(options.workspace, journal, "target_backed_up");
    maybeFault(options, "target_backed_up");
    const persisted = persistStateMonotonic(options.workspace, afterState);
    journal = {
      ...journal,
      afterState: persisted,
      phase: "state_committed",
    };
    writeManagedSkillsJournal(options.workspace, journal);
    maybeFault(options, "state_committed");
    await rm(backupPath, { recursive: true, force: true });
    maybeFault(options, "backup_cleaned");
    clearManagedSkillsJournal(options.workspace);
    return persisted;
  } catch (error) {
    if (error instanceof ManagedSkillsSimulatedCrash) throw error;
    await recoverFailedTransaction(options, "removal");
    throw error;
  }
}

async function recoverFailedTransaction(
  options: ReconcileManagedSkillsOptions,
  operation: "install" | "removal",
): Promise<void> {
  try {
    if (options.testRecoveryFailure) {
      throw new Error("simulated managed skills recovery failure");
    }
    await recoverPendingJournal(options);
    const recovered = readManagedStateResult(options.workspace);
    if (recovered.kind !== "current") {
      throw new Error("managed state unavailable after transaction recovery");
    }
  } catch (error) {
    throw new ManagedSkillsFatalError(
      `managed skills ${operation} recovery failed; reconciliation aborted with journal preserved: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

async function recoverPendingJournal(options: ReconcileManagedSkillsOptions): Promise<void> {
  const { workspace, log } = options;
  const result = readManagedSkillsJournal(workspace);
  if (result.kind === "missing") return;
  if (result.kind === "future") {
    throw new ManagedSkillsFatalError(
      `managed skills journal schema v${result.schemaVersion} is newer than this client`,
    );
  }
  if (result.kind === "invalid") {
    throw new ManagedSkillsFatalError(`managed skills journal is invalid: ${result.reason}`);
  }
  maybeFault(options, "journal_recovery");
  const journal = result.journal;
  assertManagedTarget(journal.target, allowedTargetRootsFromProjection(options.providerSkillRoots));
  if (journal.staging)
    assertTemporaryTarget(journal.staging, ".staging", allowedTargetRootsFromProjection(options.providerSkillRoots));
  if (journal.backup)
    assertTemporaryTarget(journal.backup, ".backup", allowedTargetRootsFromProjection(options.providerSkillRoots));

  const stateResult = readManagedStateResult(workspace);
  if (stateResult.kind === "future" || stateResult.kind === "invalid" || stateResult.kind === "legacy") {
    throw new ManagedSkillsFatalError("cannot recover managed skills journal against an unsafe managed state");
  }
  const currentState = stateResult.kind === "current" ? stateResult.state : journal.beforeState;
  if (currentState.resourceConfigVersion > journal.afterState.resourceConfigVersion) {
    throw new ManagedSkillsFatalError("managed skills journal would cross a newer Team Resource version fence");
  }

  const targetPath = resolveWorkspacePath(
    workspace,
    journal.target,
    "target",
    allowedTargetRootsFromProjection(options.providerSkillRoots),
  );
  const stagingPath = journal.staging
    ? resolveWorkspacePath(
        workspace,
        journal.staging,
        "temporary",
        allowedTargetRootsFromProjection(options.providerSkillRoots),
      )
    : null;
  const backupPath = journal.backup
    ? resolveWorkspacePath(
        workspace,
        journal.backup,
        "temporary",
        allowedTargetRootsFromProjection(options.providerSkillRoots),
      )
    : null;
  const targetExists = await pathExists(targetPath);
  const backupExists = backupPath ? await pathExists(backupPath) : false;

  if (journal.operation === "install") {
    const actualDigest = targetExists
      ? await digestManagedTarget(
          workspace,
          journal.target,
          allowedTargetRootsFromProjection(options.providerSkillRoots),
          { modePlatform: options.testModePlatform },
        )
      : null;
    if (actualDigest === journal.expectedInstalledDigest) {
      persistStateMonotonic(workspace, journal.afterState);
      if (stagingPath) await rm(stagingPath, { recursive: true, force: true });
      if (backupPath) await rm(backupPath, { recursive: true, force: true });
      clearManagedSkillsJournal(workspace);
      log?.(`Managed skills recovered completed install transaction for ${journal.target}`);
      return;
    }
    if (journal.phase === "prepared" && targetExists && !backupExists) {
      persistStateMonotonic(workspace, journal.beforeState);
      if (stagingPath) await rm(stagingPath, { recursive: true, force: true });
      clearManagedSkillsJournal(workspace);
      log?.(`Managed skills discarded prepared install transaction for ${journal.target}`);
      return;
    }
    if (backupExists && backupPath && !targetExists) {
      await rename(backupPath, targetPath);
      persistStateMonotonic(workspace, journal.beforeState);
      if (stagingPath) await rm(stagingPath, { recursive: true, force: true });
      clearManagedSkillsJournal(workspace);
      log?.(`Managed skills rolled back interrupted install transaction for ${journal.target}`);
      return;
    }
    if (!backupExists && !targetExists) {
      persistStateMonotonic(workspace, journal.beforeState);
      if (stagingPath) await rm(stagingPath, { recursive: true, force: true });
      clearManagedSkillsJournal(workspace);
      log?.(`Managed skills discarded uncommitted install transaction for ${journal.target}`);
      return;
    }
    throw new ManagedSkillsFatalError(`cannot safely recover interrupted install for ${journal.target}`);
  }

  const currentMatchesAfter = stateEquivalent(currentState, journal.afterState);
  if (journal.phase === "prepared" && targetExists && !backupExists) {
    persistStateMonotonic(workspace, journal.beforeState);
    clearManagedSkillsJournal(workspace);
    log?.(`Managed skills discarded prepared removal transaction for ${journal.target}`);
    return;
  }
  if (!targetExists && currentMatchesAfter) {
    if (backupPath) await rm(backupPath, { recursive: true, force: true });
    clearManagedSkillsJournal(workspace);
    log?.(`Managed skills completed interrupted removal transaction for ${journal.target}`);
    return;
  }
  if (!targetExists && backupExists && backupPath) {
    await rename(backupPath, targetPath);
    persistStateMonotonic(workspace, journal.beforeState);
    clearManagedSkillsJournal(workspace);
    log?.(`Managed skills rolled back interrupted removal transaction for ${journal.target}`);
    return;
  }
  if (!targetExists && !backupExists && currentMatchesAfter) {
    clearManagedSkillsJournal(workspace);
    return;
  }
  throw new ManagedSkillsFatalError(`cannot safely recover interrupted removal for ${journal.target}`);
}

function persistStateMonotonic(workspace: string, candidate: ManagedState): ManagedState {
  const current = readManagedStateResult(workspace);
  if (current.kind === "future" || current.kind === "invalid" || current.kind === "legacy") {
    throw new ManagedSkillsFatalError("refusing to write managed state over an unsafe schema");
  }
  if (current.kind === "current" && current.state.resourceConfigVersion > candidate.resourceConfigVersion) {
    throw new ManagedSkillsFatalError(
      `refusing to lower Team Resource fence from v${current.state.resourceConfigVersion} ` +
        `to v${candidate.resourceConfigVersion}`,
    );
  }
  return writeManagedState(workspace, candidate);
}

function writeJournalPhase(
  workspace: string,
  journal: ManagedSkillsJournal,
  phase: ManagedSkillsJournalPhase,
): ManagedSkillsJournal {
  const next = { ...journal, phase };
  writeManagedSkillsJournal(workspace, next);
  return next;
}

function maybeFault(options: ReconcileManagedSkillsOptions, checkpoint: ManagedSkillsCheckpoint): void {
  if (options.testCrashAt === checkpoint) {
    throw new ManagedSkillsSimulatedCrash(`simulated managed skills crash at ${checkpoint}`);
  }
  if (options.testFailureAt === checkpoint) {
    throw new Error(`simulated managed skills failure at ${checkpoint}`);
  }
}

async function verifyLedgerTargetsForPublication(
  options: ReconcileManagedSkillsOptions,
  state: ManagedState,
): Promise<
  Readonly<{
    verifiedTargets: ReadonlySet<string>;
    invalidated: readonly ManagedSkillEntry[];
  }>
> {
  const providerRoot = `${providerSkillRoot(options.provider, options.providerSkillRoots)}/`;
  const verifiedTargets = new Set<string>();
  const invalidated: ManagedSkillEntry[] = [];
  for (const entry of state.skills) {
    if (!entry.target.startsWith(providerRoot)) continue;
    let actualDigest: `sha256:${string}` | null = null;
    try {
      actualDigest = await digestManagedTarget(
        options.workspace,
        entry.target,
        allowedTargetRootsFromProjection(options.providerSkillRoots),
        {
          modePlatform: options.testModePlatform,
        },
      );
    } catch (error) {
      options.log?.(
        `Managed skill final publication target cannot be verified (${entry.key}): ${
          error instanceof Error ? error.message.slice(0, 300) : String(error)
        }`,
      );
    }
    if (actualDigest !== entry.installedDigest) {
      await quarantineDriftedManagedTarget(options, entry);
      invalidated.push(entry);
      continue;
    }
    verifiedTargets.add(entry.target);
  }
  return { verifiedTargets, invalidated };
}

function buildReconciledTeamRows(
  state: ManagedState,
  desired: readonly DesiredManagedSkill[],
  successfulTargets: ReadonlyMap<ManagedSkillEntry["key"], string>,
  verifiedTargets: ReadonlySet<string>,
): ReconciledTeamSkill[] {
  const rows: ReconciledTeamSkill[] = [];
  for (const skill of desired) {
    if (skill.kind !== "team") continue;
    const target = successfulTargets.get(skill.key);
    if (!target || !verifiedTargets.has(target)) continue;
    const entry = state.skills.find(
      (candidate) =>
        candidate.key === skill.key && candidate.target === target && candidate.revision === skill.revision,
    );
    if (!entry) continue;
    rows.push({
      key: skill.key as `resource:${string}`,
      name: entry.effectiveName,
      requestedSlug: entry.requestedSlug,
      description: skill.description,
      target,
      revision: entry.revision,
      installedDigest: entry.installedDigest,
    });
  }
  return rows;
}

/**
 * The complete command registry for an authoritative reconcile: every
 * desired Team Skill's base slug paired with its verified effective name,
 * or null when no verified target exists (failed install, quarantine, or
 * publication invalidation). Desired rows without a usable base slug
 * (validation failures carry an empty requestedSlug) never had a typable
 * command and are omitted.
 */
function buildTeamSkillCommandEntries(
  desired: readonly DesiredManagedSkill[],
  teamSkills: readonly ReconciledTeamSkill[],
): ReconciledTeamSkillCommand[] {
  const effectiveByKey = new Map<string, string>(teamSkills.map((skill) => [skill.key, skill.name]));
  const entries: ReconciledTeamSkillCommand[] = [];
  for (const skill of desired) {
    if (skill.kind !== "team" || !skill.requestedSlug) continue;
    const resourceId = skill.key.startsWith("resource:") ? skill.key.slice("resource:".length) : null;
    if (resourceId === null) continue;
    entries.push({
      requestedSlug: skill.requestedSlug,
      resourceId,
      effectiveName: effectiveByKey.get(skill.key) ?? null,
    });
  }
  return entries;
}

async function writeInlineSkillTree(stagingPath: string, allocated: AllocatedManagedSkill): Promise<void> {
  if (allocated.desired.source.kind !== "inline-skill") {
    throw new Error("inline Skill staging requires an inline source");
  }
  const skill = allocated.desired.source.skill;
  const metadata = stableJson(skill.metadata);
  const markdown = [
    "---",
    `name: ${JSON.stringify(allocated.effectiveName)}`,
    `description: ${JSON.stringify(skill.description || "No description")}`,
    `metadata: ${metadata}`,
    "---",
    "",
    skill.body,
    "",
  ].join("\n");
  await writeFile(join(stagingPath, "SKILL.md"), markdown, { encoding: "utf-8", mode: 0o600 });
  await writeFile(join(stagingPath, "VERSION"), `${allocated.desired.revision}\n`, {
    encoding: "utf-8",
    mode: 0o600,
  });
}

async function writeOwnershipMarker(
  stagingPath: string,
  key: ManagedSkillEntry["key"],
  revision: string,
): Promise<void> {
  await writeFile(join(stagingPath, OWNERSHIP_MARKER), ownershipMarkerContent(key, revision), {
    encoding: "utf-8",
    mode: 0o600,
  });
}

function ownershipMarkerContent(key: ManagedSkillEntry["key"], revision: string): string {
  return `${JSON.stringify({ schemaVersion: 1, key, revision }, null, 2)}\n`;
}

async function readOwnershipMarker(
  workspace: string,
  target: string,
  allowedRoots: ReadonlySet<string>,
): Promise<Readonly<{ key: ManagedSkillEntry["key"]; revision: string }> | null> {
  try {
    const raw: unknown = JSON.parse(
      await readFile(join(resolveWorkspacePath(workspace, target, "target", allowedRoots), OWNERSHIP_MARKER), "utf-8"),
    );
    if (!isRecord(raw) || raw.schemaVersion !== 1 || typeof raw.key !== "string" || typeof raw.revision !== "string") {
      return null;
    }
    if (!raw.key.startsWith("core:") && !raw.key.startsWith("resource:")) return null;
    return {
      // The prefix checks above narrow the runtime value to the persisted key contract.
      key: raw.key as ManagedSkillEntry["key"],
      revision: raw.revision,
    };
  } catch {
    return null;
  }
}

async function targetMarkerMatches(
  workspace: string,
  target: string,
  key: ManagedSkillEntry["key"],
  allowedRoots: ReadonlySet<string>,
): Promise<boolean> {
  return (await readOwnershipMarker(workspace, target, allowedRoots))?.key === key;
}

async function validateSkillManifest(
  stagingPath: string,
  expectedName: string,
): Promise<Readonly<{ name: string; description: string }>> {
  const raw = await readFile(join(stagingPath, "SKILL.md"));
  let markdown: string;
  try {
    markdown = new TextDecoder("utf-8", { fatal: true }).decode(raw);
  } catch {
    throw new Error("SKILL.md must be valid UTF-8");
  }
  const parsed = parseStrictTeamSkillMarkdown(markdown).frontmatter;
  if (!isRecord(parsed) || typeof parsed.name !== "string" || typeof parsed.description !== "string") {
    throw new Error("SKILL.md frontmatter requires string name and description");
  }
  if (parsed.name !== expectedName) {
    throw new Error(`SKILL.md name "${parsed.name}" does not match effective name "${expectedName}"`);
  }
  if (parsed.description.trim().length === 0) throw new Error("SKILL.md description must not be empty");
  return { name: parsed.name, description: parsed.description };
}

type ZipSkillEntry = Readonly<{
  sourcePath: string;
  targetPath: string;
  kind: "directory" | "file";
  mode: number;
  size: number;
}>;

async function extractSkillZip(bytes: Buffer, destinationRoot: string): Promise<void> {
  const entries = await inspectSkillZip(bytes);
  const bySourcePath = new Map(entries.map((entry) => [entry.sourcePath, entry]));
  const zipFile = await openZipBuffer(bytes);
  try {
    await forEachZipEntry(zipFile, async (zipEntry) => {
      const planned = bySourcePath.get(zipEntry.fileName);
      if (!planned) throw new Error(`Skill ZIP changed while extracting: ${zipEntry.fileName}`);
      if (!planned.targetPath) return;
      const targetPath = join(destinationRoot, ...planned.targetPath.split("/"));
      if (planned.kind === "directory") {
        await mkdir(targetPath, { recursive: true, mode: planned.mode });
        await chmod(targetPath, planned.mode);
        return;
      }
      await mkdir(dirname(targetPath), { recursive: true, mode: 0o700 });
      await writeZipEntry(zipFile, zipEntry, targetPath, planned.mode, planned.size);
    });
  } finally {
    zipFile.close();
  }
}

async function inspectSkillZip(bytes: Buffer): Promise<ZipSkillEntry[]> {
  const zipFile = await openZipBuffer(bytes);
  const rawEntries: Array<
    Readonly<{
      sourcePath: string;
      normalizedPath: string;
      kind: "directory" | "file";
      mode: number;
      size: number;
    }>
  > = [];
  const seenRawPaths = new Set<string>();
  let entryCount = 0;
  let fileCount = 0;
  let totalBytes = 0;
  try {
    await forEachZipEntry(zipFile, async (entry) => {
      const normalizedPath = validateZipEntryPath(entry.fileName);
      entryCount++;
      if (entryCount > TEAM_SKILL_BUNDLE_LIMITS.maxEntries) {
        throw new Error(`Skill ZIP exceeds max entry count ${TEAM_SKILL_BUNDLE_LIMITS.maxEntries}`);
      }
      const folded = foldPortableTeamSkillPath(normalizedPath);
      if (seenRawPaths.has(folded)) {
        throw new Error(`Skill ZIP contains a duplicate case-folded path: ${normalizedPath}`);
      }
      seenRawPaths.add(folded);
      if ((entry.generalPurposeBitFlag & 0x1) !== 0) {
        throw new Error(`Skill ZIP contains an encrypted entry: ${normalizedPath}`);
      }
      const kind = zipEntryKind(entry, normalizedPath);
      const size = entry.uncompressedSize;
      if (!Number.isSafeInteger(size) || size < 0) {
        throw new Error(`Skill ZIP entry has an invalid size: ${normalizedPath}`);
      }
      if (kind === "directory" && size !== 0) {
        throw new Error(`Skill ZIP directory entry contains data: ${normalizedPath}`);
      }
      if (kind === "file") {
        fileCount++;
        totalBytes += size;
        if (fileCount > TEAM_SKILL_BUNDLE_LIMITS.maxFiles) {
          throw new Error(`Skill ZIP exceeds max file count ${TEAM_SKILL_BUNDLE_LIMITS.maxFiles}`);
        }
        if (size > TEAM_SKILL_BUNDLE_LIMITS.maxUncompressedBytes) {
          throw new Error(
            `Skill ZIP file exceeds max size ${TEAM_SKILL_BUNDLE_LIMITS.maxUncompressedBytes}: ${normalizedPath}`,
          );
        }
        if (totalBytes > TEAM_SKILL_BUNDLE_LIMITS.maxUncompressedBytes) {
          throw new Error(`Skill ZIP exceeds max total bytes ${TEAM_SKILL_BUNDLE_LIMITS.maxUncompressedBytes}`);
        }
        if (
          basename(normalizedPath).toLocaleLowerCase("en-US") === "skill.md" &&
          size > TEAM_SKILL_BUNDLE_LIMITS.maxSkillMarkdownBytes
        ) {
          throw new Error(`SKILL.md exceeds max size ${TEAM_SKILL_BUNDLE_LIMITS.maxSkillMarkdownBytes}`);
        }
      }
      rawEntries.push({
        sourcePath: entry.fileName,
        normalizedPath,
        kind,
        mode: safeZipMode(entry, kind),
        size,
      });
    });
  } finally {
    zipFile.close();
  }

  const manifestEntries = rawEntries.filter(
    (entry) => entry.kind === "file" && basename(entry.normalizedPath).toLocaleLowerCase("en-US") === "skill.md",
  );
  if (manifestEntries.length !== 1) {
    throw new Error("Skill ZIP must contain exactly one SKILL.md");
  }
  const manifest = manifestEntries[0];
  if (!manifest) throw new Error("Skill ZIP must contain SKILL.md");
  const manifestSegments = manifest.normalizedPath.split("/");
  if (manifestSegments.length > 2 || manifestSegments.at(-1) !== "SKILL.md") {
    throw new Error("SKILL.md must be at the ZIP root or inside one top-level directory");
  }
  const wrapper = manifestSegments.length === 2 ? manifestSegments[0] : null;
  if (
    wrapper &&
    rawEntries.some((entry) => entry.normalizedPath !== wrapper && !entry.normalizedPath.startsWith(`${wrapper}/`))
  ) {
    throw new Error("A wrapped Skill ZIP cannot contain files outside its top-level directory");
  }
  if (wrapper && rawEntries.some((entry) => entry.normalizedPath === wrapper && entry.kind !== "directory")) {
    throw new Error("A wrapped Skill ZIP anchor must be a directory");
  }

  const planned: ZipSkillEntry[] = [];
  const outputKinds = new Map<string, "directory" | "file">();
  const canonicalOutputPaths = new Map<string, string>();
  for (const entry of rawEntries) {
    const targetPath = wrapper
      ? entry.normalizedPath === wrapper
        ? ""
        : entry.normalizedPath.slice(wrapper.length + 1)
      : entry.normalizedPath;
    if (!targetPath) {
      planned.push({ ...entry, targetPath });
      continue;
    }
    const segments = targetPath.split("/");
    const portableError = getPortableTeamSkillRelativePathError(targetPath, entry.kind);
    if (portableError) {
      throw new Error(`Skill ZIP contains ${portableError}`);
    }
    if (foldPortableTeamSkillPath(segments[0] ?? "") === foldPortableTeamSkillPath(OWNERSHIP_MARKER)) {
      throw new Error(`Skill ZIP may not provide reserved file ${OWNERSHIP_MARKER}`);
    }
    const spellingCollision = recordPortableTeamSkillPath(canonicalOutputPaths, targetPath);
    if (spellingCollision) {
      throw new Error(`Skill ZIP contains ${spellingCollision}`);
    }
    const folded = foldPortableTeamSkillPath(targetPath);
    if (outputKinds.has(folded)) {
      throw new Error(`Skill ZIP contains a duplicate extracted path: ${targetPath}`);
    }
    outputKinds.set(folded, entry.kind);
    planned.push({ ...entry, targetPath });
  }

  for (const entry of planned) {
    if (!entry.targetPath) continue;
    const segments = entry.targetPath.split("/");
    for (let index = 1; index < segments.length; index++) {
      const ancestor = foldPortableTeamSkillPath(segments.slice(0, index).join("/"));
      if (outputKinds.get(ancestor) === "file") {
        throw new Error(`Skill ZIP file is used as a directory: ${entry.targetPath}`);
      }
    }
  }
  return planned;
}

function validateZipEntryPath(raw: string): string {
  if (!raw || raw.includes("\0") || raw.includes("\\")) {
    throw new Error("Skill ZIP contains an invalid path");
  }
  if (raw.startsWith("/") || /^[A-Za-z]:/.test(raw)) {
    throw new Error(`Skill ZIP contains an absolute path: ${raw}`);
  }
  const normalized = raw.endsWith("/") ? raw.slice(0, -1) : raw;
  const segments = normalized.split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === "..")) {
    throw new Error(`Skill ZIP contains an unsafe path: ${raw}`);
  }
  for (const segment of segments) {
    const portableError = getPortableTeamSkillSegmentError(segment);
    if (portableError) throw new Error(`Skill ZIP contains ${portableError}`);
  }
  return normalized;
}

function zipEntryKind(entry: Entry, normalizedPath: string): "directory" | "file" {
  const unixMode = entry.versionMadeBy >>> 8 === 3 ? entry.externalFileAttributes >>> 16 : 0;
  const unixType = unixMode & 0o170000;
  if (unixType === 0o120000) throw new Error(`Skill ZIP cannot contain symlinks: ${normalizedPath}`);
  if (unixType !== 0 && unixType !== 0o040000 && unixType !== 0o100000) {
    throw new Error(`Skill ZIP cannot contain special files: ${normalizedPath}`);
  }
  const directory = entry.fileName.endsWith("/");
  if (unixType === 0o040000 && !directory) {
    throw new Error(`Skill ZIP directory entry must end with '/': ${normalizedPath}`);
  }
  if (unixType === 0o100000 && directory) {
    throw new Error(`Skill ZIP regular file entry cannot end with '/': ${normalizedPath}`);
  }
  return directory || unixType === 0o040000 ? "directory" : "file";
}

function safeZipMode(entry: Entry, kind: "directory" | "file"): number {
  if (entry.versionMadeBy >>> 8 !== 3) return kind === "directory" ? 0o700 : 0o600;
  const mode = (entry.externalFileAttributes >>> 16) & 0o777;
  // Keep safe read/execute intent while ensuring the owning Client can finish
  // staging and never accepting group/other write bits from an uploaded ZIP.
  if (kind === "directory") return 0o700 | (mode & 0o055);
  const ownerExecute = (mode & 0o111) !== 0 ? 0o100 : 0;
  return 0o600 | ownerExecute | (mode & 0o055);
}

function openZipBuffer(bytes: Buffer): Promise<ZipFile> {
  return new Promise((resolvePromise, reject) => {
    yauzl.fromBuffer(
      bytes,
      { lazyEntries: true, strictFileNames: true, validateEntrySizes: true },
      (error, zipFile) => {
        if (error || !zipFile) reject(error ?? new Error("Unable to open Skill ZIP"));
        else resolvePromise(zipFile);
      },
    );
  });
}

function forEachZipEntry(zipFile: ZipFile, visit: (entry: Entry) => Promise<void>): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    let settled = false;
    const fail = (error: unknown): void => {
      if (settled) return;
      settled = true;
      reject(error);
    };
    zipFile.once("error", fail);
    zipFile.once("end", () => {
      if (settled) return;
      settled = true;
      resolvePromise();
    });
    zipFile.on("entry", (entry) => {
      void visit(entry).then(
        () => zipFile.readEntry(),
        (error) => {
          zipFile.close();
          fail(error);
        },
      );
    });
    zipFile.readEntry();
  });
}

async function writeZipEntry(
  zipFile: ZipFile,
  entry: Entry,
  targetPath: string,
  mode: number,
  expectedSize: number,
): Promise<void> {
  const stream = await new Promise<NodeJS.ReadableStream>((resolvePromise, reject) => {
    zipFile.openReadStream(entry, (error, readable) => {
      if (error || !readable) reject(error ?? new Error(`Unable to read ${entry.fileName}`));
      else resolvePromise(readable);
    });
  });
  let measured = 0;
  const meter = new Transform({
    transform(chunk: Buffer | Uint8Array, _encoding, callback) {
      const size = Buffer.isBuffer(chunk) ? chunk.byteLength : Buffer.from(chunk).byteLength;
      measured += size;
      if (measured > expectedSize || measured > TEAM_SKILL_BUNDLE_LIMITS.maxUncompressedBytes) {
        callback(new Error(`Skill ZIP entry size is invalid: ${entry.fileName}`));
        return;
      }
      callback(null, chunk);
    },
  });
  await pipeline(stream, meter, createWriteStream(targetPath, { flags: "wx", mode }));
  if (measured !== expectedSize) {
    throw new Error(`Skill ZIP entry size is invalid: ${entry.fileName}`);
  }
  await chmod(targetPath, mode);
}

async function rewriteSkillManifestName(stagingPath: string, effectiveName: string): Promise<void> {
  const path = join(stagingPath, "SKILL.md");
  const raw = await readFile(path);
  let markdown: string;
  try {
    markdown = new TextDecoder("utf-8", { fatal: true }).decode(raw);
  } catch {
    throw new Error("SKILL.md must be valid UTF-8");
  }
  const match = /^(---\r?\n)([\s\S]*?)(\r?\n---(?:\r?\n|$))/.exec(markdown);
  if (!match?.[2]) throw new Error("SKILL.md must contain YAML frontmatter");
  const document = parseDocument(match[2]);
  if (document.errors.length > 0) {
    throw new Error(`SKILL.md frontmatter is invalid: ${document.errors[0]?.message ?? "unknown error"}`);
  }
  document.set("name", effectiveName);
  const frontmatter = document.toString().trimEnd();
  const rewritten = `${match[1]}${frontmatter}${match[3]}${markdown.slice(match[0].length)}`;
  await writeFile(path, rewritten, { encoding: "utf-8", mode: 0o600 });
}

async function copySanitizedSkillTree(sourceRoot: string, destinationRoot: string): Promise<void> {
  const sourceStat = await lstat(sourceRoot);
  if (!sourceStat.isDirectory()) throw new Error(`bundled Skill source is not a directory: ${sourceRoot}`);
  const stats: SkillTreeStats = { files: 0, bytes: 0 };
  await copySanitizedDirectory(sourceRoot, destinationRoot, "", 0, stats);
}

async function copySanitizedDirectory(
  sourceRoot: string,
  destinationRoot: string,
  relativeDir: string,
  depth: number,
  treeStats: SkillTreeStats,
): Promise<void> {
  if (depth > MAX_SKILL_DEPTH) throw new Error(`Skill bundle exceeds max directory depth ${MAX_SKILL_DEPTH}`);
  const sourceDir = relativeDir ? join(sourceRoot, ...relativeDir.split("/")) : sourceRoot;
  const destinationDir = relativeDir ? join(destinationRoot, ...relativeDir.split("/")) : destinationRoot;
  await mkdir(destinationDir, { recursive: true, mode: 0o700 });
  await chmod(destinationDir, 0o700);
  const entries = (await readdir(sourceDir, { withFileTypes: true })).sort((left, right) =>
    left.name.localeCompare(right.name),
  );
  const caseInsensitiveNames = new Set<string>();
  for (const entry of entries) {
    const folded = foldPortableTeamSkillPath(entry.name);
    if (caseInsensitiveNames.has(folded)) {
      throw new Error(`Skill bundle contains a case-insensitive path collision at ${relativeDir || "."}`);
    }
    caseInsensitiveNames.add(folded);
    if (getPortableTeamSkillSegmentError(entry.name)) {
      throw new Error(`Skill bundle contains an unsafe path segment: ${entry.name}`);
    }
    if (!relativeDir && entry.name === OWNERSHIP_MARKER) {
      throw new Error(`Skill bundle may not provide reserved file ${OWNERSHIP_MARKER}`);
    }
    const relativePath = relativeDir ? `${relativeDir}/${entry.name}` : entry.name;
    const sourcePath = join(sourceDir, entry.name);
    const destinationPath = join(destinationDir, entry.name);
    const entryStat = await lstat(sourcePath);
    if (entryStat.isSymbolicLink()) throw new Error(`Skill bundle symlinks are not allowed: ${relativePath}`);
    if (entryStat.isDirectory()) {
      await copySanitizedDirectory(sourceRoot, destinationRoot, relativePath, depth + 1, treeStats);
      continue;
    }
    if (!entryStat.isFile()) throw new Error(`Skill bundle special files are not allowed: ${relativePath}`);
    treeStats.files++;
    treeStats.bytes += entryStat.size;
    if (treeStats.files > MAX_SKILL_FILES) throw new Error(`Skill bundle exceeds max file count ${MAX_SKILL_FILES}`);
    if (entryStat.size > MAX_SKILL_FILE_BYTES) {
      throw new Error(`Skill bundle file exceeds max size ${MAX_SKILL_FILE_BYTES}: ${relativePath}`);
    }
    if (treeStats.bytes > MAX_SKILL_TOTAL_BYTES) {
      throw new Error(`Skill bundle exceeds max total bytes ${MAX_SKILL_TOTAL_BYTES}`);
    }
    const content = await readFile(sourcePath);
    const mode = normalizedBundledFileMode(entryStat.mode);
    await writeFile(destinationPath, content, { mode });
    await chmod(destinationPath, mode);
  }
}

async function digestManagedTarget(
  workspace: string,
  target: string,
  allowedRoots: ReadonlySet<string>,
  options?: Readonly<{
    followExpectedLegacySymlink?: boolean;
    modePlatform?: NodeJS.Platform;
    modePolicy?: SkillTreeModePolicy;
  }>,
): Promise<`sha256:${string}` | null> {
  assertManagedTarget(target, allowedRoots);
  const path = resolveWorkspacePath(workspace, target, "target", allowedRoots);
  const modePolicy = options?.modePolicy ?? "enforce-safe";
  try {
    const targetStat = await lstat(path);
    if (targetStat.isDirectory()) return await digestDirectory(path, options?.modePlatform, modePolicy);
    if (targetStat.isSymbolicLink() && options?.followExpectedLegacySymlink) {
      const linked = resolve(dirname(path), await readlink(path));
      const [workspaceRealPath, linkedRealPath] = await Promise.all([realpath(workspace), realpath(linked)]);
      if (linkedRealPath !== workspaceRealPath && !linkedRealPath.startsWith(`${workspaceRealPath}${sep}`)) {
        return null;
      }
      const linkedStat = await stat(linkedRealPath);
      if (!linkedStat.isDirectory()) return null;
      return await digestDirectory(linkedRealPath, options?.modePlatform, modePolicy);
    }
    return null;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`Managed Skill target ${target} cannot be digested: ${reason}`, { cause: error });
  }
}

async function digestDirectoryIfPresent(
  path: string,
  modePlatform?: NodeJS.Platform,
  modePolicy: SkillTreeModePolicy = "enforce-safe",
): Promise<`sha256:${string}` | null> {
  try {
    const pathStat = await lstat(path);
    if (!pathStat.isDirectory()) return null;
    return await digestDirectory(path, modePlatform, modePolicy);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

async function digestDirectory(
  root: string,
  modePlatform: NodeJS.Platform = process.platform,
  modePolicy: SkillTreeModePolicy = "enforce-safe",
): Promise<`sha256:${string}`> {
  const hash = createHash("sha256");
  await hashDirectoryRecursive(root, "", hash, 0, { files: 0, bytes: 0 }, null, modePlatform, modePolicy);
  return `sha256:${hash.digest("hex")}`;
}

async function digestBundledFinalTree(
  root: string,
  key: ManagedSkillEntry["key"],
  revision: string,
  modePlatform: NodeJS.Platform = process.platform,
): Promise<`sha256:${string}`> {
  const hash = createHash("sha256");
  await hashDirectoryRecursive(
    root,
    "",
    hash,
    0,
    { files: 0, bytes: 0 },
    {
      name: OWNERSHIP_MARKER,
      content: Buffer.from(ownershipMarkerContent(key, revision), "utf-8"),
      mode: 0o600,
    },
    modePlatform,
    "normalize-bundled",
  );
  return `sha256:${hash.digest("hex")}`;
}

async function hashDirectoryRecursive(
  root: string,
  relativeDir: string,
  hash: ReturnType<typeof createHash>,
  depth: number,
  treeStats: SkillTreeStats,
  virtualRootFile: Readonly<{ name: string; content: Buffer; mode: number }> | null,
  modePlatform: NodeJS.Platform,
  modePolicy: SkillTreeModePolicy,
): Promise<void> {
  if (depth > MAX_SKILL_DEPTH) throw new Error(`Skill tree exceeds max directory depth ${MAX_SKILL_DEPTH}`);
  const directory = relativeDir ? join(root, ...relativeDir.split("/")) : root;
  const directoryStat = await lstat(directory);
  if (!directoryStat.isDirectory()) throw new Error(`Skill tree directory is not a directory: ${relativeDir || "."}`);
  if (modePolicy === "enforce-safe") {
    assertManagedTreeModeSafe(directoryStat.mode, "directory", relativeDir || ".", modePlatform);
  }
  const entries = await readdir(directory, { withFileTypes: true });
  const entryByName = new Map(entries.map((entry) => [entry.name, entry]));
  const names = entries.map((entry) => entry.name);
  if (!relativeDir && virtualRootFile) names.push(virtualRootFile.name);
  names.sort((left, right) => left.localeCompare(right));
  const caseInsensitiveNames = new Set<string>();
  for (const name of names) {
    const folded = foldPortableTeamSkillPath(name);
    if (caseInsensitiveNames.has(folded)) {
      throw new Error(`Skill tree contains a case-insensitive path collision at ${relativeDir || "."}`);
    }
    caseInsensitiveNames.add(folded);
    const relativePath = relativeDir ? `${relativeDir}/${name}` : name;
    if (!relativeDir && virtualRootFile?.name === name && !entryByName.has(name)) {
      const mode =
        modePolicy === "normalize-bundled" ? normalizedBundledFileMode(virtualRootFile.mode) : virtualRootFile.mode;
      if (modePolicy === "enforce-safe") {
        assertManagedTreeModeSafe(mode, "file", relativePath, modePlatform);
      }
      treeStats.files++;
      treeStats.bytes += virtualRootFile.content.byteLength;
      if (
        treeStats.files > MAX_SKILL_FILES ||
        treeStats.bytes > MAX_SKILL_TOTAL_BYTES ||
        virtualRootFile.content.byteLength > MAX_SKILL_FILE_BYTES
      ) {
        throw new Error(`Skill tree exceeds configured bundle limits at ${relativePath}`);
      }
      hash.update(`file\0${relativePath}\0${mode & 0o111}\0${virtualRootFile.content.byteLength}\0`);
      hash.update(virtualRootFile.content);
      hash.update("\0");
      continue;
    }
    const entry = entryByName.get(name);
    if (!entry) throw new Error(`Skill tree entry disappeared while hashing: ${relativePath}`);
    const path = join(directory, name);
    const entryStat = await lstat(path);
    if (entryStat.isSymbolicLink()) throw new Error(`Skill tree symlinks are not allowed: ${relativePath}`);
    if (entryStat.isDirectory()) {
      hash.update(`directory\0${relativePath}\0`);
      await hashDirectoryRecursive(
        root,
        relativePath,
        hash,
        depth + 1,
        treeStats,
        virtualRootFile,
        modePlatform,
        modePolicy,
      );
      continue;
    }
    if (!entryStat.isFile()) throw new Error(`Skill tree special files are not allowed: ${relativePath}`);
    const mode = modePolicy === "normalize-bundled" ? normalizedBundledFileMode(entryStat.mode) : entryStat.mode;
    if (modePolicy === "enforce-safe") {
      assertManagedTreeModeSafe(mode, "file", relativePath, modePlatform);
    }
    treeStats.files++;
    treeStats.bytes += entryStat.size;
    if (
      treeStats.files > MAX_SKILL_FILES ||
      treeStats.bytes > MAX_SKILL_TOTAL_BYTES ||
      entryStat.size > MAX_SKILL_FILE_BYTES
    ) {
      throw new Error(`Skill tree exceeds configured bundle limits at ${relativePath}`);
    }
    hash.update(`file\0${relativePath}\0${mode & 0o111}\0${entryStat.size}\0`);
    hash.update(await readFile(path));
    hash.update("\0");
  }
}

function normalizedBundledFileMode(mode: number): number {
  // npm materializes package data with the ambient umask, so the same
  // published Core Skill may arrive as 0644/0755 or 0664/0775. Package-source
  // write bits are not part of the Skill contract; provider discovery is.
  // Project a deterministic owner-only mode while retaining executability.
  return (mode & 0o111) === 0 ? 0o600 : 0o700;
}

function assertManagedTreeModeSafe(
  mode: number,
  kind: "directory" | "file",
  relativePath: string,
  platform: NodeJS.Platform,
): void {
  if (hasUnsafeManagedWriteMode(mode, platform)) {
    throw new Error(`Skill tree ${kind} has unsafe group/other write permissions: ${relativePath}`);
  }
}

export function hasUnsafeManagedWriteMode(mode: number, platform: NodeJS.Platform = process.platform): boolean {
  // Windows reports synthesized POSIX bits (commonly 0666) that do not
  // represent ACL group/other write authority. Enforce this drift gate only
  // where Node exposes meaningful POSIX permission bits.
  return platform !== "win32" && (mode & 0o022) !== 0;
}

function isSafeSkillName(name: string): boolean {
  if (name.length === 0 || name.length > TEAM_SKILL_BUNDLE_LIMITS.maxTargetNameLength) return false;
  if (name === "." || name === ".." || WINDOWS_RESERVED_NAMES.has(name.toLocaleLowerCase("en-US"))) return false;
  return /^[a-z0-9][a-z0-9-]*$/.test(name);
}

function suffixSkillName(base: string, suffix: string): string {
  const trimmed = base.slice(0, TEAM_SKILL_BUNDLE_LIMITS.maxTargetNameLength - suffix.length).replace(/-+$/g, "");
  const result = `${trimmed}${suffix}`;
  if (!isSafeSkillName(result)) throw new Error(`cannot allocate safe suffixed Skill name for ${base}`);
  return result;
}

function teamSkillSource(skill: RuntimeResourceSkill): DesiredManagedSkill["source"] {
  return skill.bundle
    ? {
        kind: "attachment-zip",
        bundle: skill.bundle,
        manifestName: skill.name,
      }
    : { kind: "inline-skill", skill };
}

function teamSkillRevision(skill: RuntimeResourceSkill): string {
  return skill.bundle
    ? `attachment:${skill.bundle.attachmentId}:${skill.bundle.sizeBytes}`
    : inlineSkillRevision(skill);
}

function inlineSkillRevision(skill: RuntimeResourceSkill): string {
  return `sha256:${createHash("sha256").update(stableJson(skill)).digest("hex")}`;
}

function stableJson(value: unknown): string {
  const serialized = JSON.stringify(sortJsonValue(value));
  if (serialized === undefined) throw new Error("Skill metadata is not JSON-serializable");
  return serialized;
}

function sortJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJsonValue);
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, nested]) => [key, sortJsonValue(nested)]),
  );
}

async function readRequiredVersion(sourcePath: string, name: string): Promise<string> {
  let version: string;
  try {
    version = (await readFile(join(sourcePath, "VERSION"), "utf-8")).trim();
  } catch (error) {
    throw new Error(`bundled Core Skill ${name} is missing VERSION: ${error instanceof Error ? error.message : error}`);
  }
  if (!version) throw new Error(`bundled Core Skill ${name} has an empty VERSION`);
  return version;
}

function buildLegacyResourceSkillMarkdown(skill: RuntimeResourceSkill): string {
  const metadata = Object.keys(skill.metadata).length > 0 ? JSON.stringify(skill.metadata) : "{}";
  return [
    "---",
    `name: ${JSON.stringify(skill.name)}`,
    `description: ${JSON.stringify(skill.description)}`,
    `metadata: ${metadata}`,
    "---",
    "",
    skill.body,
    "",
  ].join("\n");
}

function replaceEntry(state: ManagedState, entry: ManagedSkillEntry): ManagedState {
  return {
    ...state,
    skills: [
      ...state.skills.filter((candidate) => !(candidate.key === entry.key && candidate.target === entry.target)),
      entry,
    ],
  };
}

function removeEntry(state: ManagedState, entry: ManagedSkillEntry): ManagedState {
  return {
    ...state,
    skills: state.skills.filter((candidate) => !(candidate.key === entry.key && candidate.target === entry.target)),
  };
}

function stateEquivalent(left: ManagedState, right: ManagedState): boolean {
  if (left.resourceConfigVersion !== right.resourceConfigVersion) return false;
  const normalize = (state: ManagedState): string =>
    JSON.stringify(
      [...state.skills].sort(
        (leftEntry, rightEntry) =>
          leftEntry.key.localeCompare(rightEntry.key) || leftEntry.target.localeCompare(rightEntry.target),
      ),
    );
  return normalize(left) === normalize(right);
}

function assertManagedTarget(target: string, allowedRoots: ReadonlySet<string>): void {
  const parts = target.split("/");
  if (parts.some((part) => !part || part === "." || part === ".." || part.includes("\\") || part.includes("\0"))) {
    throw new ManagedSkillsFatalError(`unsafe managed Skill target: ${target}`);
  }
  const root = parts.slice(0, -1).join("/");
  if (!allowedRoots.has(root) || parts.length < 3) {
    throw new ManagedSkillsFatalError(`managed Skill target is outside allowed roots: ${target}`);
  }
}

function assertTemporaryTarget(
  target: string,
  suffix: ".staging" | ".backup",
  allowedRoots: ReadonlySet<string>,
): void {
  const parts = target.split("/");
  const root = parts.slice(0, -1).join("/");
  const name = parts.at(-1) ?? "";
  if (!allowedRoots.has(root) || !name.startsWith(".") || !name.includes(".ft-") || !name.endsWith(suffix)) {
    throw new ManagedSkillsFatalError(`unsafe managed Skill transaction path: ${target}`);
  }
}

function assertManagedWorkspaceRootsSafe(workspace: string, allowedRoots: ReadonlySet<string>): void {
  resolveWorkspacePath(workspace, toPortablePath(MANAGED_SKILLS_LOCK_REL), "lock", allowedRoots);
  for (const root of allowedRoots) {
    resolveWorkspacePath(workspace, root, "root", allowedRoots);
  }
}

function resolveWorkspacePath(
  workspace: string,
  portablePath: string,
  kind: "target" | "temporary" | "lock" | "root" | "legacy-resource-file" | "quarantine",
  allowedRoots: ReadonlySet<string>,
): string {
  if (kind === "target") assertManagedTarget(portablePath, allowedRoots);
  if (kind === "quarantine") {
    const parts = portablePath.split("/");
    if (
      parts.length !== 2 ||
      parts[0] !== ".first-tree-workspace" ||
      !parts[1]?.startsWith(MANAGED_SKILLS_QUARANTINE_PREFIX)
    ) {
      throw new ManagedSkillsFatalError(`unsafe managed Skill quarantine path: ${portablePath}`);
    }
  }
  if (kind === "temporary") {
    if (portablePath.endsWith(".staging")) assertTemporaryTarget(portablePath, ".staging", allowedRoots);
    else assertTemporaryTarget(portablePath, ".backup", allowedRoots);
  }
  const workspaceRoot = realpathSync(resolve(workspace));
  if (!lstatSync(workspaceRoot).isDirectory()) {
    throw new ManagedSkillsFatalError(`managed skills workspace is not a directory: ${workspace}`);
  }
  const absolute = resolve(workspaceRoot, ...portablePath.split("/"));
  if (absolute !== workspaceRoot && !absolute.startsWith(`${workspaceRoot}${sep}`)) {
    throw new ManagedSkillsFatalError(`${kind} path escapes workspace: ${portablePath}`);
  }
  assertExistingPathChainIsDirectory(
    workspaceRoot,
    absolute,
    kind === "root" || kind === "temporary" || kind === "quarantine",
    kind,
    portablePath,
  );
  return absolute;
}

function assertExistingPathChainIsDirectory(
  workspaceRoot: string,
  absolutePath: string,
  includeLeaf: boolean,
  kind: string,
  portablePath: string,
): void {
  const relativePath = relative(workspaceRoot, absolutePath);
  const segments = relativePath.split(sep).filter(Boolean);
  const checkedSegments = includeLeaf ? segments : segments.slice(0, -1);
  let current = workspaceRoot;
  for (const segment of checkedSegments) {
    current = join(current, segment);
    let currentStats: ReturnType<typeof lstatSync>;
    try {
      currentStats = lstatSync(current);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    if (currentStats.isSymbolicLink()) {
      throw new ManagedSkillsFatalError(`${kind} path has a symlinked managed ancestor: ${portablePath}`);
    }
    if (!currentStats.isDirectory()) {
      throw new ManagedSkillsFatalError(`${kind} path has a non-directory managed ancestor: ${portablePath}`);
    }
  }
}

function portableRelative(workspace: string, absolutePath: string): string {
  const workspaceRoot = realpathSync(resolve(workspace));
  const rel = relative(workspaceRoot, resolve(absolutePath));
  if (!rel || rel.startsWith("..") || resolve(workspaceRoot, rel) === workspaceRoot) {
    throw new ManagedSkillsFatalError(`transaction path escapes workspace: ${absolutePath}`);
  }
  return toPortablePath(rel);
}

function toPortablePath(path: string): string {
  return path.split(sep).join("/");
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// Kept as a named constant so tests can assert journal placement without
// reaching into implementation-only path construction.
export const MANAGED_SKILLS_RUNTIME_PATHS = Object.freeze({
  journal: toPortablePath(MANAGED_SKILLS_JOURNAL_REL),
  lock: toPortablePath(MANAGED_SKILLS_LOCK_REL),
});
