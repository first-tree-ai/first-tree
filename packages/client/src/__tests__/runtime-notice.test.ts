import { type ProviderRetryEventPayload, RUNTIME_NOTICE_METADATA_KEY } from "@first-tree/shared";
import { describe, expect, it, vi } from "vitest";
import { FirstTreeHubSDK } from "../cloud/sdk.js";
import {
  formatProviderFailureRuntimeNotice,
  isEgressForbiddenText,
  isRuntimeSessionProofFailure,
  postProviderFailureRuntimeNotice,
  shouldPostProviderFailureRuntimeNotice,
} from "../runtime/runtime-notice.js";

function payload(overrides: Partial<ProviderRetryEventPayload> = {}): ProviderRetryEventPayload {
  return {
    event: "provider_failure_terminal",
    provider: "codex",
    scope: "provider_turn",
    category: "credential",
    reasonCode: "provider_credential_required",
    userSeverity: "error",
    ...overrides,
  };
}

describe("runtime notice formatting", () => {
  it("posts runtime notices only for terminal provider failures", () => {
    expect(shouldPostProviderFailureRuntimeNotice(payload({ event: "provider_failure_terminal" }))).toBe(true);
    expect(shouldPostProviderFailureRuntimeNotice(payload({ event: "provider_retry_exhausted" }))).toBe(true);
    expect(shouldPostProviderFailureRuntimeNotice(payload({ event: "provider_retry_scheduled" }))).toBe(false);
    expect(shouldPostProviderFailureRuntimeNotice(payload({ event: "provider_retry_succeeded" }))).toBe(false);
    const runtimeFault = payload({
      category: "runtime_transport",
      reasonCode: "runtime_session_invalid",
    });
    expect(isRuntimeSessionProofFailure(runtimeFault)).toBe(true);
    expect(shouldPostProviderFailureRuntimeNotice(runtimeFault)).toBe(false);
  });

  it("formats generic provider failure categories and action scopes", () => {
    const cases: Array<{
      overrides: Partial<ProviderRetryEventPayload>;
      expected: string;
    }> = [
      {
        overrides: { provider: "codex", scope: "session_start", category: "credential" },
        expected: "Codex could not start this chat session: credentials need attention.",
      },
      {
        overrides: { provider: "claude-code-tui", scope: "session_resume", category: "capability" },
        expected: "Claude Code CLI could not resume this chat session: the runtime is unavailable",
      },
      {
        overrides: { provider: "codex", category: "configuration" },
        expected: "runtime configuration needs attention",
      },
      {
        overrides: { provider: "codex", category: "deterministic_input" },
        expected: "this input cannot be processed as-is",
      },
      {
        overrides: { provider: "codex", category: "provider_capacity" },
        expected: "provider capacity or quota blocked the request",
      },
      {
        overrides: { provider: "codex", category: "transient_transport" },
        expected: "after retrying a transient provider or network failure",
      },
      {
        overrides: { provider: "codex", category: "unknown" },
        expected: "unknown terminal failure",
      },
    ];

    for (const item of cases) {
      expect(formatProviderFailureRuntimeNotice(payload(item.overrides))).toContain(item.expected);
    }
  });

  it("formats Pi credential notices with host-local pi /login recovery", () => {
    const notice = formatProviderFailureRuntimeNotice(
      payload({
        provider: "pi",
        scope: "provider_turn",
        category: "credential",
        messagePreview: "missing credentials",
      }),
    );
    expect(notice).toContain("Pi could not run this turn");
    expect(notice).toContain("credentials need attention");
    expect(notice).toContain("run `pi`");
    expect(notice).toContain("`/login`");
    expect(notice).toContain("missing credentials");
    expect(notice).not.toContain("Please sign in again");
  });

  it("formats Claude provider-turn credential and capacity notices", () => {
    expect(
      formatProviderFailureRuntimeNotice(
        payload({
          provider: "claude-code",
          category: "credential",
          messagePreview: "API Error: 403 Request not allowed",
        }),
      ),
    ).toContain("usually NOT a login problem");
    const credentialNotice = formatProviderFailureRuntimeNotice(
      payload({ provider: "claude-code", category: "credential" }),
    );
    expect(credentialNotice).toContain("Run `claude auth login`");
    expect(credentialNotice).toContain("send your message again in this chat");
    expect(credentialNotice).not.toContain("then retry");
    expect(
      formatProviderFailureRuntimeNotice(
        payload({ provider: "claude-code", category: "provider_capacity", reasonCode: "provider_billing_limit" }),
      ),
    ).toContain("insufficient account balance");
    expect(
      formatProviderFailureRuntimeNotice(
        payload({ provider: "claude-code", category: "provider_capacity", reasonCode: "provider_rate_limited" }),
      ),
    ).toContain("rate-limited this account");
    expect(
      formatProviderFailureRuntimeNotice(
        payload({ provider: "claude-code", category: "provider_capacity", reasonCode: "provider_overloaded" }),
      ),
    ).toContain("capacity or usage limit");
  });

  it("formats remaining Claude provider-turn categories", () => {
    const cases: Array<[ProviderRetryEventPayload["category"], string]> = [
      ["transient_transport", "custom ANTHROPIC_BASE_URL"],
      ["configuration", "runtime configuration is invalid"],
      ["deterministic_input", "Anthropic rejected this request as invalid"],
      ["capability", "runtime is not launchable"],
      ["unknown", "Claude SDK reported a provider failure"],
    ];

    for (const [category, expected] of cases) {
      expect(formatProviderFailureRuntimeNotice(payload({ provider: "claude-code", category }))).toContain(expected);
    }
  });

  it("redacts provider message previews and omits empty previews", () => {
    expect(
      formatProviderFailureRuntimeNotice(
        payload({ messagePreview: "fetch failed with token ghp_secret_should_be_redacted" }),
      ),
    ).toContain("[REDACTED:ghp]");
    expect(formatProviderFailureRuntimeNotice(payload({ messagePreview: "   " }))).not.toContain(
      "Original provider message",
    );
  });

  it("detects Anthropic egress 403 text", () => {
    expect(isEgressForbiddenText("API Error: 403 Request not allowed")).toBe(true);
    expect(isEgressForbiddenText("API Error: 403 insufficient balance")).toBe(false);
    expect(isEgressForbiddenText("Request not allowed")).toBe(false);
  });

  it("sends the formatted notice as final API text with runtime metadata", async () => {
    const sdk = new FirstTreeHubSDK({ serverUrl: "https://first-tree.test", getAccessToken: () => "token" });
    const sendMessage = vi.spyOn(sdk, "sendMessage").mockResolvedValue({
      id: "msg-1",
      chatId: "chat-1",
      senderId: "agent-1",
      senderKind: "member",
      senderProvider: null,
      format: "text",
      content: "notice",
      metadata: {},
      inReplyTo: null,
      source: "api",
      createdAt: "2026-07-09T00:00:00.000Z",
    });

    await postProviderFailureRuntimeNotice(sdk, "chat-1", payload({ messagePreview: "refresh token revoked" }));

    expect(sendMessage).toHaveBeenCalledWith("chat-1", {
      source: "api",
      format: "text",
      content: expect.stringContaining("refresh token revoked"),
      metadata: { [RUNTIME_NOTICE_METADATA_KEY]: true },
      purpose: "agent-final-text",
    });
  });
});
