import { SignJWT } from "jose";
import { describe, expect, it, vi } from "vitest";
import type WebSocket from "ws";
import { orgWsRoutes } from "../api/orgs/ws.js";
import type { Database } from "../db/connection.js";
import type { Notifier } from "../services/notifier.js";

const JWT_SECRET = "test-jwt-secret-key-for-vitest";

type RouteHandler = (socket: WebSocket, request: Record<string, unknown>) => Promise<void>;

type CapturedHandlers = {
  sessionState?: (payload: { agentId: string; chatId: string; organizationId: string }) => void;
  sessionEvent?: (payload: { agentId: string; chatId: string; organizationId: string }) => void;
  sessionRuntime?: (payload: { agentId: string; chatId: string; organizationId: string }) => void;
  chatMessage?: (payload: { chatId: string; messageId: string }) => void;
  chatUpdated?: (payload: { chatId: string }) => void;
  meChatsChanged?: (payload: { humanAgentId: string; organizationId: string }) => void;
  membershipChanged?: (payload: { memberId: string; organizationId: string }) => void;
};

function makeNotifier(handlers: CapturedHandlers): Notifier {
  return {
    onSessionStateChange: (handler: NonNullable<CapturedHandlers["sessionState"]>) => {
      handlers.sessionState = handler;
    },
    onSessionEvent: (handler: NonNullable<CapturedHandlers["sessionEvent"]>) => {
      handlers.sessionEvent = handler;
    },
    onSessionRuntime: (handler: NonNullable<CapturedHandlers["sessionRuntime"]>) => {
      handlers.sessionRuntime = handler;
    },
    onChatMessage: (handler: NonNullable<CapturedHandlers["chatMessage"]>) => {
      handlers.chatMessage = handler;
    },
    onChatUpdated: (handler: NonNullable<CapturedHandlers["chatUpdated"]>) => {
      handlers.chatUpdated = handler;
    },
    onMeChatsChanged: (handler: NonNullable<CapturedHandlers["meChatsChanged"]>) => {
      handlers.meChatsChanged = handler;
    },
    onMembershipChanged: (handler: NonNullable<CapturedHandlers["membershipChanged"]>) => {
      handlers.membershipChanged = handler;
    },
    onConfigChange: vi.fn(),
    onRuntimeStateChange: vi.fn(),
    onChatAudience: vi.fn(),
    onAgentRouteChange: vi.fn(),
    onDaemonClientCommand: vi.fn(),
    onDaemonClientCommandResult: vi.fn(),
    subscribe: vi.fn(),
    unsubscribe: vi.fn(),
    notify: vi.fn(),
    notifyStrict: vi.fn(),
    notifyConfigChange: vi.fn(),
    notifySessionStateChange: vi.fn(),
    notifySessionEvent: vi.fn(),
    notifyRuntimeStateChange: vi.fn(),
    notifySessionRuntime: vi.fn(),
    notifyChatMessage: vi.fn(),
    notifyChatAudience: vi.fn(),
    notifyChatUpdated: vi.fn(),
    notifyMeChatsChanged: vi.fn(),
    notifyMembershipChanged: vi.fn(),
    notifyAgentRouteChange: vi.fn(),
    notifyDaemonClientCommand: vi.fn(),
    notifyDaemonClientCommandResult: vi.fn(),
    pushFrameToInbox: vi.fn(),
    start: vi.fn(),
    stop: vi.fn(),
  } as unknown as Notifier;
}

function makeSelectBuilder(rows: unknown[], error?: Error) {
  const resolveRows = () => (error ? Promise.reject(error) : Promise.resolve(rows));
  return {
    from: vi.fn().mockReturnThis(),
    innerJoin: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    limit: vi.fn(resolveRows),
    // biome-ignore lint/suspicious/noThenProperty: Drizzle query builders are awaitable thenables.
    then: (resolve: (value: unknown[]) => void, reject?: (reason: unknown) => void) =>
      resolveRows().then(resolve, reject),
  };
}

function makeDeferredSelectBuilder(rows: Promise<unknown[]>) {
  return {
    from: vi.fn().mockReturnThis(),
    innerJoin: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    limit: vi.fn(() => rows),
    // biome-ignore lint/suspicious/noThenProperty: Drizzle query builders are awaitable thenables.
    then: (resolve: (value: unknown[]) => void, reject?: (reason: unknown) => void) => rows.then(resolve, reject),
  };
}

