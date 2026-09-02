import type { ChildProcess } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { getChildProcessRegistry } from "@first-tree/client";
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
   * `skipped` covers both "external mode is off" and "the CLI is unavailable";
   * either way nothing was written and the caller carries on.
   */
  status: "skipped" | "installed" | "failed";
  reason?: string;
  /** Host Skill directories the packaged Skills were written to. */
  installedHosts: string[];
  /** Workspaces connected to the configured repository. */
  connectedWorkspaces: string[];
  /** Per-workspace connect failures; one failure never aborts the rest. */
  failures: ContextTreeConnectFailure[];
};

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
    return { ...base, reason: "context_tree.repository is not set" };
  }
  if (!resolveContextTreeCli()) {
    return { ...base, reason: `${CONTEXT_TREE_PACKAGE} is not installed beside this CLI` };
  }

  const install = await runContextTreeCommand(["install", "--host", "all"]);
  if (!install.ok) {
    return { ...base, status: "failed", reason: install.reason };
  }

  const report: ContextTreeSetupReport = {
    status: "installed",
    installedHosts: installedHostsFrom(install.payload),
    connectedWorkspaces: [],
    failures: [],
  };

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
