import type { ChildProcess } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { delimiter, dirname, join, resolve as resolvePath } from "node:path";
import { getChildProcessRegistry, getCliBinding } from "@first-tree/client";
import { defaultDataDir, readContextTreeRepository } from "@first-tree/shared/config";

/**
 * The external Context Tree CLI. It ships the `context-tree-*` Skill family and
 * a JSON-only command surface for resolving, connecting, reading, and writing
 * Context Trees, including GitHub-hosted ones.
 *
 * It is a normal dependency of this package rather than a global install, so the
 * version is pinned to the CLI release and no network access is needed at run
 * time. We never import it as a module — we resolve its bin and spawn it, so the
 * bundler never pulls it into `dist/`.
 */
const CONTEXT_TREE_PACKAGE = "@first-tree-ai/context-tree";

/** `connect` clones a Git repository, so allow for a slow network. */
const CONTEXT_TREE_TIMEOUT_MS = 3 * 60 * 1000;

/** Agent homes live below `<dataDir>/workspaces/<agentName>`; see AgentSlot. */
const WORKSPACES_DIRNAME = "workspaces";

export type ContextTreeCliInvocation = { command: string; args: string[] };

export type ContextTreeCliResult =
  | { ok: true; payload: unknown }
  // `reasonCode` is the external CLI's own `error.code` (`NO_CONNECTION`,
  // `DIRTY_TREE`, …) when it produced a structured envelope, and absent when the
  // failure happened before or outside one.
  | { ok: false; reason: string; reasonCode?: string };

export type ContextTreeConnectFailure = {
  workspace: string;
  reason: string;
  reasonCode?: string;
};

export type ContextTreeSetupReport = {
  /**
   * `skipped` covers both "external mode is off with nothing to undo" and "the
   * CLI is unavailable"; either way nothing was written and the caller carries
   * on. `removed` means external mode is off and a previous install was undone.
   */
  status: "skipped" | "installed" | "failed" | "removed";
  reason?: string;
  /** Host Skill directories the packaged Skills were written to. */
  installedHosts: string[];
  /** Workspaces connected to the configured repository. */
  connectedWorkspaces: string[];
  /** Per-workspace connect failures; one failure never aborts the rest. */
  failures: ContextTreeConnectFailure[];
  /**
   * Where the `context-tree` shim was written, or null when it could not be.
   * The Skills invoke `context-tree` by name, so without this the Agent cannot
   * run them at all; `doctor` surfaces the path.
   */
  shimPath?: string | null;
  /** Skill directories removed when external mode was switched back off. */
  removedSkillPaths?: string[];
};

/**
 * What this machine installed on behalf of external mode.
 *
 * The external CLI has no `uninstall`, so switching the key back off means
 * removing the Skills ourselves — and a home directory is the last place to
 * delete by pattern. This ledger is the authority for that: only paths recorded
 * here are ever removed, so a `context-tree install` the user ran themselves is
 * untouched. No ledger therefore means remove nothing.
 */
type ContextTreeInstallLedger = {
  version: 1;
  hosts: { host: string; path: string; skills: string[] }[];
  shimPath?: string | null;
};

const LEDGER_FILENAME = "context-tree-install.json";

/** Prefix every Skill this integration owns shares; a second removal guard. */
const EXTERNAL_SKILL_PREFIX = "context-tree-";

/**
 * Marker identifying a shim this CLI wrote.
 *
 * It is what distinguishes our shim from a `context-tree` binary the user
 * installed globally themselves, so neither the writer nor the remover ever
 * touches the latter.
 */
const SHIM_MARKER = "first-tree-managed context-tree shim";

function ledgerPath(): string {
  return join(defaultDataDir(), LEDGER_FILENAME);
}

function readInstallLedger(): ContextTreeInstallLedger | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(ledgerPath(), "utf8"));
    if (!isRecord(parsed) || parsed.version !== 1 || !Array.isArray(parsed.hosts)) return null;
    const hosts = parsed.hosts.flatMap((entry) => {
      if (!isRecord(entry) || typeof entry.host !== "string" || typeof entry.path !== "string") return [];
      const skills = Array.isArray(entry.skills) ? entry.skills.filter((s): s is string => typeof s === "string") : [];
      return [{ host: entry.host, path: entry.path, skills }];
    });
    const shimPath = typeof parsed.shimPath === "string" ? parsed.shimPath : null;
    return { version: 1, hosts, shimPath };
  } catch {
    return null;
  }
}

function writeInstallLedger(ledger: ContextTreeInstallLedger): void {
  try {
    mkdirSync(defaultDataDir(), { recursive: true });
    writeFileSync(ledgerPath(), `${JSON.stringify(ledger, null, 2)}\n`, "utf8");
  } catch {
    // A missing ledger only costs us the ability to clean up later; it must
    // never fail a login.
  }
}

