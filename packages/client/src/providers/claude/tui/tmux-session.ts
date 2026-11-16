import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { READY_MARKER, TMUX_SESSION_PREFIX, USER_RE } from "./tui-markers.js";

const DEFAULT_TMUX_TIMEOUT_MS = 5000;

type TmuxResult = { ok: boolean; stdout: string; stderr: string; code: number | null };

function runTmux(args: string[], timeoutMs = DEFAULT_TMUX_TIMEOUT_MS): Promise<TmuxResult> {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    const child = spawn("tmux", args, { stdio: ["ignore", "pipe", "pipe"] });
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        child.kill("SIGKILL");
        resolve({ ok: false, stdout, stderr: `${stderr}\n[timeout]`, code: null });
      }
    }, timeoutMs);
    child.stdout.on("data", (b: Buffer) => {
      stdout += b.toString("utf-8");
    });
    child.stderr.on("data", (b: Buffer) => {
      stderr += b.toString("utf-8");
    });
    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ok: false, stdout, stderr: stderr + (stderr ? "\n" : "") + err.message, code: null });
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ok: code === 0, stdout, stderr, code });
    });
  });
}

/**
 * Render tmux argv for a diagnostic with every `-e KEY=value` value masked.
 *
 * `new-session -e` carries the agent's resolved environment, which includes
 * provider credentials; a failed start used to stringify the whole argv into the
 * error message, and that message reaches the client log (SEC-032). The key stays
 * so the diagnostic still says which variable was involved.
 */
export function redactTmuxArgsForLog(args: readonly string[]): string {
  const rendered: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] ?? "";
    if (arg === "-e" && index + 1 < args.length) {
      const assignment = args[index + 1] ?? "";
      const separator = assignment.indexOf("=");
      rendered.push(arg, separator === -1 ? assignment : `${assignment.slice(0, separator)}=***`);
      index += 1;
      continue;
    }
    rendered.push(arg);
  }
  return rendered.join(" ");
}

/**
 * True when the argv carries an `-e KEY=value` environment assignment.
 *
 * Those launches hand tmux the agent's resolved environment, provider keys
 * included. tmux echoes argument and environment problems on stderr, so that
 * stream is not safe to forward verbatim (SEC-032).
 */
function carriesEnvironment(args: readonly string[]): boolean {
  return args.includes("-e");
}

/**
 * Remove the values of every `-e KEY=value` assignment from arbitrary text.
 *
 * tmux echoes argument and environment problems on stderr, and a server that
 * rejects a variable can quote the value back. We know the secrets because they
 * are in the argv we built, so they can be removed without discarding the rest
 * of the diagnostic (SEC-032).
 */
export function redactEnvValues(text: string, args: readonly string[]): string {
  let out = text;
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] !== "-e") continue;
    const assignment = args[index + 1] ?? "";
    const separator = assignment.indexOf("=");
    if (separator === -1) continue;
    const value = assignment.slice(separator + 1);
    // Very short values would shred unrelated text for no confidentiality gain.
    if (value.length < 4) continue;
    out = out.split(value).join("***");
  }
  return out;
}

async function tmuxOrThrow(args: string[], timeoutMs?: number): Promise<string> {
  const result = await runTmux(args, timeoutMs);
  if (!result.ok) {
    const stderr = carriesEnvironment(args)
      ? `${redactEnvValues(result.stderr.trim(), args)} [stderr redacted against -e values]`
      : result.stderr.trim();
    throw new Error(`tmux ${redactTmuxArgsForLog(args)} failed (code=${result.code ?? "n/a"}): ${stderr}`);
  }
  return result.stdout;
}

export type NewSessionInput = {
  name: string;
  cwd: string;
  command: string;
  env?: Record<string, string>;
  width?: number;
  height?: number;
};

/**
 * Spawn a detached tmux session running `command`. Returns once tmux reports
 * the session started (note: the inner process may still be initialising).
 */
export async function newSession(input: NewSessionInput): Promise<void> {
  const args = [
    "new-session",
    "-d",
    "-s",
    input.name,
    "-x",
    String(input.width ?? 220),
    "-y",
    String(input.height ?? 60),
    "-c",
    input.cwd,
  ];
  for (const [k, v] of Object.entries(input.env ?? {})) {
    args.push("-e", `${k}=${v}`);
  }
  args.push(input.command);
  await tmuxOrThrow(args);
}

