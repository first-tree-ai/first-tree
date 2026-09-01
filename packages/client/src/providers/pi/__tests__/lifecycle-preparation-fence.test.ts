import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mockCtxPlumbing } from "../../../__tests__/test-helpers.js";
import type { DeliveryToken, SessionContext, SessionMessage } from "../../../runtime/contracts.js";
import { INIT_COMPLETE_SENTINEL_REL } from "../../../runtime/workspace.js";
import { createPiHandler } from "../index.js";

/**
 * Regression: a suspended Pi generation must not cross managed-session
 * preparation fences into skills reconcile, bootstrap, or init-complete.
 *
 * Covers:
 * - post-chat-context / pre-projection (suspend while fetch is pending)
 * - post-skills / pre-briefing (suspend mid-reconcile)
 *
 * The post-assert / pre-reconcile non-yielding invariant is proven in
 * `prepare-managed-session.test.ts` (same-turn entry+reconcile + thenable
 * fail-closed). A `queueMicrotask(suspend)` inside `getChatDetail` is not a
 * valid stand-in for that gap — fetch's Promise.all is still unsettled then.
 *
 * `start()` catches `PiLifecycleCancelledError` and retries delivery rather
 * than rethrowing — assert admission side effects stayed closed.
 */

vi.mock("../../../runtime/managed-skills.js", async () => {
  const actual = await vi.importActual<typeof import("../../../runtime/managed-skills.js")>(
    "../../../runtime/managed-skills.js",
  );
  return {
    ...actual,
    reconcileManagedSkillsForConfig: vi.fn(),
  };
});

vi.mock("../../../runtime/agent-bootstrap.js", () => ({
  ensureAgentBootstrap: vi.fn(),
}));

import { ensureAgentBootstrap } from "../../../runtime/agent-bootstrap.js";
import { reconcileManagedSkillsForConfig } from "../../../runtime/managed-skills.js";

describe("Pi lifecycle fence during managed-session preparation", () => {
  let workspaceRoot: string;

  beforeEach(() => {
    workspaceRoot = mkdtempSync(join(tmpdir(), "pi-lifecycle-fence-"));
    vi.clearAllMocks();
  });

  afterEach(() => {
    rmSync(workspaceRoot, { recursive: true, force: true });
  });

  function makeCtx(
    logs: string[],
    sdkOverrides?: {
      // Test stubs only need the fields fetchChatContext reads.
      getChatDetail?: (chatId: string) => Promise<unknown>;
      listChatParticipants?: (chatId: string) => Promise<unknown>;
    },
  ): SessionContext {
    const sendMessage = vi.fn().mockResolvedValue(undefined);
    return {
      agent: {
        agentId: "019d9a97-90b0-716b-8317-a8c0be8430d7",
        inboxId: "inbox-pi",
        displayName: "pi-agent",
        type: "agent",
        visibility: "organization",
        delegateMention: null,
        metadata: {},
      },
      sdk: {
        serverUrl: "https://first-tree.example.test",
        sendMessage,
        getChatDetail: async () => ({ id: "chat-pi", title: "t", topic: null, description: null }),
        listChatParticipants: async () => [],
        ...sdkOverrides,
      } as unknown as SessionContext["sdk"],
      chatId: "chat-pi",
      log: (m: string) => logs.push(m),
      recordProviderActivity: () => {},
      noteTurnStart: () => {},
      emitEvent: () => {},
      ...mockCtxPlumbing({ sendMessage }, "chat-pi"),
    } as SessionContext;
  }

  function makeMessage(): SessionMessage {
    return {
      inboxEntryId: 1,
      id: "msg-1",
      chatId: "chat-pi",
      senderId: "human-1",
      format: "text",
      content: "hello",
      metadata: {},
    };
  }

  function makeToken(): DeliveryToken & { retried: string[] } {
    const retried: string[] = [];
    return {
      processingStarted: () => {},
      complete: async () => "settled" as const,
      retry: (_messages, reason) => {
        retried.push(reason);
      },
      terminalRejected: async () => {},
      retried,
    };
  }

  it("cancels during chat-context fetch before skills reconcile begins", async () => {
    const logs: string[] = [];
    let releaseFetch: (() => void) | undefined;
    let markFetchStarted!: () => void;
    const fetchGate = new Promise<void>((resolve) => {
      markFetchStarted = resolve;
    });

    vi.mocked(reconcileManagedSkillsForConfig).mockImplementation(async () => {
      throw new Error("reconcileManagedSkillsForConfig must not run after suspend-during-fetch");
    });

    const handler = createPiHandler({
      workspaceRoot,
      agentName: "test-agent",
      runtimeProvider: "pi",
      piBinaryResolver: () => ({ ok: true as const, binary: "/usr/bin/pi", version: "0.0.0" }),
      providerProcessSupervisor: {
        spawn: () => {
          throw new Error("provider must not spawn during this fence test");
        },
      },
    });

    const token = makeToken();
    const started = handler.start(
      makeMessage(),
      makeCtx(logs, {
        getChatDetail: async () => {
          markFetchStarted();
          await new Promise<void>((r) => {
            releaseFetch = r;
          });
          return { id: "chat-pi", title: "t", topic: null, description: null };
        },
      }),
      token,
    );
    await fetchGate;
    // endLifecycle bumps generation without joining the in-flight preparation.
    await handler.suspend("test_suspend");
    releaseFetch?.();

    const result = await started;
    expect(result).toMatchObject({ route: { kind: "owned", mode: "processing" } });
    expect(token.retried).toContain("pi_turn_cancelled");

    expect(reconcileManagedSkillsForConfig).not.toHaveBeenCalled();
    expect(ensureAgentBootstrap).not.toHaveBeenCalled();
    expect(existsSync(join(workspaceRoot, INIT_COMPLETE_SENTINEL_REL))).toBe(false);

    await handler.shutdown();
  });

  it("cancels after skills and before bootstrap/sentinel when lifecycle ends mid-reconcile", async () => {
    const logs: string[] = [];
    let releaseReconcile: (() => void) | undefined;
    const reconcileStarted = new Promise<void>((resolve) => {
      vi.mocked(reconcileManagedSkillsForConfig).mockImplementation(async () => {
        resolve();
        await new Promise<void>((r) => {
          releaseReconcile = r;
        });
        return {
          ok: true,
          resourceConfigVersion: 1,
          installed: [],
          skipped: [],
          removed: [],
          teamSkills: [],
          teamSkillCommands: [],
          failures: [],
          staleTeamSnapshot: false,
        };
      });
    });

    const handler = createPiHandler({
      workspaceRoot,
      agentName: "test-agent",
      runtimeProvider: "pi",
      piBinaryResolver: () => ({ ok: true as const, binary: "/usr/bin/pi", version: "0.0.0" }),
      providerProcessSupervisor: {
        spawn: () => {
          throw new Error("provider must not spawn during this fence test");
        },
      },
    });

    const token = makeToken();
    const started = handler.start(makeMessage(), makeCtx(logs), token);
    await reconcileStarted;
    // endLifecycle bumps generation without joining the in-flight preparation.
    await handler.suspend("test_suspend");
    releaseReconcile?.();

    const result = await started;
    expect(result).toMatchObject({ route: { kind: "owned", mode: "processing" } });
    expect(token.retried).toContain("pi_turn_cancelled");

    expect(ensureAgentBootstrap).not.toHaveBeenCalled();
    expect(existsSync(join(workspaceRoot, INIT_COMPLETE_SENTINEL_REL))).toBe(false);

    await handler.shutdown();
  });
});
