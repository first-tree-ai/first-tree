// @vitest-environment happy-dom

import type { ChatDetail, ChatParticipantDetail, ListMeChatsResponse, MeChatRow } from "@first-tree/shared";
import { type InfiniteData, QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

type WsMessage = { type: string; chatId?: string };

const chatMocks = vi.hoisted(() => ({
  getChat: vi.fn(),
}));

const meChatMocks = vi.hoisted(() => ({
  joinMeChat: vi.fn(),
  markMeChatRead: vi.fn(),
}));

const authMock = vi.hoisted(() => ({
  value: {
    agentId: "human-agent-self" as string | null,
    organizationId: "org-1" as string | null,
    memberships: [{ organizationId: "org-1" }, { organizationId: "org-2" }] as Array<{ organizationId: string }>,
    selectOrganization: vi.fn(),
    switchingOrg: null as { id: string; displayName: string } | null,
  },
}));

const wsMock = vi.hoisted(() => ({
  handler: null as ((message: WsMessage) => void) | null,
}));

const chatViewMocks = vi.hoisted(() => ({
  props: [] as Array<{
    agentId: string;
    chatId: string;
    readOnly?: boolean;
    initialChatDetail?: ChatDetail;
    titleFallback?: string | null;
    joinAction?: {
      onJoin: () => void;
      joining: boolean;
      error: string | null;
    };
    narrow: boolean;
    onShowConversations: (() => void) | null;
  }>,
}));

const draftMocks = vi.hoisted(() => ({
  props: [] as Array<{
    onCreated: (chatId: string) => void;
    onShowConversations: (() => void) | null;
    initialParticipantIds?: string[];
  }>,
}));

vi.mock("../../../../api/chats.js", () => chatMocks);

vi.mock("../../../../api/me-chats.js", () => meChatMocks);

vi.mock("../../../../auth/auth-context.js", () => ({
  useAuth: () => authMock.value,
}));

vi.mock("../../../../hooks/use-admin-ws.js", () => ({
  useAdminWs: ({ onMessage }: { onMessage: (message: WsMessage) => void }) => {
    wsMock.handler = onMessage;
  },
}));

vi.mock("../chat-view.js", async () => {
  const React = await import("react");
  return {
    ChatView: (props: (typeof chatViewMocks.props)[number]) => {
      chatViewMocks.props.push(props);
      return React.createElement(
        "div",
        { "data-testid": "chat-view" },
        [
          `ChatView ${props.agentId} ${props.chatId}`,
          props.readOnly ? " read-only" : "",
          props.titleFallback ? ` ${props.titleFallback}` : "",
          props.joinAction?.error ? ` ${props.joinAction.error}` : "",
        ].join(""),
        props.joinAction
          ? React.createElement("button", { type: "button", onClick: props.joinAction.onJoin }, "Join chat")
          : null,
      );
    },
  };
});

vi.mock("../../conversations/new-chat-draft.js", async () => {
  const React = await import("react");
  return {
    NewChatDraft: (props: (typeof draftMocks.props)[number]) => {
      draftMocks.props.push(props);
      return React.createElement(
        "div",
        { "data-testid": "new-chat-draft" },
        "Draft",
        React.createElement("button", { type: "button", onClick: () => props.onCreated("created-chat") }, "Created"),
      );
    },
  };
});

const NOW = "2026-05-28T12:00:00.000Z";

function participant(
  overrides: Partial<ChatParticipantDetail> & { agentId: string; type: string },
): ChatParticipantDetail {
  return {
    agentId: overrides.agentId,
    role: overrides.role ?? "member",
    mode: overrides.mode ?? "speaker",
    joinedAt: overrides.joinedAt ?? NOW,
    name: overrides.name ?? overrides.agentId,
    displayName: overrides.displayName ?? overrides.agentId,
    type: overrides.type,
    avatarColorToken: overrides.avatarColorToken ?? null,
    avatarImageUrl: overrides.avatarImageUrl ?? null,
  };
}

function chatDetail(overrides: Partial<ChatDetail> = {}): ChatDetail {
  return {
    id: overrides.id ?? "chat-1",
    organizationId: overrides.organizationId ?? "org-1",
    type: overrides.type ?? "group",
    topic: overrides.topic ?? "Launch",
    description: overrides.description ?? null,
    descriptionUpdatedAt: overrides.descriptionUpdatedAt ?? null,
    lastReadAt: overrides.lastReadAt ?? null,
    externalChannel: overrides.externalChannel ?? null,
    lifecyclePolicy: overrides.lifecyclePolicy ?? null,
    metadata: overrides.metadata ?? {},
    createdAt: overrides.createdAt ?? NOW,
    updatedAt: overrides.updatedAt ?? NOW,
    participants: overrides.participants ?? [
      participant({ agentId: "human-agent-self", type: "human", displayName: "Gandy" }),
      participant({ agentId: "agent-1", type: "agent", displayName: "Nova" }),
      participant({ agentId: "human-agent-alice", type: "human", displayName: "Alice" }),
    ],
    title: overrides.title ?? "Launch chat",
    firstMessagePreview: overrides.firstMessagePreview ?? null,
    engagementStatus: overrides.engagementStatus ?? "active",
    viewerMembershipKind:
      "viewerMembershipKind" in overrides ? (overrides.viewerMembershipKind ?? null) : "participant",
  };
}

function meChatRow(overrides: Partial<MeChatRow> & { chatId: string }): MeChatRow {
  return {
    chatId: overrides.chatId,
    type: overrides.type ?? "group",
    membershipKind: overrides.membershipKind ?? "participant",
    createdByMe: overrides.createdByMe ?? false,
    source: overrides.source ?? "manual",
    entityType: overrides.entityType ?? null,
    title: overrides.title ?? "Launch chat",
    topic: overrides.topic ?? "Launch",
    description: overrides.description ?? null,
    participants: overrides.participants ?? [
      {
        agentId: "human-agent-self",
        displayName: "Gandy",
        type: "human",
        avatarColorToken: null,
        avatarImageUrl: null,
      },
      {
        agentId: "agent-1",
        displayName: "Nova",
        type: "agent",
        avatarColorToken: null,
        avatarImageUrl: null,
      },
    ],
    participantCount: overrides.participantCount ?? 2,
    lastMessageAt: overrides.lastMessageAt ?? NOW,
    lastMessagePreview: overrides.lastMessagePreview ?? "Latest",
    unreadMentionCount: overrides.unreadMentionCount ?? 0,
    openRequestCount: overrides.openRequestCount ?? 0,
    canReply: overrides.canReply ?? true,
    engagementStatus: overrides.engagementStatus ?? "active",
    liveActivity: overrides.liveActivity ?? null,
    failedAgentIds: overrides.failedAgentIds ?? [],
    busyAgentIds: overrides.busyAgentIds ?? [],
    chatHasExplicitMentionToMe: overrides.chatHasExplicitMentionToMe ?? false,
    pinnedAt: null,
    activityAt: null,
  };
}

function createClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false, refetchOnWindowFocus: false },
      mutations: { retry: false },
    },
  });
}

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

