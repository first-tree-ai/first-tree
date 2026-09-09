import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentRuntimeConfig, AgentRuntimeConfigPayload, RuntimeResourceSkill } from "@first-tree/shared";
import { strToU8, zipSync } from "fflate";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mockCtxPlumbing } from "../../../__tests__/test-helpers.js";
import type { ChatContext } from "../../../runtime/chat-context.js";
import type { SessionContext, SessionMessage } from "../../../runtime/handler.js";
import {
  buildTeamSkillCommandRegistry,
  rewriteSessionMessageCommand,
  type TeamSkillCommandRegistry,
} from "../../../runtime/team-skill-command-rewrite.js";

// Use the real managed reconciler instead of the default handler-test double
// installed by vitest.setup.ts.
vi.unmock("../../../runtime/managed-skills.js");

// A Team Skill bound to an agent that already has a live session only lands on
// disk if the handler reconciles it before restarting on a config bump. This
// exercises that path end-to-end against a real temp workspace.
const state = vi.hoisted(() => ({
  chatContextPromise: null as Promise<ChatContext> | null,
  resolveChatContext: null as ((value: ChatContext) => void) | null,
  observedInputs: [] as string[],
  pendingResults: [] as unknown[],
  waiters: [] as Array<() => void>,
}));

function wakeQuery(): void {
  const waiters = state.waiters.splice(0);
  for (const waiter of waiters) waiter();
}

function flattenContent(content: unknown): string {
  return typeof content === "string" ? content : JSON.stringify(content);
}

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  query: (args: { prompt: AsyncIterable<{ message: { content: unknown } }> }) => {
    let closed = false;
    void (async () => {
      for await (const sdkMsg of args.prompt) {
        state.observedInputs.push(flattenContent(sdkMsg.message.content));
        state.pendingResults.push({
          type: "result",
          subtype: "success",
          result: `reply ${state.observedInputs.length}`,
        });
        wakeQuery();
      }
      closed = true;
      wakeQuery();
    })();
    return {
      [Symbol.asyncIterator]() {
        return {
          next: async (): Promise<IteratorResult<unknown>> => {
            while (state.pendingResults.length === 0 && !closed) {
              await new Promise<void>((resolve) => state.waiters.push(resolve));
            }
            const value = state.pendingResults.shift();
            if (value) return { value, done: false };
            return { value: undefined, done: true };
          },
        };
      },
      close: () => {
        closed = true;
        wakeQuery();
      },
      setModel: async () => {},
    };
  },
}));

vi.mock("../../../runtime/agent-bootstrap.js", () => ({
  ensureAgentBootstrap: vi.fn(
    (args: {
      workspace: string;
      agentName: string;
      contextTreePath: string | null;
      contextSourceKind: string;
      briefing: string;
      sessionCtx: { agent: SessionContext["agent"]; sdk: { serverUrl: string } };
    }) => {
      const runtimeDir = join(args.workspace, ".first-tree-workspace");
      mkdirSync(runtimeDir, { recursive: true });
      writeFileSync(
        join(runtimeDir, "identity.json"),
        JSON.stringify({
          agentId: args.sessionCtx.agent.agentId,
          agentName: args.agentName,
          displayName: args.sessionCtx.agent.displayName,
          type: args.sessionCtx.agent.type,
          visibility: args.sessionCtx.agent.visibility,
          delegateMention: args.sessionCtx.agent.delegateMention,
          metadata: args.sessionCtx.agent.metadata,
          serverUrl: args.sessionCtx.sdk.serverUrl,
          contextSourceKind: args.contextSourceKind,
          contextTreePath: args.contextTreePath,
        }),
      );
      writeFileSync(join(args.workspace, "AGENTS.md"), args.briefing);
      const claudePath = join(args.workspace, "CLAUDE.md");
      rmSync(claudePath, { force: true });
      if (process.platform === "win32") writeFileSync(claudePath, args.briefing);
      else symlinkSync("AGENTS.md", claudePath);
    },
  ),
}));
vi.mock("../../../runtime/bootstrap.js", () => ({
  FIRST_TREE_RUNTIME_DIR: ".first-tree-workspace",
  FIRST_TREE_WORKSPACE_MARKER: ".first-tree-workspace",
  ensureWorkspaceRuntimeDir: vi.fn((workspacePath: string) => {
    const dir = join(workspacePath, ".first-tree-workspace");
    mkdirSync(dir, { recursive: true });
    return dir;
  }),
  writeAgentBriefing: vi.fn(),
}));
vi.mock("../../../runtime/agent-briefing.js", () => ({
  buildAgentBriefing: vi.fn(
    () => "<!-- first-tree:generated -->\nThis briefing was generated without a safe Context source.\n",
  ),
}));
vi.mock("../../../runtime/chat-context.js", () => ({
  fetchChatContext: vi.fn(async () => {
    if (!state.chatContextPromise) throw new Error("chat context gate was not initialised");
    return state.chatContextPromise;
  }),
}));
vi.mock("../../../runtime/source-repos.js", () => ({
  declaredSourceRepos: vi.fn(() => []),
  currentSourceRepoNamesFromPayload: vi.fn(() => null),
}));

