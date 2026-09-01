import {
  runtimeStateMessageSchema,
  sessionCommandAbortedAckFrameSchema,
  sessionCommandAppliedFrameSchema,
  sessionCommandFinalizedAckFrameSchema,
  sessionEventMessageSchema,
  sessionEventRejectedReasonSchema,
  sessionReconcileRequestSchema,
  sessionRuntimeMessageSchema,
  sessionStateMessageSchema,
} from "@first-tree/shared";
import { and, eq, inArray, ne } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import type { WebSocket } from "ws";
import { agentChatSessions } from "../../../db/schema/agent-chat-sessions.js";
import * as activityService from "../../../services/chat/sessions/activity.js";
import * as sessionEventService from "../../../services/chat/sessions/events.js";
import * as contextTreeIoService from "../../../services/context-tree/io.js";
import * as landingCampaignChatStateService from "../../../services/landing-campaigns/chat-state.js";
import * as notificationService from "../../../services/notification.js";
import type { Notifier } from "../../../services/notifier.js";
import * as connectionManager from "../../../services/runtime/connection-manager.js";
import * as presenceService from "../../../services/runtime/presence.js";
import {
  type SessionCommandRpcPhase,
  storeSessionCommandRpcResult,
} from "../../../services/runtime/rpc/session-command.js";
import { KeyedOperationQueue } from "../../../utils/keyed-operation-queue.js";
import type { ClientWsConnectionContext } from "./connection-context.js";

