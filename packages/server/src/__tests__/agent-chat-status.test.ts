import { randomUUID } from "node:crypto";
import {
  agentChatStatusSchema,
  encodeProviderRetryEventMessage,
  LIVE_ACTIVITY_STALE_MS,
  type LiveActivity,
  RUNTIME_STALE_MS,
} from "@first-tree/shared";
import { sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { describe, expect, it, vi } from "vitest";
import { createAgent } from "../services/agents/identity.js";
import {
  computeErrored,
  computeWorking,
  getChatAgentStatus,
  getChatAgentStatuses,
  isRuntimeFresh,
  previewAssistantTextFull,
  resolveAgentChatStatuses,
  withTurnNarration,
} from "../services/chat/sessions/status.js";
import { createMeChat } from "../services/chat/workspace/me-chat.js";
import { createTestAdmin, createTestAgent, useTestApp } from "./helpers.js";

describe("agent-chat-status", () => {
  const getApp = useTestApp();

  async function bindPresence(agentId: string, clientId: string, runtimeState = "idle"): Promise<void> {
    await getApp().db.execute(sql`
      INSERT INTO agent_presence (agent_id, status, client_id, runtime_state, last_seen_at)
      VALUES (${agentId}, 'online', ${clientId}, ${runtimeState}, NOW())
      ON CONFLICT (agent_id) DO UPDATE
        SET status = 'online', client_id = EXCLUDED.client_id, runtime_state = EXCLUDED.runtime_state
    `);
  }

  async function setSession(agentId: string, chatId: string, state: string): Promise<void> {
    await getApp().db.execute(sql`
      INSERT INTO agent_chat_sessions (agent_id, chat_id, state, updated_at)
      VALUES (${agentId}, ${chatId}, ${state}, NOW())
      ON CONFLICT (agent_id, chat_id) DO UPDATE SET state = EXCLUDED.state
    `);
  }

  // Seed `runtime_state` + `runtime_state_at` on the row. `atOffsetMs`
  // shifts the freshness stamp relative to NOW (negative = older); fresh
  // by default. The producer reads these as the per-chat D-axis truth
  // (per #553 rebase: working / errored are no longer derived from
  // `session_events` freshness, they read these columns directly).
  async function setRuntime(agentId: string, chatId: string, runtimeState: string, atOffsetMs = 0): Promise<void> {
    await getApp().db.execute(sql`
      UPDATE agent_chat_sessions
        SET runtime_state = ${runtimeState},
            runtime_state_at = NOW() + (${atOffsetMs}::int * interval '1 millisecond')
        WHERE agent_id = ${agentId} AND chat_id = ${chatId}
    `);
  }

  async function insertEvent(
    agentId: string,
    chatId: string,
    seq: number,
    kind: string,
    payload: unknown,
  ): Promise<void> {
    await getApp().db.execute(sql`
      INSERT INTO session_events (id, agent_id, chat_id, seq, kind, payload, created_at)
      VALUES (${randomUUID()}, ${agentId}, ${chatId}, ${seq}, ${kind}, ${JSON.stringify(payload)}::jsonb, NOW())
    `);
  }

  async function newChatWithAgent() {
    const app = getApp();
    const admin = await createTestAdmin(app);
    const peer = await createTestAgent(app, { name: `acs-${randomUUID().slice(0, 6)}` });
    const { chatId } = await createMeChat(app.db, admin.humanAgentUuid, admin.organizationId, {
      participantIds: [peer.agent.uuid],
    });
    return { app, admin, peer, chatId };
  }

  describe("getChatAgentStatuses (the /agent-status projection)", () => {
    it("folds reachability + active session, and excludes humans", async () => {
      const { app, admin, peer, chatId } = await newChatWithAgent();
      await bindPresence(peer.agent.uuid, peer.clientId);
      await setSession(peer.agent.uuid, chatId, "active");

      const statuses = await getChatAgentStatuses(app.db, chatId);
      const s = statuses.find((x) => x.agentId === peer.agent.uuid);
      expect(s?.reachable).toBe(true);
      expect(s?.engagement).toBe("active");
      // The human speaker is not a runtime agent — excluded.
      expect(statuses.some((x) => x.agentId === admin.humanAgentUuid)).toBe(false);
    });

    it("returns an empty list when the chat has no non-human speakers", async () => {
      const app = getApp();
      const admin = await createTestAdmin(app);
      const teammate = await createTestAdmin(app);
      const { chatId } = await createMeChat(app.db, admin.humanAgentUuid, admin.organizationId, {
        participantIds: [teammate.humanAgentUuid],
      });

      await expect(getChatAgentStatuses(app.db, chatId)).resolves.toEqual([]);
    });

    it("a reachable agent with no session reads as ready (not offline)", async () => {
      const { app, peer, chatId } = await newChatWithAgent();
      await bindPresence(peer.agent.uuid, peer.clientId);

      const s = (await getChatAgentStatuses(app.db, chatId)).find((x) => x.agentId === peer.agent.uuid);
      expect(s?.reachable).toBe(true);
      expect(s?.engagement).toBe("none");
      expect(s?.main).toBe("ready");
    });

    it("an unbound agent (no presence row) is offline even with an active session", async () => {
      const { app, peer, chatId } = await newChatWithAgent();
      await setSession(peer.agent.uuid, chatId, "active");

      const s = (await getChatAgentStatuses(app.db, chatId)).find((x) => x.agentId === peer.agent.uuid);
      expect(s?.reachable).toBe(false);
      expect(s?.main).toBe("offline"); // reachability gates everything
    });

    it("active session + per-chat runtime=working + fresh tool_call surfaces as working with the activity label", async () => {
      const { app, peer, chatId } = await newChatWithAgent();
      await bindPresence(peer.agent.uuid, peer.clientId);
      await setSession(peer.agent.uuid, chatId, "active");
      await setRuntime(peer.agent.uuid, chatId, "working");
      await insertEvent(peer.agent.uuid, chatId, 1, "tool_call", {
        toolUseId: "t1",
        name: "Bash",
        args: null,
        status: "pending",
      });

      const s = (await getChatAgentStatuses(app.db, chatId)).find((x) => x.agentId === peer.agent.uuid);
      expect(s?.working).toBe(true);
      expect(s?.main).toBe("working");
      expect(s?.activity?.label).toBe("Bash");
    });

    // turnText (folds closed PR #558) — current-turn narration on the /agent-status path.
    it("keeps the current turn's narration on turnText even after a tool_call (sticky)", async () => {
      const { app, peer, chatId } = await newChatWithAgent();
      await bindPresence(peer.agent.uuid, peer.clientId);
      await setSession(peer.agent.uuid, chatId, "active");
      await setRuntime(peer.agent.uuid, chatId, "working");
      await insertEvent(peer.agent.uuid, chatId, 1, "assistant_text", { text: "Let me check compose-status-bar.tsx" });
      await insertEvent(peer.agent.uuid, chatId, 2, "tool_call", {
        toolUseId: "t1",
        name: "Read",
        args: { file_path: "x" },
        status: "pending",
      });

      const s = (await getChatAgentStatuses(app.db, chatId)).find((x) => x.agentId === peer.agent.uuid);
      expect(s?.main).toBe("working");
      // Base activity stays the tool — sidebar / chat-list keep "Using Read".
      expect(s?.activity?.kind).toBe("tool_call");
      expect(s?.activity?.label).toBe("Read");
      // Compose bar reads the sticky narration off turnText.
      expect(s?.activity?.turnText).toBe("Let me check compose-status-bar.tsx");
    });

    it("does not carry a previous turn's narration into a fresh turn (turnText past turn_end)", async () => {
      const { app, peer, chatId } = await newChatWithAgent();
      await bindPresence(peer.agent.uuid, peer.clientId);
      await setSession(peer.agent.uuid, chatId, "active");
      await setRuntime(peer.agent.uuid, chatId, "working");
      await insertEvent(peer.agent.uuid, chatId, 1, "assistant_text", { text: "old turn narration" });
      await insertEvent(peer.agent.uuid, chatId, 2, "turn_end", { status: "success" });
      await insertEvent(peer.agent.uuid, chatId, 3, "tool_call", {
        toolUseId: "t2",
        name: "Bash",
        args: null,
        status: "pending",
      });

      const s = (await getChatAgentStatuses(app.db, chatId)).find((x) => x.agentId === peer.agent.uuid);
      expect(s?.main).toBe("working");
      expect(s?.activity?.kind).toBe("tool_call");
      expect(s?.activity?.turnText).toBeUndefined();
    });

    it("every result satisfies the AgentChatStatus invariant (main === derive(axes))", async () => {
      const { app, peer, chatId } = await newChatWithAgent();
      await bindPresence(peer.agent.uuid, peer.clientId, "error");
      await setSession(peer.agent.uuid, chatId, "active");
      for (const s of await getChatAgentStatuses(app.db, chatId)) {
        expect(() => agentChatStatusSchema.parse(s)).not.toThrow();
      }
    });

    it("projects provider retry statusReason without feeding the derived main status", async () => {
      const { app, peer, chatId } = await newChatWithAgent();
      await bindPresence(peer.agent.uuid, peer.clientId);
      await setSession(peer.agent.uuid, chatId, "active");
      await insertEvent(peer.agent.uuid, chatId, 1, "error", {
        message: encodeProviderRetryEventMessage({
          event: "provider_retry_scheduled",
          provider: "codex",
          scope: "provider_turn",
          category: "transient_transport",
          reasonCode: "provider_transient_transport",
          attempt: 1,
          maxAttempts: 2,
          retryMode: "foreground",
          delayMs: 500,
          nextRetryAt: "2026-06-22T10:00:00.000Z",
          replaySafety: "pre_visible",
          userSeverity: "info",
          messagePreview: "fetch failed",
        }),
      });

      const s = (await getChatAgentStatuses(app.db, chatId)).find((x) => x.agentId === peer.agent.uuid);
      expect(s?.main).toBe("ready");
      expect(s?.statusReason?.kind).toBe("retrying");
      expect(s?.statusReason?.reasonCode).toBe("provider_transient_transport");
      expect(() => agentChatStatusSchema.parse(s)).not.toThrow();
    });

    it("clears provider retry statusReason when the latest structured event is succeeded", async () => {
      const { app, peer, chatId } = await newChatWithAgent();
      await bindPresence(peer.agent.uuid, peer.clientId);
      await setSession(peer.agent.uuid, chatId, "active");
      await insertEvent(peer.agent.uuid, chatId, 1, "error", {
        message: encodeProviderRetryEventMessage({
          event: "provider_retry_scheduled",
          provider: "codex",
          scope: "provider_turn",
          category: "transient_transport",
          reasonCode: "provider_transient_transport",
          attempt: 1,
          maxAttempts: 2,
          retryMode: "foreground",
          delayMs: 500,
          replaySafety: "pre_visible",
          userSeverity: "info",
        }),
      });
      await insertEvent(peer.agent.uuid, chatId, 2, "error", {
        message: encodeProviderRetryEventMessage({
          event: "provider_retry_succeeded",
          provider: "codex",
          scope: "provider_turn",
          category: "transient_transport",
          reasonCode: "provider_transient_transport",
          replaySafety: "pre_visible",
          userSeverity: "info",
        }),
      });

      const s = (await getChatAgentStatuses(app.db, chatId)).find((x) => x.agentId === peer.agent.uuid);
      expect(s?.main).toBe("ready");
      expect(s?.statusReason).toBeUndefined();
    });

    it("drops a stale terminal statusReason once the agent is working a new turn", async () => {
      // Repro: a turn exhausted its provider retries (terminal), then the user
      // re-sent and a NEW turn is in flight (runtime working) but has not yet
      // emitted a `turn_end`. The exhausted reason is from the prior, superseded
      // turn — it must not keep rendering as a red "Provider retry exhausted"
      // over a visibly-working agent. (Without the working-gate the compose bar
      // shows the terminal reason for the whole new turn — the reported bug.)
      const { app, peer, chatId } = await newChatWithAgent();
      await bindPresence(peer.agent.uuid, peer.clientId);
      await setSession(peer.agent.uuid, chatId, "active");
      await setRuntime(peer.agent.uuid, chatId, "working");
      await insertEvent(peer.agent.uuid, chatId, 1, "error", {
        message: encodeProviderRetryEventMessage({
          event: "provider_retry_exhausted",
          provider: "claude-code",
          scope: "provider_turn",
          category: "configuration",
          reasonCode: "claude_native_binary_missing",
          attempt: 2,
          maxAttempts: 2,
          retryMode: "foreground",
          replaySafety: "pre_provider",
          userSeverity: "error",
        }),
      });
      // The new turn's first activity event — higher seq than the exhaustion.
      await insertEvent(peer.agent.uuid, chatId, 2, "tool_call", {
        toolUseId: "t1",
        name: "Bash",
        args: null,
        status: "pending",
      });

      const s = (await getChatAgentStatuses(app.db, chatId)).find((x) => x.agentId === peer.agent.uuid);
      expect(s?.main).toBe("working");
      expect(s?.statusReason).toBeUndefined();
    });

    it("keeps a session-scoped terminal statusReason even while the agent is working", async () => {
      // The working-gate is scoped strictly to `provider_turn`. A
      // `session_resume` / `session_start` terminal reason is session-scoped,
      // not turn-scoped, so a turn-level "working" signal must not erase it
      // from the server-side status projection. Individual Web surfaces can
      // choose to suppress it when showing a live working affordance.
      const { app, peer, chatId } = await newChatWithAgent();
      await bindPresence(peer.agent.uuid, peer.clientId);
      await setSession(peer.agent.uuid, chatId, "active");
      await setRuntime(peer.agent.uuid, chatId, "working");
      await insertEvent(peer.agent.uuid, chatId, 1, "error", {
        message: encodeProviderRetryEventMessage({
          event: "provider_failure_terminal",
          provider: "claude-code",
          scope: "session_resume",
          category: "credential",
          reasonCode: "session_resume_failed",
          replaySafety: "unsafe",
          userSeverity: "error",
        }),
      });
      await insertEvent(peer.agent.uuid, chatId, 2, "tool_call", {
        toolUseId: "t1",
        name: "Bash",
        args: null,
        status: "pending",
      });

      const s = (await getChatAgentStatuses(app.db, chatId)).find((x) => x.agentId === peer.agent.uuid);
      expect(s?.main).toBe("working");
      expect(s?.statusReason?.kind).toBe("terminal");
      expect(s?.statusReason?.scope).toBe("session_resume");
    });

    it("keeps a terminal statusReason while the agent is NOT working (last turn failed)", async () => {
      // Idle after a terminal exhaustion with no new turn yet: the reason still
      // describes the genuine last outcome and should remain visible until a new
      // turn supersedes it. Guards against the working-gate over-clearing.
      const { app, peer, chatId } = await newChatWithAgent();
      await bindPresence(peer.agent.uuid, peer.clientId);
      await setSession(peer.agent.uuid, chatId, "active");
      await insertEvent(peer.agent.uuid, chatId, 1, "error", {
        message: encodeProviderRetryEventMessage({
          event: "provider_retry_exhausted",
          provider: "claude-code",
          scope: "provider_turn",
          category: "configuration",
          reasonCode: "claude_native_binary_missing",
          attempt: 2,
          maxAttempts: 2,
          retryMode: "foreground",
          replaySafety: "pre_provider",
          userSeverity: "error",
        }),
      });

      const s = (await getChatAgentStatuses(app.db, chatId)).find((x) => x.agentId === peer.agent.uuid);
      expect(s?.main).toBe("ready");
      expect(s?.statusReason?.kind).toBe("terminal");
      expect(s?.statusReason?.label).toBe("Provider retry exhausted");
    });

    it("keeps a retrying statusReason while the agent is working (in-turn foreground retry)", async () => {
      // A foreground retry mid-turn is the legitimate working+reason combo — the
      // working-gate only drops `terminal`, never `retrying` / `waiting`.
      const { app, peer, chatId } = await newChatWithAgent();
      await bindPresence(peer.agent.uuid, peer.clientId);
      await setSession(peer.agent.uuid, chatId, "active");
      await setRuntime(peer.agent.uuid, chatId, "working");
      await insertEvent(peer.agent.uuid, chatId, 1, "tool_call", {
        toolUseId: "t1",
        name: "Bash",
        args: null,
        status: "pending",
      });
      await insertEvent(peer.agent.uuid, chatId, 2, "error", {
        message: encodeProviderRetryEventMessage({
          event: "provider_retry_scheduled",
          provider: "claude-code",
          scope: "provider_turn",
          category: "transient_transport",
          reasonCode: "provider_transient_transport",
          attempt: 1,
          maxAttempts: 2,
          retryMode: "foreground",
          delayMs: 500,
          replaySafety: "pre_visible",
          userSeverity: "info",
        }),
      });

      const s = (await getChatAgentStatuses(app.db, chatId)).find((x) => x.agentId === peer.agent.uuid);
      expect(s?.main).toBe("working");
      expect(s?.statusReason?.kind).toBe("retrying");
    });

    it("clears provider-turn retry statusReason when a later turn_end succeeds", async () => {
      const { app, peer, chatId } = await newChatWithAgent();
      await bindPresence(peer.agent.uuid, peer.clientId);
      await setSession(peer.agent.uuid, chatId, "active");
      await insertEvent(peer.agent.uuid, chatId, 1, "error", {
        message: encodeProviderRetryEventMessage({
          event: "provider_retry_scheduled",
          provider: "codex",
          scope: "provider_turn",
          category: "transient_transport",
          reasonCode: "provider_transient_transport",
          attempt: 1,
          maxAttempts: 2,
          retryMode: "foreground",
          delayMs: 500,
          replaySafety: "pre_visible",
          userSeverity: "info",
        }),
      });
      await insertEvent(peer.agent.uuid, chatId, 2, "turn_end", { status: "success" });

      const s = (await getChatAgentStatuses(app.db, chatId)).find((x) => x.agentId === peer.agent.uuid);
      expect(s?.main).toBe("ready");
      expect(s?.statusReason).toBeUndefined();
    });

    it("keeps session-scoped terminal statusReason when a later turn_end succeeds", async () => {
      const { app, peer, chatId } = await newChatWithAgent();
      await bindPresence(peer.agent.uuid, peer.clientId);
      await setSession(peer.agent.uuid, chatId, "active");
      await insertEvent(peer.agent.uuid, chatId, 1, "error", {
        message: encodeProviderRetryEventMessage({
          event: "provider_failure_terminal",
          provider: "codex",
          scope: "session_start",
          category: "credential",
          reasonCode: "invalid_runtime_session",
          replaySafety: "pre_provider",
          userSeverity: "error",
        }),
      });
      await insertEvent(peer.agent.uuid, chatId, 2, "turn_end", { status: "success" });

      const s = (await getChatAgentStatuses(app.db, chatId)).find((x) => x.agentId === peer.agent.uuid);
      expect(s?.main).toBe("ready");
      expect(s?.statusReason?.kind).toBe("terminal");
      expect(s?.statusReason?.scope).toBe("session_start");
    });
  });

  describe("withTurnNarration — sticky narration on the working activity", () => {
    const base: LiveActivity = {
      agentId: "a1",
      kind: "tool_call",
      label: "Bash",
      startedAt: "2026-05-25T00:00:00.000Z",
      detail: "npm test",
    };

    it("returns null when there is no base activity", () => {
      expect(withTurnNarration(null, "anything")).toBeNull();
    });

    it("keeps the base activity unchanged when there is no narration text", () => {
      expect(withTurnNarration(base, null)).toBe(base);
      expect(withTurnNarration(base, "   ")).toBe(base);
    });

    it("attaches a collapsed narration as turnText without touching kind / label / detail", () => {
      const out = withTurnNarration(base, "  Let me   check the file  ");
      expect(out?.kind).toBe("tool_call");
      expect(out?.label).toBe("Bash");
      expect(out?.detail).toBe("npm test");
      expect(out?.turnText).toBe("Let me check the file");
    });

    it("omits turnTextFull for a short single-line narration (nothing more to expand)", () => {
      const out = withTurnNarration(base, "Reworking the status bar");
      expect(out?.turnText).toBe("Reworking the status bar");
      expect(out?.turnTextFull).toBeUndefined();
    });

    it("attaches turnTextFull when the narration has line breaks turnText flattened", () => {
      const out = withTurnNarration(base, "Plan:\n1. read\n2. edit");
      expect(out?.turnText).toBe("Plan: 1. read 2. edit"); // flattened one-line
      expect(out?.turnTextFull).toBe("Plan:\n1. read\n2. edit"); // newline-preserving
    });

    it("attaches turnTextFull when the narration is longer than the 120-char one-line preview", () => {
      const long = `${"a".repeat(200)}`;
      const out = withTurnNarration(base, long);
      expect(out?.turnText).toHaveLength(120);
      expect(out?.turnTextFull).toBe(long); // full up to 2000, no truncation at 200
    });
  });

  describe("previewAssistantTextFull — newline-preserving full narration", () => {
    it("returns undefined for non-strings and whitespace-only blocks", () => {
      expect(previewAssistantTextFull(undefined)).toBeUndefined();
      expect(previewAssistantTextFull(42)).toBeUndefined();
      expect(previewAssistantTextFull("   \n\t ")).toBeUndefined();
    });

    it("preserves line breaks while collapsing intra-line whitespace and blank-line runs", () => {
      expect(previewAssistantTextFull("  Step   one \n\n\n  Step  two  ")).toBe("Step one\n\nStep two");
      expect(previewAssistantTextFull("a\r\nb")).toBe("a\nb"); // CRLF normalized
    });

    it("caps at ASSISTANT_TEXT_FULL_MAX with a trailing ellipsis", () => {
      const out = previewAssistantTextFull("b".repeat(2500));
      expect(out).toHaveLength(2000);
      expect(out?.endsWith("…")).toBe(true);
    });
  });

  describe("failed semantics (the errored axis, projected once)", () => {
    it("a reachable agent whose per-chat session is errored reads as failed", async () => {
      const { app, peer, chatId } = await newChatWithAgent();
      await bindPresence(peer.agent.uuid, peer.clientId);
      await setSession(peer.agent.uuid, chatId, "errored");
      const s = (await getChatAgentStatuses(app.db, chatId)).find((x) => x.agentId === peer.agent.uuid);
      expect(s?.errored).toBe(true);
      expect(s?.main).toBe("failed");
    });

    it("a reachable agent whose per-chat runtime is 'error' (fresh, active) reads as failed", async () => {
      const { app, peer, chatId } = await newChatWithAgent();
      await bindPresence(peer.agent.uuid, peer.clientId);
      await setSession(peer.agent.uuid, chatId, "active");
      await setRuntime(peer.agent.uuid, chatId, "error");
      const s = (await getChatAgentStatuses(app.db, chatId)).find((x) => x.agentId === peer.agent.uuid);
      expect(s?.errored).toBe(true);
      expect(s?.main).toBe("failed");
    });

    // Reverse #366 regression — for NEW clients (any per-chat session that has
    // reported `session:runtime` at least once): agent-global
    // presence.runtime_state='error' must NOT contribute to the per-chat
    // composite errored axis. The per-chat row is the only authority once
    // the stamp is non-null.
    it("agent-global presence.runtime_state='error' does NOT leak into errored on the new-client path", async () => {
      const { app, peer, chatId } = await newChatWithAgent();
      await bindPresence(peer.agent.uuid, peer.clientId, "error");
      await setSession(peer.agent.uuid, chatId, "active");
      // Mark this session as a NEW client: a per-chat runtime report has
      // landed (idle is fine, the point is `runtime_state_at` becomes
      // non-null and the fallback no longer applies).
      await setRuntime(peer.agent.uuid, chatId, "idle");
      const s = (await getChatAgentStatuses(app.db, chatId)).find((x) => x.agentId === peer.agent.uuid);
      expect(s?.errored).toBe(false);
      expect(s?.main).toBe("ready"); // active session, no working, no error
    });

    // Old-client fallback (one release cycle, spec §6.1 §10): NULL
    // runtime_state_at means the client has never reported per-chat, so
    // composite errored falls back to the legacy agent-global OR-fold.
    // This preserves pre-PR behaviour while the upgrade window is open and
    // self-closes the moment the client reports.
    it("agent-global presence.runtime_state='error' DOES light errored when runtime_state_at is NULL (old-client fallback)", async () => {
      const { app, peer, chatId } = await newChatWithAgent();
      await bindPresence(peer.agent.uuid, peer.clientId, "error");
      await setSession(peer.agent.uuid, chatId, "active");
      // No `setRuntime` call — runtime_state_at stays NULL (old client).
      const s = (await getChatAgentStatuses(app.db, chatId)).find((x) => x.agentId === peer.agent.uuid);
      expect(s?.errored).toBe(true);
      expect(s?.main).toBe("failed");
    });

    it("an unreachable errored agent is offline, not failed (reachability gates)", async () => {
      const { app, peer, chatId } = await newChatWithAgent();
      await setSession(peer.agent.uuid, chatId, "errored");
      const s = (await getChatAgentStatuses(app.db, chatId)).find((x) => x.agentId === peer.agent.uuid);
      expect(s?.main).toBe("offline");
    });

    it("stale per-chat in-flight runtime still surfaces as recovery (errored)", async () => {
      const { app, peer, chatId } = await newChatWithAgent();
      await bindPresence(peer.agent.uuid, peer.clientId);
      await setSession(peer.agent.uuid, chatId, "active");
      await setRuntime(peer.agent.uuid, chatId, "working", -(RUNTIME_STALE_MS + 5_000));
      const s = (await getChatAgentStatuses(app.db, chatId)).find((x) => x.agentId === peer.agent.uuid);
      expect(s?.working).toBe(false);
      expect(s?.errored).toBe(true);
      expect(s?.main).toBe("failed");
    });

    it("fresh blocked runtime surfaces as recovery, not working", async () => {
      const { app, peer, chatId } = await newChatWithAgent();
      await bindPresence(peer.agent.uuid, peer.clientId);
      await setSession(peer.agent.uuid, chatId, "active");
      await setRuntime(peer.agent.uuid, chatId, "blocked");
      const s = (await getChatAgentStatuses(app.db, chatId)).find((x) => x.agentId === peer.agent.uuid);
      expect(s?.working).toBe(false);
      expect(s?.errored).toBe(true);
      expect(s?.main).toBe("failed");
    });

    it("a reachable agent with a healthy active session is not failed", async () => {
      const { app, peer, chatId } = await newChatWithAgent();
      await bindPresence(peer.agent.uuid, peer.clientId);
      await setSession(peer.agent.uuid, chatId, "active");
      const s = (await getChatAgentStatuses(app.db, chatId)).find((x) => x.agentId === peer.agent.uuid);
      expect(s?.main).not.toBe("failed");
    });
  });

  describe("resolveAgentChatStatuses — the one producer", () => {
    it("empty input → empty map", async () => {
      expect((await resolveAgentChatStatuses(getApp().db, [])).size).toBe(0);
    });

    it("accepts known list speakers and omits detail-only status reasons", async () => {
      const { app, peer, chatId } = await newChatWithAgent();
      await bindPresence(peer.agent.uuid, peer.clientId);
      await setSession(peer.agent.uuid, chatId, "active");
      await insertEvent(peer.agent.uuid, chatId, 1, "error", {
        message: encodeProviderRetryEventMessage({
          event: "provider_retry_scheduled",
          provider: "codex",
          scope: "provider_turn",
          category: "transient_transport",
          reasonCode: "provider_transient_transport",
          attempt: 1,
          maxAttempts: 2,
          retryMode: "foreground",
          delayMs: 500,
          replaySafety: "pre_visible",
          userSeverity: "info",
        }),
      });

      const full = (await resolveAgentChatStatuses(app.db, [chatId])).get(chatId)?.[0];
      const list = (
        await resolveAgentChatStatuses(app.db, [chatId], {
          includeStatusReason: false,
          nonHumanSpeakersByChat: new Map([[chatId, new Set([peer.agent.uuid])]]),
        })
      ).get(chatId)?.[0];

      expect(full?.statusReason?.kind).toBe("retrying");
      expect(list?.statusReason).toBeUndefined();
      expect(list?.agentId).toBe(full?.agentId);
      expect(list?.main).toBe(full?.main);
      expect(list?.working).toBe(full?.working);
      expect(list?.errored).toBe(full?.errored);
    });

    it("excludes humans from the union (a human speaker never appears)", async () => {
      const { app, admin, chatId } = await newChatWithAgent();
      const all = (await resolveAgentChatStatuses(app.db, [chatId])).get(chatId) ?? [];
      expect(all.some((s) => s.agentId === admin.humanAgentUuid)).toBe(false);
    });

    it("batch isolation: an agent working in chat A does not leak into chat B (#366 defense)", async () => {
      const app = getApp();
      const admin = await createTestAdmin(app);
      const peer = await createTestAgent(app, { name: `iso-${randomUUID().slice(0, 6)}` });
      const a = await createMeChat(app.db, admin.humanAgentUuid, admin.organizationId, {
        participantIds: [peer.agent.uuid],
        topic: "A",
      });
      const b = await createMeChat(app.db, admin.humanAgentUuid, admin.organizationId, {
        participantIds: [peer.agent.uuid],
        topic: "B",
      });
      await bindPresence(peer.agent.uuid, peer.clientId);
      // Chat A: active + per-chat runtime=working (this is the per-chat truth
      // the producer reads). The session_events row is description-only.
      await setSession(peer.agent.uuid, a.chatId, "active");
      await setRuntime(peer.agent.uuid, a.chatId, "working");
      await insertEvent(peer.agent.uuid, a.chatId, 1, "tool_call", {
        toolUseId: "t1",
        name: "Bash",
        args: null,
        status: "pending",
      });
      // Chat B: suspended + default runtime_state='idle' / NULL stamp.
      await setSession(peer.agent.uuid, b.chatId, "suspended");

      const byChat = await resolveAgentChatStatuses(app.db, [a.chatId, b.chatId]);
      const inA = byChat.get(a.chatId)?.find((s) => s.agentId === peer.agent.uuid);
      const inB = byChat.get(b.chatId)?.find((s) => s.agentId === peer.agent.uuid);
      expect(inA?.main).toBe("working");
      expect(inB?.working).toBe(false);
      expect(inB?.main).toBe("paused");
    });

    // Per-chat truth: an agent can be working in multiple chats simultaneously
    // without cross-talk. Each chat's row is independent — the producer reads
    // each (agent,chat) pair separately.
    it("single agent working in multiple chats concurrently: each chat reads its own runtime", async () => {
      const app = getApp();
      const admin = await createTestAdmin(app);
      const peer = await createTestAgent(app, { name: `multi-${randomUUID().slice(0, 6)}` });
      const a = await createMeChat(app.db, admin.humanAgentUuid, admin.organizationId, {
        participantIds: [peer.agent.uuid],
        topic: "A",
      });
      const b = await createMeChat(app.db, admin.humanAgentUuid, admin.organizationId, {
        participantIds: [peer.agent.uuid],
        topic: "B",
      });
      const c = await createMeChat(app.db, admin.humanAgentUuid, admin.organizationId, {
        participantIds: [peer.agent.uuid],
        topic: "C",
      });
      await bindPresence(peer.agent.uuid, peer.clientId);
      await setSession(peer.agent.uuid, a.chatId, "active");
      await setRuntime(peer.agent.uuid, a.chatId, "working");
      await setSession(peer.agent.uuid, b.chatId, "active");
      await setRuntime(peer.agent.uuid, b.chatId, "working");
      await setSession(peer.agent.uuid, c.chatId, "active");
      await setRuntime(peer.agent.uuid, c.chatId, "idle");

      const byChat = await resolveAgentChatStatuses(app.db, [a.chatId, b.chatId, c.chatId]);
      expect(byChat.get(a.chatId)?.find((s) => s.agentId === peer.agent.uuid)?.main).toBe("working");
      expect(byChat.get(b.chatId)?.find((s) => s.agentId === peer.agent.uuid)?.main).toBe("working");
      expect(byChat.get(c.chatId)?.find((s) => s.agentId === peer.agent.uuid)?.main).toBe("ready");
    });
  });

  describe("resolveAgentChatStatuses target workset / getChatAgentStatus", () => {
    type CapturedStatement = { sql: string; params: unknown[] };

    /**
     * Capture every statement the resolve flow executes by intercepting the
     * Drizzle session's `prepareQuery` chokepoint (both query-builder selects
     * and raw `db.execute` SQL arrive here as `{ sql, params }`). Pure
     * pass-through — execution is untouched.
     */
    async function captureStatements(app: FastifyInstance, run: () => Promise<unknown>): Promise<CapturedStatement[]> {
      const session = (app.db as unknown as { session: { prepareQuery: (...args: unknown[]) => unknown } }).session;
      const originalPrepareQuery = session.prepareQuery.bind(session);
      const captured: CapturedStatement[] = [];
      const spy = vi.spyOn(session, "prepareQuery").mockImplementation(((query: unknown, ...rest: unknown[]) => {
        const q = query as { sql?: unknown; params?: unknown } | null;
        if (q && typeof q.sql === "string" && Array.isArray(q.params)) {
          captured.push({ sql: q.sql, params: q.params as unknown[] });
        }
        return originalPrepareQuery(query, ...rest);
      }) satisfies (...args: unknown[]) => unknown);
      try {
        await run();
      } finally {
        spy.mockRestore();
      }
      return captured;
    }

    /**
     * The (agentId, chatId) pairs carried by a statement's parameters, from
     * the row-value pair predicates `(col, col) IN ((a1,c1),(a2,c2),…)`.
     * Only meaningful for statements whose parameters are exactly the pair
     * list; non-identifier literal params (e.g. `speaker` / `human` filter
     * values on the membership read) are skipped.
     */
    const statementPairs = (statement: CapturedStatement): Array<readonly [string, string]> => {
      const pairs: Array<readonly [string, string]> = [];
      for (let i = 0; i + 1 < statement.params.length; i += 2) {
        const agentId = statement.params[i];
        const chatId = statement.params[i + 1];
        if (
          typeof agentId === "string" &&
          typeof chatId === "string" &&
          /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(agentId) &&
          /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(chatId)
        ) {
          pairs.push([agentId, chatId] as const);
        }
      }
      return pairs;
    };

    const pairList = (pairs: ReadonlyArray<readonly [string, string]>): string =>
      [...pairs]
        .sort()
        .map(([a, c]) => `${a}/${c}`)
        .join(",");

    /** Insert a session event with an explicit ISO timestamp (raw Date
     *  binding is unsupported by the installed driver — always ISO text). */
    async function insertEventAtMs(
      app: FastifyInstance,
      agentId: string,
      chatId: string,
      seq: number,
      kind: string,
      payload: unknown,
      createdAtIso: string,
    ): Promise<void> {
      await app.db.execute(sql`
        INSERT INTO session_events (id, agent_id, chat_id, seq, kind, payload, created_at)
        VALUES (${randomUUID()}, ${agentId}, ${chatId}, ${seq}, ${kind},
                ${JSON.stringify(payload)}::jsonb, ${createdAtIso}::timestamptz)
      `);
    }

    it("downpushes the target workset into every executed query (no sibling pair parameters)", async () => {
      const app = getApp();
      const admin = await createTestAdmin(app);
      const first = await createTestAgent(app, { name: `tgt-a-${randomUUID().slice(0, 6)}` });
      const second = await createTestAgent(app, { name: `tgt-b-${randomUUID().slice(0, 6)}` });
      const { chatId } = await createMeChat(app.db, admin.humanAgentUuid, admin.organizationId, {
        participantIds: [first.agent.uuid, second.agent.uuid],
      });
      for (const peer of [first, second]) {
        await bindPresence(peer.agent.uuid, peer.clientId);
        await setSession(peer.agent.uuid, chatId, "active");
        await setRuntime(peer.agent.uuid, chatId, "idle");
        await insertEvent(peer.agent.uuid, chatId, 1, "tool_call", {
          toolUseId: "t1",
          name: "Bash",
          args: null,
          status: "pending",
        });
      }

      const single = await captureStatements(app, () =>
        resolveAgentChatStatuses(app.db, [chatId], {
          targets: new Map([[chatId, new Set([first.agent.uuid])]]),
        }),
      );
      // Membership read + session-row read + Q3 + Q2 all ran, and every one
      // of them carries only the (first, chat) pair.
      const singleWorkset = single.filter(
        (s) => s.sql.includes("agent_chat_sessions") || s.sql.includes("chat_membership"),
      );
      expect(singleWorkset.length).toBeGreaterThanOrEqual(3);
      for (const statement of singleWorkset) {
        expect(pairList(statementPairs(statement))).toBe(pairList([[first.agent.uuid, chatId]]));
      }
      const singleParams = singleWorkset.flatMap((s) => s.params);
      expect(singleParams).not.toContain(second.agent.uuid);

      const full = await captureStatements(app, () => resolveAgentChatStatuses(app.db, [chatId]));
      const fullWorkset = full.filter((s) => s.sql.includes("agent_chat_sessions"));
      expect(fullWorkset.some((s) => s.params.includes(second.agent.uuid))).toBe(true);
    });

    it("multi-chat targets execute pair-exact SQL — crossed pairs are never fetched", async () => {
      const app = getApp();
      const admin = await createTestAdmin(app);
      const peerX = await createTestAgent(app, { name: `cross-x-${randomUUID().slice(0, 6)}` });
      const peerY = await createTestAgent(app, { name: `cross-y-${randomUUID().slice(0, 6)}` });
      // Both agents speak in BOTH chats and hold session rows in BOTH chats —
      // the exact scenario where a chat × agent cross product would fetch
      // (X, chatB) / (Y, chatA) rows the workset never asked for.
      const chatA = await createMeChat(app.db, admin.humanAgentUuid, admin.organizationId, {
        participantIds: [peerX.agent.uuid, peerY.agent.uuid],
        topic: "A",
      });
      const chatB = await createMeChat(app.db, admin.humanAgentUuid, admin.organizationId, {
        participantIds: [peerX.agent.uuid, peerY.agent.uuid],
        topic: "B",
      });
      for (const peer of [peerX, peerY]) {
        await bindPresence(peer.agent.uuid, peer.clientId);
        await setSession(peer.agent.uuid, chatA.chatId, "active");
        await setSession(peer.agent.uuid, chatB.chatId, "active");
      }
      await setRuntime(peerX.agent.uuid, chatA.chatId, "working");
      await setRuntime(peerY.agent.uuid, chatB.chatId, "working");

      const captured = await captureStatements(app, () =>
        resolveAgentChatStatuses(app.db, [chatA.chatId, chatB.chatId], {
          targets: new Map([
            [chatA.chatId, new Set([peerX.agent.uuid])],
            [chatB.chatId, new Set([peerY.agent.uuid])],
          ]),
        }),
      );

      // Every statement touching a session- or membership-bearing table is
      // parameterised by EXACTLY the two requested pairs — the crossed pairs
      // (X, B) and (Y, A) exist as real session rows here, so an independent
      // chat IN + agent IN filter would have fetched them.
      const worksetStatements = captured.filter(
        (s) => s.sql.includes("agent_chat_sessions") || s.sql.includes("chat_membership"),
      );
      expect(worksetStatements.length).toBeGreaterThanOrEqual(3);
      const expected = pairList([
        [peerX.agent.uuid, chatA.chatId],
        [peerY.agent.uuid, chatB.chatId],
      ]);
      for (const statement of worksetStatements) {
        expect(pairList(statementPairs(statement))).toBe(expected);
      }

      const byChat = await resolveAgentChatStatuses(app.db, [chatA.chatId, chatB.chatId], {
        targets: new Map([
          [chatA.chatId, new Set([peerX.agent.uuid])],
          [chatB.chatId, new Set([peerY.agent.uuid])],
        ]),
      });
      expect(byChat.get(chatA.chatId)?.map((s) => s.agentId)).toEqual([peerX.agent.uuid]);
      expect(byChat.get(chatB.chatId)?.map((s) => s.agentId)).toEqual([peerY.agent.uuid]);
    });

    it("single-target status equals the full projection's entry for the same pair (working + narration preserved)", async () => {
      const { app, peer, chatId } = await newChatWithAgent();
      await bindPresence(peer.agent.uuid, peer.clientId);
      await setSession(peer.agent.uuid, chatId, "active");
      await setRuntime(peer.agent.uuid, chatId, "working");
      await insertEvent(peer.agent.uuid, chatId, 1, "assistant_text", { text: "narration text" });

      const single = await getChatAgentStatus(app.db, chatId, peer.agent.uuid);
      const full = (await getChatAgentStatuses(app.db, chatId)).find((s) => s.agentId === peer.agent.uuid);
      expect(single).toEqual(full);
      expect(single?.main).toBe("working");
      expect(single?.activity?.kind).toBe("assistant_text");
      expect(single?.activity?.turnText).toBe("narration text");
      expect(single?.sessionResetSupported).toBe(full?.sessionResetSupported);
    });

    it("same agent across chats: per-chat target pairs stay exact and independent", async () => {
      const app = getApp();
      const admin = await createTestAdmin(app);
      const peer = await createTestAgent(app, { name: `pair-a-${randomUUID().slice(0, 6)}` });
      const sibling = await createTestAgent(app, { name: `pair-b-${randomUUID().slice(0, 6)}` });
      const chatA = await createMeChat(app.db, admin.humanAgentUuid, admin.organizationId, {
        participantIds: [peer.agent.uuid],
        topic: "A",
      });
      const chatB = await createMeChat(app.db, admin.humanAgentUuid, admin.organizationId, {
        participantIds: [peer.agent.uuid, sibling.agent.uuid],
        topic: "B",
      });
      await bindPresence(peer.agent.uuid, peer.clientId);
      await bindPresence(sibling.agent.uuid, sibling.clientId);
      await setSession(peer.agent.uuid, chatA.chatId, "active");
      await setRuntime(peer.agent.uuid, chatA.chatId, "working");
      await setSession(peer.agent.uuid, chatB.chatId, "suspended");
      await setSession(sibling.agent.uuid, chatB.chatId, "active");
      await setRuntime(sibling.agent.uuid, chatB.chatId, "idle");

      const byChat = await resolveAgentChatStatuses(app.db, [chatA.chatId, chatB.chatId], {
        targets: new Map([
          [chatA.chatId, new Set([peer.agent.uuid])],
          [chatB.chatId, new Set([sibling.agent.uuid])],
        ]),
      });
      expect(byChat.get(chatA.chatId)?.map((s) => s.agentId)).toEqual([peer.agent.uuid]);
      expect(byChat.get(chatA.chatId)?.[0]?.main).toBe("working");
      // chat B targets only the sibling: the peer speaks there too, but the
      // pair-exact workset must not widen to it.
      expect(byChat.get(chatB.chatId)?.map((s) => s.agentId)).toEqual([sibling.agent.uuid]);
      expect(byChat.get(chatB.chatId)?.map((s) => s.agentId)).not.toContain(peer.agent.uuid);

      // The single-target getter reads each chat's own row for the same agent.
      const inA = await getChatAgentStatus(app.db, chatA.chatId, peer.agent.uuid);
      const inB = await getChatAgentStatus(app.db, chatB.chatId, peer.agent.uuid);
      expect(inA?.main).toBe("working");
      expect(inB?.main).toBe("paused");
    });

    it("non-speaker targets resolve to nothing and never widen to the chat's speakers", async () => {
      const { app, admin, peer, chatId } = await newChatWithAgent();
      await bindPresence(peer.agent.uuid, peer.clientId);
      await setSession(peer.agent.uuid, chatId, "active");
      const outsider = await createTestAgent(app, { name: `outsider-${randomUUID().slice(0, 6)}` });
      // A member of the same org, but no membership row in this chat.
      const otherChat = await createMeChat(app.db, admin.humanAgentUuid, admin.organizationId, {
        participantIds: [outsider.agent.uuid],
      });

      await expect(getChatAgentStatus(app.db, chatId, outsider.agent.uuid)).resolves.toBeUndefined();
      // The outsider speaks in a DIFFERENT chat — targeting it for this chat
      // must not pull the peer in either.
      const byChat = await resolveAgentChatStatuses(app.db, [chatId], {
        targets: new Map([[chatId, new Set([outsider.agent.uuid])]]),
      });
      expect(byChat.size).toBe(0);

      // Sanity: the same target in its own chat resolves.
      const own = await getChatAgentStatus(app.db, otherChat.chatId, outsider.agent.uuid);
      expect(own?.agentId).toBe(outsider.agent.uuid);
    });

    it("empty target sets and absent chat keys never mean all agents — and skip the pair reads entirely", async () => {
      const { app, peer, chatId } = await newChatWithAgent();
      await bindPresence(peer.agent.uuid, peer.clientId);
      await setSession(peer.agent.uuid, chatId, "active");

      const emptySet = await captureStatements(app, () =>
        resolveAgentChatStatuses(app.db, [chatId], {
          targets: new Map([[chatId, new Set()]]),
        }),
      );
      expect(
        emptySet.filter((s) => s.sql.includes("agent_chat_sessions") || s.sql.includes("chat_membership")),
      ).toHaveLength(0);

      const absentKey = await captureStatements(app, () =>
        resolveAgentChatStatuses(app.db, [chatId], {
          targets: new Map([[`chat-${crypto.randomUUID()}`, new Set([peer.agent.uuid])]]),
        }),
      );
      expect(
        absentKey.filter((s) => s.sql.includes("agent_chat_sessions") || s.sql.includes("chat_membership")),
      ).toHaveLength(0);
    });

    it("holds the exact LIVE_ACTIVITY_STALE_MS boundary on activity + narration (frozen application clock)", async () => {
      const app = getApp();
      const admin = await createTestAdmin(app);
      const justFresh = await createTestAgent(app, { name: `bound-f-${randomUUID().slice(0, 6)}` });
      const justStale = await createTestAgent(app, { name: `bound-s-${randomUUID().slice(0, 6)}` });
      const { chatId } = await createMeChat(app.db, admin.humanAgentUuid, admin.organizationId, {
        participantIds: [justFresh.agent.uuid, justStale.agent.uuid],
      });
      for (const peer of [justFresh, justStale]) {
        await bindPresence(peer.agent.uuid, peer.clientId);
        await setSession(peer.agent.uuid, chatId, "active");
        await setRuntime(peer.agent.uuid, chatId, "working");
      }

      // Freeze the application clock so the JS stale check and the SQL-side
      // narration cutoff share one reference instant; DB timestamps are
      // inserted explicitly relative to it (ISO text params — raw Date
      // binding is not supported by the installed driver).
      const frozenNow = Date.now();
      const nowSpy = vi.spyOn(Date, "now").mockReturnValue(frozenNow);
      try {
        await insertEventAtMs(
          app,
          justFresh.agent.uuid,
          chatId,
          1,
          "assistant_text",
          { text: "one millisecond fresh" },
          new Date(frozenNow - LIVE_ACTIVITY_STALE_MS + 1).toISOString(),
        );
        await insertEventAtMs(
          app,
          justStale.agent.uuid,
          chatId,
          1,
          "tool_call",
          { toolUseId: "t1", name: "Bash", args: null, status: "pending" },
          new Date(frozenNow - LIVE_ACTIVITY_STALE_MS - 1).toISOString(),
        );

        const byChat = await resolveAgentChatStatuses(app.db, [chatId], { withTurnText: true });
        const fresh = byChat.get(chatId)?.find((s) => s.agentId === justFresh.agent.uuid);
        const stale = byChat.get(chatId)?.find((s) => s.agentId === justStale.agent.uuid);
        // Age 59,999 ms: kept by the JS stale check AND the SQL narration
        // guard — narration rides along.
        expect(fresh?.activity?.kind).toBe("assistant_text");
        expect(fresh?.activity?.turnText).toBe("one millisecond fresh");
        // Age 60,001 ms: dropped by the JS stale check; the guarded narration
        // may not keep it alive (nothing resurrects across the boundary). The
        // schema carries `activity: null` when working without a live
        // activity descriptor.
        expect(stale?.activity).toBeNull();
        expect(stale?.activity?.turnText).toBeUndefined();
        expect(fresh?.working).toBe(true);
        expect(stale?.working).toBe(true); // runtime axis is independent of activity
      } finally {
        nowSpy.mockRestore();
      }
    });

    it("terminal / stale latest events never resurrect older narration or activity", async () => {
      const { app, peer, chatId } = await newChatWithAgent();
      await bindPresence(peer.agent.uuid, peer.clientId);
      await setSession(peer.agent.uuid, chatId, "active");
      await setRuntime(peer.agent.uuid, chatId, "working");
      await insertEvent(peer.agent.uuid, chatId, 1, "assistant_text", { text: "old narration" });

      // A fresh terminal event as the latest row: no activity descriptor
      // (null when working without one), no narration.
      await insertEvent(peer.agent.uuid, chatId, 2, "turn_end", { status: "success" });
      let s = await getChatAgentStatus(app.db, chatId, peer.agent.uuid);
      expect(s?.working).toBe(true); // runtime axis unaffected
      expect(s?.activity).toBeNull();

      // A stale activity-kind latest event (older than LIVE_ACTIVITY_STALE_MS):
      // dropped by the JS stale check — the guarded narration may not keep it
      // alive either.
      await getApp().db.execute(sql`
        INSERT INTO session_events (id, agent_id, chat_id, seq, kind, payload, created_at)
        VALUES (${randomUUID()}, ${peer.agent.uuid}, ${chatId}, 3, 'tool_call',
                ${JSON.stringify({ toolUseId: "t1", name: "Bash", args: null, status: "pending" })}::jsonb,
                NOW() - (${LIVE_ACTIVITY_STALE_MS + 5_000}::int * interval '1 millisecond'))
      `);
      s = await getChatAgentStatus(app.db, chatId, peer.agent.uuid);
      expect(s?.activity).toBeNull();
      expect(s?.activity?.turnText).toBeUndefined();
    });
  });

  // Pure-function helpers — the projection rules in isolation, so the SQL
  // tests above can stay focused on schema/wiring and these can be
  // exhaustive on the truth table.
  describe("isRuntimeFresh / computeWorking / computeErrored — pure projection", () => {
    // Both the captured `now` and the synthetic timestamps reference the
    // same instant — otherwise the "stale by ε" boundary case fails when
    // module-load `now` and call-time `Date.now()` drift across `it`.
    const now = Date.now();
    const recent = (offsetMs: number) => new Date(now + offsetMs);

    it("isRuntimeFresh: false for undefined / suspended / NULL stamp / stale stamp; true for active+fresh", () => {
      expect(isRuntimeFresh(undefined, now)).toBe(false);
      expect(isRuntimeFresh({ state: "suspended", runtimeState: "working", runtimeStateAt: recent(-1000) }, now)).toBe(
        false,
      );
      expect(isRuntimeFresh({ state: "active", runtimeState: "working", runtimeStateAt: null }, now)).toBe(false);
      expect(
        isRuntimeFresh(
          { state: "active", runtimeState: "working", runtimeStateAt: recent(-(RUNTIME_STALE_MS + 1000)) },
          now,
        ),
      ).toBe(false);
      expect(isRuntimeFresh({ state: "active", runtimeState: "working", runtimeStateAt: recent(-1000) }, now)).toBe(
        true,
      );
    });

    it("computeWorking — new-client authoritative path: true only when fresh AND runtime_state==='working'", () => {
      const ok = { state: "active" as const, runtimeState: "working", runtimeStateAt: recent(-1000) };
      expect(computeWorking(ok, null, now)).toBe(true);
      expect(computeWorking({ ...ok, runtimeState: "idle" }, null, now)).toBe(false);
      expect(computeWorking({ ...ok, runtimeState: "blocked" }, null, now)).toBe(false);
      // Stale stamp on a known-new client: stay on new path, fail-closed.
      expect(
        computeWorking(
          { ...ok, runtimeStateAt: recent(-(RUNTIME_STALE_MS + 1000)) },
          { agentId: "a", kind: "tool_call", label: "x", startedAt: new Date().toISOString() },
          now,
        ),
      ).toBe(false);
    });

    it("computeWorking — old-client fallback (NULL stamp): true iff a non-terminal activity is present", () => {
      const active = { state: "active" as const, runtimeState: "idle", runtimeStateAt: null };
      const activity: LiveActivity = {
        agentId: "a",
        kind: "tool_call",
        label: "Bash",
        startedAt: new Date().toISOString(),
      };
      expect(computeWorking(active, activity, now)).toBe(true);
      expect(computeWorking(active, null, now)).toBe(false);
      // Old-client fallback still gated on active.
      expect(computeWorking({ ...active, state: "suspended" }, activity, now)).toBe(false);
    });

    it("computeErrored — new-client authoritative: state='errored' OR fresh error/blocked OR stale in-flight", () => {
      // C-axis lifecycle errored sticks regardless of D-axis state, irrespective of stamp.
      expect(computeErrored({ state: "errored", runtimeState: "idle", runtimeStateAt: null }, null, now)).toBe(true);
      expect(computeErrored({ state: "errored", runtimeState: "idle", runtimeStateAt: null }, "error", now)).toBe(true);
      // D-axis fault counts when fresh + active.
      expect(computeErrored({ state: "active", runtimeState: "error", runtimeStateAt: recent(-1000) }, null, now)).toBe(
        true,
      );
      expect(
        computeErrored({ state: "active", runtimeState: "blocked", runtimeStateAt: recent(-1000) }, null, now),
      ).toBe(true);
      // Fresh working is slow-but-alive, not recovery.
      expect(
        computeErrored({ state: "active", runtimeState: "working", runtimeStateAt: recent(-1000) }, null, now),
      ).toBe(false);
      expect(
        computeErrored({ state: "suspended", runtimeState: "error", runtimeStateAt: recent(-1000) }, null, now),
      ).toBe(false);
      // Stale in-flight must not look idle.
      const staleAt = recent(-(RUNTIME_STALE_MS + 1000));
      expect(computeErrored({ state: "active", runtimeState: "working", runtimeStateAt: staleAt }, null, now)).toBe(
        true,
      );
      expect(computeErrored({ state: "active", runtimeState: "blocked", runtimeStateAt: staleAt }, null, now)).toBe(
        true,
      );
      expect(computeErrored({ state: "active", runtimeState: "error", runtimeStateAt: staleAt }, null, now)).toBe(true);
      expect(computeErrored({ state: "active", runtimeState: "idle", runtimeStateAt: staleAt }, null, now)).toBe(false);
    });

    it("computeErrored — old-client fallback (NULL stamp): legacy presence.runtime_state OR-fold", () => {
      const active = { state: "active" as const, runtimeState: "idle", runtimeStateAt: null };
      // Fallback path lights errored from agent-global presence error — this
      // is pre-PR behaviour, retained for one release cycle; self-closes the
      // moment the client upgrades and starts reporting per-chat runtime.
      expect(computeErrored(active, "error", now)).toBe(true);
      // Global `blocked` must stay out of the NULL-stamp fallback — it is not
      // chat-scoped and historically false-alarmed during long reasoning.
      expect(computeErrored(active, "blocked", now)).toBe(false);
      // Non-error presence on an old-client active row: not errored.
      expect(computeErrored(active, "working", now)).toBe(false);
      expect(computeErrored(active, null, now)).toBe(false);
      // Non-active old-client row: fallback does NOT apply.
      expect(computeErrored({ ...active, state: "suspended" }, "error", now)).toBe(false);
    });
  });

  describe("GET /chats/:chatId/agent-status — route auth + shape", () => {
    it("a chat participant gets 200 and an AgentChatStatus[] of non-human speakers", async () => {
      const app = getApp();
      const admin = await createTestAdmin(app);
      const peer = await createTestAgent(app, { name: `acs-http-${randomUUID().slice(0, 6)}` });
      const { chatId } = await createMeChat(app.db, admin.humanAgentUuid, admin.organizationId, {
        participantIds: [peer.agent.uuid],
      });

      const res = await app.inject({
        method: "GET",
        url: `/api/v1/chats/${chatId}/agent-status`,
        headers: { authorization: `Bearer ${admin.accessToken}` },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json() as Array<{ agentId: string; main: string }>;
      expect(Array.isArray(body)).toBe(true);
      expect(body.find((x) => x.agentId === peer.agent.uuid)).toBeDefined();
      expect(body.some((x) => x.agentId === admin.humanAgentUuid)).toBe(false);
    });

    it("a watcher gets the same chat-scoped status projection without reply access", async () => {
      const app = getApp();
      const manager = await createTestAdmin(app);
      const peer = await createTestAdmin(app);
      const managed = await createAgent(app.db, {
        name: `acs-watched-${randomUUID().slice(0, 6)}`,
        type: "agent",
        displayName: "Watched Agent",
        managerId: manager.memberId,
        organizationId: manager.organizationId,
      });
      const { chatId } = await createMeChat(app.db, peer.humanAgentUuid, peer.organizationId, {
        participantIds: [managed.uuid],
      });

      const res = await app.inject({
        method: "GET",
        url: `/api/v1/chats/${chatId}/agent-status`,
        headers: { authorization: `Bearer ${manager.accessToken}` },
      });

      expect(res.statusCode).toBe(200);
      expect(res.json<Array<{ agentId: string }>>()).toContainEqual(expect.objectContaining({ agentId: managed.uuid }));
    });

    it("a non-member (different org) gets 404, not the status set", async () => {
      const app = getApp();
      const owner = await createTestAdmin(app);
      const peer = await createTestAgent(app, { name: `acs-http2-${randomUUID().slice(0, 6)}` });
      const { chatId } = await createMeChat(app.db, owner.humanAgentUuid, owner.organizationId, {
        participantIds: [peer.agent.uuid],
      });
      const outsider = await createTestAdmin(app);

      const res = await app.inject({
        method: "GET",
        url: `/api/v1/chats/${chatId}/agent-status`,
        headers: { authorization: `Bearer ${outsider.accessToken}` },
      });

      expect(res.statusCode).toBe(404);
    });
  });
});
