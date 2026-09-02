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
  /**
   * A turn has begun for `chatId`, so whatever the provider is running now is
   * its startup infrastructure and nothing more. Until this is called, the
   * probe keeps absorbing newly observed children into that provider's
   * baseline; after it, new children are session-spawned work.
   *
   * The seal needs a lifecycle point rather than a scan count: the poll starts
   * before any provider exists, so a scan can catch a `claude` process in the
   * window before its stdio MCP server appears. Freezing on first sight would
   * baseline nothing, and the MCP child arriving one scan later would read as
   * background work for the rest of that provider's life — the exact false
   * claim the baseline exists to prevent.
   */
  sealBaseline(chatId: string): void;
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
 * True if `pid` has a direct child outside `baseline` — the children this
 * provider was running before its first turn.
 *
 * The baseline is what a provider starts a session with and keeps: stdio MCP
 * servers, most visibly. Work the session itself launches appears as a pid the
 * baseline has never seen, which is exactly the distinction the plain
 * descendant check cannot draw.
 *
 * Both error directions are deliberate. A provider whose baseline seals mid-turn
 * absorbs that turn's children and under-reports until they exit — silence
 * rather than a false claim. An MCP server that crashes and respawns after the
 * seal takes a new pid and over-reports for the rest of that provider process;
 * that is a rare, self-limiting case, unlike the permanent misreading it
 * replaces.
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
   * Per provider pid: the infrastructure children, and whether that set is
   * still growing. Keyed by pid, so a restarted provider re-baselines for free
   * and a dead one is pruned on the next scan.
   */
  private readonly baselineChildrenByProvider = new Map<
    number,
    {
      pids: Set<number>;
      sealed: boolean;
      /** This pid was observed growing before any turn asked to seal it. */
      grownBeforeSealRequest: boolean;
      /** The one grace scan given to a pid first seen after the seal request. */
      graceScanUsed: boolean;
    }
  >();
  /** Chats whose first turn has begun; their provider's baseline is closed. */
  private readonly sealedChats = new Set<string>();
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

  sealBaseline(chatId: string): void {
    this.sealedChats.add(chatId);
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
      const chatsWithLiveProvider = new Set<string>();
      const providerPids = findProviderPids(rows, this.daemonPid);
      for (const providerPid of providerPids) {
        // The chat is resolved every scan now, not only when a descendant
        // exists: baseline growth has to happen during provider startup, which
        // is exactly the window where there may be no children yet.
        const chatId = extractChatId(await this.runEnvForPid(providerPid));
        const children = childrenByParent.get(providerPid) ?? [];
        let baseline = this.baselineChildrenByProvider.get(providerPid);
        if (!baseline) {
          baseline = { pids: new Set(), sealed: false, grownBeforeSealRequest: false, graceScanUsed: false };
          this.baselineChildrenByProvider.set(providerPid, baseline);
        }
        const grow = (): void => {
          for (const child of children) baseline.pids.add(child);
        };
        if (!baseline.sealed) {
          if (!(chatId && this.sealedChats.has(chatId))) {
            // Startup: no turn has asked to close this chat's baseline yet.
            grow();
            baseline.grownBeforeSealRequest = true;
          } else if (baseline.grownBeforeSealRequest) {
            // The startup window was observed before the turn, so everything
            // infrastructure could be is already in. Closing WITHOUT growing is
            // what keeps a task this turn just launched outside the baseline.
            baseline.sealed = true;
          } else if (!baseline.graceScanUsed) {
            // This provider was first seen only after the seal request — a
            // restarted provider, or a first turn that began before any scan.
            // It has had no startup window at all, and sealing an empty
            // baseline is what makes a permanent MCP child look like work. Give
            // it one full interval to show its infrastructure.
            baseline.graceScanUsed = true;
            grow();
          } else {
            // End of that interval: absorb whatever appeared during it, then
            // close. Work started inside the grace window is absorbed too —
            // silence, which is the error direction this whole signal prefers.
            grow();
            baseline.sealed = true;
          }
        }
        const live = hasDescendant(providerPid, childrenByParent);
        const sessionSpawned = baseline.sealed && hasNonBaselineChild(providerPid, childrenByParent, baseline.pids);
        if (!chatId) continue;
        chatsWithLiveProvider.add(chatId);
        if (live) next.add(chatId);
        if (sessionSpawned) nextSessionSpawned.add(chatId);
      }
      // Drop baselines for providers that are gone, so a recycled pid cannot
      // inherit a previous provider's session infrastructure.
      const alive = new Set(providerPids);
      for (const pid of this.baselineChildrenByProvider.keys()) {
        if (!alive.has(pid)) this.baselineChildrenByProvider.delete(pid);
      }
      // A chat with no live provider has no baseline to keep closed; the next
      // provider for it starts its own startup window.
      for (const chatId of this.sealedChats) {
        if (!chatsWithLiveProvider.has(chatId)) this.sealedChats.delete(chatId);
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
