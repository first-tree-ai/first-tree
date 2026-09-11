import type {
  Agent,
  AgentChatStatus,
  AgentRuntimeConfig,
  ChatDetail,
  ChatParticipantDetail,
  MeChatRow,
  MeMembership,
  Message,
  OrgContextTreeOutput,
  OrgSourceReposOutput,
} from "@first-tree/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactElement, ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter, Navigate, Route, Routes } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { HubClient, RuntimeAgent } from "../../api/activity.js";
import { chatAgentStatusQueryKey } from "../../api/agent-status.js";
import type { PaginatedMessages } from "../../api/chats.js";
import type { GithubRepo } from "../../api/github.js";
import { agentSessionsQueryKey, type SessionEventRow } from "../../api/sessions.js";
import { ToastProvider } from "../../components/ui/toast.js";
import type { OnboardingFlowValue } from "../onboarding/onboarding-flow.js";
import { ADMIN_STEPS, INVITEE_STEPS, type OnboardingPath, type StepId } from "../onboarding/steps.js";

const authMock = vi.hoisted(() => {
  const memberships: MeMembership[] = [];
  const currentMembership: MeMembership | null = null;
  const nullableString = (value: string | null): string | null => value;
  const onboardingStep = (value: "connect" | "create_agent" | "completed" | null) => value;
  return {
    value: {
      isAuthenticated: true,
      meLoaded: true,
      user: { id: "user-self", username: "gandy", displayName: "Gandy", avatarUrl: null },
      memberships,
      currentMembership,
      organizationId: nullableString("org-1"),
      memberId: nullableString("member-self"),
      role: nullableString("admin"),
      agentId: nullableString("human-agent-self"),
      teamDisplayName: nullableString("Acme"),
      orgHasOtherMembers: true,
      // Fully set-up user: connected + the selected org has a personal agent,
      // so the workspace renders rather than redirecting to onboarding.
      currentOrgHasUsableAgent: true,
      currentOrgHasPersonalAgent: true,
      onboardingStep: onboardingStep("completed"),
      onboardingDismissedAt: nullableString(null),
      onboardingCompletedAt: nullableString("2026-05-01T00:00:00.000Z"),
      dismissOnboarding: async () => undefined,
      restoreOnboarding: async () => undefined,
      applyOnboardingStamp: () => true,
      login: async () => undefined,
      adoptTokens: async () => undefined,
      selectOrganization: async () => undefined,
      refreshMe: async () => undefined,
      refreshMeStrict: async () => undefined,
      logout: () => undefined,
    },
  };
});

vi.mock("../../auth/auth-context.js", () => ({
  AuthProvider: ({ children }: { children: ReactNode }) => children,
  useAuth: () => authMock.value,
}));

vi.mock("../../hooks/use-admin-ws.js", () => ({
  useAdminWs: () => undefined,
}));

vi.mock("../../lib/use-agent-name-map.js", () => ({
  useAgentNameMap: () => (id: string | null | undefined) => {
    if (!id) return "unknown";
    return AGENT_NAMES[id] ?? id;
  },
  useAgentIdentityMap: () => (id: string | null | undefined) => {
    if (!id) return null;
    return {
      name: AGENT_SLUGS[id] ?? id,
      displayName: AGENT_NAMES[id] ?? id,
      avatarImageUrl: null,
      avatarColorToken: null,
    };
  },
  useAgentSlugToIdMap: () => (slug: string | null | undefined) => {
    if (!slug) return null;
    const lower = slug.toLowerCase();
    return Object.entries(AGENT_SLUGS).find(([, value]) => value === lower)?.[0] ?? null;
  },
}));

vi.mock("../../lib/use-member-name-map.js", () => ({
  useMemberNameMap: () => (id: string | null | undefined) => {
    if (!id) return "unknown";
    return MEMBER_NAMES[id] ?? id;
  },
}));

const NOW = "2026-05-28T12:00:00.000Z";

const MEMBER_NAMES: Record<string, string> = {
  "member-self": "Gandy",
  "member-alice": "Alice",
};

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
    inboxId: overrides.inboxId ?? `${overrides.uuid ?? "agent-1"}-inbox`,
    metadata: overrides.metadata ?? {},
    source: overrides.source ?? "portal",
    clientId: overrides.clientId ?? "client-1",
    runtimeProvider: overrides.runtimeProvider ?? "claude-code",
    runtimeState: overrides.runtimeState ?? "idle",
    createdAt: overrides.createdAt ?? NOW,
    updatedAt: overrides.updatedAt ?? NOW,
  };
}

const MEMBERS = [
  {
    id: "member-self",
    agentId: "human-agent-self",
    userId: "user-self",
    username: "gandy",
    displayName: "Gandy",
    role: "admin",
    createdAt: NOW,
  },
  {
    id: "member-alice",
    agentId: "human-agent-alice",
    userId: "user-alice",
    username: "alice",
    displayName: "Alice",
    role: "member",
    createdAt: NOW,
  },
];

const CLIENTS: HubClient[] = [
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
    capabilities: {
      "claude-code": {
        state: "ok",
        available: true,
        sdkVersion: "0.2.84",
        detectedAt: NOW,
      },
      codex: {
        state: "ok",
        available: true,
        sdkVersion: "0.134.0",
        detectedAt: NOW,
      },
    },
  },
  {
    id: "client-2",
    userId: "user-alice",
    status: "disconnected",
    authState: "expired",
    binName: "first-tree-dev",
    sdkVersion: "0.5.0",
    hostname: "alice-linux",
    os: "linux",
    agentCount: 1,
    connectedAt: null,
    lastSeenAt: "2026-05-28T11:00:00.000Z",
    capabilities: {},
  },
];

const RUNTIME_AGENTS: RuntimeAgent[] = [
  {
    agentId: "agent-1",
    type: "agent",
    clientId: "client-1",
    runtimeState: "idle",
    runtimeType: "claude-code",
    activeSessions: 1,
    totalSessions: 2,
    runtimeUpdatedAt: NOW,
    managedByMe: true,
  },
  {
    agentId: "agent-2",
    type: "agent",
    clientId: "client-2",
    runtimeState: "offline",
    runtimeType: "codex",
    activeSessions: 0,
    totalSessions: 1,
    runtimeUpdatedAt: "2026-05-28T11:00:00.000Z",
    managedByMe: false,
  },
  {
    agentId: "human-agent-self",
    type: "human",
    clientId: null,
    runtimeState: null,
    runtimeType: null,
    activeSessions: null,
    totalSessions: null,
    runtimeUpdatedAt: null,
    managedByMe: true,
  },
];

