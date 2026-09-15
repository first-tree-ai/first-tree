// @vitest-environment happy-dom

import type { ContextTreeIoEvent, ContextTreeSnapshot } from "@first-tree/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter, Route, Routes, useLocation } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MOCK_CONTEXT_SNAPSHOT } from "../context-preview-mock.js";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const contextApiMocks = vi.hoisted(() => ({
  getContextTreeSnapshot: vi.fn(),
  initializeContextTree: vi.fn(),
}));

const agentApiMocks = vi.hoisted(() => ({
  listManagedAgents: vi.fn(),
}));

const resourceApiMocks = vi.hoisted(() => ({
  confirmTeamRepositoriesForOrg: vi.fn(),
  createTeamResourceForOrg: vi.fn(),
  listTeamResourcesForOrg: vi.fn(),
}));

const onboardingEventMocks = vi.hoisted(() => ({
  getTreeSetupStatus: vi.fn(),
  postOnboardingStartChat: vi.fn(),
  postTreeSetupStartChat: vi.fn(),
  reportOnboardingEvent: vi.fn(),
}));

const orgSettingsMocks = vi.hoisted(() => ({
  getContextTreeSetting: vi.fn(),
}));

const githubAppMocks = vi.hoisted(() => ({
  getGithubAppInstallation: vi.fn(),
  getGithubAppInstallationExists: vi.fn(),
  getGithubAppInstallUrl: vi.fn(),
}));

const githubMocks = vi.hoisted(() => ({
  listGithubRepos: vi.fn(),
  listOrgGithubRepos: vi.fn(),
}));

const gitlabConnectionMocks = vi.hoisted(() => ({
  listGitlabConnectionsAt: vi.fn(),
}));

const authMock = vi.hoisted(() => ({
  value: {
    organizationId: "org-1" as string | null,
    role: "member" as "admin" | "member" | null,
  },
}));

vi.mock("../../api/context-tree.js", () => contextApiMocks);
vi.mock("../../api/agents.js", () => agentApiMocks);
vi.mock("../../api/resources.js", () => resourceApiMocks);
vi.mock("../../api/onboarding-events.js", () => onboardingEventMocks);
vi.mock("../../api/org-settings.js", () => orgSettingsMocks);
vi.mock("../../api/github-app.js", () => githubAppMocks);
vi.mock("../../api/github.js", () => githubMocks);

vi.mock("../../api/gitlab-connections.js", () => ({
  gitlabConnectionsQueryKey: (organizationId: string | null) => ["gitlab-connections", organizationId] as const,
  listGitlabConnectionsAt: gitlabConnectionMocks.listGitlabConnectionsAt,
}));

vi.mock("../../auth/auth-context.js", () => ({
  useAuth: () => authMock.value,
}));

function LocationProbe() {
  const location = useLocation();
  return <div data-testid="location">{`${location.pathname}${location.search}${location.hash}`}</div>;
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
): Promise<{ container: HTMLElement; root: Root; queryClient: QueryClient }> {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false, refetchOnWindowFocus: false },
      mutations: { retry: false },
    },
  });
  await act(async () => {
    root.render(
      <MemoryRouter>
        <QueryClientProvider client={queryClient}>
          {/* Outside Routes so it keeps tracking the location after a navigate
              away from "/" (e.g. the Context build entry → Settings/Onboarding). */}
          <LocationProbe />
          <Routes>
            <Route path="/" element={element} />
            <Route path="/settings/context" element={<div>Context Tree settings route</div>} />
            <Route path="/settings/resources" element={<div>Resources route</div>} />
            <Route path="/onboarding" element={<div>Onboarding route</div>} />
          </Routes>
        </QueryClientProvider>
      </MemoryRouter>,
    );
  });
  await flush();
  return { container, root, queryClient };
}

async function rerender(root: Root, queryClient: QueryClient, element: ReactElement): Promise<void> {
  await act(async () => {
    root.render(
      <MemoryRouter>
        <QueryClientProvider client={queryClient}>
          <LocationProbe />
          <Routes>
            <Route path="/" element={element} />
            <Route path="/settings/context" element={<div>Context Tree settings route</div>} />
            <Route path="/settings/resources" element={<div>Resources route</div>} />
            <Route path="/onboarding" element={<div>Onboarding route</div>} />
          </Routes>
        </QueryClientProvider>
      </MemoryRouter>,
    );
  });
  await flush();
}

async function click(element: Element | null): Promise<void> {
  if (!element) throw new Error("Expected element to click");
  await act(async () => {
    element.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  });
  await flush();
}

async function waitForText(container: ParentNode, text: string, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (container.textContent?.includes(text)) return;
    await flush();
  }
  throw new Error(`Missing text: ${text}\n${container.textContent ?? ""}`);
}

async function waitForSelector(container: ParentNode, selector: string, timeoutMs = 3000): Promise<Element> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const found = container.querySelector(selector);
    if (found) return found;
    await flush();
  }
  throw new Error(`Missing selector: ${selector}\n${container.textContent ?? ""}`);
}

