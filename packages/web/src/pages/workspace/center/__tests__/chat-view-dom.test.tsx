// @vitest-environment happy-dom

import {
  type Agent,
  type ChatDetail,
  type ChatParticipantDetail,
  encodeProviderRetryEventMessage,
  FIRST_CHAT_ORIENTATION_CHAT_STATES,
  FIRST_CHAT_ORIENTATION_METADATA_KEY,
  withFirstChatOrientationChatState,
} from "@first-tree/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, type ReactElement, useLayoutEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter, useLocation, useSearchParams } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HubClient } from "../../../../api/activity.js";
import type { MessageWithDelivery, PaginatedMessages } from "../../../../api/chats.js";
import type { ChatSessionEventsResponse, SessionEventRow } from "../../../../api/sessions.js";
import { agentSessionsQueryKey } from "../../../../api/sessions.js";
import { ToastProvider } from "../../../../components/ui/toast.js";
import { chatDraftScope, loadDraft, saveDraft } from "../../../../lib/draft-store.js";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const activityMocks = vi.hoisted(() => ({
  listClients: vi.fn(),
  getClient: vi.fn(),
  startRuntimeAuth: vi.fn(),
}));

const markdownMocks = vi.hoisted(() => ({
  render: vi.fn(),
}));

const agentStatusMocks = vi.hoisted(() => ({
  fetchChatAgentStatuses: vi.fn(),
}));

const agentMocks = vi.hoisted(() => ({
  getAgentSkills: vi.fn(),
  listAgents: vi.fn(),
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
  listChatMessages: vi.fn(),
  listChatOpenRequests: vi.fn(),
  listRequestThread: vi.fn(),
  patchChatEngagement: vi.fn(),
  readFileAsBase64: vi.fn(),
  renameChat: vi.fn(),
  sendAskAgentQuestion: vi.fn(),
  sendChatMessage: vi.fn(),
  sendFileMessageBatch: vi.fn(),
}));

const imageStoreMocks = vi.hoisted(() => ({
  getImage: vi.fn(),
  putImage: vi.fn(),
}));

const meChatMocks = vi.hoisted(() => ({
  addMeChatParticipants: vi.fn(),
  listNeedYouRequests: vi.fn(),
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
    organizationId: "org-1",
    role: "admin",
  },
}));

vi.mock("../../../../api/activity.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../../api/activity.js")>()),
  listClients: activityMocks.listClients,
  getClient: activityMocks.getClient,
  startRuntimeAuth: activityMocks.startRuntimeAuth,
}));

vi.mock("../../../../api/agent-status.js", () => ({
  chatAgentStatusQueryKey: (chatId: string) => ["chat-agent-status", chatId] as const,
  fetchChatAgentStatuses: agentStatusMocks.fetchChatAgentStatuses,
}));

vi.mock("../../../../api/agents.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../../api/agents.js")>()),
  getAgentSkills: agentMocks.getAgentSkills,
  listAgents: agentMocks.listAgents,
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

vi.mock("../../../../api/me-chats.js", () => meChatMocks);

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

vi.mock("../../../../components/ui/markdown.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../../components/ui/markdown.js")>();
  return {
    ...actual,
    Markdown: (props: import("../../../../components/ui/markdown.js").MarkdownProps) => {
      markdownMocks.render(props.children);
      return actual.Markdown(props);
    },
  };
});

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

const AGENT_NAMES: Record<string, string> = {
  "agent-1": "Nova",
  "agent-2": "Design Critique",
  "human-agent-self": "Gandy",
  "human-agent-alice": "Alice",
};

const AGENT_SLUGS: Record<string, string> = {
  "agent-1": "nova",
  "agent-2": "design",
  "human-agent-self": "gandy",
  "human-agent-alice": "alice",
};

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
  // A teammate's agent pinned to a computer the caller does NOT own — its
  // `clientId` is absent from `listClients()` (the caller's `/me/clients`).
  agent({
    uuid: "agent-teammate",
    name: "teammate",
    displayName: "Teammate Agent",
    managerId: "member-alice",
    clientId: "client-teammate",
  }),
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
  participant({ agentId: "human-agent-alice", type: "human", name: "alice", displayName: "Alice" }),
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