function participant(overrides: Partial<ChatParticipantDetail> & { agentId: string }): ChatParticipantDetail {
  return {
    agentId: overrides.agentId,
    role: overrides.role ?? "member",
    mode: overrides.mode ?? "full",
    joinedAt: overrides.joinedAt ?? NOW,
    name: overrides.name ?? (overrides.type === "human" ? "gandy" : "nova"),
    displayName: overrides.displayName ?? AGENT_NAMES[overrides.agentId] ?? overrides.agentId,
    type: overrides.type ?? "agent",
    avatarColorToken: overrides.avatarColorToken ?? null,
    avatarImageUrl: overrides.avatarImageUrl ?? null,
  };
}

const CHAT_PARTICIPANTS: ChatParticipantDetail[] = [
  participant({ agentId: "human-agent-self", name: "gandy", displayName: "Gandy", type: "human" }),
  participant({ agentId: "human-agent-alice", name: "alice", displayName: "Alice", type: "human" }),
  participant({ agentId: "agent-1", name: "nova", displayName: "Nova", type: "agent", avatarColorToken: "hue-2" }),
  participant({ agentId: "agent-2", name: "design", displayName: "Design Critique", type: "agent" }),
];

function chatRow(overrides: Partial<MeChatRow> = {}): MeChatRow {
  return {
    chatId: overrides.chatId ?? "chat-1",
    type: overrides.type ?? "group",
    membershipKind: overrides.membershipKind ?? "participant",
    createdByMe: overrides.createdByMe ?? false,
    source: overrides.source ?? "manual",
    entityType: overrides.entityType ?? null,
    title: overrides.title ?? "Launch planning",
    topic: overrides.topic ?? "Launch planning",
    description: overrides.description ?? null,
    participants: overrides.participants ?? CHAT_PARTICIPANTS,
    participantCount: overrides.participantCount ?? CHAT_PARTICIPANTS.length,
    lastMessageAt: overrides.lastMessageAt ?? NOW,
    lastMessagePreview: overrides.lastMessagePreview ?? "Please review the launch checklist.",
    unreadMentionCount: overrides.unreadMentionCount ?? 1,
    openRequestCount: overrides.openRequestCount ?? 0,
    canReply: overrides.canReply ?? true,
    engagementStatus: overrides.engagementStatus ?? "active",
    liveActivity:
      overrides.liveActivity ??
      ({
        agentId: "agent-1",
        kind: "tool_call",
        label: "Using Bash",
        startedAt: "2026-05-28T11:59:00.000Z",
      } satisfies MeChatRow["liveActivity"]),
    failedAgentIds: overrides.failedAgentIds ?? [],
    busyAgentIds: overrides.busyAgentIds ?? ["agent-1"],
    chatHasExplicitMentionToMe: overrides.chatHasExplicitMentionToMe ?? true,
    pinnedAt: null,
    activityAt: null,
  };
}

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
    metadata:
      overrides.metadata ??
      ({
        source: "github",
        entityUrl: "https://github.com/acme/web/pull/42",
      } satisfies Record<string, unknown>),
    createdAt: overrides.createdAt ?? NOW,
    updatedAt: overrides.updatedAt ?? NOW,
    participants: overrides.participants ?? CHAT_PARTICIPANTS,
    title: overrides.title ?? "Launch planning",
    firstMessagePreview: overrides.firstMessagePreview ?? "Please review the launch checklist.",
    engagementStatus: overrides.engagementStatus ?? "active",
    viewerMembershipKind: overrides.viewerMembershipKind ?? "participant",
  };
}

function message(overrides: Partial<Message> & { id: string; senderId: string; content?: unknown }): Message {
  return {
    id: overrides.id,
    chatId: overrides.chatId ?? "chat-1",
    senderId: overrides.senderId,
    senderKind: overrides.senderKind ?? "member",
    senderProvider: overrides.senderProvider ?? null,
    format: overrides.format ?? "text",
    content: overrides.content ?? "Please review `docs/plan.md` and @nova for rollout risks.",
    metadata: overrides.metadata ?? {},
    inReplyTo: overrides.inReplyTo ?? null,
    source: overrides.source ?? "web",
    createdAt: overrides.createdAt ?? NOW,
  };
}

const CHAT_MESSAGES: PaginatedMessages = {
  items: [
    message({
      id: "msg-1",
      senderId: "human-agent-self",
      createdAt: "2026-05-28T11:55:00.000Z",
      content: "Please review `docs/plan.md` and @nova for rollout risks.",
      metadata: {
        documentContext: {
          basePath: "/workspace/acme",
          files: [
            {
              path: "docs/plan.md",
              status: "included",
              content: "# Plan\nShip carefully.",
            },
          ],
          failedMentions: [{ path: "secrets.env", reason: "hidden" }],
        },
        mentions: ["agent-1"],
      },
    }),
    message({
      id: "msg-2",
      senderId: "agent-1",
      createdAt: "2026-05-28T11:57:00.000Z",
      content: "I found one deployment risk and opened an ask.",
      metadata: {},
      source: "api",
    }),
    message({
      id: "msg-3",
      senderId: "agent-2",
      format: "file",
      createdAt: "2026-05-28T11:58:00.000Z",
      content: {
        caption: "Here is the preview.",
        attachments: [{ imageId: "image-1", mimeType: "image/png", filename: "preview.png", size: 42 }],
      },
      metadata: {},
      source: "api",
    }),
  ],
  nextCursor: null,
};

const SESSION_EVENTS: { items: SessionEventRow[]; nextCursor: number | null } = {
  items: [
    {
      id: "event-1",
      agentId: "agent-1",
      chatId: "chat-1",
      seq: 1,
      kind: "tool_call",
      payload: { toolUseId: "tool-1", name: "Bash", args: { cmd: "pnpm test" }, status: "pending" },
      createdAt: "2026-05-28T11:56:00.000Z",
    },
    {
      id: "event-2",
      agentId: "agent-1",
      chatId: "chat-1",
      seq: 2,
      kind: "assistant_text",
      payload: { text: "Checking the route behavior now." },
      createdAt: "2026-05-28T11:56:10.000Z",
    },
    {
      id: "event-3",
      agentId: "agent-1",
      chatId: "chat-1",
      seq: 3,
      kind: "error",
      payload: { source: "runtime", message: "Example recoverable runtime error" },
      createdAt: "2026-05-28T11:56:20.000Z",
    },
  ],
  nextCursor: null,
};