function gitlabConnection(overrides: { lastObservedVersion: string | null }) {
  return {
    id: "connection-1",
    organizationId: "org-1",
    displayName: "Private GitLab",
    instanceOrigin: "https://gitlab.example.com",
    endpointSeen: true,
    stableDeliveryObserved: true,
    reviewerCapability: {
      mode: "reviewers",
      lastObservedVersion: overrides.lastObservedVersion,
      lastSchemaAnomalyAt: null,
      lastSchemaAnomalyCode: null,
    },
    health: {
      readiness: "routing_verified",
      lastValidInboundAt: "2026-05-28T11:00:00.000Z",
      lastSystemHookInboundAt: null,
      lastProjectHookInboundAt: "2026-05-28T11:00:00.000Z",
      lastSystemHookMergeRequestInboundAt: null,
      lastProcessingFailureAt: null,
      lastProcessingFailureCode: null,
    },
    createdAt: "2026-05-01T00:00:00.000Z",
    updatedAt: "2026-05-28T11:00:00.000Z",
  };
}

function snapshot(overrides: Partial<ContextTreeSnapshot> = {}): ContextTreeSnapshot {
  return {
    ...MOCK_CONTEXT_SNAPSHOT,
    syncedAt: "2026-05-28T12:00:00.000Z",
    ...overrides,
    contextStatus: overrides.contextStatus ?? MOCK_CONTEXT_SNAPSHOT.contextStatus,
    summary: overrides.summary ?? MOCK_CONTEXT_SNAPSHOT.summary,
    usage: overrides.usage ?? MOCK_CONTEXT_SNAPSHOT.usage,
    io: overrides.io ?? MOCK_CONTEXT_SNAPSHOT.io,
    nodes: overrides.nodes ?? MOCK_CONTEXT_SNAPSHOT.nodes,
    updates: overrides.updates ?? MOCK_CONTEXT_SNAPSHOT.updates,
    edges: overrides.edges ?? MOCK_CONTEXT_SNAPSHOT.edges,
    changes: overrides.changes ?? MOCK_CONTEXT_SNAPSHOT.changes,
    // Not `?? MOCK`: a caller passing `influence: undefined` means "no
    // influence in this window", which is the state the panel must hide for.
    influence: "influence" in overrides ? overrides.influence : MOCK_CONTEXT_SNAPSHOT.influence,
  };
}

function ioEvent(index: number, overrides: Partial<ContextTreeIoEvent> = {}): ContextTreeIoEvent {
  const isWrite = index % 3 === 0;
  return {
    id: `io-event-${index}`,
    agentId: `agent-${index}`,
    agentName: index % 2 === 0 ? `qa.bot-${index}` : `Reviewer ${index}`,
    agentAvatarColorToken: index % 2 === 0 ? "hue-2" : null,
    runtimeProvider: isWrite ? "codex" : "claude-code",
    action: isWrite ? "write" : "read",
    source: isWrite ? "codex_file_change" : "claude_read_tool",
    targetKind: "file",
    targetPath: `domains/topic-${index}/NODE.md`,
    chatId: `chat-${index}`,
    chatTitle: index % 3 === 0 ? "" : `topic-${index}`,
    viewerCanAccess: index % 5 !== 0,
    createdAt: new Date(Date.UTC(2026, 4, 28, 12, 0, 0) - index * 60_000).toISOString(),
    ...overrides,
  };
}

function buttonByText(container: ParentNode, text: string): HTMLButtonElement | null {
  return [...container.querySelectorAll("button")].find((button) => button.textContent?.includes(text)) ?? null;
}

