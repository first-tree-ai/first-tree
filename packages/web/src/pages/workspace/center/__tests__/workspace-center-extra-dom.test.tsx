// @vitest-environment happy-dom

import {
  AGENT_FINAL_TEXT_METADATA_KEY,
  type Agent,
  type ChatDetail,
  type ChatParticipantDetail,
  type ListMeChatsResponse,
  type MeChatRow,
} from "@first-tree/shared";
import { type InfiniteData, QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter, useLocation } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HubClient } from "../../../../api/activity.js";
import type { MessageWithDelivery, PaginatedMessages } from "../../../../api/chats.js";
import type { SessionEventRow } from "../../../../api/sessions.js";
import { agentSessionsQueryKey } from "../../../../api/sessions.js";
import { ToastProvider } from "../../../../components/ui/toast.js";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const activityMocks = vi.hoisted(() => ({
  getClient: vi.fn(),
  listClients: vi.fn(),
  startRuntimeAuth: vi.fn(),
}));

const agentStatusMocks = vi.hoisted(() => ({
  fetchChatAgentStatuses: vi.fn(),
}));

const agentMocks = vi.hoisted(() => ({
  getAgentSkills: vi.fn(),
}));

const agentResourceMocks = vi.hoisted(() => ({
  getAgentResources: vi.fn(),
}));

const attachmentMocks = vi.hoisted(() => ({
  downloadAttachment: vi.fn(),
  fetchAttachmentBase64: vi.fn(),
  uploadAttachment: vi.fn(),
  uploadImageAttachment: vi.fn(),
  uploadMimeFor: vi.fn((file: File) => file.type || "application/octet-stream"),
}));

const chatMocks = vi.hoisted(() => ({
  getChat: vi.fn(),
  getChatTokenUsage: vi.fn(),
  listChatGithubEntities: vi.fn(),
  listChatMessages: vi.fn(),
  listChatOpenRequests: vi.fn(),
  patchChatEngagement: vi.fn(),
  readFileAsBase64: vi.fn(),
  renameChat: vi.fn(),
  sendChatMessage: vi.fn(),
  sendFileMessageBatch: vi.fn(),
}));

const imageStoreMocks = vi.hoisted(() => ({
  getImage: vi.fn(),
  putImage: vi.fn(),
}));

const readStateMocks = vi.hoisted(() => ({
  getReadState: vi.fn(),
  setReadState: vi.fn(),
}));

const sessionMocks = vi.hoisted(() => ({
  listChatSessionEvents: vi.fn(),
  listSessionEvents: vi.fn(),
  listSessionOutputs: vi.fn(),
}));

const authMock = vi.hoisted(() => ({
  value: {
    agentId: "human-agent-self",
    memberId: "member-self",
    role: "admin",
    user: { id: "user-self" },
  },
}));

vi.mock("../../../../api/activity.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../../api/activity.js")>()),
  getClient: activityMocks.getClient,
  listClients: activityMocks.listClients,
  startRuntimeAuth: activityMocks.startRuntimeAuth,
}));

vi.mock("../../../../api/agent-status.js", () => ({
  chatAgentStatusQueryKey: (chatId: string) => ["chat-agent-status", chatId] as const,
  fetchChatAgentStatuses: agentStatusMocks.fetchChatAgentStatuses,
}));

vi.mock("../../../../api/agents.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../../api/agents.js")>()),
  getAgentSkills: agentMocks.getAgentSkills,
}));

vi.mock("../../../../api/agent-resources.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../../api/agent-resources.js")>()),
  getAgentResources: agentResourceMocks.getAgentResources,
}));

vi.mock("../../../../api/attachments.js", () => attachmentMocks);

vi.mock("../../../../api/chats.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../../api/chats.js")>()),
  ...chatMocks,
}));

vi.mock("../../../../api/image-store.js", () => imageStoreMocks);

vi.mock("../../../../api/read-state-store.js", () => readStateMocks);

vi.mock("../../../../api/sessions.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../../api/sessions.js")>()),
  listChatSessionEvents: sessionMocks.listChatSessionEvents,
  listSessionEvents: sessionMocks.listSessionEvents,
  listSessionOutputs: sessionMocks.listSessionOutputs,
}));

vi.mock("../../../../auth/auth-context.js", () => ({
  useAuth: () => authMock.value,
}));

vi.mock("../../../../components/add-participant-dropdown.js", () => ({
  AddParticipantDropdown: ({ variant }: { variant: "icon" | "inline" }) => (
    <button aria-label="Add participant" type="button">
      Add participant ({variant})
    </button>
  ),
}));

vi.mock("../../../../lib/use-agent-name-map.js", () => ({
  useAgentIdentityMap: () => resolveAgentIdentityForTest,
  useAgentNameMap: () => resolveAgentNameForTest,
  useAgentSlugToIdMap: () => resolveAgentSlugForTest,
}));

