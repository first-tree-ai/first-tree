import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentRuntimeConfig } from "@first-tree/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.unmock("../runtime/managed-skills.js");

import { IDENTITY_JSON_REL } from "../runtime/bootstrap.js";
import {
  CONTEXT_SOURCE_LOCK_REL,
  recordRemoteBindingObservation,
  setSourcePublicationTestHook,
  withSourcePublicationLock,
} from "../runtime/context-source.js";
import { CORE_SKILL_NAMES } from "../runtime/first-tree-skills/installer.js";
import type { SessionContext } from "../runtime/handler.js";
import { ManagedSkillsUnsafeDiscoveryError, providerSkillRoot } from "../runtime/managed-skills.js";
import { MANAGED_SKILLS_JOURNAL_REL, MANAGED_SKILLS_LOCK_REL, MANAGED_STATE_REL } from "../runtime/managed-state.js";
import { ContextSourceTransitionError, projectManagedWorkspace } from "../runtime/provider-support/preparation.js";
import { INIT_COMPLETE_SENTINEL_REL } from "../runtime/workspace.js";
import { mockCtxPlumbing } from "./test-helpers.js";

const TEST_PROVIDER_SKILL_ROOTS = Object.freeze({
  amp: ".agents/skills",
  "deepseek-harness": ".agents/skills",
  "claude-code": ".claude/skills",
  "claude-code-tui": ".claude/skills",
  codex: ".agents/skills",
  cursor: ".cursor/skills",
  grok: ".grok/skills",
  antigravity: ".agents/skills",
  "kimi-code": ".kimi-code/skills",
  opencode: ".opencode/skills",
  pi: ".agents/skills",
  zcode: ".zcode/skills",
});

function writeCoreBundle(parent: string): string {
  const root = join(parent, "bundled");
  for (const name of CORE_SKILL_NAMES) {
    const skillRoot = join(root, name);
    mkdirSync(join(skillRoot, "references"), { recursive: true });
    writeFileSync(
      join(skillRoot, "SKILL.md"),
      ["---", `name: ${name}`, `description: Public ${name}.`, "---", "", `# ${name}`, ""].join("\n"),
    );
    writeFileSync(join(skillRoot, "VERSION"), "1.0.0\n");
  }
  for (const name of ["first-tree-read", "first-tree-write"] as const) {
    const skillRoot = join(root, ".variants", "local-context", name);
    mkdirSync(skillRoot, { recursive: true });
    writeFileSync(
      join(skillRoot, "SKILL.md"),
      ["---", `name: ${name}`, `description: Public ${name}.`, "---", "", `# ${name} local`, ""].join("\n"),
    );
    writeFileSync(join(skillRoot, "VERSION"), "1.0.0\n");
  }
  return root;
}

