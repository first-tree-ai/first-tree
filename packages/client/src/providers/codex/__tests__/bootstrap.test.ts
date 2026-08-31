import { existsSync, lstatSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentRuntimeConfigPayload } from "@first-tree/shared";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { bootstrapWorkspace, FIRST_TREE_WORKSPACE_MARKER } from "../../../runtime/bootstrap.js";
import type { ChatContext } from "../../../runtime/chat-context.js";
import { renderChatContextPrompt } from "../../../runtime/chat-context-section.js";
import { setCliBinding } from "../../../runtime/cli-binding.js";
import { buildCodexAgentBriefing } from "../index.js";

// The unified briefing builder (`runtime/agent-briefing.ts`) reads the
// channel-resolved CLI binding for the binary name interpolated into every
// `${bin}` example. Pin it to the prod identity so the helper has a
// binding installed even when these tests run in isolation (the production
// CLI entry installs it via channel-env.ts, but vitest workers boot
// without that side effect).
beforeAll(() => {
  setCliBinding({ binName: "first-tree", packageName: "first-tree" });
});

function codexPayload(
  overrides: Partial<Extract<AgentRuntimeConfigPayload, { kind: "codex" }>> = {},
): AgentRuntimeConfigPayload {
  return {
    kind: "codex",
    prompt: { append: "" },
    model: "",
    mcpServers: [],
    env: [],
    gitRepos: [],
    resourceSkills: [],
    reasoningEffort: "high",
    serviceTier: "default",
    ...overrides,
  };
}