beforeEach(() => {
  document.body.innerHTML = "";
  vi.useRealTimers();
  authMock.value = { organizationId: "org-1", role: "member" };
  contextApiMocks.getContextTreeSnapshot.mockReset();
  contextApiMocks.initializeContextTree.mockReset();
  agentApiMocks.listManagedAgents.mockReset();
  resourceApiMocks.listTeamResourcesForOrg.mockReset();
  resourceApiMocks.confirmTeamRepositoriesForOrg.mockReset();
  resourceApiMocks.createTeamResourceForOrg.mockReset();
  onboardingEventMocks.getTreeSetupStatus.mockReset();
  onboardingEventMocks.postOnboardingStartChat.mockReset();
  onboardingEventMocks.postTreeSetupStartChat.mockReset();
  onboardingEventMocks.reportOnboardingEvent.mockReset();
  orgSettingsMocks.getContextTreeSetting.mockReset();
  agentApiMocks.listManagedAgents.mockResolvedValue([]);
  resourceApiMocks.listTeamResourcesForOrg.mockResolvedValue([]);
  resourceApiMocks.confirmTeamRepositoriesForOrg.mockResolvedValue({ repositories: [] });
  resourceApiMocks.createTeamResourceForOrg.mockResolvedValue({
    id: "repo-1",
    type: "repo",
    defaultEnabled: "recommended",
    payload: { url: "https://github.com/acme/acme-web.git" },
  });
  orgSettingsMocks.getContextTreeSetting.mockResolvedValue({
    repo: "https://github.com/acme/context-tree",
    branch: "main",
  });
  onboardingEventMocks.getTreeSetupStatus.mockResolvedValue({
    needsTreeSetup: false,
    hasTreeBinding: true,
    hasTreeSetupStartChat: true,
  });
  onboardingEventMocks.postOnboardingStartChat.mockResolvedValue({ chatId: "chat-onboarding-1" });
  onboardingEventMocks.postTreeSetupStartChat.mockResolvedValue({ chatId: "chat-tree-1" });
  githubAppMocks.getGithubAppInstallation.mockReset();
  githubAppMocks.getGithubAppInstallationExists.mockReset();
  githubAppMocks.getGithubAppInstallUrl.mockReset();
  githubMocks.listGithubRepos.mockReset();
  githubMocks.listOrgGithubRepos.mockReset();
  gitlabConnectionMocks.listGitlabConnectionsAt.mockReset();
  // Default: no GitLab connection — GitLab node citations stay plain text and
  // GitHub ones need no connection. GitLab tests override this.
  gitlabConnectionMocks.listGitlabConnectionsAt.mockResolvedValue([]);
  // Default: GitHub App not connected and no repos granted — the inline build
  // entry shows its install CTA. Tests that exercise the connected/pick states
  // override these.
  githubAppMocks.getGithubAppInstallation.mockResolvedValue(null);
  githubAppMocks.getGithubAppInstallationExists.mockResolvedValue(false);
  githubAppMocks.getGithubAppInstallUrl.mockResolvedValue(
    "https://github.com/apps/first-tree/installations/new?state=test",
  );
  githubMocks.listGithubRepos.mockResolvedValue([]);
  githubMocks.listOrgGithubRepos.mockResolvedValue([]);
  contextApiMocks.initializeContextTree.mockResolvedValue({
    repo: "https://github.com/acme/acme-context-tree.git",
    htmlUrl: "https://github.com/acme/acme-context-tree",
    branch: "main",
    nodePath: "NODE.md",
  });
});

afterEach(() => {
  document.body.innerHTML = "";
  vi.useRealTimers();
});

