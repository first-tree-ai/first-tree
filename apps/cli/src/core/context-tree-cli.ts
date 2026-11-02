import { existsSync, readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  CONTEXT_TREE_PACKAGE,
  contextTreeCliVersion,
  contextTreeShimDir,
  contextTreeShimName,
  ensureExternalContextTreeWorkspace,
  recordedExternalContextTreeWorkspaces,
  removeExternalContextTreeWorkspace,
  removeLegacyChannelShim,
  resolveContextTreeCli,
  resolveContextTreeRef,
  retireLegacyAccountSkills,
  writeContextTreeShim,
} from "@first-tree/client";
import { defaultDataDir, readContextTreeRefSetting, readContextTreeRepositorySetting } from "@first-tree/shared/config";

/**
 * Login-time setup for external Context Tree mode.
 *
 * The bundled `@first-tree-ai/context-tree` CLI (1.x) and everything it needs
 * per workspace live in `@first-tree/client`, because a session start does the
 * same work for Agents created after login. This module adds what only `login`
 * does: connect every existing workspace up front, retire what earlier First
 * Tree releases installed at account level, and revert when the key is unset.
 */
export {
  type ContextTreeCliInvocation,
  type ContextTreeCliResult,
  resolveContextTreeCli,
  runContextTreeCommand,
  skillTreeDigest,
} from "@first-tree/client";

/** What `doctor` reports about the bundled CLI, without spawning it. */
export function inspectContextTreeCli(): { version: string | null; shimPath: string; shimPresent: boolean } {
  const shimPath = join(contextTreeShimDir(), contextTreeShimName());
  return { version: contextTreeCliVersion(), shimPath, shimPresent: existsSync(shimPath) };
}

/** Agent homes live below `<dataDir>/workspaces/<agentName>`; see AgentSlot. */
const WORKSPACES_DIRNAME = "workspaces";

export type ContextTreeConnectFailure = {
  workspace: string;
  reason: string;
  reasonCode?: string;
};

export type ContextTreeSetupReport = {
  /**
   * `skipped` means the CLI is unavailable, so nothing was written and the
   * caller carries on. `removed` means external mode is off and owned cleanup
   * completed, including an already-clean inspection.
   */
  status: "skipped" | "installed" | "failed" | "removed";
  reason?: string;
  /** The branch workspaces were connected to. */
  ref?: string;
  /** Workspaces that received the Skills and a connection to the configured tree. */
  connectedWorkspaces: string[];
  /** Per-workspace failures; one failure never aborts the rest. */
  failures: ContextTreeConnectFailure[];
  /** Where the `context-tree` shim was written, or null when it could not be. */
  shimPath?: string | null;
  /** Account-level Skill directories an earlier First Tree installed and this login removed. */
  removedSkillPaths?: string[];
  /**
   * Account-level `context-tree-*` Skill directories left in place because they
   * were not recorded as First Tree-created and unmodified — a hand-installed
   * or edited Skill a login must never delete. Agents may see them beside the
   * workspace copies.
   */
  preservedSkillPaths?: string[];
};

/** Existing agent homes, so a connect never pre-creates a workspace. */
function existingWorkspacePaths(): string[] {
  const workspacesRoot = join(defaultDataDir(), WORKSPACES_DIRNAME);
  if (!existsSync(workspacesRoot)) return [];
  let names: string[];
  try {
    names = readdirSync(workspacesRoot);
  } catch {
    return [];
  }
  return names
    .filter((name) => !name.startsWith("."))
    .map((name) => join(workspacesRoot, name))
    .filter((path) => {
      try {
        return statSync(path).isDirectory();
      } catch {
        return false;
      }
    });
}

/**
 * Undo external mode once the key is unset: workspace Skills and the
 * declarations First Tree recorded, the shim, and legacy account-level copies.
 * Snapshots, write sessions and the user's own global install are left alone.
 */
export async function removeContextTreeSkills(): Promise<ContextTreeSetupReport> {
  const base: ContextTreeSetupReport = { status: "skipped", connectedWorkspaces: [], failures: [] };
  if (!resolveContextTreeCli()) {
    return { ...base, reason: `${CONTEXT_TREE_PACKAGE} is not installed beside this CLI` };
  }
  const failures: ContextTreeConnectFailure[] = [];
  for (const workspace of recordedExternalContextTreeWorkspaces()) {
    const removal = await removeExternalContextTreeWorkspace(workspace);
    if (!removal.ok) failures.push({ workspace, reason: removal.reason });
  }
  try {
    rmSync(contextTreeShimDir(), { recursive: true, force: true });
  } catch (error) {
    failures.push({ workspace: "context-tree shim", reason: String(error) });
  }
  removeLegacyChannelShim();
  const legacy = retireLegacyAccountSkills();
  return {
    ...base,
    status: "removed",
    reason: "context_tree.repository is not set",
    failures,
    removedSkillPaths: legacy.removed,
    preservedSkillPaths: legacy.preserved,
  };
}

