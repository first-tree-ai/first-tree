/**
 * Translate runtime SDK auth-failure messages into a chat-timeline hint that
 * points the user at the right re-login command on their own machine.
 *
 * We never touch the runtime's credential file — codex owns `~/.codex/auth.json`
 * and claude owns its own credential store. The boundary here is one-way:
 * detect the failure, ask the user to fix it via the runtime's native CLI.
 *
 * Why this exists: a stale `~/.codex/auth.json` (e.g. from an older install or
 * a logged-out ChatGPT account) surfaces inside First Tree's chat as an
 * opaque "ERROR - SDK" line that mentions nothing First-Tree-shaped. New users
 * read it as "First Tree is broken" and have no idea the fix lives in OpenAI's
 * CLI. The hint reframes the message so the next step is obvious.
 */

import {
  type RuntimeProvider,
  runtimeProviderAuthOwnerLabel,
  runtimeProviderChatAuthLoginPhrase,
  runtimeProviderPreferredCredentialProse,
} from "@first-tree/shared";

type Runtime = Exclude<RuntimeProvider, "claude-code-tui">;

/**
 * Substring keywords used to detect codex's auth-refresh failures. Codex's
 * SDK exposes only `{ message: string }` (no typed error code), so we match
 * on the english phrases that appear across every variant the bundled Rust
 * binary emits ("...refresh token was revoked...", "...refresh token has
 * expired...", "...could not be refreshed...", "...Please log out and sign
 * in again...", "...Token data is not available..."). All seven phrases
 * below were extracted via `strings` from
 * `node_modules/@openai/codex/vendor/*\/codex/codex` at codex-sdk 0.125.0.
 *
 * Order matters for auditability (not for correctness — we use `some`):
 * the most-specific phrases come first so any canonical codex message hits
 * a specific keyword before falling through to the broader "...sign in
 * again..." / "...log in again..." catches. Future codex copy changes that
 * remove a specific phrase but keep one of the generic tails will still
 * trip detection.
 *
 * Claude-code does NOT use this — it ships a typed `SDKAssistantMessageError`
 * union (see `isClaudeAuthError`).
 */
const CODEX_AUTH_KEYWORDS: readonly string[] = [
  "could not be refreshed",
  "refresh token",
  "log out and sign in",
  "Token data is not available",
  "sign in again",
  "log in again",
];

export function isCodexAuthError(message: string): boolean {
  if (message.length === 0) return false;
  const lower = message.toLowerCase();
  return CODEX_AUTH_KEYWORDS.some((kw) => lower.includes(kw.toLowerCase()));
}

/**
 * Cursor Agent CLI auth-failure phrases. The CLI exposes no typed error code
 * in headless mode — a logged-out turn exits 1 with stderr like
 * "Error: Authentication required. Please run 'agent login' first, or set
 * CURSOR_API_KEY environment variable." (captured verbatim in Phase 0).
 */
const CURSOR_AUTH_KEYWORDS: readonly string[] = [
  "authentication required",
  "not logged in",
  "please run 'agent login'",
  "cursor_api_key",
];

export function isCursorAuthError(message: string): boolean {
  if (message.length === 0) return false;
  const lower = message.toLowerCase();
  return CURSOR_AUTH_KEYWORDS.some((kw) => lower.includes(kw));
}

/**
 * Grok Build CLI auth-failure phrases. The CLI exposes no typed error code —
 * a logged-out turn fails with prose along the lines of "Error: not logged
 * in. Run `grok login` to authenticate." or an unauthorized response, and a
 * corrupt credential store is reported by naming `auth.json`. First Tree
 * never opens `~/.grok/auth.json`; detection is purely output substring
 * matching, mirroring the cursor approach.
 */
const GROK_AUTH_KEYWORDS: readonly string[] = [
  "not logged in",
  "not authenticated",
  "authentication required",
  "unauthorized",
  "grok login",
  "auth.json",
];

export function isGrokAuthError(message: string): boolean {
  if (message.length === 0) return false;
  const lower = message.toLowerCase();
  return GROK_AUTH_KEYWORDS.some((kw) => lower.includes(kw));
}

const ANTIGRAVITY_AUTH_KEYWORDS: readonly string[] = [
  "authentication required",
  "not authenticated",
  "unauthorized",
  "sign in",
  "login required",
  "credential",
  "gemini_api_key",
  "token missing",
  "token expired",
  "invalid token",
];

