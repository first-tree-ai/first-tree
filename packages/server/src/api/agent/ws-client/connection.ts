import { PROVIDER_MODELS_RESULT_TYPE } from "@first-tree/shared";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { WebSocket } from "ws";
import { z } from "zod";
import { endWsConnectionSpan, startWsConnectionSpan, withWsMessageSpan } from "../../../observability/index.js";
import type { Notifier } from "../../../services/notifier.js";
import { handleAgentFrame } from "./agent-frames.js";
import { createClientWsAuthGate } from "./auth.js";
import { createClientFrameHandler } from "./client-frames.js";
import { createClientWsConnectionContext } from "./connection-context.js";
import { createInboxDeliveryCoordinator, type InboxDeliveryCoordinator } from "./inbox-delivery.js";
import { createSessionFrameHandler } from "./session-frames.js";

const DEFAULT_INBOX_MAX_IN_FLIGHT_PER_AGENT = 8192;
const DEFAULT_INBOX_MAX_IN_FLIGHT_PER_AGENT_CHAT = 8;

const wsMessageSchema = z.object({
  type: z.string(),
  agentId: z.string().optional(),
  ref: z.string().optional(),
});

export function attachClientWsConnection(
  app: FastifyInstance,
  socket: WebSocket,
  request: FastifyRequest,
  notifier: Notifier,
  instanceId: string,
): void {
  const jwtSecretBytes = new TextEncoder().encode(app.config.secrets.jwtSecret);
  const inboxMaxInFlightPerAgent = app.config.inbox?.maxInFlightPerAgent ?? DEFAULT_INBOX_MAX_IN_FLIGHT_PER_AGENT;
  const inboxMaxInFlightPerAgentChat =
    app.config.inbox?.maxInFlightPerAgentChat ?? DEFAULT_INBOX_MAX_IN_FLIGHT_PER_AGENT_CHAT;

  const ua = request.headers["user-agent"];
  startWsConnectionSpan(socket, {
    remoteIp: request.ip,
    userAgent: typeof ua === "string" ? ua.slice(0, 200) : undefined,
  });

  let inbox: InboxDeliveryCoordinator | undefined;
  const context = createClientWsConnectionContext(app, socket, notifier, {
    clearInboxAgent: (agentId) => inbox?.clearAgent(agentId),
    clearInboxState: () => inbox?.clearState(),
  });
  inbox = createInboxDeliveryCoordinator(app, socket, context, inboxMaxInFlightPerAgent, inboxMaxInFlightPerAgentChat);
  const auth = createClientWsAuthGate(app, socket, jwtSecretBytes, context);
  const handleClientFrame = createClientFrameHandler(app, socket, notifier, instanceId, context, inbox);
  const handleSessionFrame = createSessionFrameHandler(app, socket, notifier, instanceId, context);
  auth.start();

  // Once the socket is gone (peer close, auth close, server shutdown) no
  // inbound frame may be dispatched: the auth gate is terminal and the
  // session handlers would act on a dead connection.
  let socketClosed = false;

  socket.on("message", async (raw) => {
    if (socketClosed || socket.readyState !== socket.OPEN) return;
    let msg: unknown;
    try {
      msg = JSON.parse(String(raw));
    } catch {
      if (!context.getSession()) auth.rejectInvalidFrame("invalid JSON auth frame");
      else socket.send(JSON.stringify({ type: "error", message: "Invalid JSON" }));
      return;
    }

    const parsed = wsMessageSchema.safeParse(msg);
    if (!parsed.success) {
      if (!context.getSession()) auth.rejectInvalidFrame("invalid auth message format");
      else socket.send(JSON.stringify({ type: "error", message: "Invalid message format" }));
      return;
    }

    const { type, ref } = parsed.data;
    if (!context.getSession()) {
      await auth.handle(msg, type);
      return;
    }

    const spanAttrs: Record<string, unknown> = ref !== undefined ? { "ws.message.ref": String(ref) } : {};
    await withWsMessageSpan(socket, type, spanAttrs, async () => {
      try {
        switch (type) {
          case "client:register":
          case "heartbeat":
          case PROVIDER_MODELS_RESULT_TYPE:
            await handleClientFrame(type, msg);
            break;
          case "agent:bind":
          case "agent:unbind":
            await handleAgentFrame(app, socket, notifier, instanceId, context, inbox, type, msg, parsed.data);
            break;
          case "session:state":
          case "session:runtime":
          case "session:reconcile":
          case "runtime:state":
          case "session:event":
          case "session:command:applied":
          case "session:command:finalized:ack":
          case "session:command:aborted:ack":
            await handleSessionFrame(type, msg, parsed.data);
            break;
          case "inbox:ack":
          case "inbox:recover":
          case "inbox:fence-probe":
            await inbox.handleFrame(type, msg);
            break;
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : "Internal error";
        socket.send(JSON.stringify({ type: "error", message }));
      }
    });
  });

  socket.on("close", (closeCode?: number) => {
    socketClosed = true;
    endWsConnectionSpan(socket, closeCode);
    auth.handleClose();
    context.close();
  });
}