describe("bootstrapWorkspace — codex briefing + workspace marker", () => {
  let workspacePath: string;

  beforeEach(() => {
    workspacePath = mkdtempSync(join(tmpdir(), "first-tree-codex-bootstrap-"));
  });

  afterEach(() => {
    rmSync(workspacePath, { recursive: true, force: true });
  });

  it("writes the .first-tree-workspace marker directory for every workspace", () => {
    bootstrapWorkspace({
      workspacePath,
      identity: {
        agentId: "agent-1",
        inboxId: "inbox_agent-1",
        displayName: "Tester",
        type: "agent",
        visibility: "organization",
        delegateMention: null,
        metadata: {},
      },
      agentName: "slot-agent",
      contextTreePath: null,
      serverUrl: "http://first-tree.test",
    });

    expect(existsSync(join(workspacePath, FIRST_TREE_WORKSPACE_MARKER))).toBe(true);
    expect(lstatSync(join(workspacePath, FIRST_TREE_WORKSPACE_MARKER)).isDirectory()).toBe(true);
  });

  it("bootstrapWorkspace no longer writes the briefing (callers route through writeAgentBriefing)", () => {
    // Briefing materialisation is now the caller's responsibility — the
    // handler computes the unified briefing via `buildAgentBriefing` and
    // hands it to `writeAgentBriefing` (or to `ensureAgentBootstrap` which
    // calls writeAgentBriefing internally). `bootstrapWorkspace` is back to
    // owning only the stable `.first-tree-workspace/` layout.
    bootstrapWorkspace({
      workspacePath,
      identity: {
        agentId: "agent-1",
        inboxId: "inbox_agent-1",
        displayName: "Tester",
        type: "agent",
        visibility: "organization",
        delegateMention: null,
        metadata: {},
      },
      agentName: "slot-agent",
      contextTreePath: null,
      serverUrl: "http://first-tree.test",
    });

    expect(existsSync(join(workspacePath, "AGENTS.md"))).toBe(false);
    expect(existsSync(join(workspacePath, "CLAUDE.md"))).toBe(false);
  });

  it("inlines stable First Tree tools and messaging rules into the shared briefing", () => {
    setCliBinding({ binName: "first-tree-staging", packageName: "first-tree-staging" });
    const chatContext: ChatContext = {
      chatId: "chat-1",
      title: "Codex routing",
      topic: "Codex routing",
      description: null,
      participants: [
        { name: "baixiaohang", displayName: "Bai Xiaohang", type: "human" },
        { name: "codex-developer", displayName: "Codex Developer", type: "agent" },
      ],
    };

    const briefing = buildCodexAgentBriefing(
      {
        agentId: "codex-developer",
        inboxId: "inbox_codex-developer",
        displayName: "Codex Developer",
        type: "agent",
        visibility: "organization",
        delegateMention: null,
        metadata: {},
      },
      codexPayload({ prompt: { append: "Follow the local implementation plan." } }),
      chatContext,
      "/workspaces/codex-developer",
      [],
      // Tree-bound case so we can assert that the Skill Map + First Tree
      // Family map are emitted. Tree-less Skill Map gating is exercised in
      // `agent-briefing.test.ts`.
      "/var/lib/context-trees/codex",
    );

    // Section names follow the AGENTS.md restructure: `# Identity`, the
    // provenance-labelled legacy prompt fallback, `# Working in First Tree`.
    expect(briefing).toContain("# Identity");
    expect(briefing).toContain("Codex Developer");
    expect(briefing).toContain("# Agent Prompt (legacy merged — may include team-shared content)");
    expect(briefing).not.toContain("## Agent-Specific Prompt");
    expect(briefing).toContain("Follow the local implementation plan.");
    expect(briefing).not.toContain("## Current Chat Context");
    expect(briefing).not.toContain("Chat ID: chat-1");
    expect(briefing).not.toContain("@baixiaohang");
    expect(briefing).toContain("# Working in First Tree");
    // The CLI decision guide stays inline because tree-less agents
    // do not have First Tree family skill payloads installed.
    expect(briefing).toContain("## CLI Overview");
    expect(briefing).toContain("## Communication");
    expect(briefing).toContain("## Task Management");
    expect(briefing).toContain("first-tree-staging chat --help");
    expect(briefing).toContain("first-tree-staging chat send");
    // `chat send` reaches any teammate — agent or human; a human also has
    // `chat ask` (decisions) / `chat update --description` (progress). The
    // output is reframed, provider-neutrally, as a reasoning/activity trace read
    // by the First Tree runtime ("the user" the agent addresses), not the
    // teammates — but the retired `agent-final-text` mirror term must NOT
    // survive (post-#1190), and the brief names no Claude-specific harness so a
    // Codex agent maps it onto its own `commentary` / `final` channels.
    expect(briefing).toContain("first-tree-staging chat ask <human>");
    expect(briefing).toContain("first-tree-staging chat update --description");
    expect(briefing).toMatch(/the "user" your underlying agent addresses is the First\s+Tree runtime/i);
    expect(briefing).not.toMatch(/Claude Code harness/i);
    expect(briefing).not.toContain("agent-final-text");
    // The new Skill Map and Context Tree section are now part of every
    // briefing — pin both so a regenerator dropping them doesn't slip past
    // review.
    expect(briefing).toContain("# Context Tree");
    expect(briefing).toContain("## Reading the Tree");
    expect(briefing).toContain("## Writing the Tree");
    expect(briefing).toContain("# Skills");
    expect(briefing).toContain("## First Tree Family");
    // Stale pointer at the retired first-tree-cloud skill must stay gone.
    expect(briefing).not.toContain("first-tree-cloud");
    // Section headers that the restructure renamed must not linger.
    expect(briefing).not.toContain("# First Tree Agent Runtime");
    expect(briefing).not.toContain("# Working Directory Convention");
    expect(briefing).not.toContain("## Agent-Specific Behavior");
  });

  it("keeps same-agent concurrent chat contexts out of the shared briefing", () => {
    const identity = {
      agentId: "codex-developer",
      inboxId: "inbox_codex-developer",
      displayName: "Codex Developer",
      type: "agent" as const,
      visibility: "organization" as const,
      delegateMention: null,
      metadata: {},
    };
    const payload = codexPayload({ prompt: { append: "Stable agent prompt." } });
    const chatA: ChatContext = {
      chatId: "chat-a",
      title: "Chat A",
      topic: "Chat A",
      description: null,
      participants: [{ name: "alice", displayName: "Alice", type: "human" }],
    };
    const chatB: ChatContext = {
      chatId: "chat-b",
      title: "Chat B",
      topic: "Chat B",
      description: null,
      participants: [{ name: "bob", displayName: "Bob", type: "human" }],
    };

    const briefingA = buildCodexAgentBriefing(identity, payload, chatA, "/workspaces/codex-developer", [], null);
    const briefingB = buildCodexAgentBriefing(identity, payload, chatB, "/workspaces/codex-developer", [], null);

    expect(briefingA).toBe(briefingB);
    expect(briefingA).not.toContain("chat-a");
    expect(briefingA).not.toContain("chat-b");

    const promptA = renderChatContextPrompt(chatA);
    const promptB = renderChatContextPrompt(chatB);
    expect(promptA).toContain('"chatId": "chat-a"');
    expect(promptA).not.toContain("chat-b");
    expect(promptB).toContain('"chatId": "chat-b"');
    expect(promptB).not.toContain("chat-a");
  });
});
