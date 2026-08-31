import type { ProviderRetryScope, ReplaySafety, RuntimeProvider } from "@first-tree/shared";
import { describe, expect, it } from "vitest";
import { SdkError } from "../cloud/sdk.js";
import { ManagedSkillsUnsafeDiscoveryError } from "../runtime/managed-skills.js";
import {
  buildProviderRetryEvent,
  classifyProviderFailure,
  decideProviderRetry,
  isExhaustedCapacityPhrasing,
  MANAGED_SKILLS_UNSAFE_DISCOVERY_REASON_CODE,
  type ProviderFailureClassification,
} from "../runtime/provider-retry-policy.js";

class FakeRateLimit extends Error {
  override name = "RateLimitError";
  status = 429;
}

function classification(category: ProviderFailureClassification["category"], reasonCode: string = category) {
  return {
    category,
    reasonCode,
    message: reasonCode,
    sourceKind: "transient",
  } satisfies ProviderFailureClassification;
}

function decide(input: {
  category: ProviderFailureClassification["category"];
  scope?: ProviderRetryScope;
  attempt?: number;
  retryAfterMs?: number;
  replaySafety?: ReplaySafety;
  reasonCode?: string;
}) {
  return decideProviderRetry({
    classification: classification(input.category, input.reasonCode),
    scope: input.scope ?? "provider_turn",
    attempt: input.attempt ?? 1,
    retryAfterMs: input.retryAfterMs,
    replaySafety: input.replaySafety ?? "pre_visible",
  });
}

