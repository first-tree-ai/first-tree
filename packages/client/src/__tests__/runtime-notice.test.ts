import type { ProviderRetryEventPayload } from "@first-tree/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FirstTreeHubSDK, SdkError } from "../cloud/sdk.js";
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

  it("publishes the formatted notice through the dedicated runtime-notice endpoint", async () => {
    const sdk = new FirstTreeHubSDK({ serverUrl: "https://first-tree.test", getAccessToken: () => "token" });
    const postRuntimeNotice = vi.spyOn(sdk, "postRuntimeNotice").mockResolvedValue({
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

    // Only the text travels: the server authors source/format/purpose and the
    // stored runtimeNotice marker, so a notice cannot quietly become an
    // addressed message.
    expect(postRuntimeNotice).toHaveBeenCalledWith("chat-1", expect.stringContaining("refresh token revoked"));
  });
});

/**
 * ROLLING DEPLOY, new client → old server. The runtime is upgraded
 * independently of the server it talks to, so a runtime that knows the
 * dedicated endpoint will meet servers that do not. A provider-failure notice
 * is most valuable precisely then, so a 404 must degrade to the older wire
 * shape rather than drop the notice.
 */
describe("runtime notice endpoint compatibility", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function jsonResponse(data: unknown, status = 200): Response {
    return new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });
  }

  function storedMessage(): Record<string, unknown> {
    return {
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
    };
  }

  function makeSdk(): FirstTreeHubSDK {
    return new FirstTreeHubSDK({
      serverUrl: "https://first-tree.example",
      agentId: "agent-1",
      getAccessToken: () => "access-token",
    });
  }

  it("falls back to the legacy send shape when the server has no runtime-notice route", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ error: "Route POST:/api/v1/... not found" }, 404))
      .mockResolvedValueOnce(jsonResponse(storedMessage(), 201));
    vi.stubGlobal("fetch", fetchMock);

    const message = await makeSdk().postRuntimeNotice("chat-1", "provider failed");

    expect(message.id).toBe("msg-1");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain("/runtime-notices");
    const fallbackUrl = String(fetchMock.mock.calls[1]?.[0]);
    expect(fallbackUrl).toContain("/chats/chat-1/messages");
    // Exactly the body the server recognises as a legacy runtime notice; the
    // two sides share `legacyRuntimeNoticeSendBody` so they cannot drift.
    expect(JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body))).toEqual({
      source: "api",
      format: "text",
      content: "provider failed",
      metadata: { runtimeNotice: true },
      purpose: "agent-final-text",
    });
  });

  it("does not reshape a genuine refusal into an ordinary send", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ error: "Not a participant of this chat" }, 403));
    vi.stubGlobal("fetch", fetchMock);

    await expect(makeSdk().postRuntimeNotice("chat-1", "provider failed")).rejects.toBeInstanceOf(SdkError);
    // Only 404 means "this server predates the route". Anything else must not
    // be retried as a plain message, which in a bridged chat would be refused
    // anyway and elsewhere would land mislabelled.
    for (const call of fetchMock.mock.calls) {
      expect(String(call[0])).toContain("/runtime-notices");
    }
  });
});
