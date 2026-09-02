import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionContext } from "../runtime/contracts.js";
import type { PrepareManagedSessionParams } from "../runtime/provider-support/preparation.js";
import { INIT_COMPLETE_SENTINEL_REL } from "../runtime/workspace.js";
import { mockCtxPlumbing } from "./test-helpers.js";

const acquireAgentHome = vi.fn((root: string) => root);
const markWorkspaceInitComplete = vi.fn();
const fetchChatContext = vi.fn();
const declaredSourceRepos = vi.fn();
const currentSourceRepoNamesFromPayload = vi.fn();

const TEST_PROVIDER_SKILL_ROOTS = Object.freeze({
  amp: ".agents/skills",
  "deepseek-harness": ".agents/skills",
  "claude-code": ".claude/skills",
  "claude-code-tui": ".claude/skills",
  codex: ".agents/skills",
  cursor: ".cursor/skills",
  grok: ".grok/skills",
  "kimi-code": ".kimi-code/skills",
  opencode: ".opencode/skills",
  pi: ".agents/skills",
});

const reconcileManagedSkillsForConfig = vi.fn();
const teamSkillBundleResolverFromSdk = vi.fn(() => vi.fn());
const buildAgentBriefing = vi.fn();
const ensureAgentBootstrap = vi.fn();

vi.mock("../runtime/workspace.js", async () => {
  const actual = await vi.importActual<typeof import("../runtime/workspace.js")>("../runtime/workspace.js");
  return {
    ...actual,
    acquireAgentHome: (root: string) => acquireAgentHome(root),
    markWorkspaceInitComplete: (workspace: string) => {
      markWorkspaceInitComplete(workspace);
      const sentinel = join(workspace, INIT_COMPLETE_SENTINEL_REL);
      mkdirSync(join(workspace, ".first-tree-workspace"), { recursive: true });
      writeFileSync(sentinel, JSON.stringify({ schemaVersion: 1, completedAt: new Date().toISOString() }));
    },
  };
});

vi.mock("../runtime/chat-context.js", () => ({
  fetchChatContext: (sdk: unknown, chatId: unknown, agent: unknown) => fetchChatContext(sdk, chatId, agent),
}));

vi.mock("../runtime/source-repos.js", () => ({
  declaredSourceRepos: (workspace: unknown, payload: unknown) => declaredSourceRepos(workspace, payload),
  currentSourceRepoNamesFromPayload: (payload: unknown, resolved: unknown) =>
    currentSourceRepoNamesFromPayload(payload, resolved),
}));

vi.mock("../runtime/managed-skills.js", () => ({
  allowedTargetRootsFromProjection: (roots: Record<string, string>) => new Set(Object.values(roots)),
  providerSkillRoot: (provider: keyof typeof TEST_PROVIDER_SKILL_ROOTS, roots: typeof TEST_PROVIDER_SKILL_ROOTS) =>
    roots[provider],
  reconcileManagedSkillsForConfig: async (
    workspace: unknown,
    provider: unknown,
    providerSkillRoots: unknown,
    runtimeConfig: unknown,
    log: unknown,
    resolver: unknown,
    // Forwarded so a test can assert the mode the projection was asked for.
    // `external` must arrive as itself: it selects the reduced Core Skill set,
    // and the admission proof is keyed to the same value.
    contextSourceKind?: unknown,
  ) => {
    const result = await reconcileManagedSkillsForConfig(
      workspace,
      provider,
      providerSkillRoots,
      runtimeConfig,
      log,
      resolver,
      contextSourceKind,
    );
    const root = join(
      workspace as string,
      (providerSkillRoots as Record<string, string>)[provider as string] as string,
    );
    // Mirror the real reconciler: external mode projects neither of these.
    const projected = contextSourceKind === "external" ? [] : ["first-tree-read", "first-tree-write"];
    for (const name of projected) {
      const skillDir = join(root, name);
      mkdirSync(skillDir, { recursive: true });
      writeFileSync(join(skillDir, "SKILL.md"), `# ${name}\n`);
      writeFileSync(join(skillDir, ".first-tree-managed.json"), JSON.stringify({ revision: "test-public:1" }));
    }
    return result;
  },
  reconcileManagedSkills: vi.fn(),
  verifyManagedSkillsProjectionForAdmission: vi.fn(async () => ({ resourceConfigVersion: 0, teamSkills: [] })),
  isManagedSkillsUnsafeDiscoveryError: () => false,
  ManagedSkillsUnsafeDiscoveryError: class ManagedSkillsUnsafeDiscoveryError extends Error {},
}));

vi.mock("../runtime/team-skill-bundle-resolver.js", () => ({
  teamSkillBundleResolverFromSdk: (_sdk: unknown) => teamSkillBundleResolverFromSdk(),
}));

vi.mock("../runtime/agent-briefing.js", () => ({
  buildAgentBriefing: (opts: unknown) => buildAgentBriefing(opts),
}));

vi.mock("../runtime/agent-bootstrap.js", () => ({
  ensureAgentBootstrap: (params: {
    workspace: string;
    sessionCtx: SessionContext;
    agentName: string;
    contextTreePath: string | null;
    contextSourceKind: "remote" | "local" | "none" | "external";
    briefing: string;
    currentSourceRepoNames: ReadonlySet<string> | null;
  }) => {
    ensureAgentBootstrap(params);
    const runtimeDir = join(params.workspace, ".first-tree-workspace");
    mkdirSync(runtimeDir, { recursive: true });
    writeFileSync(
      join(runtimeDir, "identity.json"),
      JSON.stringify({
        agentId: params.sessionCtx.agent.agentId,
        agentName: params.agentName,
        displayName: params.sessionCtx.agent.displayName,
        type: params.sessionCtx.agent.type,
        visibility: params.sessionCtx.agent.visibility,
        delegateMention: params.sessionCtx.agent.delegateMention,
        metadata: params.sessionCtx.agent.metadata,
        serverUrl: params.sessionCtx.sdk.serverUrl,
        contextTreePath: params.contextTreePath,
        contextSourceKind: params.contextSourceKind,
      }),
    );
    writeFileSync(join(params.workspace, "AGENTS.md"), params.briefing);
    const claudePath = join(params.workspace, "CLAUDE.md");
    rmSync(claudePath, { force: true });
    if (process.platform === "win32") writeFileSync(claudePath, params.briefing);
    else symlinkSync("AGENTS.md", claudePath);
    // External mode owns no workspace tree directory, so like `none` it gets no
    // workspace manifest — `workspaceTreeName("external")` is null.
    const ownsTree = params.contextSourceKind !== "none" && params.contextSourceKind !== "external";
    if (ownsTree && params.currentSourceRepoNames !== null) {
      const stateDir = join(params.workspace, ".first-tree");
      mkdirSync(stateDir, { recursive: true });
      writeFileSync(
        join(stateDir, "workspace.json"),
        JSON.stringify({ tree: params.contextSourceKind === "local" ? "local-context" : "context-tree" }),
      );
    }
  },
}));