/**
 * Inject text into the session pane via bracketed paste, then send Enter.
 *
 * `load-buffer` writes the verbatim text into a tmux buffer; `paste-buffer
 * -p` uses bracketed paste so multi-line content and shell metacharacters
 * (\ ` $ etc.) are delivered without interpretation. A small delay before
 * Enter avoids races where claude's reader misses the trailing newline.
 *
 * Cleanup matters for confidentiality: the tmux buffer lives on the shared
 * tmux *server*, not in our session, so even after our session is killed the
 * message text stays readable via `tmux show-buffer` from any other surviving
 * session. We delete the buffer (`paste-buffer -d` plus a finally backstop) and
 * remove the whole temp directory, not just the file.
 */
export async function pasteText(sessionName: string, text: string): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "ftth-tui-"));
  const file = join(dir, "msg.txt");
  writeFileSync(file, text, "utf-8");
  const bufferName = `${sessionName}-msg`;
  try {
    await tmuxOrThrow(["load-buffer", "-b", bufferName, file]);
    // `-d` deletes the buffer once pasted, so the text doesn't linger server-side.
    await tmuxOrThrow(["paste-buffer", "-b", bufferName, "-t", sessionName, "-p", "-d"]);
    await new Promise((r) => setTimeout(r, 150));
    await tmuxOrThrow(["send-keys", "-t", sessionName, "Enter"]);
  } finally {
    // Backstop: if paste failed before `-d` could delete the buffer, drop it
    // explicitly. Best-effort (no throw if already gone).
    await runTmux(["delete-buffer", "-b", bufferName]);
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
}

/** Send a single key (e.g. `Escape`, `C-c`) to the session. */
export async function sendKey(sessionName: string, key: string): Promise<void> {
  await tmuxOrThrow(["send-keys", "-t", sessionName, key]);
}

/** Snapshot the visible pane (or full scrollback when `fullScrollback`). */
export async function capturePane(sessionName: string, fullScrollback = false): Promise<string> {
  const args = ["capture-pane", "-t", sessionName, "-p"];
  if (fullScrollback) args.push("-S", "-");
  return tmuxOrThrow(args);
}

/** True iff a tmux session with the given name exists. */
export async function sessionExists(sessionName: string): Promise<boolean> {
  const result = await runTmux(["has-session", "-t", sessionName]);
  return result.ok;
}

/** Force-kill the tmux session; best-effort (no throw if already gone). */
export async function killSession(sessionName: string): Promise<void> {
  await runTmux(["kill-session", "-t", sessionName]);
}