function message(overrides: Partial<MessageWithDelivery> & { id: string; senderId: string }): MessageWithDelivery {
  return {
    id: overrides.id,
    chatId: overrides.chatId ?? "chat-1",
    senderId: overrides.senderId,
    senderKind: overrides.senderKind ?? "member",
    senderProvider: overrides.senderProvider ?? null,
    format: overrides.format ?? "text",
    content: overrides.content ?? "Please review docs/plan.md and @nova.",
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

function teamSkillResourceRow(overrides: { mode?: string; resourceId?: string | null; payload?: unknown } = {}) {
  return {
    id: "row-1",
    bindingId: null,
    resourceId: overrides.resourceId === undefined ? "res-1" : overrides.resourceId,
    replacesResourceId: null,
    type: "skill",
    name: "Team Skill",
    scope: "team",
    source: "team_recommended",
    mode: overrides.mode ?? "enabled",
    defaultEnabled: "recommended",
    payload:
      overrides.payload !== undefined
        ? overrides.payload
        : { name: "Code Review", description: "Review a change end to end.", body: "b" },
    repo: null,
    promptBody: null,
    unavailableReason: null,
    originTemplateId: null,
    order: 0,
  };
}

const BASE_MESSAGES = messages([
  message({
    id: "msg-1",
    senderId: "human-agent-self",
    createdAt: "2026-05-28T11:55:00.000Z",
    metadata: {
      mentions: ["agent-1"],
      attachments: [
        {
          attachmentId: "00000000-0000-4000-8000-000000000001",
          kind: "document",
          mimeType: "text/markdown",
          filename: "plan.md",
          size: 21,
          sha256: "a".repeat(64),
          source: { path: "docs/plan.md" },
        },
      ],
      documentContext: {
        kind: "snapshot",
        failedMentions: [{ raw: "secrets.env", reason: "hidden-segment" }],
      },
    },
  }),
  message({
    id: "msg-2",
    senderId: "agent-1",
    content: "I found one rollout risk in docs/plan.md and secrets.env.",
    source: "api",
    createdAt: "2026-05-28T11:56:00.000Z",
    deliveryStatus: "acked",
    metadata: {
      attachments: [
        {
          attachmentId: "00000000-0000-4000-8000-000000000001",
          kind: "document",
          mimeType: "text/markdown",
          filename: "plan.md",
          size: 21,
          sha256: "a".repeat(64),
          source: { path: "docs/plan.md" },
        },
      ],
      documentContext: {
        kind: "snapshot",
        failedMentions: [{ raw: "secrets.env", reason: "hidden-segment" }],
      },
    },
  }),
  message({
    id: "msg-3",
    senderId: "agent-2",
    format: "file",
    content: {
      caption: "Preview image for @nova.",
      attachments: [{ imageId: "image-1", mimeType: "image/png", filename: "preview.png", size: 42 }],
    },
    source: "api",
    createdAt: "2026-05-28T11:57:00.000Z",
  }),
  message({
    id: "msg-4",
    senderId: "agent-1",
    format: "card",
    content: { unsupported: true },
    source: "api",
    createdAt: "2026-05-28T11:58:00.000Z",
  }),
]);

const SESSION_EVENTS: { items: SessionEventRow[]; nextCursor: number | null } = {
  items: [
    {
      id: "event-1",
      agentId: "agent-1",
      chatId: "chat-1",
      seq: 1,
      kind: "tool_call",
      payload: { toolUseId: "tool-1", name: "Bash", args: { cmd: "pnpm test" }, status: "pending" },
      createdAt: "2026-05-28T11:56:10.000Z",
    },
    {
      id: "event-2",
      agentId: "agent-1",
      chatId: "chat-1",
      seq: 2,
      kind: "assistant_text",
      payload: { text: "Checking the rollout path now." },
      createdAt: "2026-05-28T11:56:20.000Z",
    },
    {
      id: "event-3",
      agentId: "agent-1",
      chatId: "chat-1",
      seq: 3,
      kind: "error",
      payload: { source: "runtime", message: "Example recoverable runtime error" },
      createdAt: "2026-05-28T11:56:30.000Z",
    },
    {
      id: "event-4",
      agentId: "agent-1",
      chatId: "chat-1",
      seq: 4,
      kind: "token_usage",
      payload: { inputTokens: 100, outputTokens: 25, totalTokens: 125 },
      createdAt: "2026-05-28T11:56:40.000Z",
    },
  ],
  nextCursor: null,
};

function chatSessionEvents(
  ...feeds: Array<{
    agentId: string;
    events: { items: SessionEventRow[]; nextCursor: number | null };
  }>
): ChatSessionEventsResponse {
  return {
    feeds: feeds.map(({ agentId, events }) => ({ agentId, ...events })),
  };
}

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
  queryClient.setQueryData(["gitlab-connections", "org-1"], []);
  queryClient.setQueryData(
    ["chat-agent-status", "chat-1"],
    [
      {
        agentId: "agent-1",
        main: "working",
        reachable: true,
        engagement: "active",
        working: true,
        needsYou: false,
        errored: false,
        teamSkillInvocationSupported: true,
        activity: {
          agentId: "agent-1",
          kind: "assistant_text",
          label: "Thinking",
          detail: "Checking the rollout path.",
          startedAt: NOW,
          turnText: "Checking the rollout path.",
        },
      },
      {
        agentId: "agent-2",
        main: "ready",
        reachable: true,
        engagement: "active",
        working: false,
        needsYou: false,
        errored: false,
        teamSkillInvocationSupported: true,
        activity: null,
      },
    ],
  );
  queryClient.setQueryData(["chat-right-sidebar", "github-entities", "chat-1"], {
    items: [
      {
        entityType: "pull_request",
        entityKey: "acme/web#42",
        htmlUrl: "https://github.com/acme/web/pull/42",
        title: "Release checklist",
        state: "open",
        boundVia: "direct",
      },
    ],
  });
  queryClient.setQueryData(agentSessionsQueryKey("agent-1"), []);
  return queryClient;
}

function seedChat(
  queryClient: QueryClient,
  detail: ChatDetail = chatDetail(),
  page: PaginatedMessages = BASE_MESSAGES,
) {
  queryClient.setQueryData(["chat-detail", detail.id], detail);
  queryClient.setQueryData(["chat-messages-cache", detail.id], page.items.slice(0, 1));
  queryClient.setQueryData(["chat-messages", detail.id], page);
  queryClient.setQueryData(
    ["chat-session-events", detail.id],
    chatSessionEvents({ agentId: "agent-1", events: SESSION_EVENTS }),
  );
  queryClient.setQueryData(["chat-read-state", detail.id], {
    chatId: detail.id,
    bottomVisibleMessageId: "msg-1",
    latestKnownMessageId: "msg-1",
    updatedAt: Date.now(),
  });
}

async function renderDom(
  element: ReactElement,
  seed?: (queryClient: QueryClient) => void,
  route = "/?docChat=chat-1&docMsg=msg-1&docAttachment=00000000-0000-4000-8000-000000000001",
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

function dispatchCopy(target: Element): { event: Event; payloads: Map<string, string> } {
  const payloads = new Map<string, string>();
  const event = new Event("copy", { bubbles: true, cancelable: true });
  Object.defineProperty(event, "clipboardData", {
    configurable: true,
    value: { setData: (type: string, value: string) => payloads.set(type, value) },
  });
  target.dispatchEvent(event);
  return { event, payloads };
}

async function changeFiles(element: HTMLInputElement, files: File[]): Promise<void> {
  Object.defineProperty(element, "files", { configurable: true, value: files });
  await act(async () => {
    element.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await flush();
}

function buttonByTitle(container: ParentNode, title: string): HTMLButtonElement | null {
  return container.querySelector<HTMLButtonElement>(`button[title="${title}"]`);
}

function LocationProbe() {
  const location = useLocation();
  return <div data-testid="loc">{location.pathname + location.search}</div>;
}

function locText(container: ParentNode): string | null {
  return container.querySelector('[data-testid="loc"]')?.textContent ?? null;
}

function buttonByText(container: ParentNode, text: string): HTMLButtonElement | null {
  return [...container.querySelectorAll("button")].find((button) => button.textContent?.trim() === text) ?? null;
}

/** The AskTakeover overlay's option button (role radio/checkbox) containing `text`. */
function askOption(container: ParentNode, text: string): HTMLButtonElement | null {
  return (
    [...container.querySelectorAll<HTMLButtonElement>('[role="radio"],[role="checkbox"]')].find((b) =>
      b.textContent?.includes(text),
    ) ?? null
  );
}

/** The AskTakeover overlay's free-text answer textarea (Other, or the pure free-text box). */
function askTextarea(container: ParentNode): HTMLTextAreaElement | null {
  return container.querySelector<HTMLTextAreaElement>(
    'textarea[placeholder^="Type your answer"], textarea[placeholder^="Other"]',
  );
}

beforeEach(() => {
  installBrowserStubs();
  document.body.innerHTML = "";
  vi.clearAllMocks();
  authMock.value = {
    agentId: "human-agent-self",
    memberId: "member-self",
    organizationId: "org-1",
    role: "admin",
  };
  activityMocks.listClients.mockResolvedValue([
    {
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
    } satisfies HubClient,
  ]);
  activityMocks.getClient.mockResolvedValue({
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
  } satisfies HubClient);
  activityMocks.startRuntimeAuth.mockResolvedValue({ ref: "auth-ref", started: true });
  agentStatusMocks.fetchChatAgentStatuses.mockResolvedValue([
    {
      agentId: "agent-1",
      main: "working",
      reachable: true,
      engagement: "active",
      working: true,
      needsYou: false,
      errored: false,
      // Default: the recipient's client parses the server-owned Team Skill
      // invocation marker, so the slash menu may offer Team Skills. Gate
      // tests override this per case.
      teamSkillInvocationSupported: true,
      activity: {
        agentId: "agent-1",
        kind: "assistant_text",
        label: "Thinking",
        detail: "Checking the rollout path.",
        startedAt: NOW,
        turnText: "Checking the rollout path.",
      },
    },
    {
      agentId: "agent-2",
      main: "ready",
      reachable: true,
      engagement: "active",
      working: false,
      needsYou: false,
      errored: false,
      teamSkillInvocationSupported: true,
      activity: null,
    },
  ]);
  agentMocks.getAgentSkills.mockResolvedValue({ skills: [{ name: "review", description: "Review a patch." }] });
  agentResourceMocks.getAgentResources.mockResolvedValue({
    effective: { version: 1, repos: [], prompts: [], skills: [], mcp: [], unavailable: [] },
  });
  agentMocks.listAgents.mockResolvedValue({ items: ORG_AGENTS, nextCursor: null });
  attachmentMocks.fetchAttachmentBase64.mockResolvedValue({ base64: "image-base64", mimeType: "image/png" });
  attachmentMocks.uploadAttachment.mockResolvedValue({ id: "uploaded-image", mimeType: "image/png", size: 42 });
  attachmentMocks.uploadImageAttachment.mockImplementation((file: File) => attachmentMocks.uploadAttachment(file));
  chatMocks.getChat.mockResolvedValue(chatDetail());
  chatMocks.getChatTokenUsage.mockResolvedValue({
    inputTokens: 0,
    cachedInputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
  });
  chatMocks.listChatMessages.mockResolvedValue(BASE_MESSAGES);
  chatMocks.listChatOpenRequests.mockResolvedValue({ items: [] });
  chatMocks.listRequestThread.mockResolvedValue({ items: [] });
  chatMocks.patchChatEngagement.mockResolvedValue({ chatId: "chat-1", engagementStatus: "active" });
  chatMocks.readFileAsBase64.mockResolvedValue("image-base64");
  chatMocks.renameChat.mockResolvedValue({ id: "chat-1", topic: "Renamed launch" });
  chatMocks.sendAskAgentQuestion.mockImplementation((chatId: string, requestId: string, content: string) =>
    Promise.resolve(
      message({
        id: "clarification-1",
        chatId,
        senderId: "human-agent-self",
        content,
        inReplyTo: requestId,
        metadata: { askAgent: { requestId, agentId: "agent-1" } },
        createdAt: "2026-05-28T12:00:30.000Z",
      }),
    ),
  );
  chatMocks.sendChatMessage.mockImplementation((chatId: string, content: string) =>
    Promise.resolve(
      message({
        id: "msg-sent",
        chatId,
        senderId: "human-agent-self",
        content,
        createdAt: "2026-05-28T12:01:00.000Z",
      }),
    ),
  );
  chatMocks.sendFileMessageBatch.mockImplementation((chatId: string, content: unknown) =>
    Promise.resolve(
      message({
        id: "msg-file",
        chatId,
        senderId: "human-agent-self",
        format: "file",
        content,
        createdAt: "2026-05-28T12:02:00.000Z",
      }),
    ),
  );
  imageStoreMocks.getImage.mockResolvedValue(null);
  imageStoreMocks.putImage.mockResolvedValue(undefined);
  meChatMocks.addMeChatParticipants.mockResolvedValue({ ok: true });
  meChatMocks.listNeedYouRequests.mockResolvedValue({ items: [], total: 0, nextCursor: null });
  readStateMocks.getReadState.mockResolvedValue(null);
  readStateMocks.setReadState.mockResolvedValue(undefined);
  sessionMocks.listSessionEvents.mockImplementation((requestedAgentId: string) =>
    Promise.resolve(
      requestedAgentId === "agent-1"
        ? SESSION_EVENTS
        : {
            items: [],
            nextCursor: null,
          },
    ),
  );
  sessionMocks.listChatSessionEvents.mockResolvedValue(
    chatSessionEvents({ agentId: "agent-1", events: SESSION_EVENTS }),
  );
  sessionMocks.listSessionOutputs.mockResolvedValue({ items: [], nextCursor: null });
});

afterEach(() => {
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

describe("ChatView", () => {
  it("renders the server-marked Orientation once and starts guidance with a visible user message", async () => {
    const { ChatView } = await import("../chat-view.js");
    const bootstrap = message({
      id: "orientation-bootstrap",
      senderId: "human-agent-self",
      content: "Design Critique, welcome aboard.\n\nPlease help me get started with First Tree.",
      metadata: {
        mentions: ["agent-2"],
        [FIRST_CHAT_ORIENTATION_METADATA_KEY]: { version: 1 },
      },
      source: "api",
      createdAt: "2026-05-28T11:55:00.000Z",
    });
    const orientationChat = chatDetail({
      participants: [
        participant({ agentId: "human-agent-self", type: "human", name: "gandy", displayName: "Gandy" }),
        participant({ agentId: "agent-2", name: "design", displayName: "Design Critique" }),
      ],
    });
    chatMocks.listChatMessages.mockResolvedValue(messages([bootstrap]));
    const { container, root } = await renderDom(
      <ChatView agentId="agent-2" chatId="chat-1" initialChatDetail={orientationChat} />,
      (queryClient) => seedChat(queryClient, orientationChat, messages([bootstrap])),
      "/",
    );

    await waitForText(container, "Start with Design Critique");
    const orientationRow = container.querySelector(
      '[data-onboarding-orientation-row][data-message-id="orientation-bootstrap"]',
    );
    expect(orientationRow).not.toBeNull();
    expect(orientationRow?.textContent).not.toContain("welcome aboard");
    expect(container.textContent).not.toContain("Design Critique, welcome aboard.");
    const composer = container.querySelector<HTMLTextAreaElement>("textarea");
    if (!composer) throw new Error("Composer textarea missing");
    expect(composer.placeholder).toBe("Message Design Critique anything — or start with the tour above");
    await setValue(composer, "A draft I still want to send");
    chatMocks.listChatMessages.mockResolvedValue(
      messages([
        bootstrap,
        message({
          id: "orientation-ready-message",
          senderId: "human-agent-self",
          content: "I'm ready — let's get started.",
          metadata: { mentions: ["agent-2"] },
          createdAt: "2026-05-28T11:56:00.000Z",
        }),
      ]),
    );
    const skipButton = buttonByText(container, "Skip intro");
    const startButton = buttonByText(container, "Start with Design Critique");
    if (!skipButton || !startButton) throw new Error("Orientation actions missing");
    // Both controls are visible at once. A fast double activation must still
    // produce only one continuation before React has time to disable them.
    await act(async () => {
      skipButton.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
      startButton.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    });
    await waitForCondition(() => chatMocks.sendChatMessage.mock.calls.length > 0, "Expected Orientation continuation");
    expect(chatMocks.sendChatMessage).toHaveBeenCalledWith("chat-1", "I'm ready — let's get started.", ["agent-2"]);
    expect(chatMocks.sendChatMessage).toHaveBeenCalledTimes(1);
    expect(composer.value).toBe("A draft I still want to send");
    await waitForText(container, "Watch");
    expect(container.querySelectorAll('[data-onboarding-orientation="pending"]')).toHaveLength(0);
    expect(composer.placeholder).not.toContain("tour above");

    await act(async () => root.unmount());
  });

  it("keeps the trusted Orientation bootstrap senderless for a later human viewer", async () => {
    authMock.value = {
      agentId: "human-agent-alice",
      memberId: "member-alice",
      organizationId: "org-1",
      role: "member",
    };
    const { ChatView } = await import("../chat-view.js");
    const bootstrap = message({
      id: "orientation-bootstrap-shared-view",
      senderId: "human-agent-self",
      content: "Design Critique, welcome aboard. Please help me get started with First Tree.",
      metadata: {
        mentions: ["agent-2"],
        [FIRST_CHAT_ORIENTATION_METADATA_KEY]: { version: 1 },
      },
      source: "api",
      createdAt: "2026-05-28T11:55:00.000Z",
    });
    const sharedChat = chatDetail({
      participants: [
        participant({ agentId: "human-agent-self", type: "human", name: "gandy", displayName: "Gandy" }),
        participant({ agentId: "human-agent-alice", type: "human", name: "alice", displayName: "Alice" }),
        participant({ agentId: "agent-2", name: "design", displayName: "Design Critique" }),
      ],
    });
    const page = messages([bootstrap]);
    chatMocks.listChatMessages.mockResolvedValue(page);
    const { container, root } = await renderDom(
      <ChatView agentId="agent-2" chatId="chat-1" initialChatDetail={sharedChat} />,
      (queryClient) => seedChat(queryClient, sharedChat, page),
      "/",
    );

    await waitForText(container, "First Tree introduction");
    expect(
      container.querySelector('[data-onboarding-orientation-row][data-message-id="orientation-bootstrap-shared-view"]'),
    ).not.toBeNull();
    expect(container.textContent).not.toContain("welcome aboard");
    expect(container.textContent).not.toContain("Start with Design Critique");
    expect(chatMocks.sendChatMessage).not.toHaveBeenCalled();

    await act(async () => root.unmount());
  });

  it("does not advertise a removed Orientation target in the composer", async () => {
    const { ChatView } = await import("../chat-view.js");
    const bootstrap = message({
      id: "orientation-bootstrap-removed-target",
      senderId: "human-agent-self",
      content: "Nova, welcome aboard.",
      metadata: {
        mentions: ["agent-1"],
        [FIRST_CHAT_ORIENTATION_METADATA_KEY]: { version: 1 },
      },
      source: "api",
      createdAt: "2026-05-28T11:55:00.000Z",
    });
    const targetRemovedChat = chatDetail({
      participants: [
        participant({ agentId: "human-agent-self", type: "human", name: "gandy", displayName: "Gandy" }),
        participant({ agentId: "agent-2", name: "design", displayName: "Design Critique" }),
      ],
    });
    const page = messages([bootstrap]);
    chatMocks.listChatMessages.mockResolvedValue(page);
    const { container, root } = await renderDom(
      <ChatView agentId="agent-1" chatId="chat-1" initialChatDetail={targetRemovedChat} />,
      (queryClient) => seedChat(queryClient, targetRemovedChat, page),
      "/",
    );

    await waitForText(container, "Start with Nova");
    const composer = container.querySelector<HTMLTextAreaElement>("textarea");
    if (!composer) throw new Error("Composer textarea missing");
    expect(composer.placeholder).not.toContain("tour above");

    await act(async () => root.unmount());
  });

  it("treats a later human message to the original target as optimistic completion", async () => {
    const { ChatView } = await import("../chat-view.js");
    const bootstrap = message({
      id: "orientation-bootstrap-completed",
      senderId: "human-agent-self",
      content: "Nova, welcome aboard.",
      metadata: {
        mentions: ["agent-1"],
        [FIRST_CHAT_ORIENTATION_METADATA_KEY]: { version: 1 },
      },
      source: "api",
      createdAt: "2026-05-28T11:55:00.000Z",
    });
    const directMessage = message({
      id: "orientation-direct-message",
      senderId: "human-agent-self",
      content: "Start by reading /projects/acme.",
      metadata: { mentions: ["agent-1"] },
      createdAt: "2026-05-28T11:56:00.000Z",
    });
    const page = messages([bootstrap, directMessage]);
    chatMocks.listChatMessages.mockResolvedValue(page);
    const { container, root } = await renderDom(
      <ChatView agentId="agent-1" chatId="chat-1" initialChatDetail={chatDetail()} />,
      (queryClient) => seedChat(queryClient, chatDetail(), page),
      "/",
    );

    await waitForText(container, "Watch");
    expect(container.textContent).toContain("Start by reading /projects/acme.");
    expect(container.textContent).not.toContain("Start with Nova");
    expect(chatMocks.sendChatMessage).not.toHaveBeenCalled();

    await act(async () => root.unmount());
  });

  it("keeps Orientation pending when a later human message targets another participant", async () => {
    const { ChatView } = await import("../chat-view.js");
    const bootstrap = message({
      id: "orientation-bootstrap-wrong-recipient",
      senderId: "human-agent-self",
      content: "Nova, welcome aboard.",
      metadata: {
        mentions: ["agent-1"],
        [FIRST_CHAT_ORIENTATION_METADATA_KEY]: { version: 1 },
      },
      source: "api",
      createdAt: "2026-05-28T11:55:00.000Z",
    });
    const messageToAnotherParticipant = message({
      id: "orientation-wrong-recipient-message",
      senderId: "human-agent-self",
      content: "Please inspect the deployment notes.",
      metadata: { mentions: ["agent-2"] },
      createdAt: "2026-05-28T11:56:00.000Z",
    });
    const page = messages([bootstrap, messageToAnotherParticipant]);
    chatMocks.listChatMessages.mockResolvedValue(page);
    const { container, root } = await renderDom(
      <ChatView agentId="agent-1" chatId="chat-1" initialChatDetail={chatDetail()} />,
      (queryClient) => seedChat(queryClient, chatDetail(), page),
      "/",
    );

    await waitForText(container, "Start with Nova");
    expect(container.querySelectorAll('[data-onboarding-orientation="pending"]')).toHaveLength(1);
    expect(container.textContent).not.toContain("First Tree introduction");
    expect(chatMocks.sendChatMessage).not.toHaveBeenCalled();

    await act(async () => root.unmount());
  });

  it("treats the server-owned continued lifecycle as complete without a later visible own message", async () => {
    const { ChatView } = await import("../chat-view.js");
    const bootstrap = message({
      id: "orientation-bootstrap-server-continued",
      senderId: "human-agent-self",
      content: "Nova, welcome aboard.",
      metadata: {
        mentions: ["agent-1"],
        [FIRST_CHAT_ORIENTATION_METADATA_KEY]: { version: 1 },
      },
      source: "api",
      createdAt: "2026-05-28T11:55:00.000Z",
    });
    const continuedChat = chatDetail({
      metadata: withFirstChatOrientationChatState({}, FIRST_CHAT_ORIENTATION_CHAT_STATES.CONTINUED),
    });
    const page = messages([bootstrap]);
    chatMocks.listChatMessages.mockResolvedValue(page);
    const { container, root } = await renderDom(
      <ChatView agentId="agent-1" chatId="chat-1" initialChatDetail={continuedChat} />,
      (queryClient) => seedChat(queryClient, continuedChat, page),
      "/",
    );

    await waitForText(container, "Watch");
    expect(container.textContent).not.toContain("Start with Nova");
    expect(chatMocks.sendChatMessage).not.toHaveBeenCalled();

    await act(async () => root.unmount());
  });

  it("hides Orientation chrome after a legacy retry owns the first wake", async () => {
    const { ChatView } = await import("../chat-view.js");
    const bootstrap = message({
      id: "orientation-bootstrap-legacy-started",
      senderId: "human-agent-self",
      content: "Nova, welcome aboard.",
      metadata: {
        mentions: ["agent-1"],
        [FIRST_CHAT_ORIENTATION_METADATA_KEY]: { version: 1 },
      },
      source: "api",
      createdAt: "2026-05-28T11:55:00.000Z",
    });
    const legacyStartedChat = chatDetail({
      metadata: withFirstChatOrientationChatState({}, FIRST_CHAT_ORIENTATION_CHAT_STATES.LEGACY_STARTED),
    });
    const page = messages([bootstrap]);
    chatMocks.listChatMessages.mockResolvedValue(page);
    const { container, root } = await renderDom(
      <ChatView agentId="agent-1" chatId="chat-1" initialChatDetail={legacyStartedChat} />,
      (queryClient) => seedChat(queryClient, legacyStartedChat, page),
      "/",
    );

    await waitForText(container, "Nova, welcome aboard.");
    expect(container.querySelector("[data-onboarding-orientation]")).toBeNull();

    await act(async () => root.unmount());
  });

  it("renders typed GitHub/GitLab header links only for anchored provider chats", async () => {
    const { ChatView } = await import("../chat-view.js");
    const cases = [
      {
        id: "chat-github-link",
        metadata: {
          source: "github",
          entityType: "pull_request",
          entityKey: "acme/web#42",
          entityUrl: "https://github.com/acme/web/pull/42",
        },
        title: "View on GitHub",
        href: "https://github.com/acme/web/pull/42",
      },
      {
        id: "chat-gitlab-link",
        metadata: {
          source: "gitlab",
          entityType: "pull_request",
          entityKey: "501:pull_request:42",
          entityUrl: "https://gitlab.internal/acme/web/-/merge_requests/42",
        },
        title: "View on GitLab",
        href: "https://gitlab.internal/acme/web/-/merge_requests/42",
      },
      {
        id: "chat-gitlab-no-url",
        metadata: {
          source: "gitlab",
          entityType: "pull_request",
          entityKey: "501:pull_request:43",
        },
        title: null,
        href: null,
      },
      { id: "chat-manual-link", metadata: {}, title: null, href: null },
    ] as const;

    for (const entry of cases) {
      const detail = chatDetail({
        id: entry.id,
        title: `Header ${entry.id}`,
        topic: `Header ${entry.id}`,
        metadata: entry.metadata,
      });
      const { container, root } = await renderDom(
        <ChatView agentId="agent-1" chatId={entry.id} initialChatDetail={detail} />,
        undefined,
        "/",
      );
      await waitForText(container, `Header ${entry.id}`);
      const link = entry.title ? container.querySelector<HTMLAnchorElement>(`a[title="${entry.title}"]`) : null;
      if (entry.href) {
        expect(link?.href).toBe(entry.href);
        expect(link?.target).toBe("_blank");
        expect(link?.rel).toBe("noopener noreferrer");
      } else {
        expect(container.querySelector('a[title^="View on "]')).toBeNull();
      }
      await act(async () => root.unmount());
    }
  });

  it("hides chat-management affordances on the trial surface even when read-only (route-scoped)", async () => {
    const { ChatView } = await import("../chat-view.js");
    // A persisted-open sidebar must NOT re-appear on the trial surface.
    localStorage.setItem("first-tree:chat-right-sidebar:open:v1", "1");
    // `isTrial` + `readOnly` together = the watcher branch of a `/quickstart`
    // chat. The trial-chrome guarantee is route-scoped, so the participant /
    // details cluster, the chat-details sidebar toggle, and rename must all be
    // gone here — `readOnly` alone would not hide them all (nor the hovercard).
    const { container, root } = await renderDom(
      <ChatView agentId="agent-1" chatId="chat-1" isTrial readOnly />,
      undefined,
      "/",
    );

    await waitForText(container, "Launch planning");

    expect(container.querySelector('button[aria-label="Add participant"]')).toBeNull();
    expect(container.querySelector('button[aria-label="Show chat details"]')).toBeNull();
    expect(container.querySelector('button[aria-label="Hide chat details"]')).toBeNull();
    expect(buttonByTitle(container, "Click to rename")).toBeNull();

    await act(async () => root.unmount());
  });

  it("uses matching initial chat detail without an immediate detail refetch", async () => {
    const { ChatView } = await import("../chat-view.js");
    const initialChatDetail = chatDetail({ title: "Initial detail title", topic: "Initial detail title" });

    const { container, root } = await renderDom(
      <ChatView agentId="agent-1" chatId="chat-1" initialChatDetail={initialChatDetail} />,
      (queryClient) => {
        queryClient.removeQueries({ queryKey: ["chat-detail", "chat-1"], exact: true });
      },
      "/",
    );

    await waitForText(container, "Initial detail title");
    expect(chatMocks.getChat).not.toHaveBeenCalled();

    await act(async () => root.unmount());
  });

  it("keeps full chat details on the generic narrow Workspace path", async () => {
    const { ChatView } = await import("../chat-view.js");
    localStorage.setItem("first-tree:chat-right-sidebar:open:v1", "1");
    const onShowConversations = vi.fn();
    const { container, root } = await renderDom(
      <ChatView agentId="agent-1" chatId="chat-1" narrow onShowConversations={onShowConversations} />,
      undefined,
      "/",
    );

    await waitForText(container, "Launch planning");
    await waitForText(container, "Example recoverable runtime error");
    await waitForText(container, "Preview image for");
    expect(container.querySelector<HTMLElement>("[data-error-header]")?.style.overflowWrap).toBe("anywhere");
    expect(container.querySelector<HTMLElement>("[data-error-message]")?.style.overflowWrap).toBe("anywhere");
    expect(container.querySelector('[data-mobile-chat-details-sheet="true"]')).toBeNull();
    expect(container.querySelector('aside[aria-label="Chat details"]')).not.toBeNull();
    expect(container.textContent).toContain("GitHub");
    expect(container.querySelector('button[aria-label$="Open participants."]')).toBeNull();
    expect(container.querySelector('button[aria-label="Show chat details"]')).toBeNull();
    expect(container.querySelector('button[aria-label="Hide agent final messages"]')).toBeNull();
    // Generic narrow Workspace keeps click-to-rename: it is gated on mobile
    // presentation, not viewport width, so resizing to the narrow breakpoint
    // does not drop the pre-existing rename affordance.
    expect(buttonByTitle(container, "Click to rename")).not.toBeNull();

    await click(container.querySelector('button[aria-label="Show conversations"]'));
    expect(onShowConversations).toHaveBeenCalledTimes(1);

    await click(container.querySelector('button[aria-label="Hide chat options"]'));
    expect(container.querySelector('aside[aria-label="Chat details"]')).toBeNull();

    await act(async () => root.unmount());
  });

  it("uses a mobile chat details sheet with participants and read-only GitHub follows", async () => {
    const { ChatView } = await import("../chat-view.js");
    localStorage.setItem("first-tree:chat-right-sidebar:open:v1", "1");
    const onShowConversations = vi.fn();
    const { container, root } = await renderDom(
      <ChatView
        agentId="agent-1"
        chatId="chat-1"
        narrow
        presentation="mobile"
        onShowConversations={onShowConversations}
      />,
      undefined,
      "/",
    );

    await waitForText(container, "Launch planning");
    expect(container.querySelector('[data-mobile-chat-details-sheet="true"]')).toBeNull();
    expect(container.querySelector('aside[aria-label="Chat details"]')).toBeNull();
    // Mobile presentation keeps the header context-only: no click-to-rename.
    expect(buttonByTitle(container, "Click to rename")).toBeNull();
    // Q4: mobile chat detail exits with a back arrow, not the hamburger.
    expect(container.querySelector('button[aria-label="Back to conversations"]')).not.toBeNull();
    expect(container.querySelector('button[aria-label="Show conversations"]')).toBeNull();

    await click(container.querySelector('button[aria-label="Show chat details"]'));
    await waitForText(container, "Participants · 4");
    expect(container.querySelector('[data-mobile-chat-details-sheet="true"]')).not.toBeNull();
    expect(container.querySelector('aside[aria-label="Chat details"]')).toBeNull();
    expect(container.textContent).toContain("Add");
    expect(container.textContent).toContain("GitHub");
    expect(container.textContent).toContain("Following in this chat");
    expect(container.textContent).toContain("Release checklist");
    expect(container.querySelector('[data-mobile-github-section="true"] a[target="_blank"]')).not.toBeNull();

    await click(container.querySelector('button[aria-label="Close chat details"]'));
    expect(container.querySelector('[data-mobile-chat-details-sheet="true"]')).toBeNull();

    await act(async () => root.unmount());
  });

  it("lands on the stored bottom-visible anchor on mobile open even when the chat has a summary", async () => {
    // Regression guard for the PR 1997 mobile Work surface: a summarized
    // chat must still land on the stored bottom-visible anchor (newer
    // messages surface via the pill) instead of jumping to the timeline
    // top to show the in-flow Current state card.
    const { ChatView } = await import("../chat-view.js");
    const summarized = chatDetail({ description: "Status: shipping the mobile Work surface soon." });
    chatMocks.getChat.mockResolvedValue(summarized);
    const { container, root } = await renderDom(
      <ChatView agentId="agent-1" chatId="chat-1" narrow presentation="mobile" onShowConversations={vi.fn()} />,
      (queryClient) => {
        seedChat(queryClient, summarized);
      },
      "/",
    );

    await waitForText(container, "Launch planning");
    const scrollIntoViewMock = HTMLElement.prototype.scrollIntoView as unknown as {
      mock: { calls: unknown[][] };
    };
    await waitForCondition(
      () =>
        scrollIntoViewMock.mock.calls.some((args) => (args[0] as ScrollIntoViewOptions | undefined)?.block === "end"),
      "Expected mobile open to land on the stored bottom-visible anchor",
    );

    await act(async () => root.unmount());
  });

  it("waits for the persisted read state before committing the chat-open landing", async () => {
    // PR 2017 review: with cached messages rendering first and the IDB
    // read-state lookup still in flight, the one-shot landing must NOT
    // commit the bottom fallback — otherwise a cold open permanently
    // misses the stored anchor.
    const { ChatView } = await import("../chat-view.js");
    let resolveReadState: (
      value: {
        chatId: string;
        bottomVisibleMessageId: string | null;
        latestKnownMessageId: string | null;
        updatedAt: number;
      } | null,
    ) => void = () => {
      throw new Error("getReadState was not called");
    };
    readStateMocks.getReadState.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveReadState = resolve;
        }),
    );
    const { container, root } = await renderDom(
      <ChatView agentId="agent-1" chatId="chat-1" narrow presentation="mobile" onShowConversations={vi.fn()} />,
      (queryClient) => {
        // Messages stay cached (they render immediately); the read-state
        // cache is dropped so the query hits the still-pending mock.
        queryClient.removeQueries({ queryKey: ["chat-read-state", "chat-1"] });
      },
      "/",
    );

    // Messages render while the read state is still pending: no landing
    // may fire yet (neither the anchor scroll nor the bottom fallback).
    await waitForText(container, "I found one rollout risk");
    const scrollIntoViewMock = HTMLElement.prototype.scrollIntoView as unknown as {
      mock: { calls: unknown[][] };
    };
    const scrollToMock = HTMLElement.prototype.scrollTo as unknown as {
      mock: { calls: unknown[][] };
    };
    await flush();
    await flush();
    expect(scrollIntoViewMock.mock.calls.length).toBe(0);
    expect(scrollToMock.mock.calls.some((args) => (args[0] as ScrollToOptions | undefined)?.behavior === "auto")).toBe(
      false,
    );

    // Once the persisted row resolves, the landing commits to its anchor.
    await act(async () => {
      resolveReadState({
        chatId: "chat-1",
        bottomVisibleMessageId: "msg-1",
        latestKnownMessageId: "msg-1",
        updatedAt: Date.now(),
      });
    });
    await waitForCondition(
      () =>
        scrollIntoViewMock.mock.calls.some((args) => (args[0] as ScrollIntoViewOptions | undefined)?.block === "end"),
      "Expected the landing to fire once the persisted read state resolved",
    );

    await act(async () => root.unmount());
  });

  it("falls back to the timeline bottom when the persisted read state has no row", async () => {
    const { ChatView } = await import("../chat-view.js");
    let resolveReadState: (value: null) => void = () => {
      throw new Error("getReadState was not called");
    };
    readStateMocks.getReadState.mockImplementation(
      () =>
        new Promise<null>((resolve) => {
          resolveReadState = resolve;
        }),
    );
    const { container, root } = await renderDom(
      <ChatView agentId="agent-1" chatId="chat-1" narrow presentation="mobile" onShowConversations={vi.fn()} />,
      (queryClient) => {
        queryClient.removeQueries({ queryKey: ["chat-read-state", "chat-1"] });
      },
      "/",
    );

    await waitForText(container, "I found one rollout risk");
    const scrollToMock = HTMLElement.prototype.scrollTo as unknown as {
      mock: { calls: unknown[][] };
    };
    await flush();
    expect(scrollToMock.mock.calls.some((args) => (args[0] as ScrollToOptions | undefined)?.behavior === "auto")).toBe(
      false,
    );

    // A resolved-but-empty row (first-time visit) still lands at the bottom.
    await act(async () => {
      resolveReadState(null);
    });
    await waitForCondition(
      () => scrollToMock.mock.calls.some((args) => (args[0] as ScrollToOptions | undefined)?.behavior === "auto"),
      "Expected the bottom fallback once the empty read state resolved",
    );

    await act(async () => root.unmount());
  });

  it("renders restore and read-only join states", async () => {
    const { ChatView } = await import("../chat-view.js");
    const deleted = chatDetail({ engagementStatus: "deleted", title: "Deleted launch" });
    chatMocks.getChat.mockResolvedValue(deleted);
    let deletedQueryClient: QueryClient | null = null;
    const deletedView = await renderDom(<ChatView agentId="agent-1" chatId="chat-1" />, (queryClient) => {
      deletedQueryClient = queryClient;
      seedChat(queryClient, deleted);
    });
    if (!deletedQueryClient) throw new Error("Missing deleted chat query client");
    const invalidateSpy = vi.spyOn(deletedQueryClient, "invalidateQueries");
    await waitForText(deletedView.container, "Restore");
    await click(buttonByText(deletedView.container, "Restore"));
    await waitForCondition(() => chatMocks.patchChatEngagement.mock.calls.length > 0, "Expected restore");
    expect(chatMocks.patchChatEngagement).toHaveBeenCalledWith("chat-1", "active");
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ["need-you"] });
    await act(async () => deletedView.root.unmount());

    const onJoin = vi.fn();
    const readOnly = await renderDom(
      <ChatView
        agentId="agent-1"
        chatId="chat-1"
        readOnly
        titleFallback="Fallback title"
        joinAction={{ error: "Join failed", joining: false, onJoin }}
      />,
    );
    await waitForText(readOnly.container, "watching");
    const readOnlyStatus = readOnly.container.querySelector("[data-compose-status-bar]");
    const readOnlyComposer = readOnly.container.querySelector(".composer-card");
    expect(readOnlyStatus).not.toBeNull();
    expect(readOnlyStatus?.nextElementSibling).toBe(readOnlyComposer);
    expect(readOnlyComposer?.getAttribute("style")).not.toContain("border-radius");
    await waitForText(readOnly.container, "Join failed");
    await click(buttonByText(readOnly.container, "Join to reply"));
    expect(onJoin).toHaveBeenCalledTimes(1);
    await act(async () => readOnly.root.unmount());
  });

  it("places token usage above the connected status and composer surfaces", async () => {
    const { ChatView } = await import("../chat-view.js");
    chatMocks.getChatTokenUsage.mockResolvedValue({
      inputTokens: 100,
      cachedInputTokens: 250,
      outputTokens: 50,
      totalTokens: 400,
    });
    const { container, root } = await renderDom(<ChatView agentId="agent-1" chatId="chat-1" />, (queryClient) => {
      queryClient.setQueryData(["chat-token-usage", "chat-1"], {
        inputTokens: 100,
        cachedInputTokens: 250,
        outputTokens: 50,
        totalTokens: 400,
      });
    });

    await waitForText(container, "400 processed tokens in this chat");
    const tokenUsage = container.querySelector<HTMLElement>('[title^="Processed 400"]');
    const statusSurface = container.querySelector<HTMLElement>("[data-compose-status-bar]");
    const composer = container.querySelector<HTMLElement>(".composer-card");
    expect(tokenUsage).not.toBeNull();
    expect(statusSurface).not.toBeNull();
    expect(composer).not.toBeNull();
    expect(tokenUsage?.compareDocumentPosition(statusSurface ?? document.body) ?? 0).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );
    expect(statusSurface?.compareDocumentPosition(composer ?? document.body) ?? 0).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );
    expect(statusSurface?.nextElementSibling).toBe(composer);

    await act(async () => root.unmount());
  });

  it("loads secondary-agent activity into the timeline so current-output links have evidence", async () => {
    const { ChatView } = await import("../chat-view.js");
    const secondaryEvents = {
      items: [
        {
          id: "event-agent-2",
          agentId: "agent-2",
          chatId: "chat-1",
          seq: 1,
          kind: "assistant_text" as const,
          payload: { text: "Reviewing the mobile interaction." },
          createdAt: "2026-05-28T11:59:00.000Z",
        },
      ],
      nextCursor: null,
    };
    const { container, root } = await renderDom(<ChatView agentId="agent-1" chatId="chat-1" />, (queryClient) => {
      queryClient.setQueryData(
        ["chat-session-events", "chat-1"],
        chatSessionEvents(
          { agentId: "agent-1", events: SESSION_EVENTS },
          { agentId: "agent-2", events: secondaryEvents },
        ),
      );
      queryClient.setQueryData(
        ["chat-agent-status", "chat-1"],
        [
          {
            agentId: "agent-1",
            main: "ready",
            reachable: true,
            engagement: "active",
            working: false,
            errored: false,
            activity: null,
          },
          {
            agentId: "agent-2",
            main: "working",
            reachable: true,
            engagement: "active",
            working: true,
            errored: false,
            activity: {
              agentId: "agent-2",
              kind: "assistant_text",
              label: "Writing",
              startedAt: NOW,
              turnText: "Reviewing the mobile interaction.",
            },
          },
        ],
      );
    });

    await waitForCondition(
      () => container.querySelector('[data-working-agent="agent-2"]') !== null,
      "Expected secondary agent timeline evidence",
    );
    await click(container.querySelector('button[aria-label^="Expand current agent output"]'));
    expect(container.querySelector('button[aria-label="View Design Critique in the timeline"]')).not.toBeNull();

    await act(async () => root.unmount());
  });

  it("keeps chat details open while current output expands and collapses inline", async () => {
    const { ChatView } = await import("../chat-view.js");
    const { container, root } = await renderDom(<ChatView agentId="agent-1" chatId="chat-1" />);

    await waitForCondition(
      () => container.querySelector('button[aria-label="Show chat details"]') !== null,
      "Expected chat details trigger",
    );
    await click(container.querySelector('button[aria-label="Show chat details"]'));
    await waitForCondition(
      () => container.querySelector('aside[aria-label="Chat details"]') !== null,
      "Expected chat details to be open",
    );
    const outputTrigger = container.querySelector('button[aria-label^="Expand current agent output"]');
    await click(outputTrigger);
    await waitForCondition(
      () => container.querySelector("[data-current-agent-output]") !== null,
      "Expected current output to expand",
    );
    expect(container.querySelector('aside[aria-label="Chat details"]')).not.toBeNull();

    await click(outputTrigger);
    expect(container.querySelector("[data-current-agent-output]")).toBeNull();
    expect(container.querySelector('aside[aria-label="Chat details"]')).not.toBeNull();

    await act(async () => root.unmount());
  });

  it("collapses current output on composer focus before the mention layer consumes Escape", async () => {
    const { ChatView } = await import("../chat-view.js");
    const { container, root } = await renderDom(<ChatView agentId="agent-1" chatId="chat-1" />);

    await click(container.querySelector('button[aria-label^="Expand current agent output"]'));
    await waitForCondition(
      () => container.querySelector("[data-current-agent-output]") !== null,
      "Expected current output to expand",
    );
    const textarea = container.querySelector<HTMLTextAreaElement>("textarea");
    if (!textarea) throw new Error("Composer textarea missing");
    await act(async () => textarea.focus());
    await flush();
    await waitForCondition(
      () => container.querySelector("[data-current-agent-output]") === null,
      "Expected composer focus to collapse current output",
    );
    await waitForCondition(
      () => container.querySelector('[role="listbox"][aria-label="Mention suggestions"]') !== null,
      "Expected mention suggestions to open after focus primed @",
    );

    await act(async () => {
      textarea.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    });
    await flush();

    expect(container.querySelector('[role="listbox"][aria-label="Mention suggestions"]')).toBeNull();
    expect(container.querySelector("[data-current-agent-output]")).toBeNull();
    expect(document.activeElement).toBe(textarea);

    await act(async () => root.unmount());
  });

  it("merges configured Team Skills into the slash menu next to the runtime catalog", async () => {
    const { ChatView } = await import("../chat-view.js");
    agentResourceMocks.getAgentResources.mockResolvedValue({
      version: 1,
      templateIds: [],
      adoptedTemplates: [],
      bindings: [],
      availableTeamResources: [],
      effective: {
        version: 1,
        repos: [],
        prompts: [],
        mcp: [],
        unavailable: [],
        skills: [
          teamSkillResourceRow({ resourceId: "res-code-review" }),
          teamSkillResourceRow({
            resourceId: "res-hidden",
            mode: "disabled",
            payload: { name: "Hidden Skill", description: "d", body: "b" },
          }),
          teamSkillResourceRow({ resourceId: "res-broken", payload: { name: "Missing Body", description: "d" } }),
        ],
      },
    });
    const direct = chatDetail({
      participants: [
        participant({ agentId: "human-agent-self", type: "human", name: "gandy", displayName: "Gandy" }),
        participant({ agentId: "agent-1", name: "nova", displayName: "Nova" }),
      ],
    });
    const { container, root } = await renderDom(
      <ChatView agentId="agent-1" chatId="chat-1" initialChatDetail={direct} />,
      (qc) => seedChat(qc, direct),
    );

    // The heavy resources catalog is NOT fetched on an ordinary chat
    // mount — only a legal slash trigger enables it.
    expect(agentResourceMocks.getAgentResources).not.toHaveBeenCalled();

    const textarea = container.querySelector<HTMLTextAreaElement>("textarea");
    if (!textarea) throw new Error("Composer textarea missing");
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
      setter?.call(textarea, "/");
      textarea.setSelectionRange(1, 1);
      textarea.dispatchEvent(new InputEvent("input", { bubbles: true, data: "/", inputType: "insertText" }));
    });
    await flush();

    await waitForCondition(
      () => agentResourceMocks.getAgentResources.mock.calls.length > 0,
      "Expected the resources catalog fetch once the slash trigger opened",
    );
    expect(agentResourceMocks.getAgentResources).toHaveBeenCalledWith("agent-1");

    // The Team Skill surfaces under its portable materializer slug; the
    // daemon-reported runtime row survives the merge; disabled and
    // malformed rows never render.
    await waitForText(container, "/code-review");
    expect(container.textContent).toContain("/review");
    expect(container.textContent).not.toContain("hidden-skill");
    expect(container.textContent).not.toContain("missing-body");

    await act(async () => root.unmount());
  });

  it("opens the slash menu after a committed mention in a group chat and keeps the recipient on send", async () => {
    const { ChatView } = await import("../chat-view.js");
    saveDraft(chatDraftScope(null, "chat-1"), { text: "@nova " });
    agentResourceMocks.getAgentResources.mockResolvedValue({
      version: 1,
      templateIds: [],
      adoptedTemplates: [],
      bindings: [],
      availableTeamResources: [],
      effective: {
        version: 1,
        repos: [],
        prompts: [],
        mcp: [],
        unavailable: [],
        skills: [teamSkillResourceRow()],
      },
    });
    const { container, root } = await renderDom(<ChatView agentId="agent-1" chatId="chat-1" />);

    const textarea = container.querySelector<HTMLTextAreaElement>("textarea");
    if (!textarea) throw new Error("Composer textarea missing");
    // The restored canonical draft hydrates into a display mention token
    // once the candidate roster resolves.
    await waitForCondition(
      () => textarea.value === "@Nova ",
      "Expected the restored draft to hydrate the @nova mention token",
    );
    // No slash trigger yet — the heavy resources catalog must not load.
    expect(agentResourceMocks.getAgentResources).not.toHaveBeenCalled();

    const typeDisplay = async (value: string) => {
      await act(async () => {
        const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
        setter?.call(textarea, value);
        textarea.setSelectionRange(value.length, value.length);
        textarea.dispatchEvent(new InputEvent("input", { bubbles: true, data: value, inputType: "insertText" }));
      });
      await flush();
    };

    // Plain prose between the mention and the slash must NOT open the menu.
    await typeDisplay("@Nova hi /code");
    expect(container.querySelector('[role="listbox"][aria-label="Slash command suggestions"]')).toBeNull();
    expect(agentResourceMocks.getAgentResources).not.toHaveBeenCalled();

    // Mention-prefixed mode: the trigger opens, the catalog loads for the
    // mentioned recipient only, and the menu shows the merged skills.
    await typeDisplay("@Nova /");
    await waitForCondition(
      () => agentResourceMocks.getAgentResources.mock.calls.length > 0,
      "Expected the resources catalog fetch once the mention-prefixed trigger opened",
    );
    expect(agentResourceMocks.getAgentResources).toHaveBeenCalledWith("agent-1");
    await waitForText(container, "/code-review");
    expect(container.textContent).toContain("/review");

    // Narrow to the Team Skill and pick it: the mention token survives
    // and the literal lands after it.
    await typeDisplay("@Nova /code");
    await act(async () => {
      textarea.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    });
    await flush();
    expect(textarea.value).toBe("@Nova /code-review ");

    // Send routes to the mentioned agent with the canonical `@nova` form.
    chatMocks.sendChatMessage.mockClear();
    await act(async () => {
      textarea.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    });
    await flush();
    await waitForCondition(() => chatMocks.sendChatMessage.mock.calls.length > 0, "Expected the message to send");
    expect(chatMocks.sendChatMessage).toHaveBeenCalledWith(
      "chat-1",
      expect.stringContaining("@nova /code-review"),
      ["agent-1"],
      expect.objectContaining({
        skillPrecondition: {
          recipientAgentId: "agent-1",
          expectedConfigVersion: 1,
          resourceId: "res-1",
          requestedSlug: "code-review",
        },
      }),
    );

    await act(async () => root.unmount());
  });

  it("shows only system commands when a slash is addressed to multiple recipients, and fetches nothing", async () => {
    const { ChatView } = await import("../chat-view.js");
    saveDraft(chatDraftScope(null, "chat-1"), { text: "@nova @design " });
    agentResourceMocks.getAgentResources.mockResolvedValue({
      version: 1,
      templateIds: [],
      adoptedTemplates: [],
      bindings: [],
      availableTeamResources: [],
      effective: { version: 1, repos: [], prompts: [], mcp: [], unavailable: [], skills: [teamSkillResourceRow()] },
    });
    const { container, root } = await renderDom(<ChatView agentId="agent-1" chatId="chat-1" />);

    const textarea = container.querySelector<HTMLTextAreaElement>("textarea");
    if (!textarea) throw new Error("Composer textarea missing");
    await waitForCondition(
      () => textarea.value === "@Nova @Design Critique ",
      "Expected the restored draft to hydrate both mention tokens",
    );
    // Append the slash at the end (pure insertion keeps the tokens and
    // moves the caret) so the slash trigger is active.
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
      setter?.call(textarea, "@Nova @Design Critique /");
      textarea.setSelectionRange(textarea.value.length, textarea.value.length);
      textarea.dispatchEvent(new InputEvent("input", { bubbles: true, data: "/", inputType: "insertText" }));
    });
    await flush();

    // The slash trigger is active, but the routed recipient is ambiguous:
    // the menu must stay system-only and the heavy catalog must not load.
    await waitForCondition(
      () => container.querySelector('[role="listbox"][aria-label="Slash command suggestions"]') !== null,
      "Expected the slash popover to open with system commands only",
    );
    expect(container.textContent).toContain("/clear");
    expect(container.textContent).not.toContain("/code-review");
    expect(container.textContent).not.toContain("/review");
    expect(agentResourceMocks.getAgentResources).not.toHaveBeenCalled();
    expect(agentMocks.getAgentSkills).not.toHaveBeenCalled();

    await act(async () => root.unmount());
  });

  it("revalidates Team Skills on every slash trigger and hides rows removed server-side", async () => {
    const { ChatView } = await import("../chat-view.js");
    const resourcesWithCodeReview = {
      version: 1,
      templateIds: [],
      adoptedTemplates: [],
      bindings: [],
      availableTeamResources: [],
      effective: { version: 1, repos: [], prompts: [], mcp: [], unavailable: [], skills: [teamSkillResourceRow()] },
    };
    const resourcesEmpty = {
      version: 2,
      templateIds: [],
      adoptedTemplates: [],
      bindings: [],
      availableTeamResources: [],
      effective: { version: 2, repos: [], prompts: [], mcp: [], unavailable: [], skills: [] },
    };
    agentResourceMocks.getAgentResources
      .mockResolvedValueOnce(resourcesWithCodeReview)
      .mockResolvedValue(resourcesEmpty);
    const direct = chatDetail({
      participants: [
        participant({ agentId: "human-agent-self", type: "human", name: "gandy", displayName: "Gandy" }),
        participant({ agentId: "agent-1", name: "nova", displayName: "Nova" }),
      ],
    });
    const { container, root } = await renderDom(
      <ChatView agentId="agent-1" chatId="chat-1" initialChatDetail={direct} />,
      (qc) => seedChat(qc, direct),
    );

    const textarea = container.querySelector<HTMLTextAreaElement>("textarea");
    if (!textarea) throw new Error("Composer textarea missing");
    const typeDisplay = async (value: string) => {
      await act(async () => {
        const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
        setter?.call(textarea, value);
        textarea.setSelectionRange(value.length, value.length);
        textarea.dispatchEvent(new InputEvent("input", { bubbles: true, data: value, inputType: "insertText" }));
      });
      await flush();
    };

    // First trigger: v1 Team row appears.
    await typeDisplay("/");
    await waitForText(container, "/code-review");

    // The server removes the row; the NEXT trigger revalidates instead of
    // serving the 60s-stale row, so the removed Team Skill disappears.
    await typeDisplay("x");
    await typeDisplay("/");
    await waitForCondition(
      () => !container.textContent?.includes("/code-review"),
      "Expected /code-review to disappear after revalidation",
    );
    // Single fetch driver: exactly one catalog request per legal trigger.
    expect(agentResourceMocks.getAgentResources).toHaveBeenCalledTimes(2);

    await act(async () => root.unmount());
  });

  it("keeps the menu system-only while the Team catalog validates, then merges, and degrades runtime-only on failure", async () => {
    const { ChatView } = await import("../chat-view.js");
    let resolveResources!: (value: unknown) => void;
    agentResourceMocks.getAgentResources.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveResources = resolve;
        }),
    );
    agentMocks.getAgentSkills.mockResolvedValue({ skills: [{ name: "review", description: "Review a patch." }] });
    const direct = chatDetail({
      participants: [
        participant({ agentId: "human-agent-self", type: "human", name: "gandy", displayName: "Gandy" }),
        participant({ agentId: "agent-1", name: "nova", displayName: "Nova" }),
      ],
    });
    const { container, root } = await renderDom(
      <ChatView agentId="agent-1" chatId="chat-1" initialChatDetail={direct} />,
      (qc) => seedChat(qc, direct),
    );

    const textarea = container.querySelector<HTMLTextAreaElement>("textarea");
    if (!textarea) throw new Error("Composer textarea missing");
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
      setter?.call(textarea, "/");
      textarea.setSelectionRange(1, 1);
      textarea.dispatchEvent(new InputEvent("input", { bubbles: true, data: "/", inputType: "insertText" }));
    });
    await flush();

    // While validation is pending the menu is system-only: no runtime row,
    // no Team row — no winner can be shown before the Team claim is known.
    await waitForCondition(
      () => container.querySelector('[role="listbox"][aria-label="Slash command suggestions"]') !== null,
      "Expected the slash popover to open with system commands only",
    );
    expect(container.textContent).toContain("/clear");
    expect(container.textContent).not.toContain("/review");
    expect(container.textContent).not.toContain("/code-review");

    // Validation resolves: the merged menu shows the Team winner.
    resolveResources({
      version: 1,
      templateIds: [],
      adoptedTemplates: [],
      bindings: [],
      availableTeamResources: [],
      effective: { version: 1, repos: [], prompts: [], mcp: [], unavailable: [], skills: [teamSkillResourceRow()] },
    });
    await waitForText(container, "/code-review");
    expect(container.textContent).toContain("/review");

    await act(async () => root.unmount());
  });

  it("degrades to the runtime-only catalog when Team catalog validation fails", async () => {
    const { ChatView } = await import("../chat-view.js");
    agentResourceMocks.getAgentResources.mockRejectedValue(new Error("resources offline"));
    agentMocks.getAgentSkills.mockResolvedValue({ skills: [{ name: "review", description: "Review a patch." }] });
    const direct = chatDetail({
      participants: [
        participant({ agentId: "human-agent-self", type: "human", name: "gandy", displayName: "Gandy" }),
        participant({ agentId: "agent-1", name: "nova", displayName: "Nova" }),
      ],
    });
    const { container, root } = await renderDom(
      <ChatView agentId="agent-1" chatId="chat-1" initialChatDetail={direct} />,
      (qc) => seedChat(qc, direct),
    );

    const textarea = container.querySelector<HTMLTextAreaElement>("textarea");
    if (!textarea) throw new Error("Composer textarea missing");
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
      setter?.call(textarea, "/");
      textarea.setSelectionRange(1, 1);
      textarea.dispatchEvent(new InputEvent("input", { bubbles: true, data: "/", inputType: "insertText" }));
    });
    await flush();

    await waitForText(container, "/review");
    expect(container.textContent).not.toContain("/code-review");

    await act(async () => root.unmount());
  });

  it("hides Team Skills and never fetches the catalog when the recipient client is too old for the marker", async () => {
    const { ChatView } = await import("../chat-view.js");
    // The light status query reports the recipient's bound client as
    // unsupported (old / unknown sdk_version / offline): the menu must
    // fail closed WITHOUT downloading the full resources payload.
    agentResourceMocks.getAgentResources.mockResolvedValue(resourcesV1());
    agentMocks.getAgentSkills.mockResolvedValue({ skills: [{ name: "review", description: "Review a patch." }] });
    const direct = directChat();
    const { container, root } = await renderDom(
      <ChatView agentId="agent-1" chatId="chat-1" initialChatDetail={direct} />,
      (qc) => {
        seedChat(qc, direct);
        qc.setQueryData(
          ["chat-agent-status", "chat-1"],
          [
            {
              agentId: "agent-1",
              main: "ready",
              reachable: true,
              engagement: "active",
              working: false,
              needsYou: false,
              errored: false,
              teamSkillInvocationSupported: false,
              activity: null,
            },
          ],
        );
      },
    );

    const textarea = container.querySelector<HTMLTextAreaElement>("textarea");
    if (!textarea) throw new Error("Composer textarea missing");
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
      setter?.call(textarea, "/");
      textarea.setSelectionRange(1, 1);
      textarea.dispatchEvent(new InputEvent("input", { bubbles: true, data: "/", inputType: "insertText" }));
    });
    await flush();

    // Runtime rows and system commands still show; Team rows stay hidden
    // and the heavy catalog is never fetched.
    await waitForText(container, "/review");
    expect(container.textContent).not.toContain("/code-review");
    expect(agentResourceMocks.getAgentResources).not.toHaveBeenCalled();

    await act(async () => root.unmount());
  });

  it("closes the gate while a warm cached true refetches, then reopens on a fresh true", async () => {
    const { ChatView } = await import("../chat-view.js");
    agentResourceMocks.getAgentResources.mockResolvedValue(resourcesV1());
    agentMocks.getAgentSkills.mockResolvedValue({ skills: [{ name: "review", description: "Review a patch." }] });
    let resolveStatuses: (value: unknown) => void = () => {};
    agentStatusMocks.fetchChatAgentStatuses.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveStatuses = resolve;
        }),
    );
    const direct = directChat();
    const { container, root, queryClient } = await renderDom(
      <ChatView agentId="agent-1" chatId="chat-1" initialChatDetail={direct} />,
      (qc) => {
        // WARM cache: statuses already say supported === true. Marking the
        // query stale forces the next observer mount into a refetch — the
        // exact frame where a cached true must NOT keep the gate open.
        seedChat(qc, direct);
        qc.invalidateQueries({ queryKey: ["chat-agent-status", "chat-1"] });
      },
    );

    const textarea = container.querySelector<HTMLTextAreaElement>("textarea");
    if (!textarea) throw new Error("Composer textarea missing");
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
      setter?.call(textarea, "/");
      textarea.setSelectionRange(1, 1);
      textarea.dispatchEvent(new InputEvent("input", { bubbles: true, data: "/", inputType: "insertText" }));
    });
    await flush();

    // Warm true + refetch pending: fail closed — the cached true does not
    // authorize a catalog download or a Team row.
    expect(agentResourceMocks.getAgentResources).not.toHaveBeenCalled();
    expect(container.textContent).not.toContain("/code-review");

    await act(async () => {
      resolveStatuses([
        {
          agentId: "agent-1",
          main: "ready",
          reachable: true,
          engagement: "active",
          working: false,
          needsYou: false,
          errored: false,
          teamSkillInvocationSupported: true,
          activity: null,
        },
      ]);
    });
    await flush();
    await waitForCondition(
      () => agentResourceMocks.getAgentResources.mock.calls.length > 0,
      "Expected the catalog fetch once a fresh supported status landed",
    );
    expect(agentResourceMocks.getAgentResources).toHaveBeenCalledTimes(1);
    await waitForText(container, "/code-review");
    void queryClient;

    await act(async () => root.unmount());
  });

  it("keeps the gate closed when a warm cached true refetch resolves false or errors", async () => {
    const { ChatView } = await import("../chat-view.js");
    agentResourceMocks.getAgentResources.mockResolvedValue(resourcesV1());
    agentMocks.getAgentSkills.mockResolvedValue({ skills: [{ name: "review", description: "Review a patch." }] });
    const statusesWith = (supported: boolean) => [
      {
        agentId: "agent-1",
        main: "ready",
        reachable: true,
        engagement: "active",
        working: false,
        needsYou: false,
        errored: false,
        teamSkillInvocationSupported: supported,
        activity: null,
      },
    ];
    const deferred = () => {
      let resolve: (value: unknown) => void = () => {};
      let reject: (error: Error) => void = () => {};
      const promise = new Promise((res, rej) => {
        resolve = res;
        reject = rej;
      });
      return { promise, resolve, reject };
    };
    let cycle = deferred();
    agentStatusMocks.fetchChatAgentStatuses.mockImplementation(() => cycle.promise);
    const direct = directChat();
    const { container, root, queryClient } = await renderDom(
      <ChatView agentId="agent-1" chatId="chat-1" initialChatDetail={direct} />,
      (qc) => {
        // WARM cache: supported === true, marked stale so the observer
        // refetches on mount — the frame a cached true must not exploit.
        seedChat(qc, direct);
        qc.invalidateQueries({ queryKey: ["chat-agent-status", "chat-1"] });
      },
    );

    const textarea = container.querySelector<HTMLTextAreaElement>("textarea");
    if (!textarea) throw new Error("Composer textarea missing");
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
      setter?.call(textarea, "/");
      textarea.setSelectionRange(1, 1);
      textarea.dispatchEvent(new InputEvent("input", { bubbles: true, data: "/", inputType: "insertText" }));
    });
    await flush();

    // Warm true + refetch pending: closed.
    expect(agentResourceMocks.getAgentResources).not.toHaveBeenCalled();
    expect(container.textContent).not.toContain("/code-review");

    // Refetch resolves FALSE: stays closed.
    await act(async () => {
      cycle.resolve(statusesWith(false));
    });
    await flush();
    expect(container.textContent).not.toContain("/code-review");
    expect(agentResourceMocks.getAgentResources).not.toHaveBeenCalled();

    // Warm true again, and the refresh ERRORS: still closed — a warm true
    // must never ride through a failed revalidation.
    await act(async () => {
      queryClient.setQueryData(["chat-agent-status", "chat-1"], statusesWith(true));
      cycle = deferred();
      queryClient.invalidateQueries({ queryKey: ["chat-agent-status", "chat-1"] });
    });
    await flush();
    expect(agentResourceMocks.getAgentResources).not.toHaveBeenCalled();
    await act(async () => {
      cycle.reject(new Error("status offline"));
    });
    await flush();
    await waitForText(container, "/review");
    expect(container.textContent).not.toContain("/code-review");
    expect(agentResourceMocks.getAgentResources).not.toHaveBeenCalled();

    await act(async () => root.unmount());
  });

  it("drops stale Team rows from the menu when catalog revalidation fails", async () => {
    const { ChatView } = await import("../chat-view.js");
    // First trigger validates successfully; the SECOND trigger's
    // revalidation fails, and React Query keeps the stale v1 data alongside
    // the error — the merge must not keep offering those rows.
    agentResourceMocks.getAgentResources.mockResolvedValueOnce(resourcesV1());
    agentMocks.getAgentSkills.mockResolvedValue({ skills: [{ name: "review", description: "Review a patch." }] });
    const direct = directChat();
    const { container, root } = await renderDom(
      <ChatView agentId="agent-1" chatId="chat-1" initialChatDetail={direct} />,
      (qc) => seedChat(qc, direct),
    );

    const textarea = container.querySelector<HTMLTextAreaElement>("textarea");
    if (!textarea) throw new Error("Composer textarea missing");
    const typeDraft = async (value: string) => {
      await act(async () => {
        const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
        setter?.call(textarea, value);
        textarea.setSelectionRange(value.length, value.length);
        textarea.dispatchEvent(new InputEvent("input", { bubbles: true, data: value, inputType: "insertText" }));
      });
      await flush();
    };

    await typeDraft("/");
    await waitForText(container, "/code-review");

    // Close the trigger, fail the next revalidation, and re-open it.
    await typeDraft("");
    agentResourceMocks.getAgentResources.mockRejectedValue(new Error("resources offline"));
    await typeDraft("/");
    await waitForText(container, "/review");
    expect(container.textContent).not.toContain("/code-review");

    await act(async () => root.unmount());
  });

  it("sends a hand-typed slash as a local command with no fetch and no precondition, even when it matches a Team row", async () => {
    const { ChatView } = await import("../chat-view.js");
    agentResourceMocks.getAgentResources.mockResolvedValue(resourcesV1());
    const direct = directChat();
    const { container, root } = await renderDom(
      <ChatView agentId="agent-1" chatId="chat-1" initialChatDetail={direct} />,
      (qc) => seedChat(qc, direct),
    );

    // Hand-typed strict slash (even one whose literal matches a Team row,
    // in any case) carries no provenance — and only a server-owned marker
    // represents Team intent. The send boundary must neither fetch the
    // full catalog nor demand a menu re-pick.
    const textarea = container.querySelector<HTMLTextAreaElement>("textarea");
    if (!textarea) throw new Error("Composer textarea missing");
    await setValue(textarea, "/CODE-REVIEW ");
    chatMocks.sendChatMessage.mockClear();
    agentResourceMocks.getAgentResources.mockClear();
    await pressSend(container);
    await waitForCondition(() => chatMocks.sendChatMessage.mock.calls.length > 0, "Expected the message POST");
    expect(agentResourceMocks.getAgentResources).not.toHaveBeenCalled();
    const [, , , opts] = chatMocks.sendChatMessage.mock.calls[0] ?? [];
    expect(opts?.skillPrecondition).toBeUndefined();

    await act(async () => root.unmount());
  });

  it("sends hand-typed local commands when the status gate is closed — zero catalog fetches", async () => {
    const { ChatView } = await import("../chat-view.js");
    agentResourceMocks.getAgentResources.mockResolvedValue(resourcesV1());
    agentMocks.getAgentSkills.mockResolvedValue({ skills: [{ name: "ship", description: "Ship it." }] });
    const direct = directChat();
    const { container, root } = await renderDom(
      <ChatView agentId="agent-1" chatId="chat-1" initialChatDetail={direct} />,
      (qc) => {
        seedChat(qc, direct);
        // Old / unknown client: the Team menu gate is closed, but local
        // commands must still send WITHOUT a Resources download.
        qc.setQueryData(
          ["chat-agent-status", "chat-1"],
          [
            {
              agentId: "agent-1",
              main: "ready",
              reachable: true,
              engagement: "active",
              working: false,
              needsYou: false,
              errored: false,
              teamSkillInvocationSupported: false,
              activity: null,
            },
          ],
        );
      },
    );

    const textarea = container.querySelector<HTMLTextAreaElement>("textarea");
    if (!textarea) throw new Error("Composer textarea missing");
    // A plain local command, then one whose literal matches the hidden
    // Team row — both send as ordinary local commands.
    for (const command of ["/ship ", "/code-review "]) {
      await setValue(textarea, command);
      chatMocks.sendChatMessage.mockClear();
      agentResourceMocks.getAgentResources.mockClear();
      await pressSend(container);
      await waitForCondition(
        () => chatMocks.sendChatMessage.mock.calls.length > 0,
        `Expected ${command.trim()} to send as a local command`,
      );
      expect(agentResourceMocks.getAgentResources).not.toHaveBeenCalled();
      const [, , , opts] = chatMocks.sendChatMessage.mock.calls[0] ?? [];
      expect(opts?.skillPrecondition).toBeUndefined();
    }

    await act(async () => root.unmount());
  });

  const directChat = () =>
    chatDetail({
      participants: [
        participant({ agentId: "human-agent-self", type: "human", name: "gandy", displayName: "Gandy" }),
        participant({ agentId: "agent-1", name: "nova", displayName: "Nova" }),
      ],
    });

  const resourcesV1 = () => ({
    version: 1,
    templateIds: [],
    adoptedTemplates: [],
    bindings: [],
    availableTeamResources: [],
    effective: { version: 1, repos: [], prompts: [], mcp: [], unavailable: [], skills: [teamSkillResourceRow()] },
  });
  const resourcesEmpty = () => ({
    version: 2,
    templateIds: [],
    adoptedTemplates: [],
    bindings: [],
    availableTeamResources: [],
    effective: { version: 2, repos: [], prompts: [], mcp: [], unavailable: [], skills: [] },
  });

  async function pickSlashCommand(container: HTMLElement, typed: string): Promise<void> {
    const textarea = container.querySelector<HTMLTextAreaElement>("textarea");
    if (!textarea) throw new Error("Composer textarea missing");
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
      setter?.call(textarea, typed);
      textarea.setSelectionRange(typed.length, typed.length);
      textarea.dispatchEvent(new InputEvent("input", { bubbles: true, data: typed, inputType: "insertText" }));
    });
    await flush();
    await act(async () => {
      textarea.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    });
    await flush();
  }

  async function pressSend(container: HTMLElement): Promise<void> {
    const button = container.querySelector('button[aria-label="Send"]');
    if (!button) throw new Error("Send button missing");
    await act(async () => {
      button.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    });
    await flush();
  }

  it("blocks sending a Team Skill command whose row changed after selection, keeping the draft", async () => {
    const { ChatView } = await import("../chat-view.js");
    // First catalog fetch (menu) serves v1; the send-time revalidation
    // sees the row already removed (v2).
    agentResourceMocks.getAgentResources.mockImplementation(() =>
      Promise.resolve(agentResourceMocks.getAgentResources.mock.calls.length === 1 ? resourcesV1() : resourcesEmpty()),
    );
    const direct = directChat();
    const { container, root } = await renderDom(
      <ChatView agentId="agent-1" chatId="chat-1" initialChatDetail={direct} />,
      (qc) => seedChat(qc, direct),
    );

    await pickSlashCommand(container, "/code");
    const textarea = container.querySelector<HTMLTextAreaElement>("textarea");
    if (!textarea) throw new Error("Composer textarea missing");
    if (textarea.value !== "/code-review ")
      throw new Error(`Expected the Team command in the draft, got "${textarea.value}"`);

    // The admin deletes/renames the Team Skill before the send lands: the
    // send must be blocked (no POST), the draft must survive, and the
    // reason must be visible.
    chatMocks.sendChatMessage.mockClear();
    await pressSend(container);
    expect(chatMocks.sendChatMessage).not.toHaveBeenCalled();
    expect(textarea.value).toBe("/code-review ");
    await waitForText(container, "re-open the / menu");

    await act(async () => root.unmount());
  });

  it("sends an unchanged Team Skill command with the transient version precondition", async () => {
    const { ChatView } = await import("../chat-view.js");
    agentResourceMocks.getAgentResources.mockResolvedValue(resourcesV1());
    const direct = directChat();
    const { container, root } = await renderDom(
      <ChatView agentId="agent-1" chatId="chat-1" initialChatDetail={direct} />,
      (qc) => seedChat(qc, direct),
    );

    await pickSlashCommand(container, "/code");
    chatMocks.sendChatMessage.mockClear();
    await pressSend(container);
    await waitForCondition(() => chatMocks.sendChatMessage.mock.calls.length > 0, "Expected the message POST");
    const [, , , opts] = chatMocks.sendChatMessage.mock.calls[0] ?? [];
    expect(opts).toMatchObject({
      skillPrecondition: {
        recipientAgentId: "agent-1",
        expectedConfigVersion: 1,
        resourceId: "res-1",
        requestedSlug: "code-review",
      },
    });

    await act(async () => root.unmount());
  });

  it("keeps the draft and surfaces the error when an old Server rejects the invocation protocol", async () => {
    const { ChatView } = await import("../chat-view.js");
    agentResourceMocks.getAgentResources.mockResolvedValue(resourcesV1());
    // Rollback simulation: the old Server's purpose enum knows only
    // `agent-final-text`, so it parse-rejects the sentinel — the send must
    // fail visibly with the draft preserved, never degrade to a bare slash.
    chatMocks.sendChatMessage.mockRejectedValue(new Error("Invalid enum value: team-skill-invocation-v1"));
    const direct = directChat();
    const { container, root } = await renderDom(
      <ChatView agentId="agent-1" chatId="chat-1" initialChatDetail={direct} />,
      (qc) => seedChat(qc, direct),
    );

    await pickSlashCommand(container, "/code");
    await pressSend(container);
    await waitForCondition(() => chatMocks.sendChatMessage.mock.calls.length > 0, "Expected the attempted POST");
    await waitForText(container, "Invalid enum value: team-skill-invocation-v1");
    const textarea = container.querySelector<HTMLTextAreaElement>("textarea");
    if (!textarea) throw new Error("Composer textarea missing");
    await waitForCondition(() => textarea.value === "/code-review ", "Expected the draft to be restored");

    // Immediate unchanged retry: the restored provenance drives the full
    // revalidation and pairs the exact precondition + sentinel AGAIN —
    // never a bare local slash that the old Server would accept.
    await pressSend(container);
    await waitForCondition(() => chatMocks.sendChatMessage.mock.calls.length === 2, "Expected the retry POST");
    const [, , , retryOpts] = chatMocks.sendChatMessage.mock.calls[1] ?? [];
    expect(retryOpts).toMatchObject({
      skillPrecondition: {
        recipientAgentId: "agent-1",
        expectedConfigVersion: 1,
        resourceId: "res-1",
        requestedSlug: "code-review",
      },
    });
    await waitForCondition(
      () => textarea.value === "/code-review ",
      "Expected the draft to survive the second rejection",
    );

    await act(async () => root.unmount());
  });

  it("does not let a failed Team send leave intent behind: clearing and hand-typing the same literal sends as local", async () => {
    const { ChatView } = await import("../chat-view.js");
    agentResourceMocks.getAgentResources.mockResolvedValue(resourcesV1());
    chatMocks.sendChatMessage.mockRejectedValueOnce(new Error("Invalid enum value: team-skill-invocation-v1"));
    const direct = directChat();
    const { container, root } = await renderDom(
      <ChatView agentId="agent-1" chatId="chat-1" initialChatDetail={direct} />,
      (qc) => seedChat(qc, direct),
    );

    await pickSlashCommand(container, "/code");
    await pressSend(container);
    await waitForCondition(() => chatMocks.sendChatMessage.mock.calls.length > 0, "Expected the attempted POST");
    await waitForText(container, "Invalid enum value: team-skill-invocation-v1");

    // The user discards the restored Team draft and hand-types the same
    // literal: clearing first kills the restored provenance (the
    // invalidation effect sees the command disappear), so the retyped
    // command is an ordinary local one — no sentinel, no precondition.
    const textarea = container.querySelector<HTMLTextAreaElement>("textarea");
    if (!textarea) throw new Error("Composer textarea missing");
    await setValue(textarea, "");
    await setValue(textarea, "/code-review ");
    chatMocks.sendChatMessage.mockClear();
    await pressSend(container);
    await waitForCondition(() => chatMocks.sendChatMessage.mock.calls.length > 0, "Expected the local send");
    const [, , , opts] = chatMocks.sendChatMessage.mock.calls[0] ?? [];
    expect(opts?.skillPrecondition).toBeUndefined();

    await act(async () => root.unmount());
  });

  it("restores the image and the caption when an old Server rejects a Team captioned-image send", async () => {
    const { ChatView } = await import("../chat-view.js");
    agentResourceMocks.getAgentResources.mockResolvedValue(resourcesV1());
    // Rollback simulation again, this time on the file path: the upload
    // succeeds, but the old Server parse-rejects the sentinel purpose.
    chatMocks.sendFileMessageBatch.mockRejectedValue(new Error("Invalid enum value: team-skill-invocation-v1"));
    const direct = directChat();
    const { container, root } = await renderDom(
      <ChatView agentId="agent-1" chatId="chat-1" initialChatDetail={direct} />,
      (qc) => seedChat(qc, direct),
    );

    const file = new File(["abc"], "preview.png", { type: "image/png" });
    const fileInput = container.querySelector<HTMLInputElement>('input[type="file"]');
    if (!fileInput) throw new Error("File input missing");
    await changeFiles(fileInput, [file]);
    // The Team command becomes the image caption.
    await pickSlashCommand(container, "/code");
    attachmentMocks.uploadAttachment.mockClear();
    chatMocks.sendFileMessageBatch.mockClear();

    await pressSend(container);
    await waitForCondition(
      () => chatMocks.sendFileMessageBatch.mock.calls.length > 0,
      "Expected the attempted file message POST",
    );
    expect(attachmentMocks.uploadAttachment).toHaveBeenCalledTimes(1);
    await waitForText(container, "Invalid enum value: team-skill-invocation-v1");

    // The caption text AND the staged image both come back to the composer;
    // no message was persisted.
    const textarea = container.querySelector<HTMLTextAreaElement>("textarea");
    if (!textarea) throw new Error("Composer textarea missing");
    await waitForCondition(() => textarea.value === "/code-review ", "Expected the caption draft to be restored");
    await waitForCondition(
      () => container.querySelector('button[aria-label="Remove preview.png"]') !== null,
      "Expected the image preview to be restored in the composer",
    );
    expect(chatMocks.sendChatMessage).not.toHaveBeenCalled();

    // Immediate unchanged retry: uploads again, posts again WITH the exact
    // pair — never a bare caption the old Server would accept — and the
    // second rejection restores caption and image once more.
    await pressSend(container);
    await waitForCondition(() => chatMocks.sendFileMessageBatch.mock.calls.length === 2, "Expected the retry POST");
    expect(attachmentMocks.uploadAttachment).toHaveBeenCalledTimes(2);
    const [, , , retryOpts] = chatMocks.sendFileMessageBatch.mock.calls[1] ?? [];
    expect(retryOpts).toMatchObject({
      skillPrecondition: {
        recipientAgentId: "agent-1",
        expectedConfigVersion: 1,
        resourceId: "res-1",
        requestedSlug: "code-review",
      },
    });
    await waitForCondition(
      () => textarea.value === "/code-review ",
      "Expected the caption to survive the second rejection",
    );
    await waitForCondition(
      () => container.querySelector('button[aria-label="Remove preview.png"]') !== null,
      "Expected the image preview to be restored again after the second rejection",
    );

    await act(async () => root.unmount());
  });

  it("lets a hand-typed runtime command send without any precondition or catalog fetch", async () => {
    const { ChatView } = await import("../chat-view.js");
    agentResourceMocks.getAgentResources.mockResolvedValue(resourcesEmpty());
    agentMocks.getAgentSkills.mockResolvedValue({ skills: [{ name: "review", description: "Review a patch." }] });
    const direct = directChat();
    const { container, root } = await renderDom(
      <ChatView agentId="agent-1" chatId="chat-1" initialChatDetail={direct} />,
      (qc) => seedChat(qc, direct),
    );

    const textarea = container.querySelector<HTMLTextAreaElement>("textarea");
    if (!textarea) throw new Error("Composer textarea missing");
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
      setter?.call(textarea, "/review ");
      textarea.setSelectionRange(8, 8);
      textarea.dispatchEvent(new InputEvent("input", { bubbles: true, data: "/review ", inputType: "insertText" }));
    });
    await flush();
    chatMocks.sendChatMessage.mockClear();
    agentResourceMocks.getAgentResources.mockClear();
    await pressSend(container);
    await waitForCondition(() => chatMocks.sendChatMessage.mock.calls.length > 0, "Expected the message POST");
    expect(agentResourceMocks.getAgentResources).not.toHaveBeenCalled();
    const [, , , opts] = chatMocks.sendChatMessage.mock.calls[0] ?? [];
    expect(opts?.skillPrecondition).toBeUndefined();

    await act(async () => root.unmount());
  });

  it("requires a restored Team-command draft with no provenance to be re-picked from the menu", async () => {
    const { ChatView } = await import("../chat-view.js");
    saveDraft(chatDraftScope(null, "chat-1"), { text: "/code-review " });
    agentResourceMocks.getAgentResources.mockResolvedValue(resourcesV1());
    const direct = directChat();
    const { container, root } = await renderDom(
      <ChatView agentId="agent-1" chatId="chat-1" initialChatDetail={direct} />,
      (qc) => seedChat(qc, direct),
    );

    chatMocks.sendChatMessage.mockClear();
    agentResourceMocks.getAgentResources.mockClear();
    await pressSend(container);
    expect(chatMocks.sendChatMessage).not.toHaveBeenCalled();
    // The restored-draft guard fires BEFORE any catalog re-check: an
    // untouched restored strict-slash draft carries no Team/local intent
    // proof at all, whether or not the Team row still exists.
    await waitForText(container, "restored from a saved draft");
    expect(agentResourceMocks.getAgentResources).not.toHaveBeenCalled();

    await act(async () => root.unmount());
  });

  it("lets a restored runtime slash send after re-picking the same row from the menu", async () => {
    const { ChatView } = await import("../chat-view.js");
    // Restored draft is a RUNTIME command, not a Team row: the guard still
    // blocks the untouched restore, but an explicit menu re-pick — even of
    // the byte-identical command — discharges it.
    saveDraft(chatDraftScope(null, "chat-1"), { text: "/review " });
    agentResourceMocks.getAgentResources.mockResolvedValue(resourcesV1());
    agentMocks.getAgentSkills.mockResolvedValue({ skills: [{ name: "review", description: "Review a patch." }] });
    const direct = directChat();
    const { container, root } = await renderDom(
      <ChatView agentId="agent-1" chatId="chat-1" initialChatDetail={direct} />,
      (qc) => seedChat(qc, direct),
    );

    chatMocks.sendChatMessage.mockClear();
    await pressSend(container);
    expect(chatMocks.sendChatMessage).not.toHaveBeenCalled();
    await waitForText(container, "restored from a saved draft");

    // Re-open the menu and pick the same runtime row.
    await pickSlashCommand(container, "/review");
    const textarea = container.querySelector<HTMLTextAreaElement>("textarea");
    if (!textarea) throw new Error("Composer textarea missing");
    if (textarea.value !== "/review ")
      throw new Error(`Expected the re-picked runtime command, got "${textarea.value}"`);

    await pressSend(container);
    await waitForCondition(() => chatMocks.sendChatMessage.mock.calls.length > 0, "Expected the message POST");
    const [, , , opts] = chatMocks.sendChatMessage.mock.calls[0] ?? [];
    // A runtime pick carries no Team precondition.
    expect(opts?.skillPrecondition).toBeUndefined();

    await act(async () => root.unmount());
  });

  it("renders provider retry events as non-fatal timeline rows when severity is not error", async () => {
    const { ChatView } = await import("../chat-view.js");
    const { container, root } = await renderDom(<ChatView agentId="agent-1" chatId="chat-1" />, (queryClient) => {
      queryClient.setQueryData(
        ["chat-session-events", "chat-1"],
        chatSessionEvents({
          agentId: "agent-1",
          events: {
            items: [
              {
                id: "retry-event",
                agentId: "agent-1",
                chatId: "chat-1",
                seq: 1,
                kind: "error",
                payload: {
                  source: "runtime",
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
                    messagePreview: "fetch failed",
                  }),
                },
                createdAt: "2026-05-28T11:56:30.000Z",
              },
            ] satisfies SessionEventRow[],
            nextCursor: null,
          },
        }),
      );
    });

    await waitForText(container, "Retrying provider");
    expect(container.textContent).toContain("fetch failed");
    expect(container.querySelector("[data-error-agent]")).toBeNull();
    expect(container.querySelector('[data-status-reason-agent="agent-1"]')).not.toBeNull();
    await act(async () => root.unmount());
  });

  // The in-chat "needs login" entry point: a terminal credential failure means
  // the provider is installed but logged out, so the error row offers an inline
  // "Connect <provider>" that starts the in-product login for the failing
  // agent's client. Keyed strictly on `category === "credential"` + a resolvable
  // client id.
  describe("in-chat login entry point", () => {
    function credentialErrorEvents(agentId: string): { items: SessionEventRow[]; nextCursor: number | null } {
      return {
        items: [
          {
            id: "cred-fail",
            agentId,
            chatId: "chat-1",
            seq: 1,
            kind: "error",
            payload: {
              source: "runtime",
              message: encodeProviderRetryEventMessage({
                event: "provider_failure_terminal",
                provider: "claude-code",
                scope: "session_start",
                category: "credential",
                reasonCode: "provider_credential_invalid",
                userSeverity: "error",
                messagePreview: "not logged in",
              }),
            },
            createdAt: "2026-05-28T11:56:30.000Z",
          },
        ] satisfies SessionEventRow[],
        nextCursor: null,
      };
    }

    function capacityErrorEvents(agentId: string): { items: SessionEventRow[]; nextCursor: number | null } {
      return {
        items: [
          {
            id: "capacity-wait",
            agentId,
            chatId: "chat-1",
            seq: 1,
            kind: "error",
            payload: {
              source: "runtime",
              message: encodeProviderRetryEventMessage({
                event: "provider_retry_scheduled",
                provider: "claude-code",
                scope: "provider_turn",
                category: "provider_capacity",
                reasonCode: "capacity_wait_required",
                retryMode: "background",
                userSeverity: "warning",
                messagePreview: "at capacity",
              }),
            },
            createdAt: "2026-05-28T11:56:30.000Z",
          },
        ] satisfies SessionEventRow[],
        nextCursor: null,
      };
    }

    function runtimeProofErrorEvents(agentId: string): { items: SessionEventRow[]; nextCursor: number | null } {
      return {
        items: [
          {
            id: "runtime-proof-fail",
            agentId,
            chatId: "chat-1",
            seq: 1,
            kind: "error",
            payload: {
              source: "runtime",
              message: encodeProviderRetryEventMessage({
                event: "provider_failure_terminal",
                provider: "claude-code",
                scope: "provider_turn",
                category: "runtime_transport",
                reasonCode: "runtime_session_invalid",
                userSeverity: "warning",
                messagePreview: "Invalid agent runtime session",
              }),
            },
            createdAt: "2026-05-28T11:56:30.000Z",
          },
        ] satisfies SessionEventRow[],
        nextCursor: null,
      };
    }

    it("renders a Connect button on a credential failure when the agent's client resolves", async () => {
      const { ChatView } = await import("../chat-view.js");
      const { container, root } = await renderDom(<ChatView agentId="agent-1" chatId="chat-1" />, (queryClient) => {
        // agent-1 has clientId "client-1" in ORG_AGENTS.
        queryClient.setQueryData(
          ["chat-session-events", "chat-1"],
          chatSessionEvents({ agentId: "agent-1", events: credentialErrorEvents("agent-1") }),
        );
      });

      await waitForText(container, "not logged in");
      await waitForCondition(
        () => buttonByText(container, "Connect Claude Code") !== null,
        "Expected the in-chat login button for a credential failure",
      );

      // Clicking starts the in-product login for the resolved client + provider.
      await click(buttonByText(container, "Connect Claude Code"));
      await waitForCondition(
        () => activityMocks.startRuntimeAuth.mock.calls.length > 0,
        "Expected the login click to start runtime auth",
      );
      expect(activityMocks.startRuntimeAuth).toHaveBeenCalledWith("client-1", { provider: "claude-code" });

      await act(async () => root.unmount());
    });

    it("does NOT render a Connect button for a non-credential failure (provider capacity)", async () => {
      const { ChatView } = await import("../chat-view.js");
      const { container, root } = await renderDom(<ChatView agentId="agent-1" chatId="chat-1" />, (queryClient) => {
        queryClient.setQueryData(
          ["chat-session-events", "chat-1"],
          chatSessionEvents({ agentId: "agent-1", events: capacityErrorEvents("agent-1") }),
        );
      });

      await waitForText(container, "at capacity");
      await flush();
      expect(buttonByText(container, "Connect Claude Code")).toBeNull();

      await act(async () => root.unmount());
    });

    it("labels runtime-proof recovery separately and does NOT offer provider login", async () => {
      const { ChatView } = await import("../chat-view.js");
      const { container, root } = await renderDom(<ChatView agentId="agent-1" chatId="chat-1" />, (queryClient) => {
        queryClient.setQueryData(
          ["chat-session-events", "chat-1"],
          chatSessionEvents({ agentId: "agent-1", events: runtimeProofErrorEvents("agent-1") }),
        );
      });

      await waitForText(container, "Runtime connection interrupted");
      expect(container.textContent).toContain("Invalid agent runtime session");
      expect(buttonByText(container, "Connect Claude Code")).toBeNull();

      await act(async () => root.unmount());
    });

    it("does NOT render a Connect button when the failing agent has no client (clientId null)", async () => {
      const { ChatView } = await import("../chat-view.js");
      const { container, root } = await renderDom(<ChatView agentId="agent-1" chatId="chat-1" />, (queryClient) => {
        // The failing agent is not in the org roster, so clientIdForAgent → null.
        queryClient.setQueryData(
          ["chat-session-events", "chat-1"],
          chatSessionEvents({ agentId: "agent-unbound", events: credentialErrorEvents("agent-unbound") }),
        );
      });

      await waitForText(container, "not logged in");
      await flush();
      expect(buttonByText(container, "Connect Claude Code")).toBeNull();

      await act(async () => root.unmount());
    });

    // Fix 1: ownership gate. The button mirrors the server's `assertClientOwner`
    // — it renders only when the failing agent's resolved client is in the
    // caller's own `/me/clients` set, so a teammate's agent on a computer the
    // caller does not own gets the error WITHOUT a button.
    it("does NOT render a Connect button when the failing agent's client is not owned by the caller", async () => {
      const { ChatView } = await import("../chat-view.js");
      // `listClients()` (the caller's own computers) returns only client-1, so
      // agent-teammate's client-teammate is resolvable but unowned.
      const { container, root } = await renderDom(<ChatView agentId="agent-1" chatId="chat-1" />, (queryClient) => {
        queryClient.setQueryData(
          ["chat-session-events", "chat-1"],
          chatSessionEvents({ agentId: "agent-teammate", events: credentialErrorEvents("agent-teammate") }),
        );
      });

      await waitForText(container, "not logged in");
      await flush();
      expect(buttonByText(container, "Connect Claude Code")).toBeNull();

      await act(async () => root.unmount());
    });

    it("renders a Connect button when the caller owns the failing agent's client (positive ownership case)", async () => {
      const { ChatView } = await import("../chat-view.js");
      // agent-1 → client-1, and listClients() returns client-1 → owned.
      const { container, root } = await renderDom(<ChatView agentId="agent-1" chatId="chat-1" />, (queryClient) => {
        queryClient.setQueryData(
          ["chat-session-events", "chat-1"],
          chatSessionEvents({ agentId: "agent-1", events: credentialErrorEvents("agent-1") }),
        );
      });

      await waitForText(container, "not logged in");
      await waitForCondition(
        () => buttonByText(container, "Connect Claude Code") !== null,
        "Expected the in-chat login button when the caller owns the client",
      );

      await act(async () => root.unmount());
    });

    // Fix 2: a `claude-code-tui` credential failure shares the Claude Code
    // keychain, so it maps to the `claude-code` login target — the button is
    // labeled "Connect Claude Code" and the click starts a `claude-code` login.
    it("maps a claude-code-tui credential failure to the claude-code login target", async () => {
      const { ChatView } = await import("../chat-view.js");
      function tuiCredentialErrorEvents(agentId: string): {
        items: SessionEventRow[];
        nextCursor: number | null;
      } {
        return {
          items: [
            {
              id: "tui-cred-fail",
              agentId,
              chatId: "chat-1",
              seq: 1,
              kind: "error",
              payload: {
                source: "runtime",
                message: encodeProviderRetryEventMessage({
                  event: "provider_failure_terminal",
                  provider: "claude-code-tui",
                  scope: "session_start",
                  category: "credential",
                  reasonCode: "provider_credential_invalid",
                  userSeverity: "error",
                  messagePreview: "not logged in",
                }),
              },
              createdAt: "2026-05-28T11:56:30.000Z",
            },
          ] satisfies SessionEventRow[],
          nextCursor: null,
        };
      }

      const { container, root } = await renderDom(<ChatView agentId="agent-1" chatId="chat-1" />, (queryClient) => {
        queryClient.setQueryData(
          ["chat-session-events", "chat-1"],
          chatSessionEvents({ agentId: "agent-1", events: tuiCredentialErrorEvents("agent-1") }),
        );
      });

      await waitForText(container, "not logged in");
      await waitForCondition(
        () => buttonByText(container, "Connect Claude Code") !== null,
        "Expected a Claude Code login button for a claude-code-tui credential failure",
      );

      await click(buttonByText(container, "Connect Claude Code"));
      await waitForCondition(
        () => activityMocks.startRuntimeAuth.mock.calls.length > 0,
        "Expected the login click to start runtime auth",
      );
      // The TUI failure is normalized to the claude-code Connect target.
      expect(activityMocks.startRuntimeAuth).toHaveBeenCalledWith("client-1", { provider: "claude-code" });

      await act(async () => root.unmount());
    });

    // Fix 3: the single-client poll must disarm once the attempt resolves. After
    // the click arms the poll, a terminal `lastAuthError` recorded at/after the
    // click resolves it — `getClient` must stop being re-polled.
    it("stops polling the single client once a terminal login failure is observed", async () => {
      const { ChatView } = await import("../chat-view.js");
      const clientBase = {
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
      } as const;
      // Mount fetch: clean entry (no pending / no error) so the button reads
      // "Connect Claude Code". After the first poll the client reports a terminal
      // failure stamped now, which the poll predicate treats as resolved.
      const cleanClient: HubClient = { ...clientBase, capabilities: {} };
      const failedClient: HubClient = {
        ...clientBase,
        capabilities: {
          "claude-code": {
            state: "ok",
            available: true,
            detectedAt: NOW,
            lastAuthError: { reason: "timeout", at: new Date().toISOString() },
          },
        },
      };
      let getClientCalls = 0;
      activityMocks.getClient.mockImplementation(() => {
        getClientCalls += 1;
        // First fetch (mount): clean; every fetch after the click: terminal failure.
        return Promise.resolve(getClientCalls <= 1 ? cleanClient : failedClient);
      });

      const { container, root } = await renderDom(<ChatView agentId="agent-1" chatId="chat-1" />, (queryClient) => {
        queryClient.setQueryData(
          ["chat-session-events", "chat-1"],
          chatSessionEvents({ agentId: "agent-1", events: credentialErrorEvents("agent-1") }),
        );
      });

      await waitForCondition(
        () => buttonByText(container, "Connect Claude Code") !== null,
        "Expected the in-chat login button",
      );
      await click(buttonByText(container, "Connect Claude Code"));

      // Let the post-click refetch + any disarm settle, then snapshot the call
      // count and confirm it does not keep climbing (the poll disarmed).
      await flush();
      await flush();
      const settledCalls = activityMocks.getClient.mock.calls.length;
      await flush();
      await flush();
      expect(activityMocks.getClient.mock.calls.length).toBe(settledCalls);

      await act(async () => root.unmount());
    });

    // Fix (Bug 2): the ErrorRow is a persistent timeline event, so after a
    // SUCCESSFUL in-chat login the control must stop re-inviting login. Drive a
    // real success transition — pending appears, then clears with `state: "ok"`
    // and no `lastAuthError` — and assert the row flips to a terminal "Signed in"
    // affordance with NO live Connect button.
    it("shows a terminal signed-in state (not a Connect button) after a successful in-chat login", async () => {
      const { ChatView } = await import("../chat-view.js");
      const clientBase = {
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
      } as const;
      // Mount: clean (Connect). The click's refetch delivers a live pending login
      // (the daemon launched browser sign-in); the next single-row refetch
      // delivers the resolved entry — pending cleared, still installed
      // (`state: "ok"`), no `lastAuthError` — a successful resolution. The mock is
      // phase-driven and we drive the resolving refetch by invalidating the
      // single-row query, so the transition is deterministic (no dependence on the
      // wall-clock poll cadence).
      const cleanClient: HubClient = { ...clientBase, capabilities: {} };
      const pendingClient: HubClient = {
        ...clientBase,
        capabilities: {
          "claude-code": {
            state: "ok",
            available: true,
            detectedAt: NOW,
            pendingAuth: { method: "browser", expiresAt: new Date(Date.now() + 60_000).toISOString() },
          },
        },
      };
      const signedInClient: HubClient = {
        ...clientBase,
        capabilities: { "claude-code": { state: "ok", available: true, detectedAt: NOW } },
      };
      let phase: "clean" | "pending" | "signed-in" = "clean";
      activityMocks.getClient.mockImplementation(() => {
        if (phase === "clean") return Promise.resolve(cleanClient);
        if (phase === "pending") return Promise.resolve(pendingClient);
        return Promise.resolve(signedInClient);
      });

      const { container, root, queryClient } = await renderDom(<ChatView agentId="agent-1" chatId="chat-1" />, (qc) => {
        qc.setQueryData(
          ["chat-session-events", "chat-1"],
          chatSessionEvents({ agentId: "agent-1", events: credentialErrorEvents("agent-1") }),
        );
      });

      await waitForCondition(
        () => buttonByText(container, "Connect Claude Code") !== null,
        "Expected the in-chat login button before sign-in",
      );
      // The click's refetch picks up the launched (pending) login.
      phase = "pending";
      await click(buttonByText(container, "Connect Claude Code"));
      await waitForCondition(
        () => container.textContent?.includes("sign-in page is opening") ?? false,
        "Expected the in-flight (pending) login state while the daemon drives sign-in",
      );

      // The daemon completes the login and re-probes: the resolving refetch
      // delivers the signed-in entry. Drive it deterministically by invalidating
      // the single-row query the button reads from.
      phase = "signed-in";
      await act(async () => {
        await queryClient.invalidateQueries({ queryKey: ["clients", "single", "client-1"] });
      });
      await waitForCondition(
        () => container.textContent?.includes("Signed in to Claude Code") ?? false,
        "Expected the terminal signed-in affordance after a successful login",
      );
      // And the Connect button must be gone — no re-invitation to log in.
      expect(buttonByText(container, "Connect Claude Code")).toBeNull();

      await act(async () => root.unmount());
    });
  });

  it("does not re-render old message markdown when the composer draft changes", async () => {
    const { ChatView } = await import("../chat-view.js");
    const page = messages([
      message({
        id: "stable-markdown",
        senderId: "agent-1",
        content: "Stable **markdown** body for render isolation.",
        source: "api",
        createdAt: "2026-05-28T12:00:00.000Z",
      }),
    ]);
    const { container, root } = await renderDom(
      <ChatView agentId="agent-1" chatId="chat-1" />,
      (queryClient) => seedChat(queryClient, chatDetail(), page),
      "/",
    );

    await waitForText(container, "Stable");
    await flush();
    markdownMocks.render.mockClear();

    const textarea = container.querySelector<HTMLTextAreaElement>("textarea");
    if (!textarea) throw new Error("Composer textarea missing");
    await setValue(textarea, "typing in the composer");

    expect(markdownMocks.render).not.toHaveBeenCalled();
    await act(async () => root.unmount());
  });

  it("renders sent mentions with displayName while preserving the stored handle and refreshes after rename", async () => {
    const { ChatView } = await import("../chat-view.js");
    const numericHuman = participant({
      agentId: "human-agent-alice",
      type: "human",
      name: "1736192959",
      displayName: "李坤阳",
    });
    const detail = chatDetail({
      participants: [
        participant({ agentId: "human-agent-self", type: "human", name: "gandy", displayName: "Gandy" }),
        numericHuman,
        participant({ agentId: "agent-1", name: "nova", displayName: "Nova" }),
      ],
    });
    const body = "请 @1736192959 处理";
    const page = messages([
      message({
        id: "display-name-mention",
        senderId: "agent-1",
        content: body,
        metadata: { mentions: [numericHuman.agentId] },
        source: "api",
      }),
    ]);
    const { container, queryClient, root } = await renderDom(
      <ChatView agentId="agent-1" chatId="chat-1" />,
      (client) => seedChat(client, detail, page),
      "/",
    );

    await waitForText(container, "@李坤阳");
    const chip = container.querySelector<HTMLElement>('.mention-chip[data-mention-name="1736192959"]');
    expect(chip?.textContent).toBe("@李坤阳");
    expect(chip?.getAttribute("title")).toBe("@李坤阳 (@1736192959)");
    expect(chip?.getAttribute("aria-label")).toBe("@李坤阳 (@1736192959)");
    expect(markdownMocks.render).toHaveBeenCalledWith(body);
    expect(chatMocks.sendChatMessage).not.toHaveBeenCalled();

    await act(async () => {
      queryClient.setQueryData(["chat-detail", "chat-1"], {
        ...detail,
        participants: detail.participants.map((row) =>
          row.agentId === numericHuman.agentId ? { ...row, displayName: "李坤阳（新）" } : row,
        ),
      });
    });
    await waitForText(container, "@李坤阳（新）");
    expect(chip?.textContent).toBe("@李坤阳（新）");

    await act(async () => root.unmount());
  });

  it("does not reassign a historical mention when its canonical handle is reused", async () => {
    const { ChatView } = await import("../chat-view.js");
    const currentOwner = participant({
      agentId: "agent-new-owner",
      name: "reused-handle",
      displayName: "New Owner",
    });
    const detail = chatDetail({
      participants: [
        participant({ agentId: "human-agent-self", type: "human", name: "gandy", displayName: "Gandy" }),
        currentOwner,
        participant({ agentId: "agent-1", name: "nova", displayName: "Nova" }),
      ],
    });
    const page = messages([
      message({
        id: "historical-handle-owner",
        senderId: "agent-1",
        content: "旧消息 @reused-handle",
        metadata: {
          mentions: ["agent-deleted-owner"],
          // System routing can point at the new owner for reasons unrelated to
          // this token. Only the explicit token-to-ID mapping may relabel it.
          addressedAgentIds: [currentOwner.agentId],
        },
        source: "api",
      }),
      message({
        id: "current-handle-owner",
        senderId: "agent-1",
        content: "新消息 @reused-handle",
        metadata: { mentions: [currentOwner.agentId] },
        source: "api",
      }),
    ]);
    const { container, root } = await renderDom(
      <ChatView agentId="agent-1" chatId="chat-1" />,
      (client) => seedChat(client, detail, page),
      "/",
    );

    await waitForText(container, "@New Owner");
    const historical = container.querySelector<HTMLElement>('[data-message-id="historical-handle-owner"]');
    const current = container.querySelector<HTMLElement>('[data-message-id="current-handle-owner"]');
    expect(historical?.textContent).toContain("@reused-handle");
    expect(historical?.querySelector(".mention-chip")).toBeNull();
    expect(current?.textContent).toContain("@New Owner");
    expect(current?.querySelector('.mention-chip[data-mention-agent-id="agent-new-owner"]')).not.toBeNull();

    await act(async () => root.unmount());
  });

  it("disambiguates one persisted recipient against duplicate display names in the full chat roster", async () => {
    const { ChatView } = await import("../chat-view.js");
    const duplicateLabel = "Sam with an intentionally long shared display name for narrow screens";
    const alice = participant({ agentId: "agent-alice-sam", name: "alice-sam", displayName: duplicateLabel });
    const bob = participant({ agentId: "agent-bob-sam", name: "bob-sam", displayName: duplicateLabel });
    const detail = chatDetail({
      participants: [
        participant({ agentId: "human-agent-self", type: "human", name: "gandy", displayName: "Gandy" }),
        alice,
        bob,
        participant({ agentId: "agent-1", name: "nova", displayName: "Nova" }),
      ],
    });
    const page = messages([
      message({
        id: "duplicate-display-single-recipient",
        senderId: "agent-1",
        content: "请 @alice-sam 处理",
        metadata: { mentions: [alice.agentId] },
        source: "api",
      }),
    ]);
    const { container, root } = await renderDom(
      <ChatView agentId="agent-1" chatId="chat-1" />,
      (client) => seedChat(client, detail, page),
      "/",
    );

    await waitForText(container, duplicateLabel);
    const chip = container.querySelector<HTMLElement>('.mention-chip[data-mention-name="alice-sam"]');
    expect(chip?.querySelector(".mention-chip-display")?.textContent).toBe(`@${duplicateLabel}`);
    expect(chip?.querySelector(".mention-chip-handle")?.textContent).toBe("(@alice-sam)");
    expect(chip?.getAttribute("title")).toBe(`@${duplicateLabel} (@alice-sam)`);
    expect(container.querySelector('.mention-chip[data-mention-name="bob-sam"]')).toBeNull();

    await act(async () => root.unmount());
  });

  it("copies canonical handles when copy targets the composer or body, including cross-message rich text", async () => {
    const { ChatView } = await import("../chat-view.js");
    const numericHuman = participant({
      agentId: "human-agent-alice",
      type: "human",
      name: "1736192959",
      displayName: "李坤阳",
    });
    const detail = chatDetail({
      participants: [
        participant({ agentId: "human-agent-self", type: "human", name: "gandy", displayName: "Gandy" }),
        numericHuman,
        participant({ agentId: "agent-1", name: "nova", displayName: "Nova" }),
      ],
    });
    const page = messages([
      message({
        id: "copy-display-name-1",
        senderId: "human-agent-self",
        content: "**请** 先看  \n下一行 @1736192959\n\n第二段 [查看详情](https://example.com)",
        metadata: { mentions: [numericHuman.agentId] },
        createdAt: "2026-05-28T11:55:00.000Z",
      }),
      message({
        id: "copy-display-name-2",
        senderId: "agent-1",
        content: "然后通知 @nova",
        metadata: { mentions: ["agent-1"] },
        source: "api",
        createdAt: "2026-05-28T11:56:00.000Z",
      }),
    ]);
    const { container, root } = await renderDom(
      <ChatView agentId="agent-1" chatId="chat-1" />,
      (client) => seedChat(client, detail, page),
      "/",
    );

    await waitForText(container, "@李坤阳");
    const firstBody = container.querySelector<HTMLElement>('[data-message-id="copy-display-name-1"] div.text-body');
    const firstParagraph = container.querySelector<HTMLElement>('[data-message-id="copy-display-name-1"] p');
    const secondParagraph = container.querySelector<HTMLElement>('[data-message-id="copy-display-name-2"] p');
    const composer = container.querySelector<HTMLTextAreaElement>("textarea");
    const timeline = container.querySelector<HTMLElement>("[data-chat-timeline-scroll]");
    const numericChip = container.querySelector<HTMLElement>('.mention-chip[data-mention-name="1736192959"]');
    if (!firstBody || !firstParagraph || !secondParagraph || !composer || !timeline || !numericChip) {
      throw new Error("Expected copy fixtures and composer");
    }

    const selection = window.getSelection();
    const singleRange = document.createRange();
    singleRange.selectNodeContents(firstBody);
    // Real non-editable copy keeps the previously focused composer as the
    // event target while the mouse selection lives in the timeline.
    composer.focus();
    selection?.removeAllRanges();
    selection?.addRange(singleRange);
    expect(selection?.toString()).toContain("@李坤阳");
    expect(timeline.contains(singleRange.commonAncestorContainer)).toBe(true);
    expect(singleRange.intersectsNode(numericChip)).toBe(true);

    const singleCopy = dispatchCopy(composer);
    expect(singleCopy.event.defaultPrevented).toBe(true);
    expect(singleCopy.payloads.get("text/plain")).toContain("请 先看");
    expect(singleCopy.payloads.get("text/plain")).toContain("下一行 @1736192959");
    expect(singleCopy.payloads.get("text/plain")).toContain("第二段 查看详情");
    expect(singleCopy.payloads.get("text/html")).toContain("<strong>请</strong>");
    expect(singleCopy.payloads.get("text/html")).toContain("@1736192959");
    expect(singleCopy.payloads.get("text/html")).toContain("https://example.com");
    expect(singleCopy.payloads.get("text/html")).not.toContain("李坤阳");

    const crossRange = document.createRange();
    crossRange.setStart(firstBody, 0);
    crossRange.setEnd(secondParagraph, secondParagraph.childNodes.length);
    selection?.removeAllRanges();
    selection?.addRange(crossRange);

    const crossCopy = dispatchCopy(document.body);
    expect(crossCopy.event.defaultPrevented).toBe(true);
    expect(crossCopy.payloads.get("text/plain")).toContain("@1736192959");
    expect(crossCopy.payloads.get("text/plain")).toContain("@nova");
    expect(crossCopy.payloads.get("text/plain")).not.toContain("@李坤阳");
    expect(crossCopy.payloads.get("text/html")).toContain("<strong>请</strong>");
    expect(crossCopy.payloads.get("text/html")).toContain("@1736192959");
    expect(crossCopy.payloads.get("text/html")).toContain("@nova");
    expect(crossCopy.payloads.get("text/html")).not.toContain("mention-chip");

    const outsideAfter = document.createElement("p");
    outsideAfter.textContent = "outside after";
    document.body.append(outsideAfter);
    const outsideAfterText = outsideAfter.firstChild;
    if (!outsideAfterText) throw new Error("Expected outside-after text");
    const insideToOutside = document.createRange();
    insideToOutside.setStart(firstParagraph, 0);
    insideToOutside.setEnd(outsideAfterText, outsideAfterText.textContent?.length ?? 0);
    selection?.removeAllRanges();
    selection?.addRange(insideToOutside);

    const insideToOutsideCopy = dispatchCopy(document.body);
    expect(insideToOutsideCopy.event.defaultPrevented).toBe(true);
    expect(insideToOutsideCopy.payloads.get("text/plain")).toContain("@1736192959");
    expect(insideToOutsideCopy.payloads.get("text/plain")).toContain("outside after");
    expect(insideToOutsideCopy.payloads.get("text/html")).not.toContain("李坤阳");

    const outsideBefore = document.createElement("p");
    outsideBefore.textContent = "outside before";
    document.body.insertBefore(outsideBefore, document.body.firstChild);
    const outsideBeforeText = outsideBefore.firstChild;
    if (!outsideBeforeText) throw new Error("Expected outside-before text");
    const outsideToInside = document.createRange();
    outsideToInside.setStart(outsideBeforeText, 0);
    outsideToInside.setEnd(secondParagraph, secondParagraph.childNodes.length);
    selection?.removeAllRanges();
    selection?.addRange(outsideToInside);

    const outsideToInsideCopy = dispatchCopy(composer);
    expect(outsideToInsideCopy.event.defaultPrevented).toBe(true);
    expect(outsideToInsideCopy.payloads.get("text/plain")).toContain("outside before");
    expect(outsideToInsideCopy.payloads.get("text/plain")).toContain("@1736192959");
    expect(outsideToInsideCopy.payloads.get("text/plain")).toContain("@nova");
    expect(outsideToInsideCopy.payloads.get("text/html")).not.toContain("mention-chip");

    selection?.removeAllRanges();
    outsideBefore.remove();
    outsideAfter.remove();
    await act(async () => root.unmount());
  });

  it("renders a request as a normal message and does not re-render its body when a reply arrives", async () => {
    const { ChatView } = await import("../chat-view.js");
    const request = message({
      id: "req-render",
      senderId: "agent-1",
      format: "request",
      content: "Lifecycle **body** stays memoized.",
      metadata: {
        mentions: ["human-agent-self"],
        request: {
          options: [
            { label: "Proceed", description: "go ahead" },
            { label: "Hold", description: "wait" },
          ],
        },
        attachments: [
          {
            attachmentId: "11111111-1111-4111-8111-111111111111",
            kind: "image",
            mimeType: "image/png",
            filename: "lifecycle.png",
            size: 42,
          },
          {
            attachmentId: "11111111-1111-4111-8111-111111111112",
            kind: "image",
            mimeType: "image/jpeg",
            filename: "lifecycle-alt.jpg",
            size: 84,
          },
        ],
      },
      source: "api",
      createdAt: "2026-05-28T12:00:00.000Z",
    });
    const answer = message({
      id: "req-answer",
      senderId: "human-agent-self",
      format: "markdown",
      content: "Proceed sounds good to me.",
      metadata: { resolves: { request: "req-render", kind: "answered" } },
      inReplyTo: "req-render",
      source: "web",
      createdAt: "2026-05-28T12:01:00.000Z",
    });
    const { container, queryClient, root } = await renderDom(
      <ChatView agentId="agent-1" chatId="chat-1" />,
      (client) => seedChat(client, chatDetail(), messages([request])),
      "/",
    );

    // The request renders as a normal message body — no status-label chrome
    // (no "RESOLVED"/"OPEN" badge), since the timeline no longer special-cases
    // `format="request"`. Viewer agent-1 is not the target, so there is no
    // answer overlay either.
    await waitForText(container, "Lifecycle");
    await waitForCondition(
      () => container.querySelector('button[aria-label="Open image lifecycle.png"]') !== null,
      "request image thumbnail did not render",
    );
    const requestRow = container.querySelector('[data-message-id="req-render"]');
    expect(
      [...(requestRow?.querySelectorAll('button[aria-label^="Open image "]') ?? [])].map((button) =>
        button.getAttribute("aria-label"),
      ),
    ).toEqual(["Open image lifecycle.png", "Open image lifecycle-alt.jpg"]);
    expect(container.textContent).not.toContain("RESOLVED");
    await flush();
    markdownMocks.render.mockClear();

    await act(async () => {
      queryClient.setQueryData(["chat-messages", "chat-1"], messages([request, answer]));
    });
    await flush();

    // The reply arrives as its own message; the request row is memoized and its
    // markdown body is not re-rendered.
    await waitForText(container, "Proceed sounds good to me.");
    expect(markdownMocks.render).not.toHaveBeenCalledWith("Lifecycle **body** stays memoized.");
    await act(async () => root.unmount());
  });

  it("shows agent mention capsules for Ask agent, its response, and the resolving answer", async () => {
    const { ChatView } = await import("../chat-view.js");
    const request = message({
      id: "req-tagged-history",
      senderId: "agent-1",
      format: "request",
      content: "Which rollout should we choose?",
      metadata: { mentions: ["human-agent-self"], request: { multiSelect: false } },
      source: "cli",
      createdAt: "2026-05-28T12:00:00.000Z",
    });
    const clarification = message({
      id: "clarification-tagged-history",
      senderId: "human-agent-self",
      content: "What is the migration risk?",
      metadata: {
        mentions: ["agent-1"],
        askAgent: { requestId: request.id, agentId: "agent-1" },
      },
      inReplyTo: request.id,
      source: "web",
      createdAt: "2026-05-28T12:01:00.000Z",
    });
    const clarificationReply = message({
      id: "clarification-reply-tagged-history",
      senderId: "agent-1",
      content: "@gandy Option B reduces the migration risk.",
      metadata: { mentions: ["human-agent-self"] },
      inReplyTo: clarification.id,
      source: "cli",
      createdAt: "2026-05-28T12:02:00.000Z",
    });
    const answer = message({
      id: "answer-tagged-history",
      senderId: "human-agent-self",
      content: "Proceed with option B.",
      metadata: {
        mentions: ["agent-1"],
        resolves: { request: request.id, kind: "answered" },
      },
      inReplyTo: request.id,
      source: "web",
      createdAt: "2026-05-28T12:03:00.000Z",
    });
    const { container, root } = await renderDom(
      <ChatView agentId="agent-1" chatId="chat-1" />,
      (client) => seedChat(client, chatDetail(), messages([request, clarification, clarificationReply, answer])),
      "/",
    );

    await waitForText(container, "Proceed with option B.");
    const requestRow = container.querySelector('[data-message-id="req-tagged-history"]');
    const clarificationRow = container.querySelector('[data-message-id="clarification-tagged-history"]');
    const replyRow = container.querySelector('[data-message-id="clarification-reply-tagged-history"]');
    const answerRow = container.querySelector('[data-message-id="answer-tagged-history"]');

    // A plain request is not relabelled. The two human request actions expose
    // their metadata-only route with a synthetic tag.
    expect(requestRow?.querySelector("[data-request-agent-tag]")).toBeNull();
    expect(
      clarificationRow?.querySelector('[data-request-agent-tag] .mention-chip[data-mention-agent-id="agent-1"]')
        ?.textContent,
    ).toBe("@Nova");
    expect(
      answerRow?.querySelector('[data-request-agent-tag] .mention-chip[data-mention-agent-id="agent-1"]')?.textContent,
    ).toBe("@Nova");

    // `chat send` already normalized the agent reply to a leading persisted
    // mention. It remains a single inline chip instead of gaining a duplicate
    // synthetic one.
    expect(replyRow?.querySelector("[data-request-agent-tag]")).toBeNull();
    expect(replyRow?.querySelectorAll('.mention-chip[data-mention-agent-id="human-agent-self"]')).toHaveLength(1);
    expect(replyRow?.querySelector(".mention-chip")?.textContent).toBe("@Gandy");

    await act(async () => root.unmount());
  });

  // R3: opening an attachment preview (new `docChat` + `docAttachment` params)
  // collapses the right sidebar so the preview rail gets the slot, then restores
  // it when the preview params clear. Keys on the new params — before the fix
  // `hasDocPreview` still read the legacy `docPath`, so the collapse never fired.
  it("collapses the right sidebar while an attachment preview is open, restores after", async () => {
    const { ChatView } = await import("../chat-view.js");
    localStorage.setItem("first-tree:chat-right-sidebar:open:v1", "1");

    // With no doc-preview params the sidebar is open → Participants visible.
    const open = await renderDom(<ChatView agentId="agent-1" chatId="chat-1" />, undefined, "/");
    await waitForText(open.container, "Participants");
    await act(async () => open.root.unmount());

    // With the attachment-preview params present the sidebar collapses →
    // Participants no longer rendered even though localStorage says "open".
    const preview = await renderDom(
      <ChatView agentId="agent-1" chatId="chat-1" />,
      undefined,
      "/?docChat=chat-1&docMsg=msg-1&docAttachment=00000000-0000-4000-8000-000000000001",
    );
    await waitForText(preview.container, "Launch planning");
    await flush();
    expect(preview.container.textContent).not.toContain("Participants");
    await act(async () => preview.root.unmount());
  });

  it("self-only roster locks composer without destroying draft, then restores after peer returns", async () => {
    const { ChatView } = await import("../chat-view.js");
    localStorage.setItem("first-tree:chat-right-sidebar:open:v1", "1");
    const history = message({
      id: "msg-before-remove",
      senderId: "human-agent-self",
      content: "hello before last-other remove",
      metadata: { mentions: ["human-agent-alice"] },
    });
    const withPeer = chatDetail({
      participants: [
        participant({ agentId: "human-agent-self", type: "human", name: "gandy", displayName: "Gandy" }),
        participant({ agentId: "human-agent-alice", type: "human", name: "alice", displayName: "Alice" }),
      ],
    });
    const solo = chatDetail({
      participants: [participant({ agentId: "human-agent-self", type: "human", name: "gandy", displayName: "Gandy" })],
    });
    chatMocks.listChatMessages.mockResolvedValue(messages([history]));
    chatMocks.getChat.mockResolvedValue(withPeer);
    agentMocks.getAgentSkills.mockClear();

    const { container, queryClient, root } = await renderDom(
      <ChatView agentId="human-agent-alice" chatId="chat-1" initialChatDetail={withPeer} />,
      (qc) => seedChat(qc, withPeer, messages([history])),
      "/",
    );

    await waitForText(container, "hello before last-other remove");
    const textarea = container.querySelector<HTMLTextAreaElement>("textarea");
    if (!textarea) throw new Error("Composer textarea missing");
    await setValue(textarea, "keep this draft after remove");
    expect(textarea.value).toBe("keep this draft after remove");
    agentMocks.getAgentSkills.mockClear();
    chatMocks.sendChatMessage.mockClear();
    agentStatusMocks.fetchChatAgentStatuses.mockClear();

    // Roster shrinks to self-only (Remove last other) — draft must survive.
    chatMocks.getChat.mockResolvedValue(solo);
    await act(async () => {
      queryClient.setQueryData(["chat-detail", "chat-1"], solo);
    });
    await flush();

    await waitForText(container, "Add a participant to send a message");
    expect(container.textContent).toContain("Your draft is kept until you add someone.");
    expect(container.textContent).toContain("Participants");
    expect(container.textContent).not.toContain("Resolving participants");
    expect(container.textContent).not.toContain("Hi Gandy!");
    expect(container.querySelector("textarea")).toBeNull();
    expect(container.querySelector('button[aria-label="Send"]')).toBeNull();
    expect(container.querySelector('[data-composer-state="no-recipient"]')).not.toBeNull();
    expect(chatMocks.sendChatMessage).not.toHaveBeenCalled();
    expect(agentMocks.getAgentSkills).not.toHaveBeenCalled();
    expect(agentStatusMocks.fetchChatAgentStatuses).not.toHaveBeenCalled();
    expect(container.textContent).not.toMatch(/\bPause\b/);
    expect(container.textContent).not.toMatch(/\bResume\b/);

    // Peer returns (Add participant) — draft comes back in the editable composer.
    // Add another human still leaves agents=[] — no agent-status poll.
    agentStatusMocks.fetchChatAgentStatuses.mockClear();
    chatMocks.getChat.mockResolvedValue(withPeer);
    await act(async () => {
      queryClient.setQueryData(["chat-detail", "chat-1"], withPeer);
    });
    await flush();
    await waitForCondition(() => container.querySelector("textarea") != null, "Expected composer restored");
    const restored = container.querySelector<HTMLTextAreaElement>("textarea");
    expect(restored?.value).toBe("keep this draft after remove");
    expect(container.querySelector('[data-composer-state="no-recipient"]')).toBeNull();
    expect(agentStatusMocks.fetchChatAgentStatuses).not.toHaveBeenCalled();

    await act(async () => root.unmount());
  });

  it("sends text, blocks unaddressed image sends, then sends uploaded image batches", async () => {
    const { ChatView } = await import("../chat-view.js");
    const { container, root } = await renderDom(<ChatView agentId="agent-1" chatId="chat-1" />, undefined, "/");

    const textarea = container.querySelector<HTMLTextAreaElement>("textarea");
    if (!textarea) throw new Error("Composer textarea missing");
    // Group chat, no @mention yet: the placeholder carries the rule, and the
    // tip bubble is NOT shown until a blocked send is actually attempted.
    expect(textarea.placeholder).toContain("In a group, @mention who this is for");
    expect(container.textContent).not.toContain("or no one gets this");

    // Blocked TEXT send: typing without an @mention then pressing Enter pops the
    // tip bubble and sends nothing. The send button stays clickable (not
    // `disabled`) so a click would trigger the same tip.
    await setValue(textarea, "no recipient here");
    expect(container.querySelector<HTMLButtonElement>('button[aria-label="Send"]')?.disabled).toBe(false);
    await act(async () => {
      textarea.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    });
    await flush();
    await waitForText(container, "@mention someone, or no one gets this");
    expect(chatMocks.sendChatMessage).not.toHaveBeenCalled();

    await setValue(textarea, "Please review @nova");
    await click(container.querySelector('button[aria-label="Send"]'));
    await waitForCondition(() => chatMocks.sendChatMessage.mock.calls.length > 0, "Expected text send");
    expect(chatMocks.sendChatMessage).toHaveBeenCalledWith("chat-1", "Please review @nova", ["agent-1"]);

    await setValue(textarea, "");
    const file = new File(["abc"], "preview.png", { type: "image/png" });
    const fileInput = container.querySelector<HTMLInputElement>('input[type="file"]');
    if (!fileInput) throw new Error("File input missing");
    await changeFiles(fileInput, [file]);
    await act(async () => {
      textarea.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    });
    await flush();
    // Image-only send with no @mention is blocked too; the tip bubble pops for
    // both text and image attempts.
    await waitForText(container, "@mention someone, or no one gets this");
    expect(chatMocks.sendFileMessageBatch).not.toHaveBeenCalled();

    await setValue(textarea, "@design image attached");
    await click(container.querySelector('button[aria-label="Send"]'));
    await waitForCondition(() => chatMocks.sendFileMessageBatch.mock.calls.length > 0, "Expected image send");
    expect(attachmentMocks.uploadAttachment).toHaveBeenCalledWith(file);
    expect(chatMocks.sendFileMessageBatch).toHaveBeenCalledWith(
      "chat-1",
      {
        caption: "@design image attached",
        attachments: [{ imageId: "uploaded-image", mimeType: "image/png", filename: "preview.png", size: 3 }],
      },
      { mentions: ["agent-2"] },
      // No live request in this chat → nothing to thread under; no Team
      // Skill provenance either, so the trailing opts bag is empty.
      {},
    );

    await act(async () => root.unmount());
  });

  it("clears the mention tip when switching to another group chat", async () => {
    const { ChatView } = await import("../chat-view.js");
    const { container, queryClient, root } = await renderDom(
      <ChatView agentId="agent-1" chatId="chat-1" />,
      undefined,
      "/",
    );

    const textarea = container.querySelector<HTMLTextAreaElement>("textarea");
    if (!textarea) throw new Error("Composer textarea missing");
    // Trigger the tip in chat-1 (group, no @mention).
    await setValue(textarea, "no recipient");
    await act(async () => {
      textarea.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    });
    await flush();
    await waitForText(container, "@mention someone, or no one gets this");

    // Switch to another group chat on the SAME long-lived ChatView instance
    // (identical provider wrappers → React updates the chatId prop rather than
    // remounting). The tip must not leak into the new chat before any blocked
    // send there.
    await act(async () => {
      root.render(
        <MemoryRouter initialEntries={["/"]}>
          <QueryClientProvider client={queryClient}>
            <ToastProvider>
              <ChatView agentId="agent-1" chatId="chat-2" />
            </ToastProvider>
          </QueryClientProvider>
        </MemoryRouter>,
      );
    });
    // Pre-paint: the render gate (tip's origin chat ≠ viewed chat) keeps the
    // stale bubble from painting even before effects flush — assert right after
    // the commit, with no intervening flush.
    expect(container.textContent).not.toContain("@mention someone, or no one gets this");
    await flush();
    expect(container.textContent).not.toContain("@mention someone, or no one gets this");

    await act(async () => root.unmount());
  });

  it("removes a focused composer when a request arrives and clean-resolves through takeover", async () => {
    const { ChatView } = await import("../chat-view.js");
    const dockMessages = messages([
      message({
        id: "req-1",
        senderId: "agent-1",
        format: "request",
        content: "Pick the deploy color.",
        metadata: {
          mentions: ["human-agent-self"],
          request: {
            options: [
              { label: "Blue-green", description: "blue-green deploy" },
              { label: "Rolling update", description: "rolling deploy" },
            ],
          },
        },
        createdAt: "2026-05-28T12:00:00.000Z",
      }),
    ]);
    const { container, queryClient, root } = await renderDom(
      <ChatView agentId="agent-1" chatId="chat-1" />,
      (client) => seedChat(client, chatDetail(), messages([])),
      "/",
    );

    const textarea = container.querySelector<HTMLTextAreaElement>("textarea");
    if (!textarea) throw new Error("Composer textarea missing");
    await act(async () => {
      textarea.dispatchEvent(new FocusEvent("focusin", { bubbles: true, cancelable: true }));
    });
    await flush();
    await waitForCondition(() => textarea.value === "@", "Expected group focus to prime @ before dock data arrives");

    await act(async () => {
      queryClient.setQueryData(["chat-messages", "chat-1"], dockMessages);
    });
    await flush();
    await waitForText(container, "Submit");
    expect(textarea.isConnected).toBe(false);
    expect(container.querySelector("[data-ask-blocked-composer]")).not.toBeNull();
    expect(document.activeElement).toBe(container.querySelector('[role="dialog"]'));

    // A queued background-composer Enter cannot send an ordinary message after
    // takeover: that composer is gone and focus belongs to the request dialog.
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    });
    expect(chatMocks.sendChatMessage).not.toHaveBeenCalled();

    // Answering happens only in the overlay.
    await click(askOption(container, "Blue-green"));
    await click(buttonByText(container, "Submit"));
    await waitForCondition(() => chatMocks.sendChatMessage.mock.calls.length > 0, "Expected option answer send");
    // The answer is the selected option label, resolving the question.
    expect(chatMocks.sendChatMessage).toHaveBeenCalledWith("chat-1", "Blue-green", ["agent-1"], {
      inReplyTo: "req-1",
      resolves: { request: "req-1", kind: "answered" },
    });

    await act(async () => root.unmount());
  });

  it("resolves an options answer via the overlay Reply button (gated on a selection)", async () => {
    const { ChatView } = await import("../chat-view.js");
    const dockMessages = messages([
      message({
        id: "req-enter",
        senderId: "agent-1",
        format: "request",
        content: "Pick the deploy color.",
        metadata: {
          mentions: ["human-agent-self"],
          request: {
            options: [
              { label: "Blue-green", description: "blue-green deploy" },
              { label: "Rolling update", description: "rolling deploy" },
            ],
          },
        },
        createdAt: "2026-05-28T12:00:00.000Z",
      }),
    ]);
    const { container, queryClient, root } = await renderDom(
      <ChatView agentId="agent-1" chatId="chat-1" />,
      (client) => seedChat(client, chatDetail(), messages([])),
      "/",
    );

    await act(async () => {
      queryClient.setQueryData(["chat-messages", "chat-1"], dockMessages);
    });
    await flush();
    await waitForText(container, "Submit");

    // Reply is disabled until an option is picked, then resolves with the label.
    expect(buttonByText(container, "Submit")?.disabled).toBe(true);
    await click(askOption(container, "Blue-green"));
    expect(buttonByText(container, "Submit")?.disabled).toBe(false);
    await click(buttonByText(container, "Submit"));
    await waitForCondition(
      () => chatMocks.sendChatMessage.mock.calls.length > 0,
      "Expected the options answer to resolve",
    );
    expect(chatMocks.sendChatMessage).toHaveBeenCalledWith("chat-1", "Blue-green", ["agent-1"], {
      inReplyTo: "req-enter",
      resolves: { request: "req-enter", kind: "answered" },
    });

    await act(async () => root.unmount());
  });

  it("surfaces a buried open ask (outside the message window) via the open-requests source", async () => {
    const { ChatView } = await import("../chat-view.js");
    // An open ask that is NOT in the loaded 50-message timeline — only the
    // window-independent open-requests source knows about it.
    const buriedAsk = message({
      id: "req-buried",
      senderId: "agent-1",
      format: "request",
      content: "Approve the migration?",
      metadata: {
        mentions: ["human-agent-self"],
        request: {
          options: [
            { label: "Approve", description: "go" },
            { label: "Hold", description: "wait" },
          ],
        },
      },
      createdAt: "2026-05-28T11:00:00.000Z",
    });
    chatMocks.listChatOpenRequests.mockResolvedValue({ items: [buriedAsk] });

    const { container, queryClient, root } = await renderDom(
      <ChatView agentId="agent-1" chatId="chat-1" />,
      // Timeline seeded WITHOUT the request — it is past the loaded window.
      (client) => seedChat(client, chatDetail(), messages([])),
      "/",
    );

    await act(async () => {
      queryClient.setQueryData(["chat-open-requests", "chat-1"], { items: [buriedAsk] });
    });
    await flush();

    // The blocking takeover still appears, driven by the open-requests source.
    await waitForText(container, "Approve the migration?");
    expect(buttonByText(container, "Submit")).toBeTruthy();
    expect(buttonByText(container, "Skip")).toBeTruthy();

    await act(async () => root.unmount());
  });

  it("supports request inspection without enabling ordinary chat sends", async () => {
    const { ChatView } = await import("../chat-view.js");
    const firstAsk = message({
      id: "req-inspect-1",
      senderId: "agent-1",
      format: "request",
      content: "Approve the migration?",
      metadata: { mentions: ["human-agent-self"], request: { multiSelect: false } },
      createdAt: "2026-05-28T11:00:00.000Z",
    });
    const secondAsk = message({
      id: "req-inspect-2",
      senderId: "agent-1",
      format: "request",
      content: "Choose the rollout window.",
      metadata: { mentions: ["human-agent-self"], request: { multiSelect: false } },
      createdAt: "2026-05-28T11:30:00.000Z",
    });
    const laterMessage = message({
      id: "msg-after-asks",
      senderId: "agent-1",
      content: "Extra evidence after both questions.",
      createdAt: "2026-05-28T11:45:00.000Z",
    });
    chatMocks.listChatOpenRequests.mockResolvedValue({ items: [firstAsk, secondAsk] });

    const { container, root } = await renderDom(
      <ChatView agentId="agent-1" chatId="chat-1" />,
      (client) => {
        seedChat(client, chatDetail(), messages([firstAsk, secondAsk, laterMessage]));
        client.setQueryData(["chat-open-requests", "chat-1"], { items: [firstAsk, secondAsk] });
      },
      "/?showAsk=false",
    );

    expect(container.querySelector('[role="dialog"][aria-label^="Question"]')).toBeNull();
    expect(container.textContent).toContain("Approve the migration?");
    expect(container.textContent).toContain("Choose the rollout window.");
    expect(container.textContent).toContain("Extra evidence after both questions.");
    expect(container.querySelector("textarea")).toBeNull();

    const blockedComposer = container.querySelector<HTMLButtonElement>("[data-inspect-ask-composer]");
    expect(blockedComposer).not.toBeNull();
    expect(blockedComposer?.textContent).toContain("2 pending questions");
    await click(blockedComposer);
    await waitForText(container, "Submit");
    expect(container.querySelector('[role="dialog"][aria-label^="Question"]')).not.toBeNull();
    expect(container.textContent).toContain("Approve the migration?");

    await click(container.querySelector('button[aria-label="Show earlier chat"]'));
    expect(container.querySelector('[role="dialog"][aria-label^="Question"]')).toBeNull();
    expect(container.querySelector("[data-inspect-ask-composer]")?.textContent).toContain("2 pending questions");
    expect(chatMocks.sendChatMessage).not.toHaveBeenCalled();

    await act(async () => root.unmount());
  });

  it("keeps the composer fail-closed while the open-requests source is pending in inspect mode", async () => {
    const { ChatView } = await import("../chat-view.js");
    // The request is past the loaded 50-message window, so ONLY the pending
    // open-requests query can know about it. Until that query confirms the
    // chat's state, an empty derivation is unknown — not "no requests".
    const buriedAsk = message({
      id: "req-inspect-pending",
      senderId: "agent-1",
      format: "request",
      content: "Approve the migration?",
      metadata: { mentions: ["human-agent-self"], request: { multiSelect: false } },
      createdAt: "2026-05-28T11:00:00.000Z",
    });
    let resolveOpenRequests!: (value: { items: MessageWithDelivery[] }) => void;
    chatMocks.listChatOpenRequests.mockImplementation(
      () =>
        new Promise<{ items: MessageWithDelivery[] }>((resolve) => {
          resolveOpenRequests = resolve;
        }),
    );

    const { container, root } = await renderDom(
      <ChatView agentId="agent-1" chatId="chat-1" />,
      (client) => seedChat(client, chatDetail(), messages([])),
      "/?showAsk=false",
    );

    // Pending: the stable composer remains editable, but sending stays
    // fail-closed until this viewing has a fresh open-request snapshot.
    const pendingTextarea = container.querySelector<HTMLTextAreaElement>("textarea");
    if (!pendingTextarea) throw new Error("Composer textarea missing");
    expect(container.querySelector("[data-inspect-ask-composer]")).toBeNull();
    await setValue(pendingTextarea, "Draft while questions load");
    expect(pendingTextarea.value).toBe("Draft while questions load");
    expect(
      container.querySelector<HTMLButtonElement>('button[aria-label="Checking for open questions"]')?.disabled,
    ).toBe(true);
    expect(container.textContent).not.toContain("Checking for open questions");
    expect(chatMocks.sendChatMessage).not.toHaveBeenCalled();

    // The query confirms the still-open request: the reopen affordance
    // takes over the stable composer.
    await act(async () => {
      resolveOpenRequests({ items: [buriedAsk] });
    });
    await waitForText(container, "1 pending question");
    expect(container.querySelector("[data-inspect-ask-composer]")).not.toBeNull();
    expect(container.querySelector("textarea")).toBeNull();
    expect(chatMocks.sendChatMessage).not.toHaveBeenCalled();

    await act(async () => root.unmount());
  });

  it("keeps the ordinary composer and shows a compact retry when the open-requests source fails", async () => {
    const { ChatView } = await import("../chat-view.js");
    chatMocks.listChatOpenRequests.mockRejectedValue(new Error("open requests unavailable"));

    const { container, root } = await renderDom(
      <ChatView agentId="agent-1" chatId="chat-1" />,
      (client) => seedChat(client, chatDetail(), messages([])),
      "/?showAsk=false",
    );

    // Failed: the draft surface stays stable, while the send gate and compact
    // recovery row explain why this chat cannot send yet.
    await waitForText(container, "Couldn’t check for open questions.");
    const failedTextarea = container.querySelector<HTMLTextAreaElement>("textarea");
    if (!failedTextarea) throw new Error("Composer textarea missing");
    await setValue(failedTextarea, "Keep this draft while retrying");
    expect(container.querySelector("[data-open-requests-error]")).not.toBeNull();
    expect(
      container.querySelector<HTMLButtonElement>(
        'button[aria-label="Send unavailable — couldn’t check for open questions"]',
      )?.disabled,
    ).toBe(true);
    expect(chatMocks.sendChatMessage).not.toHaveBeenCalled();

    // Retry succeeds with a CONFIRMED zero: the recovery row clears and the
    // stable composer remains in place.
    chatMocks.listChatOpenRequests.mockResolvedValue({ items: [] });
    await click(buttonByText(container, "Retry"));
    await waitForCondition(() => container.querySelector("[data-open-requests-error]") === null, "retry row to clear");
    expect(container.querySelector("textarea")).toBe(failedTextarea);
    expect(failedTextarea.value).toBe("Keep this draft while retrying");

    await act(async () => root.unmount());
  });

  it("treats a cached empty open-requests result as unconfirmed until this mount's fetch succeeds", async () => {
    const { ChatView } = await import("../chat-view.js");
    const buriedAsk = message({
      id: "req-inspect-stale-cache",
      senderId: "agent-1",
      format: "request",
      content: "Approve the migration?",
      metadata: { mentions: ["human-agent-self"], request: { multiSelect: false } },
      createdAt: "2026-05-28T11:00:00.000Z",
    });
    let resolveOpenRequests!: (value: { items: MessageWithDelivery[] }) => void;
    chatMocks.listChatOpenRequests.mockImplementation(
      () =>
        new Promise<{ items: MessageWithDelivery[] }>((resolve) => {
          resolveOpenRequests = resolve;
        }),
    );

    const { container, root } = await renderDom(
      <ChatView agentId="agent-1" chatId="chat-1" />,
      (client) => {
        seedChat(client, chatDetail(), messages([]));
        // A previous visit's successful EMPTY result, now stale: a new open
        // request has since arrived outside the timeline window. TanStack
        // Query keeps status "success" for this row through the mount
        // refetch — the exact fail-open window this test pins shut.
        client.setQueryData(["chat-open-requests", "chat-1"], { items: [] });
        // The harness client uses staleTime: Infinity; production (staleTime 0)
        // refetches on mount, so mark the row stale to match.
        void client.invalidateQueries({ queryKey: ["chat-open-requests", "chat-1"] });
      },
      "/?showAsk=false",
    );

    // Stale cached zero may render the stable draft surface, but must NOT
    // enable ordinary sending before this viewing confirms the snapshot.
    expect(container.querySelector("textarea")).not.toBeNull();
    expect(container.querySelector("[data-inspect-ask-composer]")).toBeNull();
    expect(
      container.querySelector<HTMLButtonElement>('button[aria-label="Checking for open questions"]')?.disabled,
    ).toBe(true);
    expect(container.textContent).not.toContain("Checking for open questions");
    expect(chatMocks.listChatOpenRequests).toHaveBeenCalled();
    expect(chatMocks.sendChatMessage).not.toHaveBeenCalled();

    // This mount's fetch lands with the still-open request: only the reopen
    // affordance appears, never the ordinary composer.
    await act(async () => {
      resolveOpenRequests({ items: [buriedAsk] });
    });
    await waitForText(container, "1 pending question");
    expect(container.querySelector("[data-inspect-ask-composer]")).not.toBeNull();
    expect(container.querySelector("textarea")).toBeNull();
    expect(chatMocks.sendChatMessage).not.toHaveBeenCalled();

    await act(async () => root.unmount());
  });

  it("keeps fail-closed with a retryable error when the mount refetch of a cached zero fails", async () => {
    const { ChatView } = await import("../chat-view.js");
    chatMocks.listChatOpenRequests.mockRejectedValue(new Error("open requests unavailable"));

    const { container, root } = await renderDom(
      <ChatView agentId="agent-1" chatId="chat-1" />,
      (client) => {
        seedChat(client, chatDetail(), messages([]));
        client.setQueryData(["chat-open-requests", "chat-1"], { items: [] });
        void client.invalidateQueries({ queryKey: ["chat-open-requests", "chat-1"] });
      },
      "/?showAsk=false",
    );

    // The mount refetch fails while the stale cached zero keeps status
    // "success": the draft surface stays mounted, with a retryable error.
    await waitForText(container, "Couldn’t check for open questions.");
    expect(container.querySelector("textarea")).not.toBeNull();
    expect(container.querySelector("[data-open-requests-error]")).not.toBeNull();
    expect(chatMocks.sendChatMessage).not.toHaveBeenCalled();

    // Retry confirms a fresh zero in this mount: the recovery row clears.
    chatMocks.listChatOpenRequests.mockResolvedValue({ items: [] });
    await click(buttonByText(container, "Retry"));
    await waitForCondition(() => container.querySelector("[data-open-requests-error]") === null, "retry row to clear");
    expect(container.querySelector("textarea")).not.toBeNull();

    await act(async () => root.unmount());
  });

  it("keeps the ordinary composer fail-closed on the normal route while the open-requests source is pending", async () => {
    const { ChatView } = await import("../chat-view.js");
    // NO `showAsk` param: the normal chat route must fail closed too — a
    // buried request (outside the latest-50 window) is invisible to
    // `blockingMessages` until the open-requests query lands.
    const buriedAsk = message({
      id: "req-normal-pending",
      senderId: "agent-1",
      format: "request",
      content: "Approve the migration?",
      metadata: { mentions: ["human-agent-self"], request: { multiSelect: false } },
      createdAt: "2026-05-28T11:00:00.000Z",
    });
    let resolveOpenRequests!: (value: { items: MessageWithDelivery[] }) => void;
    chatMocks.listChatOpenRequests.mockImplementation(
      () =>
        new Promise<{ items: MessageWithDelivery[] }>((resolve) => {
          resolveOpenRequests = resolve;
        }),
    );

    const { container, root } = await renderDom(
      <ChatView agentId="agent-1" chatId="chat-1" />,
      (client) => seedChat(client, chatDetail(), messages([])),
      "/",
    );

    const pendingTextarea = container.querySelector<HTMLTextAreaElement>("textarea");
    if (!pendingTextarea) throw new Error("Composer textarea missing");
    await setValue(pendingTextarea, "Draft before the request arrives @nova");
    expect(pendingTextarea.value).toBe("Draft before the request arrives @nova");
    expect(
      container.querySelector<HTMLButtonElement>('button[aria-label="Checking for open questions"]')?.disabled,
    ).toBe(true);
    expect(container.textContent).not.toContain("Checking for open questions");
    await act(async () => {
      pendingTextarea.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    });
    expect(chatMocks.sendChatMessage).not.toHaveBeenCalled();

    // The query lands with the still-open request: the blocking takeover
    // appears; the ordinary composer is replaced by the blocked bar.
    await act(async () => {
      resolveOpenRequests({ items: [buriedAsk] });
    });
    await waitForText(container, "Approve the migration?");
    expect(container.querySelector('[role="dialog"][aria-label^="Question"]')).not.toBeNull();
    expect(buttonByText(container, "Submit")).toBeTruthy();
    expect(container.querySelector("[data-ask-blocked-composer]")).not.toBeNull();
    expect(chatMocks.sendChatMessage).not.toHaveBeenCalled();

    await act(async () => root.unmount());
  });

  it("keeps the ordinary composer fail-closed on the normal route when the open-requests source fails", async () => {
    const { ChatView } = await import("../chat-view.js");
    chatMocks.listChatOpenRequests.mockRejectedValue(new Error("open requests unavailable"));

    const { container, root } = await renderDom(
      <ChatView agentId="agent-1" chatId="chat-1" />,
      (client) => seedChat(client, chatDetail(), messages([])),
      "/",
    );

    await waitForText(container, "Couldn’t check for open questions.");
    expect(container.querySelector("textarea")).not.toBeNull();
    expect(container.querySelector("[data-open-requests-error]")).not.toBeNull();
    expect(chatMocks.sendChatMessage).not.toHaveBeenCalled();

    // Retry confirms a fresh zero in this mount: the recovery row clears
    // without swapping the composer.
    chatMocks.listChatOpenRequests.mockResolvedValue({ items: [] });
    await click(buttonByText(container, "Retry"));
    await waitForCondition(() => container.querySelector("[data-open-requests-error]") === null, "retry row to clear");
    expect(container.querySelector("textarea")).not.toBeNull();

    await act(async () => root.unmount());
  });

  it("treats a cached empty success as unconfirmed on the normal route until this mount's fetch settles", async () => {
    const { ChatView } = await import("../chat-view.js");
    const buriedAsk = message({
      id: "req-normal-stale-cache",
      senderId: "agent-1",
      format: "request",
      content: "Approve the migration?",
      metadata: { mentions: ["human-agent-self"], request: { multiSelect: false } },
      createdAt: "2026-05-28T11:00:00.000Z",
    });
    let resolveOpenRequests!: (value: { items: MessageWithDelivery[] }) => void;
    chatMocks.listChatOpenRequests.mockImplementation(
      () =>
        new Promise<{ items: MessageWithDelivery[] }>((resolve) => {
          resolveOpenRequests = resolve;
        }),
    );

    const { container, root } = await renderDom(
      <ChatView agentId="agent-1" chatId="chat-1" />,
      (client) => {
        seedChat(client, chatDetail(), messages([]));
        // A previous visit's successful EMPTY result rides the mount as
        // status "success" through the background refetch — the fail-open
        // window this test pins shut on the normal route.
        client.setQueryData(["chat-open-requests", "chat-1"], { items: [] });
        // The harness client uses staleTime: Infinity; production (staleTime 0)
        // refetches on mount, so mark the row stale to match.
        void client.invalidateQueries({ queryKey: ["chat-open-requests", "chat-1"] });
      },
      "/",
    );

    expect(container.querySelector("textarea")).not.toBeNull();
    expect(
      container.querySelector<HTMLButtonElement>('button[aria-label="Checking for open questions"]')?.disabled,
    ).toBe(true);
    expect(container.textContent).not.toContain("Checking for open questions");
    expect(chatMocks.listChatOpenRequests).toHaveBeenCalled();
    expect(chatMocks.sendChatMessage).not.toHaveBeenCalled();

    // Settling with the still-open request enters the takeover directly.
    await act(async () => {
      resolveOpenRequests({ items: [buriedAsk] });
    });
    await waitForText(container, "Approve the migration?");
    expect(container.querySelector('[role="dialog"][aria-label^="Question"]')).not.toBeNull();
    expect(container.querySelector("[data-ask-blocked-composer]")).not.toBeNull();
    expect(chatMocks.sendChatMessage).not.toHaveBeenCalled();

    await act(async () => root.unmount());
  });

  it("latches the confirmation per chat viewing: transient poll errors do not re-block, chat switches re-verify", async () => {
    const { ChatView } = await import("../chat-view.js");
    // Per-chat deferred control over the open-requests source.
    const pendingResolvers = new Map<string, (value: { items: MessageWithDelivery[] }) => void>();
    const deferAll = () => {
      chatMocks.listChatOpenRequests.mockImplementation(
        (chatId: string) =>
          new Promise<{ items: MessageWithDelivery[] }>((resolve) => {
            pendingResolvers.set(chatId, resolve);
          }),
      );
    };
    deferAll();
    saveDraft(chatDraftScope(null, "chat-1"), { text: "draft for chat one" });
    saveDraft(chatDraftScope(null, "chat-2"), { text: "draft for chat two" });
    const draftCommits: Array<{ chatId: string; draft: string | null }> = [];
    function ObservedChat({ chatId }: { chatId: string }) {
      useLayoutEffect(() => {
        draftCommits.push({
          chatId,
          draft: document.querySelector<HTMLTextAreaElement>("textarea")?.value ?? null,
        });
      }, [chatId]);
      return <ChatView agentId="agent-1" chatId={chatId} />;
    }

    const { container, queryClient, root } = await renderDom(
      <ObservedChat chatId="chat-1" />,
      (client) => seedChat(client, chatDetail(), messages([])),
      "/",
    );

    // chat-1 confirms a zero: the stable composer stays in place and its send
    // control leaves the verification state.
    await act(async () => {
      pendingResolvers.get("chat-1")?.({ items: [] });
    });
    await waitForCondition(
      () => container.querySelector('button[aria-label="Send"]') !== null,
      "send control after chat-1 confirmed",
    );
    expect(container.querySelector<HTMLTextAreaElement>("textarea")?.value).toBe("draft for chat one");

    // A transient poll failure AFTER the latch must not re-block the composer
    // or surface the retry panel — this viewing is already confirmed.
    chatMocks.listChatOpenRequests.mockRejectedValue(new Error("poll blip"));
    await act(async () => {
      await queryClient.refetchQueries({ queryKey: ["chat-open-requests", "chat-1"] });
    });
    await flush();
    expect(container.querySelector("textarea")).not.toBeNull();
    expect(container.textContent).not.toContain("Couldn’t check for open questions.");

    // Switch to chat-2 WITHOUT remounting ChatView: the latch must reset, so
    // the stable composer remains visible but sending is unverified again.
    deferAll();
    seedChat(queryClient, chatDetail({ id: "chat-2" }), messages([]));
    draftCommits.length = 0;
    await act(async () => {
      root.render(
        <MemoryRouter initialEntries={["/"]}>
          <QueryClientProvider client={queryClient}>
            <ToastProvider>
              <ObservedChat chatId="chat-2" />
            </ToastProvider>
          </QueryClientProvider>
        </MemoryRouter>,
      );
    });
    await flush();
    expect(container.querySelector("textarea")).not.toBeNull();
    expect(
      container.querySelector<HTMLButtonElement>('button[aria-label="Checking for open questions"]')?.disabled,
    ).toBe(true);
    expect(container.textContent).not.toContain("Checking for open questions");
    expect(draftCommits).toEqual([{ chatId: "chat-2", draft: "draft for chat two" }]);
    expect(container.querySelector<HTMLTextAreaElement>("textarea")?.value).toBe("draft for chat two");
    expect(loadDraft(chatDraftScope(null, "chat-1"))?.text).toBe("draft for chat one");
    expect(loadDraft(chatDraftScope(null, "chat-2"))?.text).toBe("draft for chat two");
    expect(chatMocks.sendChatMessage).not.toHaveBeenCalled();

    // chat-2 confirms: the stable composer stays put and the verification
    // label lifts from the send control.
    await act(async () => {
      pendingResolvers.get("chat-2")?.({ items: [] });
    });
    await waitForCondition(
      () => container.querySelector('button[aria-label="Send"]') !== null,
      "send control after chat-2 confirmed",
    );

    // Back to chat-1 (still without remount): the earlier chat-1 latch was
    // cleared on switch, so this viewing re-verifies too.
    await act(async () => {
      root.render(
        <MemoryRouter initialEntries={["/"]}>
          <QueryClientProvider client={queryClient}>
            <ToastProvider>
              <ObservedChat chatId="chat-1" />
            </ToastProvider>
          </QueryClientProvider>
        </MemoryRouter>,
      );
    });
    await flush();
    expect(container.querySelector("textarea")).not.toBeNull();
    // chat-1's query still carries the blip's error status, so this viewing
    // shows the compact retryable error while preserving the draft surface;
    // the in-flight mount refetch settles it.
    await waitForText(container, "Couldn’t check for open questions.");

    await act(async () => {
      pendingResolvers.get("chat-1")?.({ items: [] });
    });
    await waitForCondition(
      () => container.querySelector('button[aria-label="Send"]') !== null,
      "send control after chat-1 re-confirmed",
    );

    await act(async () => root.unmount());
  });

  it("Skip resolves the question with a skipped answer (no temporary dismiss)", async () => {
    const { ChatView } = await import("../chat-view.js");
    const dockMessages = messages([
      message({
        id: "req-skip",
        senderId: "agent-1",
        format: "request",
        content: "Pick the deploy color.",
        metadata: {
          mentions: ["human-agent-self"],
          request: {
            options: [
              { label: "Blue-green", description: "blue-green deploy" },
              { label: "Rolling update", description: "rolling deploy" },
            ],
          },
        },
        createdAt: "2026-05-28T12:00:00.000Z",
      }),
    ]);
    const { container, queryClient, root } = await renderDom(
      <ChatView agentId="agent-1" chatId="chat-1" />,
      (client) => seedChat(client, chatDetail(), messages([])),
      "/",
    );

    await act(async () => {
      queryClient.setQueryData(["chat-messages", "chat-1"], dockMessages);
    });
    await flush();
    await waitForText(container, "Skip");

    // Skip is always enabled and resolves the question with a skipped answer —
    // it does NOT just dismiss the overlay (the open request would persist).
    expect(buttonByText(container, "Skip")?.disabled).toBe(false);
    await click(buttonByText(container, "Skip"));
    await waitForCondition(
      () => chatMocks.sendChatMessage.mock.calls.length > 0,
      "Expected Skip to resolve the question",
    );
    expect(chatMocks.sendChatMessage).toHaveBeenCalledWith("chat-1", "(Skipped — no answer provided.)", ["agent-1"], {
      inReplyTo: "req-skip",
      resolves: { request: "req-skip", kind: "closed" },
    });

    await act(async () => root.unmount());
  });

  it("enables Send and resolves when an option question is answered with free text (no option picked)", async () => {
    const { ChatView } = await import("../chat-view.js");
    const dockMessages = messages([
      message({
        id: "req-opt",
        senderId: "agent-1",
        format: "request",
        content: "Pick the deploy color.",
        metadata: {
          mentions: ["human-agent-self"],
          request: {
            options: [
              { label: "Blue-green", description: "blue-green deploy" },
              { label: "Rolling update", description: "rolling deploy" },
            ],
          },
        },
        createdAt: "2026-05-28T12:00:00.000Z",
      }),
    ]);
    const { container, root } = await renderDom(
      <ChatView agentId="agent-1" chatId="chat-1" />,
      (client) => seedChat(client, chatDetail(), dockMessages),
      "/",
    );

    await waitForText(container, "Submit");
    const other = askTextarea(container);
    if (!other) throw new Error("Overlay free-text input missing");

    // No option picked + empty Other → Reply disabled.
    expect(buttonByText(container, "Submit")?.disabled).toBe(true);

    // Typing a free-text answer (without picking an option) enables Reply.
    await setValue(other, "Neither — let's hold the deploy");
    expect(buttonByText(container, "Submit")?.disabled).toBe(false);

    // ...and Reply resolves with the free text as the answer.
    await click(buttonByText(container, "Submit"));
    await waitForCondition(() => chatMocks.sendChatMessage.mock.calls.length > 0, "Expected free-text answer send");
    expect(chatMocks.sendChatMessage).toHaveBeenCalledWith("chat-1", "Neither — let's hold the deploy", ["agent-1"], {
      inReplyTo: "req-opt",
      resolves: { request: "req-opt", kind: "answered" },
    });

    await act(async () => root.unmount());
  });

  it("does not clear a user-typed @ after an earlier focus auto-prime", async () => {
    const { ChatView } = await import("../chat-view.js");
    const dockMessages = messages([
      message({
        id: "req-manual-mention",
        senderId: "agent-1",
        format: "request",
        content: "Discuss the deploy.",
        metadata: {
          mentions: ["human-agent-self"],
          request: {
            subject: "Deploy",
            questions: [{ id: "q1", prompt: "Concerns?", kind: "free", required: true }],
          },
        },
        createdAt: "2026-05-28T12:00:00.000Z",
      }),
    ]);
    const { container, queryClient, root } = await renderDom(
      <ChatView agentId="agent-1" chatId="chat-1" />,
      (client) => seedChat(client, chatDetail(), messages([])),
      "/",
    );

    const textarea = container.querySelector<HTMLTextAreaElement>("textarea");
    if (!textarea) throw new Error("Composer textarea missing");
    await act(async () => {
      textarea.dispatchEvent(new FocusEvent("focusin", { bubbles: true, cancelable: true }));
    });
    await flush();
    await waitForCondition(() => textarea.value === "@", "Expected initial group focus to auto-prime @");

    await setValue(textarea, "");
    await act(async () => {
      queryClient.setQueryData(["chat-messages", "chat-1"], dockMessages);
    });
    await flush();
    await waitForText(container, "Submit");
    expect(textarea.value).toBe("");

    await setValue(textarea, "@");
    await flush();
    expect(textarea.value).toBe("@");

    await act(async () => root.unmount());
  });

  // Shared free-text (legacy-shape → free-text fallback) blocking ask used by the
  // text-resolve and image-resolve cases below.
  const freeTextDockMessages = () =>
    messages([
      message({
        id: "req-file",
        senderId: "agent-1",
        format: "request",
        content: "Attach the rollout screenshot.",
        metadata: {
          mentions: ["human-agent-self"],
          request: {
            subject: "Evidence",
            questions: [{ id: "q1", prompt: "Evidence?", kind: "free", required: true }],
          },
        },
        createdAt: "2026-05-28T12:00:00.000Z",
      }),
    ]);

  it("resolves a blocking free-text question via a typed text answer", async () => {
    const { ChatView } = await import("../chat-view.js");
    const { container, root } = await renderDom(
      <ChatView agentId="agent-1" chatId="chat-1" />,
      (client) => seedChat(client, chatDetail(), freeTextDockMessages()),
      "/",
    );

    await waitForText(container, "Submit");
    const answerBox = askTextarea(container);
    if (!answerBox) throw new Error("Overlay free-text input missing");
    await setValue(answerBox, "Screenshot evidence attached");
    await click(buttonByText(container, "Submit"));
    await waitForCondition(() => chatMocks.sendChatMessage.mock.calls.length > 0, "Expected text resolve send");
    expect(chatMocks.sendChatMessage).toHaveBeenCalledWith("chat-1", "Screenshot evidence attached", ["agent-1"], {
      inReplyTo: "req-file",
      resolves: { request: "req-file", kind: "answered" },
    });
    expect(chatMocks.sendFileMessageBatch).not.toHaveBeenCalled();

    await act(async () => root.unmount());
  });

  it("resolves a blocking free-text question with an attached image via a file-batch resolve", async () => {
    const { ChatView } = await import("../chat-view.js");
    const { container, root } = await renderDom(
      <ChatView agentId="agent-1" chatId="chat-1" />,
      (client) => seedChat(client, chatDetail(), freeTextDockMessages()),
      "/",
    );

    await waitForText(container, "Submit");
    const answerBox = askTextarea(container);
    if (!answerBox) throw new Error("Overlay free-text input missing");
    await setValue(answerBox, "Screenshot evidence attached");
    // The ask card now owns image attachments — its file input is the first one
    // in the DOM (the overlay renders above the covered composer). Attaching an
    // image makes the resolving reply a `format="file"` batch that STILL carries
    // `metadata.resolves`, so the question resolves exactly like a text answer.
    const file = new File(["abc"], "evidence.png", { type: "image/png" });
    const fileInput = container.querySelector<HTMLInputElement>('input[type="file"]');
    if (!fileInput) throw new Error("File input missing");
    await changeFiles(fileInput, [file]);
    await click(buttonByText(container, "Submit"));
    await waitForCondition(
      () => chatMocks.sendFileMessageBatch.mock.calls.length > 0,
      "Expected image file-batch resolve",
    );
    expect(attachmentMocks.uploadAttachment).toHaveBeenCalledWith(file);
    expect(chatMocks.sendFileMessageBatch).toHaveBeenCalledWith(
      "chat-1",
      {
        caption: "Screenshot evidence attached",
        attachments: [{ imageId: "uploaded-image", mimeType: "image/png", filename: "evidence.png", size: 3 }],
      },
      { mentions: ["agent-1"] },
      { inReplyTo: "req-file", resolves: { request: "req-file", kind: "answered" } },
    );
    expect(chatMocks.sendChatMessage).not.toHaveBeenCalled();

    await act(async () => root.unmount());
  });

  it("resolves a blocking free-text question with an attached document via metadata refs", async () => {
    attachmentMocks.uploadAttachment.mockResolvedValueOnce({
      id: "11111111-1111-4111-8111-111111111111",
      mimeType: "application/pdf",
      size: 3,
    });
    const { ChatView } = await import("../chat-view.js");
    const { container, root } = await renderDom(
      <ChatView agentId="agent-1" chatId="chat-1" />,
      (client) => seedChat(client, chatDetail(), freeTextDockMessages()),
      "/",
    );

    await waitForText(container, "Submit");
    const file = new File(["pdf"], "evidence.pdf", { type: "application/pdf" });
    const fileInput = container.querySelector<HTMLInputElement>('input[type="file"]');
    if (!fileInput) throw new Error("File input missing");
    await changeFiles(fileInput, [file]);
    await waitForText(container, "evidence.pdf");
    await click(buttonByText(container, "Submit"));
    await waitForCondition(() => chatMocks.sendChatMessage.mock.calls.length > 0, "Expected document resolve send");
    expect(attachmentMocks.uploadAttachment).toHaveBeenCalledWith(file);
    expect(chatMocks.sendChatMessage).toHaveBeenCalledWith("chat-1", "", ["agent-1"], {
      inReplyTo: "req-file",
      resolves: { request: "req-file", kind: "answered" },
      attachments: [
        {
          attachmentId: "11111111-1111-4111-8111-111111111111",
          kind: "file",
          mimeType: "application/pdf",
          filename: "evidence.pdf",
          size: 3,
        },
      ],
    });
    expect(chatMocks.sendFileMessageBatch).not.toHaveBeenCalled();

    await act(async () => root.unmount());
  });

  it("handles empty and direct-chat branches", async () => {
    const { ChatView } = await import("../chat-view.js");
    const emptyDetail = chatDetail({
      id: "chat-empty",
      title: "Empty direct",
      type: "direct",
      participants: [
        participant({ agentId: "human-agent-self", type: "human", name: "gandy", displayName: "Gandy" }),
        participant({ agentId: "agent-1", name: "nova", displayName: "Nova" }),
      ],
    });
    const empty = await renderDom(
      <ChatView agentId="agent-1" chatId="chat-empty" />,
      (queryClient) => {
        seedChat(queryClient, emptyDetail, messages([]));
        queryClient.setQueryData(
          ["chat-session-events", "chat-empty"],
          chatSessionEvents({ agentId: "agent-1", events: { items: [], nextCursor: null } }),
        );
      },
      "/",
    );
    await waitForText(empty.container, "Send a message to start the conversation");
    const textarea = empty.container.querySelector<HTMLTextAreaElement>("textarea");
    if (!textarea) throw new Error("Direct composer textarea missing");
    await waitForCondition(() => textarea.value.includes("Hi Nova!"), "Expected direct-chat greeting");
    await setValue(textarea, "hello there");
    await click(empty.container.querySelector('button[aria-label="Send"]'));
    await waitForCondition(() => chatMocks.sendChatMessage.mock.calls.length > 0, "Expected direct send");
    expect(chatMocks.sendChatMessage).toHaveBeenCalledWith("chat-empty", "hello there", ["agent-1"]);
    await act(async () => empty.root.unmount());
  });

  function directDetail(): ChatDetail {
    return chatDetail({
      id: "chat-empty",
      title: "Empty direct",
      type: "direct",
      participants: [
        participant({ agentId: "human-agent-self", type: "human", name: "gandy", displayName: "Gandy" }),
        participant({ agentId: "agent-1", name: "nova", displayName: "Nova" }),
      ],
    });
  }

  it("mobile composer: one-line rest, 44-unit send hit area, simplified placeholder, Enter does not send", async () => {
    const { ChatView } = await import("../chat-view.js");
    const { container, root } = await renderDom(
      <ChatView agentId="agent-1" chatId="chat-empty" narrow presentation="mobile" />,
      (queryClient) => {
        seedChat(queryClient, directDetail(), messages([]));
        queryClient.setQueryData(
          ["chat-session-events", "chat-empty"],
          chatSessionEvents({ agentId: "agent-1", events: { items: [], nextCursor: null } }),
        );
      },
      "/",
    );
    await waitForText(container, "Send a message to start the conversation");
    const textarea = container.querySelector<HTMLTextAreaElement>("textarea");
    const send = container.querySelector<HTMLButtonElement>('button[aria-label="Send"]');
    const timeline = container.querySelector<HTMLElement>("[data-chat-timeline-scroll]");
    const footer = container.querySelector<HTMLElement>("[data-chat-composer-footer]");
    if (!textarea || !send || !timeline || !footer) throw new Error("Mobile composer or timeline missing");

    expect(timeline.style.padding).toContain("var(--sp-4)");
    expect(footer.style.paddingInline).toBe("var(--sp-4)");

    // Resting height is one row: the auto-resize hook measures the `rows`-sized
    // empty box, so `rows` (not just the min-height floor) must drop to 1.
    expect(Number(textarea.rows)).toBe(1);
    // Send is the ONLY send path on mobile (Enter inserts a newline), so its hit
    // area must clear the touch minimum.
    expect(Number.parseInt(send.style.width, 10)).toBe(44);
    expect(Number.parseInt(send.style.height, 10)).toBe(44);
    // Placeholder drops the desktop keyboard-shortcut teaching text.
    await setValue(textarea, "");
    expect(textarea.placeholder).not.toContain("for commands");
    expect(textarea.placeholder).not.toContain("to mention");

    // Enter inserts a newline and sends nothing; the button is the only send.
    await setValue(textarea, "hello there");
    await act(async () => {
      textarea.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    });
    await flush();
    expect(chatMocks.sendChatMessage).not.toHaveBeenCalled();
    await click(send);
    await waitForCondition(() => chatMocks.sendChatMessage.mock.calls.length > 0, "Expected button send on mobile");
    expect(chatMocks.sendChatMessage).toHaveBeenCalledWith("chat-empty", "hello there", ["agent-1"]);

    await act(async () => root.unmount());
  });

  it("desktop composer unchanged: two-row rest, compact send, full placeholder, Enter sends", async () => {
    const { ChatView } = await import("../chat-view.js");
    const { container, root } = await renderDom(
      <ChatView agentId="agent-1" chatId="chat-empty" />,
      (queryClient) => {
        seedChat(queryClient, directDetail(), messages([]));
        queryClient.setQueryData(
          ["chat-session-events", "chat-empty"],
          chatSessionEvents({ agentId: "agent-1", events: { items: [], nextCursor: null } }),
        );
      },
      "/",
    );
    await waitForText(container, "Send a message to start the conversation");
    const textarea = container.querySelector<HTMLTextAreaElement>("textarea");
    const send = container.querySelector<HTMLButtonElement>('button[aria-label="Send"]');
    const timeline = container.querySelector<HTMLElement>("[data-chat-timeline-scroll]");
    const footer = container.querySelector<HTMLElement>("[data-chat-composer-footer]");
    if (!textarea || !send || !timeline || !footer) throw new Error("Desktop composer or timeline missing");

    expect(timeline.style.padding).toContain("var(--sp-6)");
    expect(footer.style.paddingInline).toBe("var(--sp-6)");

    expect(Number(textarea.rows)).toBe(2);
    expect(Number.parseInt(send.style.width, 10)).toBe(28);
    expect(Number.parseInt(send.style.height, 10)).toBe(28);
    await setValue(textarea, "");
    expect(textarea.placeholder).toContain("for commands");

    // Desktop keeps Enter-to-send.
    await setValue(textarea, "hello there");
    await act(async () => {
      textarea.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    });
    await waitForCondition(() => chatMocks.sendChatMessage.mock.calls.length > 0, "Expected Enter send on desktop");
    expect(chatMocks.sendChatMessage).toHaveBeenCalledWith("chat-empty", "hello there", ["agent-1"]);

    await act(async () => root.unmount());
  });

  it("renders an agent worktree-path link as plain text while keeping real web links (issue 831)", async () => {
    const { ChatView } = await import("../chat-view.js");
    const worktree = "/Users/u/.first-tree/data/workspaces/a/worktrees/build-tree";
    // An agent reporting tree-build progress: a markdown link to its local
    // worktree directory (a 404 trap) alongside a genuine external URL.
    const page = messages([
      message({
        id: "msg-worktree",
        senderId: "agent-1",
        source: "api",
        content: `Built the tree at [${worktree}](${worktree}). Docs: https://example.com/guide`,
        createdAt: "2026-05-28T11:59:00.000Z",
      }),
    ]);
    const { container, root } = await renderDom(
      <ChatView agentId="agent-1" chatId="chat-1" />,
      (queryClient) => {
        seedChat(queryClient, chatDetail(), page);
      },
      "/",
    );

    await waitForText(container, "Built the tree at");

    const anchorHrefs = [...container.querySelectorAll("a")].map((a) => a.getAttribute("href"));
    // The worktree directory path has no web route — it must NOT be a live
    // anchor (clicking would 404 against the cloud origin), but the path text
    // is preserved as plain text.
    expect(container.querySelector(`a[href="${worktree}"]`)).toBeNull();
    expect(anchorHrefs).not.toContain(worktree);
    expect(container.textContent).toContain("worktrees/build-tree");
    // A genuine external link in the same message still renders as an anchor.
    expect(anchorHrefs).toContain("https://example.com/guide");

    await act(async () => root.unmount());
  });

  it("shortens only bare entity links from the Team's connected GitLab instance", async () => {
    const { ChatView } = await import("../chat-view.js");
    const canonical = "https://gitlab.internal/acme/web/-/merge_requests/42";
    const legacy = "https://gitlab.internal/acme/web/issues/7";
    const otherOrigin = "https://gitlab.example/acme/web/-/merge_requests/9";
    const page = messages([
      message({
        id: "msg-gitlab-links",
        senderId: "agent-1",
        source: "api",
        content: [canonical, legacy, otherOrigin, `[Review the MR](${canonical})`].join("\n\n"),
        createdAt: "2026-05-28T11:59:00.000Z",
      }),
    ]);
    const { container, root } = await renderDom(
      <ChatView agentId="agent-1" chatId="chat-1" />,
      (queryClient) => {
        seedChat(queryClient, chatDetail(), page);
        queryClient.setQueryData(["gitlab-connections", "org-1"], [{ instanceOrigin: "https://gitlab.internal" }]);
      },
      "/",
    );

    await waitForText(container, "acme/web!42");

    const anchors = [...container.querySelectorAll<HTMLAnchorElement>("a")];
    const compactMr = anchors.find((anchor) => anchor.textContent === "acme/web!42");
    expect(compactMr?.getAttribute("href")).toBe(canonical);
    expect(compactMr?.title).toBe(canonical);
    expect(anchors.find((anchor) => anchor.textContent === "acme/web#7")?.getAttribute("href")).toBe(legacy);
    expect(anchors.find((anchor) => anchor.textContent === otherOrigin)?.getAttribute("href")).toBe(otherOrigin);
    expect(anchors.find((anchor) => anchor.textContent === "Review the MR")?.getAttribute("href")).toBe(canonical);

    await act(async () => root.unmount());
  });

  it("binds compact GitLab links to the rendered chat Team while the shell still points elsewhere", async () => {
    const { ChatView } = await import("../chat-view.js");
    authMock.value = {
      agentId: "human-agent-self",
      memberId: "member-self",
      organizationId: "shell-org",
      role: "admin",
    };
    const chatOriginUrl = "https://chat-gitlab.example/acme/web/-/merge_requests/42";
    const shellOriginUrl = "https://shell-gitlab.example/acme/web/-/merge_requests/9";
    const page = messages([
      message({
        id: "msg-cross-org-gitlab",
        senderId: "agent-1",
        source: "api",
        content: [chatOriginUrl, shellOriginUrl].join("\n\n"),
        createdAt: "2026-05-28T11:59:00.000Z",
      }),
    ]);
    const { container, root } = await renderDom(
      <ChatView agentId="agent-1" chatId="chat-1" />,
      (queryClient) => {
        seedChat(queryClient, chatDetail({ organizationId: "chat-org" }), page);
        queryClient.setQueryData(
          ["gitlab-connections", "shell-org"],
          [{ instanceOrigin: "https://shell-gitlab.example" }],
        );
        queryClient.setQueryData(
          ["gitlab-connections", "chat-org"],
          [{ instanceOrigin: "https://chat-gitlab.example" }],
        );
      },
      "/",
    );

    await waitForText(container, "acme/web!42");
    const anchors = [...container.querySelectorAll<HTMLAnchorElement>("a")];
    expect(anchors.find((anchor) => anchor.textContent === "acme/web!42")?.href).toBe(chatOriginUrl);
    expect(anchors.find((anchor) => anchor.textContent === shellOriginUrl)?.href).toBe(shellOriginUrl);

    await act(async () => root.unmount());
  });

  it("uses the same compact GitLab presentation in the blocking request body", async () => {
    const { ChatView } = await import("../chat-view.js");
    const canonical = "https://gitlab.internal/acme/web/-/merge_requests/42";
    const request = message({
      id: "req-gitlab-link",
      senderId: "agent-1",
      format: "request",
      content: [canonical, `[Review the MR](${canonical})`].join("\n\n"),
      metadata: {
        mentions: ["human-agent-self"],
        request: {
          options: [
            { label: "Approve", description: "ship it" },
            { label: "Hold", description: "wait" },
          ],
        },
        attachments: [
          {
            attachmentId: "22222222-2222-4222-8222-222222222222",
            kind: "image",
            mimeType: "image/png",
            filename: "evidence.png",
            size: 42,
          },
        ],
      },
      source: "api",
      createdAt: "2026-05-28T11:59:00.000Z",
    });
    const { container, root } = await renderDom(
      <ChatView agentId="agent-1" chatId="chat-1" />,
      (queryClient) => {
        seedChat(queryClient, chatDetail(), messages([request]));
        queryClient.setQueryData(["gitlab-connections", "org-1"], [{ instanceOrigin: "https://gitlab.internal" }]);
      },
      "/",
    );

    await waitForCondition(
      () => container.querySelector('[role="dialog"] a') !== null,
      "Expected the blocking request body links",
    );
    const dialog = container.querySelector('[role="dialog"]');
    const anchors = [...(dialog?.querySelectorAll<HTMLAnchorElement>("a") ?? [])];
    const compact = anchors.find((anchor) => anchor.textContent === "acme/web!42");
    expect(compact?.getAttribute("href")).toBe(canonical);
    expect(compact?.title).toBe(canonical);
    expect(anchors.find((anchor) => anchor.textContent === "Review the MR")?.getAttribute("href")).toBe(canonical);
    expect(dialog?.querySelector('button[aria-label="Open image evidence.png"]')).not.toBeNull();

    await act(async () => root.unmount());
  });

  it("opens the image lightbox on thumbnail click and closes on Escape", async () => {
    // BASE_MESSAGES' msg-3 is a one-image message ("preview.png").
    const { ChatView } = await import("../chat-view.js");
    const { container, root } = await renderDom(<ChatView agentId="agent-1" chatId="chat-1" />);
    const thumb = () => container.querySelector<HTMLButtonElement>('button[aria-label="Open image preview.png"]');
    await waitForCondition(() => thumb() !== null, "image thumbnail did not render");

    await click(thumb());
    const dialog = document.querySelector('[role="dialog"]');
    expect(dialog).not.toBeNull();
    expect(dialog?.querySelector('img[alt="preview.png"]')).not.toBeNull();
    expect(dialog?.querySelector('button[aria-label="Download original"]')).not.toBeNull();
    expect(dialog?.querySelector('button[aria-label="Close"]')).not.toBeNull();
    // Single image: no prev/next paging affordances.
    expect(dialog?.querySelector('button[aria-label="Next image"]')).toBeNull();

    // Radix listens for Escape on document; this closes the lightbox.
    await act(async () => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    await waitForCondition(
      () => document.querySelector('[role="dialog"]') === null,
      "lightbox did not close on Escape",
    );

    await act(async () => root.unmount());
  });

  it("bounds the image thumbnail by the message column (no fixed-px overflow on narrow/mobile)", async () => {
    // The inline maxWidth must stay container-relative (`min(..., 100%)`), not a
    // bare fixed cap that would override `img { max-width: 100% }` and overflow
    // the narrow mobile message column. Layout isn't measurable in jsdom, so
    // assert the container-aware declaration is present.
    const { ChatView } = await import("../chat-view.js");
    const { container, root } = await renderDom(<ChatView agentId="agent-1" chatId="chat-1" />);
    const thumbImg = () => container.querySelector<HTMLImageElement>('button[aria-label="Open image preview.png"] img');
    await waitForCondition(() => thumbImg() !== null, "image thumbnail did not render");

    const style = thumbImg()?.getAttribute("style") ?? "";
    expect(style).toContain("100%");
    expect(style).toContain("min(");

    await act(async () => root.unmount());
  });

  // The chat summary (`chat.description`) now renders in the pinned ChatSummary
  // between the chat header and the message stream — NOT in the right rail.
  describe("pinned summary", () => {
    // Distinct from BASE_MESSAGES' body so assertions can't match unrelated chrome.
    const DESCRIPTION_MD = "Status: shipping **DescBody** soon.";

    function sidebarOpen(container: ParentNode): boolean {
      return container.querySelector('aside[aria-label="Chat details"]') !== null;
    }
    function chatSummaryButton(container: ParentNode): HTMLButtonElement | null {
      return container.querySelector<HTMLButtonElement>('button[aria-label$="current state"]');
    }

    it("renders the description's first line collapsed and the full markdown when expanded", async () => {
      localStorage.clear();
      const { ChatView } = await import("../chat-view.js");
      const withDescription = chatDetail({ description: DESCRIPTION_MD });
      chatMocks.getChat.mockResolvedValue(withDescription);
      const { container, root } = await renderDom(
        <ChatView agentId="agent-1" chatId="chat-1" />,
        (queryClient) => seedChat(queryClient, withDescription),
        "/",
      );

      await waitForCondition(
        () => chatSummaryButton(container) !== null,
        "Expected the summary to render for a chat with a description",
      );
      const button = chatSummaryButton(container);
      if (!button) throw new Error("summary button missing");
      // Collapsed bar = the first line with markdown markers stripped.
      expect(button.textContent).toContain("Status: shipping DescBody soon.");

      // Expand → faithful markdown (bold renders as <strong>DescBody</strong>).
      await act(async () => {
        button.click();
      });
      expect(chatSummaryButton(container)?.textContent).toContain("Current state");
      expect(chatSummaryButton(container)?.textContent).not.toContain("Status: shipping DescBody soon.");
      await waitForCondition(
        () => [...container.querySelectorAll("strong")].some((el) => el.textContent === "DescBody"),
        "Expected the expanded summary to render the description markdown",
      );

      await act(async () => root.unmount());
    });

    it("auto-expands an unread summary version on entry", async () => {
      localStorage.clear();
      const { ChatView } = await import("../chat-view.js");
      const unreadDescription = chatDetail({
        description: DESCRIPTION_MD,
        descriptionUpdatedAt: "2026-05-28T12:05:00.000Z",
        lastReadAt: "2026-05-28T12:00:00.000Z",
      });
      chatMocks.getChat.mockResolvedValue(unreadDescription);
      const { container, root } = await renderDom(
        <ChatView agentId="agent-1" chatId="chat-1" />,
        (queryClient) => seedChat(queryClient, unreadDescription),
        "/",
      );

      await waitForCondition(
        () =>
          chatSummaryButton(container)?.getAttribute("aria-label") === "Collapse current state" &&
          [...container.querySelectorAll("strong")].some((el) => el.textContent === "DescBody"),
        "Expected the unread summary version to auto-expand on entry",
      );
      expect(chatSummaryButton(container)?.textContent).toContain("Current state");

      await act(async () => root.unmount());
    });

    it("renders no summary when the chat has no description", async () => {
      localStorage.clear();
      const { ChatView } = await import("../chat-view.js");
      const noDescription = chatDetail({ description: null });
      chatMocks.getChat.mockResolvedValue(noDescription);
      const { container, root } = await renderDom(
        <ChatView agentId="agent-1" chatId="chat-1" />,
        (queryClient) => seedChat(queryClient, noDescription),
        "/",
      );

      await waitForText(container, "Launch planning");
      await flush();
      expect(chatSummaryButton(container)).toBeNull();

      await act(async () => root.unmount());
    });

    it("does NOT auto-open the right rail for a described chat — the summary lives in the summary", async () => {
      localStorage.clear();
      const { ChatView } = await import("../chat-view.js");
      const withDescription = chatDetail({ description: DESCRIPTION_MD });
      chatMocks.getChat.mockResolvedValue(withDescription);
      const { container, root } = await renderDom(
        <ChatView agentId="agent-1" chatId="chat-1" />,
        (queryClient) => seedChat(queryClient, withDescription),
        "/",
      );

      await waitForCondition(() => chatSummaryButton(container) !== null, "Expected the summary to render");
      await flush();
      // The rail no longer pops open just because the chat has a description.
      expect(sidebarOpen(container)).toBe(false);

      await act(async () => root.unmount());
    });

    it("exposes no edit affordance — read-only", async () => {
      localStorage.clear();
      const { ChatView } = await import("../chat-view.js");
      const withDescription = chatDetail({ description: DESCRIPTION_MD });
      chatMocks.getChat.mockResolvedValue(withDescription);
      const { container, root } = await renderDom(
        <ChatView agentId="agent-1" chatId="chat-1" />,
        (queryClient) => seedChat(queryClient, withDescription),
        "/",
      );

      await waitForCondition(() => chatSummaryButton(container) !== null, "Expected the summary to render");
      const button = chatSummaryButton(container);
      if (!button) throw new Error("summary button missing");
      // Expand and confirm the expanded surface still exposes no edit affordance.
      await act(async () => {
        button.click();
      });
      await flush();
      const headerRoot = button.parentElement;
      if (!headerRoot) throw new Error("summary root missing");
      // Read-only is self-evident: the only control is the expand/collapse toggle —
      // no edit button / input / textarea (the footer + info hint were removed).
      expect(headerRoot.querySelectorAll("button")).toHaveLength(1);
      expect(headerRoot.querySelector("input")).toBeNull();
      expect(headerRoot.querySelector("textarea")).toBeNull();

      await act(async () => root.unmount());
    });
  });
});