vi.mock("../../../../lib/use-org-agents.js", () => ({
  useOrgAgents: () => ({ data: { items: ORG_AGENTS, nextCursor: null } }),
  useOrgAgentsSearch: () => ({ data: { items: ORG_AGENTS, nextCursor: null }, isFetching: false }),
}));

vi.mock("../../../../lib/visibility-interval.js", () => ({
  runVisibilityAwareInterval: (tick: () => void | Promise<void>) => {
    void tick();
    return () => undefined;
  },
}));

const NOW = "2026-05-28T12:00:00.000Z";
const DOC_ATTACHMENT_ID = "00000000-0000-4000-8000-000000000101";
const IMAGE_ID = "00000000-0000-4000-8000-000000000202";

const AGENT_NAMES: Record<string, string> = {
  "agent-1": "Nova",
  "agent-2": "Design Critique",
  "human-agent-self": "Gandy",
};

const AGENT_SLUGS: Record<string, string> = {
  "agent-1": "nova",
  "agent-2": "design",
  "human-agent-self": "gandy",
};

function resolveAgentIdentityForTest(id: string | null | undefined) {
  if (!id) return null;
  return {
    name: AGENT_SLUGS[id] ?? id,
    displayName: AGENT_NAMES[id] ?? id,
    avatarImageUrl: null,
    avatarColorToken: id === "agent-1" ? "hue-2" : null,
  };
}

function resolveAgentNameForTest(id: string | null | undefined): string {
  return id ? (AGENT_NAMES[id] ?? id) : "unknown";
}

function resolveAgentSlugForTest(slug: string | null | undefined): string | null {
  if (!slug) return null;
  return Object.entries(AGENT_SLUGS).find(([, value]) => value === slug)?.[0] ?? null;
}

function agent(overrides: Partial<Agent> = {}): Agent {
  return {
    uuid: overrides.uuid ?? "agent-1",
    name: overrides.name ?? "nova",
    displayName: overrides.displayName ?? "Nova",
    type: overrides.type ?? "agent",
    managerId: overrides.managerId ?? "member-self",
    visibility: overrides.visibility ?? "organization",
    avatarColorToken: overrides.avatarColorToken ?? null,
    avatarImageUrl: overrides.avatarImageUrl ?? null,
    status: overrides.status ?? "active",
    organizationId: overrides.organizationId ?? "org-1",
    delegateMention: overrides.delegateMention ?? null,
    inboxId: overrides.inboxId ?? "inbox-1",
    metadata: overrides.metadata ?? {},
    source: overrides.source ?? "portal",
    clientId: overrides.clientId ?? "client-1",
    runtimeProvider: overrides.runtimeProvider ?? "claude-code",
    runtimeState: overrides.runtimeState ?? "idle",
    createdAt: overrides.createdAt ?? NOW,
    updatedAt: overrides.updatedAt ?? NOW,
  };
}

const ORG_AGENTS = [
  agent({ uuid: "human-agent-self", name: "gandy", displayName: "Gandy", type: "human", clientId: null }),
  agent(),
  agent({ uuid: "agent-2", name: "design", displayName: "Design Critique", managerId: "member-alice" }),
];

function participant(overrides: Partial<ChatParticipantDetail> & { agentId: string }): ChatParticipantDetail {
  return {
    agentId: overrides.agentId,
    role: overrides.role ?? "member",
    mode: overrides.mode ?? "full",
    joinedAt: overrides.joinedAt ?? NOW,
    name: overrides.name ?? AGENT_SLUGS[overrides.agentId] ?? overrides.agentId,
    displayName: overrides.displayName ?? AGENT_NAMES[overrides.agentId] ?? overrides.agentId,
    type: overrides.type ?? "agent",
    avatarColorToken: overrides.avatarColorToken ?? null,
    avatarImageUrl: overrides.avatarImageUrl ?? null,
  };
}

const PARTICIPANTS: ChatParticipantDetail[] = [
  participant({ agentId: "human-agent-self", type: "human", name: "gandy", displayName: "Gandy" }),
  participant({ agentId: "agent-1", name: "nova", displayName: "Nova" }),
  participant({ agentId: "agent-2", name: "design", displayName: "Design Critique" }),
];

function chatDetail(overrides: Partial<ChatDetail> = {}): ChatDetail {
  return {
    id: overrides.id ?? "chat-1",
    organizationId: overrides.organizationId ?? "org-1",
    type: overrides.type ?? "group",
    topic: overrides.topic ?? "Launch planning",
    description: overrides.description ?? null,
    descriptionUpdatedAt: overrides.descriptionUpdatedAt ?? null,
    lastReadAt: overrides.lastReadAt ?? null,
    externalChannel: overrides.externalChannel ?? null,
    lifecyclePolicy: overrides.lifecyclePolicy ?? null,
    metadata: overrides.metadata ?? { source: "github", entityUrl: "https://github.com/acme/web/pull/42" },
    createdAt: overrides.createdAt ?? NOW,
    updatedAt: overrides.updatedAt ?? NOW,
    participants: overrides.participants ?? PARTICIPANTS,
    title: overrides.title ?? "Launch planning",
    firstMessagePreview: overrides.firstMessagePreview ?? "Please review the launch checklist.",
    engagementStatus: overrides.engagementStatus ?? "active",
    viewerMembershipKind: overrides.viewerMembershipKind ?? "participant",
  };
}