const CHAT_STATUSES: AgentChatStatus[] = [
  {
    agentId: "agent-1",
    main: "working",
    reachable: true,
    engagement: "active",
    working: true,
    errored: false,
    activity: {
      agentId: "agent-1",
      kind: "tool_call",
      label: "Bash",
      detail: "pnpm test",
      startedAt: "2026-05-28T11:59:00.000Z",
      turnText: "Checking the rollout path.",
    },
  },
  {
    agentId: "agent-2",
    main: "ready",
    reachable: true,
    engagement: "active",
    working: false,
    errored: false,
    activity: null,
  },
];

const GITHUB_REPOS: GithubRepo[] = [
  {
    fullName: "acme/web",
    cloneUrl: "https://github.com/acme/web.git",
    htmlUrl: "https://github.com/acme/web",
    private: false,
    defaultBranch: "main",
    pushedAt: NOW,
  },
  {
    fullName: "acme/api",
    cloneUrl: "git@github.com:acme/api.git",
    htmlUrl: "https://github.com/acme/api",
    private: true,
    defaultBranch: "main",
    pushedAt: NOW,
  },
];

const CONTEXT_TREE_SETTING: OrgContextTreeOutput = {
  repo: "https://github.com/acme/context-tree",
  branch: "main",
};

const SOURCE_REPOS_SETTING: OrgSourceReposOutput = {
  repos: [
    { url: "https://github.com/acme/web.git", defaultBranch: "main" },
    { url: "git@github.com:acme/api.git", defaultBranch: "main" },
  ],
};

const AGENT_CONFIG: AgentRuntimeConfig = {
  agentId: "agent-1",
  version: 7,
  payload: {
    kind: "claude-code",
    prompt: { append: "Always explain tradeoffs." },
    model: "sonnet",
    reasoningEffort: "high",
    mcpServers: [
      {
        name: "filesystem",
        transport: "stdio",
        command: "npx",
        args: ["-y", "@modelcontextprotocol/server-filesystem", "/workspace"],
      },
      {
        name: "docs",
        transport: "http",
        url: "https://docs.example.com/mcp",
        headers: { Authorization: "Bearer test" },
      },
    ],
    env: [
      { key: "FIRST_TREE_ENV", value: "test", sensitive: false },
      { key: "OPENAI_API_KEY", value: "***", sensitive: true },
    ],
    gitRepos: [
      { url: "https://github.com/acme/web.git", localPath: "web", ref: "main" },
      { url: "git@github.com:acme/api.git", localPath: "api" },
    ],
    resourceSkills: [],
  },
  updatedAt: NOW,
  updatedBy: "member-self",
};

