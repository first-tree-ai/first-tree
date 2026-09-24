import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type RouteHandler = (...args: unknown[]) => unknown;

type RegisteredRoute = {
  method: "DELETE" | "GET" | "PATCH" | "POST" | "PUT";
  path: string;
  options?: unknown;
  handler: RouteHandler;
};

type TestReply = {
  code?: number;
  body?: unknown;
  status: (code: number) => TestReply;
  send: (body: unknown) => TestReply;
};

const routeMocks = {
  aggregateByAgent: vi.fn(),
  assertMutableAgentIsNotLandingCampaignTrial: vi.fn(),
  assertNoRuntimeSwitchInProgress: vi.fn(),
  getMeDocPreview: vi.fn(),
  getOrganization: vi.fn(),
  getOrgContextTreeBinding: vi.fn(),
  getTeamSafeOrgContextReviewRuntime: vi.fn(),
  generateConnectToken: vi.fn(),
  ensureMembership: vi.fn(),
  findActiveByToken: vi.fn(),
  listAgentTurns: vi.fn(),
  listActiveMemberships: vi.fn(),
  leaveOrganization: vi.fn(),
  membershipRecoveryPolicy: vi.fn(),
  recoverAgentRuntimeSwitch: vi.fn(),
  recordRedemption: vi.fn(),
  requireAgent: vi.fn(),
  requireAgentAccess: vi.fn(),
  requireChatAccess: vi.fn(),
  requireOrgAdmin: vi.fn(),
  requireOrgMembership: vi.fn(),
  resetActivity: vi.fn(),
  resolveUsageWindow: vi.fn(),
  selfCreateOrganization: vi.fn(),
  summarizeAgent: vi.fn(),
  updateOrganization: vi.fn(),
};

const mockedModules = [
  "@first-tree/shared/channel",
  "../middleware/require-identity.js",
  "../scope/require-org.js",
  "../scope/require-resource.js",
  "../services/chat/sessions/activity.js",
  "../services/agents/identity.js",
  "../services/auth/tokens.js",
  "../services/agents/runtime/switch.js",
  "../services/chat/conversation.js",
  "../services/runtime/connection-manager.js",
  "../services/scm/github/entity-chat.js",
  "../services/scm/github/entity-follow.js",
  "../services/team/invitation.js",
  "../services/landing-campaigns/guards.js",
  "../services/chat/workspace/document-preview.js",
  "../services/team/membership.js",
  "../services/onboarding-kickoff.js",
  "../services/context-tree/settings.js",
  "../services/team/default-membership.js",
  "../services/team/organization.js",
  "../services/usage.js",
];

function mockRouteDependencies(): void {
  vi.doMock("../middleware/require-identity.js", () => ({
    requireAgent: routeMocks.requireAgent,
  }));
  vi.doMock("../scope/require-org.js", () => ({
    requireOrgAdmin: routeMocks.requireOrgAdmin,
    requireOrgMembership: routeMocks.requireOrgMembership,
  }));
  vi.doMock("../scope/require-resource.js", () => ({
    assertAllAgentsVisibleInOrg: vi.fn(),
    requireAgentAccess: routeMocks.requireAgentAccess,
    requireChatAccess: routeMocks.requireChatAccess,
  }));
  vi.doMock("../services/chat/sessions/activity.js", () => ({
    resetActivity: routeMocks.resetActivity,
  }));
  vi.doMock("../services/auth/tokens.js", () => ({
    generateConnectToken: routeMocks.generateConnectToken,
  }));
  vi.doMock("../services/team/default-membership.js", () => ({
    pickDefaultMembership: vi.fn(),
  }));
  vi.doMock("../services/team/invitation.js", () => ({
    buildInviteUrl: vi.fn((_base: string, token: string) => `https://invite.example/${token}`),
    findActiveByToken: routeMocks.findActiveByToken,
    getActiveInvitation: vi.fn(),
    recordRedemption: routeMocks.recordRedemption,
  }));
  vi.doMock("../services/agents/runtime/switch.js", () => ({
    RUNTIME_SWITCH_FAULTS: ["after_claim", "after_commit"],
    assertNoRuntimeSwitchInProgress: routeMocks.assertNoRuntimeSwitchInProgress,
    recoverAgentRuntimeSwitch: routeMocks.recoverAgentRuntimeSwitch,
  }));
  vi.doMock("../services/landing-campaigns/guards.js", () => ({
    assertMetadataDoesNotClaimLandingCampaignTrial: vi.fn(),
    assertMutableAgentIsNotLandingCampaignTrial: routeMocks.assertMutableAgentIsNotLandingCampaignTrial,
  }));
  vi.doMock("../services/chat/workspace/document-preview.js", () => ({
    getMeDocPreview: routeMocks.getMeDocPreview,
  }));
  vi.doMock("../services/team/membership.js", () => ({
    countActiveMembersByOrgs: vi.fn(async () => new Map()),
    ensureMembership: routeMocks.ensureMembership,
    leaveOrganization: routeMocks.leaveOrganization,
    listActiveMemberships: routeMocks.listActiveMemberships,
    membershipRecoveryPolicy: routeMocks.membershipRecoveryPolicy,
    selfCreateOrganization: routeMocks.selfCreateOrganization,
  }));
  vi.doMock("../services/onboarding-kickoff.js", () => ({
    hasTreeSetupKickoffMessage: vi.fn(async () => false),
    kickoffOnboarding: vi.fn(async () => ({ chatId: "chat_1", sent: null })),
  }));
  vi.doMock("../services/context-tree/settings.js", () => ({
    getOrgContextTreeBinding: routeMocks.getOrgContextTreeBinding,
    getTeamSafeOrgContextReviewRuntime: routeMocks.getTeamSafeOrgContextReviewRuntime,
  }));
  vi.doMock("../services/team/organization.js", () => ({
    getOrganization: routeMocks.getOrganization,
    updateOrganization: routeMocks.updateOrganization,
  }));
  vi.doMock("../services/usage.js", () => ({
    DEFAULT_USAGE_TURNS_LIMIT: 25,
    aggregateByAgent: routeMocks.aggregateByAgent,
    listAgentTurns: routeMocks.listAgentTurns,
    resolveUsageWindow: routeMocks.resolveUsageWindow,
    summarizeAgent: routeMocks.summarizeAgent,
  }));
}