describe("ContextPage DOM behavior", () => {
  it("renders live preview, selects change groups, expands IO, and navigates accessible chats", async () => {
    vi.setSystemTime(new Date("2026-05-28T12:15:00.000Z"));
    const { ContextPage } = await import("../context.js");
    // 22 io events so the 20-row default still leaves rows behind "Show all".
    // The mock's 2 influence rows join the same stream, hence 24 below.
    const events = Array.from({ length: 22 }, (_, index) => ioEvent(index + 1));
    const liveSnapshot = snapshot({
      contextStatus: { label: "Needs attention", detail: "Tree sync is stale.", severity: "warning" },
      summary: { addedCount: 2, editedCount: 8, removedCount: 1, changedNodeCount: 3 },
      io: {
        ...MOCK_CONTEXT_SNAPSHOT.io,
        recentEvents: events,
        // This case exercises the reads stream + pagination; writes are covered
        // by the dedicated write-feed test below.
        writes: [],
        writesTotal: 0,
      },
    });

    const { container, root, queryClient } = await renderDom(<ContextPage previewSnapshot={liveSnapshot} />);
    expect(contextApiMocks.getContextTreeSnapshot).not.toHaveBeenCalled();
    // The old centered "Context tree is live" hero is now a LIVE chip in the
    // PageHeader right slot; the warning detail still renders via ContextStatusNote.
    expect(container.textContent).toContain("LIVE");
    expect(container.textContent).toContain("Tree sync is stale.");
    expect(container.textContent).toContain("4 agents");
    expect(container.textContent).toContain("read the tree 18 times");
    expect(container.textContent).toContain("2 agents");
    expect(container.textContent).toContain("wrote 5 times");
    expect(container.textContent).toContain("23total nodes");
    expect(container.textContent).toContain("+6 updates");
    // The usage-feed avatar is a generated identicon (an svg), not text initials.
    expect(container.querySelector(".context-usage-feed-avatar svg")).not.toBeNull();
    expect(container.textContent).toContain("qa.bot-2");
    expect(container.textContent).toContain("#chat-3");

    await click(buttonByText(container, "Show all 24"));
    expect(container.textContent).toContain("#hat-21");

    await click(buttonByText(container, "Nova"));
    expect(container.querySelector(".context-network-card.is-live")?.textContent).toContain("Nova");

    await click(buttonByText(container, "#topic-1"));
    expect(container.querySelector('[data-testid="location"]')?.textContent).toBe("/?c=chat-1");

    const nextSnapshot = snapshot({
      ...liveSnapshot,
      io: {
        ...liveSnapshot.io,
        recentEvents: [ioEvent(99, { id: "new-event", agentName: "Fresh Agent" }), ...events],
      },
    });
    await rerender(root, queryClient, <ContextPage previewSnapshot={nextSnapshot} />);
    expect(container.querySelector(".context-usage-feed-row.is-fresh")?.textContent).toContain("Fresh Agent");

    await act(async () => root.unmount());
  });

  it("renders the influence panel, ranks nodes, and isolates influence rows", async () => {
    const { ContextPage } = await import("../context.js");
    const { container, root } = await renderDom(<ContextPage previewSnapshot={snapshot()} />);

    // Outcome, not exposure — and framed as attribution, never as a verified
    // fact: the Server proves only that an agent authored a convertible note.
    expect(container.textContent).toContain("Agent-reported");
    expect(container.textContent).toContain("decisions reported as shaped");
    expect(container.textContent).toContain("does not verify causality");
    expect(container.textContent).toContain("1 surfaced a conflict");
    // The count must never be framed as a share of reads — a decision is a
    // message and a read is a file open, so the two have different denominators.
    expect(container.textContent).not.toContain("Of those reads");
    // All three coverage gaps must be stated, so a low count cannot read as a
    // verdict on the tree or on a node missing from the ranking.
    expect(container.textContent).toContain("managed chats only");
    expect(container.textContent).toContain("notes this Server could read back");

    // Titles come from the org-visible tree snapshot, never from the citation's
    // own label — that label is the agent's wording inside a private chat.
    const nodes = [...container.querySelectorAll(".context-influence-node")];
    expect(nodes.map((node) => node.textContent)).toEqual([
      "Notebookmembers/yzw/notebook.md3",
      "Journalmembers/yzw/journal.md2",
    ]);
    // Link identity is the SNAPSHOT's repo and head commit, never the note's:
    // a citation names those inside a chat the viewer may not be in.
    expect(nodes[0]?.querySelector("a")?.getAttribute("href")).toBe(
      "https://github.com/agent-team-foundation/first-tree-context/blob/83c3939e90b1a2b3c4d5e6f708192a3b4c5d6e7f/members/yzw/notebook.md",
    );

    await click(buttonByText(container, "Influence"));
    const rows = [...container.querySelectorAll(".context-usage-feed-row")];
    expect(rows).toHaveLength(2);
    expect(rows.every((row) => row.className.includes("is-influence"))).toBe(true);
    expect(rows[0]?.className).toContain("is-conflict");
    expect(rows[0]?.textContent).toContain("Conflict surfaced");
    expect(rows[1]?.textContent).toContain("Options narrowed");

    await act(async () => root.unmount());
  });

  it("hides the influence panel when the window holds no decisions", async () => {
    const { ContextPage } = await import("../context.js");
    const { container, root } = await renderDom(<ContextPage previewSnapshot={snapshot({ influence: undefined })} />);

    expect(container.querySelector(".context-influence")).toBeNull();
    expect(container.textContent).not.toContain("decisions shaped");
    // The read/write signal is unaffected — influence is an addition, not a
    // replacement.
    expect(container.textContent).toContain("read the tree");

    await act(async () => root.unmount());
  });

  it("routes a connected legacy (11.11.3) GitLab tree through /blob/ and a current one through /-/blob/", async () => {
    const HEAD = "83c3939e90b1a2b3c4d5e6f708192a3b4c5d6e7f";
    const gitlabSnapshot = () =>
      snapshot({
        repo: "https://gitlab.example.com/group/sub/context-tree",
        headCommit: HEAD,
      });

    // The reported legacy case: the connection's observed version must reach
    // the link builder, or this node would get a `/-/blob/` link the 11.11.3
    // instance cannot serve.
    gitlabConnectionMocks.listGitlabConnectionsAt.mockResolvedValueOnce([
      gitlabConnection({ lastObservedVersion: "11.11.3" }),
    ]);
    const { ContextPage } = await import("../context.js");
    const first = await renderDom(<ContextPage previewSnapshot={gitlabSnapshot()} />);
    const legacyLink = await waitForSelector(first.container, ".context-influence-node a");
    expect(legacyLink.getAttribute("href")).toBe(
      `https://gitlab.example.com/group/sub/context-tree/blob/${HEAD}/members/yzw/notebook.md`,
    );
    await act(async () => first.root.unmount());

    gitlabConnectionMocks.listGitlabConnectionsAt.mockResolvedValueOnce([
      gitlabConnection({ lastObservedVersion: "17.11.2-ee" }),
    ]);
    const second = await renderDom(<ContextPage previewSnapshot={gitlabSnapshot()} />);
    const scopedLink = await waitForSelector(second.container, ".context-influence-node a");
    expect(scopedLink.getAttribute("href")).toBe(
      `https://gitlab.example.com/group/sub/context-tree/-/blob/${HEAD}/members/yzw/notebook.md`,
    );
    await act(async () => second.root.unmount());
  });

  it("keeps GitLab node citations as plain text while the connection has no observed version", async () => {
    gitlabConnectionMocks.listGitlabConnectionsAt.mockResolvedValueOnce([
      gitlabConnection({ lastObservedVersion: null }),
    ]);
    const { ContextPage } = await import("../context.js");
    const { container, root } = await renderDom(
      <ContextPage
        previewSnapshot={snapshot({
          repo: "https://gitlab.example.com/group/sub/context-tree",
          headCommit: "83c3939e90b1a2b3c4d5e6f708192a3b4c5d6e7f",
        })}
      />,
    );

    await waitForText(container, "Notebook");
    // Unknown version means no route can be chosen with confidence, so the
    // citation must not become a guessed link.
    expect(container.querySelector(".context-influence-node a")).toBeNull();
    expect(container.querySelector(".context-influence-node span")?.textContent).toBe("Notebook");

    await act(async () => root.unmount());
  });

  it("renders empty usage and empty change map states", async () => {
    const { ContextPage } = await import("../context.js");
    const empty = snapshot({
      summary: { addedCount: 0, editedCount: 0, removedCount: 0, changedNodeCount: 0 },
      usage: {
        windowDays: 7,
        agentCount: 0,
        usageCount: 0,
        recentEvents: [],
      },
      io: {
        windowDays: 7,
        summary: {
          read: { agentCount: 0, eventCount: 0, targetCount: 0 },
          write: { agentCount: 0, eventCount: 0, targetCount: 0 },
        },
        agents: [],
        recentEvents: [],
        writes: [],
        writesTotal: 0,
        skipped: { windowDays: 7, totalEventCount: 0, reasons: [] },
      },
      nodes: MOCK_CONTEXT_SNAPSHOT.nodes.map((node) => ({ ...node, changeType: null, changedAtCommit: null })),
      updates: [],
    });

    const { container, root } = await renderDom(<ContextPage previewSnapshot={empty} />);
    expect(container.textContent).toContain("No context updates in the past 7 days.");
    expect(container.textContent).toContain("No Context Tree reads or writes in the past 7 days.");
    // LIVE reflects the tree's sync liveness, not usage: a synced (active)
    // snapshot shows the header LIVE chip even with zero reads/writes / no
    // events (the streaming IO feed is what hides when empty).
    expect(container.textContent).toContain("LIVE");
    await act(async () => root.unmount());
  });

  it("renders git-derived writes (PR, risk, attribution) and filters reads vs writes", async () => {
    vi.setSystemTime(new Date("2026-05-28T12:15:00.000Z"));
    const { ContextPage } = await import("../context.js");
    // MOCK_CONTEXT_SNAPSHOT.io carries 3 sample writes + 3 reads.
    const { container, root } = await renderDom(<ContextPage previewSnapshot={snapshot()} />);

    const feed = container.querySelector(".context-usage-feed");
    expect(feed).not.toBeNull();

    // Default All: both a write row and a read row are present.
    const writeRows = () => [...container.querySelectorAll(".context-usage-feed-row.is-write")];
    const readRows = () =>
      [...container.querySelectorAll(".context-usage-feed-row")].filter((row) => !row.classList.contains("is-write"));
    expect(writeRows().length).toBeGreaterThan(0);
    expect(readRows().length).toBeGreaterThan(0);

    // Agent-attributed write carries the PR chip as a real GitHub link + summary.
    const prLinks = [...container.querySelectorAll<HTMLAnchorElement>("a.context-usage-feed-pr")];
    const pr514 = prLinks.find((link) => link.textContent === `#${514}`);
    expect(pr514).toBeDefined();
    expect(pr514?.getAttribute("href")).toContain("/pull/514");
    expect(container.textContent).toContain("record team deletion semantics");

    // Unmatched git author (a PR merge) is shown honestly as the git author,
    // with the high-risk badge on the removal.
    expect(container.textContent).toContain("yuezengwu");
    expect(container.textContent).toContain("git author");
    expect(container.querySelector(".context-usage-feed-risk.is-high")).not.toBeNull();

    // Root write (empty node path) renders a friendly label, never a blank target.
    const rootWriteRow = writeRows().find((row) => row.textContent?.includes("refresh the root index"));
    expect(rootWriteRow).toBeDefined();
    expect(rootWriteRow?.querySelector(".context-usage-feed-node")).toBeNull();
    expect(rootWriteRow?.textContent).toContain("the Context Tree");

    // Filter → Writes: only write rows remain.
    await click(buttonByText(container, "Writes"));
    expect(readRows().length).toBe(0);
    expect(writeRows().length).toBeGreaterThan(0);

    // Filter → Reads: writes disappear, PR chip gone.
    await click(buttonByText(container, "Reads"));
    expect(writeRows().length).toBe(0);
    expect(container.querySelector("a.context-usage-feed-pr")).toBeNull();

    await act(async () => root.unmount());
  });

  it("renders unavailable states with redacted repo details", async () => {
    const { ContextPage } = await import("../context.js");
    const unavailable = snapshot({
      repo: "https://token@example.com/acme/context-tree.git",
      branch: "main",
      snapshotStatus: "unavailable",
      contextStatus: { label: "Sync failed", detail: "Permission denied", severity: "error" },
    });

    const { container, root } = await renderDom(<ContextPage previewSnapshot={unavailable} />);
    expect(container.textContent).toContain("Context Tree sync unavailable");
    expect(container.textContent).toContain("Permission denied");
    expect(container.textContent).toContain("Repo: https://[redacted]@example.com/acme/context-tree.git");
    expect(container.textContent).toContain("Branch: main");
    await act(async () => root.unmount());

    const disconnected = await renderDom(
      <ContextPage
        previewSnapshot={snapshot({
          repo: null,
          branch: null,
          snapshotStatus: "unavailable",
          contextStatus: { label: "Not configured", detail: null, severity: "warning" },
        })}
      />,
    );
    expect(disconnected.container.textContent).toContain("Connect Context Tree");
    expect(disconnected.container.textContent).toContain("Ask an admin to set up your team's Context Tree.");
    expect(buttonByText(disconnected.container, "Create private GitHub repo")).toBeNull();
    await act(async () => disconnected.root.unmount());
  });

  it.each([
    "gitlab_authentication_required",
    "gitlab_origin_not_authorized",
    "gitlab_dns_unavailable",
    "gitlab_address_not_authorized",
    "gitlab_egress_denied",
  ] as const)("shows the same neutral GitLab Web Context state for %s", async (reason) => {
    agentApiMocks.listManagedAgents.mockResolvedValue([treeAgent]);
    const serverDetail = `Provider-specific diagnostic for ${reason}`;
    const unavailableGitlab = snapshot({
      provider: "gitlab",
      contentAvailability: {
        status: "unavailable",
        accessMode: "anonymous",
        reason,
      },
      repo: "https://oauth2:secret@gitlab.example/acme/private-context.git",
      branch: "main",
      snapshotStatus: "unavailable",
      contextStatus: {
        label: "Team context unavailable",
        detail: serverDetail,
        severity: "error",
      },
    });
    contextApiMocks.getContextTreeSnapshot.mockResolvedValue(unavailableGitlab);

    const { ContextPage } = await import("../context.js");
    for (const role of ["member", "admin"] as const) {
      authMock.value = { organizationId: "org-1", role };
      const { container, root } = await renderDom(<ContextPage />);

      await waitForText(container, "Web preview isn’t available for this repository");
      expect(container.textContent).toContain("Agent access and Automatic Review are unaffected.");
      expect(container.textContent).not.toContain(serverDetail);
      expect(container.querySelector('[data-context-availability-tone="neutral"]')).not.toBeNull();
      expect(container.querySelector(".lucide-info")).not.toBeNull();
      expect(container.querySelector(".lucide-triangle-alert")).toBeNull();
      expect(container.textContent).toContain(
        "Repo: https://[redacted]@gitlab.example/acme/private-context.git · Branch: main",
      );
      expect(buttonByText(container, "Work on this in chat")).toBeNull();
      expect(buttonByText(container, "Create an agent")).toBeNull();
      expect(container.querySelector('[aria-label="Agent for the Context Tree chat"]')).toBeNull();
      await act(async () => root.unmount());
    }
    expect(agentApiMocks.listManagedAgents).not.toHaveBeenCalled();
  });

  it("keeps public GitLab snapshots on the live Context page", async () => {
    const { ContextPage } = await import("../context.js");
    const publicGitlab = snapshot({
      provider: "gitlab",
      contentAvailability: {
        status: "available",
        accessMode: "anonymous",
      },
      repo: "https://gitlab.com/acme/public-context.git",
      branch: "main",
      snapshotStatus: "active",
      contextStatus: { label: "Live", detail: null, severity: "ok" },
    });

    const { container, root } = await renderDom(<ContextPage previewSnapshot={publicGitlab} />);
    expect(container.textContent).toContain("LIVE");
    expect(container.textContent).not.toContain("coming soon");
    await act(async () => root.unmount());
  });

  it.each([
    ["gitlab_redirect_forbidden", "GitLab repository redirect is not allowed", "never follows"],
    ["gitlab_repository_unavailable", "GitLab repository or branch is unavailable", "allow anonymous reads"],
  ] as const)("shows actionable GitLab recovery copy for %s", async (reason, title, recovery) => {
    const { ContextPage } = await import("../context.js");
    const unavailable = snapshot({
      provider: "gitlab",
      contentAvailability: {
        status: "unavailable",
        accessMode: "anonymous",
        reason,
      },
      repo: "https://gitlab.example/acme/context-tree.git",
      branch: "main",
      snapshotStatus: "unavailable",
      contextStatus: {
        label: "Team context unavailable",
        detail: "Provider-specific diagnostic",
        severity: "error",
      },
    });

    const { container, root } = await renderDom(<ContextPage previewSnapshot={unavailable} />);
    expect(container.textContent).toContain(title);
    expect(container.textContent).toContain(recovery);
    expect(container.textContent).toContain("Webhook");
    await act(async () => root.unmount());
  });

  it("routes recoverable GitLab unavailable states to Context Tree settings", async () => {
    authMock.value = { organizationId: "org-1", role: "admin" };
    contextApiMocks.getContextTreeSnapshot.mockResolvedValue(
      snapshot({
        provider: "gitlab",
        contentAvailability: {
          status: "unavailable",
          accessMode: "anonymous",
          reason: "gitlab_repository_unavailable",
        },
        repo: "https://gitlab.example/acme/context-tree.git",
        branch: "main",
        snapshotStatus: "unavailable",
        contextStatus: {
          label: "Team context unavailable",
          detail: "Provider-specific diagnostic",
          severity: "error",
        },
      }),
    );

    const { ContextPage } = await import("../context.js");
    const { container, root } = await renderDom(<ContextPage />);

    await waitForText(container, "Manage Context Tree");
    expect(container.textContent).toContain("GitLab repository or branch is unavailable");
    expect(container.textContent).toContain("Provider-specific diagnostic");
    expect(agentApiMocks.listManagedAgents).not.toHaveBeenCalled();
    await click(container.querySelector('a[href="/settings/context#binding"]'));
    expect(container.querySelector('[data-testid="location"]')?.textContent).toBe("/settings/context#binding");
    await act(async () => root.unmount());
  });

  const treeAgent = {
    uuid: "agent-1",
    name: "agent-1",
    displayName: "Tree Agent",
    type: "agent",
    organizationId: "org-1",
    inboxId: "inbox-agent-1",
    visibility: "private",
    runtimeProvider: "claude-code",
    clientId: "client-agent-1",
    status: "active",
    avatarImageUrl: null,
  };
  const unavailableSnapshot = () =>
    snapshot({
      repo: null,
      branch: null,
      snapshotStatus: "unavailable",
      contextStatus: { label: "Not configured", detail: null, severity: "warning" },
    });

  it("routes a bound-tree sync failure to settings without an App-install gate", async () => {
    authMock.value = { organizationId: "org-1", role: "admin" };
    const { ContextPage } = await import("../context.js");
    contextApiMocks.getContextTreeSnapshot.mockResolvedValue(
      snapshot({
        repo: "https://github.com/acme/context-tree",
        branch: "main",
        snapshotStatus: "unavailable",
        recoveryAction: "manage_github_app_installation",
        contextStatus: { label: "Sync failed", detail: "Permission denied", severity: "error" },
      }),
    );

    const { container, root } = await renderDom(<ContextPage />);
    await waitForText(container, "Manage Context Tree");
    expect(container.textContent).toContain("Review the binding and recovery options in Settings.");
    expect(container.textContent).not.toContain("GitHub App");
    expect(githubAppMocks.getGithubAppInstallation).not.toHaveBeenCalled();
    expect(onboardingEventMocks.postTreeSetupStartChat).not.toHaveBeenCalled();
    await click(container.querySelector('a[href="/settings/context#binding"]'));
    expect(container.querySelector('[data-testid="location"]')?.textContent).toBe("/settings/context#binding");

    await act(async () => root.unmount());
  });

  it("routes a no-tree admin to the dedicated settings page", async () => {
    authMock.value = { organizationId: "org-1", role: "admin" };
    const { ContextPage } = await import("../context.js");
    contextApiMocks.getContextTreeSnapshot.mockResolvedValue(unavailableSnapshot());

    const { container, root } = await renderDom(<ContextPage />);
    await waitForText(container, "Set up Context Tree");
    expect(container.textContent).toContain("Set it up in Settings when your team is ready.");
    expect(agentApiMocks.listManagedAgents).not.toHaveBeenCalled();
    expect(resourceApiMocks.listTeamResourcesForOrg).not.toHaveBeenCalled();
    expect(githubAppMocks.getGithubAppInstallation).not.toHaveBeenCalled();
    expect(githubMocks.listOrgGithubRepos).not.toHaveBeenCalled();
    await click(container.querySelector('a[href="/settings/context#binding"]'));
    expect(resourceApiMocks.createTeamResourceForOrg).not.toHaveBeenCalled();
    expect(container.querySelector('[data-testid="location"]')?.textContent).toBe("/settings/context#binding");

    await act(async () => root.unmount());
  });

  it("keeps unavailable member states admin-owned and does not query setup dependencies", async () => {
    authMock.value = { organizationId: "org-1", role: "member" };
    const { ContextPage } = await import("../context.js");
    contextApiMocks.getContextTreeSnapshot.mockResolvedValue(
      snapshot({
        repo: "https://github.com/acme/context-tree",
        branch: "main",
        snapshotStatus: "unavailable",
        recoveryAction: "manage_github_app_installation",
        contextStatus: { label: "Sync failed", detail: "Permission denied", severity: "error" },
      }),
    );

    const { container, root } = await renderDom(<ContextPage />);
    await waitForText(container, "Ask an admin to inspect this Context Tree sync issue.");
    expect(buttonByText(container, "Work on this in chat")).toBeNull();
    expect(agentApiMocks.listManagedAgents).not.toHaveBeenCalled();
    expect(githubAppMocks.getGithubAppInstallation).not.toHaveBeenCalled();

    await act(async () => root.unmount());
  });

  it("resets the chat button and surfaces kickoff failures", async () => {
    authMock.value = { organizationId: "org-1", role: "admin" };
    agentApiMocks.listManagedAgents.mockResolvedValue([treeAgent]);
    onboardingEventMocks.postTreeSetupStartChat.mockRejectedValueOnce(new Error("tree setup unavailable"));
    const { ContextTreeBuildEntry } = await import("../context-tree-build-entry.js");

    const { container, root } = await renderDom(<ContextTreeBuildEntry intent="recover" />);
    await waitForText(container, "Work on this in chat");
    await click(buttonByText(container, "Work on this in chat"));
    await waitForText(container, "tree setup unavailable");
    expect(buttonByText(container, "Work on this in chat")?.hasAttribute("disabled")).toBe(false);

    await act(async () => root.unmount());
  });

  it("does not require an active agent before opening Context Tree settings", async () => {
    authMock.value = { organizationId: "org-1", role: "admin" };
    agentApiMocks.listManagedAgents.mockResolvedValue([]);
    const { ContextPage } = await import("../context.js");
    contextApiMocks.getContextTreeSnapshot.mockResolvedValue(unavailableSnapshot());

    const { container, root } = await renderDom(<ContextPage />);
    await waitForText(container, "Set up Context Tree");
    expect(agentApiMocks.listManagedAgents).not.toHaveBeenCalled();
    await click(container.querySelector('a[href="/settings/context#binding"]'));
    expect(container.querySelector('[data-testid="location"]')?.textContent).toBe("/settings/context#binding");

    await act(async () => root.unmount());
  });

  it("does not show setup recovery on a live tree even when setup kickoff was never sent", async () => {
    authMock.value = { organizationId: "org-1", role: "admin" };
    onboardingEventMocks.getTreeSetupStatus.mockResolvedValueOnce({
      needsTreeSetup: true,
      hasTreeBinding: true,
      hasTreeSetupStartChat: false,
    });
    agentApiMocks.listManagedAgents.mockResolvedValue([
      {
        uuid: "agent-1",
        name: "agent-1",
        displayName: "Tree Agent",
        type: "agent",
        organizationId: "org-1",
        inboxId: "inbox-agent-1",
        visibility: "private",
        runtimeProvider: "claude-code",
        clientId: "client-agent-1",
        status: "active",
        avatarImageUrl: null,
      },
    ]);
    resourceApiMocks.listTeamResourcesForOrg.mockResolvedValue([]);
    const { ContextPage } = await import("../context.js");
    contextApiMocks.getContextTreeSnapshot.mockResolvedValue(
      snapshot({
        repo: "https://github.com/acme/context-tree",
        branch: "main",
        snapshotStatus: "active",
        contextStatus: { label: "Live", detail: null, severity: "ok" },
      }),
    );

    const { container, root } = await renderDom(<ContextPage />);
    await waitForText(container, "LIVE");
    expect(container.textContent).not.toContain("Finish Context Tree setup");
    expect(container.textContent).not.toContain("Build your Context Tree");

    await act(async () => root.unmount());
  });

  it("does not show setup recovery on a bootstrap-only live tree", async () => {
    authMock.value = { organizationId: "org-1", role: "admin" };
    onboardingEventMocks.getTreeSetupStatus.mockResolvedValueOnce({
      needsTreeSetup: true,
      hasTreeBinding: true,
      hasTreeSetupStartChat: false,
    });
    const { ContextPage } = await import("../context.js");
    contextApiMocks.getContextTreeSnapshot.mockResolvedValue(
      snapshot({
        repo: "https://github.com/acme/context-tree",
        branch: "main",
        snapshotStatus: "active",
        contextStatus: { label: "Live", detail: null, severity: "ok" },
        nodes: [
          {
            id: "root",
            parentId: null,
            path: "",
            sourcePath: "NODE.md",
            title: "Context Tree",
            kind: "root",
            owners: [],
            preview: null,
            relatedNodeIds: [],
            affectedContextArea: "root",
            changeType: null,
            changedAtCommit: null,
          },
        ],
        edges: [],
      }),
    );

    const { container, root } = await renderDom(<ContextPage />);
    await waitForText(container, "LIVE");
    expect(container.textContent).not.toContain("Finish Context Tree setup");
    expect(container.textContent).not.toContain("Build your Context Tree");

    await act(async () => root.unmount());
  });

  it("loads and errors through the live query path", async () => {
    const { ContextPage } = await import("../context.js");
    let resolveSnapshot: (value: ContextTreeSnapshot) => void = () => undefined;
    contextApiMocks.getContextTreeSnapshot.mockReturnValue(
      new Promise<ContextTreeSnapshot>((resolve) => {
        resolveSnapshot = resolve;
      }),
    );
    const loading = await renderDom(<ContextPage />);
    expect(loading.container.textContent).toContain("Loading team context...");
    expect(contextApiMocks.getContextTreeSnapshot).toHaveBeenCalledWith("org-1", "7d");
    await act(async () => {
      resolveSnapshot(snapshot());
    });
    await waitForText(loading.container, "LIVE");
    await act(async () => loading.root.unmount());

    contextApiMocks.getContextTreeSnapshot.mockRejectedValueOnce(new Error("Snapshot unavailable"));
    const failed = await renderDom(<ContextPage />);
    await waitForText(failed.container, "Snapshot unavailable");
    await act(async () => failed.root.unmount());

    authMock.value = { organizationId: null, role: null };
    const noOrg = await renderDom(<ContextPage />);
    // No org → query disabled, no snapshot. The page renders only its
    // PageHeader chrome (always present, like every other tab) — no live
    // chip, no IO feed, and no navigation occurs.
    expect(noOrg.container.querySelector('[data-testid="location"]')?.textContent).toBe("/");
    expect(noOrg.container.textContent).not.toContain("LIVE");
    // Assert the IO feed section element is absent (robust to its label text)
    // rather than matching a sublabel string that the data model may rename.
    expect(noOrg.container.querySelector(".context-usage-feed")).toBeNull();
    expect(contextApiMocks.getContextTreeSnapshot).toHaveBeenCalledTimes(2);
    await act(async () => noOrg.root.unmount());
  });
});