export function isAntigravityAuthError(message: string): boolean {
  if (message.length === 0) return false;
  const lower = message.toLowerCase();
  return ANTIGRAVITY_AUTH_KEYWORDS.some((keyword) => lower.includes(keyword));
}

export function isKimiCodeAuthError(codeOrMessage: string): boolean {
  const lower = codeOrMessage.toLowerCase();
  return (
    lower.startsWith("auth.") ||
    lower.includes(" auth.") ||
    lower.includes("provider.auth_error") ||
    lower.includes("login required") ||
    lower.includes("not authenticated")
  );
}

const OPENCODE_AUTH_KEYWORDS: readonly string[] = [
  "authentication required",
  "not authenticated",
  "unauthorized",
  "invalid api key",
  "missing api key",
  "auth login",
  "provider.auth",
];

export function isOpenCodeAuthError(message: string): boolean {
  const lower = message.toLowerCase();
  return OPENCODE_AUTH_KEYWORDS.some((keyword) => lower.includes(keyword));
}

const PI_AUTH_KEYWORDS: readonly string[] = [
  "/login",
  "not authenticated",
  "unauthorized",
  "missing credentials",
  "no api key",
  "auth required",
];

export function isPiAuthError(message: string): boolean {
  const lower = message.toLowerCase();
  return PI_AUTH_KEYWORDS.some((keyword) => lower.includes(keyword));
}

const AMP_AUTH_KEYWORDS: readonly string[] = [
  "amp login",
  "amp_api_key",
  "not logged in",
  "not authenticated",
  "authentication required",
  "unauthorized",
  "invalid api key",
  "missing api key",
  // Official CLI absent-key / login-flow stdout (non-zero): "No API key found.
  // Starting login flow...". That wording contains neither `amp login` nor
  // `AMP_API_KEY` nor the existing `missing api key` substring.
  "no api key found",
  "starting login flow",
];

export function isAmpAuthError(message: string): boolean {
  if (message.length === 0) return false;
  const lower = message.toLowerCase();
  return AMP_AUTH_KEYWORDS.some((keyword) => lower.includes(keyword));
}

const DEEPSEEK_AUTH_KEYWORDS: readonly string[] = [
  "deepseek_api_key",
  "missing_credential",
  "missing api key",
  "not authenticated",
  "authentication required",
  "unauthorized",
  "invalid api key",
  "invalid_credential",
];

export function isDeepseekAuthError(message: string): boolean {
  if (message.length === 0) return false;
  const lower = message.toLowerCase();
  return DEEPSEEK_AUTH_KEYWORDS.some((keyword) => lower.includes(keyword));
}

/**
 * The single auth-failure code claude-code's SDK reports (out of the
 * `SDKAssistantMessageError` union). Centralised here so both the assistant-
 * message path and the api_retry path can share one check.
 */
export function isClaudeAuthError(code: string | undefined): boolean {
  return code === "authentication_failed";
}

/**
 * Build the chat-timeline message we want the user to see when an auth
 * failure is detected. Includes the raw SDK error verbatim so the user can
 * paste it into a support thread without losing detail. The hint is short
 * and points at the runtime's own CLI — we do NOT advertise a First Tree
 * UI button or relogin flow, by design.
 */
export function formatAuthHint(
  runtime: Runtime,
  originalMessage: string,
  options: { loginCommand?: string } = {},
): string {
  // Login / owner copy comes from the shared runtime-provider catalog so the
  // in-chat hint stays aligned with Computers setup and other surfaces.
  const reauth = options.loginCommand ? `\`${options.loginCommand}\`` : runtimeProviderChatAuthLoginPhrase(runtime);
  const provider = runtimeProviderAuthOwnerLabel(runtime);
  const preferred = runtimeProviderPreferredCredentialProse(runtime);
  // Cap the appended raw message so an upstream stack-trace envelope (codex
  // wraps its `event.error.message` in surprising ways) doesn't bloat the
  // hint into a wall of text on the chat timeline.
  const trimmed = originalMessage.trim().slice(0, ORIGINAL_MESSAGE_CAP);
  const original = trimmed.length > 0 ? trimmed : "(no message from SDK)";
  const recovery = preferred
    ? `${preferred} (or run ${reauth} in the host shell)`
    : `please run ${reauth} in your terminal to re-authenticate`;
  return (
    `${runtime} auth on this machine looks broken or expired. ` +
    `This is ${provider}'s auth state, not First Tree's — ` +
    `${recovery}, then retry. ` +
    `Original SDK error: ${original}`
  );
}

const ORIGINAL_MESSAGE_CAP = 1000;
