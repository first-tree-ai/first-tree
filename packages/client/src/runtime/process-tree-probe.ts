import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";
import type { pino } from "../cloud/observability/logger.js";

const execFileAsync = promisify(execFile);

/**
 * Detects whether a session's provider process currently has any live
 * descendant process — e.g. a `Bash run_in_background` watcher polling a CI
 * run. SessionRuntime consults this to defer idle-suspend and to deprioritize
 * concurrency eviction while such background work is in flight, so the
 * provider's "background task complete -> re-invoke the agent" wake-up is not
 * lost by tearing the session down underneath it.
 *
 * The provider (a `claude` process spawned by the Claude Agent SDK) is a direct
 * child of this daemon process, and the daemon stamps a per-session
 * `FIRST_TREE_CHAT_ID` env var onto it. So the probe maps a provider pid back
 * to its chatId by reading that env var; it never needs to track individual
 * child pids — only whether the provider currently has a descendant at all.
 */
export interface SubprocessProbe {
  /** True if the provider for `chatId` currently has at least one live descendant. */
  hasLiveSubprocess(chatId: string): boolean;
  /**
   * True if the provider for `chatId` has a live child it did NOT start the
   * session with — the closest available reading of "a task this session
   * launched is still running".
   *
   * `hasLiveSubprocess` cannot answer that question. Its predicate is "the
   * provider has any direct child", and a stdio MCP server is a direct child
   * for the whole life of the session, so for any MCP-configured agent it is
   * unconditionally true. That is harmless for the deferral it was built for
   * (over-deferring a suspend is conservative and invisible) but wrong for
   * anything a user reads, which would then say "background task" about every
   * idle chat on the host.
   */
  hasSessionSpawnedSubprocess(chatId: string): boolean;
  /** Stop the background refresh loop (called on SessionRuntime shutdown). */
  stop(): void;
}

export type ProcessRow = { pid: number; ppid: number; comm: string };

/** Parse `ps -axo pid=,ppid=,comm=` output into rows. Unparseable lines are skipped. */
export function parseProcessRows(output: string): ProcessRow[] {
  const rows: ProcessRow[] = [];
  for (const line of output.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const match = trimmed.match(/^(\d+)\s+(\d+)\s+(.*)$/);
    if (!match) continue;
    rows.push({ pid: Number(match[1]), ppid: Number(match[2]), comm: match[3] ?? "" });
  }
  return rows;
}

/** Build a parent-pid -> child-pids adjacency index. */
export function buildChildrenIndex(rows: readonly ProcessRow[]): Map<number, number[]> {
  const byParent = new Map<number, number[]>();
  for (const { pid, ppid } of rows) {
    const existing = byParent.get(ppid);
    if (existing) existing.push(pid);
    else byParent.set(ppid, [pid]);
  }
  return byParent;
}

/** A provider is a `claude` process; `comm` is a full path on macOS, a basename on Linux. */
function isClaudeComm(comm: string): boolean {
  return comm === "claude" || comm.endsWith("/claude");
}

/** Provider pids = `claude` processes that are direct children of the daemon. */
export function findProviderPids(rows: readonly ProcessRow[], daemonPid: number): number[] {
  return rows.filter((row) => row.ppid === daemonPid && isClaudeComm(row.comm)).map((row) => row.pid);
}

/**
 * True if `pid` has at least one direct child. A direct-child check is
 * sufficient to detect any live descendant: a `run_in_background` task lives
 * under the launcher shell (a direct child of the provider) for its whole life,
 * and if that launcher exits the task reparents to the provider (a subreaper) —
 * so a live descendant always implies a live direct child.
 */
export function hasDescendant(pid: number, childrenByParent: ReadonlyMap<number, number[]>): boolean {
  return (childrenByParent.get(pid)?.length ?? 0) > 0;
}

/**
 * True if `pid` has a direct child outside `baseline` — the children it had
 * when this provider process was first observed.
 *
 * The baseline is what a provider starts a session with and keeps: stdio MCP
 * servers, most visibly. Work the session itself launches appears as a pid the
 * baseline has never seen, which is exactly the distinction the plain
 * descendant check cannot draw.
 *
 * Both error directions are deliberate. A provider first observed mid-turn
 * baselines that turn's children and under-reports until they exit — silence
 * rather than a false claim. An MCP server that crashes and respawns takes a
 * new pid and over-reports for the rest of that provider process; that is a
 * rare, self-limiting case, unlike the permanent misreading it replaces.
 */
export function hasNonBaselineChild(
  pid: number,
  childrenByParent: ReadonlyMap<number, number[]>,
  baseline: ReadonlySet<number>,
): boolean {
  return (childrenByParent.get(pid) ?? []).some((childPid) => !baseline.has(childPid));
}

/**
 * Extract the `FIRST_TREE_CHAT_ID` value from a process's environment dump.
 * Handles both forms produced by {@link defaultEnvForPid}: space-separated
 * (Darwin `ps -Eww`) and NUL-separated (Linux `/proc/<pid>/environ`). The value
 * therefore stops at the next whitespace OR NUL, so it never bleeds into the
 * following env entry.
 */
export function extractChatId(envText: string): string | null {
  const match = envText.match(/\bFIRST_TREE_CHAT_ID=([^\s\0]+)/);
  return match ? (match[1] ?? null) : null;
}