async function renderDom(
  element: ReactElement,
  queryClient: QueryClient = createClient(),
): Promise<{ container: HTMLElement; queryClient: QueryClient; root: Root }> {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(<QueryClientProvider client={queryClient}>{element}</QueryClientProvider>);
  });
  await flush();
  return { container, queryClient, root };
}

async function waitForText(container: ParentNode, text: string, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (container.textContent?.includes(text)) return;
    await flush();
  }
  throw new Error(`Expected text "${text}"`);
}

async function click(element: Element | null): Promise<void> {
  if (!element) throw new Error("Expected element to click");
  await act(async () => {
    element.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  });
  await flush();
}

beforeEach(() => {
  document.body.innerHTML = "";
  vi.clearAllMocks();
  wsMock.handler = null;
  chatViewMocks.props.length = 0;
  draftMocks.props.length = 0;
  authMock.value = {
    agentId: "human-agent-self",
    organizationId: "org-1",
    memberships: [{ organizationId: "org-1" }, { organizationId: "org-2" }],
    selectOrganization: vi.fn(),
    switchingOrg: null,
  };
  chatMocks.getChat.mockResolvedValue(chatDetail());
  meChatMocks.markMeChatRead.mockResolvedValue({
    chatId: "chat-1",
    lastReadAt: NOW,
    unreadMentionCount: 0,
  });
  meChatMocks.joinMeChat.mockResolvedValue(undefined);
});