function makeDb(options: {
  memberRows?: unknown[];
  visibleRows?: unknown[];
  humanRows?: unknown[];
  audienceRows?: unknown[][];
  finalMemberRows?: unknown[];
  /** Rows for chat-status selects (speaker membership / session rows share the chatId-keyed projection). */
  statusRows?: unknown[];
  liveMembershipError?: Error;
  handshakeMembershipError?: Error;
  visibleAgentError?: Error;
  visibleRowsPromise?: Promise<unknown[]>;
  onVisibleSelect?: () => void;
}) {
  const memberRows = options.memberRows ?? [
    { id: "member-1", organizationId: "org-1", role: "admin", agentId: "human-1" },
  ];
  const visibleRows = options.visibleRows ?? [{ id: "visible-agent" }];
  const humanRows = options.humanRows ?? [{ uuid: "human-1" }];
  let authorizationSelects = 0;
  const execute = vi.fn();
  for (const rows of options.audienceRows ?? []) execute.mockResolvedValueOnce(rows);
  execute.mockResolvedValue([]);
  return {
    execute,
    select: vi.fn((projection?: Record<string, unknown>) => {
      const keys = new Set(Object.keys(projection ?? {}));
      if (keys.has("role") && options.handshakeMembershipError) {
        return makeSelectBuilder([], options.handshakeMembershipError);
      }
      if (keys.has("organizationId") && !keys.has("role") && options.liveMembershipError) {
        return makeSelectBuilder([], options.liveMembershipError);
      }
      if (keys.size === 1 && keys.has("id") && options.visibleAgentError) {
        return makeSelectBuilder([], options.visibleAgentError);
      }
      if (keys.size === 1 && keys.has("id") && options.visibleRowsPromise) {
        options.onVisibleSelect?.();
        return makeDeferredSelectBuilder(options.visibleRowsPromise);
      }
      if (keys.has("role")) {
        authorizationSelects += 1;
        return makeSelectBuilder(
          authorizationSelects > 1 && options.finalMemberRows !== undefined ? options.finalMemberRows : memberRows,
        );
      }
      if (keys.has("organizationId")) return makeSelectBuilder(memberRows);
      if (keys.has("uuid")) return makeSelectBuilder(humanRows);
      if (keys.has("chatId")) return makeSelectBuilder(options.statusRows ?? []);
      return makeSelectBuilder(visibleRows);
    }),
  } as unknown as Database;
}

function makeApp(db: Database): {
  app: { db: Database; get: ReturnType<typeof vi.fn> };
  getRoute: () => RouteHandler;
  getRouteOptions: () => unknown;
} {
  let route: RouteHandler | undefined;
  let routeOptions: unknown;
  const app = {
    db,
    get: vi.fn((_path: string, options: unknown, handler: RouteHandler) => {
      routeOptions = options;
      route = handler;
    }),
  };
  return {
    app,
    getRoute: () => {
      if (!route) throw new Error("admin ws route was not registered");
      return route;
    },
    getRouteOptions: () => routeOptions,
  };
}

function makeSocket(): {
  socket: WebSocket;
  send: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
  setReadyState: (readyState: number) => void;
  emitClose: (code: number) => void;
} {
  let readyState = 1;
  let closeHandler: ((code: number) => void) | undefined;
  const send = vi.fn();
  const close = vi.fn();
  const socket = {
    get readyState() {
      return readyState;
    },
    send,
    close,
    on: vi.fn((event: string, handler: (code: number) => void) => {
      if (event === "close") closeHandler = handler;
      return socket;
    }),
  } as unknown as WebSocket;
  return {
    socket,
    send,
    close,
    setReadyState: (next) => {
      readyState = next;
    },
    emitClose: (code) => closeHandler?.(code),
  };
}

async function signToken(payload: Record<string, unknown>): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT(payload)
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt(now)
    .setExpirationTime(now + 300)
    .sign(new TextEncoder().encode(JWT_SECRET));
}

