import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type ProviderRetryEventPayload, parseProviderRetryEventMessage, type SessionEvent } from "@first-tree/shared";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const SESSION_LIMIT_RESULT = "You've hit your session limit \u00b7 resets 9:50pm (Asia/Shanghai)";

vi.mock("@anthropic-ai/claude-agent-sdk", () => {
  const fakeQuery = {
    [Symbol.asyncIterator]() {
      let step = 0;
      return {
        next: async () => {
          step += 1;
          if (step === 1) {
            return {
              done: false,
              value: {
                type: "result",
                subtype: "success",
                is_error: true,
                result: SESSION_LIMIT_RESULT,
              },
            };
          }
          return { done: true, value: undefined };
        },
      };
    },
    close: () => {},
    setModel: async () => {},
  };
  return { query: () => fakeQuery };
});

import { mockCtxPlumbing } from "../../../__tests__/test-helpers.js";
import { createAgentConfigCache } from "../../../runtime/agent-config-cache.js";
import type { SessionContext, TurnOutcome } from "../../../runtime/handler.js";
import { deliveryTokenFromSessionContext } from "../../../runtime/handler.js";
import { formatProviderFailureRuntimeNotice } from "../../../runtime/runtime-notice.js";
import { createClaudeCodeHandler } from "../index.js";

const AGENT_ID = "019ef431-0000-7000-9000-000000000001";

let workspaceRoot: string;

beforeAll(() => {
  workspaceRoot = mkdtempSync(join(tmpdir(), "ftt-claude-session-limit-"));
});

afterAll(() => {
  rmSync(workspaceRoot, { recursive: true, force: true });
});

function buildCache() {
  const stubSdk = {
    fetchAgentConfig: async () => ({
      agentId: AGENT_ID,
      version: 1,
      payload: { prompt: { append: "" }, model: "", mcpServers: [], env: [], gitRepos: [] },
      updatedAt: new Date().toISOString(),
      updatedBy: "test",
    }),
  } as unknown as Parameters<typeof createAgentConfigCache>[0]["sdk"];
  return createAgentConfigCache({ sdk: stubSdk });
}

function providerRetryPayloads(emitted: readonly SessionEvent[]): ProviderRetryEventPayload[] {
  return emitted
    .filter((event) => event.kind === "error")
    .map((event) => parseProviderRetryEventMessage(event.payload.message))
    .filter((payload): payload is ProviderRetryEventPayload => payload !== null);
}

function firstProviderPayload(payloads: readonly ProviderRetryEventPayload[]): ProviderRetryEventPayload {
  const payload = payloads[0];
  if (!payload) throw new Error("expected provider retry event");
  return payload;
}

describe("claude-code handler — session-limit success result", () => {
  it("treats the limit notice as a consumed provider error instead of final text", async () => {
    const sendMessage = vi.fn().mockResolvedValue(undefined);
    const forwardResult = vi.fn<SessionContext["forwardResult"]>().mockResolvedValue(undefined);
    const emitted: SessionEvent[] = [];
    const completed: Array<{ count: number; outcome: TurnOutcome }> = [];
    const logs: string[] = [];

    const cache = buildCache();
    await cache.refresh(AGENT_ID);

    const handler = createClaudeCodeHandler({
      runtimeProvider: "claude-code",
      workspaceRoot,
      agentName: "test-agent",
      agentConfigCache: cache,
    });
    const ctx: SessionContext = {
      agent: {
        agentId: AGENT_ID,
        inboxId: "inbox-test",
        displayName: "test",
        type: "agent",
        visibility: "organization",
        delegateMention: null,
        metadata: {},
      },
      sdk: { serverUrl: "http://test", sendMessage } as unknown as SessionContext["sdk"],
      chatId: "chat-claude-session-limit",
      log: (m) => logs.push(m),
      recordProviderActivity: () => {},
      noteTurnStart: () => {},
      emitEvent: (e) => emitted.push(e),
      ...mockCtxPlumbing({ sendMessage }, "chat-claude-session-limit"),
      forwardResult,
      finishTurn: async (messages, outcome) => {
        completed.push({ count: Array.isArray(messages) ? messages.length : 1, outcome });
      },
    };

    await handler.start(
      {
        id: "m1",
        chatId: "chat-claude-session-limit",
        senderId: "user-1",
        format: "text",
        content: "hello",
        metadata: null,
      },
      ctx,
      deliveryTokenFromSessionContext(ctx),
    );
    await handler.suspend();
    await new Promise((r) => setImmediate(r));

    expect(forwardResult).not.toHaveBeenCalled();
    expect(sendMessage).not.toHaveBeenCalled();
    expect(logs.some((line) => line.includes("Claude SDK provider failure"))).toBe(true);

    const providerPayloads = providerRetryPayloads(emitted);
    expect(providerPayloads).toHaveLength(1);
    expect(providerPayloads[0]).toMatchObject({
      event: "provider_failure_terminal",
      provider: "claude-code",
      scope: "provider_turn",
      category: "provider_capacity",
      reasonCode: "capacity_wait_required",
      userSeverity: "warning",
    });
    expect(formatProviderFailureRuntimeNotice(firstProviderPayload(providerPayloads))).toContain(
      "capacity or usage limit",
    );

    expect(
      emitted.some(
        (event) =>
          event.kind === "error" &&
          event.payload.source === "sdk" &&
          event.payload.message.includes("Claude SDK provider failure"),
      ),
    ).toBe(true);
    expect(emitted.some((event) => event.kind === "turn_end" && event.payload.status === "error")).toBe(true);
    expect(completed).toEqual([
      {
        count: 1,
        outcome: {
          status: "error",
          terminal: true,
          completion: "consumed",
          reason: "capacity_wait_required",
        },
      },
    ]);
  });
});
