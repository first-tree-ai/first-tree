// @vitest-environment happy-dom

import type { AgentChatStatus } from "@first-tree/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const clientMocks = vi.hoisted(() => ({
  getStoredTokens: vi.fn(),
  refreshAccessToken: vi.fn(),
  getApiSelectedOrganizationId: vi.fn(),
  ADMIN_WS_ORG_CHANGED_EVENT: "admin-ws:org-changed",
  ADMIN_WS_MEMBERSHIP_CHANGED_EVENT: "admin-ws:membership-changed",
}));

vi.mock("../../api/client.js", () => clientMocks);

type WsHandler = ((event: MessageEvent<string>) => void) | null;
type CloseHandler = ((event: CloseEvent) => void) | null;

class FakeWebSocket {
  static instances: FakeWebSocket[] = [];
  static emitCloseEvent = true;
  onmessage: WsHandler = null;
  onopen: (() => void) | null = null;
  onclose: CloseHandler = null;
  closed = false;
  closeCode: number | null = null;
  closeCodes: number[] = [];
  readonly url: string;

  constructor(url: string) {
    this.url = url;
    FakeWebSocket.instances.push(this);
  }

  close(code = 1000): void {
    if (code !== 1000 && (code < 3000 || code > 4999)) {
      throw new DOMException("Invalid WebSocket close code", "InvalidAccessError");
    }
    this.closed = true;
    this.closeCode = code;
    this.closeCodes.push(code);
    if (FakeWebSocket.emitCloseEvent) this.onclose?.(new CloseEvent("close", { code }));
  }

  emit(data: unknown): void {
    this.onmessage?.(new MessageEvent("message", { data: JSON.stringify(data) }));
  }

  open(): void {
    this.onopen?.();
  }

  closeWith(code: number): void {
    this.onclose?.(new CloseEvent("close", { code }));
  }
}

let root: Root | null = null;
let container: HTMLElement | null = null;
let queryClient: QueryClient;

function createStorage(): Storage {
  const data = new Map<string, string>();
  return {
    get length() {
      return data.size;
    },
    clear: () => data.clear(),
    getItem: (key: string) => data.get(key) ?? null,
    key: (index: number) => [...data.keys()][index] ?? null,
    removeItem: (key: string) => {
      data.delete(key);
    },
    setItem: (key: string, value: string) => {
      data.set(key, value);
    },
  };
}

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

async function renderHook(enabled = true, onMessage = vi.fn()): Promise<typeof onMessage> {
  const { useAdminWs } = await import("../use-admin-ws.js");
  function Probe() {
    useAdminWs({ enabled, onMessage });
    return <div>mounted</div>;
  }
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  await act(async () => {
    root?.render(
      <QueryClientProvider client={queryClient}>
        <Probe />
      </QueryClientProvider>,
    );
  });
  await flush();
  return onMessage;
}

function makeStatus(overrides: Partial<AgentChatStatus> = {}): AgentChatStatus {
  return {
    agentId: overrides.agentId ?? "agent-1",
    main: overrides.main ?? "working",
    reachable: overrides.reachable ?? true,
    engagement: overrides.engagement ?? "active",
    working: overrides.working ?? true,
    errored: overrides.errored ?? false,
    activity: overrides.activity ?? null,
  };
}

beforeEach(() => {
  vi.resetModules();
  FakeWebSocket.instances = [];
  FakeWebSocket.emitCloseEvent = true;
  Object.defineProperty(globalThis, "WebSocket", { configurable: true, value: FakeWebSocket });
  Object.defineProperty(window, "WebSocket", { configurable: true, value: FakeWebSocket });
  Object.defineProperty(window, "location", {
    configurable: true,
    value: { protocol: "https:", host: "first-tree.test" },
  });
  const storage = createStorage();
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: storage });
  Object.defineProperty(window, "localStorage", { configurable: true, value: storage });
  clientMocks.getApiSelectedOrganizationId.mockReturnValue("org-1");
  clientMocks.getStoredTokens.mockReturnValue({ accessToken: "access-1", refreshToken: "refresh-1" });
  clientMocks.refreshAccessToken.mockResolvedValue({ accessToken: "access-2", refreshToken: "refresh-2" });
  root = null;
  container = null;
});