describe("classifyProviderFailure", () => {
  it("routes runtime-session proof failures to bind recovery before generic 403 credentials", () => {
    for (const [code, reasonCode] of [
      ["AGENT_RUNTIME_SESSION_MISSING", "runtime_session_missing"],
      ["AGENT_RUNTIME_SESSION_INVALID", "runtime_session_invalid"],
    ] as const) {
      const c = classifyProviderFailure(new SdkError(403, "Forbidden", { code }), {
        provider: "codex",
        scope: "provider_turn",
        source: "sdk",
      });
      expect(c).toMatchObject({ category: "runtime_transport", reasonCode });
      expect(
        decideProviderRetry({
          classification: c,
          scope: "provider_turn",
          attempt: 1,
          replaySafety: "unknown",
        }),
      ).toMatchObject({
        action: "stop",
        reasonCode,
        terminalKind: "runtime_rebind_required",
        userSeverity: "warning",
      });
    }
  });

  it("recognizes legacy runtime-proof messages during a rolling server upgrade", () => {
    expect(
      classifyProviderFailure(Object.assign(new Error("Invalid agent runtime session"), { statusCode: 403 }), {
        provider: "claude-code",
        scope: "session_start",
        source: "sdk",
      }),
    ).toMatchObject({ category: "runtime_transport", reasonCode: "runtime_session_invalid" });
  });

  it("maps provider rate limits to provider_capacity", () => {
    expect(
      classifyProviderFailure(new FakeRateLimit("rate limited"), {
        provider: "claude-code",
        scope: "provider_turn",
        source: "stream",
      }),
    ).toMatchObject({ category: "provider_capacity", reasonCode: "provider_rate_limited" });
  });

  it("carries Retry-After into session capacity retry scheduling", () => {
    const err = Object.assign(new Error("Rate limit exceeded, retry in 53 seconds"), {
      statusCode: 429,
      retryAfterMs: 53_000,
    });
    const c = classifyProviderFailure(err, {
      provider: "codex",
      scope: "session_start",
      source: "sdk",
    });
    expect(c).toMatchObject({
      category: "provider_capacity",
      reasonCode: "provider_rate_limited",
      retryAfterMs: 53_000,
    });
    expect(
      decideProviderRetry({
        classification: c,
        scope: "session_start",
        attempt: 1,
        replaySafety: "pre_provider",
      }),
    ).toMatchObject({ action: "retry", delayMs: 53_000, retryMode: "background" });
  });

  it("maps Claude session limits to unrecoverable provider capacity", () => {
    const c = classifyProviderFailure(new Error("You've hit your session limit \u00b7 resets 9:50pm (Asia/Shanghai)"), {
      provider: "claude-code",
      scope: "provider_turn",
      source: "stream",
    });
    expect(c).toMatchObject({ category: "provider_capacity", reasonCode: "provider_usage_limit" });
    expect(
      decideProviderRetry({
        classification: c,
        scope: "provider_turn",
        attempt: 1,
        replaySafety: "provider_entered",
      }),
    ).toMatchObject({
      action: "stop",
      reasonCode: "capacity_wait_required",
      terminalKind: "capacity_wait_required",
    });
  });

  it("maps billing and account-balance errors to provider billing capacity before generic 403 credential", () => {
    const cases = [
      Object.assign(new Error("Failed to authenticate. API Error: 403 Insufficient account balance."), { status: 403 }),
      Object.assign(new Error("Credit balance is too low"), { statusCode: 403 }),
      Object.assign(new Error("billing_error"), { status: 403 }),
    ];

    for (const err of cases) {
      const c = classifyProviderFailure(err, {
        provider: "claude-code",
        scope: "provider_turn",
        source: "sdk",
      });
      expect(c).toMatchObject({ category: "provider_capacity", reasonCode: "provider_billing_limit" });
      expect(
        decideProviderRetry({
          classification: c,
          scope: "provider_turn",
          attempt: 1,
          replaySafety: "provider_entered",
        }),
      ).toMatchObject({
        action: "stop",
        reasonCode: "provider_billing_limit",
        terminalKind: "capacity_wait_required",
      });
    }
  });

  it("maps network and 5xx failures to transient_transport", () => {
    for (const err of [
      new Error("fetch failed"),
      new Error("API Error: Unable to connect to API (ConnectionRefused)"),
      Object.assign(new Error("upstream 503"), { status: 503 }),
    ]) {
      expect(classifyProviderFailure(err, { provider: "codex", scope: "provider_turn", source: "sdk" }).category).toBe(
        "transient_transport",
      );
    }
  });

  it("maps Codex service-tier omission to a terminal configuration failure", () => {
    const classification = classifyProviderFailure(
      new Error(
        "Configured service tier `fast` is not advertised as supported for model `gpt-test` and will be omitted from requests.",
      ),
      { provider: "codex", scope: "provider_turn", source: "sdk" },
    );
    expect(classification).toMatchObject({
      category: "configuration",
      reasonCode: "codex_service_tier_unsupported",
    });
    expect(
      decideProviderRetry({
        classification,
        scope: "provider_turn",
        attempt: 1,
        replaySafety: "pre_provider",
      }),
    ).toMatchObject({
      action: "stop",
      reasonCode: "codex_service_tier_unsupported",
      terminalKind: "needs_operator",
    });
  });

  it("classifies Kimi's stable SDK error codes without depending on prose", () => {
    const classifyKimi = (code: string) =>
      classifyProviderFailure(Object.assign(new Error("provider stopped"), { code }), {
        provider: "kimi-code",
        scope: "provider_turn",
        source: "sdk",
      });

    expect(classifyKimi("auth.login_required")).toMatchObject({ category: "credential" });
    expect(classifyKimi("provider.rate_limit")).toMatchObject({ category: "provider_capacity" });
    expect(classifyKimi("provider.connection_error")).toMatchObject({ category: "transient_transport" });
    expect(classifyKimi("model.not_configured")).toMatchObject({ category: "configuration" });
    expect(classifyKimi("model.config_invalid")).toMatchObject({ category: "configuration" });
  });

  it("a transient codex --version verify flake is retried at session start, NOT a terminal capability failure", () => {
    const err = new Error(
      "codex --version smoke check did not complete (transient host condition); will retry. Detail: `codex --version` timed out",
    );
    err.name = "CodexBinaryVerifyTransientError";
    const c = classifyProviderFailure(err, { provider: "codex", scope: "session_start", source: "session" });
    // The regression: this used to land in `capability` → needs_operator →
    // terminal. It must now be transient_transport so the bring-up retries.
    expect(c.category).toBe("transient_transport");
    expect(c.reasonCode).toBe("codex_verify_transient");
    expect(
      decideProviderRetry({ classification: c, scope: "session_start", attempt: 1, replaySafety: "pre_provider" }),
    ).toMatchObject({ action: "retry" });
  });

  it("a bounded all-candidate Codex launch failure stops as a user-actionable capability error", () => {
    const err = new Error(
      "Codex runtime binary candidates are installed but unusable. Checked: `/Users/test/.npm-global/bin/codex` (`codex --version` killed by SIGKILL). Upgrade or replace the failing Codex installation.",
    );
    err.name = "CodexBinaryUnusableError";
    const classification = classifyProviderFailure(err, {
      provider: "codex",
      scope: "session_start",
      source: "session",
    });
    expect(classification).toMatchObject({
      category: "capability",
      reasonCode: "codex_binary_unusable",
    });
    expect(
      decideProviderRetry({
        classification,
        scope: "session_start",
        attempt: 3,
        replaySafety: "pre_provider",
      }),
    ).toMatchObject({
      action: "stop",
      reasonCode: "codex_binary_unusable",
      terminalKind: "needs_operator",
    });
  });

  it("classifies Grok Build logged-out phrasings as credential, grok-gated", () => {
    for (const message of [
      "Error: not logged in. Run `grok login` to authenticate.",
      "Failed to read credentials from ~/.grok/auth.json",
    ]) {
      const c = classifyProviderFailure(new Error(message), {
        provider: "grok",
        scope: "provider_turn",
        source: "sdk",
      });
      expect(c, message).toMatchObject({ category: "credential" });
      expect(
        decideProviderRetry({ classification: c, scope: "provider_turn", attempt: 1, replaySafety: "pre_provider" }),
      ).toMatchObject({ action: "stop", terminalKind: "needs_operator" });
    }
    // The same wording under ANOTHER provider must not trip the grok-only
    // branch (the in-chat re-login CTA keys off category=credential).
    const other = classifyProviderFailure(new Error("not logged in"), {
      provider: "codex",
      scope: "provider_turn",
      source: "sdk",
    });
    expect(other.category).not.toBe("credential");
  });

  it("classifies Grok Build 429 / exhaustion phrasings as provider capacity, grok-gated", () => {
    for (const message of [
      "HTTP 429 Too Many Requests",
      "Error: resource has been exhausted (rate limit budget spent)",
    ]) {
      const c = classifyProviderFailure(new Error(message), {
        provider: "grok",
        scope: "provider_turn",
        source: "sdk",
      });
      expect(c, message).toMatchObject({ category: "provider_capacity", reasonCode: "provider_rate_limited" });
    }
    // "resource has been exhausted" is not reserved capacity-speak for other
    // providers — the branch stays provider-gated (grok/pi only).
    const other = classifyProviderFailure(new Error("resource has been exhausted"), {
      provider: "codex",
      scope: "provider_turn",
      source: "sdk",
    });
    expect(other.category).not.toBe("provider_capacity");
  });

  it("classifies Pi 429 / exhaustion phrasings as provider capacity via the shared provider-scoped rule", () => {
    for (const message of ["too many requests", "resource has been exhausted"]) {
      const c = classifyProviderFailure(new Error(message), {
        provider: "pi",
        scope: "provider_turn",
        source: "sdk",
      });
      // The same provider-scoped rule the Pi sanitizer (pi_capacity_limited)
      // uses must drive the shared classifier, so retry delay and the durable
      // notice agree instead of falling through to unknown/unknown_exhausted.
      expect(c, message).toMatchObject({ category: "provider_capacity", reasonCode: "provider_rate_limited" });
      expect(
        decideProviderRetry({ classification: c, scope: "session_start", attempt: 1, replaySafety: "pre_provider" }),
      ).toMatchObject({ action: "retry" });
    }
    // One predicate, both consumers; still not reserved for other providers.
    expect(isExhaustedCapacityPhrasing("pi", "too many requests")).toBe(true);
    expect(isExhaustedCapacityPhrasing("pi", "resource has been exhausted")).toBe(true);
    expect(isExhaustedCapacityPhrasing("grok", "too many requests")).toBe(true);
    expect(isExhaustedCapacityPhrasing("codex", "too many requests")).toBe(false);
    expect(isExhaustedCapacityPhrasing("kimi-code", "resource has been exhausted")).toBe(false);
  });

  it("a transient grok --version verify flake is retried at session start, NOT a terminal capability failure", () => {
    const err = new Error(
      "grok --version smoke check did not complete (transient host condition); will retry. Detail: `grok --version` timed out",
    );
    err.name = "GrokBinaryVerifyTransientError";
    const c = classifyProviderFailure(err, { provider: "grok", scope: "session_start", source: "session" });
    expect(c.category).toBe("transient_transport");
    expect(c.reasonCode).toBe("grok_verify_transient");
    expect(
      decideProviderRetry({ classification: c, scope: "session_start", attempt: 1, replaySafety: "pre_provider" }),
    ).toMatchObject({ action: "retry" });
  });

  it("a genuinely missing grok binary stays terminal needs_operator (no false retry)", () => {
    const err = new Error(
      "Grok Build CLI is missing on this machine. First Tree does not bundle or install the Grok engine.",
    );
    const c = classifyProviderFailure(err, { provider: "grok", scope: "session_start", source: "session" });
    expect(c.category).toBe("capability");
    expect(c.reasonCode).toBe("grok_binary_missing");
    expect(
      decideProviderRetry({ classification: c, scope: "session_start", attempt: 1, replaySafety: "pre_provider" }),
    ).toMatchObject({ action: "stop", terminalKind: "needs_operator" });
  });

  it("classifies Antigravity missing/auth/protocol failures deterministically", () => {
    const missing = classifyProviderFailure(new Error("Antigravity CLI is missing on this machine"), {
      provider: "antigravity",
      scope: "session_start",
      source: "session",
    });
    expect(missing).toMatchObject({ category: "capability", reasonCode: "antigravity_binary_missing" });

    const auth = classifyProviderFailure(new Error("Antigravity returned an authentication required error"), {
      provider: "antigravity",
      scope: "provider_turn",
      source: "stream",
    });
    expect(auth).toMatchObject({ category: "credential" });

    const protocol = classifyProviderFailure(new Error("expected one conversation ID, observed none"), {
      provider: "antigravity",
      scope: "provider_turn",
      source: "stream",
    });
    expect(protocol).toMatchObject({ category: "configuration", reasonCode: "antigravity_protocol_error" });

    const platform = classifyProviderFailure(new Error("Antigravity is not supported on Windows in v1"), {
      provider: "antigravity",
      scope: "session_start",
      source: "session",
    });
    expect(platform).toMatchObject({ category: "capability", reasonCode: "antigravity_platform_unsupported" });
  });

  it("classifies Pi credential phrasings as needs_operator and does not unknown-retry them", () => {
    for (const message of ["missing credentials", "No API key configured", "run /login to continue"]) {
      const c = classifyProviderFailure(new Error(message), {
        provider: "pi",
        scope: "provider_turn",
        source: "sdk",
      });
      expect(c, message).toMatchObject({ category: "credential" });
      expect(
        decideProviderRetry({ classification: c, scope: "provider_turn", attempt: 1, replaySafety: "pre_provider" }),
      ).toMatchObject({ action: "stop", terminalKind: "needs_operator" });
    }
  });

  it("classifies Pi missing/unsupported/platform failures as permanent capability", () => {
    const missing = classifyProviderFailure(
      new Error("Pi CLI is missing on this machine. First Tree does not bundle or install Pi"),
      { provider: "pi", scope: "session_start", source: "session" },
    );
    expect(missing).toMatchObject({ category: "capability", reasonCode: "pi_binary_missing" });

    const unsupported = classifyProviderFailure(
      new Error("Pi runtime provider mismatch: unsupported version. First Tree requires >=0.80.5 <1.0.0"),
      { provider: "pi", scope: "session_start", source: "session" },
    );
    expect(unsupported).toMatchObject({ category: "capability", reasonCode: "pi_binary_unsupported" });

    const windows = classifyProviderFailure(
      new Error("Pi runtime provider is not supported on Windows in V1 (macOS/Linux only)"),
      { provider: "pi", scope: "session_start", source: "session" },
    );
    expect(windows).toMatchObject({ category: "capability", reasonCode: "pi_platform_unsupported" });

    for (const c of [missing, unsupported, windows]) {
      expect(
        decideProviderRetry({ classification: c, scope: "session_start", attempt: 1, replaySafety: "pre_provider" }),
      ).toMatchObject({ action: "stop", terminalKind: "needs_operator" });
    }
  });

  it("classifies Pi protocol/get_state failures as terminal capability", () => {
    for (const message of [
      "Pi session identity mismatch: expected abc, get_state reported wrong",
      "pi get_state response missing data object",
      "pi get_state response missing sessionId",
    ]) {
      const err = Object.assign(new Error(message), {
        name: message.includes("missing") ? "PiRpcProtocolError" : "Error",
      });
      if (message.includes("session identity")) err.name = "PiRpcProtocolError";
      const c = classifyProviderFailure(err, {
        provider: "pi",
        scope: "provider_turn",
        source: "session",
      });
      expect(c, message).toMatchObject({
        category: "capability",
        reasonCode: "pi_protocol_error",
      });
      expect(
        decideProviderRetry({ classification: c, scope: "provider_turn", attempt: 1, replaySafety: "pre_provider" }),
      ).toMatchObject({ action: "stop", terminalKind: "needs_operator" });
    }
  });

  it("classifies Pi model configuration phrases as terminal configuration", () => {
    for (const message of [
      "Pi model selector is invalid: bad",
      "Pi model mismatch: configured openai-codex/gpt-test, get_state reported anthropic/gpt-test",
      "Pi thinkingLevel mismatch: configured high, get_state reported low",
    ]) {
      const c = classifyProviderFailure(new Error(message), {
        provider: "pi",
        scope: "provider_turn",
        source: "session",
      });
      expect(c, message).toMatchObject({
        category: "configuration",
        reasonCode: "pi_model_configuration_error",
      });
      expect(
        decideProviderRetry({ classification: c, scope: "provider_turn", attempt: 1, replaySafety: "pre_provider" }),
      ).toMatchObject({ action: "stop", terminalKind: "needs_operator" });
      // Must not leak into other providers as configuration.
      expect(
        classifyProviderFailure(new Error(message), { provider: "codex", scope: "provider_turn", source: "session" }),
      ).toMatchObject({ category: "unknown", reasonCode: "unknown" });
    }
  });

  it("classifies an invalid Amp mode as terminal configuration", () => {
    const message = 'amp_mode_invalid: Amp --mode must be one of low, medium, high, ultra; received "claude-opus-4.6"';
    const c = classifyProviderFailure(new Error(message), {
      provider: "amp",
      scope: "provider_turn",
      source: "stream",
    });
    expect(c).toMatchObject({
      category: "configuration",
      reasonCode: "provider_configuration_error",
    });
    expect(
      decideProviderRetry({ classification: c, scope: "provider_turn", attempt: 1, replaySafety: "pre_provider" }),
    ).toMatchObject({ action: "stop", terminalKind: "needs_operator" });
    expect(
      classifyProviderFailure(new Error(message), { provider: "codex", scope: "provider_turn", source: "session" }),
    ).toMatchObject({ category: "unknown", reasonCode: "unknown" });
  });

  it("retries Pi version-probe timeout as transient transport", () => {
    const err = new Error(
      "pi --version smoke check did not complete (transient host condition); will retry. Detail: `pi --version` timed out",
    );
    err.name = "PiBinaryVerifyTransientError";
    const c = classifyProviderFailure(err, { provider: "pi", scope: "session_start", source: "session" });
    expect(c).toMatchObject({ category: "transient_transport", reasonCode: "pi_verify_transient" });
    expect(
      decideProviderRetry({ classification: c, scope: "session_start", attempt: 1, replaySafety: "pre_provider" }),
    ).toMatchObject({ action: "retry" });
  });

  it("a codex backend AbortSignal.timeout is transient_transport and retried", () => {
    const err = new DOMException("The operation was aborted due to timeout", "TimeoutError");
    const c = classifyProviderFailure(err, { provider: "codex", scope: "provider_turn", source: "sdk" });
    expect(c.category).toBe("transient_transport");
    expect(c.reasonCode).toBe("operation_timeout");
    expect(
      decideProviderRetry({ classification: c, scope: "provider_turn", attempt: 1, replaySafety: "pre_provider" }),
    ).toMatchObject({ action: "retry" });
  });

  it.each([
    "session_start",
    "session_resume",
  ] as const)("classifies managed-Skill unsafe discovery by stable identity and retries %s indefinitely with bounded backoff", (scope) => {
    const classified = classifyProviderFailure(new ManagedSkillsUnsafeDiscoveryError("opaque safety detail"), {
      provider: "opencode",
      scope,
      source: "session",
    });
    expect(classified).toMatchObject({
      category: "transient_transport",
      reasonCode: MANAGED_SKILLS_UNSAFE_DISCOVERY_REASON_CODE,
    });

    for (const [attempt, delayMs, retryMode] of [
      [1, 1_000, "foreground"],
      [2, 2_000, "foreground"],
      [3, 4_000, "foreground"],
      [20, 60_000, "background"],
    ] as const) {
      expect(
        decideProviderRetry({
          classification: classified,
          scope,
          attempt,
          replaySafety: "pre_provider",
        }),
      ).toMatchObject({
        action: "retry",
        attempt,
        delayMs,
        retryMode,
        reasonCode: MANAGED_SKILLS_UNSAFE_DISCOVERY_REASON_CODE,
      });
    }

    expect(
      decideProviderRetry({
        classification: classified,
        scope: "provider_turn",
        attempt: 1,
        replaySafety: "user_visible",
      }),
    ).toMatchObject({
      action: "stop",
      reasonCode: "unsafe_replay",
      terminalKind: "unsafe_replay",
    });
  });

  it("a genuinely missing codex binary stays terminal needs_operator (no false retry)", () => {
    const err = new Error(
      "Codex runtime binary is missing on this machine. First Tree does not bundle the native Codex engine by default.",
    );
    const c = classifyProviderFailure(err, { provider: "codex", scope: "session_start", source: "session" });
    expect(c.category).toBe("capability");
    expect(
      decideProviderRetry({ classification: c, scope: "session_start", attempt: 1, replaySafety: "pre_provider" }),
    ).toMatchObject({ action: "stop", terminalKind: "needs_operator" });
  });

  it("maps deterministic and operator-actionable failures to stop categories", () => {
    const cases: Array<[unknown, ProviderFailureClassification["category"]]> = [
      [Object.assign(new Error("401 Unauthorized"), { status: 401 }), "credential"],
      [Object.assign(new Error("request failed"), { status: 401 }), "credential"],
      [Object.assign(new Error("request failed"), { statusCode: 403 }), "credential"],
      [new Error("Codex runtime binary is missing"), "capability"],
      [new Error("sandbox approval rejected"), "configuration"],
      [new Error("context length exceeded"), "deterministic_input"],
      [new Error("error_max_turns: exceeded max turns"), "deterministic_input"],
    ];
    for (const [err, category] of cases) {
      expect(classifyProviderFailure(err, { provider: "codex", scope: "provider_turn", source: "sdk" }).category).toBe(
        category,
      );
    }
  });

  it("reads retry-after hints from numbers, strings, and date strings", () => {
    const numeric = classifyProviderFailure(
      { message: "rate limit", retryAfter: 2 },
      {
        provider: "codex",
        scope: "session_start",
        source: "sdk",
      },
    );
    expect(numeric).toMatchObject({ category: "provider_capacity", retryAfterMs: 2000 });

    const text = classifyProviderFailure(
      { message: "rate limit", retryAfter: "3" },
      {
        provider: "codex",
        scope: "session_start",
        source: "sdk",
      },
    );
    expect(text).toMatchObject({ category: "provider_capacity", retryAfterMs: 3000 });

    const now = Date.now();
    const date = classifyProviderFailure(
      { message: "rate limit", retryAfter: new Date(now + 60_000).toUTCString() },
      { provider: "codex", scope: "session_start", source: "sdk" },
    );
    expect(date.retryAfterMs ?? 0).toBeGreaterThan(0);
  });

  it("classifies string, null, and unshaped object failures without throwing", () => {
    expect(classifyProviderFailure("upstream 502", { provider: "codex", scope: "provider_turn" })).toMatchObject({
      category: "transient_transport",
      reasonCode: "provider_transient_transport",
    });
    expect(classifyProviderFailure(null, { provider: "codex", scope: "provider_turn" })).toMatchObject({
      category: "unknown",
    });
    expect(classifyProviderFailure({ code: "EPIPE" }, { provider: "codex", scope: "provider_turn" })).toMatchObject({
      category: "transient_transport",
    });
  });

  it("maps ambiguous capacity and context-room messages to deterministic reasons", () => {
    expect(
      classifyProviderFailure({ message: "capacity is overloaded" }, { provider: "codex", scope: "provider_turn" }),
    ).toMatchObject({ category: "provider_capacity", reasonCode: "provider_overloaded" });
    expect(
      classifyProviderFailure("ran out of room in the context window", {
        provider: "claude-code",
        scope: "provider_turn",
      }),
    ).toMatchObject({ category: "deterministic_input", reasonCode: "provider_deterministic_input" });
  });

  it("amp win32 fail-closed classifies capability/amp_platform_unsupported with a deterministic stop", () => {
    const c = classifyProviderFailure(
      new Error(
        "Amp is not supported on Windows in v1 until the client-wide pre-admission Job Object supervisor is available.",
      ),
      { provider: "amp", scope: "provider_turn" },
    );
    expect(c).toMatchObject({ category: "capability", reasonCode: "amp_platform_unsupported" });
    expect(
      decideProviderRetry({ classification: c, scope: "provider_turn", attempt: 1, replaySafety: "pre_provider" }),
    ).toMatchObject({ action: "stop" });
  });

  it("deepseek win32 fail-closed classifies capability/deepseek_platform_unsupported with a deterministic stop", () => {
    const c = classifyProviderFailure(
      new Error(
        "DeepSeek Harness is not supported on Windows in v1 until the client-wide pre-admission Job Object supervisor is available.",
      ),
      { provider: "deepseek-harness", scope: "provider_turn" },
    );
    expect(c).toMatchObject({ category: "capability", reasonCode: "deepseek_platform_unsupported" });
    expect(
      decideProviderRetry({ classification: c, scope: "provider_turn", attempt: 1, replaySafety: "pre_provider" }),
    ).toMatchObject({ action: "stop" });
  });

  it("classifies Amp credential phrasings as needs_operator", () => {
    const c = classifyProviderFailure(new Error("Error: not logged in. Run `amp login` or set AMP_API_KEY."), {
      provider: "amp",
      scope: "provider_turn",
      source: "stream",
    });
    expect(c).toMatchObject({ category: "credential" });
    expect(
      decideProviderRetry({ classification: c, scope: "provider_turn", attempt: 1, replaySafety: "pre_provider" }),
    ).toMatchObject({ action: "stop", terminalKind: "needs_operator" });
  });

  it("classifies Amp official absent-key login-flow wording as needs_operator", () => {
    const c = classifyProviderFailure(new Error("No API key found. Starting login flow..."), {
      provider: "amp",
      scope: "provider_turn",
      source: "stream",
    });
    expect(c).toMatchObject({ category: "credential", reasonCode: "provider_credential_required" });
    expect(
      decideProviderRetry({ classification: c, scope: "provider_turn", attempt: 1, replaySafety: "pre_provider" }),
    ).toMatchObject({ action: "stop", terminalKind: "needs_operator" });
    const other = classifyProviderFailure(new Error("No API key found. Starting login flow..."), {
      provider: "cursor",
      scope: "provider_turn",
      source: "stream",
    });
    expect(other.category).not.toBe("credential");
  });

  it("grok win32 fail-closed classifies capability/grok_platform_unsupported with a deterministic stop", () => {
    const c = classifyProviderFailure(
      new Error("the grok provider is not supported on Windows in V1 (macOS/Linux only)"),
      { provider: "grok", scope: "provider_turn" },
    );
    expect(c.category).not.toBe("unknown");
    expect(c.reasonCode).not.toBe("grok_binary_missing");
    expect(c).toMatchObject({ category: "capability", reasonCode: "grok_platform_unsupported" });
    expect(
      decideProviderRetry({ classification: c, scope: "provider_turn", attempt: 1, replaySafety: "pre_provider" }),
    ).toMatchObject({ action: "stop" });
  });

  it("grok out-of-range binary classifies capability/grok_binary_unsupported (never unknown, never binary_missing)", () => {
    const c = classifyProviderFailure(
      new Error(
        "Grok Build CLI at /home/op/.local/bin/grok is not a supported Grok Build version: `grok --version` " +
          "reported 2.0.0 (supported range >=0.2.117 <2.0.0).",
      ),
      { provider: "grok", scope: "provider_turn" },
    );
    expect(c.category).not.toBe("unknown");
    expect(c.reasonCode).not.toBe("grok_binary_missing");
    expect(c).toMatchObject({ category: "capability", reasonCode: "grok_binary_unsupported" });
    expect(
      decideProviderRetry({ classification: c, scope: "provider_turn", attempt: 1, replaySafety: "pre_provider" }),
    ).toMatchObject({ action: "stop" });
    // The grok gates stay provider-scoped: the same text under another
    // provider must not take the grok reason codes.
    const other = classifyProviderFailure(new Error("not supported on Windows in V1"), {
      provider: "cursor",
      scope: "provider_turn",
    });
    expect(other.reasonCode).not.toBe("grok_platform_unsupported");
  });
});