describe("timeline message filter", () => {
  const FILTER_MESSAGES = messages([
    message({
      id: "pf-human-to-nova",
      senderId: "human-agent-self",
      content: "Nova, please check the deploy.",
      createdAt: "2026-05-28T11:50:00.000Z",
      metadata: { mentions: ["agent-1"] },
    }),
    message({
      id: "pf-nova-reply",
      senderId: "agent-1",
      content: "Deploy checked, all green.",
      createdAt: "2026-05-28T11:51:00.000Z",
      metadata: { mentions: ["human-agent-self"] },
    }),
    message({
      id: "pf-design-to-human",
      senderId: "agent-2",
      content: "Design notes for the banner.",
      createdAt: "2026-05-28T11:52:00.000Z",
      metadata: { mentions: ["human-agent-self"] },
    }),
  ]);

  it("applies the transient ?focus= pair filter and clears it via Show all messages", async () => {
    const { ChatView } = await import("../chat-view.js");
    chatMocks.listChatMessages.mockResolvedValue(FILTER_MESSAGES);
    const { container, root } = await renderDom(
      <ChatView agentId="agent-1" chatId="chat-1" />,
      (client) => seedChat(client, chatDetail(), FILTER_MESSAGES),
      "/?focus=agent-1",
    );

    await waitForText(container, "Showing your conversation with Nova");
    expect(container.textContent).toContain("temporary view");
    expect(container.textContent).toContain("Deploy checked, all green.");
    expect(container.textContent).not.toContain("Design notes for the banner.");
    // No focusMsg handoff anchor → no out-of-window warning.
    expect(container.textContent).not.toContain("older than the loaded history");
    // The pair view is messages-only: session events carry no pair
    // attribution, so even the selected agent's rows stay hidden.
    expect(container.textContent).not.toContain("Example recoverable runtime error");

    await click(buttonByText(container, "Show all messages"));
    await waitForText(container, "Design notes for the banner.");
    expect(container.querySelector("[data-message-filter-banner]")).toBeNull();
    await waitForText(container, "Example recoverable runtime error");

    await act(async () => root.unmount());
  });

  it("keeps unaddressed pair messages in a two-speaker group-typed chat", async () => {
    const { ChatView } = await import("../chat-view.js");
    // New chats persist as `type: "group"` even for 1-on-1s; the pair filter
    // must key on the two-speaker SHAPE, or a DM's plain (mention-less)
    // exchange would vanish under the group addressing rule.
    const dmDetail = chatDetail({
      participants: [
        participant({ agentId: "human-agent-self", type: "human", name: "gandy", displayName: "Gandy" }),
        participant({ agentId: "agent-1", name: "nova", displayName: "Nova" }),
      ],
    });
    const dmMessages = messages([
      message({
        id: "dm-human",
        senderId: "human-agent-self",
        content: "Plain DM line without a mention.",
        createdAt: "2026-05-28T11:50:00.000Z",
      }),
      message({
        id: "dm-nova",
        senderId: "agent-1",
        content: "Plain DM reply without a mention.",
        createdAt: "2026-05-28T11:51:00.000Z",
      }),
    ]);
    chatMocks.getChat.mockResolvedValue(dmDetail);
    chatMocks.listChatMessages.mockResolvedValue(dmMessages);
    const { container, root } = await renderDom(
      <ChatView agentId="agent-1" chatId="chat-1" />,
      (client) => seedChat(client, dmDetail, dmMessages),
      "/?focus=agent-1",
    );

    await waitForText(container, "Showing your conversation with Nova");
    expect(container.textContent).toContain("Plain DM line without a mention.");
    expect(container.textContent).toContain("Plain DM reply without a mention.");

    await act(async () => root.unmount());
  });

  it("keeps the group addressing rule when filtering on a departed agent in a two-speaker chat", async () => {
    const { ChatView } = await import("../chat-view.js");
    // agent-2 has LEFT: current speakers are {viewer, agent-1}. Focusing the
    // departed agent-2 (still reachable via history / an old open request)
    // must NOT trip the exact-pair shortcut — otherwise every viewer message,
    // including ones addressed to agent-1, would leak into the pair view.
    const twoSpeakerDetail = chatDetail({
      participants: [
        participant({ agentId: "human-agent-self", type: "human", name: "gandy", displayName: "Gandy" }),
        participant({ agentId: "agent-1", name: "nova", displayName: "Nova" }),
      ],
    });
    const history = messages([
      message({
        id: "dep-human-to-nova",
        senderId: "human-agent-self",
        content: "Nova-only instruction line.",
        createdAt: "2026-05-28T11:50:00.000Z",
        metadata: { mentions: ["agent-1"] },
      }),
      message({
        id: "dep-human-to-design",
        senderId: "human-agent-self",
        content: "Design, please revisit the banner.",
        createdAt: "2026-05-28T11:51:00.000Z",
        metadata: { mentions: ["agent-2"] },
      }),
      message({
        id: "dep-design-reply",
        senderId: "agent-2",
        content: "Banner revisited, done.",
        createdAt: "2026-05-28T11:52:00.000Z",
        metadata: { mentions: ["human-agent-self"] },
      }),
    ]);
    chatMocks.getChat.mockResolvedValue(twoSpeakerDetail);
    chatMocks.listChatMessages.mockResolvedValue(history);
    const { container, root } = await renderDom(
      <ChatView agentId="agent-1" chatId="chat-1" />,
      (client) => seedChat(client, twoSpeakerDetail, history),
      "/?focus=agent-2",
    );

    await waitForText(container, "Showing your conversation with Design Critique");
    expect(container.textContent).toContain("Design, please revisit the banner.");
    expect(container.textContent).toContain("Banner revisited, done.");
    expect(container.textContent).not.toContain("Nova-only instruction line.");

    await act(async () => root.unmount());
  });

  it("reports when the focused request is older than the loaded history", async () => {
    const { ChatView } = await import("../chat-view.js");
    chatMocks.listChatMessages.mockResolvedValue(FILTER_MESSAGES);
    const { container, root } = await renderDom(
      <ChatView agentId="agent-1" chatId="chat-1" />,
      (client) => seedChat(client, chatDetail(), FILTER_MESSAGES),
      "/?focus=agent-1&focusMsg=req-outside-window",
    );

    await waitForText(container, "Showing your conversation with Nova");
    await waitForText(container, "older than the loaded history");

    await act(async () => root.unmount());
  });

  it("keeps the group rule when the current exact-pair chat once had a third speaker", async () => {
    const { ChatView } = await import("../chat-view.js");
    // Membership evolved {viewer, Nova, Design} → {viewer, Nova}: the speaker
    // rows say "exact pair", but history still holds the departed Design
    // era. The direct shortcut must NOT engage — messages addressed to the
    // departed agent stay out of the pair view, and mention-less pair
    // messages fall back to the group addressing rule.
    const shrunkDetail = chatDetail({
      participants: [
        participant({ agentId: "human-agent-self", type: "human", name: "gandy", displayName: "Gandy" }),
        participant({ agentId: "agent-1", name: "nova", displayName: "Nova" }),
      ],
    });
    const historyWithDeparted = messages([
      message({
        id: "hist-human-to-design",
        senderId: "human-agent-self",
        content: "Design-era side instruction.",
        createdAt: "2026-05-28T11:49:00.000Z",
        metadata: { mentions: ["agent-2"] },
      }),
      message({
        id: "hist-human-plain",
        senderId: "human-agent-self",
        content: "Plain unaddressed line.",
        createdAt: "2026-05-28T11:50:00.000Z",
      }),
      message({
        id: "hist-human-to-nova",
        senderId: "human-agent-self",
        content: "Nova, please take over.",
        createdAt: "2026-05-28T11:51:00.000Z",
        metadata: { mentions: ["agent-1"] },
      }),
      message({
        id: "hist-nova-reply",
        senderId: "agent-1",
        content: "Taking over now.",
        createdAt: "2026-05-28T11:52:00.000Z",
        metadata: { mentions: ["human-agent-self"] },
      }),
    ]);
    chatMocks.getChat.mockResolvedValue(shrunkDetail);
    chatMocks.listChatMessages.mockResolvedValue(historyWithDeparted);
    const { container, root } = await renderDom(
      <ChatView agentId="agent-1" chatId="chat-1" />,
      (client) => seedChat(client, shrunkDetail, historyWithDeparted),
      "/?focus=agent-1",
    );

    await waitForText(container, "Showing your conversation with Nova");
    expect(container.textContent).toContain("Nova, please take over.");
    expect(container.textContent).toContain("Taking over now.");
    expect(container.textContent).not.toContain("Design-era side instruction.");
    expect(container.textContent).not.toContain("Plain unaddressed line.");

    await act(async () => root.unmount());
  });

  it("caps the persisted read watermark just below the oldest hidden message", async () => {
    const { ChatView } = await import("../chat-view.js");
    chatMocks.listChatMessages.mockResolvedValue(FILTER_MESSAGES);
    const { root: filteredRoot } = await renderDom(
      <ChatView agentId="agent-1" chatId="chat-1" />,
      (client) => seedChat(client, chatDetail(), FILTER_MESSAGES),
      "/?focus=agent-1",
    );
    // Unmount flushes the tracker. The filtered DOM tip (pf-nova-reply) sits
    // AFTER older visible rows but the newest loaded message (agent-2's,
    // hidden) must never be marked known — the safe watermark is the message
    // just before the oldest hidden one. Here that happens to equal the
    // visible tip; the critical assertion is that the hidden id is never
    // persisted while the read pair messages still get digested (a plain
    // freeze would re-flag them as new on every future visit).
    await act(async () => filteredRoot.unmount());
    const filteredWrites = readStateMocks.setReadState.mock.calls.filter((call) => call[0] === "chat-1");
    expect(filteredWrites.length).toBeGreaterThan(0);
    for (const call of filteredWrites) {
      expect(call[2]).toBe("pf-nova-reply");
    }

    // Control: the same visit without the filter persists the true tip.
    readStateMocks.setReadState.mockClear();
    document.body.innerHTML = "";
    const { root: plainRoot } = await renderDom(
      <ChatView agentId="agent-1" chatId="chat-1" />,
      (client) => seedChat(client, chatDetail(), FILTER_MESSAGES),
      "/",
    );
    await act(async () => plainRoot.unmount());
    const chatWrites = readStateMocks.setReadState.mock.calls.filter((call) => call[0] === "chat-1");
    expect(chatWrites.length).toBeGreaterThan(0);
    for (const call of chatWrites) {
      expect(call[2]).toBe("pf-design-to-human");
    }
  });

  it("persists the true tip when an active focus hides nothing", async () => {
    const { ChatView } = await import("../chat-view.js");
    // Transient exact-pair focus in a genuine two-speaker chat: the full
    // message DOM renders, so read persistence must behave exactly as an
    // unfiltered visit — freezing here would strand a stale watermark and
    // scroll anchor for the next ordinary visit.
    const dmDetail = chatDetail({
      participants: [
        participant({ agentId: "human-agent-self", type: "human", name: "gandy", displayName: "Gandy" }),
        participant({ agentId: "agent-1", name: "nova", displayName: "Nova" }),
      ],
    });
    const dmMessages = messages([
      message({
        id: "dm-human",
        senderId: "human-agent-self",
        content: "Plain DM line.",
        createdAt: "2026-05-28T11:50:00.000Z",
      }),
      message({
        id: "dm-nova",
        senderId: "agent-1",
        content: "Plain DM reply.",
        createdAt: "2026-05-28T11:51:00.000Z",
      }),
    ]);
    chatMocks.getChat.mockResolvedValue(dmDetail);
    chatMocks.listChatMessages.mockResolvedValue(dmMessages);
    const { container, root } = await renderDom(
      <ChatView agentId="agent-1" chatId="chat-1" />,
      (client) => seedChat(client, dmDetail, dmMessages),
      "/?focus=agent-1",
    );
    await waitForText(container, "Plain DM reply.");
    await act(async () => root.unmount());
    const writes = readStateMocks.setReadState.mock.calls.filter((call) => call[0] === "chat-1");
    expect(writes.length).toBeGreaterThan(0);
    for (const call of writes) {
      expect(call[2]).toBe("dm-nova");
    }
  });

  it("still offers the filter when a departed third party never addressed the viewer", async () => {
    const { ChatView } = await import("../chat-view.js");
    // Current speakers are exactly {viewer, Nova}, and departed agent-2 only
    // ever talked TO NOVA — so it is not a filter candidate, but its side
    // conversation is still in history. Filtering on Nova is therefore NOT a
    // no-op, and the control must stay available (the suppression shares the
    // projection's own predicate, membership shape alone is not enough).
    const shrunkDetail = chatDetail({
      participants: [
        participant({ agentId: "human-agent-self", type: "human", name: "gandy", displayName: "Gandy" }),
        participant({ agentId: "agent-1", name: "nova", displayName: "Nova" }),
      ],
    });
    const history = messages([
      message({
        id: "sup-b-to-nova",
        senderId: "agent-2",
        content: "Legacy design note for Nova only.",
        createdAt: "2026-05-28T11:49:00.000Z",
        metadata: { mentions: ["agent-1"] },
      }),
      message({
        id: "sup-viewer-plain",
        senderId: "human-agent-self",
        content: "Plain unaddressed viewer line.",
        createdAt: "2026-05-28T11:50:00.000Z",
      }),
      message({
        id: "sup-viewer-to-nova",
        senderId: "human-agent-self",
        content: "Nova, your turn.",
        createdAt: "2026-05-28T11:51:00.000Z",
        metadata: { mentions: ["agent-1"] },
      }),
      message({
        id: "sup-nova-reply",
        senderId: "agent-1",
        content: "On it, boss.",
        createdAt: "2026-05-28T11:52:00.000Z",
        metadata: { mentions: ["human-agent-self"] },
      }),
    ]);
    chatMocks.getChat.mockResolvedValue(shrunkDetail);
    chatMocks.listChatMessages.mockResolvedValue(history);
    const { container, root } = await renderDom(
      <ChatView agentId="agent-1" chatId="chat-1" />,
      (client) => seedChat(client, shrunkDetail, history),
      "/",
    );

    await waitForText(container, "Legacy design note for Nova only.");
    const trigger = container.querySelector("[data-message-filter-trigger]");
    expect(trigger).not.toBeNull();
    await click(trigger);
    const menu = document.body.querySelector('[role="menu"][aria-label="Filter messages"]');
    if (!menu) throw new Error("filter menu missing");
    await click(buttonByText(menu, "Nova"));

    await waitForText(container, "Showing your conversation with Nova");
    expect(container.textContent).toContain("On it, boss.");
    expect(container.textContent).not.toContain("Legacy design note for Nova only.");
    // Third-party trace in history keeps the group rule too.
    expect(container.textContent).not.toContain("Plain unaddressed viewer line.");

    await act(async () => root.unmount());
  });

  it("clamps the persisted scroll anchor below an interleaved hidden message", async () => {
    const { ChatView } = await import("../chat-view.js");
    // visible-A1, hidden-B2, visible-A3: the filtered DOM bottom (A3) is
    // chronologically AFTER the hidden B2. Persisting A3 as the scroll
    // anchor would land the next ordinary visit below B2, whose live
    // bottom-advance would then swallow B2's pill. Both persisted ids must
    // stay at A1 — the safe side of the oldest hidden row.
    const interleaved = messages([
      message({
        id: "il-nova-a1",
        senderId: "agent-1",
        content: "Pair line before the hidden arrival.",
        createdAt: "2026-05-28T11:50:00.000Z",
        metadata: { mentions: ["human-agent-self"] },
      }),
      message({
        id: "il-design-b2",
        senderId: "agent-2",
        content: "Hidden interleaved note.",
        createdAt: "2026-05-28T11:51:00.000Z",
        metadata: { mentions: ["human-agent-self"] },
      }),
      message({
        id: "il-nova-a3",
        senderId: "agent-1",
        content: "Pair line after the hidden arrival.",
        createdAt: "2026-05-28T11:52:00.000Z",
        metadata: { mentions: ["human-agent-self"] },
      }),
    ]);
    chatMocks.listChatMessages.mockResolvedValue(interleaved);
    const { root } = await renderDom(
      <ChatView agentId="agent-1" chatId="chat-1" />,
      (client) => seedChat(client, chatDetail(), interleaved),
      "/?focus=agent-1",
    );
    await act(async () => root.unmount());
    const writes = readStateMocks.setReadState.mock.calls.filter((call) => call[0] === "chat-1");
    expect(writes.length).toBeGreaterThan(0);
    for (const call of writes) {
      expect(call[1]).toBe("il-nova-a1");
      expect(call[2]).toBe("il-nova-a1");
    }

    // Full revisit restored at the clamped anchor: the hidden message is
    // surfaced as new (divider), not silently digested.
    readStateMocks.setReadState.mockClear();
    document.body.innerHTML = "";
    const { container: revisit, root: revisitRoot } = await renderDom(
      <ChatView agentId="agent-1" chatId="chat-1" />,
      (client) => {
        seedChat(client, chatDetail(), interleaved);
        client.setQueryData(["chat-read-state", "chat-1"], {
          chatId: "chat-1",
          bottomVisibleMessageId: "il-nova-a1",
          latestKnownMessageId: "il-nova-a1",
          updatedAt: Date.now(),
        });
      },
      "/",
    );
    await waitForText(revisit, "Hidden interleaved note.");
    await waitForText(revisit, "New Messages");
    await act(async () => revisitRoot.unmount());
  });

  it("keeps the hidden arrival marked as new across a same-session filter lift", async () => {
    const { ChatView } = await import("../chat-view.js");
    // The interleaved shape again, but the filter is lifted IN the mounted
    // view. Two anchors must both hold: the stale filtered live-bottom (A3)
    // is provenance-gated so it cannot promote the session high-water when
    // the ceiling releases, and a filtered divider dismissal advances the
    // divider anchor only to the clamped bound (A1). Either one advancing
    // to A3 would strip B2's "new" marking without the user reaching it.
    const observers: Array<{ cb: IntersectionObserverCallback; targets: Element[] }> = [];
    class RecordingIntersectionObserver {
      cb: IntersectionObserverCallback;
      targets: Element[] = [];
      constructor(cb: IntersectionObserverCallback) {
        this.cb = cb;
        observers.push({ cb, targets: this.targets });
      }
      observe = (target: Element) => {
        this.targets.push(target);
      };
      disconnect = vi.fn();
      unobserve = vi.fn();
    }
    Object.defineProperty(globalThis, "IntersectionObserver", {
      configurable: true,
      value: RecordingIntersectionObserver,
    });

    const interleaved = messages([
      message({
        id: "sl-nova-a1",
        senderId: "agent-1",
        content: "Pair line before the hidden arrival.",
        createdAt: "2026-05-28T11:50:00.000Z",
        metadata: { mentions: ["human-agent-self"] },
      }),
      message({
        id: "sl-design-b2",
        senderId: "agent-2",
        content: "Hidden interleaved note.",
        createdAt: "2026-05-28T11:51:00.000Z",
        metadata: { mentions: ["human-agent-self"] },
      }),
      message({
        id: "sl-nova-a3",
        senderId: "agent-1",
        content: "Pair line after the hidden arrival.",
        createdAt: "2026-05-28T11:52:00.000Z",
        metadata: { mentions: ["human-agent-self"] },
      }),
    ]);
    chatMocks.listChatMessages.mockResolvedValue(interleaved);
    const { container, root } = await renderDom(
      <ChatView agentId="agent-1" chatId="chat-1" />,
      (client) => {
        seedChat(client, chatDetail(), interleaved);
        // Previous visit ended at A1, so the divider arms for this visit.
        client.setQueryData(["chat-read-state", "chat-1"], {
          chatId: "chat-1",
          bottomVisibleMessageId: "sl-nova-a1",
          latestKnownMessageId: "sl-nova-a1",
          updatedAt: Date.now(),
        });
      },
      "/?focus=agent-1",
    );
    await waitForText(container, "Pair line after the hidden arrival.");
    expect(container.textContent).toContain("New Messages");

    // Scroll the divider past the viewport top while STILL FILTERED: the
    // dismissal advance must clamp to A1, not adopt the filtered bottom A3.
    const dividerObservers = observers.filter((o) => o.targets.some((t) => t.textContent?.includes("New Messages")));
    expect(dividerObservers.length).toBeGreaterThan(0);
    await act(async () => {
      for (const o of dividerObservers) {
        o.cb(
          [
            {
              rootBounds: { top: 100 } as DOMRectReadOnly,
              boundingClientRect: { bottom: 0 } as DOMRectReadOnly,
            } as IntersectionObserverEntry,
          ],
          o as unknown as IntersectionObserver,
        );
      }
    });
    await flush();

    // Lift the filter in the same mounted view. The stale filtered bottom
    // must not advance the high-water, and the divider anchor stayed at A1,
    // so the hidden arrival still reads as new after effects settle.
    await click(buttonByText(container, "Show all messages"));
    await waitForText(container, "Hidden interleaved note.");
    await flush();
    await flush();
    expect(container.textContent).toContain("New Messages");
    const pill = container.querySelector('button[aria-label$="new messages"], button[aria-label$="new message"]');
    expect(pill).not.toBeNull();

    // A dismissal callback firing AFTER the lift but BEFORE any fresh
    // unfiltered bottom publication (re-rendering the timeline can trigger
    // the observer): the observation ref still holds the filtered bottom
    // (A3) while the clamp now has no ceiling. The provenance gate must
    // refuse it — B2 keeps its divider and pill.
    const postLiftDividerObservers = observers.filter((o) =>
      o.targets.some((t) => t.textContent?.includes("New Messages")),
    );
    expect(postLiftDividerObservers.length).toBeGreaterThan(0);
    await act(async () => {
      for (const o of postLiftDividerObservers) {
        o.cb(
          [
            {
              rootBounds: { top: 100 } as DOMRectReadOnly,
              boundingClientRect: { bottom: 0 } as DOMRectReadOnly,
            } as IntersectionObserverEntry,
          ],
          o as unknown as IntersectionObserver,
        );
      }
    });
    await flush();
    await flush();
    expect(container.textContent).toContain("New Messages");
    expect(
      container.querySelector('button[aria-label$="new messages"], button[aria-label$="new message"]'),
    ).not.toBeNull();

    await act(async () => root.unmount());
  });

  it("keeps the watermark at the blocking question while a stored filter is active", async () => {
    const { ChatView } = await import("../chat-view.js");
    // Stored filter + an unanswered ask + a message AFTER the ask. The
    // blocking truncation hides everything past the question from the DOM,
    // so the ceiling must stop at the question — "hidden" means NOT
    // RENDERED, regardless of which layer (pair filter or block truncation)
    // hid the row. Building the ceiling from the filter projection alone
    // would persist the never-rendered trailing message as known.
    window.localStorage.setItem(
      "first-tree:chat-message-filter:v1",
      JSON.stringify({ "u:anon:chat:chat-1": { agentId: "agent-1", updatedAt: 1 } }),
    );
    const blockedHistory = messages([
      message({
        id: "bk-human-to-nova",
        senderId: "human-agent-self",
        content: "Nova, run the deploy.",
        createdAt: "2026-05-28T11:50:00.000Z",
        metadata: { mentions: ["agent-1"] },
      }),
      message({
        id: "bk-request",
        senderId: "agent-1",
        format: "request",
        content: "Approve the rollout window?",
        createdAt: "2026-05-28T11:51:00.000Z",
        metadata: { mentions: ["human-agent-self"], request: { multiSelect: false } },
      }),
      message({
        id: "bk-after",
        senderId: "agent-1",
        content: "Extra evidence after the question.",
        createdAt: "2026-05-28T11:52:00.000Z",
        metadata: { mentions: ["human-agent-self"] },
      }),
    ]);
    chatMocks.listChatMessages.mockResolvedValue(blockedHistory);
    const { root } = await renderDom(
      <ChatView agentId="agent-1" chatId="chat-1" />,
      (client) => seedChat(client, chatDetail(), blockedHistory),
      "/",
    );
    await act(async () => root.unmount());

    const writes = readStateMocks.setReadState.mock.calls.filter((call) => call[0] === "chat-1");
    expect(writes.length).toBeGreaterThan(0);
    for (const call of writes) {
      expect(call[2]).toBe("bk-request");
      expect(call[1]).not.toBe("bk-after");
    }
  });

  it("does not advance the read watermark past a hidden arrival on an own send", async () => {
    const { ChatView } = await import("../chat-view.js");
    // The hidden agent-2 message is the NEWEST loaded row; the viewer then
    // sends. The own send is chronologically after the hidden arrival, so
    // neither the durable read-state write nor the session pre-advance may
    // move the watermark to it.
    chatMocks.listChatMessages.mockResolvedValue(FILTER_MESSAGES);
    const { container, queryClient, root } = await renderDom(
      <ChatView agentId="agent-1" chatId="chat-1" />,
      (client) => seedChat(client, chatDetail(), FILTER_MESSAGES),
      "/?focus=agent-1",
    );
    await waitForText(container, "Deploy checked, all green.");

    const textarea = container.querySelector<HTMLTextAreaElement>("textarea");
    if (!textarea) throw new Error("Composer textarea missing");
    await setValue(textarea, "Ping @nova");
    await click(container.querySelector('button[aria-label="Send"]'));
    await waitForCondition(() => chatMocks.sendChatMessage.mock.calls.length > 0, "Expected the send to fire");
    await flush();

    for (const call of readStateMocks.setReadState.mock.calls) {
      expect(call[2]).not.toBe("msg-sent");
    }
    const cached = queryClient.getQueryData<{ latestKnownMessageId?: string }>(["chat-read-state", "chat-1"]);
    expect(cached?.latestKnownMessageId).not.toBe("msg-sent");

    await act(async () => root.unmount());
  });

  it("reports a failed focus window as a retryable load error, never as request age", async () => {
    const { ChatView } = await import("../chat-view.js");
    // The ordinary timeline is seeded (staleTime: Infinity), so this rejection
    // hits ONLY the supplemental focus-window query.
    chatMocks.listChatMessages.mockRejectedValue(new Error("history unavailable"));
    const { container, root } = await renderDom(
      <ChatView agentId="agent-1" chatId="chat-1" />,
      (client) => seedChat(client, chatDetail(), FILTER_MESSAGES),
      "/?focus=agent-1&focusMsg=req-outside-window",
    );

    // A failed fetch is not evidence the request is old: the age line must
    // stay absent and the failure must be visible + retryable instead.
    await waitForText(container, "Earlier chat could not be loaded.");
    expect(container.textContent).not.toContain("older than the loaded history");
    expect(container.querySelector("[data-focus-window-error]")).not.toBeNull();

    // Retry succeeds; the request is genuinely outside the window, so the
    // honest age report replaces the error line.
    chatMocks.listChatMessages.mockResolvedValue(FILTER_MESSAGES);
    await click(buttonByText(container, "Retry"));
    await waitForText(container, "older than the loaded history");
    expect(container.querySelector("[data-focus-window-error]")).toBeNull();

    await act(async () => root.unmount());
  });

  it("does not strand the new-messages pill on an arrival the pair filter hides", async () => {
    const { ChatView } = await import("../chat-view.js");
    chatMocks.listChatMessages.mockResolvedValue(FILTER_MESSAGES);
    const lateArrival = message({
      id: "pf-late-design",
      senderId: "agent-2",
      content: "Late design note.",
      createdAt: "2026-05-28T12:05:00.000Z",
      metadata: { mentions: ["human-agent-self"] },
    });
    const { container, queryClient, root } = await renderDom(
      <ChatView agentId="agent-1" chatId="chat-1" />,
      (client) => {
        seedChat(client, chatDetail(), FILTER_MESSAGES);
        // Previous visit left the chat at the newest pair message, so any
        // later non-self arrival is "new since last visit".
        client.setQueryData(["chat-read-state", "chat-1"], {
          chatId: "chat-1",
          bottomVisibleMessageId: "pf-design-to-human",
          latestKnownMessageId: "pf-design-to-human",
          updatedAt: Date.now(),
        });
      },
      "/?focus=agent-1",
    );
    await waitForText(container, "Showing your conversation with Nova");

    // A filtered-out agent's message arrives. It has no DOM row, so scrolling
    // could never advance the watermark past it — the pill must not count it.
    await act(async () => {
      queryClient.setQueryData(["chat-messages", "chat-1"], messages([...FILTER_MESSAGES.items, lateArrival]));
    });
    await flush();
    expect(container.querySelector('button[aria-label$="new message"]')).toBeNull();
    expect(container.querySelector('button[aria-label$="new messages"]')).toBeNull();

    // Lifting the filter surfaces the arrival itself. (The pill's own
    // clear-on-reach behavior is unchanged; in this harness the read tracker
    // reaches the new row as soon as it renders, so the pill is not asserted
    // here — the regression under test is the STUCK pill above.)
    await click(buttonByText(container, "Show all messages"));
    await waitForText(container, "Late design note.");

    await act(async () => root.unmount());
  });

  it("filters via the header control and persists the choice for this user + chat", async () => {
    const { ChatView } = await import("../chat-view.js");
    chatMocks.listChatMessages.mockResolvedValue(FILTER_MESSAGES);
    const { container, root } = await renderDom(
      <ChatView agentId="agent-1" chatId="chat-1" />,
      (client) => seedChat(client, chatDetail(), FILTER_MESSAGES),
      "/",
    );

    await waitForText(container, "Design notes for the banner.");
    expect(container.querySelector("[data-message-filter-banner]")).toBeNull();

    await click(container.querySelector("[data-message-filter-trigger]"));
    const menu = document.body.querySelector('[role="menu"][aria-label="Filter messages"]');
    expect(menu).not.toBeNull();
    if (!menu) throw new Error("filter menu missing");
    expect(buttonByText(menu, "All messages")).not.toBeNull();
    await click(buttonByText(menu, "Nova"));

    await waitForText(container, "Showing your conversation with Nova");
    // An explicit choice is not the transient navigation-applied view.
    expect(container.textContent).not.toContain("temporary view");
    expect(container.textContent).not.toContain("Design notes for the banner.");
    const stored: unknown = JSON.parse(window.localStorage.getItem("first-tree:chat-message-filter:v1") ?? "{}");
    expect(stored).toMatchObject({ "u:anon:chat:chat-1": { agentId: "agent-1" } });

    await act(async () => root.unmount());
  });

  it("restores a stored filter choice when the chat opens", async () => {
    window.localStorage.setItem(
      "first-tree:chat-message-filter:v1",
      JSON.stringify({ "u:anon:chat:chat-1": { agentId: "agent-2", updatedAt: 1 } }),
    );
    const { ChatView } = await import("../chat-view.js");
    chatMocks.listChatMessages.mockResolvedValue(FILTER_MESSAGES);
    const { container, root } = await renderDom(
      <ChatView agentId="agent-1" chatId="chat-1" />,
      (client) => seedChat(client, chatDetail(), FILTER_MESSAGES),
      "/",
    );

    await waitForText(container, "Showing your conversation with Design Critique");
    expect(container.textContent).toContain("Design notes for the banner.");
    expect(container.textContent).not.toContain("Deploy checked, all green.");

    await act(async () => root.unmount());
  });
});