/** Parse `install`'s `{installed:[{host,path,skills}]}` payload into a ledger. */
function ledgerFromInstallPayload(payload: unknown, shimPath: string | null): ContextTreeInstallLedger {
  const hosts: ContextTreeInstallLedger["hosts"] = [];
  if (isRecord(payload) && Array.isArray(payload.installed)) {
    for (const entry of payload.installed) {
      if (!isRecord(entry) || typeof entry.host !== "string" || typeof entry.path !== "string") continue;
      const skills = Array.isArray(entry.skills) ? entry.skills.filter((s): s is string => typeof s === "string") : [];
      hosts.push({ host: entry.host, path: entry.path, skills });
    }
  }
  return { version: 1, hosts, shimPath };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/**
 * Locate the packaged `context-tree` bin.
 *
 * Invoked as `process.execPath <bin>` rather than through the bin shim: the same
 * defence `resolveNpmInvocation` applies for npm, which avoids the Windows
 * `.cmd` EINVAL problem. Returns `null` when the dependency is absent — the
 * portable build prunes deps — so callers report a skip, not a failure.
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

/**
 * Run one `context-tree` subcommand and parse its result.
 *
 * Every subcommand prints exactly one JSON line. Success payloads are
 * command-specific and do NOT carry an `ok` field, so exit code is the only
 * reliable verdict; a non-zero exit prints `{ok:false,error:{code,message}}` and
 * we surface that `code` as the `reasonCode`.
 */
export async function runContextTreeCommand(args: string[]): Promise<ContextTreeCliResult> {
  const cli = resolveContextTreeCli();
  if (!cli) {
    return {
      ok: false,
      reason: `${CONTEXT_TREE_PACKAGE} is not installed beside this CLI.`,
      reasonCode: "context_tree_cli_missing",
    };
  }

  return new Promise((resolvePromise) => {
    let child: ChildProcess;
    try {
      ({ child } = getChildProcessRegistry().spawn(cli.command, [...cli.args, ...args], {
        category: "other",
        label: `context-tree ${args.join(" ")}`,
        timeoutMs: CONTEXT_TREE_TIMEOUT_MS,
        stdio: ["ignore", "pipe", "pipe"],
      }));
    } catch (err) {
      resolvePromise(spawnFailure(err));
      return;
    }

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let timedOut = false;
    child.stdout?.on("data", (chunk: Buffer) => stdoutChunks.push(chunk));
    child.stderr?.on("data", (chunk: Buffer) => stderrChunks.push(chunk));

    child.on("error", (err) => resolvePromise(spawnFailure(err)));

    child.on("exit", (code, signal) => {
      const stdout = Buffer.concat(stdoutChunks).toString("utf8").trim();
      if (code === 0) {
        const payload = parseJsonLine(stdout);
        if (payload === undefined) {
          resolvePromise({
            ok: false,
            reason: "context-tree returned no parseable JSON result.",
            reasonCode: "context_tree_bad_payload",
          });
          return;
        }
        resolvePromise({ ok: true, payload });
        return;
      }
      if (code === null && signal) timedOut = true;
      const envelope = parseJsonLine(stdout);
      const envelopeError = isRecord(envelope) && isRecord(envelope.error) ? envelope.error : undefined;
      const envelopeCode = typeof envelopeError?.code === "string" ? envelopeError.code : undefined;
      const envelopeMessage = typeof envelopeError?.message === "string" ? envelopeError.message : undefined;
      const stderr = Buffer.concat(stderrChunks).toString("utf8").trim();
      const reason =
        envelopeMessage ??
        `context-tree ${
          timedOut ? `killed by signal ${signal} (timeout)` : `exited with code ${code}`
        }${stderr ? `: ${stderr.split("\n").slice(-3).join(" | ")}` : ""}`;
      resolvePromise({
        ok: false,
        reason,
        reasonCode: envelopeCode ?? (timedOut ? "context_tree_timeout" : undefined),
      });
    });
  });
}

function spawnFailure(err: unknown): ContextTreeCliResult {
  return { ok: false, reason: err instanceof Error ? err.message : String(err) };
}

function parseJsonLine(stdout: string): unknown {
  if (stdout.length === 0) return undefined;
  // Take the last non-empty line: the payload is one line, but a stray warning
  // ahead of it should not defeat parsing.
  const lines = stdout.split("\n").filter((line) => line.trim().length > 0);
  const last = lines[lines.length - 1];
  if (last === undefined) return undefined;
  try {
    return JSON.parse(last);
  } catch {
    return undefined;
  }
}

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

function installedHostsFrom(payload: unknown): string[] {
  if (!isRecord(payload) || !Array.isArray(payload.installed)) return [];
  return payload.installed
    .map((entry) => (isRecord(entry) && typeof entry.host === "string" ? entry.host : null))
    .filter((host): host is string => host !== null);
}

/**
 * The directory holding this channel's CLI executable, found on `PATH`.
 *
 * That directory is what the Agent's `PATH` is built from — either inherited or
 * prepended as `FIRST_TREE_CLI_BIN_DIR` (`agent-io.ts`) — so it is the one place
 * a `context-tree` shim is guaranteed to be visible from inside a session.
 */
function channelCliBinDir(): string | null {
  let binName: string;
  try {
    binName = getCliBinding().binName;
  } catch {
    return null;
  }
  const candidates = process.platform === "win32" ? [`${binName}.cmd`, `${binName}.exe`, binName] : [binName];
  for (const dir of (process.env.PATH ?? "").split(delimiter).filter((part) => part.length > 0)) {
    for (const candidate of candidates) {
      if (existsSync(join(dir, candidate))) return resolvePath(dir);
    }
  }
  return null;
}

/**
 * Put `context-tree` on the Agent's `PATH`.
 *
 * Every installed Skill starts by running `context-tree …`, but npm links only a
 * top-level package's bin — never a transitive dependency's — so the packaged
 * dependency is reachable by module resolution and by nothing else. Without this
 * shim the Skills are installed and unrunnable.
 *
 * Absolute paths are baked in deliberately: the shim must work even though the
 * Agent's `PATH` is a controlled list that need not contain `node`. `login`
 * rewrites it every time, so a Node version bump heals itself.
 */
function writeContextTreeShim(): { path: string; owned: boolean } | { reason: string } {
  const cli = resolveContextTreeCli();
  if (!cli) return { reason: `${CONTEXT_TREE_PACKAGE} is not installed beside this CLI` };
  const binDir = channelCliBinDir();
  if (!binDir) return { reason: "could not locate this CLI's bin directory on PATH" };

  const target = cli.args[0];
  if (target === undefined) return { reason: "could not resolve the context-tree entry point" };

  const shimPath = join(binDir, process.platform === "win32" ? "context-tree.cmd" : "context-tree");

  // Never clobber a `context-tree` the user installed themselves — a global
  // `npm i -g @first-tree-ai/context-tree` lands its own bin in exactly this
  // directory, and that one already satisfies the Skills. Only a shim carrying
  // our marker is rewritten, which keeps repeated logins idempotent and lets a
  // Node version bump heal itself.
  if (existsSync(shimPath)) {
    let existing = "";
    try {
      existing = readFileSync(shimPath, "utf8");
    } catch {
      // Unreadable (a dangling symlink, most likely) — treat it as not ours.
    }
    if (!existing.includes(SHIM_MARKER)) return { path: shimPath, owned: false };
  }

  try {
    if (process.platform === "win32") {
      writeFileSync(shimPath, `@echo off\r\nrem ${SHIM_MARKER}\r\n"${process.execPath}" "${target}" %*\r\n`, "utf8");
      return { path: shimPath, owned: true };
    }
    writeFileSync(shimPath, `#!/bin/sh\n# ${SHIM_MARKER}\nexec "${process.execPath}" "${target}" "$@"\n`, "utf8");
    chmodSync(shimPath, 0o755);
    return { path: shimPath, owned: true };
  } catch (err) {
    // A root-owned prefix is the common case. Report the remedy rather than
    // failing the login; external mode is degraded, not the whole CLI.
    const detail = err instanceof Error ? err.message : String(err);
    return {
      reason: `could not write a context-tree shim into ${binDir} (${detail}) — run \`npm i -g ${CONTEXT_TREE_PACKAGE}\``,
    };
  }
}

/**
 * Undo what external mode installed, once the key is unset.
 *
 * Removal is ledger-driven and guarded three ways: the path must be recorded in
 * the ledger, its basename must carry the `context-tree-` prefix, and it must
 * sit under the host Skill root the ledger recorded for it. A Skill this machine
 * did not install is therefore never removed, and neither is a tree checkout or
 * a `~/.context-tree` connection — those belong to the user.
 */
function removeInstalledContextTreeSkills(): ContextTreeSetupReport {
  const base: ContextTreeSetupReport = {
    status: "skipped",
    installedHosts: [],
    connectedWorkspaces: [],
    failures: [],
  };
  const ledger = readInstallLedger();
  if (!ledger) {
    return { ...base, reason: "context_tree.repository is not set" };
  }

  const removed: string[] = [];
  for (const host of ledger.hosts) {
    const hostRoot = resolvePath(host.path);
    for (const skill of host.skills) {
      if (!skill.startsWith(EXTERNAL_SKILL_PREFIX)) continue;
      const skillPath = resolvePath(join(hostRoot, skill));
      if (skillPath !== join(hostRoot, skill)) continue;
      if (!existsSync(skillPath)) continue;
      try {
        rmSync(skillPath, { recursive: true, force: true });
        removed.push(skillPath);
      } catch {
        // Leave it; the ledger is cleared below either way and a stale Skill is
        // less harmful than a login that cannot complete.
      }
    }
  }

  if (ledger.shimPath) {
    try {
      // Re-verify ownership at removal time too: the file may have been replaced
      // by a real global install since the ledger was written.
      if (readFileSync(ledger.shimPath, "utf8").includes(SHIM_MARKER)) unlinkSync(ledger.shimPath);
    } catch {
      // Already gone, or not ours to read.
    }
  }

  try {
    unlinkSync(ledgerPath());
  } catch {
    // Nothing recorded to clear.
  }

  return {
    ...base,
    status: "removed",
    reason: "context_tree.repository is not set",
    removedSkillPaths: removed,
  };
}

/**
 * Install the external Context Tree Skills and link the configured tree.
 *
 * Gated on `context_tree.repository`. That gate is what keeps the two Skill
 * families from ever being live together: an unconfigured machine never gets the
 * `context-tree-*` Skills installed, and a configured one has the overlapping
 * `first-tree-{read,write,seed}` projection stood down by the Client (see
 * `ContextSource` kind `external`).
 *
 * Best-effort throughout: a failure is reported, never thrown — it runs inside
 * `login`, which must succeed even when the tree cannot be reached.
 */
export async function ensureContextTreeSkills(): Promise<ContextTreeSetupReport> {
  const base: ContextTreeSetupReport = {
    status: "skipped",
    installedHosts: [],
    connectedWorkspaces: [],
    failures: [],
  };

  const repository = readContextTreeRepository();
  if (!repository) {
    // Not a no-op: a global install runs the dependency's own postinstall, which
    // places the Skills regardless of this key. Undoing that is what makes the
    // switch real in both directions rather than one-way.
    return removeInstalledContextTreeSkills();
  }
  if (!resolveContextTreeCli()) {
    return { ...base, reason: `${CONTEXT_TREE_PACKAGE} is not installed beside this CLI` };
  }

  const install = await runContextTreeCommand(["install", "--host", "all"]);
  if (!install.ok) {
    return { ...base, status: "failed", reason: install.reason };
  }

  const shim = writeContextTreeShim();
  const shimPath = "path" in shim ? shim.path : null;
  // Only a shim we actually wrote is recorded, so the revert path can never
  // remove a `context-tree` the user installed globally themselves.
  writeInstallLedger(ledgerFromInstallPayload(install.payload, "owned" in shim && shim.owned ? shimPath : null));

  const report: ContextTreeSetupReport = {
    status: "installed",
    installedHosts: installedHostsFrom(install.payload),
    connectedWorkspaces: [],
    failures: [],
    shimPath,
  };
  // The Skills are useless without the shim, so a failure to write it is
  // surfaced beside the connect failures rather than swallowed.
  if ("reason" in shim) {
    report.failures.push({ workspace: "context-tree shim", reason: shim.reason });
  }

  for (const workspace of existingWorkspacePaths()) {
    const connect = await runContextTreeCommand(["connect", repository, "--project-path", workspace]);
    if (connect.ok) report.connectedWorkspaces.push(workspace);
    else report.failures.push({ workspace, reason: connect.reason, reasonCode: connect.reasonCode });
  }

  return report;
}

/** One line for the CLI to print after login. */
export function formatContextTreeSetupReport(report: ContextTreeSetupReport): string {
  if (report.status === "skipped") return `Context Tree Skills skipped — ${report.reason ?? "unavailable"}`;
  if (report.status === "failed") return `Context Tree Skills not installed — ${report.reason ?? "unknown error"}`;
  if (report.status === "removed") {
    const count = report.removedSkillPaths?.length ?? 0;
    return `Context Tree Skills removed (${count} skill${count === 1 ? "" : "s"}) — external mode is off`;
  }
  const hosts = report.installedHosts.length > 0 ? report.installedHosts.join(", ") : "no host";
  const connected = `${report.connectedWorkspaces.length} workspace${
    report.connectedWorkspaces.length === 1 ? "" : "s"
  }`;
  return `Context Tree Skills installed (${hosts}); linked ${connected}${formatFailures(report.failures)}`;
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