afterEach(async () => {
  vi.useRealTimers();
  if (root) await act(async () => root?.unmount());
  document.body.innerHTML = "";
});

describe("useAdminWs", () => {
  it("connects once, broadcasts messages, patches status, and invalidates affected queries", async () => {
    const invalidateSpy = vi.spyOn(QueryClient.prototype, "invalidateQueries");
    queryClient = new QueryClient();
    const onMessage = await renderHook();
    const socket = FakeWebSocket.instances[0];
    if (!socket) throw new Error("socket missing");

    expect(socket.url).toBe("wss://first-tree.test/api/v1/orgs/org-1/ws/?token=access-1");
    queryClient.setQueryData(
      ["chat-agent-status", "chat-1"],
      [makeStatus({ agentId: "agent-1", main: "ready", working: false })],
    );

    await act(async () => {
      socket.emit({ type: "session:state", agentId: "agent-1", chatId: "chat-1", status: makeStatus() });
    });

    expect(onMessage).toHaveBeenCalledWith(expect.objectContaining({ type: "session:state" }));
    expect(queryClient.getQueryData<AgentChatStatus[]>(["chat-agent-status", "chat-1"])?.[0]?.main).toBe("working");
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ["activity"] });
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ["sessions"] });

    await act(async () => {
      socket.emit({ type: "session:event", agentId: "agent-1", chatId: "chat-1", status: makeStatus() });
      socket.emit({ type: "chat:message", chatId: "chat-1" });
      socket.emit({ type: "pulse:tick" });
      socket.emit("not json");
    });

    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ["session-events", "agent-1", "chat-1"] });
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ["chat-session-events", "chat-1"] });
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ["chat-messages", "chat-1"] });
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ["chat-detail", "chat-1"] });
    // A new message may be an accepted cron trigger — the schedule list rides
    // the same chat-scoped invalidation.
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ["chat-right-sidebar", "cron-jobs", "chat-1"] });
  });

  it("invalidates the chat's event cache when a session:state frame reports evicted", async () => {
    // Reset finalize deletes session_events server-side; every other open
    // viewer only learns about it through this frame — `chat-session-events`
    // has no polling floor, so the evicted state must actively clear the
    // cached trace.
    const invalidateSpy = vi.spyOn(QueryClient.prototype, "invalidateQueries");
    queryClient = new QueryClient();
    await renderHook();
    const socket = FakeWebSocket.instances[0];
    if (!socket) throw new Error("socket missing");
    invalidateSpy.mockClear();

    await act(async () => {
      socket.emit({ type: "session:state", agentId: "agent-1", chatId: "chat-1", state: "suspended" });
    });
    expect(invalidateSpy).not.toHaveBeenCalledWith({ queryKey: ["chat-session-events", "chat-1"] });

    await act(async () => {
      socket.emit({ type: "session:state", agentId: "agent-1", chatId: "chat-1", state: "evicted" });
    });
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ["chat-session-events", "chat-1"] });
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ["session-events", "agent-1", "chat-1"] });
  });

  it("invalidates the chat's cron-jobs query on chat:updated and on reconnect catch-up", async () => {
    const invalidateSpy = vi.spyOn(QueryClient.prototype, "invalidateQueries");
    await renderHook();
    const socket = FakeWebSocket.instances[0];
    if (!socket) throw new Error("socket missing");

    await act(async () => {
      socket.emit({ type: "chat:updated", chatId: "chat-9" });
    });
    // Cron CRUD reuses the chat:updated notifier, so the sidebar schedule
    // list follows it — scoped to exactly the updated chat.
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ["chat-right-sidebar", "cron-jobs", "chat-9"] });
    expect(invalidateSpy).not.toHaveBeenCalledWith({ queryKey: ["chat-right-sidebar", "cron-jobs", "chat-1"] });

    // Reconnect catch-up prefix-invalidates every cached schedule list after
    // the replacement socket receives protocol admission, so a frame missed
    // during a WS gap self-heals without trusting transport open.
    invalidateSpy.mockClear();
    vi.useFakeTimers();
    await act(async () => {
      socket.closeWith(1013);
      vi.advanceTimersByTime(2_000);
    });
    const replacement = FakeWebSocket.instances[1];
    if (!replacement) throw new Error("replacement socket missing");
    await act(async () => {
      replacement.open();
    });
    expect(invalidateSpy).not.toHaveBeenCalledWith({ queryKey: ["chat-right-sidebar", "cron-jobs"] });
    await act(async () => {
      replacement.emit({ type: "admin:connected" });
    });
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ["chat-right-sidebar", "cron-jobs"] });
  });

  it("refreshes both private chat projections when me-chats changes on another client", async () => {
    const invalidateSpy = vi.spyOn(QueryClient.prototype, "invalidateQueries");
    await renderHook();
    const socket = FakeWebSocket.instances[0];
    if (!socket) throw new Error("socket missing");
    invalidateSpy.mockClear();

    await act(async () => {
      socket.emit({ type: "me-chats:changed" });
    });

    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ["me", "chats"] });
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ["need-you"] });
  });

  it("signals membership reconciliation and never reconnects the revoked Team socket", async () => {
    const membershipChanged = vi.fn();
    window.addEventListener("admin-ws:membership-changed", membershipChanged);
    await renderHook();
    const socket = FakeWebSocket.instances[0];
    if (!socket) throw new Error("socket missing");
    vi.useFakeTimers();

    await act(async () => {
      socket.emit({ type: "membership:changed", memberId: "member-1", organizationId: "org-1" });
      socket.closeWith(4403);
      vi.advanceTimersByTime(30_000);
    });

    expect(membershipChanged).toHaveBeenCalledTimes(1);
    expect(FakeWebSocket.instances).toHaveLength(1);
    window.removeEventListener("admin-ws:membership-changed", membershipChanged);
  });

  it("backs off pre-admission authorization outages and catches up only after protocol admission", async () => {
    const invalidateSpy = vi.spyOn(QueryClient.prototype, "invalidateQueries");
    const membershipChanged = vi.fn();
    window.addEventListener("admin-ws:membership-changed", membershipChanged);
    const onMessage = await renderHook();
    const first = FakeWebSocket.instances[0];
    if (!first) throw new Error("socket missing");
    vi.useFakeTimers();
    invalidateSpy.mockClear();

    await act(async () => {
      first.open();
    });
    expect(onMessage).not.toHaveBeenCalledWith({ type: "ws:reconnect" });
    expect(invalidateSpy).not.toHaveBeenCalledWith({ queryKey: ["activity"] });

    await act(async () => {
      first.closeWith(1013);
      vi.advanceTimersByTime(1_999);
    });
    expect(FakeWebSocket.instances).toHaveLength(1);

    await act(async () => {
      vi.advanceTimersByTime(1);
    });
    const second = FakeWebSocket.instances[1];
    if (!second) throw new Error("second socket missing");

    await act(async () => {
      second.open();
      second.closeWith(1013);
      vi.advanceTimersByTime(3_999);
    });
    expect(FakeWebSocket.instances).toHaveLength(2);
    expect(onMessage).not.toHaveBeenCalledWith({ type: "ws:reconnect" });
    expect(invalidateSpy).not.toHaveBeenCalledWith({ queryKey: ["activity"] });

    await act(async () => {
      vi.advanceTimersByTime(1);
    });
    const third = FakeWebSocket.instances[2];
    if (!third) throw new Error("third socket missing");

    await act(async () => {
      third.open();
    });
    expect(onMessage).not.toHaveBeenCalledWith({ type: "ws:reconnect" });
    expect(invalidateSpy).not.toHaveBeenCalledWith({ queryKey: ["activity"] });

    await act(async () => {
      third.emit({ type: "admin:connected" });
    });
    expect(membershipChanged).not.toHaveBeenCalled();
    expect(onMessage).toHaveBeenCalledWith({ type: "ws:reconnect" });
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ["activity"] });

    await act(async () => {
      third.closeWith(1013);
      vi.advanceTimersByTime(1_999);
    });
    expect(FakeWebSocket.instances).toHaveLength(3);
    await act(async () => {
      vi.advanceTimersByTime(1);
    });
    expect(FakeWebSocket.instances).toHaveLength(4);
    window.removeEventListener("admin-ws:membership-changed", membershipChanged);
  });

  it("retries when transport opens without protocol admission", async () => {
    const invalidateSpy = vi.spyOn(QueryClient.prototype, "invalidateQueries");
    const onMessage = await renderHook();
    const first = FakeWebSocket.instances[0];
    if (!first) throw new Error("socket missing");
    vi.useFakeTimers();
    invalidateSpy.mockClear();

    await act(async () => {
      first.open();
      vi.advanceTimersByTime(9_999);
    });
    expect(first.closed).toBe(false);
    expect(FakeWebSocket.instances).toHaveLength(1);
    expect(onMessage).not.toHaveBeenCalledWith({ type: "ws:reconnect" });
    expect(invalidateSpy).not.toHaveBeenCalledWith({ queryKey: ["activity"] });

    await act(async () => {
      vi.advanceTimersByTime(1);
    });
    expect(first.closed).toBe(true);
    expect(first.closeCode).toBe(4013);
    expect(FakeWebSocket.instances).toHaveLength(1);

    await act(async () => {
      vi.advanceTimersByTime(1_999);
    });
    expect(FakeWebSocket.instances).toHaveLength(1);
    await act(async () => {
      vi.advanceTimersByTime(1);
    });
    const replacement = FakeWebSocket.instances[1];
    if (!replacement) throw new Error("replacement socket missing");
    expect(onMessage).not.toHaveBeenCalledWith({ type: "ws:reconnect" });
    expect(invalidateSpy).not.toHaveBeenCalledWith({ queryKey: ["activity"] });

    await act(async () => {
      replacement.open();
      replacement.emit({ type: "admin:connected" });
    });
    expect(onMessage.mock.calls.filter(([message]) => message.type === "ws:reconnect")).toHaveLength(1);
    expect(invalidateSpy.mock.calls.filter(([options]) => options?.queryKey?.[0] === "activity")).toHaveLength(1);

    await act(async () => {
      vi.advanceTimersByTime(12_000);
    });
    expect(replacement.closed).toBe(false);
    expect(FakeWebSocket.instances).toHaveLength(2);
    expect(onMessage.mock.calls.filter(([message]) => message.type === "ws:reconnect")).toHaveLength(1);
    expect(invalidateSpy.mock.calls.filter(([options]) => options?.queryKey?.[0] === "activity")).toHaveLength(1);
  });

  it("refreshes access tokens on auth close and reconnects immediately", async () => {
    const onMessage = await renderHook();
    const first = FakeWebSocket.instances[0];
    if (!first) throw new Error("socket missing");

    await act(async () => {
      first.closeWith(4001);
    });
    await flush();

    expect(clientMocks.refreshAccessToken).toHaveBeenCalled();
    const second = FakeWebSocket.instances[1];
    expect(second).toBeTruthy();

    await act(async () => {
      second?.open();
      second?.emit({ type: "admin:connected" });
    });
    expect(onMessage).not.toHaveBeenCalledWith({ type: "ws:reconnect" });
  });

  it("preserves reconnect catch-up through a successful auth refresh until protocol admission", async () => {
    const invalidateSpy = vi.spyOn(QueryClient.prototype, "invalidateQueries");
    const onMessage = await renderHook();
    const first = FakeWebSocket.instances[0];
    if (!first) throw new Error("socket missing");
    vi.useFakeTimers();

    await act(async () => {
      first.open();
      first.emit({ type: "admin:connected" });
    });
    onMessage.mockClear();
    invalidateSpy.mockClear();
    clientMocks.refreshAccessToken.mockClear();

    await act(async () => {
      first.closeWith(1006);
      vi.advanceTimersByTime(2_000);
    });
    const second = FakeWebSocket.instances[1];
    if (!second) throw new Error("replacement socket missing");

    await act(async () => {
      second.open();
      second.closeWith(4001);
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(clientMocks.refreshAccessToken).toHaveBeenCalledTimes(1);
    const third = FakeWebSocket.instances[2];
    if (!third) throw new Error("refreshed socket missing");
    expect(onMessage).not.toHaveBeenCalledWith({ type: "ws:reconnect" });
    expect(invalidateSpy).not.toHaveBeenCalledWith({ queryKey: ["activity"] });

    await act(async () => {
      third.open();
    });
    expect(onMessage).not.toHaveBeenCalledWith({ type: "ws:reconnect" });
    expect(invalidateSpy).not.toHaveBeenCalledWith({ queryKey: ["activity"] });

    await act(async () => {
      third.emit({ type: "admin:connected" });
    });
    expect(onMessage.mock.calls.filter(([message]) => message.type === "ws:reconnect")).toHaveLength(1);
    expect(invalidateSpy.mock.calls.filter(([options]) => options?.queryKey?.[0] === "activity")).toHaveLength(1);
  });

  it("skips disabled hooks and tears down the shared socket when the last subscriber unmounts", async () => {
    await renderHook(false);
    expect(FakeWebSocket.instances).toHaveLength(0);

    await renderHook(true);
    const socket = FakeWebSocket.instances[0];
    if (!socket) throw new Error("socket missing");
    await act(async () => root?.unmount());
    expect(socket.closed).toBe(true);
  });

  it("clears the admission deadline synchronously when the last subscriber unmounts", async () => {
    await renderHook();
    const socket = FakeWebSocket.instances[0];
    if (!socket) throw new Error("socket missing");
    vi.useFakeTimers();
    FakeWebSocket.emitCloseEvent = false;

    await act(async () => {
      socket.open();
    });
    expect(vi.getTimerCount()).toBe(1);

    await act(async () => root?.unmount());
    expect(socket.closeCodes).toEqual([1000]);
    expect(vi.getTimerCount()).toBe(0);

    await act(async () => {
      vi.advanceTimersByTime(12_000);
    });
    expect(socket.closeCodes).toEqual([1000]);
    expect(FakeWebSocket.instances).toHaveLength(1);
  });

  it("reconnects to the new org's socket when the selected org changes", async () => {
    await renderHook();
    const first = FakeWebSocket.instances[0];
    if (!first) throw new Error("socket missing");
    expect(first.url).toBe("wss://first-tree.test/api/v1/orgs/org-1/ws/?token=access-1");

    // selectOrganization flips the API client's selected-org value and fires the
    // org-changed event; the shared socket must drop org-1 and reopen on org-2.
    clientMocks.getApiSelectedOrganizationId.mockReturnValue("org-2");
    await act(async () => {
      window.dispatchEvent(new CustomEvent("admin-ws:org-changed"));
    });
    await flush();

    expect(first.closed).toBe(true);
    const second = FakeWebSocket.instances[1];
    expect(second?.url).toBe("wss://first-tree.test/api/v1/orgs/org-2/ws/?token=access-1");
  });

  it("clears the admission deadline synchronously when the selected org changes", async () => {
    await renderHook();
    const first = FakeWebSocket.instances[0];
    if (!first) throw new Error("socket missing");
    vi.useFakeTimers();
    FakeWebSocket.emitCloseEvent = false;

    await act(async () => {
      first.open();
    });
    expect(vi.getTimerCount()).toBe(1);

    clientMocks.getApiSelectedOrganizationId.mockReturnValue("org-2");
    await act(async () => {
      window.dispatchEvent(new CustomEvent("admin-ws:org-changed"));
    });
    expect(first.closeCodes).toEqual([1000]);
    expect(FakeWebSocket.instances).toHaveLength(2);
    expect(vi.getTimerCount()).toBe(0);

    await act(async () => {
      vi.advanceTimersByTime(12_000);
    });
    expect(first.closeCodes).toEqual([1000]);
    expect(FakeWebSocket.instances).toHaveLength(2);
  });

  it("ignores the org-changed event after the workspace socket has torn down", async () => {
    await renderHook();
    expect(FakeWebSocket.instances).toHaveLength(1);
    await act(async () => root?.unmount());

    clientMocks.getApiSelectedOrganizationId.mockReturnValue("org-2");
    await act(async () => {
      window.dispatchEvent(new CustomEvent("admin-ws:org-changed"));
    });
    await flush();

    // No live consumer → no reconnect; the listener was removed on teardown.
    expect(FakeWebSocket.instances).toHaveLength(1);
  });
});