function createClient(): QueryClient {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false, refetchOnWindowFocus: false },
      mutations: { retry: false },
    },
  });

  const agents = [agent(), agent({ uuid: "agent-2", name: "design-critique", displayName: "Design Critique" })];
  const humanAgent = agent({
    uuid: "human-agent-self",
    name: "gandy",
    displayName: "Gandy",
    type: "human",
    clientId: null,
    delegateMention: "agent-1",
  });
  const orgAgents = [humanAgent, ...agents];
  queryClient.setQueryData(["clients", "org"], CLIENTS);
  queryClient.setQueryData(
    ["clients", "me"],
    CLIENTS.filter((c) => c.userId === "user-self"),
  );
  queryClient.setQueryData(["clients"], CLIENTS);
  queryClient.setQueryData(["clients", "team-page"], CLIENTS);
  queryClient.setQueryData(["members"], MEMBERS);
  queryClient.setQueryData(["activity"], { agents: RUNTIME_AGENTS, clients: CLIENTS });
  queryClient.setQueryData(["agents", "team-page", "admin"], agents);
  queryClient.setQueryData(["agents"], { items: agents, nextCursor: null });
  queryClient.setQueryData(["agents", "org-list"], { items: orgAgents, nextCursor: null });
  queryClient.setQueryData(["agents", "org-list", "search", ""], { items: orgAgents, nextCursor: null });
  queryClient.setQueryData(["managed-agents", "name-map"], agents);
  queryClient.setQueryData(["agent", "agent-1"], agents[0]);
  queryClient.setQueryData(["agent-config", "agent-1"], AGENT_CONFIG);
  queryClient.setQueryData(["agent-resources", "agent-1"], {
    version: 7,
    templateIds: [],
    adoptedTemplates: [],
    effective: {
      version: 7,
      repos: [
        {
          id: "resource:repo-1",
          bindingId: null,
          resourceId: "repo-1",
          replacesResourceId: null,
          type: "repo",
          name: "Team web",
          scope: "team",
          source: "team_recommended",
          mode: "enabled",
          defaultEnabled: "recommended",
          payload: { url: "https://github.com/acme/web.git" },
          repo: { url: "https://github.com/acme/web.git", localPath: "web" },
          promptBody: null,
          unavailableReason: null,
          order: 0,
        },
      ],
      prompts: [],
      skills: [],
      mcp: [],
      unavailable: [],
    },
    bindings: [],
    availableTeamResources: [],
  });
  queryClient.setQueryData(["agent-client-status", "agent-1"], {
    clientId: "client-1",
    clientStatus: "connected",
    clientAuthState: "ok",
    hostname: "gandy-macbook",
    lastSeenAt: NOW,
  });
  queryClient.setQueryData(["agent-sessions-active", "agent-1"], []);
  queryClient.setQueryData(agentSessionsQueryKey("agent-1"), [
    {
      agentId: "agent-1",
      chatId: "chat-1",
      state: "active",
      runtimeState: "working",
      startedAt: "2026-05-28T11:52:00.000Z",
      lastActivityAt: NOW,
      messageCount: 3,
      summary: "Launch checklist review",
      topic: "Launch planning",
    },
  ]);
  // The rail reads via `useInfiniteQuery`, so seed the `InfiniteData` shape.
  const meInfinite = (rows: ReturnType<typeof chatRow>[]) => ({
    pages: [{ rows, nextCursor: null }],
    pageParams: [undefined],
  });
  queryClient.setQueryData(
    ["me", "chats", "all", "active", false, null, null],
    meInfinite([
      chatRow(),
      chatRow({
        chatId: "chat-2",
        title: "Archived design review",
        source: "github",
        entityType: "pull_request",
        unreadMentionCount: 0,
        busyAgentIds: [],
        chatHasExplicitMentionToMe: false,
        pinnedAt: null,
        activityAt: null,
        engagementStatus: "archived",
        lastMessageAt: "2026-05-27T09:00:00.000Z",
        lastMessagePreview: "Looks good.",
      }),
    ]),
  );
  // The triad is single-select: rendering with both `unread` + `watching`
  // canonicalizes to Unread, so the component requests watchingParam=false
  // (the 5th key slot) even though the smoke render passes both.
  queryClient.setQueryData(["me", "chats", "unread", "active", false, "manual", "agent-1"], meInfinite([chatRow()]));
  queryClient.setQueryData(
    ["me", "chats", "all", "archived", false, null, null],
    meInfinite([
      chatRow({
        chatId: "chat-2",
        title: "Archived design review",
        source: "github",
        entityType: "pull_request",
        unreadMentionCount: 0,
        busyAgentIds: [],
        chatHasExplicitMentionToMe: false,
        pinnedAt: null,
        activityAt: null,
        engagementStatus: "archived",
      }),
    ]),
  );
  queryClient.setQueryData(["chat-detail", "chat-1"], chatDetail());
  queryClient.setQueryData(["chat-messages-cache", "chat-1"], CHAT_MESSAGES.items.slice(0, 1));
  queryClient.setQueryData(["chat-messages", "chat-1"], CHAT_MESSAGES);
  queryClient.setQueryData(["chat-session-events", "chat-1"], {
    feeds: [{ agentId: "agent-1", ...SESSION_EVENTS }],
  });
  queryClient.setQueryData(["chat-read-state", "chat-1"], {
    chatId: "chat-1",
    bottomVisibleMessageId: "msg-1",
    latestKnownMessageId: "msg-1",
    updatedAt: Date.now(),
  });
  queryClient.setQueryData(chatAgentStatusQueryKey("chat-1"), CHAT_STATUSES);
  queryClient.setQueryData(["agent-skills", "agent-1"], {
    skills: [{ name: "review", description: "Review a change list." }],
  });
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
  queryClient.setQueryData(["onboarding", "installation", "org-1"], {
    installationId: 42,
    accountLogin: "acme",
    accountType: "Organization",
    accountGithubId: 12345,
    repositorySelection: "selected",
    permissions: { contents: "read", pull_requests: "write" },
    events: ["pull_request", "issues"],
    suspended: false,
    manageUrl: "https://github.com/organizations/acme/settings/installations/42",
    createdAt: NOW,
    updatedAt: NOW,
  });
  queryClient.setQueryData(["onboarding", "github-repos"], GITHUB_REPOS);
  queryClient.setQueryData(["onboarding", "context-tree", "org-1"], CONTEXT_TREE_SETTING);
  queryClient.setQueryData(["onboarding", "team-config", "org-1"], {
    treeUrl: CONTEXT_TREE_SETTING.repo,
    teamRepoUrls: SOURCE_REPOS_SETTING.repos.map((repo) => repo.url),
    hasInstallation: true,
    installationKnown: true,
  });
  queryClient.setQueryData(["org-setting", "org-1", "context_tree"], CONTEXT_TREE_SETTING);
  queryClient.setQueryData(["org-setting", "org-1", "source_repos"], SOURCE_REPOS_SETTING);
  queryClient.setQueryData(["github-app-installation", "org-1"], {
    installationId: 42,
    accountLogin: "acme",
    accountType: "Organization",
    accountGithubId: 12345,
    repositorySelection: "selected",
    permissions: { contents: "read", pull_requests: "write" },
    events: ["pull_request", "issues"],
    suspended: true,
    manageUrl: "https://github.com/organizations/acme/settings/installations/42",
    createdAt: NOW,
    updatedAt: NOW,
  });
  return queryClient;
}

function renderWithClient(element: ReactElement, queryClient: QueryClient, route = "/"): string {
  return renderToStaticMarkup(
    <MemoryRouter initialEntries={[route]}>
      <QueryClientProvider client={queryClient}>
        <ToastProvider>{element}</ToastProvider>
      </QueryClientProvider>
    </MemoryRouter>,
  );
}

function renderPage(element: ReactElement, route = "/"): string {
  return renderWithClient(element, createClient(), route);
}

type FlowOverrides = Partial<Omit<OnboardingFlowValue, "activeStep">> & {
  activeStep?: StepId | "connect-code";
};

function createFlowValue(overrides: FlowOverrides = {}): OnboardingFlowValue {
  const path: OnboardingPath = overrides.path ?? "admin";
  const sequence: readonly StepId[] = path === "admin" ? ADMIN_STEPS : INVITEE_STEPS;
  const fallbackStep: StepId = path === "admin" ? "create-team" : "get-started";
  const requestedActiveStep = overrides.activeStep;
  const activeStep: StepId =
    requestedActiveStep && (sequence as readonly string[]).includes(requestedActiveStep)
      ? (requestedActiveStep as StepId)
      : fallbackStep;
  const activeIndex = sequence.indexOf(activeStep);
  const base: OnboardingFlowValue = {
    path,
    sequence,
    activeIndex: overrides.activeIndex ?? Math.max(0, activeIndex),
    activeStep,
    goNext: () => undefined,
    goTo: () => undefined,
    reportStepFailure: () => undefined,
    organizationId: "org-1",
    memberId: "member-self",
    role: path === "admin" ? "admin" : "member",
    username: "gandy",
    teamDisplayName: "Acme",
    orgHasOtherMembers: true,
    computer: {
      connectedClients: CLIENTS[0] ? [CLIENTS[0]] : [],
      selectedClientId: CLIENTS[0]?.id ?? null,
      setSelectedClientId: () => undefined,
      connectedClient: CLIENTS[0] ?? null,
      capabilitiesLoaded: true,
      okRuntimes: ["claude-code", "codex"],
      selectedRuntime: "claude-code",
      setSelectedRuntime: () => undefined,
      cliCommand:
        "curl -fsSL https://download.first-tree.ai/releases/prod/install.sh | sh\n" +
        "~/.local/bin/first-tree login connect-token",
      tokenError: null,
      retry: () => undefined,
    },
    prepareByoBootstrap: () => undefined,
    agentDisplayName: "Gandy's assistant",
    setAgentDisplayName: () => undefined,
    visibility: "organization",
    setVisibility: () => undefined,
    agentPhase: "idle",
    agentError: null,
    createAgent: async () => undefined,
    retryAgent: async () => undefined,
    createdAgentUuid: "agent-1",
    hasAgent: true,
    selectedRepoUrls: ["https://github.com/acme/web.git"],
    setSelectedRepoUrls: () => undefined,
    hasRepoDraft: true,
    treeBindingPlan: "useBoundTree",
    setTreeBindingPlan: () => undefined,
    treeUrl: "https://github.com/acme/context-tree",
    setTreeUrl: () => undefined,
    treeAutoDetectDone: true,
    markTreeAutoDetectDone: () => undefined,
    offerTeamAgentStart: false,
    completeAndEnterChat: async () => undefined,
    finishLater: async () => undefined,
  };
  return {
    ...base,
    ...overrides,
    sequence,
    activeIndex: overrides.activeIndex ?? Math.max(0, activeIndex),
    activeStep,
  };
}