/**
 * Install the external Context Tree Skills into every Agent workspace and
 * connect each one to the configured tree.
 *
 * Gated on `context_tree.repository`: First Tree does not install external
 * Skills on an unconfigured machine. A configured machine has the overlapping
 * `first-tree-{read,write,seed}` projection stood down by the Client (see
 * `ContextSource` kind `external`).
 *
 * Best-effort throughout: a failure is reported, never thrown — it runs inside
 * `login`, which must succeed even when the tree cannot be reached.
 */
export async function ensureContextTreeSkills(): Promise<ContextTreeSetupReport> {
  const base: ContextTreeSetupReport = { status: "skipped", connectedWorkspaces: [], failures: [] };

  const setting = readContextTreeRepositorySetting();
  if (!setting.repository) {
    const removal = await removeContextTreeSkills();
    if (setting.raw !== null) {
      return {
        ...removal,
        status: "failed",
        reason: `context_tree.repository value ${JSON.stringify(setting.raw)} is unusable; external mode is off`,
      };
    }
    return removal;
  }
  const repository = setting.repository;
  if (!resolveContextTreeCli()) {
    return { ...base, reason: `${CONTEXT_TREE_PACKAGE} is not installed beside this CLI` };
  }

  const refSetting = readContextTreeRefSetting();
  if (refSetting.raw !== null && refSetting.ref === null) {
    return {
      ...base,
      status: "failed",
      reason: `context_tree.ref value ${JSON.stringify(refSetting.raw)} is not a usable branch name`,
    };
  }
  const ref = await resolveContextTreeRef(repository, refSetting.ref);
  if ("reason" in ref) return { ...base, status: "failed", reason: ref.reason };

  removeLegacyChannelShim();
  const legacy = retireLegacyAccountSkills();
  const shim = writeContextTreeShim();
  if ("reason" in shim) return { ...base, status: "failed", reason: shim.reason };

  const report: ContextTreeSetupReport = {
    status: "installed",
    ref: ref.ref,
    connectedWorkspaces: [],
    failures: [],
    shimPath: shim.path,
    removedSkillPaths: legacy.removed,
    preservedSkillPaths: legacy.preserved,
  };
  for (const workspace of existingWorkspacePaths()) {
    const result = await ensureExternalContextTreeWorkspace(workspace, { repository, ref: ref.ref });
    if (result.ok) report.connectedWorkspaces.push(workspace);
    else
      report.failures.push({
        workspace,
        reason: result.reason,
        ...(result.reasonCode ? { reasonCode: result.reasonCode } : {}),
      });
  }
  return report;
}

/** One line for the CLI to print after login. */
export function formatContextTreeSetupReport(report: ContextTreeSetupReport): string {
  if (report.status === "skipped") return `Context Tree Skills skipped — ${report.reason ?? "unavailable"}`;
  if (report.status === "failed") return `Context Tree Skills not installed — ${report.reason ?? "unknown error"}`;
  const preserved = report.preservedSkillPaths?.length ?? 0;
  const preservedNote =
    preserved > 0
      ? `; left ${preserved} hand-installed or edited account-level Skill${preserved === 1 ? "" : "s"} in place (${truncate(
          (report.preservedSkillPaths ?? []).join(", "),
          120,
        )})`
      : "";
  if (report.status === "removed") {
    const count = report.removedSkillPaths?.length ?? 0;
    return `Context Tree Skills removed (${count} legacy skill${count === 1 ? "" : "s"})${preservedNote}${formatFailures(
      report.failures,
    )} — external mode is off`;
  }
  const version = contextTreeCliVersion();
  const connected = `${report.connectedWorkspaces.length} workspace${report.connectedWorkspaces.length === 1 ? "" : "s"}`;
  return `Context Tree Skills installed (context-tree ${version ?? "unknown"}, ${report.ref ?? "default branch"}); linked ${connected}${preservedNote}${formatFailures(
    report.failures,
  )}`;
}

/**
 * Name the first failure rather than only counting them. The likeliest failure
 * by far is a private tree with no Git credential helper, and a bare count
 * leaves the user with nothing to act on.
 */
function formatFailures(failures: readonly ContextTreeConnectFailure[]): string {
  const first = failures[0];
  if (first === undefined) return "";
  const more = failures.length > 1 ? ` (+${failures.length - 1} more)` : "";
  return `, ${failures.length} failed: ${truncate(first.reason, 160)}${more}`;
}

function truncate(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}
