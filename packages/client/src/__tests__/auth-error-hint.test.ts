import { describe, expect, it } from "vitest";
import {
  formatAuthHint,
  isAmpAuthError,
  isAntigravityAuthError,
  isClaudeAuthError,
  isCodexAuthError,
  isDeepseekAuthError,
  isGrokAuthError,
  isOpenCodeAuthError,
} from "../providers/handlers/auth-error-hint.js";

/**
 * Locks the behavioural contract of the auth-error hint module that
 * the codex and claude-code handlers both consume.
 *
 * `isCodexAuthError` must match every canonical wording the bundled
 * `@openai/codex` Rust binary emits when its refresh flow fails — the SDK
 * gives us no typed code, so substring matching is all we have. Drift in
 * either direction is bad: false positives mistranslate unrelated errors
 * into a "run codex login" hint; false negatives let a stale `auth.json`
 * surface as an opaque "ERROR - SDK" line that new users read as "First
 * Tree is broken."
 *
 * `isClaudeAuthError` is a thin equality check against the SDK's typed
 * `SDKAssistantMessageError` union and exists mainly so the codex and
 * claude-code handlers share a single source of truth for the auth-failure code.
 */
describe("isCodexAuthError", () => {
  it("matches every refresh-flow wording extracted from @openai/codex 0.125.0", () => {
    const authMessages = [
      "Your access token could not be refreshed because your refresh token was revoked. Please log out and sign in again.",
      "Your access token could not be refreshed because your refresh token has expired. Please log out and sign in again.",
      "Your access token could not be refreshed because your refresh token was already used. Please log out and sign in again.",
      "Your access token could not be refreshed because you have since logged out or signed in to another account. Please sign in again.",
      "Your access token could not be refreshed. Please log out and sign in again.",
      "Your authentication session could not be refreshed automatically. Please log out and sign in again.",
      "Token data is not available.",
    ];
    for (const msg of authMessages) {
      expect(isCodexAuthError(msg), `expected auth-error: ${msg}`).toBe(true);
    }
  });

  it("matches when the wording is wrapped in a longer SDK error envelope", () => {
    // ThreadError messages can be wrapped by upstream layers; the keyword
    // detector must still trigger on substring presence.
    expect(
      isCodexAuthError(
        "codex exec failed: Your access token could not be refreshed because your refresh token was revoked. Please log out and sign in again.",
      ),
    ).toBe(true);
  });

  it("does NOT match unrelated SDK errors", () => {
    const nonAuth = [
      "HTTP 500 Internal Server Error",
      "fetch failed",
      "ECONNRESET while reading response",
      "request timed out",
      "sandbox denied write to /etc/passwd",
      "context length exceeded",
      "The server is overloaded",
      "rate limit exceeded",
      "",
    ];
    for (const msg of nonAuth) {
      expect(isCodexAuthError(msg), `expected NOT auth-error: ${msg}`).toBe(false);
    }
  });

  it("returns false for the empty string", () => {
    expect(isCodexAuthError("")).toBe(false);
  });
});

describe("isClaudeAuthError", () => {
  it("matches the canonical SDKAssistantMessageError auth code", () => {
    expect(isClaudeAuthError("authentication_failed")).toBe(true);
  });

  it("does NOT match other SDKAssistantMessageError codes", () => {
    const nonAuth = [
      "oauth_org_not_allowed",
      "billing_error",
      "rate_limit",
      "overloaded",
      "invalid_request",
      "model_not_found",
      "server_error",
      "unknown",
      "max_output_tokens",
    ];
    for (const code of nonAuth) {
      expect(isClaudeAuthError(code), `expected NOT auth-error: ${code}`).toBe(false);
    }
  });

  it("returns false for undefined / empty", () => {
    expect(isClaudeAuthError(undefined)).toBe(false);
    expect(isClaudeAuthError("")).toBe(false);
  });
});

describe("isGrokAuthError", () => {
  it("matches every plausible logged-out Grok Build wording", () => {
    const authMessages = [
      "Error: not logged in. Run `grok login` to authenticate.",
      "not authenticated — please run grok login",
      "Error: authentication required",
      "Provider returned 401 Unauthorized",
      "Failed to read credentials from ~/.grok/auth.json",
    ];
    for (const msg of authMessages) {
      expect(isGrokAuthError(msg), `expected auth-error: ${msg}`).toBe(true);
    }
  });

  it("does NOT match unrelated failures (capacity / transport / input)", () => {
    const nonAuth = [
      "HTTP 429 Too Many Requests",
      "rate limit exceeded",
      "resource has been exhausted",
      "fetch failed",
      "context length exceeded",
      "",
    ];
    for (const msg of nonAuth) {
      expect(isGrokAuthError(msg), `expected NOT auth-error: ${msg}`).toBe(false);
    }
  });
});

describe("isAntigravityAuthError", () => {
  it("matches provider-owned headless auth failures without treating capacity as auth", () => {
    expect(isAntigravityAuthError("authentication required — run agy once to sign in")).toBe(true);
    expect(isAntigravityAuthError("Gemini API credential is missing")).toBe(true);
    expect(isAntigravityAuthError("HTTP 429 resource exhausted")).toBe(false);
    expect(isAntigravityAuthError("")).toBe(false);
  });
});