function meChatRow(overrides: Partial<MeChatRow> & { chatId: string; title: string }): MeChatRow {
  return {
    chatId: overrides.chatId,
    type: overrides.type ?? "group",
    membershipKind: overrides.membershipKind ?? "participant",
    createdByMe: overrides.createdByMe ?? false,
    source: overrides.source ?? "manual",
    entityType: overrides.entityType ?? null,
    title: overrides.title,
    topic: overrides.topic ?? overrides.title,
    description: overrides.description ?? null,
    participants:
      overrides.participants ??
      PARTICIPANTS.map(({ agentId, displayName, type, avatarColorToken, avatarImageUrl }) => ({
        agentId,
        displayName,
        type,
        avatarColorToken,
        avatarImageUrl,
      })),
    participantCount: overrides.participantCount ?? PARTICIPANTS.length,
    lastMessageAt: overrides.lastMessageAt ?? NOW,
    lastMessagePreview: overrides.lastMessagePreview ?? "Latest update",
    unreadMentionCount: overrides.unreadMentionCount ?? 0,
    openRequestCount: overrides.openRequestCount ?? 0,
    canReply: overrides.canReply ?? true,
    engagementStatus: overrides.engagementStatus ?? "active",
    liveActivity: overrides.liveActivity ?? null,
    failedAgentIds: overrides.failedAgentIds ?? [],
    busyAgentIds: overrides.busyAgentIds ?? [],
    chatHasExplicitMentionToMe: overrides.chatHasExplicitMentionToMe ?? false,
    pinnedAt: overrides.pinnedAt ?? null,
    activityAt: overrides.activityAt ?? null,
  };
}

function message(overrides: Partial<MessageWithDelivery> & { id: string; senderId: string }): MessageWithDelivery {
  return {
    id: overrides.id,
    chatId: overrides.chatId ?? "chat-1",
    senderId: overrides.senderId,
    senderKind: overrides.senderKind ?? "member",
    senderProvider: overrides.senderProvider ?? null,
    format: overrides.format ?? "text",
    content: overrides.content ?? "Message body",
    metadata: overrides.metadata ?? {},
    inReplyTo: overrides.inReplyTo ?? null,
    source: overrides.source ?? "web",
    createdAt: overrides.createdAt ?? NOW,
    deliveryStatus: overrides.deliveryStatus,
  };
}

function messages(items: MessageWithDelivery[]): PaginatedMessages {
  return { items, nextCursor: null };
}

const BASE_MESSAGES = messages([
  message({
    id: "msg-1",
    senderId: "human-agent-self",
    content: "Please review @nova.",
    metadata: { mentions: ["agent-1"] },
  }),
  message({
    id: "msg-2",
    senderId: "agent-1",
    content: "I am reviewing now.",
    source: "api",
    createdAt: "2026-05-28T12:01:00.000Z",
  }),
]);

const SESSION_EVENTS: { items: SessionEventRow[]; nextCursor: number | null } = {
  items: [],
  nextCursor: null,
};

function installBrowserStubs(): void {
  const storage = createStorage();
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: storage });
  Object.defineProperty(window, "localStorage", { configurable: true, value: storage });
  Object.defineProperty(globalThis, "crypto", {
    configurable: true,
    value: { randomUUID: () => "00000000-0000-4000-8000-000000000000" },
  });
  Object.defineProperty(window.URL, "createObjectURL", { configurable: true, value: () => "blob:test-image" });
  Object.defineProperty(window.URL, "revokeObjectURL", { configurable: true, value: vi.fn() });
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: (query: string) => ({
      matches: query.includes("48rem") || query.includes("80rem"),
      media: query,
      onchange: null,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      addListener: () => undefined,
      removeListener: () => undefined,
      dispatchEvent: () => false,
    }),
  });
  Object.defineProperty(HTMLElement.prototype, "scrollIntoView", { configurable: true, value: vi.fn() });
  Object.defineProperty(HTMLElement.prototype, "scrollTo", { configurable: true, value: vi.fn() });
  class TestResizeObserver {
    observe = vi.fn();
    disconnect = vi.fn();
    unobserve = vi.fn();
  }
  class TestIntersectionObserver {
    observe = vi.fn();
    disconnect = vi.fn();
    unobserve = vi.fn();
  }
  Object.defineProperty(globalThis, "ResizeObserver", { configurable: true, value: TestResizeObserver });
  Object.defineProperty(globalThis, "IntersectionObserver", { configurable: true, value: TestIntersectionObserver });
  Object.defineProperty(globalThis, "requestAnimationFrame", {
    configurable: true,
    value: (cb: FrameRequestCallback) => window.setTimeout(() => cb(Date.now()), 0),
  });
}