describe("useAdminWs session:event timeline throttling", () => {
  function countInvalidations(
    spy: { mock: { calls: Array<readonly unknown[]> } },
    queryKey: readonly string[],
  ): number {
    return spy.mock.calls.filter(([options]) => {
      const filters = options as { queryKey?: readonly unknown[] } | undefined;
      return JSON.stringify(filters?.queryKey) === JSON.stringify(queryKey);
    }).length;
  }

  const eventPairKey = ["session-events", "agent-1", "chat-1"];
  const eventChatKey = ["chat-session-events", "chat-1"];

  function emitEvent(socket: FakeWebSocket, agentId: string, chatId: string, main: "working" | "ready" = "working") {
    socket.emit({ type: "session:event", agentId, chatId, status: makeStatus({ agentId, main }) });
  }

  it("folds a session:event burst on one chat into one leading + one trailing refresh, patching status every frame", async () => {
    const invalidateSpy = vi.spyOn(QueryClient.prototype, "invalidateQueries");
    await renderHook();
    const socket = FakeWebSocket.instances[0];
    if (!socket) throw new Error("socket missing");
    vi.useFakeTimers();
    invalidateSpy.mockClear();

    queryClient.setQueryData(
      ["chat-agent-status", "chat-1"],
      [makeStatus({ agentId: "agent-1", main: "ready", working: false })],
    );

    // 10 frames of one tool-call burst, all inside the same throttle window.
    await act(async () => {
      for (let i = 0; i < 10; i++) {
        emitEvent(socket, "agent-1", "chat-1", i % 2 === 0 ? "ready" : "working");
      }
    });

    // Leading edge fired exactly once per key for the whole burst (10 frames
    // → 1 refetch per key instead of 10).
    expect(countInvalidations(invalidateSpy, eventPairKey)).toBe(1);
    expect(countInvalidations(invalidateSpy, eventChatKey)).toBe(1);
    // The per-frame status patch is immediate even while invalidations are
    // folded — the last frame's status must already be cached.
    const cached = queryClient.getQueryData<AgentChatStatus[]>(["chat-agent-status", "chat-1"]);
    expect(cached?.[0]?.main).toBe("working");

    // Nothing refetches mid-window…
    await act(async () => {
      vi.advanceTimersByTime(500);
    });
    expect(countInvalidations(invalidateSpy, eventPairKey)).toBe(1);
    expect(countInvalidations(invalidateSpy, eventChatKey)).toBe(1);

    // …then the burst collapses into exactly one trailing refresh.
    await act(async () => {
      vi.advanceTimersByTime(500);
    });
    expect(countInvalidations(invalidateSpy, eventPairKey)).toBe(2);
    expect(countInvalidations(invalidateSpy, eventChatKey)).toBe(2);

    // And nothing more fires afterwards.
    await act(async () => {
      vi.advanceTimersByTime(60_000);
    });
    expect(countInvalidations(invalidateSpy, eventPairKey)).toBe(2);
    expect(countInvalidations(invalidateSpy, eventChatKey)).toBe(2);
  });

  it("keeps per-chat and per-(agent, chat) windows independent", async () => {
    const invalidateSpy = vi.spyOn(QueryClient.prototype, "invalidateQueries");
    await renderHook();
    const socket = FakeWebSocket.instances[0];
    if (!socket) throw new Error("socket missing");
    vi.useFakeTimers();
    invalidateSpy.mockClear();

    // A burst on chat-1 opens chat-1's window…
    await act(async () => {
      for (let i = 0; i < 5; i++) {
        emitEvent(socket, "agent-1", "chat-1");
      }
    });
    expect(countInvalidations(invalidateSpy, eventPairKey)).toBe(1);
    expect(countInvalidations(invalidateSpy, eventChatKey)).toBe(1);

    // …but a frame for another chat still refreshes that chat immediately,
    // and a second agent streaming into chat-1 still gets its own pair
    // refresh instead of being starved by agent-1's window.
    await act(async () => {
      emitEvent(socket, "agent-2", "chat-2");
      emitEvent(socket, "agent-3", "chat-1");
    });
    expect(countInvalidations(invalidateSpy, ["session-events", "agent-2", "chat-2"])).toBe(1);
    expect(countInvalidations(invalidateSpy, ["chat-session-events", "chat-2"])).toBe(1);
    expect(countInvalidations(invalidateSpy, ["session-events", "agent-3", "chat-1"])).toBe(1);
    expect(countInvalidations(invalidateSpy, eventChatKey)).toBe(1);

    // Each window that saw a burst trails exactly once; single-frame bursts
    // need no trailing refresh.
    await act(async () => {
      vi.advanceTimersByTime(2_000);
    });
    expect(countInvalidations(invalidateSpy, eventPairKey)).toBe(2);
    expect(countInvalidations(invalidateSpy, eventChatKey)).toBe(2);
    expect(countInvalidations(invalidateSpy, ["session-events", "agent-2", "chat-2"])).toBe(1);
    expect(countInvalidations(invalidateSpy, ["chat-session-events", "chat-2"])).toBe(1);
    expect(countInvalidations(invalidateSpy, ["session-events", "agent-3", "chat-1"])).toBe(1);

    await act(async () => {
      vi.advanceTimersByTime(10_000);
    });
    expect(countInvalidations(invalidateSpy, eventChatKey)).toBe(2);
  });

  it("guarantees a trailing refresh after a long burst and refreshes the next burst immediately", async () => {
    const invalidateSpy = vi.spyOn(QueryClient.prototype, "invalidateQueries");
    await renderHook();
    const socket = FakeWebSocket.instances[0];
    if (!socket) throw new Error("socket missing");
    vi.useFakeTimers();
    invalidateSpy.mockClear();

    // A 20-frame burst at ~10 fps spans two cooldown windows (t=0…1900ms).
    // The fires land at t=0 (leading), t=1000 (trailing) and t=2000 (trailing)
    // — the frame at t=1000 must fold into the next trailing refresh instead
    // of re-firing a leading one at the boundary.
    await act(async () => {
      for (let i = 0; i < 20; i++) {
        emitEvent(socket, "agent-1", "chat-1");
        if (i < 19) vi.advanceTimersByTime(100);
      }
    });
    // Loop ended at t=1900 with t=0 + t=1000 fired; the burst's last refresh
    // (t=2000) is still pending.
    expect(countInvalidations(invalidateSpy, eventPairKey)).toBe(2);
    expect(countInvalidations(invalidateSpy, eventChatKey)).toBe(2);

    // The burst ended at t=1900; the guaranteed last refresh fires after it.
    await act(async () => {
      vi.advanceTimersByTime(100);
    });
    expect(countInvalidations(invalidateSpy, eventPairKey)).toBe(3);
    expect(countInvalidations(invalidateSpy, eventChatKey)).toBe(3);
    await act(async () => {
      vi.advanceTimersByTime(60_000);
    });
    expect(countInvalidations(invalidateSpy, eventPairKey)).toBe(3);

    // A later isolated frame is a fresh burst: it refetches immediately
    // (the idle sweep dropped the entry once the cooldown elapsed).
    await act(async () => {
      emitEvent(socket, "agent-1", "chat-1");
    });
    expect(countInvalidations(invalidateSpy, eventPairKey)).toBe(4);
    expect(countInvalidations(invalidateSpy, eventChatKey)).toBe(4);
    await act(async () => {
      vi.advanceTimersByTime(60_000);
    });
    expect(countInvalidations(invalidateSpy, eventPairKey)).toBe(4);
  });

  it("does not re-fire a leading invalidation when a frame lands on a fire boundary", async () => {
    const invalidateSpy = vi.spyOn(QueryClient.prototype, "invalidateQueries");
    await renderHook();
    const socket = FakeWebSocket.instances[0];
    if (!socket) throw new Error("socket missing");
    vi.useFakeTimers();
    invalidateSpy.mockClear();

    await act(async () => {
      for (let i = 0; i < 10; i++) {
        emitEvent(socket, "agent-1", "chat-1");
        if (i < 9) vi.advanceTimersByTime(100);
      }
    });
    // Frames t=0…900: leading fired at t=0; the trailing (due t=1000) is
    // still pending.
    expect(countInvalidations(invalidateSpy, eventPairKey)).toBe(1);

    // Advance onto the boundary: the trailing fires at t=1000…
    await act(async () => {
      vi.advanceTimersByTime(100);
    });
    expect(countInvalidations(invalidateSpy, eventPairKey)).toBe(2);

    // …and a frame landing at exactly that moment must fold into the next
    // trailing refresh (t=2000), not re-fire a leading one at t=1000.
    await act(async () => {
      emitEvent(socket, "agent-1", "chat-1");
    });
    expect(countInvalidations(invalidateSpy, eventPairKey)).toBe(2);
    await act(async () => {
      vi.advanceTimersByTime(2_000);
    });
    expect(countInvalidations(invalidateSpy, eventPairKey)).toBe(3);
    await act(async () => {
      vi.advanceTimersByTime(60_000);
    });
    expect(countInvalidations(invalidateSpy, eventPairKey)).toBe(3);
  });

  it("drops pending session:event throttle timers when the workspace unmounts", async () => {
    const invalidateSpy = vi.spyOn(QueryClient.prototype, "invalidateQueries");
    await renderHook();
    const socket = FakeWebSocket.instances[0];
    if (!socket) throw new Error("socket missing");
    vi.useFakeTimers();
    invalidateSpy.mockClear();

    await act(async () => {
      for (let i = 0; i < 3; i++) {
        emitEvent(socket, "agent-1", "chat-1");
      }
    });
    expect(countInvalidations(invalidateSpy, eventPairKey)).toBe(1);
    expect(countInvalidations(invalidateSpy, eventChatKey)).toBe(1);

    // Release (last subscriber unmounts): the pending trailing timers must
    // not survive to fire against a later scope.
    await act(async () => root?.unmount());
    await act(async () => {
      vi.advanceTimersByTime(60_000);
    });
    expect(countInvalidations(invalidateSpy, eventPairKey)).toBe(1);
    expect(countInvalidations(invalidateSpy, eventChatKey)).toBe(1);
  });

  it("resets session:event throttle state on org switch so old-scope timers cannot fire", async () => {
    const invalidateSpy = vi.spyOn(QueryClient.prototype, "invalidateQueries");
    await renderHook();
    const first = FakeWebSocket.instances[0];
    if (!first) throw new Error("socket missing");
    vi.useFakeTimers();
    invalidateSpy.mockClear();

    await act(async () => {
      for (let i = 0; i < 3; i++) {
        emitEvent(first, "agent-1", "chat-1");
      }
    });
    expect(countInvalidations(invalidateSpy, eventPairKey)).toBe(1);
    expect(countInvalidations(invalidateSpy, eventChatKey)).toBe(1);

    // Org switch drops the old socket's pending throttle timers.
    clientMocks.getApiSelectedOrganizationId.mockReturnValue("org-2");
    await act(async () => {
      window.dispatchEvent(new CustomEvent("admin-ws:org-changed"));
    });
    const second = FakeWebSocket.instances[1];
    if (!second) throw new Error("replacement socket missing");
    await act(async () => {
      vi.advanceTimersByTime(60_000);
    });
    expect(countInvalidations(invalidateSpy, eventPairKey)).toBe(1);
    expect(countInvalidations(invalidateSpy, eventChatKey)).toBe(1);

    // The new org starts with a clean throttle: the same chat id refreshes
    // immediately instead of inheriting the old scope's open window.
    await act(async () => {
      emitEvent(second, "agent-1", "chat-1");
    });
    expect(countInvalidations(invalidateSpy, eventPairKey)).toBe(2);
    expect(countInvalidations(invalidateSpy, eventChatKey)).toBe(2);
  });

  it("keeps session:state eviction invalidations immediate during an event burst", async () => {
    const invalidateSpy = vi.spyOn(QueryClient.prototype, "invalidateQueries");
    await renderHook();
    const socket = FakeWebSocket.instances[0];
    if (!socket) throw new Error("socket missing");
    vi.useFakeTimers();
    invalidateSpy.mockClear();

    await act(async () => {
      for (let i = 0; i < 5; i++) {
        emitEvent(socket, "agent-1", "chat-1");
      }
      // Terminal eviction lands mid-burst: its timeline invalidations are
      // NOT folded into the session:event throttle — every viewer must learn
      // about the server-side trace deletion immediately.
      socket.emit({ type: "session:state", agentId: "agent-1", chatId: "chat-1", state: "evicted" });
    });
    expect(countInvalidations(invalidateSpy, eventPairKey)).toBe(2);
    expect(countInvalidations(invalidateSpy, eventChatKey)).toBe(2);

    // The pre-eviction burst's pending trailing still settles exactly once…
    await act(async () => {
      vi.advanceTimersByTime(2_000);
    });
    expect(countInvalidations(invalidateSpy, eventPairKey)).toBe(3);
    expect(countInvalidations(invalidateSpy, eventChatKey)).toBe(3);
    // …then nothing else fires.
    await act(async () => {
      vi.advanceTimersByTime(60_000);
    });
    expect(countInvalidations(invalidateSpy, eventPairKey)).toBe(3);
  });
});