function request(token: string | undefined, orgId = "org-1"): Record<string, unknown> {
  return {
    ip: "127.0.0.1",
    headers: { "user-agent": "vitest-admin-ws" },
    params: { orgId },
    query: token ? { token } : {},
  };
}

function sentPayloads(send: ReturnType<typeof vi.fn>): Array<{ type?: string } & Record<string, unknown>> {
  return send.mock.calls.map(([frame]) => JSON.parse(String(frame)));
}

async function waitForAsyncDispatch(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
}

describe("Admin WS route edge paths", () => {
  it("rate-limits membership authorization handshakes", async () => {
    const handlers: CapturedHandlers = {};
    const { app, getRouteOptions } = makeApp(makeDb({}));

    await orgWsRoutes(makeNotifier(handlers), JWT_SECRET)(app as never);

    const options = getRouteOptions() as {
      websocket: boolean;
      config: { rateLimit: { max: number; timeWindow: string; keyGenerator: (request: unknown) => Promise<string> } };
    };
    expect(options).toMatchObject({
      websocket: true,
      config: { rateLimit: { max: 60, timeWindow: "1 minute" } },
    });
    const firstUserKey = await options.config.rateLimit.keyGenerator(
      request(await signToken({ sub: "user-1", type: "access" })),
    );
    const secondUserKey = await options.config.rateLimit.keyGenerator(
      request(await signToken({ sub: "user-2", type: "access" })),
    );
    expect(firstUserKey).toBe("user:user-1");
    expect(secondUserKey).toBe("user:user-2");
    expect(await options.config.rateLimit.keyGenerator(request("invalid"))).toBe("ip:127.0.0.1");
  });

  it("rejects missing, malformed, wrong-type, and non-member handshakes", async () => {
    const handlers: CapturedHandlers = {};
    const db = makeDb({ memberRows: [] });
    const { app, getRoute } = makeApp(db);
    await orgWsRoutes(makeNotifier(handlers), JWT_SECRET)(app as never);
    const route = getRoute();

    const missing = makeSocket();
    await route(missing.socket, request(undefined));
    expect(sentPayloads(missing.send)[0]).toMatchObject({ type: "error", message: "Missing token or org" });
    expect(missing.close).toHaveBeenCalledWith(4001, "Missing token");

    const malformed = makeSocket();
    await route(malformed.socket, request("not-a-jwt"));
    expect(sentPayloads(malformed.send)[0]).toMatchObject({ type: "error", message: "Invalid or expired token" });
    expect(malformed.close).toHaveBeenCalledWith(4001, "Auth failed");

    const wrongType = makeSocket();
    await route(wrongType.socket, request(await signToken({ sub: "user-1", type: "refresh" })));
    expect(sentPayloads(wrongType.send)[0]).toMatchObject({ type: "error", message: "Invalid token type" });
    expect(wrongType.close).toHaveBeenCalledWith(4001, "Invalid token");

    const nonMember = makeSocket();
    await route(nonMember.socket, request(await signToken({ sub: "user-1", type: "access" })));
    expect(sentPayloads(nonMember.send)[0]).toMatchObject({
      type: "error",
      message: "Not an active member of this organization",
    });
    expect(nonMember.close).toHaveBeenCalledWith(4403, "Not a member");
  });

  it("dispatches chat and session frames only to active audience sockets", async () => {
    const handlers: CapturedHandlers = {};
    const db = makeDb({
      audienceRows: [[{ agent_id: "human-1" }], [{ agent_id: "human-1" }], []],
    });
    const { app, getRoute } = makeApp(db);
    await orgWsRoutes(makeNotifier(handlers), JWT_SECRET)(app as never);
    const route = getRoute();
    const token = await signToken({ sub: "user-1", type: "access" });
    const active = makeSocket();
    const closed = makeSocket();

    await route(active.socket, request(token));
    await route(closed.socket, request(token));
    closed.setReadyState(3);

    handlers.chatMessage?.({ chatId: "chat-message-edge", messageId: "msg-1" });
    await waitForAsyncDispatch();
    handlers.chatUpdated?.({ chatId: "chat-updated-edge" });
    await waitForAsyncDispatch();
    handlers.sessionState?.({ agentId: "agent-1", chatId: "chat-session-empty-edge", organizationId: "org-1" });
    await waitForAsyncDispatch();

    const activeTypes = sentPayloads(active.send).map((payload) => payload.type);
    const closedTypes = sentPayloads(closed.send).map((payload) => payload.type);
    expect(activeTypes).toEqual(["admin:connected", "chat:message", "chat:updated", "session:state"]);
    expect(closedTypes).toEqual(["admin:connected"]);

    active.emitClose(1000);
    handlers.chatMessage?.({ chatId: "chat-after-close-edge", messageId: "msg-2" });
    await waitForAsyncDispatch();
    expect(sentPayloads(active.send).map((payload) => payload.type)).toEqual([
      "admin:connected",
      "chat:message",
      "chat:updated",
      "session:state",
    ]);
  });

  it("swallows socket send failures while dispatching chat and session frames", async () => {
    const handlers: CapturedHandlers = {};
    const db = makeDb({
      audienceRows: [[{ agent_id: "human-1" }], [{ agent_id: "human-1" }], [{ agent_id: "human-1" }]],
    });
    const { app, getRoute } = makeApp(db);
    await orgWsRoutes(makeNotifier(handlers), JWT_SECRET)(app as never);
    const route = getRoute();
    const token = await signToken({ sub: "user-1", type: "access" });
    const active = makeSocket();

    await route(active.socket, request(token));
    active.send.mockImplementation(() => {
      throw new Error("socket send failed");
    });

    handlers.chatMessage?.({ chatId: "chat-message-send-fail", messageId: "msg-1" });
    await waitForAsyncDispatch();
    handlers.chatUpdated?.({ chatId: "chat-updated-send-fail" });
    await waitForAsyncDispatch();
    handlers.sessionRuntime?.({ agentId: "agent-1", chatId: "chat-runtime-send-fail", organizationId: "org-1" });
    await waitForAsyncDispatch();

    expect(active.send).toHaveBeenCalledTimes(4);
  });

  it("fans a me-chats:changed frame only to the acting user's own sockets in that org", async () => {
    const handlers: CapturedHandlers = {};
    // The mock db resolves every handshake to humanAgentId "human-1"; the org is
    // taken from the request path, so `own` (org-1) and `otherOrg` (org-2) share
    // a user but differ by org — enough to exercise both filter dimensions.
    const db = makeDb({});
    const { app, getRoute } = makeApp(db);
    await orgWsRoutes(makeNotifier(handlers), JWT_SECRET)(app as never);
    const route = getRoute();
    const token = await signToken({ sub: "user-1", type: "access" });

    const own = makeSocket();
    const otherOrg = makeSocket();
    await route(own.socket, request(token, "org-1"));
    await route(otherOrg.socket, request(token, "org-2"));

    // The acting user's own pin in their org → delivered to `own` only.
    handlers.meChatsChanged?.({ humanAgentId: "human-1", organizationId: "org-1" });
    await waitForAsyncDispatch();
    // A DIFFERENT user's pin in the same org → delivered to nobody. This is the
    // privacy boundary: pin state is private and must never reach another member.
    handlers.meChatsChanged?.({ humanAgentId: "human-2", organizationId: "org-1" });
    await waitForAsyncDispatch();
    // The same user, a different org → delivered to nobody here (org-scoped).
    handlers.meChatsChanged?.({ humanAgentId: "human-1", organizationId: "org-3" });
    await waitForAsyncDispatch();

    expect(sentPayloads(own.send).map((payload) => payload.type)).toEqual(["admin:connected", "me-chats:changed"]);
    // The other-org socket (same user) never sees org-1's pin.
    expect(sentPayloads(otherOrg.send).map((payload) => payload.type)).toEqual(["admin:connected"]);
  });

  it("skips session-frame status enrichment when no connected socket is in the chat audience (performance gate)", async () => {
    const handlers: CapturedHandlers = {};
    // The only admitted socket's human agent is human-1; the cached audience
    // names human-2 only, so no enriched frame could be delivered — the
    // audience query is the ONLY execute (no derive scans follow).
    const db = makeDb({ audienceRows: [[{ agent_id: "human-2" }]] });
    const { app, getRoute } = makeApp(db);
    await orgWsRoutes(makeNotifier(handlers), JWT_SECRET)(app as never);
    const route = getRoute();
    const socket = makeSocket();
    await route(socket.socket, request(await signToken({ sub: "user-1", type: "access" })));
    const dbExecuteMock = (db as unknown as { execute: ReturnType<typeof vi.fn> }).execute;
    dbExecuteMock.mockClear();

    handlers.sessionState?.({ agentId: "agent-1", chatId: "chat-gate-skip", organizationId: "org-1" });
    await waitForAsyncDispatch();

    // Bare frame still delivered to the live org socket (delivery contract).
    const frame = sentPayloads(socket.send).find((p) => p.type === "session:state");
    expect(frame).toBeDefined();
    expect(frame).not.toHaveProperty("status");
    // Audience resolution ran; the status compute (2 derive executes) did not.
    expect(dbExecuteMock).toHaveBeenCalledTimes(1);
  });

  it("skips session-frame status enrichment for an empty audience", async () => {
    const handlers: CapturedHandlers = {};
    const db = makeDb({ audienceRows: [[]] });
    const { app, getRoute } = makeApp(db);
    await orgWsRoutes(makeNotifier(handlers), JWT_SECRET)(app as never);
    const route = getRoute();
    const socket = makeSocket();
    await route(socket.socket, request(await signToken({ sub: "user-1", type: "access" })));
    const dbExecuteMock = (db as unknown as { execute: ReturnType<typeof vi.fn> }).execute;
    dbExecuteMock.mockClear();

    handlers.sessionEvent?.({ agentId: "agent-1", chatId: "chat-gate-empty", organizationId: "org-1" });
    await waitForAsyncDispatch();

    expect(dbExecuteMock).toHaveBeenCalledTimes(1);
    const frame = sentPayloads(socket.send).find((p) => p.type === "session:event");
    expect(frame).not.toHaveProperty("status");
  });

  it("enriches a session frame via single-target status resolution when an audience socket is connected", async () => {
    const handlers: CapturedHandlers = {};
    // The admitted socket (human-1) IS in the cached audience, so the gate
    // passes and the event's own agent status is resolved (audience + 2
    // derive executes) — scoped to (chat-enrich-1, agent-1).
    const db = makeDb({
      audienceRows: [[{ agent_id: "human-1" }]],
      statusRows: [
        {
          chatId: "chat-enrich-1",
          agentId: "agent-1",
          state: "active",
          runtimeState: "idle",
          runtimeStateAt: null,
        },
      ],
    });
    const { app, getRoute } = makeApp(db);
    await orgWsRoutes(makeNotifier(handlers), JWT_SECRET)(app as never);
    const route = getRoute();
    const socket = makeSocket();
    await route(socket.socket, request(await signToken({ sub: "user-1", type: "access" })));
    const dbExecuteMock = (db as unknown as { execute: ReturnType<typeof vi.fn> }).execute;
    dbExecuteMock.mockClear();

    handlers.sessionState?.({ agentId: "agent-1", chatId: "chat-enrich-1", organizationId: "org-1" });
    await waitForAsyncDispatch();

    expect(dbExecuteMock).toHaveBeenCalledTimes(3); // audience + deriveActivities + deriveStatusReasons
    const frame = sentPayloads(socket.send).find((p) => p.type === "session:state");
    expect(frame?.status).toMatchObject({ agentId: "agent-1" });
  });

  it("closes affected sockets with 1013 when live authorization cannot be revalidated", async () => {
    const handlers: CapturedHandlers = {};
    const db = makeDb({ liveMembershipError: new Error("authorization database unavailable") });
    const { app, getRoute } = makeApp(db);
    await orgWsRoutes(makeNotifier(handlers), JWT_SECRET)(app as never);
    const socket = makeSocket();
    await getRoute()(socket.socket, request(await signToken({ sub: "user-1", type: "access" })));

    handlers.meChatsChanged?.({ humanAgentId: "human-1", organizationId: "org-1" });
    await waitForAsyncDispatch();

    expect(socket.close).toHaveBeenCalledWith(1013, "Authorization unavailable");
    expect(sentPayloads(socket.send).map((payload) => payload.type)).toEqual(["admin:connected"]);
  });

  it("closes with 1013 when handshake authorization cannot reach the database", async () => {
    const handlers: CapturedHandlers = {};
    const db = makeDb({ handshakeMembershipError: new Error("handshake authorization unavailable") });
    const { app, getRoute } = makeApp(db);
    await orgWsRoutes(makeNotifier(handlers), JWT_SECRET)(app as never);
    const socket = makeSocket();

    await expect(
      getRoute()(socket.socket, request(await signToken({ sub: "user-1", type: "access" }))),
    ).resolves.toBeUndefined();

    expect(socket.close).toHaveBeenCalledWith(1013, "Authorization unavailable");
    expect(sentPayloads(socket.send).map((payload) => payload.type)).not.toContain("admin:connected");
    expect(sentPayloads(socket.send).map((payload) => payload.type)).not.toContain("membership:changed");
  });

  it("closes with 1013 when handshake preparation cannot reach the database", async () => {
    const handlers: CapturedHandlers = {};
    const db = makeDb({ visibleAgentError: new Error("handshake preparation unavailable") });
    const { app, getRoute } = makeApp(db);
    await orgWsRoutes(makeNotifier(handlers), JWT_SECRET)(app as never);
    const socket = makeSocket();

    await expect(
      getRoute()(socket.socket, request(await signToken({ sub: "user-1", type: "access" }))),
    ).resolves.toBeUndefined();

    expect(socket.close).toHaveBeenCalledWith(1013, "Authorization unavailable");
    expect(sentPayloads(socket.send).map((payload) => payload.type)).not.toContain("admin:connected");
    expect(sentPayloads(socket.send).map((payload) => payload.type)).not.toContain("membership:changed");
  });

  it("does not admit a membership removed while handshake preparation is in flight", async () => {
    let releaseVisibility: (rows: unknown[]) => void = () => undefined;
    const visibleRowsPromise = new Promise<unknown[]>((resolve) => {
      releaseVisibility = resolve;
    });
    let announceVisibility: () => void = () => undefined;
    const visibilityStarted = new Promise<void>((resolve) => {
      announceVisibility = resolve;
    });
    const handlers: CapturedHandlers = {};
    const db = makeDb({ visibleRowsPromise, onVisibleSelect: announceVisibility });
    const { app, getRoute } = makeApp(db);
    await orgWsRoutes(makeNotifier(handlers), JWT_SECRET)(app as never);
    const socket = makeSocket();

    const handshake = getRoute()(socket.socket, request(await signToken({ sub: "user-1", type: "access" })));
    await visibilityStarted;
    handlers.membershipChanged?.({ memberId: "member-1", organizationId: "org-1" });
    releaseVisibility([{ id: "visible-agent" }]);
    await handshake;

    expect(socket.close).toHaveBeenCalledWith(4403, "Membership changed");
    expect(sentPayloads(socket.send).map((payload) => payload.type)).not.toContain("admin:connected");
  });

  it("rejects final handshake admission from the database when the membership notifier was missed", async () => {
    let releaseVisibility: (rows: unknown[]) => void = () => undefined;
    const visibleRowsPromise = new Promise<unknown[]>((resolve) => {
      releaseVisibility = resolve;
    });
    let announceVisibility: () => void = () => undefined;
    const visibilityStarted = new Promise<void>((resolve) => {
      announceVisibility = resolve;
    });
    const handlers: CapturedHandlers = {};
    const db = makeDb({
      visibleRowsPromise,
      onVisibleSelect: announceVisibility,
      // Initial authorization sees the active row; the final authoritative
      // read observes the committed removal. No notifier is delivered.
      finalMemberRows: [],
    });
    const { app, getRoute } = makeApp(db);
    await orgWsRoutes(makeNotifier(handlers), JWT_SECRET)(app as never);
    const socket = makeSocket();

    const handshake = getRoute()(socket.socket, request(await signToken({ sub: "user-1", type: "access" })));
    await visibilityStarted;
    releaseVisibility([{ id: "visible-agent" }]);
    await handshake;
    handlers.meChatsChanged?.({ humanAgentId: "human-1", organizationId: "org-1" });
    await waitForAsyncDispatch();

    expect(socket.close).toHaveBeenCalledWith(4403, "Membership changed");
    const frameTypes = sentPayloads(socket.send).map((payload) => payload.type);
    expect(frameTypes).not.toContain("admin:connected");
    expect(frameTypes).not.toContain("me-chats:changed");
  });
});