function createStorage(): Storage {
  const data = new Map<string, string>();
  return {
    get length() {
      return data.size;
    },
    clear: () => data.clear(),
    getItem: (key: string) => data.get(key) ?? null,
    key: (index: number) => [...data.keys()][index] ?? null,
    removeItem: (key: string) => data.delete(key),
    setItem: (key: string, value: string) => {
      data.set(key, value);
    },
  };
}

function createClient(): QueryClient {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false, refetchOnWindowFocus: false, staleTime: Infinity },
      mutations: { retry: false },
    },
  });
  queryClient.setQueryData(["agents", "org-list"], { items: ORG_AGENTS, nextCursor: null });
  queryClient.setQueryData(["chat-agent-status", "chat-1"], []);
  queryClient.setQueryData(agentSessionsQueryKey("agent-1"), []);
  return queryClient;
}

function seedChat(
  queryClient: QueryClient,
  detail: ChatDetail = chatDetail(),
  page: PaginatedMessages = BASE_MESSAGES,
): void {
  queryClient.setQueryData(["chat-detail", detail.id], detail);
  queryClient.setQueryData(["chat-messages-cache", detail.id], []);
  queryClient.setQueryData(["chat-messages", detail.id], page);
  queryClient.setQueryData(["chat-open-requests", detail.id], { items: [] });
  queryClient.setQueryData(["chat-session-events", detail.id], {
    feeds: [{ agentId: "agent-1", ...SESSION_EVENTS }],
  });
  queryClient.setQueryData(["chat-read-state", detail.id], null);
  queryClient.setQueryData(["chat-token-usage", detail.id], {
    inputTokens: 0,
    cachedInputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
  });
  queryClient.setQueryData(["chat-right-sidebar", "github-entities", detail.id], {
    items: [
      {
        entityType: "pull_request",
        entityKey: "acme/web#42",
        htmlUrl: "https://github.com/acme/web/pull/42",
        title: "Release checklist",
        state: "open",
        boundVia: "direct",
        number: 42,
      },
    ],
  });
}

function LocationProbe() {
  const location = useLocation();
  return <div data-testid="location">{`${location.pathname}${location.search}`}</div>;
}

async function renderDom(
  element: ReactElement,
  seed?: (queryClient: QueryClient) => void,
  route = "/",
): Promise<{ container: HTMLElement; queryClient: QueryClient; root: Root }> {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const queryClient = createClient();
  seedChat(queryClient);
  seed?.(queryClient);
  await act(async () => {
    root.render(
      <MemoryRouter initialEntries={[route]}>
        <QueryClientProvider client={queryClient}>
          <LocationProbe />
          <ToastProvider>{element}</ToastProvider>
        </QueryClientProvider>
      </MemoryRouter>,
    );
  });
  await flush();
  return { container, queryClient, root };
}

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

async function waitForText(container: ParentNode, text: string, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (container.textContent?.includes(text)) return;
    await flush();
  }
  throw new Error(`Expected text "${text}"`);
}

async function waitForCondition(predicate: () => boolean, message: string, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await flush();
  }
  throw new Error(message);
}

async function click(element: Element | null): Promise<void> {
  if (!element) throw new Error("Expected element to click");
  await act(async () => {
    element.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  });
  await flush();
}

