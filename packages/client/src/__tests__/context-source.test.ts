import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FirstTreeHubSDK } from "../cloud/sdk.js";
import {
  applyContextSourceToHandlerConfig,
  classifyAgentContextTreeInfo,
  contextSourceFromHandlerConfig,
  effectiveContextSourceKind,
  hasRemoteLatch,
  inspectRemoteLatch,
  recordRemoteBindingObservation,
  remoteGitAttributionFromSource,
  resolveAgentContextSource,
  SOURCE_STATE_REL,
} from "../runtime/context-source.js";

const workspaces: string[] = [];

afterEach(() => {
  vi.unstubAllGlobals();
  for (const workspace of workspaces.splice(0)) rmSync(workspace, { recursive: true, force: true });
});

function workspace(): string {
  const path = mkdtempSync(join(realpathSync(tmpdir()), "ft-context-source-"));
  workspaces.push(path);
  return path;
}

function sdk(config: unknown): FirstTreeHubSDK {
  return { getAgentContextTreeConfig: vi.fn(async () => config) } as unknown as FirstTreeHubSDK;
}

describe("classifyAgentContextTreeInfo", () => {
  it("fail-closes missing, conflicting, and invalid wire payloads", () => {
    expect(classifyAgentContextTreeInfo({ repo: null, branch: null })).toMatchObject({ status: "unknown" });
    expect(
      classifyAgentContextTreeInfo({ bindingState: "bound", repo: null, branch: "main", provider: null }),
    ).toMatchObject({
      status: "unknown",
    });
    expect(
      classifyAgentContextTreeInfo({
        bindingState: "unbound",
        repo: "git@github.com:acme/tree.git",
        branch: "main",
        provider: null,
      }),
    ).toMatchObject({ status: "unknown" });
    expect(
      classifyAgentContextTreeInfo({ bindingState: "unbound", repo: null, branch: null, provider: null }),
    ).toMatchObject({ status: "unknown" });
    expect(
      classifyAgentContextTreeInfo({ bindingState: "invalid", repo: null, branch: null, provider: null }),
    ).toMatchObject({
      status: "invalid",
    });
    expect(classifyAgentContextTreeInfo({ bindingState: "unbound", repo: null, branch: "main" })).toMatchObject({
      status: "unknown",
    });
    expect(
      classifyAgentContextTreeInfo({
        bindingState: "bound",
        repo: "git@github.com:acme/context-tree.git",
        provider: "github",
      }),
    ).toMatchObject({ status: "unknown" });
    expect(
      classifyAgentContextTreeInfo({ bindingState: "unbound", repo: null, branch: "main", provider: null }),
    ).toMatchObject({
      status: "unbound",
      branch: "main",
    });
    expect(
      classifyAgentContextTreeInfo({
        bindingState: "bound",
        repo: "git@github.com:acme/context-tree.git",
        branch: "main",
        provider: "github",
      }),
    ).toMatchObject({ status: "bound", repoUrl: "git@github.com:acme/context-tree.git", branch: "main" });
    expect(
      classifyAgentContextTreeInfo({
        bindingState: "bound",
        repo: "git@github.com:acme/context-tree.git",
        branch: "main",
        provider: null,
      }),
    ).toMatchObject({ status: "unknown" });
    expect(
      classifyAgentContextTreeInfo({
        bindingState: "bound",
        repo: "git@git.example.invalid:acme/tree.git",
        branch: "main",
        provider: null,
      }),
    ).toMatchObject({ status: "bound", repoUrl: "git@git.example.invalid:acme/tree.git", branch: "main" });
  });
});