describe("prepareManagedSession", () => {
  let workspaceRoot: string;
  const callOrder: string[] = [];

  beforeEach(() => {
    workspaceRoot = mkdtempSync(join(tmpdir(), "prepare-managed-session-"));
    callOrder.length = 0;
    vi.clearAllMocks();

    acquireAgentHome.mockImplementation((root: string) => {
      callOrder.push("acquire");
      return root;
    });
    fetchChatContext.mockImplementation(async () => {
      callOrder.push("chatContext");
      return { chatId: "chat-1", title: "t", topic: null, description: null, participants: [] };
    });
    declaredSourceRepos.mockImplementation((workspace: string) => {
      callOrder.push("sourceRepos");
      return [{ absolutePath: join(workspace, "source-repos", "widget"), url: "https://example.test/widget" }];
    });
    reconcileManagedSkillsForConfig.mockImplementation(async () => {
      callOrder.push("skills");
      return {
        ok: true,
        resourceConfigVersion: 3,
        installed: [],
        skipped: [],
        removed: [],
        teamSkills: [
          {
            key: "resource:skill",
            name: "team-skill",
            requestedSlug: "team-skill",
            description: "desc",
            revision: "r1",
            installedDigest: "sha256:abc",
            target: "/tmp/skill-target",
          },
        ],
        teamSkillCommands: [{ requestedSlug: "team-skill", resourceId: "skill", effectiveName: "team-skill" }],
        failures: [],
        staleTeamSnapshot: false,
      };
    });
    buildAgentBriefing.mockImplementation((opts: { teamSkills: Array<{ name: string; target: string }> }) => {
      callOrder.push("briefing");
      expect(opts.teamSkills[0]?.name).toBe("team-skill");
      expect(opts.teamSkills[0]?.target).toBe("/tmp/skill-target");
      return "BRIEFING_BODY";
    });
    ensureAgentBootstrap.mockImplementation(() => {
      callOrder.push("bootstrap");
    });
    markWorkspaceInitComplete.mockImplementation(() => {
      callOrder.push("sentinel");
    });
    currentSourceRepoNamesFromPayload.mockImplementation((_payload: unknown, resolved: boolean) => {
      callOrder.push(resolved ? "sourceNames:set" : "sourceNames:null");
      return resolved ? new Set(["widget"]) : null;
    });
    teamSkillBundleResolverFromSdk.mockReturnValue(vi.fn());
  });

  afterEach(() => {
    rmSync(workspaceRoot, { recursive: true, force: true });
  });

  function sessionCtx(logs: string[] = []): SessionContext {
    const sendMessage = vi.fn().mockResolvedValue(undefined);
    return {
      agent: {
        agentId: "019d9a97-90b0-716b-8317-a8c0be8430d7",
        inboxId: "inbox-1",
        displayName: "prep-agent",
        type: "agent",
        visibility: "organization",
        delegateMention: null,
        metadata: {},
      },
      sdk: {
        serverUrl: "https://first-tree.example.test",
        sendMessage,
      } as unknown as SessionContext["sdk"],
      chatId: "chat-1",
      log: (message: string) => {
        logs.push(message);
      },
      recordProviderActivity: () => {},
      emitEvent: () => {},
      ...mockCtxPlumbing({ sendMessage }, "chat-1"),
    } as SessionContext;
  }

  async function loadPrepare() {
    const mod = await import("../runtime/provider-support/preparation.js");
    return mod.prepareManagedSession;
  }

  it("forwards external mode to the projection instead of collapsing it to remote", async () => {
    // External mode is driven by `context_tree.repository` in client.yaml, and
    // `resolveAgentContextSource` reads it through FIRST_TREE_HOME. Point that at
    // a scratch home so the real resolution path runs.
    const configHome = mkdtempSync(join(tmpdir(), "prepare-external-home-"));
    mkdirSync(join(configHome, "config"), { recursive: true });
    writeFileSync(
      join(configHome, "config", "client.yaml"),
      "server:\n  url: http://localhost:8000\ncontext_tree:\n  repository: acme/context\n",
      "utf8",
    );
    const previousHome = process.env.FIRST_TREE_HOME;
    process.env.FIRST_TREE_HOME = configHome;

    try {
      await runExternalModePreparation();
    } finally {
      if (previousHome === undefined) delete process.env.FIRST_TREE_HOME;
      else process.env.FIRST_TREE_HOME = previousHome;
    }
  });

  async function runExternalModePreparation(): Promise<void> {
    const prepareManagedSession = await loadPrepare();
    const payload = {
      kind: "cursor" as const,
      prompt: { append: "" },
      model: "",
      mcpServers: [],
      env: [],
      gitRepos: [],
      resourceSkills: [],
    };

    await prepareManagedSession({
      sessionCtx: sessionCtx(),
      workspaceRoot,
      agentName: "prep-agent",
      runtimeProvider: "cursor",
      providerSkillRoots: TEST_PROVIDER_SKILL_ROOTS,
      runtimeConfig: null,
      payload,
      payloadResolved: true,
      contextTree: { kind: "external", path: null, repoUrl: null, branch: null, repository: "acme/context" },
    });

    // Regression guard: the projection used to receive `remote` for anything that
    // was not `local`. That would project `first-tree-read` / `first-tree-write`
    // and then fail the admission proof, which expects them gone in this mode.
    const kinds = reconcileManagedSkillsForConfig.mock.calls.map((call) => call[6]);
    expect(kinds).toContain("external");
    expect(kinds).not.toContain("remote");

    // And the superseded Skills are absent from the projected skill root.
    const skillRoot = join(workspaceRoot, TEST_PROVIDER_SKILL_ROOTS.cursor);
    for (const superseded of ["first-tree-read", "first-tree-write"]) {
      expect(existsSync(join(skillRoot, superseded))).toBe(false);
    }

    // External mode owns no workspace tree, so no manifest names one.
    expect(existsSync(join(workspaceRoot, ".first-tree", "workspace.json"))).toBe(false);
  }

  it("runs the admission sequence in order and returns stable consumer values", async () => {
    const prepareManagedSession = await loadPrepare();
    const payload = {
      kind: "cursor" as const,
      prompt: { append: "" },
      model: "",
      mcpServers: [],
      env: [],
      gitRepos: [{ url: "https://example.test/widget", localPath: "widget" }],
      resourceSkills: [],
    };
    const runtimeConfig = {
      agentId: "019d9a97-90b0-716b-8317-a8c0be8430d7",
      version: 3,
      payload,
      updatedAt: new Date().toISOString(),
      updatedBy: "test",
    };

    const ctx = sessionCtx();
    (ctx.sdk as unknown as { getAgentContextTreeConfig: ReturnType<typeof vi.fn> }).getAgentContextTreeConfig = vi.fn(
      async () => ({
        bindingState: "bound",
        repo: "https://example.test/tree",
        branch: "main",
        provider: null,
      }),
    );
    const result = await prepareManagedSession({
      sessionCtx: ctx,
      workspaceRoot,
      agentName: "prep-agent",
      runtimeProvider: "cursor",
      providerSkillRoots: TEST_PROVIDER_SKILL_ROOTS,
      runtimeConfig: runtimeConfig as never,
      payload,
      payloadResolved: true,
      contextTree: {
        path: join(workspaceRoot, "context-tree"),
        repoUrl: "https://example.test/tree",
        branch: "main",
      },
    });

    expect(callOrder).toEqual([
      "acquire",
      "chatContext",
      "sourceRepos",
      "skills",
      "briefing",
      "sourceNames:set",
      "bootstrap",
      "sentinel",
    ]);
    expect(result.workspace).toBe(workspaceRoot);
    expect(result.briefing).toBe("BRIEFING_BODY");
    expect(result.chatContext).toEqual({
      chatId: "chat-1",
      title: "t",
      topic: null,
      description: null,
      participants: [],
    });
    expect(result.sourceRepos).toEqual([
      { absolutePath: join(workspaceRoot, "source-repos", "widget"), url: "https://example.test/widget" },
    ]);
    expect(result.teamSkills).toEqual([
      {
        key: "resource:skill",
        name: "team-skill",
        requestedSlug: "team-skill",
        description: "desc",
        revision: "r1",
        installedDigest: "sha256:abc",
        target: "/tmp/skill-target",
      },
    ]);
    expect(result.resourceConfigVersion).toBe(3);
    expect(ensureAgentBootstrap).toHaveBeenCalledTimes(1);
    expect(markWorkspaceInitComplete).toHaveBeenCalledTimes(1);
    expect(markWorkspaceInitComplete).toHaveBeenCalledWith(workspaceRoot);
    expect(teamSkillBundleResolverFromSdk).toHaveBeenCalledTimes(1);
    expect(buildAgentBriefing).toHaveBeenCalledWith(
      expect.objectContaining({
        contextTreePath: join(workspaceRoot, "context-tree"),
        contextTreeRepoUrl: "https://example.test/tree",
        contextTreeBranch: "main",
        teamSkills: result.teamSkills,
      }),
    );
    expect(ensureAgentBootstrap).toHaveBeenCalledWith(
      expect.objectContaining({
        workspace: workspaceRoot,
        briefing: "BRIEFING_BODY",
        contextTreePath: join(workspaceRoot, "context-tree"),
        currentSourceRepoNames: expect.any(Set),
      }),
    );
    expect(INIT_COMPLETE_SENTINEL_REL).toMatch(/init-complete/);
  });

  it("publishes the reconciled Team Skill command registry to the session context before briefing", async () => {
    const prepareManagedSession = await loadPrepare();
    const payload = {
      kind: "cursor" as const,
      prompt: { append: "" },
      model: "",
      mcpServers: [],
      env: [],
      gitRepos: [],
      resourceSkills: [],
    };
    const runtimeConfig = {
      agentId: "019d9a97-90b0-716b-8317-a8c0be8430d7",
      version: 3,
      payload,
      updatedAt: new Date().toISOString(),
      updatedBy: "test",
    };
    reconcileManagedSkillsForConfig.mockImplementation(async () => {
      callOrder.push("skills");
      return {
        ok: true,
        resourceConfigVersion: 3,
        installed: [],
        skipped: [],
        removed: [],
        teamSkills: [
          {
            key: "resource:skill",
            name: "team-skill-first-tree",
            requestedSlug: "team-skill",
            description: "desc",
            revision: "r1",
            installedDigest: "sha256:abc",
            target: "/tmp/skill-target",
          },
        ],
        teamSkillCommands: [
          { requestedSlug: "team-skill", resourceId: "skill", effectiveName: "team-skill-first-tree" },
        ],
        failures: [],
        staleTeamSnapshot: false,
      };
    });

    const ctx = sessionCtx();
    (ctx.sdk as unknown as { getAgentContextTreeConfig: ReturnType<typeof vi.fn> }).getAgentContextTreeConfig = vi.fn(
      async () => ({
        bindingState: "bound",
        repo: "https://example.test/tree",
        branch: "main",
        provider: null,
      }),
    );
    // The shared beforeEach briefing stub asserts the default skill name;
    // this test reconciles a suffixed name instead.
    buildAgentBriefing.mockImplementation(() => {
      callOrder.push("briefing");
      return "BRIEFING_BODY";
    });
    const publishTeamSkillCommands = vi.fn();
    ctx.publishTeamSkillCommands = publishTeamSkillCommands;
    await prepareManagedSession({
      sessionCtx: ctx,
      workspaceRoot,
      agentName: "prep-agent",
      runtimeProvider: "cursor",
      providerSkillRoots: TEST_PROVIDER_SKILL_ROOTS,
      runtimeConfig: runtimeConfig as never,
      payload,
      payloadResolved: true,
      contextTree: {
        path: join(workspaceRoot, "context-tree"),
        repoUrl: "https://example.test/tree",
        branch: "main",
      },
    });

    // The publish carries the complete command registry input (base slug →
    // verified effective name) and lands before the briefing/build steps so
    // no provider turn can format user input with a stale registry.
    expect(publishTeamSkillCommands).toHaveBeenCalledTimes(1);
    expect(publishTeamSkillCommands).toHaveBeenCalledWith(
      [{ requestedSlug: "team-skill", resourceId: "skill", effectiveName: "team-skill-first-tree" }],
      3,
    );
    expect(callOrder.indexOf("skills")).toBeLessThan(callOrder.indexOf("briefing"));
  });

  it("publishes the verified ledger registry when reconcile returns no authoritative commands", async () => {
    const prepareManagedSession = await loadPrepare();
    reconcileManagedSkillsForConfig.mockImplementation(async () => {
      callOrder.push("skills");
      return {
        ok: false,
        resourceConfigVersion: 0,
        installed: [],
        skipped: [],
        removed: [],
        teamSkills: [],
        teamSkillCommands: null,
        failures: [{ key: "workspace", reason: "clean top-level failure" }],
        staleTeamSnapshot: false,
      };
    });
    const { verifyManagedSkillsProjectionForAdmission } = (await import("../runtime/managed-skills.js")) as unknown as {
      verifyManagedSkillsProjectionForAdmission: ReturnType<typeof vi.fn>;
    };
    verifyManagedSkillsProjectionForAdmission.mockImplementation(async () => ({
      resourceConfigVersion: 7,
      teamSkills: [
        {
          key: "resource:skill",
          name: "team-skill-first-tree",
          requestedSlug: "team-skill",
          description: "desc",
          revision: "r1",
          installedDigest: "sha256:abc",
          target: "/tmp/skill-target",
        },
      ],
    }));

    buildAgentBriefing.mockImplementation(() => {
      callOrder.push("briefing");
      return "BRIEFING_BODY";
    });
    const ctx = sessionCtx();
    const publishTeamSkillCommands = vi.fn();
    ctx.publishTeamSkillCommands = publishTeamSkillCommands;
    await prepareManagedSession({
      sessionCtx: ctx,
      workspaceRoot,
      agentName: "prep-agent",
      runtimeProvider: "cursor",
      providerSkillRoots: TEST_PROVIDER_SKILL_ROOTS,
      runtimeConfig: null,
      payload: {
        kind: "cursor" as const,
        prompt: { append: "" },
        model: "",
        mcpServers: [],
        env: [],
        gitRepos: [],
        resourceSkills: [],
      },
      payloadResolved: false,
      contextTree: { path: null, repoUrl: null, branch: null },
    });

    expect(publishTeamSkillCommands).toHaveBeenCalledWith(
      [{ requestedSlug: "team-skill", resourceId: "skill", effectiveName: "team-skill-first-tree" }],
      7,
    );
  });

  it("marks configured Team commands unavailable when neither reconcile nor the ledger can prove identities", async () => {
    const prepareManagedSession = await loadPrepare();
    reconcileManagedSkillsForConfig.mockImplementation(async () => {
      callOrder.push("skills");
      return {
        ok: false,
        resourceConfigVersion: 0,
        installed: [],
        skipped: [],
        removed: [],
        teamSkills: [],
        teamSkillCommands: null,
        failures: [{ key: "workspace", reason: "clean top-level failure" }],
        staleTeamSnapshot: false,
      };
    });
    const { verifyManagedSkillsProjectionForAdmission } = (await import("../runtime/managed-skills.js")) as unknown as {
      verifyManagedSkillsProjectionForAdmission: ReturnType<typeof vi.fn>;
    };
    verifyManagedSkillsProjectionForAdmission.mockImplementation(async () => null);

    const payload = {
      kind: "cursor" as const,
      prompt: { append: "" },
      model: "",
      mcpServers: [],
      env: [],
      gitRepos: [],
      resourceSkills: [
        {
          resourceId: "res-1",
          name: "Team Review",
          description: "d",
          body: "b",
          metadata: {},
        },
      ],
    };
    const runtimeConfig = {
      agentId: "019d9a97-90b0-716b-8317-a8c0be8430d7",
      version: 3,
      payload,
      updatedAt: new Date().toISOString(),
      updatedBy: "test",
    };
    buildAgentBriefing.mockImplementation(() => {
      callOrder.push("briefing");
      return "BRIEFING_BODY";
    });
    const ctx = sessionCtx();
    const publishTeamSkillCommands = vi.fn();
    ctx.publishTeamSkillCommands = publishTeamSkillCommands;
    await prepareManagedSession({
      sessionCtx: ctx,
      workspaceRoot,
      agentName: "prep-agent",
      runtimeProvider: "cursor",
      providerSkillRoots: TEST_PROVIDER_SKILL_ROOTS,
      runtimeConfig: runtimeConfig as never,
      payload,
      payloadResolved: true,
      contextTree: { path: null, repoUrl: null, branch: null },
    });

    expect(publishTeamSkillCommands).toHaveBeenCalledWith(
      [{ requestedSlug: "team-review", resourceId: "res-1", effectiveName: null }],
      3,
    );
  });

  it("prefers the current config over a verified older ledger when reconcile has no authoritative registry", async () => {
    const prepareManagedSession = await loadPrepare();
    reconcileManagedSkillsForConfig.mockImplementation(async () => ({
      ok: false,
      resourceConfigVersion: 0,
      installed: [],
      skipped: [],
      removed: [],
      teamSkills: [],
      teamSkillCommands: null,
      failures: [{ key: "workspace", reason: "clean top-level failure" }],
      staleTeamSnapshot: false,
    }));
    const { verifyManagedSkillsProjectionForAdmission } = (await import("../runtime/managed-skills.js")) as unknown as {
      verifyManagedSkillsProjectionForAdmission: ReturnType<typeof vi.fn>;
    };
    // The ledger verifies, but only covers the OLD config (`audit`). The
    // current config added `review` — the ledger must NOT stand in for it.
    verifyManagedSkillsProjectionForAdmission.mockImplementation(async () => ({
      resourceConfigVersion: 1,
      teamSkills: [
        {
          key: "resource:audit",
          name: "audit",
          requestedSlug: "audit",
          description: "d",
          revision: "r1",
          installedDigest: "sha256:abc",
          target: "/tmp/audit",
        },
      ],
    }));

    const payload = {
      kind: "cursor" as const,
      prompt: { append: "" },
      model: "",
      mcpServers: [],
      env: [],
      gitRepos: [],
      resourceSkills: [
        { resourceId: "res-audit", name: "audit", description: "d", body: "b", metadata: {} },
        { resourceId: "res-review", name: "review", description: "d", body: "b", metadata: {} },
      ],
    };
    const runtimeConfig = {
      agentId: "019d9a97-90b0-716b-8317-a8c0be8430d7",
      version: 2,
      payload,
      updatedAt: new Date().toISOString(),
      updatedBy: "test",
    };
    buildAgentBriefing.mockImplementation(() => {
      callOrder.push("briefing");
      return "BRIEFING_BODY";
    });
    const ctx = sessionCtx();
    const publishTeamSkillCommands = vi.fn();
    ctx.publishTeamSkillCommands = publishTeamSkillCommands;
    await prepareManagedSession({
      sessionCtx: ctx,
      workspaceRoot,
      agentName: "prep-agent",
      runtimeProvider: "cursor",
      providerSkillRoots: TEST_PROVIDER_SKILL_ROOTS,
      runtimeConfig: runtimeConfig as never,
      payload,
      payloadResolved: true,
      contextTree: { path: null, repoUrl: null, branch: null },
    });

    // BOTH current-config bases fail closed — the newer `review` must not
    // pass through as an "unknown local command", and the older `audit`
    // does not ride the stale ledger either. The ledger is never consulted
    // once a resolved runtime config exists.
    expect(verifyManagedSkillsProjectionForAdmission).not.toHaveBeenCalled();
    expect(publishTeamSkillCommands).toHaveBeenCalledWith(
      [
        { requestedSlug: "audit", resourceId: "res-audit", effectiveName: null },
        { requestedSlug: "review", resourceId: "res-review", effectiveName: null },
      ],
      2,
    );
  });

  it("publishes unknown (null) when the current config's Team rows have no valid slug", async () => {
    const prepareManagedSession = await loadPrepare();
    reconcileManagedSkillsForConfig.mockImplementation(async () => ({
      ok: false,
      resourceConfigVersion: 0,
      installed: [],
      skipped: [],
      removed: [],
      teamSkills: [],
      teamSkillCommands: null,
      failures: [{ key: "workspace", reason: "clean top-level failure" }],
      staleTeamSnapshot: false,
    }));
    const { verifyManagedSkillsProjectionForAdmission } = (await import("../runtime/managed-skills.js")) as unknown as {
      verifyManagedSkillsProjectionForAdmission: ReturnType<typeof vi.fn>;
    };
    verifyManagedSkillsProjectionForAdmission.mockImplementation(async () => ({
      resourceConfigVersion: 1,
      teamSkills: [
        {
          key: "resource:audit",
          name: "audit",
          requestedSlug: "audit",
          description: "d",
          revision: "r1",
          installedDigest: "sha256:abc",
          target: "/tmp/audit",
        },
      ],
    }));

    const payload = {
      kind: "cursor" as const,
      prompt: { append: "" },
      model: "",
      mcpServers: [],
      env: [],
      gitRepos: [],
      // A Team Skill whose name yields no portable slug has no typable
      // command — the registry must stay UNKNOWN, not verified-empty.
      resourceSkills: [{ resourceId: "res-1", name: "!!!", description: "d", body: "b", metadata: {} }],
    };
    const runtimeConfig = {
      agentId: "019d9a97-90b0-716b-8317-a8c0be8430d7",
      version: 2,
      payload,
      updatedAt: new Date().toISOString(),
      updatedBy: "test",
    };
    buildAgentBriefing.mockImplementation(() => {
      callOrder.push("briefing");
      return "BRIEFING_BODY";
    });
    const ctx = sessionCtx();
    const publishTeamSkillCommands = vi.fn();
    ctx.publishTeamSkillCommands = publishTeamSkillCommands;
    await prepareManagedSession({
      sessionCtx: ctx,
      workspaceRoot,
      agentName: "prep-agent",
      runtimeProvider: "cursor",
      providerSkillRoots: TEST_PROVIDER_SKILL_ROOTS,
      runtimeConfig: runtimeConfig as never,
      payload,
      payloadResolved: true,
      contextTree: { path: null, repoUrl: null, branch: null },
    });

    expect(verifyManagedSkillsProjectionForAdmission).not.toHaveBeenCalled();
    expect(publishTeamSkillCommands).toHaveBeenCalledWith(null, null);
  });

  it("uses the verified newer ledger for a stale snapshot instead of publishing the old config's aliases", async () => {
    const prepareManagedSession = await loadPrepare();
    // Cache fell back to the OLDER config v1 while the ledger is already
    // v2 — reconcile reports the snapshot as stale and publishes nothing.
    reconcileManagedSkillsForConfig.mockImplementation(async () => ({
      ok: true,
      resourceConfigVersion: 2,
      installed: [],
      skipped: [],
      removed: [],
      teamSkills: [],
      teamSkillCommands: null,
      failures: [],
      staleTeamSnapshot: true,
    }));
    const { verifyManagedSkillsProjectionForAdmission } = (await import("../runtime/managed-skills.js")) as unknown as {
      verifyManagedSkillsProjectionForAdmission: ReturnType<typeof vi.fn>;
    };
    verifyManagedSkillsProjectionForAdmission.mockImplementation(async () => ({
      resourceConfigVersion: 2,
      teamSkills: [
        {
          key: "resource:review",
          name: "review-first-tree",
          requestedSlug: "review",
          description: "d",
          revision: "r2",
          installedDigest: "sha256:abc",
          target: "/tmp/review-first-tree",
        },
      ],
    }));

    const payload = {
      kind: "cursor" as const,
      prompt: { append: "" },
      model: "",
      mcpServers: [],
      env: [],
      gitRepos: [],
      resourceSkills: [{ resourceId: "res-1", name: "review", description: "d", body: "b", metadata: {} }],
    };
    const runtimeConfig = {
      agentId: "019d9a97-90b0-716b-8317-a8c0be8430d7",
      version: 1,
      payload,
      updatedAt: new Date().toISOString(),
      updatedBy: "test",
    };
    buildAgentBriefing.mockImplementation(() => {
      callOrder.push("briefing");
      return "BRIEFING_BODY";
    });
    const ctx = sessionCtx();
    const publishTeamSkillCommands = vi.fn();
    ctx.publishTeamSkillCommands = publishTeamSkillCommands;
    await prepareManagedSession({
      sessionCtx: ctx,
      workspaceRoot,
      agentName: "prep-agent",
      runtimeProvider: "cursor",
      providerSkillRoots: TEST_PROVIDER_SKILL_ROOTS,
      runtimeConfig: runtimeConfig as never,
      payload,
      payloadResolved: true,
      contextTree: { path: null, repoUrl: null, branch: null },
    });

    // The verified NEWER ledger identity wins; the stale config's partial
    // alias set is never published.
    expect(publishTeamSkillCommands).toHaveBeenCalledWith(
      [{ requestedSlug: "review", resourceId: "review", effectiveName: "review-first-tree" }],
      2,
    );
  });

  it("continues when chat context fetch fails and logs the failure", async () => {
    const prepareManagedSession = await loadPrepare();
    const logs: string[] = [];
    fetchChatContext.mockImplementation(async () => {
      callOrder.push("chatContext");
      throw new Error("chat detail unavailable");
    });

    const result = await prepareManagedSession({
      sessionCtx: sessionCtx(logs),
      workspaceRoot,
      agentName: "prep-agent",
      runtimeProvider: "cursor",
      providerSkillRoots: TEST_PROVIDER_SKILL_ROOTS,
      runtimeConfig: null,
      payload: {
        kind: "cursor",
        prompt: { append: "" },
        model: "",
        mcpServers: [],
        env: [],
        gitRepos: [],
        resourceSkills: [],
      },
      payloadResolved: false,
      contextTree: { path: null, repoUrl: null, branch: null },
    });

    expect(result.chatContext).toBeUndefined();
    expect(logs.some((line) => line.includes("fetchChatContext failed"))).toBe(true);
    expect(callOrder).toEqual([
      "acquire",
      "chatContext",
      "sourceRepos",
      "skills",
      "briefing",
      "sourceNames:null",
      "bootstrap",
      "sentinel",
    ]);
  });

  it("stops before sentinel when Managed Skills reconcile throws", async () => {
    const prepareManagedSession = await loadPrepare();
    reconcileManagedSkillsForConfig.mockImplementation(async () => {
      callOrder.push("skills");
      throw new Error("managed skills unsafe");
    });

    await expect(
      prepareManagedSession({
        sessionCtx: sessionCtx(),
        workspaceRoot,
        agentName: "prep-agent",
        runtimeProvider: "cursor",
        providerSkillRoots: TEST_PROVIDER_SKILL_ROOTS,
        runtimeConfig: null,
        payload: {
          kind: "cursor",
          prompt: { append: "" },
          model: "",
          mcpServers: [],
          env: [],
          gitRepos: [],
          resourceSkills: [],
        },
        payloadResolved: false,
        contextTree: { path: null, repoUrl: null, branch: null },
      }),
    ).rejects.toThrow(/managed skills unsafe/);

    expect(callOrder).toEqual(["acquire", "chatContext", "sourceRepos", "skills"]);
    expect(ensureAgentBootstrap).not.toHaveBeenCalled();
    expect(markWorkspaceInitComplete).not.toHaveBeenCalled();
  });

  it("stops before sentinel when bootstrap throws", async () => {
    const prepareManagedSession = await loadPrepare();
    ensureAgentBootstrap.mockImplementation(() => {
      callOrder.push("bootstrap");
      throw new Error("bootstrap failed");
    });

    await expect(
      prepareManagedSession({
        sessionCtx: sessionCtx(),
        workspaceRoot,
        agentName: "prep-agent",
        runtimeProvider: "grok",
        providerSkillRoots: TEST_PROVIDER_SKILL_ROOTS,
        runtimeConfig: null,
        payload: {
          kind: "grok",
          prompt: { append: "" },
          model: "",
          reasoningEffort: "",
          mcpServers: [],
          env: [],
          gitRepos: [],
          resourceSkills: [],
        },
        payloadResolved: false,
        contextTree: { path: null, repoUrl: null, branch: null },
      }),
    ).rejects.toThrow(/bootstrap failed/);

    expect(callOrder).toContain("bootstrap");
    expect(markWorkspaceInitComplete).not.toHaveBeenCalled();
  });

  it("passes null source-name set for unresolved fallback payloads", async () => {
    const prepareManagedSession = await loadPrepare();
    await prepareManagedSession({
      sessionCtx: sessionCtx(),
      workspaceRoot,
      agentName: "prep-agent",
      runtimeProvider: "cursor",
      providerSkillRoots: TEST_PROVIDER_SKILL_ROOTS,
      runtimeConfig: null,
      payload: {
        kind: "cursor",
        prompt: { append: "" },
        model: "",
        mcpServers: [],
        env: [],
        gitRepos: [],
        resourceSkills: [],
      },
      payloadResolved: false,
      contextTree: { path: null, repoUrl: null, branch: null },
    });

    expect(currentSourceRepoNamesFromPayload).toHaveBeenCalledWith(expect.anything(), false);
    expect(ensureAgentBootstrap).toHaveBeenCalledWith(expect.objectContaining({ currentSourceRepoNames: null }));
  });

  it("does not double-call bootstrap or sentinel on success", async () => {
    const prepareManagedSession = await loadPrepare();
    await prepareManagedSession({
      sessionCtx: sessionCtx(),
      workspaceRoot,
      agentName: "prep-agent",
      runtimeProvider: "cursor",
      providerSkillRoots: TEST_PROVIDER_SKILL_ROOTS,
      runtimeConfig: null,
      payload: {
        kind: "cursor",
        prompt: { append: "" },
        model: "",
        mcpServers: [],
        env: [],
        gitRepos: [],
        resourceSkills: [],
      },
      payloadResolved: true,
      contextTree: { path: null, repoUrl: null, branch: null },
    });
    expect(ensureAgentBootstrap).toHaveBeenCalledTimes(1);
    expect(markWorkspaceInitComplete).toHaveBeenCalledTimes(1);
  });

  it("runs atProjectionEntry sync before skills projection", async () => {
    const prepareManagedSession = await loadPrepare();
    const atProjectionEntry = vi.fn((): undefined => {
      callOrder.push("atProjectionEntry");
      return undefined;
    });
    const beforeBriefing = vi.fn(async () => {
      callOrder.push("beforeBriefing");
    });

    await prepareManagedSession({
      sessionCtx: sessionCtx(),
      workspaceRoot,
      agentName: "prep-agent",
      runtimeProvider: "cursor",
      providerSkillRoots: TEST_PROVIDER_SKILL_ROOTS,
      runtimeConfig: null,
      payload: {
        kind: "cursor",
        prompt: { append: "" },
        model: "",
        mcpServers: [],
        env: [],
        gitRepos: [],
        resourceSkills: [],
      },
      payloadResolved: false,
      contextTree: { path: null, repoUrl: null, branch: null },
      atProjectionEntry,
      beforeBriefing,
    });

    expect(atProjectionEntry).toHaveBeenCalledTimes(2);
    expect(beforeBriefing).toHaveBeenCalledTimes(1);
    expect(callOrder).toEqual([
      "acquire",
      "chatContext",
      "atProjectionEntry",
      "atProjectionEntry",
      "sourceRepos",
      "skills",
      "beforeBriefing",
      "briefing",
      "sourceNames:null",
      "bootstrap",
      "sentinel",
    ]);
  });

  it("rejects async atProjectionEntry at compile time", () => {
    // @ts-expect-error async callbacks are not assignable to () => undefined
    const _hook: PrepareManagedSessionParams["atProjectionEntry"] = async () => undefined;
    void _hook;
  });

  it("rejects thenable atProjectionEntry before reconcile (fail-closed sync contract)", async () => {
    const prepareManagedSession = await loadPrepare();

    await expect(
      prepareManagedSession({
        sessionCtx: sessionCtx(),
        workspaceRoot,
        agentName: "prep-agent",
        runtimeProvider: "cursor",
        providerSkillRoots: TEST_PROVIDER_SKILL_ROOTS,
        runtimeConfig: null,
        payload: {
          kind: "cursor",
          prompt: { append: "" },
          model: "",
          mcpServers: [],
          env: [],
          gitRepos: [],
          resourceSkills: [],
        },
        payloadResolved: false,
        contextTree: { path: null, repoUrl: null, branch: null },
        // Type escape: async is assignable to `() => void` but not `() => undefined`.
        // Cast to prove runtime still fail-closes if a thenable slips through.
        atProjectionEntry: (async () => {
          callOrder.push("atProjectionEntry");
        }) as unknown as () => undefined,
      }),
    ).rejects.toThrow(/atProjectionEntry must be synchronous/);

    expect(callOrder).toEqual(["acquire", "chatContext", "atProjectionEntry"]);
    expect(declaredSourceRepos).not.toHaveBeenCalled();
    expect(reconcileManagedSkillsForConfig).not.toHaveBeenCalled();
  });

  it("rejects non-undefined atProjectionEntry returns before reconcile", async () => {
    const prepareManagedSession = await loadPrepare();

    await expect(
      prepareManagedSession({
        sessionCtx: sessionCtx(),
        workspaceRoot,
        agentName: "prep-agent",
        runtimeProvider: "cursor",
        providerSkillRoots: TEST_PROVIDER_SKILL_ROOTS,
        runtimeConfig: null,
        payload: {
          kind: "cursor",
          prompt: { append: "" },
          model: "",
          mcpServers: [],
          env: [],
          gitRepos: [],
          resourceSkills: [],
        },
        payloadResolved: false,
        contextTree: { path: null, repoUrl: null, branch: null },
        atProjectionEntry: (() => {
          callOrder.push("atProjectionEntry");
          return null;
        }) as unknown as () => undefined,
      }),
    ).rejects.toThrow(/atProjectionEntry must be synchronous/);

    expect(reconcileManagedSkillsForConfig).not.toHaveBeenCalled();
  });

  it("enters reconcile in the same synchronous turn as the in-lock atProjectionEntry", async () => {
    const prepareManagedSession = await loadPrepare();
    let microtaskRan = false;
    let projectionEntryCount = 0;

    reconcileManagedSkillsForConfig.mockImplementation(async () => {
      expect(microtaskRan).toBe(false);
      callOrder.push("skills");
      return {
        ok: true,
        resourceConfigVersion: 3,
        installed: [],
        skipped: [],
        removed: [],
        teamSkills: [
          {
            key: "resource:skill",
            name: "team-skill",
            requestedSlug: "team-skill",
            description: "desc",
            revision: "r1",
            installedDigest: "sha256:abc",
            target: "/tmp/skill-target",
          },
        ],
        teamSkillCommands: [{ requestedSlug: "team-skill", resourceId: "skill", effectiveName: "team-skill" }],
        failures: [],
        staleTeamSnapshot: false,
      };
    });

    await prepareManagedSession({
      sessionCtx: sessionCtx(),
      workspaceRoot,
      agentName: "prep-agent",
      runtimeProvider: "cursor",
      providerSkillRoots: TEST_PROVIDER_SKILL_ROOTS,
      runtimeConfig: null,
      payload: {
        kind: "cursor",
        prompt: { append: "" },
        model: "",
        mcpServers: [],
        env: [],
        gitRepos: [],
        resourceSkills: [],
      },
      payloadResolved: false,
      contextTree: { path: null, repoUrl: null, branch: null },
      atProjectionEntry: (): undefined => {
        projectionEntryCount += 1;
        if (projectionEntryCount === 2) {
          queueMicrotask(() => {
            microtaskRan = true;
          });
        }
        return undefined;
      },
    });

    expect(projectionEntryCount).toBe(2);
    expect(reconcileManagedSkillsForConfig).toHaveBeenCalled();
    await Promise.resolve();
    expect(microtaskRan).toBe(true);
  });

  it("completes briefing/bootstrap/sentinel before sync beforeBriefing microtasks", async () => {
    const prepareManagedSession = await loadPrepare();
    let microtaskRan = false;
    const events: string[] = [];

    buildAgentBriefing.mockImplementation((opts: { teamSkills: Array<{ name: string; target: string }> }) => {
      expect(microtaskRan).toBe(false);
      events.push("briefing");
      callOrder.push("briefing");
      expect(opts.teamSkills[0]?.name).toBe("team-skill");
      return "BRIEFING_BODY";
    });
    ensureAgentBootstrap.mockImplementation(() => {
      expect(microtaskRan).toBe(false);
      events.push("bootstrap");
      callOrder.push("bootstrap");
    });
    markWorkspaceInitComplete.mockImplementation(() => {
      expect(microtaskRan).toBe(false);
      events.push("sentinel");
      callOrder.push("sentinel");
    });

    await prepareManagedSession({
      sessionCtx: sessionCtx(),
      workspaceRoot,
      agentName: "prep-agent",
      runtimeProvider: "cursor",
      providerSkillRoots: TEST_PROVIDER_SKILL_ROOTS,
      runtimeConfig: null,
      payload: {
        kind: "cursor",
        prompt: { append: "" },
        model: "",
        mcpServers: [],
        env: [],
        gitRepos: [],
        resourceSkills: [],
      },
      payloadResolved: false,
      contextTree: { path: null, repoUrl: null, branch: null },
      beforeBriefing: () => {
        events.push("beforeBriefing");
        callOrder.push("beforeBriefing");
        queueMicrotask(() => {
          microtaskRan = true;
        });
      },
    });

    expect(events).toEqual(["beforeBriefing", "briefing", "bootstrap", "sentinel"]);
    await Promise.resolve();
    expect(microtaskRan).toBe(true);
  });

  it("awaits async beforeBriefing before briefing/bootstrap/sentinel", async () => {
    const prepareManagedSession = await loadPrepare();

    await prepareManagedSession({
      sessionCtx: sessionCtx(),
      workspaceRoot,
      agentName: "prep-agent",
      runtimeProvider: "cursor",
      providerSkillRoots: TEST_PROVIDER_SKILL_ROOTS,
      runtimeConfig: null,
      payload: {
        kind: "cursor",
        prompt: { append: "" },
        model: "",
        mcpServers: [],
        env: [],
        gitRepos: [],
        resourceSkills: [],
      },
      payloadResolved: false,
      contextTree: { path: null, repoUrl: null, branch: null },
      beforeBriefing: async () => {
        callOrder.push("beforeBriefing-start");
        await Promise.resolve();
        callOrder.push("beforeBriefing-end");
      },
    });

    expect(callOrder).toEqual([
      "acquire",
      "chatContext",
      "sourceRepos",
      "skills",
      "beforeBriefing-start",
      "beforeBriefing-end",
      "briefing",
      "sourceNames:null",
      "bootstrap",
      "sentinel",
    ]);
  });

  it("leaves skills/briefing/bootstrap/sentinel untouched when atProjectionEntry throws", async () => {
    const prepareManagedSession = await loadPrepare();

    await expect(
      prepareManagedSession({
        sessionCtx: sessionCtx(),
        workspaceRoot,
        agentName: "prep-agent",
        runtimeProvider: "cursor",
        providerSkillRoots: TEST_PROVIDER_SKILL_ROOTS,
        runtimeConfig: null,
        payload: {
          kind: "cursor",
          prompt: { append: "" },
          model: "",
          mcpServers: [],
          env: [],
          gitRepos: [],
          resourceSkills: [],
        },
        payloadResolved: false,
        contextTree: { path: null, repoUrl: null, branch: null },
        atProjectionEntry: (): undefined => {
          callOrder.push("atProjectionEntry");
          throw new Error("lifecycle cancelled at prepare_before_projection");
        },
      }),
    ).rejects.toThrow(/lifecycle cancelled at prepare_before_projection/);

    expect(callOrder).toEqual(["acquire", "chatContext", "atProjectionEntry"]);
    expect(declaredSourceRepos).not.toHaveBeenCalled();
    expect(reconcileManagedSkillsForConfig).not.toHaveBeenCalled();
    expect(buildAgentBriefing).not.toHaveBeenCalled();
    expect(ensureAgentBootstrap).not.toHaveBeenCalled();
    expect(markWorkspaceInitComplete).not.toHaveBeenCalled();
  });

  it("runs beforeBriefing after skills and before briefing/bootstrap/sentinel", async () => {
    const prepareManagedSession = await loadPrepare();
    const beforeBriefing = vi.fn(async () => {
      callOrder.push("beforeBriefing");
    });

    await prepareManagedSession({
      sessionCtx: sessionCtx(),
      workspaceRoot,
      agentName: "prep-agent",
      runtimeProvider: "cursor",
      providerSkillRoots: TEST_PROVIDER_SKILL_ROOTS,
      runtimeConfig: null,
      payload: {
        kind: "cursor",
        prompt: { append: "" },
        model: "",
        mcpServers: [],
        env: [],
        gitRepos: [],
        resourceSkills: [],
      },
      payloadResolved: false,
      contextTree: { path: null, repoUrl: null, branch: null },
      beforeBriefing,
    });

    expect(beforeBriefing).toHaveBeenCalledTimes(1);
    expect(callOrder).toEqual([
      "acquire",
      "chatContext",
      "sourceRepos",
      "skills",
      "beforeBriefing",
      "briefing",
      "sourceNames:null",
      "bootstrap",
      "sentinel",
    ]);
  });

  it("leaves briefing/bootstrap/sentinel untouched when beforeBriefing throws", async () => {
    const prepareManagedSession = await loadPrepare();

    await expect(
      prepareManagedSession({
        sessionCtx: sessionCtx(),
        workspaceRoot,
        agentName: "prep-agent",
        runtimeProvider: "cursor",
        providerSkillRoots: TEST_PROVIDER_SKILL_ROOTS,
        runtimeConfig: null,
        payload: {
          kind: "cursor",
          prompt: { append: "" },
          model: "",
          mcpServers: [],
          env: [],
          gitRepos: [],
          resourceSkills: [],
        },
        payloadResolved: false,
        contextTree: { path: null, repoUrl: null, branch: null },
        beforeBriefing: async () => {
          callOrder.push("beforeBriefing");
          throw new Error("lifecycle cancelled at prepare_skills");
        },
      }),
    ).rejects.toThrow(/lifecycle cancelled at prepare_skills/);

    expect(callOrder).toEqual(["acquire", "chatContext", "sourceRepos", "skills", "beforeBriefing"]);
    expect(buildAgentBriefing).not.toHaveBeenCalled();
    expect(ensureAgentBootstrap).not.toHaveBeenCalled();
    expect(markWorkspaceInitComplete).not.toHaveBeenCalled();
  });
});