async function setValue(element: HTMLInputElement | HTMLTextAreaElement, value: string): Promise<void> {
  await act(async () => {
    const proto = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
    setter?.call(element, value);
    element.dispatchEvent(new InputEvent("input", { bubbles: true, data: value, inputType: "insertText" }));
    element.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await flush();
}

function buttonByText(container: ParentNode, text: string): HTMLButtonElement | null {
  return [...container.querySelectorAll("button")].find((button) => button.textContent?.trim() === text) ?? null;
}

function buttonByTitle(container: ParentNode, title: string): HTMLButtonElement | null {
  return container.querySelector<HTMLButtonElement>(`button[title="${title}"]`);
}

function locationParams(container: ParentNode): URLSearchParams {
  const locationText = container.querySelector('[data-testid="location"]')?.textContent ?? "/";
  const query = locationText.includes("?") ? (locationText.split("?")[1] ?? "") : "";
  return new URLSearchParams(query);
}

beforeEach(() => {
  installBrowserStubs();
  document.body.innerHTML = "";
  vi.clearAllMocks();
  authMock.value = {
    agentId: "human-agent-self",
    memberId: "member-self",
    role: "admin",
    user: { id: "user-self" },
  };
  const client = {
    id: "client-1",
    userId: "user-self",
    status: "connected",
    authState: "ok",
    binName: "first-tree-dev",
    sdkVersion: "0.5.0",
    hostname: "gandy-macbook",
    os: "darwin",
    agentCount: 1,
    connectedAt: NOW,
    lastSeenAt: NOW,
    capabilities: {},
  } satisfies HubClient;
  activityMocks.getClient.mockResolvedValue(client);
  activityMocks.listClients.mockResolvedValue([client]);
  activityMocks.startRuntimeAuth.mockResolvedValue({ ref: "auth-ref", started: true });
  agentStatusMocks.fetchChatAgentStatuses.mockResolvedValue([]);
  agentMocks.getAgentSkills.mockResolvedValue({ skills: [] });
  agentResourceMocks.getAgentResources.mockResolvedValue({
    effective: { version: 1, repos: [], prompts: [], skills: [], mcp: [], unavailable: [] },
  });
  attachmentMocks.fetchAttachmentBase64.mockResolvedValue({ base64: "image-base64", mimeType: "image/png" });
  attachmentMocks.downloadAttachment.mockReset();
  attachmentMocks.uploadImageAttachment.mockResolvedValue({ id: IMAGE_ID, mimeType: "image/png", size: 3 });
  chatMocks.getChat.mockResolvedValue(chatDetail());
  chatMocks.getChatTokenUsage.mockResolvedValue({
    inputTokens: 0,
    cachedInputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
  });
  chatMocks.listChatGithubEntities.mockResolvedValue({ items: [] });
  chatMocks.listChatMessages.mockResolvedValue(BASE_MESSAGES);
  chatMocks.listChatOpenRequests.mockResolvedValue({ items: [] });
  chatMocks.patchChatEngagement.mockResolvedValue({ chatId: "chat-1", engagementStatus: "active" });
  chatMocks.readFileAsBase64.mockResolvedValue("image-base64");
  chatMocks.renameChat.mockResolvedValue({ id: "chat-1", topic: "Renamed launch" });
  chatMocks.sendChatMessage.mockResolvedValue(
    message({ id: "msg-sent", senderId: "human-agent-self", content: "sent" }),
  );
  chatMocks.sendFileMessageBatch.mockResolvedValue(
    message({ id: "msg-file", senderId: "human-agent-self", format: "file", content: { attachments: [] } }),
  );
  imageStoreMocks.getImage.mockResolvedValue(null);
  imageStoreMocks.putImage.mockResolvedValue(undefined);
  readStateMocks.getReadState.mockResolvedValue(null);
  readStateMocks.setReadState.mockResolvedValue(undefined);
  sessionMocks.listSessionEvents.mockImplementation((requestedAgentId: string) =>
    Promise.resolve(requestedAgentId === "agent-1" ? SESSION_EVENTS : { items: [], nextCursor: null }),
  );
  sessionMocks.listChatSessionEvents.mockResolvedValue({
    feeds: [{ agentId: "agent-1", ...SESSION_EVENTS }],
  });
  sessionMocks.listSessionOutputs.mockResolvedValue({ items: [], nextCursor: null });
});

afterEach(() => {
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

describe("chat-view exported helpers", () => {
  it("parses failed document mentions and returns stable drawer query keys", async () => {
    const { docAttachmentRefQueryKey, docMessageAttachmentRefsQueryKey, failedDocMentionsFromMetadata } = await import(
      "../chat-view.js"
    );

    expect(docAttachmentRefQueryKey(DOC_ATTACHMENT_ID)).toEqual(["chat-doc-attachment-ref", DOC_ATTACHMENT_ID]);
    expect(docMessageAttachmentRefsQueryKey("msg-doc")).toEqual(["chat-doc-message-attachment-refs", "msg-doc"]);
    expect(failedDocMentionsFromMetadata(undefined)).toBeUndefined();
    expect(failedDocMentionsFromMetadata({ documentContext: { kind: "none" } })).toBeUndefined();

    const failed = failedDocMentionsFromMetadata({
      documentContext: {
        kind: "snapshot",
        failedMentions: [
          { raw: "docs/private.md", reason: "hidden-segment" },
          { raw: "docs/missing.md", reason: "missing" },
        ],
      },
    });

    expect(failed?.get("docs/private.md")).toBe("hidden-segment");
    expect(failed?.get("docs/missing.md")).toBe("missing");
  });
});

describe("ChatView extra DOM branches", () => {
  it("supports cancel and blank-save rename branches", async () => {
    const { ChatView } = await import("../chat-view.js");
    const { container, root } = await renderDom(<ChatView agentId="agent-1" chatId="chat-1" />);

    await waitForText(container, "Launch planning");
    await click(buttonByTitle(container, "Click to rename"));
    const firstInput = container.querySelector<HTMLInputElement>("input");
    if (!firstInput) throw new Error("Rename input missing");
    await act(async () => {
      firstInput.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    });
    await flush();
    expect(chatMocks.renameChat).not.toHaveBeenCalled();
    expect(buttonByTitle(container, "Click to rename")).not.toBeNull();

    await click(buttonByTitle(container, "Click to rename"));
    const secondInput = container.querySelector<HTMLInputElement>("input");
    if (!secondInput) throw new Error("Rename input missing after reopening");
    await setValue(secondInput, "   ");
    await click(buttonByTitle(container, "Save"));
    await waitForCondition(() => chatMocks.renameChat.mock.calls.length === 1, "Expected blank rename commit");
    expect(chatMocks.renameChat).toHaveBeenCalledWith("chat-1", null);

    await act(async () => root.unmount());
  });

  it("updates only the persisted chat title across list caches without changing row order", async () => {
    const { ChatView } = await import("../chat-view.js");
    const renamedDetail = chatDetail({ topic: "Renamed launch", title: "Renamed launch" });
    chatMocks.renameChat.mockResolvedValueOnce(renamedDetail);

    const otherBefore = meChatRow({
      chatId: "chat-before",
      title: "Earlier chat",
      activityAt: "2026-05-28T12:02:00.000Z",
    });
    const renamedRow = meChatRow({
      chatId: "chat-1",
      title: "Launch planning",
      activityAt: "2026-05-28T12:01:00.000Z",
      pinnedAt: "2026-05-28T12:03:00.000Z",
    });
    const otherAfter = meChatRow({
      chatId: "chat-after",
      title: "Later chat",
      activityAt: "2026-05-28T12:00:00.000Z",
    });
    const rows = [otherBefore, renamedRow, otherAfter];
    const desktopKey = ["me", "chats", "all", "active", false, null, null] as const;
    const paletteKey = ["me", "chats", "palette"] as const;
    const desktop: InfiniteData<ListMeChatsResponse> = {
      pages: [
        {
          rows,
          priorityRows: { pinned: [renamedRow] },
          nextCursor: null,
        },
      ],
      pageParams: [undefined],
    };
    const palette: ListMeChatsResponse = {
      rows,
      priorityRows: { pinned: [] },
      nextCursor: null,
    };

    const { container, queryClient, root } = await renderDom(
      <ChatView agentId="agent-1" chatId="chat-1" />,
      (client) => {
        client.setQueryData(desktopKey, desktop);
        client.setQueryData(paletteKey, palette);
      },
    );

    await waitForText(container, "Launch planning");
    chatMocks.getChat.mockResolvedValue(renamedDetail);
    await click(buttonByTitle(container, "Click to rename"));
    const input = container.querySelector<HTMLInputElement>("input");
    if (!input) throw new Error("Rename input missing");
    await setValue(input, "Renamed launch");
    await click(buttonByTitle(container, "Save"));

    await waitForCondition(
      () => buttonByTitle(container, "Click to rename")?.textContent?.includes("Renamed launch") === true,
      "Expected the detail title to update after the persisted rename",
    );
    const patchedDesktop = queryClient.getQueryData<InfiniteData<ListMeChatsResponse>>(desktopKey);
    const patchedRows = patchedDesktop?.pages[0]?.rows ?? [];
    expect(patchedRows.map((row) => row.chatId)).toEqual(["chat-before", "chat-1", "chat-after"]);
    expect(patchedRows.find((row) => row.chatId === "chat-1")).toMatchObject({
      topic: "Renamed launch",
      title: "Renamed launch",
      activityAt: "2026-05-28T12:01:00.000Z",
    });
    expect(patchedRows.find((row) => row.chatId === "chat-before")).toBe(otherBefore);
    expect(patchedRows.find((row) => row.chatId === "chat-after")).toBe(otherAfter);
    expect(patchedDesktop?.pages[0]?.priorityRows.pinned[0]).toMatchObject({
      chatId: "chat-1",
      title: "Renamed launch",
    });
    expect(queryClient.getQueryData<ListMeChatsResponse>(paletteKey)?.rows.map((row) => row.title)).toEqual([
      "Earlier chat",
      "Renamed launch",
      "Later chat",
    ]);

    await act(async () => root.unmount());
  });

  it("keeps list titles unchanged and shows the failure when rename persistence fails", async () => {
    const { ChatView } = await import("../chat-view.js");
    chatMocks.renameChat.mockRejectedValueOnce(new Error("rename failed"));
    const originalRow = meChatRow({ chatId: "chat-1", title: "Launch planning" });
    const listKey = ["me", "chats", "all", "active", false, null, null] as const;
    const originalCache: InfiniteData<ListMeChatsResponse> = {
      pages: [
        {
          rows: [originalRow],
          priorityRows: { pinned: [] },
          nextCursor: null,
        },
      ],
      pageParams: [undefined],
    };
    const { container, queryClient, root } = await renderDom(<ChatView agentId="agent-1" chatId="chat-1" />, (client) =>
      client.setQueryData(listKey, originalCache),
    );

    await waitForText(container, "Launch planning");
    await click(buttonByTitle(container, "Click to rename"));
    const input = container.querySelector<HTMLInputElement>("input");
    if (!input) throw new Error("Rename input missing");
    await setValue(input, "Unsaved title");
    await click(buttonByTitle(container, "Save"));

    await waitForText(container, "Couldn't rename chat");
    expect(container.textContent).toContain("rename failed");
    expect(input.value).toBe("Unsaved title");
    expect(buttonByTitle(container, "Save")).not.toBeNull();
    expect(queryClient.getQueryData(listKey)).toBe(originalCache);
    expect(queryClient.getQueryData<ChatDetail>(["chat-detail", "chat-1"])?.title).toBe("Launch planning");

    await act(async () => root.unmount());
  });

  it("replaces an attachment preview with the chat details sidebar from the header toggle", async () => {
    const { ChatView } = await import("../chat-view.js");
    localStorage.setItem("first-tree:chat-right-sidebar:open:v1", "1");
    const route = `/?docChat=chat-1&docMsg=msg-doc&docAttachment=${DOC_ATTACHMENT_ID}&docAgent=agent-1&docPath=docs%2Fplan.md`;
    const { container, root } = await renderDom(<ChatView agentId="agent-1" chatId="chat-1" />, undefined, route);

    await waitForText(container, "Launch planning");
    await flush();
    expect(container.textContent).not.toContain("Participants ·");

    await click(container.querySelector('button[aria-label="Show chat details"]'));
    await waitForText(container, "Participants · 3");
    expect(locationParams(container).get("docChat")).toBeNull();
    expect(locationParams(container).get("docAttachment")).toBeNull();
    expect(locationParams(container).get("docAgent")).toBeNull();
    expect(locationParams(container).get("docPath")).toBeNull();

    await act(async () => root.unmount());
  });

  it("seeds doc-preview query data when an attachment link is opened", async () => {
    const { ChatView, docAttachmentRefQueryKey, docMessageAttachmentRefsQueryKey } = await import("../chat-view.js");
    const docMessage = message({
      id: "msg-doc",
      senderId: "agent-1",
      source: "api",
      content: `Open [the captured doc](attachment:${DOC_ATTACHMENT_ID}) now.`,
      metadata: {
        attachments: [
          {
            attachmentId: DOC_ATTACHMENT_ID,
            kind: "document",
            mimeType: "text/markdown",
            filename: "plan.md",
            size: 21,
            sha256: "a".repeat(64),
            source: { path: "docs/plan.md" },
          },
        ],
      },
    });
    const { container, queryClient, root } = await renderDom(<ChatView agentId="agent-1" chatId="chat-1" />, (client) =>
      seedChat(client, chatDetail(), messages([docMessage])),
    );

    await waitForText(container, "the captured doc");
    const link = container.querySelector<HTMLAnchorElement>(`a[href="attachment:${DOC_ATTACHMENT_ID}"]`);
    await click(link);

    expect(locationParams(container).get("docChat")).toBe("chat-1");
    expect(locationParams(container).get("docMsg")).toBe("msg-doc");
    expect(locationParams(container).get("docAttachment")).toBe(DOC_ATTACHMENT_ID);
    expect(queryClient.getQueryData(docAttachmentRefQueryKey(DOC_ATTACHMENT_ID))).toMatchObject({
      attachmentId: DOC_ATTACHMENT_ID,
      filename: "plan.md",
    });
    expect(queryClient.getQueryData(docMessageAttachmentRefsQueryKey("msg-doc"))).toEqual([
      expect.objectContaining({ attachmentId: DOC_ATTACHMENT_ID }),
    ]);

    await act(async () => root.unmount());
  });

  it("renders image fallbacks and read receipts without the retired final-text visibility toggle", async () => {
    const { ChatView } = await import("../chat-view.js");
    attachmentMocks.fetchAttachmentBase64.mockRejectedValueOnce(new Error("deleted"));
    const page = messages([
      message({
        id: "msg-self-sent",
        senderId: "human-agent-self",
        content: "Sent receipt branch",
        deliveryStatus: "sent",
      }),
      message({
        id: "msg-self-delivered",
        senderId: "human-agent-self",
        content: "Delivered receipt branch",
        createdAt: "2026-05-28T12:01:00.000Z",
        deliveryStatus: "delivered",
      }),
      message({
        id: "msg-image-miss",
        senderId: "agent-1",
        format: "file",
        content: { imageId: IMAGE_ID, mimeType: "image/png", filename: "missing.png", size: 3 },
        source: "api",
        createdAt: "2026-05-28T12:02:00.000Z",
      }),
      message({
        id: "msg-final",
        senderId: "agent-1",
        content: "Persisted agent final text remains visible",
        metadata: { [AGENT_FINAL_TEXT_METADATA_KEY]: true },
        source: "api",
        createdAt: "2026-05-28T12:03:00.000Z",
      }),
    ]);
    const { container, root } = await renderDom(<ChatView agentId="agent-1" chatId="chat-1" />, (client) =>
      seedChat(client, chatDetail(), page),
    );

    await waitForText(container, "Sent receipt branch");
    expect(container.textContent).toContain("✓ sent");
    expect(container.textContent).toContain("✓✓");
    await waitForText(container, '[Image "missing.png" failed to load]');
    await waitForText(container, "Persisted agent final text remains visible");
    expect(container.querySelector('button[aria-label$="agent final messages"]')).toBeNull();

    await act(async () => root.unmount());
  });

  it("renders an explicit expired note for a server-reclaimed image (404)", async () => {
    const { ChatView } = await import("../chat-view.js");
    const { ApiError } = await import("../../../../api/client.js");
    attachmentMocks.fetchAttachmentBase64.mockRejectedValueOnce(new ApiError(404, "Not Found"));
    const page = messages([
      message({
        id: "msg-image-expired",
        senderId: "agent-1",
        format: "file",
        content: { imageId: IMAGE_ID, mimeType: "image/png", filename: "expired.png", size: 3 },
        source: "api",
        createdAt: "2026-05-28T12:02:00.000Z",
      }),
    ]);
    const { container, root } = await renderDom(<ChatView agentId="agent-1" chatId="chat-1" />, (client) =>
      seedChat(client, chatDetail(), page),
    );

    await waitForText(
      container,
      '[Image "expired.png" expired or unavailable — Cloud message attachments are retained for 14 days]',
    );

    await act(async () => root.unmount());
  });

  it("splits file-chip download failures: 404 marks expired, other errors toast", async () => {
    const { ChatView } = await import("../chat-view.js");
    const { ApiError } = await import("../../../../api/client.js");
    const fileRef = (id: string, filename: string) => ({
      attachmentId: id,
      kind: "file" as const,
      mimeType: "text/csv",
      filename,
      size: 12,
    });
    const page = messages([
      message({
        id: "msg-file-expired",
        senderId: "agent-1",
        content: "expired file",
        metadata: { attachments: [fileRef("44444444-4444-4444-8444-444444444444", "expired.csv")] },
        source: "api",
        createdAt: "2026-05-28T12:02:00.000Z",
      }),
      message({
        id: "msg-file-flaky",
        senderId: "agent-1",
        content: "flaky file",
        metadata: { attachments: [fileRef("55555555-5555-4555-8555-555555555555", "flaky.csv")] },
        source: "api",
        createdAt: "2026-05-28T12:03:00.000Z",
      }),
    ]);
    attachmentMocks.downloadAttachment.mockImplementation(async (id: string) => {
      throw id === "44444444-4444-4444-8444-444444444444"
        ? new ApiError(404, "Not Found")
        : new ApiError(500, "Server Error");
    });
    const { container, root } = await renderDom(<ChatView agentId="agent-1" chatId="chat-1" />, (client) =>
      seedChat(client, chatDetail(), page),
    );

    // 404 → the chip disables, switches to its error state, and exposes the
    // retention note through aria-label + tooltip. No toast for an expected
    // expiry.
    const expiredButton = container.querySelector('button[aria-label="Download expired.csv"]');
    await click(expiredButton);
    await waitForCondition(() => {
      const button = container.querySelector<HTMLButtonElement>('button:disabled[aria-label^="expired.csv"]');
      return button?.getAttribute("aria-label")?.includes("no longer available") ?? false;
    }, "expected the chip to disable with the no-longer-available aria-label");
    expect(
      container.querySelector(
        '[title="Attachment expired or unavailable (Cloud message attachments are retained for 14 days)."]',
      ),
    ).not.toBeNull();
    expect(container.textContent).not.toContain("Download failed");

    // A second activation attempt cannot fire another download.
    const disabledButton = container.querySelector('button:disabled[aria-label^="expired.csv"]');
    await click(disabledButton);
    expect(
      attachmentMocks.downloadAttachment.mock.calls.filter(
        (call: unknown[]) => call[0] === "44444444-4444-4444-8444-444444444444",
      ),
    ).toHaveLength(1);

    // 5xx → ordinary failure toast; the chip stays downloadable (not gone).
    const flakyButton = container.querySelector('button[aria-label="Download flaky.csv"]');
    await click(flakyButton);
    await waitForText(container, "Download failed");
    expect(container.textContent).toContain('"flaky.csv"');
    expect(container.querySelector('button:not(:disabled)[aria-label="Download flaky.csv"]')).not.toBeNull();

    await act(async () => root.unmount());
  });

  it("renders a disabled joining panel for read-only watchers", async () => {
    const { ChatView } = await import("../chat-view.js");
    const onJoin = vi.fn();
    const { container, root } = await renderDom(
      <ChatView agentId="agent-1" chatId="chat-1" readOnly joinAction={{ joining: true, error: null, onJoin }} />,
    );

    await waitForText(container, "You're watching this chat");
    const joinButton = buttonByText(container, "Joining…");
    expect(joinButton?.disabled).toBe(true);
    expect(container.querySelector("textarea")).toBeNull();
    expect(container.querySelector('button[aria-label="Add participant"]')).toBeNull();

    await click(joinButton);
    expect(onJoin).not.toHaveBeenCalled();

    await act(async () => root.unmount());
  });
});