describe("resolveAgentContextSource", () => {
  it("safely creates a missing fresh Agent home before authorizing Local", async () => {
    const parent = workspace();
    const root = join(parent, "fresh-agent");
    await expect(
      resolveAgentContextSource(
        sdk({ bindingState: "unbound", repo: null, branch: "main", provider: null }),
        root,
        vi.fn(),
      ),
    ).resolves.toEqual({ kind: "local", path: join(root, "local-context") });
    expect(lstatSync(root).isDirectory()).toBe(true);
  });

  it("does not activate Local when required Agent wire keys are missing", async () => {
    const root = workspace();
    await expect(
      resolveAgentContextSource(sdk({ bindingState: "unbound", repo: null, branch: "main" }), root, vi.fn()),
    ).resolves.toEqual({ kind: "none", reason: "unknown" });
    expect(existsSync(join(root, "local-context"))).toBe(false);

    await expect(
      resolveAgentContextSource(
        sdk({
          bindingState: "bound",
          repo: "git@github.com:acme/context-tree.git",
          provider: "github",
        }),
        root,
        vi.fn(),
      ),
    ).resolves.toEqual({ kind: "none", reason: "unknown" });
    expect(inspectRemoteLatch(root).status).toBe("absent");
  });

  it("treats SDK schema failure for missing provider or branch as unknown, not unbound", async () => {
    const fetchMock = vi.fn();
    fetchMock
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ bindingState: "unbound", repo: null, branch: "main" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            bindingState: "bound",
            repo: "https://github.com/acme/tree.git",
            provider: "github",
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      );
    vi.stubGlobal("fetch", fetchMock);
    const realSdk = new FirstTreeHubSDK({
      serverUrl: "https://first-tree.example/",
      agentId: "agent-1",
      userAgent: "first-tree-test",
      getAccessToken: () => "access-token",
    });

    const missingProvider = workspace();
    await expect(resolveAgentContextSource(realSdk, missingProvider, vi.fn())).resolves.toEqual({
      kind: "none",
      reason: "unknown",
    });
    expect(existsSync(join(missingProvider, "local-context"))).toBe(false);

    const missingBranch = workspace();
    await expect(resolveAgentContextSource(realSdk, missingBranch, vi.fn())).resolves.toEqual({
      kind: "none",
      reason: "unknown",
    });
    expect(inspectRemoteLatch(missingBranch).status).toBe("absent");
  });

  it("fail-closes symlinked workspace and runtime roots without writing through them", async () => {
    const parent = workspace();
    const externalWorkspace = join(parent, "external-workspace");
    const linkedWorkspace = join(parent, "linked-agent");
    mkdirSync(externalWorkspace);
    symlinkSync(externalWorkspace, linkedWorkspace);
    await expect(
      resolveAgentContextSource(
        sdk({ bindingState: "unbound", repo: null, branch: "main", provider: null }),
        linkedWorkspace,
        vi.fn(),
      ),
    ).rejects.toThrow(/must not be a symlink/);
    expect(lstatSync(linkedWorkspace).isSymbolicLink()).toBe(true);

    const root = workspace();
    const externalRuntime = join(parent, "external-runtime");
    mkdirSync(externalRuntime);
    symlinkSync(externalRuntime, join(root, ".first-tree-workspace"));
    await expect(
      recordRemoteBindingObservation(root, { repoUrl: "git@github.com:acme/tree.git", branch: "main" }),
    ).rejects.toThrow(/must not be a symlink/);
    expect(existsSync(join(externalRuntime, "source-state.json"))).toBe(false);
    expect(existsSync(join(externalRuntime, "context-source.lock"))).toBe(false);
  });

  it("activates Local only for authoritative unbound state without a latch", async () => {
    const root = workspace();
    await expect(
      resolveAgentContextSource(
        sdk({ bindingState: "unbound", repo: null, branch: "main", provider: null }),
        root,
        vi.fn(),
      ),
    ).resolves.toEqual({
      kind: "local",
      path: join(root, "local-context"),
    });
  });

  it("writes a monotonic remote latch and never reactivates Local afterwards", async () => {
    const root = workspace();
    const logs: string[] = [];
    await expect(
      resolveAgentContextSource(
        sdk({
          bindingState: "bound",
          repo: "git@github.com:acme/context-tree.git",
          branch: "main",
          provider: "github",
        }),
        root,
        (msg) => logs.push(msg),
      ),
    ).resolves.toMatchObject({ kind: "remote", repoUrl: "git@github.com:acme/context-tree.git" });
    expect(hasRemoteLatch(root)).toBe(true);
    const firstLatch = readFileSync(join(root, SOURCE_STATE_REL), "utf8");

    await expect(
      resolveAgentContextSource(
        sdk({ bindingState: "unbound", repo: null, branch: "main", provider: null }),
        root,
        (msg) => logs.push(msg),
      ),
    ).resolves.toEqual({ kind: "none", reason: "frozen" });
    expect(readFileSync(join(root, SOURCE_STATE_REL), "utf8")).toBe(firstLatch);
    expect(logs.some((line) => line.includes("remote binding was previously observed"))).toBe(true);
  });

  it("does not treat request failure or invalid state as unbound", async () => {
    const root = workspace();
    const failing = {
      getAgentContextTreeConfig: vi.fn(async () => {
        throw new Error("offline");
      }),
    } as unknown as FirstTreeHubSDK;
    await expect(resolveAgentContextSource(failing, root, vi.fn())).resolves.toEqual({
      kind: "none",
      reason: "unknown",
    });
    await expect(
      resolveAgentContextSource(
        sdk({ bindingState: "invalid", repo: null, branch: null, provider: null }),
        root,
        vi.fn(),
      ),
    ).resolves.toEqual({ kind: "none", reason: "invalid" });
    expect(hasRemoteLatch(root)).toBe(false);
  });

  it("keeps Git attribution empty for Local so telemetry cannot ingest the live path", () => {
    expect(remoteGitAttributionFromSource({ kind: "local", path: "/agent/local-context" })).toEqual({
      contextTreePath: null,
      contextTreeRepoUrl: null,
    });
  });

  it("prevents a stale Local handler config from overwriting a latched remote publication", async () => {
    const root = workspace();
    await resolveAgentContextSource(
      sdk({
        bindingState: "bound",
        repo: "git@github.com:acme/context-tree.git",
        branch: "main",
        provider: "github",
      }),
      root,
      vi.fn(),
    );
    const frozen = await resolveAgentContextSource(
      sdk({ bindingState: "unbound", repo: null, branch: "main", provider: null }),
      root,
      vi.fn(),
    );
    const config = applyContextSourceToHandlerConfig(
      {
        workspaceRoot: root,
        runtimeProvider: "codex",
        contextSourceKind: "local",
        contextTreePath: join(root, "local-context"),
        contextTreeRepoUrl: null,
        contextTreeBranch: null,
      },
      frozen,
    );
    expect(config).toMatchObject({
      contextSourceKind: "none",
      contextTreePath: null,
      contextTreeRepoUrl: null,
      contextTreeBranch: null,
    });
  });

  it("treats a present but corrupt or future source-state as frozen, not absent", async () => {
    const root = workspace();
    mkdirSync(join(root, ".first-tree-workspace"), { recursive: true });
    writeFileSync(join(root, SOURCE_STATE_REL), "{not-json");
    expect(inspectRemoteLatch(root).status).toBe("unreadable");
    expect(hasRemoteLatch(root)).toBe(true);
    await expect(
      resolveAgentContextSource(
        sdk({ bindingState: "unbound", repo: null, branch: "main", provider: null }),
        root,
        vi.fn(),
      ),
    ).resolves.toEqual({ kind: "none", reason: "frozen" });

    writeFileSync(
      join(root, SOURCE_STATE_REL),
      `${JSON.stringify({ schemaVersion: 2, remoteObserved: true, observedAt: "2026-08-13T00:00:00.000Z" })}\n`,
    );
    await expect(
      resolveAgentContextSource(
        sdk({ bindingState: "unbound", repo: null, branch: "main", provider: null }),
        root,
        vi.fn(),
      ),
    ).resolves.toEqual({ kind: "none", reason: "frozen" });
  });

  it("keeps a valid latch frozen when the network fetch fails", async () => {
    const root = workspace();
    await recordRemoteBindingObservation(root, { repoUrl: "git@github.com:acme/tree.git", branch: "main" });
    const failing = {
      getAgentContextTreeConfig: vi.fn(async () => {
        throw new Error("offline");
      }),
    } as unknown as FirstTreeHubSDK;
    await expect(resolveAgentContextSource(failing, root, vi.fn())).resolves.toEqual({
      kind: "none",
      reason: "frozen",
    });
  });

  it("never overwrites corrupt, future, symlinked, or non-file source state", async () => {
    const cases: Array<(root: string, statePath: string) => string> = [
      (_root, statePath) => {
        writeFileSync(statePath, "{broken");
        return readFileSync(statePath, "utf8");
      },
      (_root, statePath) => {
        const bytes = `${JSON.stringify({
          schemaVersion: 2,
          remoteObserved: true,
          observedAt: "2026-08-13T00:00:00.000Z",
          repoUrl: "git@github.com:future/tree.git",
          branch: "main",
        })}\n`;
        writeFileSync(statePath, bytes);
        return bytes;
      },
      (root, statePath) => {
        const target = join(root, "external-state.json");
        writeFileSync(target, "external-bytes\n");
        symlinkSync(target, statePath);
        return readFileSync(target, "utf8");
      },
      (_root, statePath) => {
        mkdirSync(statePath);
        return "directory";
      },
    ];

    for (const arrange of cases) {
      const root = workspace();
      const runtimeDir = join(root, ".first-tree-workspace");
      mkdirSync(runtimeDir);
      const statePath = join(root, SOURCE_STATE_REL);
      const before = arrange(root, statePath);
      await expect(
        recordRemoteBindingObservation(root, { repoUrl: "git@github.com:acme/tree.git", branch: "main" }),
      ).rejects.toThrow(/unreadable Context source state/);
      if (lstatSync(statePath).isSymbolicLink()) {
        expect(readFileSync(join(root, "external-state.json"), "utf8")).toBe(before);
      } else if (lstatSync(statePath).isFile()) {
        expect(readFileSync(statePath, "utf8")).toBe(before);
      } else {
        expect(lstatSync(statePath).isDirectory()).toBe(true);
      }
    }
  });

  it("rejects invalid public remote coordinates before writing a latch", async () => {
    const root = workspace();
    await expect(recordRemoteBindingObservation(root, { repoUrl: "", branch: "main" })).rejects.toThrow();
    await expect(
      recordRemoteBindingObservation(root, { repoUrl: "git@github.com:acme/tree.git", branch: "" }),
    ).rejects.toThrow();
    expect(inspectRemoteLatch(root)).toEqual({ status: "absent" });
  });
});