describe("isOpenCodeAuthError", () => {
  it("matches provider-owned credential failures without treating capacity failures as auth", () => {
    expect(isOpenCodeAuthError("Provider returned 401 Unauthorized: invalid API key")).toBe(true);
    expect(isOpenCodeAuthError("Run opencode auth login before using this provider")).toBe(true);
    expect(isOpenCodeAuthError("rate limit exceeded")).toBe(false);
    expect(isOpenCodeAuthError("")).toBe(false);
  });
});

describe("formatAuthHint — Antigravity", () => {
  it("targets the host-local agy login for the Antigravity runtime", () => {
    const hint = formatAuthHint("antigravity", "authentication required");
    expect(hint).toContain("antigravity");
    expect(hint).toContain("agy");
    expect(hint).toContain("Google Antigravity");
    expect(hint).toContain("not First Tree's");
  });
});

describe("isAmpAuthError", () => {
  it("matches provider-owned credential failures without treating capacity failures as auth", () => {
    expect(isAmpAuthError("Error: not logged in. Run `amp login` or set AMP_API_KEY.")).toBe(true);
    expect(isAmpAuthError("invalid api key")).toBe(true);
    expect(
      isAmpAuthError("No API key found. Starting login flow...\nIf your browser does not open automatically, visit:"),
    ).toBe(true);
    expect(isAmpAuthError("rate limit exceeded")).toBe(false);
    expect(isAmpAuthError("")).toBe(false);
  });
});

describe("isDeepseekAuthError", () => {
  it("matches provider-owned credential failures without treating capacity failures as auth", () => {
    expect(isDeepseekAuthError("MISSING_CREDENTIAL: set DEEPSEEK_API_KEY")).toBe(true);
    expect(isDeepseekAuthError("DEEPSEEK_API_KEY=secret not authenticated")).toBe(true);
    expect(isDeepseekAuthError("rate limit exceeded")).toBe(false);
    expect(isDeepseekAuthError("")).toBe(false);
  });
});

describe("formatAuthHint", () => {
  it("targets `codex login` for the codex runtime and quotes the original SDK message", () => {
    const hint = formatAuthHint(
      "codex",
      "Your access token could not be refreshed because your refresh token was revoked. Please log out and sign in again.",
    );
    expect(hint).toContain("codex");
    expect(hint).toContain("`codex login`");
    expect(hint).toContain("OpenAI");
    expect(hint).toContain("not First Tree's");
    expect(hint).toContain("refresh token was revoked");
  });

  it("targets `claude auth login` for the claude-code runtime", () => {
    const hint = formatAuthHint("claude-code", "authentication_failed");
    expect(hint).toContain("claude-code");
    expect(hint).toContain("`claude auth login`");
    expect(hint).toContain("Anthropic");
    expect(hint).toContain("not First Tree's");
    expect(hint).toContain("authentication_failed");
  });

  it("targets `grok login` for the grok runtime and names Grok Build", () => {
    const hint = formatAuthHint("grok", "Error: not logged in. Run `grok login` to authenticate.");
    expect(hint).toContain("grok");
    expect(hint).toContain("`grok login`");
    expect(hint).toContain("Grok Build");
    expect(hint).toContain("not First Tree's");
    expect(hint).toContain("not logged in");
  });

  it("keeps Amp authentication host-local and points at the provider-owned login", () => {
    const hint = formatAuthHint("amp", "Error: not logged in. Run `amp login`.");
    expect(hint).toContain("amp");
    expect(hint).toContain("`amp login`");
    expect(hint).toContain("Amp");
    expect(hint).toContain("not First Tree's");
  });

  it("keeps DeepSeek authentication host-local and points at DEEPSEEK_API_KEY setup", () => {
    const hint = formatAuthHint("deepseek-harness", "MISSING_CREDENTIAL: set DEEPSEEK_API_KEY");
    expect(hint).toContain("deepseek-harness");
    expect(hint).toContain("DEEPSEEK_API_KEY");
    expect(hint).toContain("DeepSeek");
    expect(hint).toContain("not First Tree's");
    expect(hint).toContain("Runtime → Environment variables");
    expect(hint).toContain("Mark as sensitive");
  });

  it("keeps OpenCode authentication host-local and points at the provider-owned login", () => {
    const hint = formatAuthHint("opencode", "Provider returned 401 Unauthorized");
    expect(hint).toContain("opencode");
    expect(hint).toContain("`opencode auth login`");
    expect(hint).toContain("OpenCode's selected provider");
    expect(hint).toContain("not First Tree's");
  });

  it("keeps Pi authentication host-local and points at the provider-owned login", () => {
    const hint = formatAuthHint("pi", "Please run /login");
    expect(hint).toContain("pi");
    expect(hint).toContain("`pi` and then `/login`");
    expect(hint).toContain("Pi");
    expect(hint).toContain("not First Tree's");
  });

  it("falls back to a placeholder when the SDK gives no message", () => {
    const hint = formatAuthHint("codex", "");
    expect(hint).toContain("(no message from SDK)");
  });

  it("caps an oversized SDK error envelope so the hint stays readable in the timeline", () => {
    // Codex error envelopes can occasionally include a wrapped stack trace
    // that runs into the tens of KB. The hint should remain bounded.
    const giantMessage = "x".repeat(5000);
    const hint = formatAuthHint("codex", giantMessage);
    expect(hint.length).toBeLessThan(2000);
    expect(hint).toContain("Original SDK error:");
    // The original message we DO include should be capped, not absent.
    expect(hint).toMatch(/x{500,}/);
  });
});