describe("decideProviderRetry", () => {
  it("keeps provider_turn retry budget finite and foreground-only", () => {
    expect(decide({ category: "transient_transport", attempt: 1 })).toMatchObject({
      action: "retry",
      delayMs: 500,
      retryMode: "foreground",
      maxAttempts: 2,
    });
    expect(decide({ category: "transient_transport", attempt: 2 })).toMatchObject({
      action: "retry",
      delayMs: 1500,
    });
    expect(decide({ category: "transient_transport", attempt: 3 })).toMatchObject({
      action: "stop",
      terminalKind: "exhausted",
    });
  });

  it("does not apply provider_turn budget to session_start/session_resume transient failures", () => {
    for (const scope of ["session_start", "session_resume"] as const) {
      expect(decide({ category: "transient_transport", scope, attempt: 20 })).toMatchObject({
        action: "retry",
        retryMode: "background",
      });
    }
  });

  it("stops unknown after a small budget in every scope", () => {
    expect(decide({ category: "unknown", scope: "provider_turn", attempt: 2 })).toMatchObject({
      action: "retry",
      delayMs: 15000,
    });
    expect(decide({ category: "unknown", scope: "session_resume", attempt: 3 })).toMatchObject({
      action: "stop",
      reasonCode: "unknown_exhausted",
      terminalKind: "exhausted",
    });
  });

  it("does not return capacity_wait_required for pre_provider failures", () => {
    expect(
      decide({
        category: "provider_capacity",
        reasonCode: "provider_rate_limited",
        replaySafety: "pre_provider",
        attempt: 3,
        retryAfterMs: 120_000,
      }),
    ).toMatchObject({ action: "stop", terminalKind: "exhausted" });
    expect(
      decide({
        category: "provider_capacity",
        reasonCode: "provider_rate_limited",
        replaySafety: "user_visible",
        attempt: 3,
        retryAfterMs: 25_000,
      }),
    ).toMatchObject({ action: "stop", terminalKind: "exhausted" });
  });

  it("returns capacity_wait_required for provider-entered long capacity refusals", () => {
    expect(
      decide({
        category: "provider_capacity",
        reasonCode: "provider_rate_limited",
        replaySafety: "provider_entered",
        retryAfterMs: 120_000,
      }),
    ).toMatchObject({
      action: "stop",
      reasonCode: "capacity_wait_required",
      terminalKind: "capacity_wait_required",
    });
  });

  it("retries classified transient provider_turn failures after user-visible output", () => {
    expect(
      decide({
        category: "transient_transport",
        replaySafety: "user_visible",
        attempt: 1,
      }),
    ).toMatchObject({ action: "retry", delayMs: 500, retryMode: "foreground" });
    expect(
      decide({
        category: "provider_capacity",
        reasonCode: "provider_overloaded",
        replaySafety: "user_visible",
        attempt: 1,
      }),
    ).toMatchObject({ action: "retry", delayMs: 500, retryMode: "foreground" });
    expect(
      decide({
        category: "transient_transport",
        replaySafety: "user_visible",
        attempt: 3,
      }),
    ).toMatchObject({ action: "stop", terminalKind: "exhausted" });
    expect(
      decide({
        category: "provider_capacity",
        reasonCode: "provider_overloaded",
        replaySafety: "user_visible",
        attempt: 3,
      }),
    ).toMatchObject({ action: "stop", terminalKind: "exhausted" });
    expect(
      decide({
        category: "provider_capacity",
        reasonCode: "provider_usage_limit",
        replaySafety: "user_visible",
        attempt: 1,
      }),
    ).toMatchObject({ action: "stop", terminalKind: "capacity_wait_required" });
  });

  it("stops provider_turn retry when replay custody is unknown", () => {
    expect(
      decide({
        category: "transient_transport",
        replaySafety: "unknown",
        attempt: 1,
      }),
    ).toMatchObject({ action: "stop", terminalKind: "unsafe_replay" });
    expect(
      decide({
        category: "unknown",
        replaySafety: "user_visible",
        attempt: 1,
      }),
    ).toMatchObject({ action: "stop", terminalKind: "unsafe_replay" });
  });

  it("retries short provider-entered capacity waits and overloaded responses without Retry-After", () => {
    expect(
      decide({
        category: "provider_capacity",
        reasonCode: "provider_rate_limited",
        replaySafety: "provider_entered",
        retryAfterMs: 25_000,
      }),
    ).toMatchObject({ action: "retry", delayMs: 25_000, userSeverity: "warning" });

    expect(
      decide({
        category: "provider_capacity",
        reasonCode: "provider_overloaded",
        replaySafety: "provider_entered",
      }),
    ).toMatchObject({ action: "retry", delayMs: 500, userSeverity: "warning" });
  });

  it("normalizes non-positive and fractional attempts before choosing backoff", () => {
    expect(decide({ category: "transient_transport", attempt: 0 })).toMatchObject({
      action: "retry",
      attempt: 1,
      delayMs: 500,
    });
    expect(decide({ category: "unknown", attempt: 2.9 })).toMatchObject({
      action: "retry",
      attempt: 2,
      delayMs: 15000,
    });
  });
});