describe("need-you queue session", () => {
  const OPEN_ASK = message({
    id: "nq-request",
    senderId: "agent-1",
    format: "request",
    content: "Queue question: approve?",
    metadata: { mentions: ["human-agent-self"], request: { multiSelect: false } },
    createdAt: "2026-05-28T11:50:00.000Z",
  });

  async function answerOpenAsk(container: HTMLElement) {
    await waitForText(container, "Queue question: approve?");
    const answerBox = container.querySelector<HTMLTextAreaElement>('textarea[placeholder^="Type your answer"]');
    if (!answerBox) throw new Error("takeover answer input missing");
    await setValue(answerBox, "Approved.");
    await click(buttonByText(container, "Submit"));
    await waitForCondition(() => chatMocks.sendChatMessage.mock.calls.length > 0, "resolving send");
    await flush();
    await flush();
  }

  it("advances to the next chat holding an open question after answering", async () => {
    const { ChatView } = await import("../chat-view.js");
    chatMocks.listChatOpenRequests.mockResolvedValue({ items: [OPEN_ASK] });
    meChatMocks.listNeedYouRequests.mockResolvedValue({
      items: [{ request: { id: "req-next" }, chat: { id: "chat-2", title: "Next" }, asker: { agentId: "agent-2" } }],
      total: 1,
      nextCursor: null,
    });
    const { container, root } = await renderDom(
      <>
        <ChatView agentId="agent-1" chatId="chat-1" />
        <LocationProbe />
      </>,
      (client) => {
        seedChat(client, chatDetail(), messages([OPEN_ASK]));
        client.setQueryData(["chat-open-requests", "chat-1"], { items: [OPEN_ASK] });
      },
      "/?nq=1",
    );

    await answerOpenAsk(container);

    // Queue session active + next question lives in another chat: the
    // resolution navigates there (a push — Back walks the queue hops) and
    // keeps the session flag for the question after it.
    await waitForCondition(() => locText(container)?.includes("c=chat-2") === true, "expected queue advance");
    expect(locText(container)).toContain("nq=1");

    await act(async () => root.unmount());
  });

  it("ends the queue session in place when the queue is empty", async () => {
    const { ChatView } = await import("../chat-view.js");
    chatMocks.listChatOpenRequests.mockResolvedValue({ items: [OPEN_ASK] });
    meChatMocks.listNeedYouRequests.mockResolvedValue({ items: [], total: 0, nextCursor: null });
    const { container, root } = await renderDom(
      <>
        <ChatView agentId="agent-1" chatId="chat-1" />
        <LocationProbe />
      </>,
      (client) => {
        seedChat(client, chatDetail(), messages([OPEN_ASK]));
        client.setQueryData(["chat-open-requests", "chat-1"], { items: [OPEN_ASK] });
      },
      "/?nq=1",
    );

    await answerOpenAsk(container);

    await waitForCondition(() => locText(container) === "/", "expected the session flag to clear in place");

    await act(async () => root.unmount());
  });

  it("never lets a stale queue continuation override a manual chat switch", async () => {
    const { ChatView } = await import("../chat-view.js");
    chatMocks.listChatOpenRequests.mockResolvedValue({ items: [OPEN_ASK] });
    meChatMocks.listNeedYouRequests.mockResolvedValue({
      items: [{ request: { id: "req-next" }, chat: { id: "chat-2", title: "Next" }, asker: { agentId: "agent-2" } }],
      total: 1,
      nextCursor: null,
    });
    // The resolving send stays in flight until the test releases it, keeping
    // the rail-usable window open.
    let releaseSend!: (value: MessageWithDelivery) => void;
    chatMocks.sendChatMessage.mockImplementation(
      () =>
        new Promise<MessageWithDelivery>((resolve) => {
          releaseSend = resolve;
        }),
    );

    // Harness stand-in for the workspace shell: the chat follows `?c=` and a
    // rail-like button performs a manual switch (new chat + `nq` deleted).
    function QueueRaceHarness() {
      const [params, setParams] = useSearchParams();
      const chatId = params.get("c") ?? "chat-1";
      return (
        <>
          <ChatView agentId="agent-1" chatId={chatId} />
          <button
            type="button"
            onClick={() => {
              const next = new URLSearchParams(params);
              next.set("c", "chat-elsewhere");
              next.delete("nq");
              setParams(next);
            }}
          >
            Manual switch
          </button>
          <LocationProbe />
        </>
      );
    }

    const { container, root } = await renderDom(
      <QueueRaceHarness />,
      (client) => {
        seedChat(client, chatDetail(), messages([OPEN_ASK]));
        client.setQueryData(["chat-open-requests", "chat-1"], { items: [OPEN_ASK] });
      },
      "/?nq=1",
    );

    await waitForText(container, "Queue question: approve?");
    const answerBox = container.querySelector<HTMLTextAreaElement>('textarea[placeholder^="Type your answer"]');
    if (!answerBox) throw new Error("takeover answer input missing");
    await setValue(answerBox, "Approved.");
    await click(buttonByText(container, "Submit"));
    await waitForCondition(() => chatMocks.sendChatMessage.mock.calls.length > 0, "send started");

    // Mid-flight manual exit: switches chat and deletes `nq`.
    await click(buttonByText(container, "Manual switch"));
    expect(locText(container)).toBe("/?c=chat-elsewhere");

    // The send settles AFTER the switch. The stale continuation must neither
    // navigate to the queue's next chat nor resurrect the session flag.
    await act(async () => {
      releaseSend(message({ id: "msg-late", senderId: "human-agent-self", createdAt: "2026-05-28T12:10:00.000Z" }));
    });
    await flush();
    await flush();
    expect(locText(container)).toBe("/?c=chat-elsewhere");
    expect(locText(container)).not.toContain("nq=1");
    expect(locText(container)).not.toContain("chat-2");

    await act(async () => root.unmount());
  });

  it("respects a same-chat session exit that lands while the queue fetch is pending", async () => {
    const { ChatView } = await import("../chat-view.js");
    chatMocks.listChatOpenRequests.mockResolvedValue({ items: [OPEN_ASK] });
    // Hold the QUEUE fetch (not the send): the exit happens in the window
    // between resolution and the continuation's write.
    let releaseQueue!: (value: { items: unknown[]; total: number; nextCursor: null }) => void;
    meChatMocks.listNeedYouRequests.mockImplementation(
      () =>
        new Promise((resolve) => {
          releaseQueue = resolve;
        }),
    );

    // Same chat throughout — the exit only deletes `nq` (the shape of
    // re-clicking the already-selected rail row).
    function SameChatExitHarness() {
      const [params, setParams] = useSearchParams();
      return (
        <>
          <ChatView agentId="agent-1" chatId="chat-1" />
          <button
            type="button"
            onClick={() => {
              const next = new URLSearchParams(params);
              next.delete("nq");
              setParams(next);
            }}
          >
            End session
          </button>
          <LocationProbe />
        </>
      );
    }

    const { container, root } = await renderDom(
      <SameChatExitHarness />,
      (client) => {
        seedChat(client, chatDetail(), messages([OPEN_ASK]));
        client.setQueryData(["chat-open-requests", "chat-1"], { items: [OPEN_ASK] });
      },
      "/?nq=1",
    );

    await waitForText(container, "Queue question: approve?");
    const answerBox = container.querySelector<HTMLTextAreaElement>('textarea[placeholder^="Type your answer"]');
    if (!answerBox) throw new Error("takeover answer input missing");
    await setValue(answerBox, "Approved.");
    await click(buttonByText(container, "Submit"));
    await waitForCondition(() => meChatMocks.listNeedYouRequests.mock.calls.length > 0, "queue fetch started");

    // The user exits the session in place — same chat, `nq` deleted.
    await click(buttonByText(container, "End session"));
    expect(locText(container)).toBe("/");

    // The queue settles with a next chat available. The committed chat never
    // changed, so only the LIVE params can protect this exit: no navigation,
    // no resurrected flag.
    await act(async () => {
      releaseQueue({
        items: [{ request: { id: "req-next" }, chat: { id: "chat-2", title: "Next" }, asker: { agentId: "a2" } }],
        total: 1,
        nextCursor: null,
      });
    });
    await flush();
    await flush();
    expect(locText(container)).toBe("/");

    await act(async () => root.unmount());
  });

  it("does not touch navigation when answering outside a queue session", async () => {
    const { ChatView } = await import("../chat-view.js");
    chatMocks.listChatOpenRequests.mockResolvedValue({ items: [OPEN_ASK] });
    const { container, root } = await renderDom(
      <>
        <ChatView agentId="agent-1" chatId="chat-1" />
        <LocationProbe />
      </>,
      (client) => {
        seedChat(client, chatDetail(), messages([OPEN_ASK]));
        client.setQueryData(["chat-open-requests", "chat-1"], { items: [OPEN_ASK] });
      },
      "/",
    );

    await answerOpenAsk(container);
    expect(locText(container)).toBe("/");
    expect(meChatMocks.listNeedYouRequests).not.toHaveBeenCalled();

    await act(async () => root.unmount());
  });
});