function makeReply(): TestReply {
  const reply: TestReply = {
    status(code: number): TestReply {
      this.code = code;
      return this;
    },
    send(body: unknown): TestReply {
      this.body = body;
      return this;
    },
  };
  return reply;
}

function addRoute(
  routes: RegisteredRoute[],
  method: RegisteredRoute["method"],
  path: string,
  optionsOrHandler: unknown,
  maybeHandler?: unknown,
): void {
  const hasOptions = typeof optionsOrHandler !== "function";
  routes.push({
    handler: (hasOptions ? maybeHandler : optionsOrHandler) as RouteHandler,
    method,
    options: hasOptions ? optionsOrHandler : undefined,
    path,
  });
}

function makeApp(extra: Record<string, unknown> = {}): { app: unknown; routes: RegisteredRoute[] } {
  const routes: RegisteredRoute[] = [];
  const app = {
    db: { name: "db" },
    config: {},
    addContentTypeParser: vi.fn(),
    delete(path: string, optionsOrHandler: unknown, maybeHandler?: unknown): void {
      addRoute(routes, "DELETE", path, optionsOrHandler, maybeHandler);
    },
    get(path: string, optionsOrHandler: unknown, maybeHandler?: unknown): void {
      addRoute(routes, "GET", path, optionsOrHandler, maybeHandler);
    },
    patch(path: string, optionsOrHandler: unknown, maybeHandler?: unknown): void {
      addRoute(routes, "PATCH", path, optionsOrHandler, maybeHandler);
    },
    post(path: string, optionsOrHandler: unknown, maybeHandler?: unknown): void {
      addRoute(routes, "POST", path, optionsOrHandler, maybeHandler);
    },
    put(path: string, optionsOrHandler: unknown, maybeHandler?: unknown): void {
      addRoute(routes, "PUT", path, optionsOrHandler, maybeHandler);
    },
    ...extra,
  };
  return { app, routes };
}

function route(routes: RegisteredRoute[], method: RegisteredRoute["method"], path: string): RegisteredRoute {
  const found = routes.find((entry) => entry.method === method && entry.path === path);
  expect(found).toBeDefined();
  return found as RegisteredRoute;
}

function makeQueuedSelectDb(results: unknown[][]): unknown {
  return {
    select: vi.fn(() => {
      const rows = results.shift() ?? [];
      const chain = {
        from: vi.fn(() => chain),
        limit: vi.fn(async () => rows),
        where: vi.fn(() => chain),
      };
      return chain;
    }),
  };
}

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  mockRouteDependencies();
  routeMocks.requireAgent.mockReturnValue({ organizationId: "org_1", uuid: "agent_1" });
  routeMocks.requireAgentAccess.mockResolvedValue({
    agent: { uuid: "agent_1" },
    scope: { humanAgentId: "human_1", memberId: "member_1" },
  });
  routeMocks.requireChatAccess.mockResolvedValue(undefined);
  routeMocks.requireOrgAdmin.mockResolvedValue({ memberId: "member_1", organizationId: "org_1", role: "admin" });
  routeMocks.requireOrgMembership.mockResolvedValue({
    memberId: "member_1",
    organizationId: "org_1",
    role: "admin",
  });
  routeMocks.membershipRecoveryPolicy.mockReturnValue("repair-required");
  routeMocks.ensureMembership.mockResolvedValue({ id: "member_joined", organizationId: "org_join", role: "member" });
  routeMocks.findActiveByToken.mockResolvedValue(null);
  routeMocks.listActiveMemberships.mockResolvedValue([]);
  routeMocks.leaveOrganization.mockResolvedValue(undefined);
  routeMocks.recordRedemption.mockResolvedValue(undefined);
  routeMocks.selfCreateOrganization.mockResolvedValue({
    organizationId: "org_created",
    name: "new-org",
    displayName: "New Org",
  });
  routeMocks.resolveUsageWindow.mockReturnValue({
    from: new Date("2026-07-01T00:00:00.000Z"),
    to: new Date("2026-07-08T00:00:00.000Z"),
  });
});