describe("source-publication lock", () => {
  let sandbox: string;
  let workspace: string;
  let bundledSkillsRoot: string;

  beforeEach(() => {
    sandbox = mkdtempSync(join(realpathSync(tmpdir()), "ft-source-publication-"));
    workspace = join(sandbox, "workspace");
    mkdirSync(workspace, { recursive: true });
    bundledSkillsRoot = writeCoreBundle(sandbox);
    setSourcePublicationTestHook(null);
  });

  afterEach(() => {
    setSourcePublicationTestHook(null);
    rmSync(sandbox, { recursive: true, force: true });
  });

  function sessionCtx(): SessionContext {
    const sendMessage = vi.fn().mockResolvedValue(undefined);
    return {
      agent: {
        agentId: "019d9a97-90b0-716b-8317-a8c0be8430d7",
        inboxId: "inbox-1",
        displayName: "Display Name Must Not Become agentName",
        type: "agent",
        visibility: "organization",
        delegateMention: null,
        metadata: {},
      },
      sdk: { serverUrl: "https://first-tree.example.test", sendMessage } as unknown as SessionContext["sdk"],
      chatId: "chat-1",
      log: () => {},
      recordProviderActivity: () => {},
      noteTurnStart: () => {},
      emitEvent: () => {},
      ...mockCtxPlumbing({ sendMessage }, "chat-1"),
    } as SessionContext;
  }

  const payload = {
    kind: "codex" as const,
    prompt: { append: "" },
    model: "",
    mcpServers: [],
    env: [],
    gitRepos: [],
    resourceSkills: [],
    reasoningEffort: "high" as const,
    serviceTier: "default" as const,
  };

  function projectionBytes(root = workspace): Record<string, string | null> {
    const paths = [
      join(root, ".agents", "skills", "first-tree-read", "SKILL.md"),
      join(root, ".agents", "skills", "first-tree-write", "SKILL.md"),
      join(root, ".first-tree", "workspace.json"),
      join(root, IDENTITY_JSON_REL),
      join(root, "AGENTS.md"),
      join(root, INIT_COMPLETE_SENTINEL_REL),
    ];
    return Object.fromEntries(paths.map((path) => [path, existsSync(path) ? readFileSync(path, "utf8") : null]));
  }

  function workspaceEntrySnapshot(root = workspace): Record<string, string> {
    const result: Record<string, string> = {};
    const visit = (absolute: string, relative: string): void => {
      const stat = lstatSync(absolute);
      if (stat.isSymbolicLink()) {
        result[relative] = `symlink:${readlinkSync(absolute)}`;
        return;
      }
      if (stat.isDirectory()) {
        result[relative || "."] = "directory";
        for (const name of readdirSync(absolute).sort()) {
          visit(join(absolute, name), relative ? `${relative}/${name}` : name);
        }
        return;
      }
      result[relative] = `file:${readFileSync(absolute).toString("base64")}`;
    };
    visit(root, "");
    return result;
  }

  it("does not let stale Local publication downgrade remote Skill, manifest, identity, briefing, or sentinel", async () => {
    let releaseLocal = (): void => {};
    let localReached = (): void => {};
    const localGate = new Promise<void>((resolve) => {
      releaseLocal = resolve;
    });
    const localWaiting = new Promise<void>((resolve) => {
      localReached = resolve;
    });
    let pauseLocal = false;
    setSourcePublicationTestHook(async () => {
      if (!pauseLocal) return;
      localReached();
      await localGate;
    });

    pauseLocal = true;
    const localPublication = projectManagedWorkspace({
      sessionCtx: sessionCtx(),
      workspace,
      agentName: "slot-agent",
      runtimeProvider: "codex",
      providerSkillRoots: TEST_PROVIDER_SKILL_ROOTS,
      runtimeConfig: null,
      payload,
      payloadResolved: true,
      bundledSkillsRoot,
      contextTree: {
        kind: "local",
        path: join(workspace, "local-context"),
        repoUrl: null,
        branch: null,
      },
      markInitComplete: true,
    });
    await localWaiting;
    pauseLocal = false;

    await projectManagedWorkspace({
      sessionCtx: sessionCtx(),
      workspace,
      agentName: "slot-agent",
      runtimeProvider: "codex",
      providerSkillRoots: TEST_PROVIDER_SKILL_ROOTS,
      runtimeConfig: null,
      payload,
      payloadResolved: true,
      bundledSkillsRoot,
      contextTree: {
        kind: "remote",
        path: join(workspace, "context-tree"),
        repoUrl: "git@github.com:acme/tree.git",
        branch: "main",
      },
      markInitComplete: true,
    });

    const readRoot = join(workspace, providerSkillRoot("codex", TEST_PROVIDER_SKILL_ROOTS), "first-tree-read");
    const remoteSkill = readFileSync(join(readRoot, "SKILL.md"), "utf8");
    const remoteManifest = readFileSync(join(workspace, ".first-tree", "workspace.json"), "utf8");
    const remoteIdentity = readFileSync(join(workspace, IDENTITY_JSON_REL), "utf8");
    const remoteBriefing = readFileSync(join(workspace, "AGENTS.md"), "utf8");
    const remoteSentinel = readFileSync(join(workspace, INIT_COMPLETE_SENTINEL_REL), "utf8");

    releaseLocal();
    await expect(localPublication).rejects.toBeInstanceOf(ManagedSkillsUnsafeDiscoveryError);

    expect(readFileSync(join(readRoot, "SKILL.md"), "utf8")).toBe(remoteSkill);
    expect(remoteSkill).toContain("# first-tree-read\n");
    expect(remoteSkill).not.toContain("# first-tree-read local");
    expect(JSON.parse(readFileSync(join(readRoot, ".first-tree-managed.json"), "utf8"))).toMatchObject({
      revision: "1.0.0",
    });
    expect(readFileSync(join(workspace, ".first-tree", "workspace.json"), "utf8")).toBe(remoteManifest);
    expect(JSON.parse(remoteManifest)).toMatchObject({ tree: "context-tree" });
    expect(readFileSync(join(workspace, IDENTITY_JSON_REL), "utf8")).toBe(remoteIdentity);
    expect(JSON.parse(remoteIdentity)).toMatchObject({
      agentName: "slot-agent",
      contextSourceKind: "remote",
    });
    expect(readFileSync(join(workspace, "AGENTS.md"), "utf8")).toBe(remoteBriefing);
    expect(readFileSync(join(workspace, INIT_COMPLETE_SENTINEL_REL), "utf8")).toBe(remoteSentinel);
    expect(
      JSON.parse(readFileSync(join(workspace, ".first-tree-workspace", "source-state.json"), "utf8")),
    ).toMatchObject({
      schemaVersion: 1,
      remoteObserved: true,
      repoUrl: "git@github.com:acme/tree.git",
      branch: "main",
    });
    expect(existsSync(join(workspace, CONTEXT_SOURCE_LOCK_REL))).toBe(true);
    expect(CONTEXT_SOURCE_LOCK_REL).not.toBe(MANAGED_SKILLS_LOCK_REL);
  });

  it("legacy resume publication cannot downgrade remote Skills or AGENTS.md after a latch", async () => {
    const legacyWorkspace = join(sandbox, "legacy-chat");
    mkdirSync(legacyWorkspace);
    await projectManagedWorkspace({
      sessionCtx: sessionCtx(),
      workspace: legacyWorkspace,
      sourceAuthorityRoot: workspace,
      agentName: "slot-agent",
      runtimeProvider: "codex",
      providerSkillRoots: TEST_PROVIDER_SKILL_ROOTS,
      runtimeConfig: null,
      payload,
      payloadResolved: true,
      bundledSkillsRoot,
      contextTree: {
        kind: "remote",
        path: join(workspace, "context-tree"),
        repoUrl: "git@github.com:acme/tree.git",
        branch: "main",
      },
      markInitComplete: false,
      writeIdentityAndManifest: false,
    });

    const readRoot = join(legacyWorkspace, providerSkillRoot("codex", TEST_PROVIDER_SKILL_ROOTS), "first-tree-read");
    const remoteSkill = readFileSync(join(readRoot, "SKILL.md"), "utf8");
    const remoteBriefing = readFileSync(join(legacyWorkspace, "AGENTS.md"), "utf8");

    await expect(
      projectManagedWorkspace({
        sessionCtx: sessionCtx(),
        workspace: legacyWorkspace,
        sourceAuthorityRoot: workspace,
        agentName: "slot-agent",
        runtimeProvider: "codex",
        providerSkillRoots: TEST_PROVIDER_SKILL_ROOTS,
        runtimeConfig: null,
        payload,
        payloadResolved: true,
        bundledSkillsRoot,
        contextTree: {
          kind: "local",
          path: join(workspace, "local-context"),
          repoUrl: null,
          branch: null,
        },
        markInitComplete: false,
        writeIdentityAndManifest: false,
      }),
    ).rejects.toBeInstanceOf(ManagedSkillsUnsafeDiscoveryError);

    expect(readFileSync(join(readRoot, "SKILL.md"), "utf8")).toBe(remoteSkill);
    expect(remoteSkill).not.toContain("# first-tree-read local");
    expect(readFileSync(join(legacyWorkspace, "AGENTS.md"), "utf8")).toBe(remoteBriefing);
    expect(existsSync(join(workspace, CONTEXT_SOURCE_LOCK_REL))).toBe(true);
    expect(existsSync(join(legacyWorkspace, CONTEXT_SOURCE_LOCK_REL))).toBe(false);
  });

  it("publishes trusted Local authority metadata in Agent home while keeping legacy identity out of the target", async () => {
    const legacyWorkspace = join(sandbox, "legacy-local-chat");
    mkdirSync(legacyWorkspace);
    await projectManagedWorkspace({
      sessionCtx: sessionCtx(),
      workspace: legacyWorkspace,
      sourceAuthorityRoot: workspace,
      agentName: "slot-agent",
      runtimeProvider: "codex",
      providerSkillRoots: TEST_PROVIDER_SKILL_ROOTS,
      runtimeConfig: null,
      payload,
      payloadResolved: true,
      bundledSkillsRoot,
      contextTree: {
        kind: "local",
        path: join(workspace, "local-context"),
        repoUrl: null,
        branch: null,
      },
      markInitComplete: false,
      writeIdentityAndManifest: false,
    });

    expect(JSON.parse(readFileSync(join(workspace, IDENTITY_JSON_REL), "utf8"))).toMatchObject({
      agentName: "slot-agent",
      contextSourceKind: "local",
      contextTreePath: join(workspace, "local-context"),
    });
    expect(JSON.parse(readFileSync(join(workspace, ".first-tree", "workspace.json"), "utf8"))).toMatchObject({
      tree: "local-context",
    });
    expect(existsSync(join(workspace, INIT_COMPLETE_SENTINEL_REL))).toBe(true);
    expect(existsSync(join(legacyWorkspace, IDENTITY_JSON_REL))).toBe(false);
    expect(existsSync(join(legacyWorkspace, INIT_COMPLETE_SENTINEL_REL))).toBe(false);
    expect(readFileSync(join(legacyWorkspace, ".agents", "skills", "first-tree-read", "SKILL.md"), "utf8")).toContain(
      "# first-tree-read local",
    );
  });

  it("recognizes a complete split-root none projection on a later legacy admission", async () => {
    const legacyWorkspace = join(sandbox, "legacy-none-chat");
    mkdirSync(legacyWorkspace);
    const params = {
      sessionCtx: sessionCtx(),
      workspace: legacyWorkspace,
      sourceAuthorityRoot: workspace,
      agentName: "slot-agent",
      runtimeProvider: "codex" as const,
      providerSkillRoots: TEST_PROVIDER_SKILL_ROOTS,
      runtimeConfig: null,
      payload,
      payloadResolved: true,
      bundledSkillsRoot,
      contextTree: { kind: "none" as const, path: null, repoUrl: null, branch: null },
      markInitComplete: false,
      writeIdentityAndManifest: false,
    };
    await projectManagedWorkspace(params);
    await expect(projectManagedWorkspace({ ...params, existingPayload: payload })).resolves.toMatchObject({
      briefing: expect.any(String),
    });
    expect(JSON.parse(readFileSync(join(workspace, IDENTITY_JSON_REL), "utf8"))).toMatchObject({
      contextSourceKind: "none",
      contextTreePath: null,
    });
    expect(existsSync(join(legacyWorkspace, IDENTITY_JSON_REL))).toBe(false);
  });

  it("treats a latch as a Local freeze, not a lease that can restart an old Remote", async () => {
    await projectManagedWorkspace({
      sessionCtx: sessionCtx(),
      workspace,
      agentName: "slot-agent",
      runtimeProvider: "codex",
      providerSkillRoots: TEST_PROVIDER_SKILL_ROOTS,
      runtimeConfig: { version: 0, payload } as unknown as AgentRuntimeConfig,
      payload,
      payloadResolved: true,
      bundledSkillsRoot,
      contextTree: {
        kind: "remote",
        path: join(workspace, "context-tree"),
        repoUrl: "git@github.com:acme/old-tree.git",
        branch: "main",
      },
      markInitComplete: true,
    });
    const before = projectionBytes();

    await expect(
      projectManagedWorkspace({
        sessionCtx: sessionCtx(),
        workspace,
        agentName: "slot-agent",
        runtimeProvider: "codex",
        providerSkillRoots: TEST_PROVIDER_SKILL_ROOTS,
        runtimeConfig: null,
        payload,
        payloadResolved: true,
        bundledSkillsRoot,
        contextTree: { kind: "none", path: null, repoUrl: null, branch: null },
        markInitComplete: true,
      }),
    ).rejects.toBeInstanceOf(ManagedSkillsUnsafeDiscoveryError);
    expect(projectionBytes()).toEqual(before);
  });

  it("requires handler replacement instead of mixing current Remote B into a handler captured on A", async () => {
    await projectManagedWorkspace({
      sessionCtx: sessionCtx(),
      workspace,
      agentName: "slot-agent",
      runtimeProvider: "codex",
      providerSkillRoots: TEST_PROVIDER_SKILL_ROOTS,
      runtimeConfig: null,
      payload,
      payloadResolved: true,
      bundledSkillsRoot,
      contextTree: {
        kind: "remote",
        path: join(workspace, "context-tree"),
        repoUrl: "git@github.com:acme/tree-a.git",
        branch: "main",
      },
      markInitComplete: true,
    });
    const restartCtx = sessionCtx();
    (restartCtx.sdk as unknown as { getAgentContextTreeConfig: ReturnType<typeof vi.fn> }).getAgentContextTreeConfig =
      vi.fn(async () => ({
        bindingState: "bound",
        repo: "git@github.com:acme/tree-b.git",
        branch: "release",
        provider: "github",
      }));

    const before = projectionBytes();
    await expect(
      projectManagedWorkspace({
        sessionCtx: restartCtx,
        workspace,
        agentName: "slot-agent",
        runtimeProvider: "codex",
        providerSkillRoots: TEST_PROVIDER_SKILL_ROOTS,
        runtimeConfig: null,
        payload,
        payloadResolved: true,
        bundledSkillsRoot,
        contextTree: {
          kind: "remote",
          path: join(workspace, "context-tree"),
          repoUrl: "git@github.com:acme/tree-a.git",
          branch: "main",
        },
        markInitComplete: false,
        reresolveSource: true,
      }),
    ).rejects.toBeInstanceOf(ContextSourceTransitionError);
    expect(projectionBytes()).toEqual(before);
  });

  it("does not let a stale Remote A config refresh overwrite a completed Remote B projection", async () => {
    const common = {
      sessionCtx: sessionCtx(),
      workspace,
      agentName: "slot-agent",
      runtimeProvider: "codex" as const,
      providerSkillRoots: TEST_PROVIDER_SKILL_ROOTS,
      runtimeConfig: { version: 0, payload } as unknown as AgentRuntimeConfig,
      payload,
      payloadResolved: true,
      bundledSkillsRoot,
      markInitComplete: true,
    };
    const remoteA = {
      kind: "remote" as const,
      path: join(workspace, "context-tree"),
      repoUrl: "git@github.com:acme/tree-a.git",
      branch: "main",
    };
    await projectManagedWorkspace({ ...common, contextTree: remoteA });
    await projectManagedWorkspace({
      ...common,
      contextTree: { ...remoteA, repoUrl: "git@github.com:acme/tree-b.git", branch: "release" },
    });
    const before = projectionBytes();

    await expect(
      projectManagedWorkspace({
        ...common,
        contextTree: remoteA,
        existingPayload: payload,
        markInitComplete: false,
      }),
    ).rejects.toBeInstanceOf(ContextSourceTransitionError);
    expect(projectionBytes()).toEqual(before);
    expect(readFileSync(join(workspace, "AGENTS.md"), "utf8")).toContain("git@github.com:acme/tree-b.git");
  });

  it("rechecks authority inside the publication lock after a stale A publisher was paused", async () => {
    const runtimeConfig = { version: 0, payload } as unknown as AgentRuntimeConfig;
    const common = {
      workspace,
      agentName: "slot-agent",
      runtimeProvider: "codex" as const,
      providerSkillRoots: TEST_PROVIDER_SKILL_ROOTS,
      runtimeConfig,
      payload,
      payloadResolved: true,
      bundledSkillsRoot,
      markInitComplete: true,
    };
    const remoteA = {
      kind: "remote" as const,
      path: join(workspace, "context-tree"),
      repoUrl: "git@github.com:acme/tree-a.git",
      branch: "main",
    };
    const remoteB = { ...remoteA, repoUrl: "git@github.com:acme/tree-b.git", branch: "release" };
    await projectManagedWorkspace({ ...common, sessionCtx: sessionCtx(), contextTree: remoteA });

    let release = (): void => {};
    let reached = (): void => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const waiting = new Promise<void>((resolve) => {
      reached = resolve;
    });
    let pauseNext = true;
    setSourcePublicationTestHook(async () => {
      if (!pauseNext) return;
      pauseNext = false;
      reached();
      await gate;
    });
    let authoritative = remoteA;
    const staleCtx = sessionCtx();
    (staleCtx.sdk as unknown as { getAgentContextTreeConfig: ReturnType<typeof vi.fn> }).getAgentContextTreeConfig =
      vi.fn(async () => ({
        bindingState: "bound",
        repo: authoritative.repoUrl,
        branch: authoritative.branch,
        provider: "github",
      }));
    const stale = projectManagedWorkspace({
      ...common,
      sessionCtx: staleCtx,
      contextTree: remoteA,
      existingPayload: payload,
      reresolveSource: true,
      markInitComplete: false,
    });
    await waiting;
    authoritative = remoteB;
    await projectManagedWorkspace({ ...common, sessionCtx: sessionCtx(), contextTree: remoteB });
    const before = workspaceEntrySnapshot();
    release();

    await expect(stale).rejects.toBeInstanceOf(ContextSourceTransitionError);
    expect(workspaceEntrySnapshot()).toEqual(before);
    expect(readFileSync(join(workspace, "AGENTS.md"), "utf8")).toContain(remoteB.repoUrl);
  });

  it.each([
    "unbound",
    "unknown",
  ] as const)("preserves every non-none projection byte when provider restart authority becomes %s", async (reason) => {
    await projectManagedWorkspace({
      sessionCtx: sessionCtx(),
      workspace,
      agentName: "slot-agent",
      runtimeProvider: "codex",
      providerSkillRoots: TEST_PROVIDER_SKILL_ROOTS,
      runtimeConfig: null,
      payload,
      payloadResolved: true,
      bundledSkillsRoot,
      contextTree: {
        kind: "remote",
        path: join(workspace, "context-tree"),
        repoUrl: "git@github.com:acme/tree-a.git",
        branch: "main",
      },
      markInitComplete: true,
    });
    const before = projectionBytes();
    const restartCtx = sessionCtx();
    (restartCtx.sdk as unknown as { getAgentContextTreeConfig: ReturnType<typeof vi.fn> }).getAgentContextTreeConfig =
      reason === "unbound"
        ? vi.fn(async () => ({ bindingState: "unbound", repo: null, branch: "main", provider: null }))
        : vi.fn(async () => {
            throw new Error("offline");
          });

    await expect(
      projectManagedWorkspace({
        sessionCtx: restartCtx,
        workspace,
        agentName: "slot-agent",
        runtimeProvider: "codex",
        providerSkillRoots: TEST_PROVIDER_SKILL_ROOTS,
        runtimeConfig: null,
        payload,
        payloadResolved: true,
        bundledSkillsRoot,
        contextTree: {
          kind: "remote",
          path: join(workspace, "context-tree"),
          repoUrl: "git@github.com:acme/tree-a.git",
          branch: "main",
        },
        markInitComplete: false,
        reresolveSource: true,
      }),
    ).rejects.toBeInstanceOf(ContextSourceTransitionError);
    expect(projectionBytes()).toEqual(before);
  });

  it("publishes public Skills and none briefing only for an initial absent-latch none admission", async () => {
    await projectManagedWorkspace({
      sessionCtx: sessionCtx(),
      workspace,
      agentName: "slot-agent",
      runtimeProvider: "codex",
      providerSkillRoots: TEST_PROVIDER_SKILL_ROOTS,
      runtimeConfig: null,
      payload,
      payloadResolved: true,
      bundledSkillsRoot,
      contextTree: { kind: "none", path: null, repoUrl: null, branch: null },
      markInitComplete: true,
    });
    const readSkill = readFileSync(
      join(workspace, providerSkillRoot("codex", TEST_PROVIDER_SKILL_ROOTS), "first-tree-read", "SKILL.md"),
      "utf8",
    );
    expect(readSkill).toContain("# first-tree-read\n");
    expect(readSkill).not.toContain("# first-tree-read local");
    expect(JSON.parse(readFileSync(join(workspace, IDENTITY_JSON_REL), "utf8"))).toMatchObject({
      agentName: "slot-agent",
      contextSourceKind: "none",
      contextTreePath: null,
    });
    expect(existsSync(join(workspace, ".first-tree", "workspace.json"))).toBe(false);
  });

  it.each([
    {
      name: "corrupt read Skill bytes",
      mutate: (root: string) =>
        writeFileSync(join(root, ".agents", "skills", "first-tree-read", "SKILL.md"), "corrupt\n"),
    },
    {
      name: "drifted additional managed target",
      mutate: (root: string) =>
        writeFileSync(join(root, ".agents", "skills", "first-tree-welcome", "SKILL.md"), "drifted\n"),
    },
    {
      name: "invalid v2 ledger",
      mutate: (root: string) => writeFileSync(join(root, MANAGED_STATE_REL), '{"schemaVersion":2}\n'),
    },
    {
      name: "ledger missing another core target",
      mutate: (root: string) => {
        const ledgerPath = join(root, MANAGED_STATE_REL);
        const ledger = JSON.parse(readFileSync(ledgerPath, "utf8")) as { skills: Array<{ key: string }> };
        ledger.skills = ledger.skills.filter((entry) => entry.key !== "core:first-tree-welcome");
        writeFileSync(ledgerPath, `${JSON.stringify(ledger)}\n`);
      },
    },
    {
      name: "ledger contains an extra retired core target",
      mutate: (root: string) => {
        const ledgerPath = join(root, MANAGED_STATE_REL);
        const ledger = JSON.parse(readFileSync(ledgerPath, "utf8")) as {
          skills: Array<Record<string, unknown>>;
        };
        const template = ledger.skills.find((entry) => entry.key === "core:first-tree-read");
        if (!template) throw new Error("missing read ledger fixture");
        ledger.skills.push({
          ...template,
          key: "core:first-tree-guide",
          requestedSlug: "first-tree-guide",
          effectiveName: "first-tree-guide",
          target: ".agents/skills/first-tree-guide",
        });
        writeFileSync(ledgerPath, `${JSON.stringify(ledger)}\n`);
      },
    },
    {
      name: "unledgered retired core discovery directory",
      mutate: (root: string) => mkdirSync(join(root, ".agents", "skills", "first-tree-guide"), { recursive: true }),
    },
    {
      name: "missing v2 ledger",
      mutate: (root: string) => rmSync(join(root, MANAGED_STATE_REL)),
    },
    {
      name: "unfinished managed journal",
      mutate: (root: string) => writeFileSync(join(root, MANAGED_SKILLS_JOURNAL_REL), "partial\n"),
    },
    {
      name: "orphaned managed staging directory",
      mutate: (root: string) => mkdirSync(join(root, ".agents", "skills", ".first-tree-read.ft-deadbeef.staging")),
    },
    {
      name: "mixed-provider ledger target",
      mutate: (root: string) => {
        const ledgerPath = join(root, MANAGED_STATE_REL);
        const ledger = JSON.parse(readFileSync(ledgerPath, "utf8")) as {
          skills: Array<{ key: string; target: string }>;
        };
        const entry = ledger.skills.find((candidate) => candidate.key === "core:first-tree-welcome");
        if (!entry) throw new Error("missing welcome ledger fixture");
        entry.target = ".claude/skills/first-tree-welcome";
        writeFileSync(ledgerPath, `${JSON.stringify(ledger)}\n`);
      },
    },
    {
      name: "inactive-provider Core orphan",
      mutate: (root: string) => mkdirSync(join(root, ".claude", "skills", "first-tree-read"), { recursive: true }),
    },
    {
      name: "mis-targeted Claude briefing",
      mutate: (root: string) => {
        rmSync(join(root, "CLAUDE.md"));
        symlinkSync("elsewhere.md", join(root, "CLAUDE.md"));
      },
    },
    {
      name: "identity from another Agent",
      mutate: (root: string) => {
        const identityPath = join(root, IDENTITY_JSON_REL);
        const identity = JSON.parse(readFileSync(identityPath, "utf8")) as { agentId: string };
        identity.agentId = "019d9a97-90b0-716b-8317-a8c0be843099";
        writeFileSync(identityPath, `${JSON.stringify(identity)}\n`);
      },
    },
  ])("preserves every projection byte and entry for $name", async ({ mutate }) => {
    const noneParams = {
      sessionCtx: sessionCtx(),
      workspace,
      agentName: "slot-agent",
      runtimeProvider: "codex" as const,
      providerSkillRoots: TEST_PROVIDER_SKILL_ROOTS,
      runtimeConfig: null,
      payload,
      payloadResolved: true,
      bundledSkillsRoot,
      contextTree: { kind: "none" as const, path: null, repoUrl: null, branch: null },
      markInitComplete: true,
    };
    await projectManagedWorkspace(noneParams);
    mutate(workspace);
    const before = workspaceEntrySnapshot();

    await expect(projectManagedWorkspace(noneParams)).rejects.toBeInstanceOf(ManagedSkillsUnsafeDiscoveryError);
    expect(workspaceEntrySnapshot()).toEqual(before);
  });

  it("requires exact marker schema, key, and revision before admitting a none LKG", async () => {
    const noneParams = {
      sessionCtx: sessionCtx(),
      workspace,
      agentName: "slot-agent",
      runtimeProvider: "codex" as const,
      providerSkillRoots: TEST_PROVIDER_SKILL_ROOTS,
      runtimeConfig: null,
      payload,
      payloadResolved: true,
      bundledSkillsRoot,
      contextTree: { kind: "none" as const, path: null, repoUrl: null, branch: null },
      markInitComplete: true,
    };
    await projectManagedWorkspace(noneParams);
    const markerPath = join(workspace, ".agents", "skills", "first-tree-read", ".first-tree-managed.json");
    writeFileSync(markerPath, `${JSON.stringify({ revision: "1.0.0" })}\n`);
    const before = workspaceEntrySnapshot();

    await expect(projectManagedWorkspace(noneParams)).rejects.toBeInstanceOf(ManagedSkillsUnsafeDiscoveryError);
    expect(workspaceEntrySnapshot()).toEqual(before);
  });

  it("rejects an arbitrary non-empty AGENTS file as a none projection", async () => {
    const noneParams = {
      sessionCtx: sessionCtx(),
      workspace,
      agentName: "slot-agent",
      runtimeProvider: "codex" as const,
      providerSkillRoots: TEST_PROVIDER_SKILL_ROOTS,
      runtimeConfig: null,
      payload,
      payloadResolved: true,
      bundledSkillsRoot,
      contextTree: { kind: "none" as const, path: null, repoUrl: null, branch: null },
      markInitComplete: true,
    };
    await projectManagedWorkspace(noneParams);
    writeFileSync(join(workspace, "AGENTS.md"), "not a generated none briefing\n");
    const before = workspaceEntrySnapshot();

    await expect(projectManagedWorkspace(noneParams)).rejects.toBeInstanceOf(ManagedSkillsUnsafeDiscoveryError);
    expect(workspaceEntrySnapshot()).toEqual(before);
  });

  it("admits but does not re-publish a complete none projection after a later remote observation", async () => {
    const noneParams = {
      sessionCtx: sessionCtx(),
      workspace,
      agentName: "slot-agent",
      runtimeProvider: "codex" as const,
      providerSkillRoots: TEST_PROVIDER_SKILL_ROOTS,
      runtimeConfig: null,
      payload,
      payloadResolved: true,
      bundledSkillsRoot,
      contextTree: { kind: "none" as const, path: null, repoUrl: null, branch: null },
      markInitComplete: true,
    };
    await projectManagedWorkspace(noneParams);
    await recordRemoteBindingObservation(workspace, {
      repoUrl: "git@github.com:acme/observed.git",
      branch: "main",
    });
    const before = workspaceEntrySnapshot();
    await expect(projectManagedWorkspace({ ...noneParams, existingPayload: payload })).resolves.toMatchObject({
      briefing: expect.any(String),
    });
    expect(workspaceEntrySnapshot()).toEqual(before);
    expect(
      JSON.parse(readFileSync(join(workspace, ".first-tree-workspace", "source-state.json"), "utf8")),
    ).toMatchObject({
      remoteObserved: true,
      repoUrl: "git@github.com:acme/observed.git",
    });
  });

  it("admits a complete none projection without rewriting an unreadable future latch", async () => {
    const noneParams = {
      sessionCtx: sessionCtx(),
      workspace,
      agentName: "slot-agent",
      runtimeProvider: "codex" as const,
      providerSkillRoots: TEST_PROVIDER_SKILL_ROOTS,
      runtimeConfig: null,
      payload,
      payloadResolved: true,
      bundledSkillsRoot,
      contextTree: { kind: "none" as const, path: null, repoUrl: null, branch: null },
      markInitComplete: true,
    };
    await projectManagedWorkspace(noneParams);
    const statePath = join(workspace, ".first-tree-workspace", "source-state.json");
    const futureBytes = `${JSON.stringify({
      schemaVersion: 2,
      remoteObserved: true,
      observedAt: "2026-08-13T00:00:00.000Z",
      repoUrl: "git@github.com:future/tree.git",
      branch: "main",
    })}\n`;
    writeFileSync(statePath, futureBytes);
    const before = workspaceEntrySnapshot();

    await expect(projectManagedWorkspace({ ...noneParams, existingPayload: payload })).resolves.toMatchObject({
      briefing: expect.any(String),
    });
    expect(workspaceEntrySnapshot()).toEqual(before);
    expect(readFileSync(statePath, "utf8")).toBe(futureBytes);
  });

  it("restores verified Team Skill metadata when admitting a complete none projection behind a latch", async () => {
    const teamPayload = {
      ...payload,
      resourceSkills: [
        {
          resourceId: "resource-review",
          name: "Review",
          description: "Review correctness before style.",
          body: "# Review\n\nCheck correctness first.",
          metadata: {},
        },
      ],
    };
    const runtimeConfig = { version: 7, payload: teamPayload } as unknown as AgentRuntimeConfig;
    const noneParams = {
      sessionCtx: sessionCtx(),
      workspace,
      agentName: "slot-agent",
      runtimeProvider: "codex" as const,
      providerSkillRoots: TEST_PROVIDER_SKILL_ROOTS,
      runtimeConfig,
      payload: teamPayload,
      payloadResolved: true,
      bundledSkillsRoot,
      contextTree: { kind: "none" as const, path: null, repoUrl: null, branch: null },
      markInitComplete: true,
    };
    const initial = await projectManagedWorkspace(noneParams);
    expect(initial.briefing).toContain("Review correctness before style.");
    await recordRemoteBindingObservation(workspace, {
      repoUrl: "git@github.com:acme/observed.git",
      branch: "main",
    });
    const before = workspaceEntrySnapshot();

    await expect(projectManagedWorkspace({ ...noneParams, existingPayload: teamPayload })).resolves.toMatchObject({
      briefing: expect.stringContaining("Review correctness before style."),
    });
    expect(workspaceEntrySnapshot()).toEqual(before);
  });

  it("does not let a stale same-source runtime config lower the managed projection fence", async () => {
    const v2 = { version: 2, payload } as unknown as AgentRuntimeConfig;
    const base = {
      sessionCtx: sessionCtx(),
      workspace,
      agentName: "slot-agent",
      runtimeProvider: "codex" as const,
      providerSkillRoots: TEST_PROVIDER_SKILL_ROOTS,
      payload,
      payloadResolved: true,
      bundledSkillsRoot,
      contextTree: { kind: "none" as const, path: null, repoUrl: null, branch: null },
      markInitComplete: true,
    };
    await projectManagedWorkspace({ ...base, runtimeConfig: v2 });
    const before = workspaceEntrySnapshot();

    await expect(
      projectManagedWorkspace({
        ...base,
        runtimeConfig: { version: 1, payload } as unknown as AgentRuntimeConfig,
      }),
    ).rejects.toThrow("older than managed projection v2");
    expect(workspaceEntrySnapshot()).toEqual(before);
  });

  it("uses the highest managed config fence across a legacy target and its Agent authority root", async () => {
    const legacyWorkspace = join(sandbox, "legacy-config-fence-chat");
    mkdirSync(legacyWorkspace);
    const contextTree = {
      kind: "remote" as const,
      path: join(workspace, "context-tree"),
      repoUrl: "git@github.com:acme/tree.git",
      branch: "main",
    };
    const common = {
      sessionCtx: sessionCtx(),
      agentName: "slot-agent",
      runtimeProvider: "codex" as const,
      providerSkillRoots: TEST_PROVIDER_SKILL_ROOTS,
      payload,
      payloadResolved: true,
      bundledSkillsRoot,
      contextTree,
      markInitComplete: true,
    };

    await projectManagedWorkspace({
      ...common,
      workspace,
      runtimeConfig: { version: 2, payload } as unknown as AgentRuntimeConfig,
    });
    await projectManagedWorkspace({
      ...common,
      workspace: legacyWorkspace,
      runtimeConfig: { version: 1, payload } as unknown as AgentRuntimeConfig,
    });
    const authorityBefore = workspaceEntrySnapshot(workspace);
    const legacyBefore = workspaceEntrySnapshot(legacyWorkspace);

    await expect(
      projectManagedWorkspace({
        ...common,
        workspace: legacyWorkspace,
        sourceAuthorityRoot: workspace,
        runtimeConfig: { version: 1, payload } as unknown as AgentRuntimeConfig,
        existingPayload: payload,
        markInitComplete: false,
        writeIdentityAndManifest: false,
      }),
    ).rejects.toThrow("older than managed projection v2");
    expect(workspaceEntrySnapshot(workspace)).toEqual(authorityBefore);
    expect(workspaceEntrySnapshot(legacyWorkspace)).toEqual(legacyBefore);
  });

  it("preserves an existing managed projection when runtime config is unavailable", async () => {
    const base = {
      sessionCtx: sessionCtx(),
      workspace,
      agentName: "slot-agent",
      runtimeProvider: "codex" as const,
      providerSkillRoots: TEST_PROVIDER_SKILL_ROOTS,
      payload,
      payloadResolved: true,
      bundledSkillsRoot,
      contextTree: { kind: "none" as const, path: null, repoUrl: null, branch: null },
      markInitComplete: true,
    };
    await projectManagedWorkspace({
      ...base,
      runtimeConfig: { version: 3, payload } as unknown as AgentRuntimeConfig,
    });
    const before = workspaceEntrySnapshot();

    await expect(projectManagedWorkspace({ ...base, runtimeConfig: null })).rejects.toThrow(
      "runtime config is unavailable",
    );
    expect(workspaceEntrySnapshot()).toEqual(before);
  });

  it("keeps Local LKG bytes unchanged when later admission is network unknown", async () => {
    await projectManagedWorkspace({
      sessionCtx: sessionCtx(),
      workspace,
      agentName: "slot-agent",
      runtimeProvider: "codex",
      providerSkillRoots: TEST_PROVIDER_SKILL_ROOTS,
      runtimeConfig: null,
      payload,
      payloadResolved: true,
      bundledSkillsRoot,
      contextTree: {
        kind: "local",
        path: join(workspace, "local-context"),
        repoUrl: null,
        branch: null,
      },
      markInitComplete: true,
    });
    const before = workspaceEntrySnapshot();
    expect(
      readFileSync(
        join(workspace, providerSkillRoot("codex", TEST_PROVIDER_SKILL_ROOTS), "first-tree-read", "SKILL.md"),
        "utf8",
      ),
    ).toContain("# first-tree-read local");

    await expect(
      projectManagedWorkspace({
        sessionCtx: sessionCtx(),
        workspace,
        agentName: "slot-agent",
        runtimeProvider: "codex",
        providerSkillRoots: TEST_PROVIDER_SKILL_ROOTS,
        runtimeConfig: null,
        payload,
        payloadResolved: true,
        bundledSkillsRoot,
        contextTree: { kind: "none", path: null, repoUrl: null, branch: null },
        markInitComplete: true,
      }),
    ).rejects.toBeInstanceOf(ManagedSkillsUnsafeDiscoveryError);
    expect(workspaceEntrySnapshot()).toEqual(before);
  });

  it("does not rewrite Remote LKG, Skills, or source-state when none follows an observed latch", async () => {
    await projectManagedWorkspace({
      sessionCtx: sessionCtx(),
      workspace,
      agentName: "slot-agent",
      runtimeProvider: "codex",
      providerSkillRoots: TEST_PROVIDER_SKILL_ROOTS,
      runtimeConfig: null,
      payload,
      payloadResolved: true,
      bundledSkillsRoot,
      contextTree: {
        kind: "remote",
        path: join(workspace, "context-tree"),
        repoUrl: "git@github.com:acme/observed.git",
        branch: "main",
      },
      markInitComplete: true,
    });
    const before = workspaceEntrySnapshot();
    const latchBefore = readFileSync(join(workspace, ".first-tree-workspace", "source-state.json"), "utf8");

    await expect(
      projectManagedWorkspace({
        sessionCtx: sessionCtx(),
        workspace,
        agentName: "slot-agent",
        runtimeProvider: "codex",
        providerSkillRoots: TEST_PROVIDER_SKILL_ROOTS,
        runtimeConfig: null,
        payload,
        payloadResolved: true,
        bundledSkillsRoot,
        contextTree: { kind: "none", path: null, repoUrl: null, branch: null },
        markInitComplete: true,
      }),
    ).rejects.toBeInstanceOf(ManagedSkillsUnsafeDiscoveryError);
    expect(workspaceEntrySnapshot()).toEqual(before);
    expect(readFileSync(join(workspace, ".first-tree-workspace", "source-state.json"), "utf8")).toBe(latchBefore);
  });

  it("stops before any Skill or metadata mutation when source-state is future or corrupt", async () => {
    await projectManagedWorkspace({
      sessionCtx: sessionCtx(),
      workspace,
      agentName: "slot-agent",
      runtimeProvider: "codex",
      providerSkillRoots: TEST_PROVIDER_SKILL_ROOTS,
      runtimeConfig: null,
      payload,
      payloadResolved: true,
      bundledSkillsRoot,
      contextTree: {
        kind: "local",
        path: join(workspace, "local-context"),
        repoUrl: null,
        branch: null,
      },
      markInitComplete: true,
    });
    const statePath = join(workspace, ".first-tree-workspace", "source-state.json");
    const futureBytes = `${JSON.stringify({
      schemaVersion: 2,
      remoteObserved: true,
      observedAt: "2026-08-13T00:00:00.000Z",
      repoUrl: "git@github.com:future/tree.git",
      branch: "main",
    })}\n`;
    writeFileSync(statePath, futureBytes);
    const before = workspaceEntrySnapshot();

    await expect(
      projectManagedWorkspace({
        sessionCtx: sessionCtx(),
        workspace,
        agentName: "slot-agent",
        runtimeProvider: "codex",
        providerSkillRoots: TEST_PROVIDER_SKILL_ROOTS,
        runtimeConfig: null,
        payload,
        payloadResolved: true,
        bundledSkillsRoot,
        contextTree: { kind: "none", path: null, repoUrl: null, branch: null },
        markInitComplete: true,
      }),
    ).rejects.toBeInstanceOf(ManagedSkillsUnsafeDiscoveryError);
    await expect(
      projectManagedWorkspace({
        sessionCtx: sessionCtx(),
        workspace,
        agentName: "slot-agent",
        runtimeProvider: "codex",
        providerSkillRoots: TEST_PROVIDER_SKILL_ROOTS,
        runtimeConfig: null,
        payload,
        payloadResolved: true,
        bundledSkillsRoot,
        contextTree: {
          kind: "local",
          path: join(workspace, "local-context"),
          repoUrl: null,
          branch: null,
        },
        markInitComplete: true,
      }),
    ).rejects.toBeInstanceOf(ManagedSkillsUnsafeDiscoveryError);
    await expect(
      projectManagedWorkspace({
        sessionCtx: sessionCtx(),
        workspace,
        agentName: "slot-agent",
        runtimeProvider: "codex",
        providerSkillRoots: TEST_PROVIDER_SKILL_ROOTS,
        runtimeConfig: null,
        payload,
        payloadResolved: true,
        bundledSkillsRoot,
        contextTree: {
          kind: "remote",
          path: join(workspace, "context-tree"),
          repoUrl: "git@github.com:acme/tree.git",
          branch: "main",
        },
        markInitComplete: true,
      }),
    ).rejects.toBeInstanceOf(ManagedSkillsUnsafeDiscoveryError);
    expect(workspaceEntrySnapshot()).toEqual(before);
    expect(readFileSync(statePath, "utf8")).toBe(futureBytes);
  });

  it("fail-closes incomplete explicit remote coordinates before any Skill write", async () => {
    await expect(
      projectManagedWorkspace({
        sessionCtx: sessionCtx(),
        workspace,
        agentName: "slot-agent",
        runtimeProvider: "codex",
        providerSkillRoots: TEST_PROVIDER_SKILL_ROOTS,
        runtimeConfig: null,
        payload,
        payloadResolved: true,
        bundledSkillsRoot,
        contextTree: {
          kind: "remote",
          path: join(workspace, "context-tree"),
          repoUrl: "git@github.com:acme/tree.git",
          branch: null,
        },
        markInitComplete: true,
      }),
    ).rejects.toBeInstanceOf(ManagedSkillsUnsafeDiscoveryError);
    expect(existsSync(join(workspace, providerSkillRoot("codex", TEST_PROVIDER_SKILL_ROOTS), "first-tree-read"))).toBe(
      false,
    );
    expect(existsSync(join(workspace, IDENTITY_JSON_REL))).toBe(false);
    expect(existsSync(join(workspace, "AGENTS.md"))).toBe(false);
    expect(existsSync(join(workspace, ".first-tree", "workspace.json"))).toBe(false);
    expect(existsSync(join(workspace, INIT_COMPLETE_SENTINEL_REL))).toBe(false);
  });

  it("does not create a source lock or latch through a .first-tree-workspace symlink", async () => {
    const external = join(sandbox, "external-runtime");
    mkdirSync(external);
    writeFileSync(join(external, "keep.txt"), "untouched\n");
    symlinkSync(external, join(workspace, ".first-tree-workspace"));

    await expect(withSourcePublicationLock(workspace, async () => "ok")).rejects.toThrow(/must not be a symlink/);
    await expect(
      recordRemoteBindingObservation(workspace, { repoUrl: "git@github.com:acme/tree.git", branch: "main" }),
    ).rejects.toThrow(/must not be a symlink/);
    await expect(
      projectManagedWorkspace({
        sessionCtx: sessionCtx(),
        workspace,
        agentName: "slot-agent",
        runtimeProvider: "codex",
        providerSkillRoots: TEST_PROVIDER_SKILL_ROOTS,
        runtimeConfig: null,
        payload,
        payloadResolved: true,
        bundledSkillsRoot,
        contextTree: {
          kind: "remote",
          path: join(workspace, "context-tree"),
          repoUrl: "git@github.com:acme/tree.git",
          branch: "main",
        },
        markInitComplete: true,
      }),
    ).rejects.toThrow(/must not be a symlink/);

    expect(readFileSync(join(external, "keep.txt"), "utf8")).toBe("untouched\n");
    expect(existsSync(join(external, "context-source.lock"))).toBe(false);
    expect(existsSync(join(external, "source-state.json"))).toBe(false);
    expect(existsSync(join(external, "managed-skills.lock"))).toBe(false);
    expect(existsSync(join(workspace, IDENTITY_JSON_REL))).toBe(false);
  });

  it("rejects an existing workspace reached through a symlinked ancestor before publication", async () => {
    const realParent = join(sandbox, "real-parent");
    const linkedParent = join(sandbox, "linked-parent");
    const realWorkspace = join(realParent, "workspace");
    mkdirSync(realWorkspace, { recursive: true });
    symlinkSync(realParent, linkedParent);
    const escapedWorkspace = join(linkedParent, "workspace");

    await expect(withSourcePublicationLock(escapedWorkspace, async () => "ok")).rejects.toThrow(
      /must not traverse a symlinked or aliased ancestor/,
    );
    expect(existsSync(join(realWorkspace, ".first-tree-workspace"))).toBe(false);
  });

  it("does not mutate target projection entries before unsafe none admission fails", async () => {
    mkdirSync(join(workspace, ".first-tree-workspace"), { recursive: true });
    writeFileSync(
      join(workspace, IDENTITY_JSON_REL),
      `${JSON.stringify({ agentId: "agent-1", agentName: "slot-agent", contextSourceKind: "none", contextTreePath: null })}\n`,
    );
    const before = projectionBytes();
    expect(existsSync(join(workspace, ".first-tree"))).toBe(false);

    await expect(
      projectManagedWorkspace({
        sessionCtx: sessionCtx(),
        workspace,
        agentName: "slot-agent",
        runtimeProvider: "codex",
        providerSkillRoots: TEST_PROVIDER_SKILL_ROOTS,
        runtimeConfig: null,
        payload,
        payloadResolved: true,
        bundledSkillsRoot,
        contextTree: { kind: "none", path: null, repoUrl: null, branch: null },
        markInitComplete: true,
      }),
    ).rejects.toBeInstanceOf(ManagedSkillsUnsafeDiscoveryError);
    expect(projectionBytes()).toEqual(before);
    expect(existsSync(join(workspace, ".first-tree"))).toBe(false);
  });

  it("records Remote first, then fails closed without writing through a manifest-parent symlink", async () => {
    const external = join(sandbox, "external-manifest-parent");
    mkdirSync(external);
    writeFileSync(join(external, "keep.txt"), "untouched\n");
    symlinkSync(external, join(workspace, ".first-tree"));

    await expect(
      projectManagedWorkspace({
        sessionCtx: sessionCtx(),
        workspace,
        agentName: "slot-agent",
        runtimeProvider: "codex",
        providerSkillRoots: TEST_PROVIDER_SKILL_ROOTS,
        runtimeConfig: null,
        payload,
        payloadResolved: true,
        bundledSkillsRoot,
        contextTree: {
          kind: "remote",
          path: join(workspace, "context-tree"),
          repoUrl: "git@github.com:acme/tree.git",
          branch: "main",
        },
        markInitComplete: true,
      }),
    ).rejects.toThrow(/must not be a symlink/);

    expect(
      JSON.parse(readFileSync(join(workspace, ".first-tree-workspace", "source-state.json"), "utf8")),
    ).toMatchObject({
      remoteObserved: true,
      repoUrl: "git@github.com:acme/tree.git",
    });
    expect(readFileSync(join(external, "keep.txt"), "utf8")).toBe("untouched\n");
    expect(existsSync(join(external, "workspace.json"))).toBe(false);
    expect(existsSync(join(workspace, IDENTITY_JSON_REL))).toBe(false);
    expect(existsSync(join(workspace, "AGENTS.md"))).toBe(false);
  });

  it("atomically replaces a matching identity symlink instead of trusting or following it", async () => {
    const externalIdentity = join(sandbox, "external-identity.json");
    const externalBriefing = join(sandbox, "external-briefing.md");
    const externalSentinel = join(sandbox, "external-sentinel.json");
    mkdirSync(join(workspace, ".first-tree-workspace"), { recursive: true });
    const externalBytes = `${JSON.stringify(
      {
        agentId: "019d9a97-90b0-716b-8317-a8c0be8430d7",
        agentName: "slot-agent",
        displayName: "Display Name Must Not Become agentName",
        type: "agent",
        visibility: "organization",
        delegateMention: null,
        metadata: {},
        serverUrl: "https://first-tree.example.test",
        contextTreePath: join(workspace, "context-tree"),
        contextSourceKind: "remote",
      },
      null,
      2,
    )}\n`;
    writeFileSync(externalIdentity, externalBytes);
    symlinkSync(externalIdentity, join(workspace, IDENTITY_JSON_REL));
    writeFileSync(externalBriefing, "external briefing must remain\n");
    symlinkSync(externalBriefing, join(workspace, "AGENTS.md"));
    writeFileSync(externalSentinel, "external sentinel must remain\n");
    symlinkSync(externalSentinel, join(workspace, INIT_COMPLETE_SENTINEL_REL));

    await projectManagedWorkspace({
      sessionCtx: sessionCtx(),
      workspace,
      agentName: "slot-agent",
      runtimeProvider: "codex",
      providerSkillRoots: TEST_PROVIDER_SKILL_ROOTS,
      runtimeConfig: null,
      payload,
      payloadResolved: true,
      bundledSkillsRoot,
      contextTree: {
        kind: "remote",
        path: join(workspace, "context-tree"),
        repoUrl: "git@github.com:acme/tree.git",
        branch: "main",
      },
      markInitComplete: true,
    });

    expect(lstatSync(join(workspace, IDENTITY_JSON_REL)).isSymbolicLink()).toBe(false);
    expect(lstatSync(join(workspace, "AGENTS.md")).isSymbolicLink()).toBe(false);
    expect(lstatSync(join(workspace, INIT_COMPLETE_SENTINEL_REL)).isSymbolicLink()).toBe(false);
    expect(JSON.parse(readFileSync(join(workspace, IDENTITY_JSON_REL), "utf8"))).toMatchObject({
      agentName: "slot-agent",
      contextSourceKind: "remote",
    });
    expect(readFileSync(externalIdentity, "utf8")).toBe(externalBytes);
    expect(readFileSync(externalBriefing, "utf8")).toBe("external briefing must remain\n");
    expect(readFileSync(externalSentinel, "utf8")).toBe("external sentinel must remain\n");
  });
});