export function createSessionFrameHandler(
  app: FastifyInstance,
  socket: WebSocket,
  notifier: Notifier,
  instanceId: string,
  context: ClientWsConnectionContext,
) {
  const sessionOpQueue = new KeyedOperationQueue();
  function chainSessionOp(agentId: string, chatId: string, op: () => Promise<void>): Promise<void> {
    return sessionOpQueue.run(`${agentId}:${chatId}`, op);
  }

  return async function handleSessionFrame(
    type: string,
    msg: unknown,
    base: { agentId?: string; ref?: string },
  ): Promise<boolean | undefined> {
    const clientId = context.getClientId();
    const parsed = { data: base };
    const boundAgents = {
      has: context.hasBoundAgent,
      get: context.getBoundAgent,
    };
    if (type === "session:state") {
      const agentId = parsed.data.agentId;
      if (!agentId || !(await context.ensureAgentStillRoutedHere(agentId))) {
        socket.send(JSON.stringify({ type: "error", message: "Agent not bound" }));
        return;
      }

      const payloadResult = sessionStateMessageSchema.safeParse(msg);
      if (!payloadResult.success) {
        // Strict wire contract: the client may only report active/suspended.
        // A stale client sending `evicted` gets a hard reject; its local state
        // has already moved, and the next inbound message will re-sync via the
        // evictedMappings resume path. See proposal §Wire-Level Strictness.
        socket.send(
          JSON.stringify({
            type: "error",
            message: "Unsupported session state from client; client upgrade required",
          }),
        );
        const rawState = (msg as { state?: unknown }).state;
        app.log.warn({ clientId, agentId, rawState }, "session:state rejected — stale client wire");
        return;
      }

      const boundAgentInfo = boundAgents.get(agentId);
      if (!boundAgentInfo) return;
      // Run on the per-(agent,chat) FIFO so a `session:runtime`
      // frame (which only writes to an `active` row) can't be
      // reordered ahead of the `session:state active` that
      // creates / activates that row. The op MUST catch internally
      // (mirroring `session:event`): a thrown upsert would
      // otherwise reject the queued promise with no handler (the
      // chain only consumes the prior op's rejection when a
      // *next* op is enqueued), surfacing as an unhandled
      // rejection.
      await chainSessionOp(agentId, payloadResult.data.chatId, async () => {
        try {
          await activityService.upsertSessionState(
            app.db,
            agentId,
            payloadResult.data.chatId,
            payloadResult.data.state,
            boundAgentInfo.organizationId,
            notifier,
          );
        } catch (err) {
          socket.send(
            JSON.stringify({
              type: "error",
              message: `Failed to persist session state: ${err instanceof Error ? err.message : String(err)}`,
            }),
          );
        }
      });
    } else if (type === "session:runtime") {
      const agentId = parsed.data.agentId;
      if (!agentId || !(await context.ensureAgentStillRoutedHere(agentId))) {
        socket.send(JSON.stringify({ type: "error", message: "Agent not bound" }));
        return;
      }

      const payloadResult = sessionRuntimeMessageSchema.safeParse(msg);
      if (!payloadResult.success) {
        socket.send(JSON.stringify({ type: "error", message: "Malformed session:runtime frame" }));
        return;
      }
      const boundInfo = boundAgents.get(agentId);
      if (!boundInfo) return;
      const { chatId, runtimeState, backgroundWork } = payloadResult.data;
      // Same per-(agent,chat) FIFO as session:state / session:event —
      // setSessionRuntime gates on `state='active'`, so the upstream
      // state write must drain first.
      await chainSessionOp(agentId, chatId, async () => {
        try {
          await activityService.setSessionRuntime(
            app.db,
            agentId,
            chatId,
            runtimeState,
            boundInfo.organizationId,
            notifier,
            backgroundWork === true,
          );
        } catch (err) {
          socket.send(
            JSON.stringify({
              type: "error",
              message: `Failed to persist session runtime: ${err instanceof Error ? err.message : String(err)}`,
            }),
          );
        }
      });
    } else if (type === "session:reconcile") {
      const agentId = parsed.data.agentId;
      if (!agentId || !(await context.ensureAgentStillRoutedHere(agentId))) {
        socket.send(JSON.stringify({ type: "error", message: "Agent not bound" }));
        return;
      }

      const payloadResult = sessionReconcileRequestSchema.safeParse(msg);
      if (!payloadResult.success) {
        socket.send(JSON.stringify({ type: "error", message: "Malformed session:reconcile frame" }));
        return;
      }

      const { chatIds } = payloadResult.data;
      const aliveRows = chatIds.length
        ? await app.db
            .select({ chatId: agentChatSessions.chatId })
            .from(agentChatSessions)
            .where(
              and(
                eq(agentChatSessions.agentId, agentId),
                inArray(agentChatSessions.chatId, chatIds),
                ne(agentChatSessions.state, "evicted"),
              ),
            )
        : [];
      const alive = new Set(aliveRows.map((r) => r.chatId));
      const staleChatIds = chatIds.filter((id) => !alive.has(id));

      socket.send(
        JSON.stringify({
          type: "session:reconcile:result",
          agentId,
          staleChatIds,
        }),
      );
    } else if (type === "runtime:state") {
      const agentId = parsed.data.agentId;
      if (!agentId || !(await context.ensureAgentStillRoutedHere(agentId))) {
        socket.send(JSON.stringify({ type: "error", message: "Agent not bound" }));
        return;
      }

      const payload = runtimeStateMessageSchema.parse(msg);
      const boundAgentInfo = boundAgents.get(agentId);
      if (!boundAgentInfo) return;
      await presenceService.setRuntimeState(app.db, agentId, payload.runtimeState, {
        organizationId: boundAgentInfo.organizationId,
        notifier,
      });

      // All three fault types share one dedup key (`agent:{id}:fault`),
      // so a noisy reconcile loop — or a runtime that flips error →
      // blocked → error — collapses to a single unread row. Healthy
      // states close that row so the badge doesn't linger after the
      // agent has already recovered.
      if (payload.runtimeState === "error") {
        notificationService.notifyAgentEvent(app.db, agentId, "agent_error", "high").catch(() => {});
      } else if (payload.runtimeState === "blocked") {
        notificationService.notifyAgentEvent(app.db, agentId, "agent_blocked", "medium").catch(() => {});
      } else if (payload.runtimeState === "idle" || payload.runtimeState === "working") {
        notificationService.markAgentFaultsResolved(app.db, agentId).catch(() => {});
      }
    } else if (type === "session:event") {
      const rawMsg = msg as Record<string, unknown>;
      const agentId = parsed.data.agentId;
      if (!agentId || !(await context.ensureAgentStillRoutedHere(agentId))) {
        const rawRef = typeof rawMsg.ref === "string" && rawMsg.ref.length > 0 ? rawMsg.ref : null;
        if (rawRef && agentId) {
          socket.send(
            JSON.stringify({
              type: "session:event:rejected",
              ref: rawRef,
              agentId,
              reason: sessionEventRejectedReasonSchema.enum.agent_not_bound,
            }),
          );
        } else {
          socket.send(JSON.stringify({ type: "error", message: "Agent not bound" }));
        }
        return;
      }

      const payloadResult = sessionEventMessageSchema.safeParse(msg);
      if (!payloadResult.success) {
        const rawRef = typeof rawMsg.ref === "string" && rawMsg.ref.length > 0 ? rawMsg.ref : null;
        if (rawRef) {
          socket.send(
            JSON.stringify({
              type: "session:event:rejected",
              ref: rawRef,
              agentId,
              chatId: typeof rawMsg.chatId === "string" ? rawMsg.chatId : undefined,
              reason: sessionEventRejectedReasonSchema.enum.malformed,
            }),
          );
        } else {
          socket.send(JSON.stringify({ type: "error", message: "Malformed session:event frame" }));
        }
        return;
      }
      const payload = payloadResult.data;
      const boundInfo = boundAgents.get(agentId);
      chainSessionOp(agentId, payload.chatId, async () => {
        try {
          const persistedEvent = await sessionEventService.appendLiveEvent(
            app.db,
            agentId,
            payload.chatId,
            payload.event,
          );
          if (!persistedEvent) {
            // The session is evicted: a late frame from the old turn
            // (emitted before the client processed session:terminate)
            // or a producer racing the operator's reset. Dropped at
            // persistence so it can never recreate cleared traces;
            // reject the ref honestly so the client's pending event
            // resolves instead of hanging while it tears the session
            // down.
            if (payload.ref) {
              socket.send(
                JSON.stringify({
                  type: "session:event:rejected",
                  ref: payload.ref,
                  agentId,
                  chatId: payload.chatId,
                  // Deliberately the pre-existing reason: old clients
                  // strict-parse the rejection frame, and an unknown
                  // enum value would make them drop it and hang the
                  // pending event until timeout. The session is being
                  // torn down anyway; the client only needs the
                  // pending ref resolved.
                  reason: sessionEventRejectedReasonSchema.enum.persist_failed,
                }),
              );
            }
            return;
          }
          if (
            payload.ref &&
            payload.event.kind === "turn_end" &&
            payload.event.payload.status === "success" &&
            typeof payload.event.payload.turnCompletionId === "string"
          ) {
            const result = await landingCampaignChatStateService.completeLandingCampaignTrialAgentTurn(
              app.db,
              payload.chatId,
              agentId,
              payload.event.payload.turnCompletionId,
            );
            if (result.advanced) {
              notifier.notifyChatUpdated(payload.chatId).catch(() => {});
            }
          }
          if (boundInfo) {
            await contextTreeIoService
              .recordFromSessionEvent(app.db, {
                organizationId: boundInfo.organizationId,
                agentId,
                chatId: payload.chatId,
                runtimeProvider: boundInfo.runtimeProvider,
                sessionEvent: persistedEvent,
              })
              .catch((err) => {
                app.log.warn({ err, agentId, chatId: payload.chatId }, "context-tree IO record failed (non-fatal)");
              });
          }
          if (boundInfo) {
            // Best-effort cross-instance kick so admin WS sockets in
            // the same org can invalidate `liveActivity` without
            // waiting for the 15s `me/chats` poll. Failures are
            // swallowed inside the notifier (fire-and-forget).
            notifier
              .notifySessionEvent(agentId, payload.chatId, payload.event.kind, boundInfo.organizationId)
              .catch(() => {});
          }
          if (payload.ref) {
            socket.send(
              JSON.stringify({
                type: "session:event:accepted",
                ref: payload.ref,
                agentId,
                chatId: payload.chatId,
              }),
            );
          }
        } catch (err) {
          if (payload.ref) {
            socket.send(
              JSON.stringify({
                type: "session:event:rejected",
                ref: payload.ref,
                agentId,
                chatId: payload.chatId,
                reason: sessionEventRejectedReasonSchema.enum.persist_failed,
              }),
            );
          } else {
            socket.send(
              JSON.stringify({
                type: "error",
                message: `Failed to persist session event: ${err instanceof Error ? err.message : String(err)}`,
              }),
            );
          }
        }
      });
    } else if (type === "session:command:applied") {
      // Apply-ack for a ref'd session command (the Web Reset flow).
      // The HTTP waiter may live on ANOTHER replica, so the ack is
      // made durable (clients.metadata, instance-guarded) and a
      // result wake is fanned out; the local waiter resolves too.
      const parsedAck = sessionCommandAppliedFrameSchema.safeParse(msg);
      if (!parsedAck.success) {
        app.log.warn(
          { clientId, issues: parsedAck.error.issues.map((i) => i.message) },
          "malformed session:command:applied frame — dropping",
        );
        return;
      }
      if (!clientId) return;
      // Reject a locally replaced socket before touching durable state.
      if (!connectionManager.isActiveClientConnection(clientId, socket)) {
        app.log.debug(
          { clientId, ref: parsedAck.data.ref },
          "ignoring session:command:applied from replaced local socket",
        );
        return;
      }
      // The ack must come from the agent's CURRENT route: this client
      // owns the agent binding on this socket right now.
      if (
        !boundAgents.has(parsedAck.data.agentId) ||
        connectionManager.getAgentClientId(parsedAck.data.agentId) !== clientId
      ) {
        app.log.debug(
          { clientId, agentId: parsedAck.data.agentId, ref: parsedAck.data.ref },
          "ignoring session:command:applied from an agent not routed to this client",
        );
        return;
      }
      // …and from a socket that still speaks the composite Reset
      // protocol. Accepting this ack is what lets the HTTP waiter
      // conclude the provider mapping is gone and evict the session,
      // so a legacy build that re-registered under the same clientId
      // must not be able to complete a Reset it cannot finish. The
      // durable store applies the same rule for the `applied` phase;
      // this is the live-socket half of it.
      if (!connectionManager.agentSupportsSessionResetV1(parsedAck.data.agentId)) {
        app.log.debug(
          { clientId, agentId: parsedAck.data.agentId, ref: parsedAck.data.ref },
          "ignoring session:command:applied from a client that no longer advertises wsSessionResetV1",
        );
        return;
      }
      const stored = await storeSessionCommandRpcResult(
        app.db,
        clientId,
        parsedAck.data.ref,
        {
          command: "session:terminate",
          agentId: parsedAck.data.agentId,
          chatId: parsedAck.data.chatId,
          applied: parsedAck.data.applied,
        },
        instanceId,
      );
      if (!stored) {
        app.log.debug(
          { clientId, ref: parsedAck.data.ref, instanceId },
          "ignoring session:command:applied; client ownership moved before durable write",
        );
        return;
      }
      connectionManager.resolveClientReply(clientId, parsedAck.data.ref, parsedAck.data);
      await notifier.notifyDaemonClientCommandResult({ clientId, ref: parsedAck.data.ref });
    } else if (type === "session:command:finalized:ack" || type === "session:command:aborted:ack") {
      // Post-apply disposition receipt: the client released (or
      // refused to release) parked Reset-fence recovery for this exact
      // generation, after either a durable eviction
      // (`finalized:ack`) or a Reset the server could not finalize
      // (`aborted:ack`). Correlated on its own `ackRef` so a late
      // apply-ack wake for the terminate ref cannot satisfy the
      // disposition waiter, with the same durable rendezvous as the
      // apply-ack so a lost PG wake still converges.
      //
      // Deliberately WITHOUT the apply-ack's `wsSessionResetV1`
      // recheck: only a client that already applied gets here, and
      // this receipt just releases its own parked rows; rejecting it
      // over a capability flag that flipped mid-handshake would leave
      // that client fenced on a session it can no longer reach.
      //
      // Both dispositions are also scoped to CLIENT identity rather
      // than the agent's current route: `isActiveClientConnection` pins
      // the frame to the applying client's live socket and `boundAgents`
      // proves this socket bound that agent. The agent's route may have
      // moved since the apply — for `aborted` that is the very trigger —
      // and following it would refuse the receipt in exactly the cases a
      // disposition exists for, stranding the client that armed the
      // fence while telling a replacement client about a Reset it never
      // applied.
      const phase: SessionCommandRpcPhase = type === "session:command:aborted:ack" ? "aborted" : "finalized";
      const parsedReceipt =
        phase === "aborted"
          ? sessionCommandAbortedAckFrameSchema.safeParse(msg)
          : sessionCommandFinalizedAckFrameSchema.safeParse(msg);
      if (!parsedReceipt.success) {
        app.log.warn(
          { clientId, issues: parsedReceipt.error.issues.map((i) => i.message) },
          `malformed ${type} frame — dropping`,
        );
        return;
      }
      if (!clientId) return;
      if (!connectionManager.isActiveClientConnection(clientId, socket)) {
        app.log.debug({ clientId, ref: parsedReceipt.data.ackRef }, `ignoring ${type} from replaced local socket`);
        return;
      }
      if (!boundAgents.has(parsedReceipt.data.agentId)) {
        app.log.debug(
          { clientId, agentId: parsedReceipt.data.agentId, ref: parsedReceipt.data.ackRef },
          `ignoring ${type} from an agent this socket never bound`,
        );
        return;
      }
      const receipt = {
        command: "session:terminate" as const,
        agentId: parsedReceipt.data.agentId,
        chatId: parsedReceipt.data.chatId,
        applied: parsedReceipt.data.released,
        phase,
      };
      const receiptStored = await storeSessionCommandRpcResult(
        app.db,
        clientId,
        parsedReceipt.data.ackRef,
        receipt,
        instanceId,
      );
      if (!receiptStored) {
        app.log.debug(
          { clientId, ref: parsedReceipt.data.ackRef, instanceId },
          `ignoring ${type}; client ownership moved before durable write`,
        );
        return;
      }
      connectionManager.resolveClientReply(clientId, parsedReceipt.data.ackRef, receipt);
      await notifier.notifyDaemonClientCommandResult({ clientId, ref: parsedReceipt.data.ackRef });
    } else return false;
    return true;
  };
}