afterEach(() => {
  for (const moduleId of mockedModules) {
    vi.doUnmock(moduleId);
  }
  vi.resetModules();
});

describe("small API route handlers", () => {
  it("maps GitHub entity follow service outcomes to the wire contract", async () => {
    const { sendFollowResult } = await import("../api/github-entity-reply.js");
    const conflictReply = makeReply();

    sendFollowResult(
      conflictReply as never,
      {
        conflict: { chatId: "chat_1", topic: "PR 1" },
        outcome: "conflict",
      } as never,
      "owner/repo#1",
    );
    expect(conflictReply.code).toBe(409);
    expect(conflictReply.body).toMatchObject({
      conflict: { chatId: "chat_1", topic: "PR 1" },
      error: "ENTITY_FOLLOWED_ELSEWHERE",
    });

    const createdReply = makeReply();
    sendFollowResult(createdReply as never, { entity: { key: "owner/repo#1" }, outcome: "created" } as never, "x");
    expect(createdReply.code).toBe(201);
    expect(createdReply.body).toEqual({ entity: { key: "owner/repo#1" }, status: "created" });

    const existingReply = makeReply();
    sendFollowResult(
      existingReply as never,
      { entity: { key: "owner/repo#1" }, outcome: "already_following" } as never,
      "x",
    );
    expect(existingReply.code).toBe(200);
  });

  it("serves org and agent usage routes with scoped defaults", async () => {
    const { orgUsageRoutes } = await import("../api/orgs/usage.js");
    const { agentUsageRoutes } = await import("../api/agent-usage.js");
    const { app, routes } = makeApp();
    routeMocks.aggregateByAgent.mockResolvedValue([{ agentId: "agent_1", totalTokens: 12 }]);
    routeMocks.summarizeAgent.mockResolvedValue({ totalTokens: 12 });
    routeMocks.listAgentTurns.mockResolvedValue({ rows: [], nextCursor: null });

    await orgUsageRoutes(app as never);
    await agentUsageRoutes(app as never);

    await expect(route(routes, "GET", "/by-agent").handler({ query: {} })).resolves.toEqual({
      from: "2026-07-01T00:00:00.000Z",
      rows: [{ agentId: "agent_1", totalTokens: 12 }],
      to: "2026-07-08T00:00:00.000Z",
    });
    await expect(
      route(routes, "GET", "/:uuid/usage/summary").handler({ params: { uuid: "agent_1" }, query: {} }),
    ).resolves.toEqual({ totalTokens: 12 });
    await expect(
      route(routes, "GET", "/:uuid/usage/turns").handler({
        params: { uuid: "agent_1" },
        query: { cursor: "cursor_1", limit: "not-a-number" },
      }),
    ).resolves.toEqual({ nextCursor: null, rows: [] });

    expect(routeMocks.aggregateByAgent).toHaveBeenCalledWith(
      { name: "db" },
      expect.objectContaining({ organizationId: "org_1" }),
    );
    expect(routeMocks.summarizeAgent).toHaveBeenCalledWith(
      { name: "db" },
      expect.objectContaining({ agentId: "agent_1" }),
    );
    expect(routeMocks.listAgentTurns).toHaveBeenCalledWith(
      { name: "db" },
      expect.objectContaining({ cursor: "cursor_1", limit: 25, viewer: { humanAgentId: "human_1" } }),
    );
  });

  it("returns health and healthz success and degraded responses", async () => {
    vi.useFakeTimers();
    try {
      const { healthRoutes } = await import("../api/health.js");
      const { healthzRoutes } = await import("../api/healthz.js");
      const execute = vi.fn().mockResolvedValue(undefined);
      const { app, routes } = makeApp({ db: { execute } });

      await healthRoutes(app as never);
      await healthzRoutes(app as never);
      await expect(route(routes, "GET", "/health").handler()).resolves.toEqual({ db: "connected", status: "ok" });

      const okReply = makeReply();
      await route(routes, "GET", "/healthz").handler({}, okReply);
      expect(okReply).toMatchObject({ body: { status: "ok" }, code: 200 });

      execute.mockRejectedValueOnce(new Error("db down")).mockRejectedValueOnce(new Error("db down"));
      await expect(route(routes, "GET", "/health").handler()).resolves.toEqual({
        db: "disconnected",
        status: "degraded",
      });
      // /healthz caches its probe briefly; move past the TTL so the degraded
      // path re-probes and consumes the second rejection.
      vi.advanceTimersByTime(1_001);
      const degradedReply = makeReply();
      await route(routes, "GET", "/healthz").handler({}, degradedReply);
      expect(degradedReply).toMatchObject({ body: { message: "database unreachable", status: "error" }, code: 503 });
    } finally {
      vi.useRealTimers();
    }
  });

  it("serves agent runtime config and context tree info", async () => {
    const { agentConfigRoutes } = await import("../api/agent/config.js");
    const { agentContextTreeInfoRoutes } = await import("../api/agent/context-tree-info.js");
    const { app, routes } = makeApp({
      configService: { getDecrypted: vi.fn().mockResolvedValue({ env: { A: "1" } }) },
      resourcesService: { resolveRuntimeConfig: vi.fn().mockReturnValue({ env: { A: "1" }, resources: [] }) },
    });
    routeMocks.getTeamSafeOrgContextReviewRuntime
      .mockResolvedValueOnce({
        bindingState: "bound",
        provider: "gitlab",
        branch: "main",
        repo: "git@gitlab.example:owner/tree.git",
        providerMatchesRepository: true,
        gitlabConnection: {
          id: "connection-1",
          instanceOrigin: "https://gitlab.example:8443",
        },
        contextReviewer: { enabled: true, agentUuid: "reviewer-1" },
      })
      .mockResolvedValueOnce({
        bindingState: "bound",
        provider: "gitlab",
        branch: "main",
        repo: "git@gitlab.example:owner/tree.git",
        providerMatchesRepository: false,
        gitlabConnection: {
          id: "connection-2",
          instanceOrigin: "https://gitlab.example:9443",
        },
        contextReviewer: { enabled: true, agentUuid: "reviewer-1" },
      })
      .mockResolvedValueOnce({
        bindingState: "bound",
        provider: "gitlab",
        branch: "main",
        repo: "git@gitlab.example:owner/tree.git",
        providerMatchesRepository: false,
        gitlabConnection: null,
        contextReviewer: { enabled: true, agentUuid: "reviewer-1" },
      });

    await agentConfigRoutes(app as never);
    await agentContextTreeInfoRoutes(app as never);

    await expect(route(routes, "GET", "/config").handler({})).resolves.toEqual({ env: { A: "1" }, resources: [] });
    await expect(route(routes, "GET", "/context-tree/info").handler({})).resolves.toEqual({
      bindingState: "bound",
      provider: "gitlab",
      branch: "main",
      repo: "git@gitlab.example:owner/tree.git",
      providerMatchesRepository: true,
      gitlabConnection: {
        id: "connection-1",
        instanceOrigin: "https://gitlab.example:8443",
      },
      contextReviewer: { enabled: true, agentUuid: "reviewer-1" },
    });
    await expect(route(routes, "GET", "/context-tree/info").handler({})).resolves.toEqual({
      bindingState: "bound",
      provider: "gitlab",
      branch: "main",
      repo: "git@gitlab.example:owner/tree.git",
      providerMatchesRepository: false,
      gitlabConnection: {
        id: "connection-2",
        instanceOrigin: "https://gitlab.example:9443",
      },
      contextReviewer: { enabled: true, agentUuid: "reviewer-1" },
    });
    await expect(route(routes, "GET", "/context-tree/info").handler({})).resolves.toEqual({
      bindingState: "bound",
      provider: "gitlab",
      branch: "main",
      repo: "git@gitlab.example:owner/tree.git",
      providerMatchesRepository: false,
      gitlabConnection: null,
      contextReviewer: { enabled: true, agentUuid: "reviewer-1" },
    });
  });

  it("fails closed when a hosted channel has no portable installer metadata", async () => {
    vi.doMock("@first-tree/shared/channel", () => ({
      getChannelConfig: vi.fn(() => ({
        binName: "first-tree-test",
        defaultServerUrl: "https://first-tree.example",
        packageName: "first-tree-test",
        portable: { downloadBaseUrl: null, publicInstallerPath: null },
      })),
    }));
    routeMocks.generateConnectToken.mockResolvedValue({ token: "code_123", expiresIn: 600 });
    const { meRoutes } = await import("../api/me.js");
    const { app, routes } = makeApp({
      config: {
        auth: { connectTokenExpiry: "10m" },
        channel: "staging",
        connectBootstrap: { portableDownloadBaseUrl: "https://download.example/releases" },
        server: { publicUrl: "https://first-tree.example/app/" },
      },
    });

    await meRoutes(app as never);

    await expect(
      route(routes, "POST", "/me/connect-tokens").handler({
        headers: {},
        hostname: "ignored.local",
        protocol: "https",
        user: { userId: "user_1" },
      }),
    ).rejects.toThrow("Portable installer metadata is missing for the staging channel");
    expect(routeMocks.generateConnectToken).toHaveBeenCalledWith(
      { name: "db" },
      "user_1",
      { connectTokenExpiry: "10m" },
      "https://first-tree.example/app",
    );
  });

  it("shell-quotes an unsafe connect code without putting it in the installer URL", async () => {
    vi.doMock("@first-tree/shared/channel", () => ({
      getChannelConfig: vi.fn(() => ({
        binName: "first-tree",
        defaultServerUrl: "https://cloud.first-tree.ai",
        packageName: "first-tree",
        portable: {
          downloadBaseUrl: "https://download.first-tree.ai/releases",
          publicInstallerPath: "prod/install.sh",
        },
      })),
    }));
    const token = "code'$(id);x";
    routeMocks.generateConnectToken.mockResolvedValue({ token, expiresIn: 600 });
    const { meRoutes } = await import("../api/me.js");
    const { app, routes } = makeApp({
      config: {
        auth: { connectTokenExpiry: "10m" },
        channel: "prod",
        connectBootstrap: { portableDownloadBaseUrl: "https://download.first-tree.ai/releases" },
        server: { publicUrl: "https://cloud.first-tree.ai" },
      },
    });

    await meRoutes(app as never);
    const result = (await route(routes, "POST", "/me/connect-tokens").handler({
      headers: {},
      hostname: "ignored.local",
      protocol: "https",
      user: { userId: "user_1" },
    })) as {
      bootstrapCommand: string;
      command: string;
      installerUrl: string;
      token: string;
    };

    expect(result.token).toBe(token);
    expect(result.command).toBe("first-tree login 'code'\\''$(id);x'");
    expect(result.bootstrapCommand).toBe(
      `curl -fsSL https://download.first-tree.ai/releases/prod/install.sh | sh\n` +
        `~/.local/bin/first-tree login 'code'\\''$(id);x'`,
    );
    expect(result.installerUrl).toBe("https://download.first-tree.ai/releases/prod/install.sh");
    expect(result.installerUrl).not.toContain(token);
  });

  it("covers /me organization create, join, leave, and onboarding membership edge routes", async () => {
    const { meRoutes } = await import("../api/me.js");
    const appBase = {
      config: {
        auth: { connectTokenExpiry: "10m" },
        channel: "dev",
        connectBootstrap: { portableDownloadBaseUrl: "https://download.example/releases" },
        docs: { enabled: true },
        growth: {},
        server: { publicUrl: "https://first-tree.example" },
      },
      log: { info: vi.fn(), warn: vi.fn() },
      notifier: {},
    };

    const created = makeApp({
      ...appBase,
      db: makeQueuedSelectDb([[{ username: "alice", displayName: "Alice" }]]),
    });
    await meRoutes(created.app as never);
    const createReply = makeReply();
    await route(created.routes, "POST", "/me/organizations").handler(
      { body: { displayName: "New Org" }, user: { userId: "user_1" } },
      createReply,
    );
    expect(createReply).toMatchObject({
      code: 201,
      body: { organization: { id: "org_created", name: "new-org", displayName: "New Org", role: "admin" } },
    });
    expect(routeMocks.selfCreateOrganization).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ username: "alice" }),
    );

    const missingUser = makeApp({ ...appBase, db: makeQueuedSelectDb([[]]) });
    await meRoutes(missingUser.app as never);
    await expect(
      route(missingUser.routes, "POST", "/me/organizations").handler(
        { body: { displayName: "New Org" }, user: { userId: "user_missing" } },
        makeReply(),
      ),
    ).rejects.toThrow("User not found");

    const joinMissingInvite = makeApp({ ...appBase, db: makeQueuedSelectDb([]) });
    await meRoutes(joinMissingInvite.app as never);
    const missingInviteReply = makeReply();
    await route(joinMissingInvite.routes, "POST", "/me/organizations/join").handler(
      { body: { token: "invite_missing" }, headers: {}, ip: "127.0.0.1", user: { userId: "user_1" } },
      missingInviteReply,
    );
    expect(missingInviteReply).toMatchObject({
      code: 404,
      body: { error: "Invitation not found or no longer valid" },
    });

    routeMocks.findActiveByToken.mockResolvedValueOnce({
      id: "inv_1",
      organizationId: "org_join",
      role: "admin",
      token: "invite_admin",
    });
    routeMocks.ensureMembership.mockResolvedValueOnce({
      id: "member_admin",
      organizationId: "org_join",
      role: "admin",
    });
    const joinAdmin = makeApp({
      ...appBase,
      db: makeQueuedSelectDb([[{ username: "alice", displayName: "Alice" }]]),
    });
    await meRoutes(joinAdmin.app as never);
    const joinReply = makeReply();
    await route(joinAdmin.routes, "POST", "/me/organizations/join").handler(
      { body: { token: "invite_admin" }, headers: {}, ip: "127.0.0.1", user: { userId: "user_1" } },
      joinReply,
    );
    expect(joinReply).toMatchObject({
      code: 200,
      body: { organizationId: "org_join", memberId: "member_admin", role: "admin" },
    });
    expect(routeMocks.recordRedemption).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ userAgent: null }),
    );

    routeMocks.findActiveByToken.mockResolvedValueOnce({
      id: "inv_2",
      organizationId: "org_join",
      role: "member",
      token: "invite_member",
    });
    const joinNoUser = makeApp({ ...appBase, db: makeQueuedSelectDb([[]]) });
    await meRoutes(joinNoUser.app as never);
    await expect(
      route(joinNoUser.routes, "POST", "/me/organizations/join").handler(
        { body: { token: "invite_member" }, headers: {}, ip: "127.0.0.1", user: { userId: "user_missing" } },
        makeReply(),
      ),
    ).rejects.toThrow("User not found");

    const leave = makeApp({
      ...appBase,
      db: makeQueuedSelectDb([
        [{ id: "member_leave", userId: "user_1" }],
        [{ id: "member_other", userId: "user_2" }],
        [],
      ]),
    });
    await meRoutes(leave.app as never);
    const leaveReply = makeReply();
    await route(leave.routes, "POST", "/me/memberships/:memberId/leave").handler(
      { params: { memberId: "member_leave" }, user: { userId: "user_1" } },
      leaveReply,
    );
    expect(leaveReply.code).toBe(204);
    expect(routeMocks.membershipRecoveryPolicy).toHaveBeenCalledWith(undefined);
    expect(routeMocks.leaveOrganization).toHaveBeenCalledWith(
      expect.anything(),
      "member_leave",
      "repair-required",
      appBase.notifier,
    );
    await expect(
      route(leave.routes, "POST", "/me/memberships/:memberId/leave").handler(
        { params: { memberId: "member_other" }, user: { userId: "user_1" } },
        makeReply(),
      ),
    ).rejects.toThrow('Membership "member_other" not found');
    await expect(
      route(leave.routes, "POST", "/me/memberships/:memberId/leave").handler(
        { params: { memberId: "member_missing" }, user: { userId: "user_1" } },
        makeReply(),
      ),
    ).rejects.toThrow('Membership "member_missing" not found');

    const onboardingOrgMissing = makeApp({ ...appBase, db: makeQueuedSelectDb([[]]) });
    await meRoutes(onboardingOrgMissing.app as never);
    await expect(
      route(onboardingOrgMissing.routes, "PATCH", "/me/onboarding").handler(
        { body: { dismissed: true, organizationId: "org_missing" }, user: { userId: "user_1" } },
        makeReply(),
      ),
    ).rejects.toThrow('Membership for organization "org_missing" not found');

    const onboardingDefaultMissing = makeApp({ ...appBase, db: makeQueuedSelectDb([]) });
    await meRoutes(onboardingDefaultMissing.app as never);
    await expect(
      route(onboardingDefaultMissing.routes, "PATCH", "/me/onboarding").handler(
        { body: { dismissed: true }, user: { userId: "user_1" } },
        makeReply(),
      ),
    ).rejects.toThrow("No active membership found");

    const kickoffMissingMember = makeApp({
      ...appBase,
      db: makeQueuedSelectDb([[{ id: "member_1" }], []]),
    });
    await meRoutes(kickoffMissingMember.app as never);
    await expect(
      route(kickoffMissingMember.routes, "POST", "/me/onboarding/kickoff").handler(
        {
          body: { organizationId: "org_1", agentUuid: "agent_1", bootstrap: "Hello" },
          user: { userId: "user_1" },
        },
        makeReply(),
      ),
    ).rejects.toThrow("Membership not found");
  });

  it("rejects avatar uploads whose parsed body is not a Buffer", async () => {
    const { agentRoutes } = await import("../api/agents.js");
    const { app, routes } = makeApp({
      config: { runtime: { runtimeSwitchFaultInjection: false } },
      log: { warn: vi.fn() },
      notifier: { notifyAgentRouteChange: vi.fn() },
    });

    await agentRoutes(app as never);

    await expect(
      route(routes, "PUT", "/:uuid/avatar").handler({
        body: { not: "bytes" },
        headers: { "content-type": "image/png" },
        params: { uuid: "agent_1" },
      }),
    ).rejects.toThrow("Avatar upload body must be raw image bytes.");
  });

  it("recovers a runtime switch and skips malformed immediate pinned frames", async () => {
    const sendToAgent = vi.fn();
    const sendToClient = vi.fn();
    vi.doMock("../services/runtime/connection-manager.js", () => ({
      forceDisconnect: vi.fn(),
      getAgentClientId: vi.fn(),
      hasActiveConnection: vi.fn(),
      sendToAgent,
      sendToClient,
    }));
    vi.doMock("../services/agents/identity.js", () => ({
      MAX_AVATAR_IMAGE_BYTES: 5 * 1024 * 1024,
      SUPPORTED_AVATAR_IMAGE_MIMES: ["image/png"],
      agentAvatarImageUrl: vi.fn(() => "/avatar.png"),
      clearAgentAvatarImage: vi.fn(),
      fetchUserAvatarForHumanAgent: vi.fn().mockResolvedValue(null),
      getAgentAvatarImage: vi.fn(),
      resolveAvatarImageUrl: vi.fn(() => null),
      setAgentAvatarImage: vi.fn(),
      stripReservedAgentMetadata: vi.fn((metadata: unknown) => metadata ?? {}),
    }));
    const recoveredAt = new Date("2026-07-08T00:00:00.000Z");
    routeMocks.recoverAgentRuntimeSwitch.mockResolvedValue({
      agent: {
        uuid: "agent_1",
        name: "runtime-recovered",
        displayName: "Runtime Recovered",
        type: "agent",
        clientId: "client_new",
        runtimeProvider: "not-a-runtime",
        metadata: {},
        createdAt: recoveredAt,
        updatedAt: recoveredAt,
      },
      oldClientId: "client_old",
      targetClientId: "client_new",
      terminatedChatIds: ["chat_1"],
      recoveryAction: "forwarded",
    });
    const warn = vi.fn();
    const notifyAgentRouteChange = vi.fn().mockResolvedValue(undefined);
    const { agentRoutes } = await import("../api/agents.js");
    const { app, routes } = makeApp({
      config: { runtime: { runtimeSwitchFaultInjection: true } },
      log: { warn },
      notifier: { notifyAgentRouteChange },
    });

    await agentRoutes(app as never);

    await expect(
      route(routes, "POST", "/:uuid/switch-runtime/recover").handler({
        headers: {},
        params: { uuid: "agent_1" },
      }),
    ).resolves.toMatchObject({
      uuid: "agent_1",
      runtimeProvider: "not-a-runtime",
      avatarImageUrl: null,
    });
    expect(routeMocks.recoverAgentRuntimeSwitch).toHaveBeenCalledWith(
      { name: "db" },
      "agent_1",
      expect.objectContaining({ notifier: expect.any(Object) }),
    );
    expect(notifyAgentRouteChange).toHaveBeenCalledWith(expect.objectContaining({ targetClientId: "client_new" }));
    expect(warn).toHaveBeenCalledWith(expect.any(Object), "agent:pinned frame failed schema validation — not sending");
    expect(sendToClient).not.toHaveBeenCalled();
    expect(sendToAgent).toHaveBeenCalledWith("agent_1", { type: "session:terminate", chatId: "chat_1" });
  });

  it("skips malformed org agent pinned frames after create", async () => {
    const sendToClient = vi.fn();
    const createdAt = new Date("2026-07-08T00:00:00.000Z");
    const createAgent = vi.fn().mockResolvedValue({
      uuid: "agent_bad_runtime",
      name: "bad-runtime",
      displayName: "Bad Runtime",
      type: "agent",
      clientId: "client_1",
      runtimeProvider: "not-a-runtime",
      metadata: {},
      createdAt,
      updatedAt: createdAt,
    });
    vi.doMock("../services/runtime/connection-manager.js", () => ({ sendToClient }));
    vi.doMock("../services/agents/identity.js", () => ({
      createAgent,
      resolveAvatarImageUrl: vi.fn(() => null),
      stripReservedAgentMetadata: vi.fn((metadata: unknown) => metadata ?? {}),
    }));
    const warn = vi.fn();
    const { orgAgentRoutes } = await import("../api/orgs/agents.js");
    const { app, routes } = makeApp({
      log: { warn },
      config: { attachments: { organizationObjectQuota: 10_000 } },
    });

    await orgAgentRoutes(app as never);

    const reply = makeReply();
    await route(routes, "POST", "/").handler(
      {
        body: { type: "agent", name: "bad-runtime", displayName: "Bad Runtime", clientId: "client_1" },
      },
      reply,
    );

    expect(reply.code).toBe(201);
    expect(createAgent).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ type: "agent", name: "bad-runtime" }),
      expect.objectContaining({ attachmentObjectQuota: { maxOrganizationAttachments: 10_000 } }),
    );
    expect(sendToClient).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(expect.any(Object), "agent:pinned frame failed schema validation — not sending");
  });

  it("rejects agent GitHub entity follow without a binding pair and unfollow without an entity", async () => {
    const assertParticipant = vi.fn().mockResolvedValue(undefined);
    const declareEntityFollow = vi.fn().mockResolvedValue({
      entity: { key: "acme/api#42" },
      outcome: "already_following",
    });
    const resolveBindingPair = vi
      .fn()
      .mockResolvedValueOnce(null)
      .mockResolvedValue({ delegateAgentId: "agent_1", humanAgentId: "human_1", organizationId: "org_1" });
    vi.doMock("../services/chat/conversation.js", () => ({ assertParticipant }));
    vi.doMock("../services/scm/github/entity-chat.js", () => ({ resolveBindingPair }));
    vi.doMock("../services/scm/github/entity-follow.js", () => ({
      declareEntityFollow,
      listChatGithubEntities: vi.fn(),
      removeEntityFollow: vi.fn(),
    }));
    const { agentChatRoutes } = await import("../api/agent/chats.js");
    const { app, routes } = makeApp({ config: { oauth: { githubApp: {} } } });

    await agentChatRoutes(app as never);

    await expect(
      route(routes, "POST", "/:chatId/github-entities").handler({
        body: { entity: "https://github.com/acme/api/pull/42" },
        params: { chatId: "chat_1" },
      }),
    ).rejects.toThrow("No eligible (human, wake-agent) binding pair");
    expect(resolveBindingPair).toHaveBeenCalledWith({ name: "db" }, "chat_1", "agent_1");

    const followReply = makeReply();
    await route(routes, "POST", "/:chatId/github-entities").handler(
      {
        body: { entity: "https://github.com/acme/api/pull/42" },
        params: { chatId: "chat_1" },
      },
      followReply,
    );
    expect(followReply).toMatchObject({ body: { entity: { key: "acme/api#42" }, status: "already_following" } });
    expect(declareEntityFollow).toHaveBeenCalledWith(
      { name: "db" },
      { appCredentials: {} },
      expect.objectContaining({
        boundVia: "agent_declared",
        chatId: "chat_1",
        delegateAgentId: "agent_1",
        humanAgentId: "human_1",
        organizationId: "org_1",
      }),
    );

    await expect(
      route(routes, "DELETE", "/:chatId/github-entities").handler({
        params: { chatId: "chat_1" },
        query: {},
      }),
    ).rejects.toThrow("Pass ?entity=<GitHub PR/Issue/Discussion URL | owner/repo#N> to unfollow.");
  });

  it("serializes organization identity reads and updates", async () => {
    const { orgIdentityRoutes } = await import("../api/orgs/identity.js");
    const dates = {
      createdAt: new Date("2026-07-01T00:00:00.000Z"),
      updatedAt: new Date("2026-07-08T00:00:00.000Z"),
    };
    routeMocks.getOrganization.mockResolvedValue({ id: "org_1", name: "acme", displayName: "Acme", ...dates });
    routeMocks.updateOrganization.mockResolvedValue({ id: "org_1", name: "acme", displayName: "Acme Inc", ...dates });
    const { app, routes } = makeApp();

    await orgIdentityRoutes(app as never);

    await expect(route(routes, "GET", "/").handler({})).resolves.toMatchObject({
      createdAt: "2026-07-01T00:00:00.000Z",
      displayName: "Acme",
      updatedAt: "2026-07-08T00:00:00.000Z",
    });
    await expect(route(routes, "PATCH", "/").handler({ body: { displayName: "Acme Inc" } })).resolves.toMatchObject({
      displayName: "Acme Inc",
      updatedAt: "2026-07-08T00:00:00.000Z",
    });
  });

  it("guards organization resource mutations and previews", async () => {
    const { orgResourceRoutes } = await import("../api/orgs/resources.js");
    const resourcesService = {
      createTeamResource: vi.fn().mockResolvedValue({ id: "res_1" }),
      listTeamResources: vi.fn().mockResolvedValue([{ id: "res_1" }]),
      previewOrgImpact: vi.fn().mockResolvedValue({ affectedAgents: 2 }),
    };
    const { app, routes } = makeApp({ resourcesService });

    await orgResourceRoutes(app as never);

    await expect(route(routes, "GET", "/").handler({})).resolves.toEqual([{ id: "res_1" }]);
    const createReply = makeReply();
    await route(routes, "POST", "/").handler(
      { body: { name: "Prompt", payload: { body: "Use short replies." }, type: "prompt" } },
      createReply,
    );
    expect(createReply).toMatchObject({ body: { id: "res_1" }, code: 201 });
    await expect(route(routes, "POST", "/impact-preview").handler({ body: { resourceId: "res_1" } })).resolves.toEqual({
      affectedAgents: 2,
    });

    routeMocks.requireOrgMembership.mockResolvedValueOnce({
      memberId: "member_2",
      organizationId: "org_1",
      role: "member",
    });
    await expect(route(routes, "POST", "/").handler({ body: {} }, makeReply())).rejects.toThrow("Admin role required");
  });

  it("updates agent resource bindings after management guards", async () => {
    const { agentResourcesRoutes } = await import("../api/agents-resources.js");
    const resourcesService = {
      getAgentResources: vi.fn().mockResolvedValue({ bindings: [] }),
      replaceAgentResources: vi.fn().mockResolvedValue({ version: 2 }),
    };
    const { app, routes } = makeApp({ resourcesService });

    await agentResourcesRoutes(app as never);

    await expect(route(routes, "GET", "/:uuid/resources").handler({ params: { uuid: "agent_1" } })).resolves.toEqual({
      bindings: [],
    });
    await expect(
      route(routes, "PATCH", "/:uuid/resources").handler({
        body: {
          bindings: [{ inlinePromptBody: "Stay focused.", mode: "include", type: "prompt" }],
          expectedVersion: 1,
        },
        params: { uuid: "agent_1" },
      }),
    ).resolves.toEqual({ version: 2 });
    expect(routeMocks.assertMutableAgentIsNotLandingCampaignTrial).toHaveBeenCalledWith({ uuid: "agent_1" });
    expect(routeMocks.assertNoRuntimeSwitchInProgress).toHaveBeenCalledWith({ uuid: "agent_1" });
  });

  it("resets agent activity through the manage scope", async () => {
    const { agentActivityRoutes } = await import("../api/agent-activity.js");
    const { app, routes } = makeApp();

    await agentActivityRoutes(app as never);

    await expect(
      route(routes, "POST", "/:uuid/reset-activity").handler({ params: { uuid: "agent_1" } }),
    ).resolves.toEqual({
      reset: true,
    });
    expect(routeMocks.resetActivity).toHaveBeenCalledWith({ name: "db" }, "agent_1");
  });

  it("serves me document previews only for speaker agents", async () => {
    const { meDocsRoutes } = await import("../api/me-docs.js");
    routeMocks.getMeDocPreview.mockResolvedValue({
      content: "# Plan",
      path: "plan.md",
      ref: { agentId: "agent_1", chatId: "chat_1", path: "plan.md", type: "workspace" },
    });
    const { app, routes } = makeApp({
      db: makeQueuedSelectDb([[{ agentId: "agent_1" }], [{ name: "Writer" }], [], [{ name: "Writer" }]]),
    });

    await meDocsRoutes(app as never, { workspacesRoot: "/workspace" });

    await expect(
      route(routes, "GET", "/chats/:chatId/docs/preview").handler({
        params: { chatId: "chat_1" },
        query: { agentId: "agent_1", path: "plan.md" },
      }),
    ).resolves.toEqual({
      content: "# Plan",
      path: "plan.md",
      ref: { agentId: "agent_1", chatId: "chat_1", path: "plan.md", type: "workspace" },
    });
    await expect(
      route(routes, "GET", "/chats/:chatId/docs/preview").handler({
        params: { chatId: "chat_1" },
        query: { agentId: "agent_1", path: "plan.md" },
      }),
    ).rejects.toThrow("Document not found");
  });
});