describe("buildProviderRetryEvent", () => {
  it("builds standard payloads from decisions", () => {
    const provider: RuntimeProvider = "codex";
    const c = classification("transient_transport", "network_error");
    const decision = decideProviderRetry({
      classification: c,
      scope: "provider_turn",
      attempt: 1,
      replaySafety: "pre_visible",
    });
    expect(
      buildProviderRetryEvent({
        event: "provider_retry_scheduled",
        provider,
        scope: "provider_turn",
        classification: c,
        decision,
        messagePreview: "fetch failed with token ghp_secret_should_be_redacted",
        now: 1_000,
      }),
    ).toMatchObject({
      event: "provider_retry_scheduled",
      provider,
      scope: "provider_turn",
      category: "transient_transport",
      reasonCode: "network_error",
      attempt: 1,
      maxAttempts: 2,
      delayMs: 500,
      userSeverity: "info",
    });
  });

  it("builds terminal payloads without a retry decision", () => {
    const c = classification("credential", "provider_credential_required");
    expect(
      buildProviderRetryEvent({
        event: "provider_failure_terminal",
        provider: "claude-code",
        scope: "session_start",
        classification: c,
        messagePreview: null,
      }),
    ).toEqual({
      event: "provider_failure_terminal",
      provider: "claude-code",
      scope: "session_start",
      category: "credential",
      reasonCode: "provider_credential_required",
      userSeverity: "error",
    });
  });
});