async function renderOnboardingStep(
  element: ReactElement,
  overrides: FlowOverrides = {},
  queryClient = createClient(),
): Promise<string> {
  const { OnboardingFlowContext } = await import("../onboarding/onboarding-flow.js");
  return renderWithClient(
    <OnboardingFlowContext.Provider value={createFlowValue(overrides)}>{element}</OnboardingFlowContext.Provider>,
    queryClient,
    "/onboarding",
  );
}

function installBrowserStubs(pathname = "/preview/onboarding"): void {
  const localStorageData = new Map<string, string>();
  const sessionStorageData = new Map<string, string>();
  const documentElement = {
    classList: {
      contains: () => false,
      toggle: () => false,
    },
  };
  const doc = {
    title: "First Tree",
    body: {
      appendChild: () => undefined,
      removeChild: () => undefined,
    },
    documentElement,
    activeElement: null,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    querySelector: () => null,
    querySelectorAll: () => [],
    createElement: (tag: string) => ({
      tagName: tag.toUpperCase(),
      style: {},
      setAttribute: () => undefined,
      appendChild: () => undefined,
      removeChild: () => undefined,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      getBoundingClientRect: () => ({ top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0 }),
    }),
  };
  const win = {
    document: doc,
    fetch: globalThis.fetch,
    innerWidth: 1280,
    matchMedia: (query: string) => ({
      matches: query.includes(`1024${"px"}`),
      media: query,
      onchange: null,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      addListener: () => undefined,
      removeListener: () => undefined,
      dispatchEvent: () => false,
    }),
    localStorage: {
      getItem: (key: string) => localStorageData.get(key) ?? null,
      setItem: (key: string, value: string) => {
        localStorageData.set(key, value);
      },
      removeItem: (key: string) => {
        localStorageData.delete(key);
      },
    },
    location: { pathname, search: "" },
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    setTimeout: globalThis.setTimeout,
    clearTimeout: globalThis.clearTimeout,
    sessionStorage: {
      getItem: (key: string) => sessionStorageData.get(key) ?? null,
      setItem: (key: string, value: string) => {
        sessionStorageData.set(key, value);
      },
      removeItem: (key: string) => {
        sessionStorageData.delete(key);
      },
    },
    requestAnimationFrame: (cb: FrameRequestCallback) => {
      cb(0);
      return 1;
    },
  };
  Object.defineProperty(globalThis, "window", { configurable: true, value: win });
  Object.defineProperty(globalThis, "document", { configurable: true, value: doc });
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: win.localStorage });
  Object.defineProperty(globalThis, "sessionStorage", { configurable: true, value: win.sessionStorage });
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: { clipboard: { writeText: async () => undefined } },
  });
  Object.defineProperty(globalThis, "requestAnimationFrame", { configurable: true, value: win.requestAnimationFrame });
  Object.defineProperty(globalThis, "cancelAnimationFrame", { configurable: true, value: () => undefined });
  Object.defineProperty(globalThis, "crypto", {
    configurable: true,
    value: { randomUUID: () => "00000000-0000-4000-8000-000000000000" },
  });
  Object.defineProperty(globalThis, "URL", {
    configurable: true,
    value: {
      ...URL,
      createObjectURL: () => "blob:test",
      revokeObjectURL: () => undefined,
    },
  });
}

