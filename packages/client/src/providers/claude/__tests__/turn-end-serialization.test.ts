import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SessionEvent } from "@first-tree/shared";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

/**
 * Regression guard for the turn_end serialization race.
 *
 * If the per-turn completion hook (`forwardResult`) were fire-and-forget, a
 * slow round-trip could let the SDK emit turn N+1's thinking / tool_call /
 * assistant_text events BEFORE the client has posted turn N's `turn_end` over
 * the WebSocket. The server then assigns a smaller seq to turn N+1's first
 * events than to turn N's turn_end — and the chat-view's
 * `filterEventsForTimeline` treats the latest turn_end as a hard boundary,
 * retroactively hiding turn N+1's live events.
 *
 * The fix: await `forwardResult` synchronously inside the consumer loop so the
 * turn_end emit happens BEFORE the for-await pulls the next SDK message off the
 * queue. (The final-text mirror is retired, so `forwardResult` no longer
 * delivers a message — but it stays awaited precisely to preserve this seq
 * ordering.) This test proves the property by stalling the hook.
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
              value: { type: "result", subtype: "success", result: "turn-1", num_turns: 1, duration_ms: 5 },
            };
          }
          // Turn 2 begins: the SDK has a next assistant message ready. If the
          // consumer loop were not awaiting the completion hook, this would
          // fire before turn_end and break the seq invariant.
          if (step === 2) {
            return {
              done: false,
              value: {
                type: "assistant",
                message: {
                  role: "assistant",
                  content: [{ type: "tool_use", id: "tu-next-turn", name: "Bash", input: { command: "x" } }],
                },
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
import type { SessionContext } from "../../../runtime/handler.js";
import { deliveryTokenFromSessionContext } from "../../../runtime/handler.js";
import { createClaudeCodeHandler } from "../index.js";

const AGENT_ID = "019d9a97-90b0-716b-8317-a8c0be8430d9";

let workspaceRoot: string;

beforeAll(() => {
  workspaceRoot = mkdtempSync(join(tmpdir(), "ftt-turn-end-ser-"));
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

describe("claude-code handler — turn_end serialization (race guard)", () => {
  it("blocks the next turn's events until the current turn_end has been emitted", async () => {
    // Test-local stall: the completion hook holds (simulating a slow
    // round-trip) until this test releases it. Kept inside the test
    // lifecycle so a failing assertion can never strand a module-scoped gate
    // or leave a background consumer alive past afterAll's workspace removal.
    let releaseForward!: () => void;
    const forwardStalled = new Promise<void>((resolve) => {
      releaseForward = resolve;
    });

    const sendMessage = vi.fn();
    // The completion hook holds (simulating a slow round-trip) until released.
    const forwardResult = vi.fn().mockImplementation(async () => {
      await forwardStalled;
    });

    const emitted: { kind: string; at: number }[] = [];
    const start = Date.now();

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
      emitEvent: (e: SessionEvent) => {
        emitted.push({ kind: e.kind, at: Date.now() - start });
      },
      ...mockCtxPlumbing({ sendMessage }, "chat-1"),
      forwardResult,
    };

    let startPromise: Promise<unknown> | null = null;
    let suspended = false;
    try {
      startPromise = handler.start(
        { id: "m1", chatId: "chat-1", senderId: "u", format: "text", content: "hi", metadata: null },
        ctx,
        deliveryTokenFromSessionContext(ctx),
      );

      // Explicit readiness instead of a wall-clock guess: wait until turn 1's
      // completion hook was invoked (its result arrived and the hook is now
      // stalled), then yield one immediate turn — a fire-and-forget
      // regression would get the chance to pull the second SDK message and
      // turn the assertions below red.
      await vi.waitFor(() => expect(forwardResult).toHaveBeenCalledTimes(1));
      await new Promise((r) => setImmediate(r));
      // The mirror is retired — no chat message is ever sent.
      expect(sendMessage).not.toHaveBeenCalled();
      expect(emitted.filter((e) => e.kind !== "turn_end")).toEqual([]);

      // Release the hook — turn_end should fire, THEN turn 2 tool_use pending.
      releaseForward();

      await startPromise;
      startPromise = null;
      await handler.suspend();
      suspended = true;
      await new Promise((r) => setImmediate(r));

      const kinds = emitted.map((e) => e.kind);
      const turnEndIdx = kinds.indexOf("turn_end");
      const nextTurnToolIdx = kinds.indexOf("tool_call");

      expect(turnEndIdx).toBeGreaterThanOrEqual(0);
      expect(nextTurnToolIdx).toBeGreaterThanOrEqual(0);
      // The cardinal invariant: turn_end from turn 1 strictly precedes every
      // event from turn 2.
      expect(turnEndIdx).toBeLessThan(nextTurnToolIdx);
    } finally {
      // Idempotent teardown: unblock the hook, let start/suspend settle, and
      // drain pending immediates so no background consumer outlives the test
      // into afterAll's workspace removal. Cleanup-only rejections are
      // swallowed here; real failures already surfaced above.
      releaseForward();
      if (startPromise) await startPromise.catch(() => {});
      if (!suspended) await handler.suspend().catch(() => {});
      await new Promise((r) => setImmediate(r));
    }
  });
});
