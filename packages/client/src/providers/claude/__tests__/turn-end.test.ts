import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SessionEvent } from "@first-tree/shared";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

/**
 * The chat UI groups session events at `turn_end` boundaries. This test locks
 * down the handler's contract: every query turn emits exactly one `turn_end`,
 * with status:"success" on a clean turn and status:"error" when the SDK
 * returned a non-success subtype. The final-text mirror is retired, so the
 * turn produces no chat message — `forwardResult` is the turn-completion hook,
 * awaited before `turn_end` only to keep the seq ordering.
 */

const RESULT_TEXT = "final answer";

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
              value: { type: "result", subtype: "success", result: RESULT_TEXT, num_turns: 1, duration_ms: 5 },
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
import type { SessionContext } from "../../../runtime/handler.js";
import { deliveryTokenFromSessionContext } from "../../../runtime/handler.js";
import { createClaudeCodeHandler } from "../index.js";

const AGENT_ID = "019d9a97-90b0-716b-8317-a8c0be8430d7";

let workspaceRoot: string;

beforeAll(() => {
  workspaceRoot = mkdtempSync(join(tmpdir(), "ftt-turn-end-"));
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

describe("claude-code handler — turn_end emission", () => {
  it("emits exactly one turn_end per query turn", async () => {
    // Regression guard: every result message produces exactly one turn_end.
    // Duplicate emits would confuse the frontend's "last turn_end seq" filter.
    const sendMessage = vi.fn().mockResolvedValue(undefined);
    const emitted: SessionEvent[] = [];

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
      chatId: "chat-1",
      log: () => {},
      recordProviderActivity: () => {},
      noteTurnStart: () => {},
      ...mockCtxPlumbing({ sendMessage }, "chat-1"),
      emitEvent: (e) => emitted.push(e),
    };

    await handler.start(
      { id: "m1", chatId: "chat-1", senderId: "u", format: "text", content: "hi", metadata: null },
      ctx,
      deliveryTokenFromSessionContext(ctx),
    );
    await handler.suspend();
    await new Promise((r) => setImmediate(r));

    expect(emitted.filter((e) => e.kind === "turn_end")).toHaveLength(1);
  });

  it("emits a turn_end success event AFTER the turn-completion hook resolves", async () => {
    const emitted: SessionEvent[] = [];
    // Track call order so we can assert turn_end follows the completion hook.
    const order: string[] = [];
    const sendMessage = vi.fn();

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
      chatId: "chat-1",
      log: () => {},
      recordProviderActivity: () => {},
      noteTurnStart: () => {},
      ...mockCtxPlumbing({ sendMessage }, "chat-1"),
      // Production-faithful: forwardResult delivers nothing; record the call so
      // we can assert turn_end is emitted only after it resolves.
      forwardResult: async () => {
        order.push("forwardResult");
      },
      emitEvent: (e) => {
        if (e.kind === "turn_end") order.push(`turn_end:${e.payload.status}`);
        emitted.push(e);
      },
    };

    await handler.start(
      { id: "m1", chatId: "chat-1", senderId: "u", format: "text", content: "hi", metadata: null },
      ctx,
      deliveryTokenFromSessionContext(ctx),
    );

    // Consumer loop is async; let microtasks settle.
    await handler.suspend();
    await new Promise((r) => setImmediate(r));

    // The final-text mirror is retired: the turn produces no chat message.
    expect(sendMessage).not.toHaveBeenCalled();

    const turnEndEvents = emitted.filter((e) => e.kind === "turn_end");
    expect(turnEndEvents).toHaveLength(1);
    const ev = turnEndEvents[0];
    if (!ev || ev.kind !== "turn_end") throw new Error("expected turn_end event");
    expect(ev.payload.status).toBe("success");

    // Crucial: turn_end must fire AFTER the completion hook resolves, so the
    // server can't assign turn N+1's events a smaller seq than turn N's
    // turn_end (which the frontend's "latest turn_end" filter keys off).
    expect(order).toEqual(["forwardResult", "turn_end:success"]);
  });
});