describe("page SSR smoke coverage", () => {
  beforeEach(() => {
    installBrowserStubs();
    authMock.value = {
      ...authMock.value,
      role: "admin",
      memberId: "member-self",
      organizationId: "org-1",
      user: { id: "user-self", username: "gandy", displayName: "Gandy", avatarUrl: null },
    };
  });

  it("renders the large preview pages", async () => {
    const { ChatRowAvatarPreviewPage } = await import("../chat-row-avatar-preview.js");
    const { ComposeStatusBarPreviewPage } = await import("../compose-status-bar-preview.js");
    const { ContextPreviewPage } = await import("../context-preview.js");
    const { OnboardingPreviewPage } = await import("../onboarding-preview.js");
    const { StyleguidePreviewPage } = await import("../styleguide-preview.js");
    const { TeamPreviewPage } = await import("../team-preview.js");

    expect(renderPage(<StyleguidePreviewPage />)).toContain("First Tree");
    expect(renderPage(<OnboardingPreviewPage />)).toContain("Onboarding");
    expect(renderPage(<ChatRowAvatarPreviewPage />)).toContain("Chat Row Avatar");
    expect(renderPage(<ContextPreviewPage />)).toContain("Context Tree");
    expect(renderPage(<ComposeStatusBarPreviewPage />)).toContain("ComposeStatusBar");
    expect(renderPage(<TeamPreviewPage />)).toContain("Agent teammates");
  });

  it("renders public and settings pages with seeded query data", async () => {
    const { ClientsPage } = await import("../clients.js");
    const { LandingPage } = await import("../landing/index.js");
    const { SettingsComputersPage } = await import("../settings/computers.js");
    const { SettingsGithubPage } = await import("../settings/github.js");
    const { SettingsRepositoriesPage } = await import("../settings/repositories.js");
    const { SettingsResourcesPage } = await import("../settings/resources.js");
    const { TeamPage } = await import("../team/index.js");
    const { OpenTagPage } = await import("../opentag/opentag-page.js");

    expect(renderPage(<LandingPage />)).toContain("AI-native teams");
    // OpenTag's first frame is the Computer condition on the approved one-page flow.
    const opentag = renderPage(<OpenTagPage />, "/opentag");
    expect(opentag).toContain("Bring your agent");
    expect(opentag).not.toContain("Step 1");
    expect(opentag).toContain("OpenTag");
    // ClientsPage / SettingsComputersPage no longer render their own title —
    // the Settings layout owns the single page heading (see settings.tsx), so
    // assert on stable body copy instead of the moved title.
    expect(renderPage(<ClientsPage />)).toContain("computer");
    expect(renderPage(<TeamPage />)).toContain("Team");
    expect(renderPage(<SettingsComputersPage />)).toContain("computer");
    // Page titles moved to the Settings layout; assert on stable section
    // content each sub-page renders on its own.
    expect(renderPage(<SettingsGithubPage />)).toContain("GitHub");
    const repositories = renderPage(<SettingsRepositoriesPage />, "/settings/repositories");
    expect(repositories).toContain("Code repositories");
    expect(repositories).not.toContain("Context Tree");
    expect(renderPage(<SettingsResourcesPage />)).toContain("Loading");

    authMock.value = { ...authMock.value, role: "member" };
    // Settings GitHub, Repositories, and Resources stay visible (read-only)
    // for members.
    expect(renderPage(<SettingsGithubPage />)).toContain("GitHub");
    expect(renderPage(<SettingsRepositoriesPage />, "/settings/repositories")).not.toContain("Context Tree");
    expect(renderPage(<SettingsResourcesPage />)).toContain("Loading");

    authMock.value = { ...authMock.value, role: null };
    expect(renderPage(<SettingsGithubPage />)).toContain("Loading");
  });

  it("renders the agent detail layout with configuration data", async () => {
    const { AgentDetailPage } = await import("../agent-detail.js");
    const { ProfileTab } = await import("../agent-detail/profile-tab.js");
    const { PromptTab } = await import("../agent-detail/prompt-tab.js");
    const { RepositoriesTab } = await import("../agent-detail/repositories-tab.js");
    const { ResourcesTab } = await import("../agent-detail/resources-tab.js");
    const { RuntimeTab } = await import("../agent-detail/runtime-tab.js");

    const html = renderPage(
      <Routes>
        <Route path="/agents/:uuid" element={<AgentDetailPage />}>
          <Route path="profile" element={<ProfileTab />} />
          <Route path="responsibilities" element={<Navigate to="../profile" replace />} />
          <Route path="runtime" element={<RuntimeTab />} />
          <Route path="prompt" element={<PromptTab />} />
          <Route path="resources" element={<ResourcesTab />} />
          <Route path="repositories" element={<RepositoriesTab />} />
        </Route>
      </Routes>,
      "/agents/agent-1/profile",
    );

    expect(html).toContain("Nova");
    expect(html).toContain("Profile");

    for (const [route, expected] of [
      // IA recut: runtime shows model/effort/execution/env; repos + context tree
      // moved to their own Repositories tab; Tools & skills lists only skills + MCP.
      ["/agents/agent-1/runtime", "Reasoning effort"],
      ["/agents/agent-1/repositories", "Team web"],
      ["/agents/agent-1/prompt", "Instructions"],
      ["/agents/agent-1/resources", "Integrations"],
    ] as const) {
      expect(
        renderPage(
          <Routes>
            <Route path="/agents/:uuid" element={<AgentDetailPage />}>
              <Route path="profile" element={<ProfileTab />} />
              <Route path="responsibilities" element={<Navigate to="../profile" replace />} />
              <Route path="runtime" element={<RuntimeTab />} />
              <Route path="prompt" element={<PromptTab />} />
              <Route path="resources" element={<ResourcesTab />} />
              <Route path="repositories" element={<RepositoriesTab />} />
            </Route>
          </Routes>,
          route,
        ),
      ).toContain(expected);
    }
  });

  it("renders agent detail sections (immediate-save)", async () => {
    const { AppearanceSection } = await import("../agent-detail/appearance-section.js");
    const { EnvSection } = await import("../agent-detail/env-section.js");
    const { IdentitySection } = await import("../agent-detail/identity-section.js");
    const { ModelSection } = await import("../agent-detail/model-section.js");
    const { ReasoningEffortSection } = await import("../agent-detail/reasoning-effort-section.js");
    const { RuntimeSection } = await import("../agent-detail/runtime-section.js");

    const noop = () => undefined;
    const rendered = renderPage(
      <>
        <IdentitySection agent={agent()} />
        <AppearanceSection agent={agent()} />
        <RuntimeSection
          runtimeProvider="claude-code"
          computerLabel="gandy-macbook"
          canBindComputer={false}
          onBindComputer={noop}
        />
        <ModelSection value="sonnet" onChange={noop} />
        <ReasoningEffortSection value="high" onChange={noop} />
        <EnvSection items={AGENT_CONFIG.payload.env} onSave={noop} />
      </>,
    );

    expect(rendered).toContain("Identity");
    expect(rendered).toContain("Appearance");
    expect(rendered).toContain("gandy-macbook");
    expect(rendered).toContain("FIRST_TREE_ENV");
  });

  it("renders workspace surfaces with seeded chat data", async () => {
    const { AgentStatusPanel } = await import("../../components/chat/agent-status-panel.js");
    const { ComposeStatusBar } = await import("../../components/chat/compose-status-bar.js");
    const { NewAgentDialog } = await import("../../components/new-agent-dialog.js");
    const { ChatView } = await import("../workspace/center/chat-view.js");
    const { ConversationList } = await import("../workspace/conversations/index.js");
    const { NewChatDraft } = await import("../workspace/conversations/new-chat-draft.js");
    const { WorkspacePage } = await import("../workspace/index.js");
    const { AgentRoster } = await import("../workspace/roster/index.js");
    const { ChatRightSidebar } = await import("../workspace/right-sidebar/index.js");
    const { AgentContext } = await import("../workspace/context/agent-context.js");

    const noop = () => undefined;
    expect(
      renderPage(
        <ConversationList
          selectedChatId="chat-1"
          onSelectChat={noop}
          onNewChat={noop}
          engagement="active"
          onEngagementChange={noop}
          unread
          watching
          onRailFilterChange={noop}
          origin={["manual"]}
          onOriginChange={noop}
          participants={["agent-1"]}
          onParticipantsChange={noop}
          onClearFilters={noop}
          group="source"
          onGroupChange={noop}
          onOpenNeedYou={noop}
        />,
      ),
    ).toContain("Launch planning");

    expect(renderPage(<NewChatDraft onCreated={noop} onShowConversations={noop} />)).toContain("task?");
    expect(
      renderPage(
        <AgentRoster selectedAgentId="agent-1" selectedChatId="chat-1" onSelectAgent={noop} onSelectChat={noop} />,
      ),
    ).toContain("Launch planning");
    expect(() => renderPage(<NewAgentDialog open onOpenChange={noop} onCreated={noop} />)).not.toThrow();
    expect(
      renderPage(
        <ChatRightSidebar
          chatId="chat-1"
          participants={CHAT_PARTICIPANTS}
          participantsLoading={false}
          managedByMe={new Map([["agent-1", true]])}
          onAdded={noop}
          readOnly={false}
        />,
      ),
    ).toContain("Participants");
    expect(
      renderPage(
        <AgentStatusPanel
          chatId="chat-1"
          agents={CHAT_PARTICIPANTS.filter((participant) => participant.type !== "human")}
          canManage={() => true}
          order="priority"
        />,
      ),
    ).toContain("Working");
    // The rail surfaces working / failed only — the working lead renders its
    // goal (turnText) first.
    const statusRail = renderPage(
      <ComposeStatusBar
        chatId="chat-1"
        agents={CHAT_PARTICIPANTS.filter((participant) => participant.type !== "human")}
      />,
    );
    expect(statusRail).toContain("Checking the rollout path.");
    expect(renderPage(<AgentContext agentId="agent-1" />)).toContain("Computer");
    expect(renderPage(<ChatView agentId="agent-1" chatId="chat-1" />)).toContain("Launch planning");
    expect(renderPage(<WorkspacePage />, "/?c=chat-1&origin=manual&with=agent-1&unread=1&watching=1")).toContain(
      "Launch planning",
    );
  });

  it("keeps the right sidebar roster on agent lifecycle labels when provider reasons are present", async () => {
    const { AgentStatusPanel } = await import("../../components/chat/agent-status-panel.js");
    const client = createClient();
    client.setQueryData(chatAgentStatusQueryKey("chat-1"), [
      {
        agentId: "agent-1",
        main: "failed",
        reachable: true,
        engagement: "active",
        working: false,
        errored: true,
        activity: null,
        statusReason: {
          kind: "terminal",
          severity: "error",
          provider: "codex",
          scope: "provider_turn",
          category: "deterministic_input",
          reasonCode: "codex_context_window_exceeded",
          label: "Provider failure",
        },
      },
      {
        agentId: "agent-2",
        main: "ready",
        reachable: true,
        engagement: "active",
        working: false,
        errored: false,
        activity: null,
        statusReason: {
          kind: "terminal",
          severity: "error",
          provider: "codex",
          scope: "provider_turn",
          category: "deterministic_input",
          reasonCode: "codex_context_window_exceeded",
          label: "Provider failure",
        },
      },
    ] satisfies AgentChatStatus[]);

    const html = renderWithClient(
      <AgentStatusPanel
        chatId="chat-1"
        agents={CHAT_PARTICIPANTS.filter((participant) => participant.type !== "human")}
        canManage={() => true}
        order="priority"
      />,
      client,
    );

    expect(html).toContain("Failed");
    expect(html).toContain("Idle");
    expect(html).not.toContain("Provider failure");
  });

  it("renders ChatView alternate chrome, composer, and recovery states", async () => {
    const { ChatView } = await import("../workspace/center/chat-view.js");

    // SSR/initial paint: no mount-scope open-request fetch has completed.
    // Keep the stable draft surface visible, while the send control remains
    // fail-closed until the client confirms the chat's snapshot.
    const pendingHtml = renderWithClient(<ChatView agentId="agent-1" chatId="chat-1" />, createClient());
    expect(pendingHtml).toContain("<textarea");
    expect(pendingHtml).toContain('aria-label="Checking for open questions"');
    expect(pendingHtml).not.toContain("Checking for open questions…");

    const readOnlyClient = createClient();
    expect(
      renderWithClient(
        <ChatView
          agentId="agent-1"
          chatId="chat-1"
          readOnly
          titleFallback="Fallback title"
          joinAction={{ error: "Join failed", joining: false, onJoin: () => undefined }}
          onShowConversations={() => undefined}
        />,
        readOnlyClient,
      ),
    ).toContain("Join to reply");

    expect(
      renderWithClient(
        <ChatView
          agentId="agent-1"
          chatId="chat-1"
          readOnly
          joinAction={{ error: null, joining: true, onJoin: () => undefined }}
        />,
        createClient(),
      ),
    ).toContain("Joining");

    const deletedClient = createClient();
    deletedClient.setQueryData(
      ["chat-detail", "chat-1"],
      chatDetail({ engagementStatus: "deleted", title: "Archived launch" }),
    );
    expect(renderWithClient(<ChatView agentId="agent-1" chatId="chat-1" />, deletedClient)).toContain("Restore");

    const emptyClient = createClient();
    emptyClient.setQueryData(["chat-detail", "chat-empty"], chatDetail({ id: "chat-empty", title: "Empty chat" }));
    emptyClient.setQueryData(["chat-messages-cache", "chat-empty"], []);
    emptyClient.setQueryData(["chat-messages", "chat-empty"], { items: [], nextCursor: null });
    emptyClient.setQueryData(["chat-session-events", "chat-empty"], {
      feeds: [{ agentId: "agent-1", items: [], nextCursor: null }],
    });
    expect(renderWithClient(<ChatView agentId="agent-1" chatId="chat-empty" />, emptyClient)).toContain(
      "Send a message to start",
    );

    localStorage.setItem("first-tree:chat-right-sidebar:open:v1", "1");
    const narrowRendered = renderWithClient(<ChatView agentId="agent-1" chatId="chat-1" narrow />, createClient());
    expect(narrowRendered).toContain("Hide chat options");
    expect(narrowRendered).toContain("Participants");
    expect(narrowRendered).toContain("GitHub");

    const mobileRendered = renderWithClient(
      <ChatView agentId="agent-1" chatId="chat-1" narrow presentation="mobile" />,
      createClient(),
    );
    expect(mobileRendered).toContain("Show chat details");
    expect(mobileRendered).not.toContain("Participants");
  });

  it("renders onboarding steps and reusable onboarding UI states", async () => {
    const { ConnectCommandPanel } = await import("../../components/connect-command-panel.js");
    const { CommandBox, FlowNote, RepoPicker, StatusRow, WorkingState } = await import("../onboarding/flow-ui.js");
    const { GithubConnectedPage } = await import("../onboarding/github-connected.js");
    const { StepConnectCode } = await import("../onboarding/steps/step-connect-code.js");
    const { StepConnectComputer } = await import("../onboarding/steps/step-connect-computer.js");
    const { StepCreateAgent } = await import("../onboarding/steps/step-create-agent.js");
    const { AgentArrival, StepStartChat } = await import("../onboarding/steps/step-start-chat.js");
    const { StepTeam } = await import("../onboarding/steps/step-team.js");

    const html = renderPage(
      <>
        <CommandBox
          command={
            "curl -fsSL https://download.first-tree.ai/releases/prod/install.sh | sh\n" +
            "~/.local/bin/first-tree login token"
          }
        />
        <FlowNote tone="info">Heads up</FlowNote>
        <StatusRow state="waiting" label="Waiting now" />
        <StatusRow state="ok" label="Connected now" />
        <WorkingState label="Working now" hint="A short hint" />
        <RepoPicker repos={GITHUB_REPOS} selected={["https://github.com/acme/web.git"]} onToggle={() => undefined} />
        <ConnectCommandPanel
          command="first-tree login token"
          expiresInSeconds={600}
          phase="success"
          successContent="gandy-macbook connected"
        />
        <ConnectCommandPanel command="first-tree login token" expiresInSeconds={600} phase="waiting" />
        <ConnectCommandPanel command={null} phase="error" errorContent="Could not mint a token" />
      </>,
    );
    expect(html).toContain("first-tree login token");
    expect(html).toContain("Heads up");
    expect(html).toContain("gandy-macbook connected");
    // The expiry ticker renders only in the waiting phase, seeded from the TTL.
    expect(html).toContain("expires in 10m:00s");

    // The install-popup landing page (auto-closes the script-opened tab; the
    // effect is a no-op under SSR). It makes no success claim — success vs
    // pending-approval is owned by the origin tab — so it reads neutral and
    // just points the user back. Confirms it renders + carries role=status.
    const connectedHtml = renderPage(<GithubConnectedPage />);
    expect(connectedHtml).toContain("Back to First Tree");
    expect(connectedHtml).toContain("close this tab");
    expect(connectedHtml).not.toContain("Connected");
    expect(connectedHtml).toContain('role="status"');

    expect(await renderOnboardingStep(<StepTeam />, { activeStep: "create-team" })).toContain(
      "What should we call your team?",
    );
    expect(await renderOnboardingStep(<StepConnectComputer />, { activeStep: "connect-computer" })).toContain(
      "gandy-macbook",
    );
    expect(await renderOnboardingStep(<StepCreateAgent />, { activeStep: "create-agent" })).toContain(
      "Gandy&#x27;s assistant",
    );
    expect(
      await renderOnboardingStep(<StepCreateAgent />, { activeStep: "create-agent", agentPhase: "creating" }),
    ).toContain("Bringing your agent online");
    expect(
      await renderOnboardingStep(<StepCreateAgent />, { activeStep: "create-agent", agentPhase: "timeout" }),
    ).toContain("taking longer");
    expect(await renderOnboardingStep(<StepConnectCode />, { activeStep: "connect-code" })).toContain(
      "Loading your repos",
    );
    const arrivalHtml = renderPage(
      <AgentArrival
        agent={{
          uuid: "agent-1",
          name: "nova",
          displayName: "Nova",
          type: "agent",
          organizationId: "org-1",
          inboxId: "inbox-1",
          visibility: "organization",
          runtimeProvider: "claude-code",
          clientId: "client-1",
          status: "active",
          avatarImageUrl: null,
        }}
        error={null}
        onStart={() => undefined}
        phase="idle"
      />,
    );
    expect(arrivalHtml).toContain("Meet Nova");
    expect(arrivalHtml).toContain("Meet your agent");
    expect(await renderOnboardingStep(<StepStartChat />, { activeStep: "start-chat" })).toContain("Finding your agent");
    expect(
      await renderOnboardingStep(<StepStartChat />, {
        activeStep: "start-chat",
        selectedRepoUrls: [],
        treeBindingPlan: "createBinding",
        treeUrl: "",
      }),
    ).toContain("Finding your agent");
    expect(
      await renderOnboardingStep(<StepStartChat />, {
        path: "invitee",
        activeStep: "start-chat",
        selectedRepoUrls: [],
      }),
    ).toContain("Finding your agent");
  });

  it("renders invite, GitHub App, settings, and layout surfaces", async () => {
    const { Layout } = await import("../../components/layout.js");
    const { TeamSetupModal } = await import("../../components/team-setup-modal.js");
    const { UserMenu } = await import("../../components/user-menu.js");
    const { InviteAcceptCard, InviteAcceptError, InviteAcceptShell, InviteAcceptSkeleton } = await import(
      "../invite-accept.js"
    );
    const { GithubAppInstallationPanel } = await import("../github-app-installation-panel.js");
    const { ContextTreeSettingsPanel } = await import("../context-tree-settings-panel.js");
    const { SettingsLayout } = await import("../settings.js");

    const preview = {
      organizationId: "org-1",
      organizationName: "acme",
      organizationDisplayName: "Acme",
      role: "member",
      expiresAt: "2026-05-29T12:00:00.000Z",
    };

    expect(
      renderPage(
        <InviteAcceptShell>
          <InviteAcceptSkeleton />
          <InviteAcceptError message="No invite" />
        </InviteAcceptShell>,
      ),
    ).toContain("Back to home");
    expect(
      renderPage(
        <InviteAcceptCard
          preview={preview}
          isAuthenticated
          currentTeamName="Other Team"
          busy={false}
          onJoin={() => undefined}
          oauthHref="/api/v1/auth/github/start"
        />,
      ),
    ).toContain("Join Acme");
    expect(renderPage(<GithubAppInstallationPanel />)).toContain("Connected to");
    expect(renderPage(<ContextTreeSettingsPanel />)).toContain("Context Tree");
    expect(renderPage(<UserMenu />)).toContain("user-menu");
    expect(() => renderPage(<TeamSetupModal action="create" onClose={() => undefined} />)).not.toThrow();
    expect(renderPage(<SettingsLayout />)).toContain("Settings");
    expect(
      renderPage(
        <Routes>
          <Route element={<Layout />}>
            <Route index element={<div>Workspace child</div>} />
            <Route path="settings" element={<div>Settings child</div>} />
          </Route>
        </Routes>,
      ),
    ).toContain("Workspace child");
  });
});