import { writeAgentBriefing } from "../../../runtime/bootstrap.js";
import { noopDeliveryToken } from "../../../runtime/handler.js";
import { createClaudeCodeHandler } from "../index.js";

const AGENT_ID = "019e71d2-c9ec-7f11-86bf-5dfc9e873338";

let workspaceRoot: string;
let cachedConfig: AgentRuntimeConfig;

function makePayload(skills: RuntimeResourceSkill[]): AgentRuntimeConfigPayload {
  return {
    kind: "claude-code",
    prompt: { append: "" },
    model: "",
    mcpServers: [],
    env: [],
    gitRepos: [],
    resourceSkills: skills,
    reasoningEffort: "",
  };
}

function makeConfig(version: number, skills: RuntimeResourceSkill[]): AgentRuntimeConfig {
  return { agentId: AGENT_ID, version, payload: makePayload(skills), updatedAt: "", updatedBy: "" };
}

// Minimal cache stub: the handler only reads `.get()`. It always returns the
// current `cachedConfig`, which the test mutates to simulate a mid-session bump.
const agentConfigCache = {
  get: () => cachedConfig,
  refreshIfNewer: async () => cachedConfig,
  refresh: async () => cachedConfig,
  updateUrls: () => {},
  allReferencedUrls: () => new Set<string>(),
  forget: () => {},
};

const SCAN_SKILL: RuntimeResourceSkill = {
  resourceId: "res-scan-1",
  name: "production-scan",
  description: "Scan this repo",
  body: "SCAN RUBRIC BODY",
  metadata: {},
};

const REVIEW_SKILL: RuntimeResourceSkill = {
  resourceId: "res-review-1",
  name: "review",
  description: "Team review skill",
  body: "TEAM REVIEW BODY",
  metadata: {},
};

function makeMessage(id: string, content: string): SessionMessage {
  return { id, chatId: "chat-materialize", senderId: "sender-1", format: "text", content, metadata: {} };
}

function makeContext(fetchAttachment = vi.fn(), log: (message: string) => void = () => {}): SessionContext {
  const sendMessage = vi.fn().mockResolvedValue(undefined);
  const plumbing = mockCtxPlumbing({ sendMessage }, "chat-materialize");
  // Mirror the production SessionContext wiring (session-runtime.ts): the
  // reconciled Team Skill command registry rewrites base slash commands
  // before the provider ever sees the text. `null` until the first
  // publication — strict slash commands are blocked before that.
  let teamSkillCommands: TeamSkillCommandRegistry | null = null;
  return {
    agent: {
      agentId: AGENT_ID,
      inboxId: `inbox_${AGENT_ID}`,
      displayName: "reused-agent",
      type: "agent",
      visibility: "organization",
      delegateMention: null,
      metadata: {},
    },
    sdk: { serverUrl: "http://test", sendMessage, fetchAttachment } as unknown as SessionContext["sdk"],
    chatId: "chat-materialize",
    log,
    recordProviderActivity: () => {},
    noteTurnStart: () => {},
    emitEvent: () => {},
    ...plumbing,
    publishTeamSkillCommands: (commands) => {
      teamSkillCommands = commands === null ? null : buildTeamSkillCommandRegistry(commands);
    },
    formatInboundContent: (msg) =>
      plumbing.formatInboundContent(
        rewriteSessionMessageCommand(msg, teamSkillCommands, {
          // Mirror the production routed-mention gate (session-runtime.ts).
          allowMentionPrefix: Array.isArray(msg.metadata?.mentions) && msg.metadata.mentions.includes(AGENT_ID),
        }),
      ),
    finishTurn: async () => {},
  };
}