describe("contextSourceFromHandlerConfig", () => {
  it("does not construct a fake local or remote from incomplete discriminators", () => {
    expect(
      contextSourceFromHandlerConfig({
        workspaceRoot: "/ws",
        runtimeProvider: "codex",
        contextSourceKind: "local",
        contextTreePath: "",
      }),
    ).toEqual({ kind: "none", reason: "unknown" });
    expect(
      contextSourceFromHandlerConfig({
        workspaceRoot: "/ws",
        runtimeProvider: "codex",
        contextSourceKind: "remote",
        contextTreePath: "/ws/context-tree",
      }),
    ).toEqual({ kind: "none", reason: "unknown" });
    expect(
      contextSourceFromHandlerConfig({
        workspaceRoot: "/ws",
        runtimeProvider: "codex",
        contextTreePath: "/ws/local-context",
      }),
    ).toEqual({ kind: "none", reason: "unknown" });
  });
});

describe("effectiveContextSourceKind", () => {
  it("keeps external only for the providers the external installer supports", () => {
    // The external CLI's installer accepts exactly `claude` and `codex`; the
    // Claude family shares one home directory.
    for (const provider of ["claude-code", "claude-code-tui", "codex"] as const) {
      expect(effectiveContextSourceKind("external", provider)).toBe("external");
    }
  });

  it("falls back to none for providers it cannot install Skills for", () => {
    // Standing down `first-tree-{read,write,seed}` here would leave the machine
    // with no Context Tree Skills at all, because `context-tree install` reports
    // these hosts as skipped and writes nothing.
    for (const provider of ["cursor", "grok", "kimi-code", "opencode", "amp", "deepseek-harness", "pi"] as const) {
      expect(effectiveContextSourceKind("external", provider)).toBe("none");
    }
  });

  it("passes every other kind through untouched for every provider", () => {
    for (const provider of ["claude-code", "codex", "cursor", "grok"] as const) {
      for (const kind of ["remote", "local", "none"] as const) {
        expect(effectiveContextSourceKind(kind, provider)).toBe(kind);
      }
    }
  });
});