/** List names of all tmux sessions on the local server. Returns [] if no server is running. */
export async function listSessions(): Promise<string[]> {
  const result = await runTmux(["list-sessions", "-F", "#{session_name}"]);
  if (!result.ok) return [];
  return result.stdout
    .split("\n")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/**
 * List sessions whose name starts with `prefix`. The orphan sweep passes the
 * client-scoped prefix from `ownedSessionPrefix(clientId)` so it only ever
 * matches sessions THIS client created — never another live client process or
 * a parallel QA slot, which carry a different client tag.
 */
export async function listOwnedSessions(prefix: string): Promise<string[]> {
  const all = await listSessions();
  return all.filter((name) => name.startsWith(prefix));
}

export type WaitForReadyInput = {
  name: string;
  timeoutMs?: number;
  pollIntervalMs?: number;
  /**
   * Deadline granted *after* we auto-select "Resume from summary". Claude then
   * generates the summary (an LLM round-trip over the whole session) before it
   * reaches the ready surface, which routinely exceeds the normal `timeoutMs`
   * start window. Without a fresh, longer deadline a large session would answer
   * the menu and still time out, re-deadlocking on the next resume attempt.
   */
  summaryReadyTimeoutMs?: number;
  /** Test seams; default to the real tmux helpers (capturePane / sendKey). */
  capture?: (sessionName: string) => Promise<string>;
  send?: (sessionName: string, key: string) => Promise<void>;
};

/**
 * Claude Code 2.1.170 may show a one-time workspace trust dialog before the
 * normal TUI surface when a fresh agent workspace has never been opened by the
 * local user. First Tree creates and owns these agent workspaces; without
 * acknowledging this dialog the handler never reaches the ready marker.
 */
export function isWorkspaceTrustPrompt(pane: string): boolean {
  return (
    pane.includes("Quick safety check:") &&
    pane.includes("Yes, I trust this folder") &&
    pane.includes("Enter to confirm")
  );
}

/**
 * Claude Code shows a one-time "resume strategy" menu before the normal TUI
 * surface when resuming a large / old session — e.g. "This session is 2h 41m
 * old and 119.5k tokens. … We recommend resuming from a summary." with options
 * `1. Resume from summary (recommended)` / `2. Resume full session as-is` /
 * `3. Don't ask me again`. The detached runtime has no human to answer it, so
 * without acknowledging this menu the handler never reaches the ready marker
 * and the session start times out, looping forever on every resume attempt.
 * We match on the two stable option labels plus the confirm footer so the
 * normal ready surface never trips it.
 */
export function isResumeSummaryPrompt(pane: string): boolean {
  return (
    pane.includes("Resume from summary") && pane.includes("Resume full session") && pane.includes("Enter to confirm")
  );
}

/**
 * `--dangerously-skip-permissions` makes Claude Code show a one-time
 * Bypass-Permissions warning ("Yes, I accept" / "No, exit") before the ready
 * surface unless the HOME already accepted it (a settings flag or a prior
 * interactive accept). First Tree sets that flag nowhere, so a fresh HOME (new
 * machine / cloud agent) hits this modal and deadlocks like the trust dialog.
 *
 * Match the full warning title AND both option labels: the captured pane also
 * contains prior transcript on resume, so a loose "Bypass Permissions mode"
 * match could fire on conversation text and inject a stray keystroke. The full
 * title + both options is a live-modal shape that ordinary prose won't satisfy
 * (and `waitForReady` checks the ready surface first regardless).
 */
export function isBypassPermissionsWarning(pane: string): boolean {
  return (
    pane.includes("WARNING: Claude Code running in Bypass Permissions mode") &&
    pane.includes("Yes, I accept") &&
    pane.includes("No, exit")
  );
}

/**
 * Claude Code drops into an interactive login wall when credentials are missing
 * or expired — a login-method selector the detached runtime cannot answer (a
 * human must re-authenticate in a browser). waitForReady throws
 * {@link ClaudeTuiLoginRequiredError} on sight; the taxonomy classifies it
 * `permanent` so the session stops the otherwise-infinite retry loop and
 * surfaces to an operator instead of silently spamming retries.
 *
 * Match ONLY the live selector (its title AND an option label), never loose
 * "run /login" / OAuth phrasing: that text routinely appears in ordinary
 * transcript content (a resumed pane re-renders prior conversation), and a
 * false positive here is irreversible — it marks a healthy session permanent.
 * Under-detecting (a non-selector auth failure falls back to the normal
 * retry + ready-timeout path) is the safe direction.
 */
export function isClaudeLoginWall(pane: string): boolean {
  return (
    pane.includes("Select login method") &&
    (pane.includes("Login with Claude account") || pane.includes("Sign in with your Anthropic account"))
  );
}

/**
 * Thrown by {@link waitForReady} when the TUI is parked on an unanswerable
 * login / re-auth wall. The `name` is the classification contract: the error
 * taxonomy maps it to a `permanent` `claude_login_required` so SessionManager
 * stops retrying and surfaces the session as errored.
 */
export class ClaudeTuiLoginRequiredError extends Error {
  constructor(sessionName: string) {
    super(`claude TUI requires re-authentication (run /login) — session=${sessionName}`);
    this.name = "ClaudeTuiLoginRequiredError";
  }
}

/** True iff the pane shows the loaded ready surface (marker + `❯` input line). */
function isReadySurface(pane: string): boolean {
  return pane.includes(READY_MARKER) && pane.split("\n").some((line) => USER_RE.test(line));
}

/**
 * Poll capture-pane until the bypass-permissions marker and a `❯` input prompt
 * line are visible. Resolves on success, throws on timeout.
 *
 * The ready surface is checked FIRST every poll. A loaded TUI always shows the
 * marker + input prompt, and on resume the captured pane ALSO re-renders prior
 * transcript -- which can quote modal/login strings. Checking ready first means
 * a healthy session is never mistaken for a modal (no stray keystroke) or for
 * the login wall (no false permanent failure) just because its visible history
 * mentions those words.
 *
 * Only before the ready surface exists do we handle the one-time interactive
 * prompts instead of deadlocking on them:
 * - the workspace trust prompt (acknowledged with Enter);
 * - the bypass-permissions warning (accept option 1, "Yes, I accept");
 * - the large-session "resume strategy" menu (select option 1, "Resume from
 *   summary", so over-threshold sessions resume from a summary).
 * The login wall is NOT keystroke-answerable, so it throws
 * {@link ClaudeTuiLoginRequiredError} (classified `permanent`) to stop the
 * retry loop and surface to an operator rather than time out forever.
 */
export async function waitForReady(input: WaitForReadyInput): Promise<void> {
  const timeoutMs = input.timeoutMs ?? 30_000;
  const pollIntervalMs = input.pollIntervalMs ?? 250;
  const summaryReadyTimeoutMs = input.summaryReadyTimeoutMs ?? 120_000;
  const capture = input.capture ?? capturePane;
  const send = input.send ?? sendKey;
  const started = Date.now();
  let deadline = started + timeoutMs;
  let acceptedWorkspaceTrust = false;
  let acceptedBypassWarning = false;
  let acceptedResumeSummary = false;
  while (Date.now() < deadline) {
    // The TUI prints U+00A0 (NBSP) inside its chrome (see tui-markers.ts);
    // normalize to ASCII space once so every substring match below is robust
    // to that, regardless of which gaps Claude renders as NBSP.
    const pane = (await capture(input.name)).replace(/\u00A0/g, " ");
    // Ready wins over every modal/login check below -- see the function doc:
    // a ready pane can also show prior transcript that quotes those strings.
    if (isReadySurface(pane)) {
      return;
    }
    // Not ready yet. An unanswerable login wall can't be keystroked away; fail
    // fast and let the taxonomy mark it permanent so we stop retrying forever.
    if (isClaudeLoginWall(pane)) {
      throw new ClaudeTuiLoginRequiredError(input.name);
    }
    if (!acceptedWorkspaceTrust && isWorkspaceTrustPrompt(pane)) {
      acceptedWorkspaceTrust = true;
      await send(input.name, "Enter");
      await new Promise((r) => setTimeout(r, pollIntervalMs));
      continue;
    }
    if (!acceptedBypassWarning && isBypassPermissionsWarning(pane)) {
      acceptedBypassWarning = true;
      // Accept by selecting option 1 ("Yes, I accept") explicitly by number.
      // We must NOT rely on Enter hitting the default highlight here: if the
      // modal ever defaulted to "No, exit", a bare Enter would QUIT claude.
      // "1" pins the affirmative option; if number-select is unsupported it is
      // ignored and Enter falls on the default (the affirmative option 1, as
      // with the trust dialog).
      await send(input.name, "1");
      await new Promise((r) => setTimeout(r, 100));
      await send(input.name, "Enter");
      await new Promise((r) => setTimeout(r, pollIntervalMs));
      continue;
    }
    if (!acceptedResumeSummary && isResumeSummaryPrompt(pane)) {
      acceptedResumeSummary = true;
      // Select option 1 ("Resume from summary") explicitly by its number rather
      // than relying on Enter hitting the default highlight: it pins the
      // over-threshold path to a summary even if a future build reorders or
      // re-highlights the menu. (If number-select is unsupported, the "1" is
      // ignored and Enter still falls on the recommended default -- option 1.)
      await send(input.name, "1");
      await new Promise((r) => setTimeout(r, 100));
      await send(input.name, "Enter");
      // Summary generation needs a fresh, longer window than a normal start,
      // or a large session answers the menu and still times out.
      deadline = Date.now() + summaryReadyTimeoutMs;
      await new Promise((r) => setTimeout(r, pollIntervalMs));
      continue;
    }
    await new Promise((r) => setTimeout(r, pollIntervalMs));
  }
  const waitedMs = Date.now() - started;
  throw new Error(`claude TUI did not become ready within ${waitedMs}ms (session=${input.name})`);
}

/**
 * Per-client tag embedded in every session name so each client process owns a
 * disjoint slice of the `ftth-` namespace. Derived from the trailing chars of
 * the client id (the unique hex in `client_<hex>`); stable across restarts of
 * the same client (so the sweep finds its own crashed-run leftovers) but
 * distinct from any other client / QA process.
 */
function clientTag(clientId: string): string {
  const s = sanitise(clientId);
  return s.length >= 4 ? s.slice(-8) : "nocid";
}

/** Prefix matching exactly the sessions a given client owns: `ftth-<clientTag>-`. */
export function ownedSessionPrefix(clientId: string): string {
  return `${TMUX_SESSION_PREFIX}${clientTag(clientId)}-`;
}

/**
 * Derive a deterministic, tmux-safe, collision-resistant session name from
 * `(clientId, agentId, chatId)`.
 *
 * The agent/chat component is a hash, not a truncated prefix: server agent ids
 * are uuidv7, whose leading chars are a millisecond timestamp, so two agents
 * created close together share the first 8 chars. Truncating would alias two
 * distinct peer agents in the same chat to one session name — and `startClaude`
 * kills any pre-existing session with that name, so one agent would tear down a
 * peer's live pane. A 12-hex (48-bit) SHA-256 slice gives uniform entropy
 * regardless of uuid structure; collisions are negligible. The output is hex
 * only, so it is inherently tmux-safe (no `:`/`.`). The client-owner prefix is
 * kept so the orphan sweep's prefix filter still matches.
 */
export function deriveSessionName(clientId: string, agentId: string, chatId: string): string {
  const digest = createHash("sha256").update(`${agentId} ${chatId}`).digest("hex").slice(0, 12);
  return `${ownedSessionPrefix(clientId)}${digest}`;
}

function sanitise(input: string): string {
  return input.replace(/[^A-Za-z0-9_-]/g, "").toLowerCase();
}