function resolveChatContext(): void {
  state.resolveChatContext?.({
    chatId: "chat-materialize",
    title: "materialize",
    topic: null,
    description: null,
    participants: [],
  });
}

async function waitFor(assertion: () => boolean): Promise<void> {
  const deadline = Date.now() + 5000;
  while (!assertion()) {
    if (Date.now() > deadline) throw new Error("timed out waiting for assertion");
    await new Promise((resolve) => setImmediate(resolve));
  }
}

function skillPath(): string {
  return join(workspaceRoot, ".claude", "skills", "production-scan", "SKILL.md");
}

beforeEach(() => {
  workspaceRoot = mkdtempSync(join(tmpdir(), "ft-claude-materialize-"));
  state.observedInputs.length = 0;
  state.pendingResults.length = 0;
  state.waiters.length = 0;
  state.chatContextPromise = new Promise((resolve) => {
    state.resolveChatContext = resolve;
  });
});

afterEach(() => {
  rmSync(workspaceRoot, { recursive: true, force: true });
  state.chatContextPromise = null;
  state.resolveChatContext = null;
  state.pendingResults.length = 0;
  wakeQuery();
});

describe("claude-code inject-time managed Skill reconciliation", () => {
  it("materializes a skill bound mid-session so the injected turn finds it on disk", async () => {
    cachedConfig = makeConfig(1, []);
    const config = {
      workspaceRoot,
      agentName: "test-agent",
      agentConfigCache,
      runtimeProvider: "claude-code" as const,
    };
    const handler = createClaudeCodeHandler(config);
    const ctx = makeContext();

    const startPromise = handler.start(makeMessage("m1", "first"), ctx, noopDeliveryToken());
    resolveChatContext();
    await startPromise;
    await waitFor(() => state.observedInputs.length === 1);

    // Start ran with no skills, so nothing is on disk yet.
    expect(existsSync(skillPath())).toBe(false);

    // Server binds the scan skill + bumps the config version; the cache now
    // reflects the newer version. An injected message drives the drain →
    // maybeSwitchConfig → materialize.
    cachedConfig = makeConfig(2, [SCAN_SKILL]);
    handler.inject(makeMessage("m2", "run the scan"), noopDeliveryToken());

    // Wait for the body to actually land — existsSync alone can race the
    // create-then-write window and observe a still-empty file.
    const target = skillPath();
    await waitFor(() => existsSync(target) && readFileSync(target, "utf-8").includes("SCAN RUBRIC BODY"));
    expect(readFileSync(target, "utf-8")).toContain("SCAN RUBRIC BODY");

    await handler.shutdown();
  });

  it("does not prune a live skill when a refresh falls back to a lower-version empty config", async () => {
    cachedConfig = makeConfig(2, [SCAN_SKILL]);
    const config = {
      workspaceRoot,
      agentName: "test-agent",
      agentConfigCache,
      runtimeProvider: "claude-code" as const,
    };
    const handler = createClaudeCodeHandler(config);
    const ctx = makeContext();

    const startPromise = handler.start(makeMessage("m1", "first"), ctx, noopDeliveryToken());
    resolveChatContext();
    await startPromise;
    await waitFor(() => state.observedInputs.length === 1);
    // Start materialized the skill at version 2.
    expect(existsSync(skillPath())).toBe(true);

    // A swallowed refresh failure leaves a version-0 empty fallback config.
    // The version guard must skip re-materialization so the empty payload
    // cannot prune the live skill while the injected turn still proceeds.
    vi.mocked(writeAgentBriefing).mockClear();
    cachedConfig = makeConfig(0, []);
    handler.inject(makeMessage("m2", "another message"), noopDeliveryToken());

    await waitFor(() => state.observedInputs.length === 2);
    expect(existsSync(skillPath())).toBe(true);

    await handler.shutdown();
  });

  it("downloads and settles a newly attached complete bundle before the injected provider turn", async () => {
    const bundle = Buffer.from(
      zipSync({
        "SKILL.md": strToU8(
          [
            "---",
            "name: production-scan",
            "description: Scan this repo from a complete bundle.",
            "---",
            "",
            "# Scan",
            "",
            "BUNDLED RUBRIC BODY",
            "",
          ].join("\n"),
        ),
        "scripts/scan.sh": strToU8("#!/bin/sh\necho bundle-ready\n"),
        "assets/proof.bin": Uint8Array.from([0, 255, 7]),
      }),
    );
    const fetchAttachment = vi.fn().mockResolvedValue({
      bytes: bundle,
      mimeType: "application/zip",
      filename: "production-scan.zip",
      size: bundle.byteLength,
    });
    const bundledSkill: RuntimeResourceSkill = {
      ...SCAN_SKILL,
      body: "INLINE FALLBACK MUST NOT LAND",
      bundle: {
        attachmentId: "11111111-1111-4111-8111-111111111111",
        format: "zip",
        sizeBytes: bundle.byteLength,
      },
    };
    cachedConfig = makeConfig(1, []);
    const handler = createClaudeCodeHandler({
      runtimeProvider: "claude-code",
      workspaceRoot,
      agentName: "test-agent",
      agentConfigCache,
    });
    const ctx = makeContext(fetchAttachment);

    const startPromise = handler.start(makeMessage("m1", "first"), ctx, noopDeliveryToken());
    resolveChatContext();
    await startPromise;
    await waitFor(() => state.observedInputs.length === 1);

    cachedConfig = makeConfig(2, [bundledSkill]);
    handler.inject(makeMessage("m2", "run the newly attached scan"), noopDeliveryToken());

    await waitFor(() => state.observedInputs.length === 2);
    expect(fetchAttachment).toHaveBeenCalledTimes(1);
    expect(fetchAttachment).toHaveBeenCalledWith({ id: bundledSkill.bundle?.attachmentId });
    expect(readFileSync(skillPath(), "utf-8")).toContain("BUNDLED RUBRIC BODY");
    expect(readFileSync(skillPath(), "utf-8")).not.toContain("INLINE FALLBACK");
    expect(
      readFileSync(join(workspaceRoot, ".claude", "skills", "production-scan", "scripts", "scan.sh"), "utf-8"),
    ).toContain("bundle-ready");

    await handler.shutdown();
  });

  it("blocks an injected provider turn when drift cannot leave the discovery root", async () => {
    const bundle = Buffer.from(
      zipSync({
        "SKILL.md": strToU8("---\nname: production-scan\ndescription: Scan safely.\n---\n\n# Scan\n"),
        "scripts/scan.sh": strToU8("#!/bin/sh\necho safe\n"),
      }),
    );
    const bundledSkill: RuntimeResourceSkill = {
      ...SCAN_SKILL,
      bundle: {
        attachmentId: "11111111-1111-4111-8111-111111111111",
        format: "zip",
        sizeBytes: bundle.byteLength,
      },
    };
    const fetchAttachment = vi.fn().mockResolvedValue({
      bytes: bundle,
      mimeType: "application/zip",
      filename: "production-scan.zip",
      size: bundle.byteLength,
    });
    const logs: string[] = [];
    cachedConfig = makeConfig(1, [bundledSkill]);
    const handler = createClaudeCodeHandler({
      runtimeProvider: "claude-code",
      workspaceRoot,
      agentName: "test-agent",
      agentConfigCache,
    });
    const ctx = makeContext(fetchAttachment, (message) => logs.push(message));

    const startPromise = handler.start(makeMessage("m1", "first"), ctx, noopDeliveryToken());
    resolveChatContext();
    await startPromise;
    await waitFor(() => state.observedInputs.length === 1);

    const scriptsRoot = join(workspaceRoot, ".claude", "skills", "production-scan", "scripts");
    writeFileSync(join(scriptsRoot, "scan.sh"), "#!/bin/sh\necho tampered\n");
    const discoveryRoot = join(workspaceRoot, ".claude", "skills");
    chmodSync(discoveryRoot, 0o500);
    try {
      cachedConfig = makeConfig(2, [bundledSkill]);
      handler.inject(makeMessage("m2", "must not reach provider"), noopDeliveryToken());
      await waitFor(() =>
        logs.some(
          (message) =>
            message.includes("cannot be verified or quarantined") || message.includes("must remain unchanged"),
        ),
      );
      expect(state.observedInputs).toHaveLength(1);
      expect(readFileSync(join(scriptsRoot, "scan.sh"), "utf-8")).toContain("tampered");
    } finally {
      chmodSync(discoveryRoot, 0o700);
      await handler.shutdown();
    }
  });

  it("rewrites a base slash command to the suffixed install when an unmanaged local Skill occupies the base name", async () => {
    cachedConfig = makeConfig(1, []);
    const handler = createClaudeCodeHandler({
      runtimeProvider: "claude-code",
      workspaceRoot,
      agentName: "test-agent",
      agentConfigCache,
    });
    const ctx = makeContext();

    const startPromise = handler.start(makeMessage("m1", "first"), ctx, noopDeliveryToken());
    resolveChatContext();
    await startPromise;
    await waitFor(() => state.observedInputs.length === 1);

    // An unmanaged local Skill squats on the base name; the server then
    // binds the Team Skill and the injected turn drives the reconcile.
    const localDir = join(workspaceRoot, ".claude", "skills", "review");
    mkdirSync(localDir, { recursive: true });
    writeFileSync(join(localDir, "SKILL.md"), "---\nname: review\ndescription: local\n---\n\nLOCAL REVIEW BODY\n");
    cachedConfig = makeConfig(2, [REVIEW_SKILL]);
    handler.inject(makeMessage("m2", "/review src/"), noopDeliveryToken());

    await waitFor(() => existsSync(join(workspaceRoot, ".claude", "skills", "review-first-tree", "SKILL.md")));
    await waitFor(() => state.observedInputs.length === 2);

    // The provider received the rewritten command — never the squatted
    // local `/review`.
    expect(readFileSync(join(workspaceRoot, ".claude", "skills", "review-first-tree", "SKILL.md"), "utf-8")).toContain(
      "TEAM REVIEW BODY",
    );
    expect(state.observedInputs[1]).toContain("/review-first-tree src/");
    expect(state.observedInputs[1]).not.toContain("/review src/");

    await handler.shutdown();
  });

  it("leaves the command untouched when the Team Skill installs under its base name", async () => {
    cachedConfig = makeConfig(1, []);
    const handler = createClaudeCodeHandler({
      runtimeProvider: "claude-code",
      workspaceRoot,
      agentName: "test-agent",
      agentConfigCache,
    });
    const ctx = makeContext();

    const startPromise = handler.start(makeMessage("m1", "first"), ctx, noopDeliveryToken());
    resolveChatContext();
    await startPromise;
    await waitFor(() => state.observedInputs.length === 1);

    cachedConfig = makeConfig(2, [REVIEW_SKILL]);
    handler.inject(makeMessage("m2", "/review src/"), noopDeliveryToken());

    await waitFor(() => existsSync(join(workspaceRoot, ".claude", "skills", "review", "SKILL.md")));
    await waitFor(() => state.observedInputs.length === 2);
    expect(state.observedInputs[1]).toContain("/review src/");

    await handler.shutdown();
  });

  it("rewrites a bare image-caption slash command to the suffixed install", async () => {
    cachedConfig = makeConfig(1, []);
    const handler = createClaudeCodeHandler({
      runtimeProvider: "claude-code",
      workspaceRoot,
      agentName: "test-agent",
      agentConfigCache,
    });
    const ctx = makeContext();

    const startPromise = handler.start(makeMessage("m1", "first"), ctx, noopDeliveryToken());
    resolveChatContext();
    await startPromise;
    await waitFor(() => state.observedInputs.length === 1);

    const localDir = join(workspaceRoot, ".claude", "skills", "review");
    mkdirSync(localDir, { recursive: true });
    writeFileSync(join(localDir, "SKILL.md"), "---\nname: review\ndescription: local\n---\n\nLOCAL REVIEW BODY\n");
    cachedConfig = makeConfig(2, [REVIEW_SKILL]);

    const imageMessage: SessionMessage = {
      id: "m2",
      chatId: "chat-materialize",
      senderId: "sender-1",
      format: "file",
      content: {
        caption: "/review see this",
        attachments: [{ imageId: "11111111-1111-4111-8111-111111111111", mimeType: "image/png", filename: "shot.png" }],
      },
      metadata: {},
    };
    handler.inject(imageMessage, noopDeliveryToken());

    await waitFor(() => existsSync(join(workspaceRoot, ".claude", "skills", "review-first-tree", "SKILL.md")));
    await waitFor(() => state.observedInputs.length === 2);
    // The caption command was rewritten before the provider saw it; the
    // image attachment prompt is preserved alongside it.
    expect(state.observedInputs[1]).toContain("/review-first-tree see this");
    expect(state.observedInputs[1]).not.toContain("/review see this");
    // The image attachment prompt/filename is preserved EXACTLY once — the
    // routed-mentions metadata we now keep must not duplicate the note.
    expect(state.observedInputs[1]?.match(/shot\.png/g)).toHaveLength(1);

    await handler.shutdown();
  });

  it("rewrites a mention-prefixed image-caption slash command only with routed metadata", async () => {
    cachedConfig = makeConfig(1, []);
    const handler = createClaudeCodeHandler({
      runtimeProvider: "claude-code",
      workspaceRoot,
      agentName: "test-agent",
      agentConfigCache,
    });
    const ctx = makeContext();

    const startPromise = handler.start(makeMessage("m1", "first"), ctx, noopDeliveryToken());
    resolveChatContext();
    await startPromise;
    await waitFor(() => state.observedInputs.length === 1);

    const localDir = join(workspaceRoot, ".claude", "skills", "review");
    mkdirSync(localDir, { recursive: true });
    writeFileSync(join(localDir, "SKILL.md"), "---\nname: review\ndescription: local\n---\n\nLOCAL REVIEW BODY\n");
    cachedConfig = makeConfig(2, [REVIEW_SKILL]);

    const routed: SessionMessage = {
      id: "m2",
      chatId: "chat-materialize",
      senderId: "sender-1",
      format: "file",
      content: {
        caption: "@nova /review",
        attachments: [{ imageId: "11111111-1111-4111-8111-111111111111", mimeType: "image/png", filename: "shot.png" }],
      },
      metadata: { mentions: [AGENT_ID] },
    };
    handler.inject(routed, noopDeliveryToken());
    await waitFor(() => state.observedInputs.length === 2);
    expect(state.observedInputs[1]).toContain("@nova /review-first-tree");

    // Without routed mention metadata the same caption is NOT rewritten.
    state.observedInputs.length = 0;
    const unrouted: SessionMessage = {
      id: "m3",
      chatId: "chat-materialize",
      senderId: "sender-1",
      format: "file",
      content: {
        caption: "@nova /review",
        attachments: [{ imageId: "22222222-2222-4222-8222-222222222222", mimeType: "image/png", filename: "shot.png" }],
      },
      metadata: {},
    };
    handler.inject(unrouted, noopDeliveryToken());
    await waitFor(() => state.observedInputs.length === 1);
    expect(state.observedInputs[0]).toContain("@nova /review");
    expect(state.observedInputs[0]).not.toContain("review-first-tree");

    await handler.shutdown();
  });

  it("settles a same-version unavailable Team command with one inert provider notice — no retry, no command token", async () => {
    const bundleSkill: RuntimeResourceSkill = {
      ...REVIEW_SKILL,
      bundle: {
        attachmentId: "33333333-3333-4333-8333-333333333333",
        format: "zip",
        sizeBytes: 100,
      },
    };
    // The bundle can never be fetched, so `/review` never gets an exact
    // installed identity; the registry marks it explicitly unavailable.
    const fetchAttachment = vi.fn().mockRejectedValue(new Error("attachment unavailable"));
    cachedConfig = makeConfig(1, []);
    const handler = createClaudeCodeHandler({
      runtimeProvider: "claude-code",
      workspaceRoot,
      agentName: "test-agent",
      agentConfigCache,
    });
    const ctx = makeContext(fetchAttachment);

    const startPromise = handler.start(makeMessage("m1", "first"), ctx, noopDeliveryToken());
    resolveChatContext();
    await startPromise;
    await waitFor(() => state.observedInputs.length === 1);

    cachedConfig = makeConfig(2, [bundleSkill]);
    const noop = noopDeliveryToken();
    const token = { ...noop, retry: vi.fn(), complete: vi.fn(noop.complete) };
    handler.inject(makeMessage("m2", "/review src/"), token);

    // Deterministic terminal boundary: the provider receives exactly one
    // inert First Tree notice — no `/review` command token, no formatter
    // retry, no recovery loop.
    await waitFor(() => state.observedInputs.length === 2);
    expect(state.observedInputs[1]).toContain("currently unavailable");
    expect(state.observedInputs[1]).not.toContain("/review src/");
    expect(state.observedInputs[1]).not.toContain("/review ");
    expect(token.retry).not.toHaveBeenCalled();

    await handler.shutdown();
  });
});