describe("projectManagedWorkspace", () => {
  let workspaceRoot: string;
  const callOrder: string[] = [];

  beforeEach(() => {
    workspaceRoot = mkdtempSync(join(tmpdir(), "project-managed-workspace-"));
    callOrder.length = 0;
    vi.clearAllMocks();
    declaredSourceRepos.mockImplementation((workspace: string) => {
      callOrder.push("sourceRepos");
      return [{ absolutePath: join(workspace, "source-repos", "widget"), url: "https://example.test/widget" }];
    });
    reconcileManagedSkillsForConfig.mockImplementation(async () => {
      callOrder.push("skills");
      return {
        ok: true,
        resourceConfigVersion: 1,
        installed: [],
        skipped: [],
        removed: [],
        teamSkills: [],
        teamSkillCommands: [],
        failures: [],
        staleTeamSnapshot: false,
      };
    });
    buildAgentBriefing.mockImplementation(() => {
      callOrder.push("briefing");
      return "BRIEFING";
    });
    ensureAgentBootstrap.mockImplementation(() => {
      callOrder.push("bootstrap");
    });
    markWorkspaceInitComplete.mockImplementation(() => {
      callOrder.push("sentinel");
    });
    currentSourceRepoNamesFromPayload.mockReturnValue(null);
    teamSkillBundleResolverFromSdk.mockReturnValue(vi.fn());
  });

  afterEach(() => {
    rmSync(workspaceRoot, { recursive: true, force: true });
  });

  function sessionCtx(): SessionContext {
    const sendMessage = vi.fn().mockResolvedValue(undefined);
    return {
      agent: {
        agentId: "019d9a97-90b0-716b-8317-a8c0be8430d7",
        inboxId: "inbox-1",
        displayName: "prep-agent",
        type: "agent",
        visibility: "organization",
        delegateMention: null,
        metadata: {},
      },
      sdk: { serverUrl: "https://first-tree.example.test", sendMessage } as unknown as SessionContext["sdk"],
      chatId: "chat-1",
      log: () => {},
      recordProviderActivity: () => {},
      emitEvent: () => {},
      ...mockCtxPlumbing({ sendMessage }, "chat-1"),
    } as SessionContext;
  }

  it("requires an explicit markInitComplete:false to skip the sentinel", async () => {
    const { projectManagedWorkspace } = await import("../runtime/provider-support/preparation.js");
    await projectManagedWorkspace({
      sessionCtx: sessionCtx(),
      workspace: workspaceRoot,
      agentName: "prep-agent",
      runtimeProvider: "pi",
      providerSkillRoots: TEST_PROVIDER_SKILL_ROOTS,
      runtimeConfig: null,
      payload: {
        kind: "pi",
        prompt: { append: "" },
        model: "",
        mcpServers: [],
        env: [],
        gitRepos: [],
        resourceSkills: [],
      },
      payloadResolved: false,
      contextTree: { path: null, repoUrl: null, branch: null },
      markInitComplete: false,
    });
    expect(callOrder).toEqual(["sourceRepos", "skills", "briefing", "bootstrap"]);
    expect(markWorkspaceInitComplete).not.toHaveBeenCalled();
  });

  it("writes the sentinel when markInitComplete is true", async () => {
    const { projectManagedWorkspace } = await import("../runtime/provider-support/preparation.js");
    await projectManagedWorkspace({
      sessionCtx: sessionCtx(),
      workspace: workspaceRoot,
      agentName: "prep-agent",
      runtimeProvider: "opencode",
      providerSkillRoots: TEST_PROVIDER_SKILL_ROOTS,
      runtimeConfig: null,
      payload: {
        kind: "opencode",
        prompt: { append: "" },
        model: "",
        mcpServers: [],
        env: [],
        gitRepos: [],
        resourceSkills: [],
      },
      payloadResolved: false,
      contextTree: { path: null, repoUrl: null, branch: null },
      markInitComplete: true,
    });
    expect(callOrder).toContain("sentinel");
    expect(markWorkspaceInitComplete).toHaveBeenCalledWith(workspaceRoot);
  });
});