afterEach(() => {
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

describe("ChatByIdView and CenterPanel", () => {
  it("picks the first non-human non-self agent and marks readable chats on mount and websocket frames", async () => {
    const { ChatByIdView } = await import("../chat-by-id.js");
    const onShowConversations = vi.fn();
    const queryClient = createClient();
    const invalidateSpy = vi.spyOn(queryClient, "invalidateQueries");
    const allKey = ["me", "chats", "all", "active", false, null, null];
    const unreadKey = ["me", "chats", "unread", "active", false, null, null];
    const mobileAllKey = ["me", "chats", "mobile", "work-list", "org-1", "active", false, "all"];
    const mobileUnreadKey = ["me", "chats", "mobile", "work-list", "org-1", "active", false, "unread"];
    const mobileSourceCountsKey = ["me", "chats", "mobile", "work-source-counts", "org-1", "active", false];
    const currentUnread = meChatRow({
      chatId: "chat-1",
      unreadMentionCount: 2,
      chatHasExplicitMentionToMe: true,
      pinnedAt: null,
      activityAt: null,
    });
    const otherUnread = meChatRow({
      chatId: "chat-2",
      title: "Other chat",
      unreadMentionCount: 1,
      chatHasExplicitMentionToMe: true,
      pinnedAt: null,
      activityAt: null,
    });
    // The desktop rail stores InfiniteData (`useInfiniteQuery`); the command
    // palette stores a bare ListMeChatsResponse. Seed both so the mark-read
    // patch is exercised against each cache shape it must handle.
    const paletteKey = ["me", "chats", "palette"];
    const infinite = (
      rows: MeChatRow[],
      priorityRows: ListMeChatsResponse["priorityRows"] = { pinned: [] },
    ): InfiniteData<ListMeChatsResponse> => ({
      pages: [{ rows, nextCursor: null, priorityRows }],
      pageParams: [undefined],
    });
    queryClient.setQueryData<InfiniteData<ListMeChatsResponse>>(
      allKey,
      infinite([currentUnread, otherUnread], { pinned: [currentUnread] }),
    );
    queryClient.setQueryData<InfiniteData<ListMeChatsResponse>>(
      unreadKey,
      infinite([currentUnread, otherUnread], { pinned: [currentUnread] }),
    );
    queryClient.setQueryData<ListMeChatsResponse>(paletteKey, {
      rows: [currentUnread, otherUnread],
      nextCursor: null,
      priorityRows: { pinned: [currentUnread] },
    });
    queryClient.setQueryData<InfiniteData<ListMeChatsResponse>>(
      mobileAllKey,
      infinite([currentUnread, otherUnread], { pinned: [currentUnread] }),
    );
    queryClient.setQueryData<InfiniteData<ListMeChatsResponse>>(
      mobileUnreadKey,
      infinite([currentUnread, otherUnread], { pinned: [currentUnread] }),
    );
    queryClient.setQueryData(mobileSourceCountsKey, {
      counts: { manual: { chatCount: 2, unreadChatCount: 2 } },
    });

    const { container, root } = await renderDom(
      <ChatByIdView chatId="chat-1" narrow onShowConversations={onShowConversations} />,
      queryClient,
    );

    await waitForText(container, "ChatView agent-1 chat-1");
    expect(chatMocks.getChat).toHaveBeenCalledWith("chat-1");
    expect(meChatMocks.markMeChatRead).toHaveBeenCalledTimes(1);
    expect(invalidateSpy).toHaveBeenCalledWith({
      queryKey: ["me", "chats", "mobile", "work-source-counts"],
    });
    const allRows = queryClient.getQueryData<InfiniteData<ListMeChatsResponse>>(allKey)?.pages.flatMap((p) => p.rows);
    expect(allRows?.find((row) => row.chatId === "chat-1")).toMatchObject({
      unreadMentionCount: 0,
      chatHasExplicitMentionToMe: false,
      pinnedAt: null,
      activityAt: null,
    });
    expect(
      queryClient.getQueryData<InfiniteData<ListMeChatsResponse>>(allKey)?.pages[0]?.priorityRows.pinned[0],
    ).toMatchObject({
      unreadMentionCount: 0,
      chatHasExplicitMentionToMe: false,
    });
    expect(allRows?.find((row) => row.chatId === "chat-2")).toMatchObject({
      unreadMentionCount: 1,
      chatHasExplicitMentionToMe: true,
      pinnedAt: null,
      activityAt: null,
    });
    const unreadRows = queryClient
      .getQueryData<InfiniteData<ListMeChatsResponse>>(unreadKey)
      ?.pages.flatMap((p) => p.rows);
    expect(unreadRows?.map((row) => row.chatId)).toEqual(["chat-2"]);
    expect(
      queryClient.getQueryData<InfiniteData<ListMeChatsResponse>>(unreadKey)?.pages[0]?.priorityRows.pinned,
    ).toEqual([]);
    // The bare-response (palette / mobile) shape is patched in place too.
    const patchedPalette = queryClient.getQueryData<ListMeChatsResponse>(paletteKey);
    expect(patchedPalette?.rows.find((row) => row.chatId === "chat-1")).toMatchObject({ unreadMentionCount: 0 });
    expect(patchedPalette?.priorityRows.pinned[0]).toMatchObject({
      unreadMentionCount: 0,
      chatHasExplicitMentionToMe: false,
    });
    const mobileAll = queryClient.getQueryData<InfiniteData<ListMeChatsResponse>>(mobileAllKey)?.pages[0];
    expect(mobileAll?.rows.find((row) => row.chatId === "chat-1")).toMatchObject({
      unreadMentionCount: 0,
      chatHasExplicitMentionToMe: false,
    });
    expect(mobileAll?.priorityRows.pinned[0]).toMatchObject({ unreadMentionCount: 0 });
    const mobileUnread = queryClient.getQueryData<InfiniteData<ListMeChatsResponse>>(mobileUnreadKey)?.pages[0];
    expect(mobileUnread?.rows.map((row) => row.chatId)).toEqual(["chat-2"]);
    expect(mobileUnread?.priorityRows.pinned).toEqual([]);
    expect(queryClient.getQueryData(mobileSourceCountsKey)).toEqual({
      counts: { manual: { chatCount: 2, unreadChatCount: 2 } },
    });
    expect(queryClient.getQueryState(mobileSourceCountsKey)?.isInvalidated).toBe(true);
    expect(chatViewMocks.props.at(-1)).toMatchObject({
      agentId: "agent-1",
      chatId: "chat-1",
      initialChatDetail: expect.objectContaining({ id: "chat-1" }),
      narrow: true,
      onShowConversations,
    });

    await act(async () => {
      wsMock.handler?.({ type: "chat:message", chatId: "other-chat" });
      wsMock.handler?.({ type: "chat:message", chatId: "chat-1" });
      wsMock.handler?.({ type: "ws:reconnect" });
    });
    await flush();
    expect(meChatMocks.markMeChatRead).toHaveBeenCalledTimes(3);

    await act(async () => root.unmount());
  });

  it("falls back to a non-self human, skips mark-read for supervisor views, and mounts ChatView for self-only roster", async () => {
    chatMocks.getChat.mockResolvedValueOnce(
      chatDetail({
        participants: [
          participant({ agentId: "human-agent-self", type: "human" }),
          participant({ agentId: "human-agent-alice", type: "human", displayName: "Alice" }),
        ],
        viewerMembershipKind: null,
      }),
    );
    const { ChatByIdView } = await import("../chat-by-id.js");
    const fallback = await renderDom(<ChatByIdView chatId="chat-2" narrow={false} onShowConversations={null} />);
    await waitForText(fallback.container, "ChatView human-agent-alice chat-2");
    expect(meChatMocks.markMeChatRead).not.toHaveBeenCalled();
    await act(async () => fallback.root.unmount());

    chatMocks.getChat.mockResolvedValueOnce(
      chatDetail({ participants: [participant({ agentId: "human-agent-self", type: "human" })] }),
    );
    const selfOnly = await renderDom(<ChatByIdView chatId="chat-3" narrow={false} onShowConversations={null} />);
    await waitForText(selfOnly.container, "ChatView human-agent-self chat-3");
    expect(selfOnly.container.textContent).not.toContain("Resolving participants");
    expect(chatViewMocks.props.at(-1)?.agentId).toBe("human-agent-self");
    await act(async () => selfOnly.root.unmount());
  });

  it("shows an unavailable empty state when a manual chat URL cannot be loaded", async () => {
    chatMocks.getChat.mockRejectedValueOnce(new Error("not found"));
    const onClearChat = vi.fn();
    const { ChatByIdView } = await import("../chat-by-id.js");
    const { container, root } = await renderDom(
      <ChatByIdView chatId="missing-chat" narrow={false} onShowConversations={null} onClearChat={onClearChat} />,
    );

    await waitForText(container, "This chat doesn't exist or you don't have access.");
    expect(container.textContent).toContain("Chat unavailable");
    expect(container.textContent).not.toContain("Resolving participants");
    expect(chatViewMocks.props).toHaveLength(0);
    expect(meChatMocks.markMeChatRead).not.toHaveBeenCalled();

    await click(
      [...container.querySelectorAll("button")].find((button) => button.textContent?.includes("Back")) ?? null,
    );
    expect(onClearChat).toHaveBeenCalledTimes(1);

    await act(async () => root.unmount());
  });

  it("passes watcher join state into ChatView and invalidates via the join action", async () => {
    chatMocks.getChat.mockResolvedValueOnce(chatDetail({ viewerMembershipKind: "watching", title: "Watch title" }));
    const { ChatByIdView } = await import("../chat-by-id.js");
    const { container, root } = await renderDom(
      <ChatByIdView chatId="chat-watch" narrow={false} onShowConversations={null} />,
    );

    await waitForText(container, "read-only");
    expect(chatViewMocks.props.at(-1)?.titleFallback).toBe("Watch title");
    await click(container.querySelector("button"));
    expect(meChatMocks.joinMeChat).toHaveBeenCalledWith("chat-watch");

    await act(async () => root.unmount());
  });

  it("forces Feishu chats read-only without offering the watcher join action", async () => {
    chatMocks.getChat.mockResolvedValueOnce(
      chatDetail({
        metadata: {
          source: "feishu",
          botBindingId: "binding-1",
          externalChatId: "oc_1",
          externalChatType: "group",
        },
        viewerMembershipKind: "participant",
        title: "Feishu task",
      }),
    );
    const { ChatByIdView } = await import("../chat-by-id.js");
    const { container, root } = await renderDom(
      <ChatByIdView chatId="chat-feishu" narrow={false} onShowConversations={null} />,
    );

    await waitForText(container, "read-only");
    expect(chatViewMocks.props.at(-1)).toMatchObject({
      chatId: "chat-feishu",
      readOnly: true,
      joinAction: undefined,
      titleFallback: "Feishu task",
    });
    expect(container.querySelector("button")).toBeNull();

    await act(async () => root.unmount());
  });

  it("routes CenterPanel between draft, selected chat, and empty state", async () => {
    const { CenterPanel } = await import("../index.js");
    const onSelectChat = vi.fn();
    const onClearChat = vi.fn();
    const onShowConversations = vi.fn();

    const draft = await renderDom(
      <CenterPanel
        selectedChatId="draft"
        onSelectChat={onSelectChat}
        onClearChat={onClearChat}
        narrow
        onShowConversations={onShowConversations}
        initialParticipantIds={["agent-1"]}
      />,
    );
    expect(draft.container.textContent).toContain("Draft");
    expect(draftMocks.props.at(-1)).toMatchObject({
      onShowConversations,
      initialParticipantIds: ["agent-1"],
    });
    await click(draft.container.querySelector("button"));
    expect(onSelectChat).toHaveBeenCalledWith("created-chat");
    await act(async () => draft.root.unmount());

    const selected = await renderDom(
      <CenterPanel
        selectedChatId="chat-1"
        onSelectChat={onSelectChat}
        onClearChat={onClearChat}
        narrow={false}
        onShowConversations={null}
      />,
    );
    await waitForText(selected.container, "ChatView agent-1 chat-1");
    await act(async () => selected.root.unmount());

    const empty = await renderDom(
      <CenterPanel
        selectedChatId={null}
        onSelectChat={onSelectChat}
        onClearChat={onClearChat}
        narrow={false}
        onShowConversations={null}
      />,
    );
    await click(
      [...empty.container.querySelectorAll("button")].find((button) => button.textContent?.includes("New chat")) ??
        null,
    );
    expect(onSelectChat).toHaveBeenCalledWith("draft");
    await act(async () => empty.root.unmount());
  });

  it("switches the workspace to the chat's org when it differs and the user is a member", async () => {
    authMock.value.organizationId = "org-1";
    authMock.value.memberships = [{ organizationId: "org-1" }, { organizationId: "org-2" }];
    chatMocks.getChat.mockResolvedValueOnce(chatDetail({ organizationId: "org-2" }));
    const { ChatByIdView } = await import("../chat-by-id.js");
    const { container, root } = await renderDom(
      <ChatByIdView chatId="chat-xorg" narrow={false} onShowConversations={null} />,
    );

    await waitForText(container, "ChatView agent-1 chat-xorg");
    expect(authMock.value.selectOrganization).toHaveBeenCalledTimes(1);
    expect(authMock.value.selectOrganization).toHaveBeenCalledWith("org-2");

    await act(async () => root.unmount());
  });

  it("does not auto-switch back to the open chat's org while a team switch is in flight", async () => {
    authMock.value.organizationId = "org-2";
    authMock.value.switchingOrg = { id: "org-2", displayName: "Globex" };
    authMock.value.memberships = [{ organizationId: "org-1" }, { organizationId: "org-2" }];
    chatMocks.getChat.mockResolvedValueOnce(chatDetail({ organizationId: "org-1" }));
    const { ChatByIdView } = await import("../chat-by-id.js");
    const { container, root } = await renderDom(
      <ChatByIdView chatId="chat-old-org" narrow={false} onShowConversations={null} />,
    );

    await waitForText(container, "ChatView agent-1 chat-old-org");
    expect(authMock.value.selectOrganization).not.toHaveBeenCalled();

    await act(async () => root.unmount());
  });

  it("does not switch org when the opened chat is already in the current org", async () => {
    authMock.value.organizationId = "org-1";
    authMock.value.memberships = [{ organizationId: "org-1" }, { organizationId: "org-2" }];
    chatMocks.getChat.mockResolvedValueOnce(chatDetail({ organizationId: "org-1" }));
    const { ChatByIdView } = await import("../chat-by-id.js");
    const { container, root } = await renderDom(
      <ChatByIdView chatId="chat-sameorg" narrow={false} onShowConversations={null} />,
    );

    await waitForText(container, "ChatView agent-1 chat-sameorg");
    expect(authMock.value.selectOrganization).not.toHaveBeenCalled();

    await act(async () => root.unmount());
  });

  it("does not switch into an org the caller is not a member of (stale /me guard)", async () => {
    authMock.value.organizationId = "org-1";
    authMock.value.memberships = [{ organizationId: "org-1" }];
    chatMocks.getChat.mockResolvedValueOnce(chatDetail({ organizationId: "org-2" }));
    const { ChatByIdView } = await import("../chat-by-id.js");
    const { container, root } = await renderDom(
      <ChatByIdView chatId="chat-guard" narrow={false} onShowConversations={null} />,
    );

    await waitForText(container, "ChatView agent-1 chat-guard");
    expect(authMock.value.selectOrganization).not.toHaveBeenCalled();

    await act(async () => root.unmount());
  });

  it("does not loop the auto-switch after a rejected switch, and still tries a new target", async () => {
    authMock.value.organizationId = "org-1";
    authMock.value.memberships = [
      { organizationId: "org-1" },
      { organizationId: "org-2" },
      { organizationId: "org-3" },
    ];
    authMock.value.selectOrganization = vi.fn(async () => {
      throw new Error("offline");
    });
    // Refetches keep resolving so repeated effect passes stay possible.
    chatMocks.getChat.mockImplementation(async (chatId: string) =>
      chatDetail({ organizationId: chatId === "chat-other" ? "org-3" : "org-2" }),
    );
    const { ChatByIdView } = await import("../chat-by-id.js");
    const queryClient = createClient();
    const { container, root } = await renderDom(
      <ChatByIdView chatId="chat-reject" narrow={false} onShowConversations={null} />,
      queryClient,
    );

    await waitForText(container, "ChatView agent-1 chat-reject");
    expect(authMock.value.selectOrganization).toHaveBeenCalledTimes(1);
    expect(authMock.value.selectOrganization).toHaveBeenCalledWith("org-2");

    // Rejection fallout: the rollback leaves the org on org-1 and the cache
    // clear refetches this chat's detail — the same target must NOT re-fire,
    // no matter how many renders/effect passes follow.
    await act(async () => {
      queryClient.clear();
    });
    await flush();
    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <ChatByIdView chatId="chat-reject" narrow={false} onShowConversations={null} />
        </QueryClientProvider>,
      );
    });
    await flush();
    await flush();
    expect(authMock.value.selectOrganization).toHaveBeenCalledTimes(1);

    // A genuinely different chat target is still attempted.
    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <ChatByIdView chatId="chat-other" narrow={false} onShowConversations={null} />
        </QueryClientProvider>,
      );
    });
    await waitForText(container, "ChatView agent-1 chat-other");
    expect(authMock.value.selectOrganization).toHaveBeenCalledTimes(2);
    expect(authMock.value.selectOrganization).toHaveBeenLastCalledWith("org-3");

    await act(async () => root.unmount());
  });
});
