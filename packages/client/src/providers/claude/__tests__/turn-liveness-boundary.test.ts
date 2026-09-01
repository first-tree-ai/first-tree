import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SessionEvent } from "@first-tree/shared";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

/**
 * Turn liveness must follow the SDK's own turn lifecycle, not the arrival of
 * messages.
 *
 * The stream does not end at `result`: `sdk.d.ts` documents
 * `session_state_changed: idle` as the authoritative turn-over signal, fired
 * once the held-back result flushes and the background-agent loop exits. A
 * hook that treats every frame as turn-entering therefore runs again on that
 * trailing frame and re-opens the turn it just closed — leaving the chat
 * Working, with no `turn_end` left to clear it, until the idle sweep's hard
 * cap (~12h with shipped defaults).
 *
 * The script below is that exact ordering: running -> result -> idle.
 */

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
                type: "system",
                subtype: "session_state_changed",
                state: "running",
                uuid: "u1",
                session_id: "s",
              },
            };
          }
          if (step === 2) {
            return {
              done: false,
              value: { type: "result", subtype: "success", result: "done", num_turns: 1, duration_ms: 5 },
            };
          }
          if (step === 3) {
            return {
              done: false,
              value: { type: "system", subtype: "session_state_changed", state: "idle", uuid: "u2", session_id: "s" },
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

const AGENT_ID = "019d9a97-90b0-716b-8317-a8c0be8430d9";

let workspaceRoot: string;

beforeAll(() => {
  workspaceRoot = mkdtempSync(join(tmpdir(), "ftt-turn-liveness-"));
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

describe("claude-code handler — turn liveness boundary", () => {
  it("opens on the running frame and does not reopen on the post-result idle frame", async () => {
    const sendMessage = vi.fn();
    const order: string[] = [];

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
      noteTurnStart: () => order.push("turn_start"),
      noteTurnEnd: () => order.push("turn_end_hook"),
      emitEvent: (e: SessionEvent) => {
        if (e.kind === "turn_end") order.push("turn_end_event");
      },
      ...mockCtxPlumbing({ sendMessage }, "chat-1"),
      forwardResult: async () => {},
    };

    try {
      await handler.start(
        { id: "m1", chatId: "chat-1", senderId: "u", format: "text", content: "hi", metadata: null },
        ctx,
        deliveryTokenFromSessionContext(ctx),
      );
      await vi.waitFor(() => expect(order).toContain("turn_end_hook"));

      // The whole point: exactly one open, and the trailing authoritative
      // idle frame closes rather than reopens.
      expect(order).toEqual(["turn_start", "turn_end_event", "turn_end_hook"]);
      expect(order.lastIndexOf("turn_start")).toBe(0);
    } finally {
      await handler.suspend().catch(() => {});
      await new Promise((r) => setImmediate(r));
    }
  });
});