type PsSubprocessProbeOptions = {
  log: pino.Logger;
  /** Defaults to this daemon process. */
  daemonPid?: number;
  /** Refresh cadence; defaults to 10s (matches the idle-eviction tick). */
  intervalMs?: number;
  /** Injectable for tests: returns `ps -axo pid=,ppid=,comm=` stdout. */
  runProcessSnapshot?: () => Promise<string>;
  /** Injectable for tests: returns `ps -Eww -p <pid> -o command=` stdout. */
  runEnvForPid?: (pid: number) => Promise<string>;
};

async function defaultProcessSnapshot(): Promise<string> {
  const { stdout } = await execFileAsync("ps", ["-axo", "pid=,ppid=,comm="]);
  return stdout;
}

async function defaultEnvForPid(pid: number): Promise<string> {
  // Platform-aware: Linux/procps rejects the BSD `-E` flag, so read the env
  // directly from procfs there (NUL-separated KEY=VALUE entries). Darwin/BSD
  // `ps` has no procfs, so use its `-E` form. Either output is understood by
  // `extractChatId`.
  if (process.platform === "linux") {
    return readFile(`/proc/${pid}/environ`, "utf8");
  }
  const { stdout } = await execFileAsync("ps", ["-Eww", "-p", String(pid), "-o", "command="]);
  return stdout;
}

/**
 * `ps`-backed {@link SubprocessProbe}. Refreshes a `chatId -> has-live-subprocess`
 * snapshot on a background interval (async, off the event-loop hot path) so the
 * synchronous `hasLiveSubprocess` lookup used inside `evictIdle` never blocks on
 * a process scan.
 */
export class PsSubprocessProbe implements SubprocessProbe {
  private chatIdsWithLiveWork = new Set<string>();
  private chatIdsWithSessionSpawnedWork = new Set<string>();
  /**
   * Direct children each provider pid had when first observed. Keyed by pid,
   * so a restarted provider re-baselines for free and a dead one is pruned on
   * the next scan.
   */
  private readonly baselineChildrenByProvider = new Map<number, Set<number>>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private inflight: Promise<void> | null = null;
  private readonly daemonPid: number;
  private readonly runProcessSnapshot: () => Promise<string>;
  private readonly runEnvForPid: (pid: number) => Promise<string>;

  constructor(private readonly opts: PsSubprocessProbeOptions) {
    this.daemonPid = opts.daemonPid ?? process.pid;
    this.runProcessSnapshot = opts.runProcessSnapshot ?? defaultProcessSnapshot;
    this.runEnvForPid = opts.runEnvForPid ?? defaultEnvForPid;
    void this.refresh();
    this.timer = setInterval(() => void this.refresh(), opts.intervalMs ?? 10_000);
    // Never keep the process alive just for the probe.
    this.timer.unref?.();
  }

  hasLiveSubprocess(chatId: string): boolean {
    return this.chatIdsWithLiveWork.has(chatId);
  }

  hasSessionSpawnedSubprocess(chatId: string): boolean {
    return this.chatIdsWithSessionSpawnedWork.has(chatId);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /**
   * Recompute the snapshot once. Concurrent callers share the in-flight run
   * (so a test can `await refresh()` and deterministically observe the result
   * of the constructor's initial refresh).
   */
  refresh(): Promise<void> {
    if (this.inflight) return this.inflight;
    this.inflight = this.doRefresh().finally(() => {
      this.inflight = null;
    });
    return this.inflight;
  }

  private async doRefresh(): Promise<void> {
    try {
      const rows = parseProcessRows(await this.runProcessSnapshot());
      const childrenByParent = buildChildrenIndex(rows);
      const next = new Set<string>();
      const nextSessionSpawned = new Set<string>();
      const providerPids = findProviderPids(rows, this.daemonPid);
      for (const providerPid of providerPids) {
        let baseline = this.baselineChildrenByProvider.get(providerPid);
        if (!baseline) {
          baseline = new Set(childrenByParent.get(providerPid) ?? []);
          this.baselineChildrenByProvider.set(providerPid, baseline);
        }
        const live = hasDescendant(providerPid, childrenByParent);
        const sessionSpawned = hasNonBaselineChild(providerPid, childrenByParent, baseline);
        if (!live && !sessionSpawned) continue;
        const chatId = extractChatId(await this.runEnvForPid(providerPid));
        if (!chatId) continue;
        if (live) next.add(chatId);
        if (sessionSpawned) nextSessionSpawned.add(chatId);
      }
      // Drop baselines for providers that are gone, so a recycled pid cannot
      // inherit a previous provider's session infrastructure.
      const alive = new Set(providerPids);
      for (const pid of this.baselineChildrenByProvider.keys()) {
        if (!alive.has(pid)) this.baselineChildrenByProvider.delete(pid);
      }
      this.chatIdsWithLiveWork = next;
      this.chatIdsWithSessionSpawnedWork = nextSessionSpawned;
    } catch (err) {
      // A probe failure must never wedge the runtime: fall back to "no live
      // work", which simply lets suspend proceed exactly as it did before this
      // feature existed.
      this.opts.log.debug(
        { err },
        "subprocess probe refresh failed; treating all sessions as having no live subprocess",
      );
      this.chatIdsWithLiveWork = new Set();
      this.chatIdsWithSessionSpawnedWork = new Set();
    }
  }
}
