import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parse as parseYaml } from "yaml";
import {
  listPinnedAgents,
  reconcileLocalRuntimeProviders,
  uploadAgentSkills,
  uploadClientCapabilities,
} from "../core/runtime-provider-reconcile.js";

/** SEC-023: these request paths take the credential bound to its issuing origin. */
function credentialFor(token: string): { token: string; origin: string } {
  return { token, origin: "http://first-tree.test" };
}

/**
 * Two CLI helpers, both fetch-driven against the server:
 *   - `listPinnedAgents` reads the server-authoritative local-agent set.
 *   - `reconcileLocalRuntimeProviders` rewrites local `agent.yaml::runtime`
 *     when it disagrees with `agents.runtime_provider` (server authoritative).
 *   - `uploadClientCapabilities` PATCHes the per-machine probe results to
 *     `clients.metadata.capabilities`.
 *
 * Both are best-effort on the CLI startup path, so these tests pin the
 * happy/unhappy contracts and verify the YAML round-trip is non-lossy
 * (other keys preserved). Without coverage, a regression that drops
 * `agentId` or rewrites every yaml unconditionally would only surface at
 * production startup.
 */
describe("listPinnedAgents", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("GETs /me/pinned-agents with the user access token", async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify([{ agentId: "agent-1", clientId: "client-1", runtimeProvider: "claude-code" }]), {
        status: 200,
      }),
    );

    const rows = await listPinnedAgents({ serverUrl: "http://first-tree.test", credential: credentialFor("tok-xyz") });

    expect(rows).toEqual([{ agentId: "agent-1", clientId: "client-1", runtimeProvider: "claude-code" }]);
    expect(fetchMock).toHaveBeenCalledWith(
      "http://first-tree.test/api/v1/me/pinned-agents",
      expect.objectContaining({ headers: expect.objectContaining({ Authorization: "Bearer tok-xyz" }) }),
    );
  });

  it("throws on non-OK status so daemon startup can fall back to best-effort upload", async () => {
    fetchMock.mockResolvedValue(new Response("nope", { status: 500 }));

    await expect(
      listPinnedAgents({ serverUrl: "http://first-tree.test", credential: credentialFor("tok") }),
    ).rejects.toThrow(/500/);
  });
});

describe("reconcileLocalRuntimeProviders", () => {
  let agentsDir: string;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    agentsDir = mkdtempSync(join(tmpdir(), "ft-first-tree-reconcile-"));
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    rmSync(agentsDir, { recursive: true, force: true });
    vi.unstubAllGlobals();
  });

  function seedAgentDir(name: string, yamlContent: Record<string, unknown>): string {
    const dir = join(agentsDir, name);
    mkdirSync(dir, { recursive: true });
    const path = join(dir, "agent.yaml");
    writeFileSync(
      path,
      Object.entries(yamlContent)
        .map(([k, v]) => `${k}: ${JSON.stringify(v)}`)
        .join("\n"),
    );
    return path;
  }

  it("rewrites agent.yaml when the server says a different runtime_provider", async () => {
    const yamlPath = seedAgentDir("alpha", { agentId: "agent-1", runtime: "claude-code", workspaceLabel: "alpha-ws" });
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify([{ agentId: "agent-1", clientId: "cli-1", runtimeProvider: "codex" }]), {
        status: 200,
      }),
    );

    await reconcileLocalRuntimeProviders({
      serverUrl: "http://first-tree.test",
      credential: credentialFor("tok"),
      agentsDir,
    });

    const after = parseYaml(readFileSync(yamlPath, "utf-8")) as Record<string, unknown>;
    expect(after.runtime).toBe("codex");
    // Sibling keys must survive the rewrite.
    expect(after.agentId).toBe("agent-1");
    expect(after.workspaceLabel).toBe("alpha-ws");
  });

  it("leaves agent.yaml untouched when runtime already matches the server", async () => {
    const yamlPath = seedAgentDir("beta", { agentId: "agent-2", runtime: "codex" });
    const before = readFileSync(yamlPath, "utf-8");
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify([{ agentId: "agent-2", clientId: "cli-1", runtimeProvider: "codex" }]), {
        status: 200,
      }),
    );

    await reconcileLocalRuntimeProviders({
      serverUrl: "http://first-tree.test",
      credential: credentialFor("tok"),
      agentsDir,
    });

    expect(readFileSync(yamlPath, "utf-8")).toBe(before);
  });

  it("ignores local agents that aren't pinned to this user (server returns no entry)", async () => {
    const yamlPath = seedAgentDir("gamma", { agentId: "stale-agent", runtime: "claude-code" });
    const before = readFileSync(yamlPath, "utf-8");
    fetchMock.mockResolvedValue(new Response(JSON.stringify([]), { status: 200 }));

    await reconcileLocalRuntimeProviders({
      serverUrl: "http://first-tree.test",
      credential: credentialFor("tok"),
      agentsDir,
    });

    expect(readFileSync(yamlPath, "utf-8")).toBe(before);
  });

  it("throws when the server returns a non-OK status (caller wraps best-effort)", async () => {
    fetchMock.mockResolvedValue(new Response("server down", { status: 500 }));
    await expect(
      reconcileLocalRuntimeProviders({
        serverUrl: "http://first-tree.test",
        credential: credentialFor("tok"),
        agentsDir,
      }),
    ).rejects.toThrow(/500/);
  });

  it("warns + skips an agent with malformed yaml without aborting the whole pass", async () => {
    const goodPath = seedAgentDir("good", { agentId: "agent-good", runtime: "claude-code" });
    const badDir = join(agentsDir, "broken");
    mkdirSync(badDir, { recursive: true });
    writeFileSync(join(badDir, "agent.yaml"), ":\n\t-broken: yaml: [");

    fetchMock.mockResolvedValue(
      new Response(JSON.stringify([{ agentId: "agent-good", clientId: "cli-1", runtimeProvider: "codex" }]), {
        status: 200,
      }),
    );

    const logs: Array<[string, string]> = [];
    await reconcileLocalRuntimeProviders({
      serverUrl: "http://first-tree.test",
      credential: credentialFor("tok"),
      agentsDir,
      log: (level, msg) => logs.push([level, msg]),
    });

    // `good` still got reconciled despite the sibling parse failure.
    const after = parseYaml(readFileSync(goodPath, "utf-8")) as { runtime?: string };
    expect(after.runtime).toBe("codex");
    expect(logs.some(([level, msg]) => level === "warn" && /broken/.test(msg))).toBe(true);
  });

  it("returns quietly when the agents directory is missing", async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify([{ agentId: "agent-1", clientId: "cli-1", runtimeProvider: "codex" }]), {
        status: 200,
      }),
    );

    await expect(
      reconcileLocalRuntimeProviders({
        serverUrl: "http://first-tree.test",
        credential: credentialFor("tok"),
        agentsDir: join(agentsDir, "missing"),
      }),
    ).resolves.toBeUndefined();
  });

  it("skips directories without agent.yaml and empty yaml files", async () => {
    const missingYamlDir = join(agentsDir, "missing-yaml");
    mkdirSync(missingYamlDir, { recursive: true });
    const emptyPath = seedAgentDir("empty", {});
    writeFileSync(emptyPath, "");
    const goodPath = seedAgentDir("unset-runtime", { agentId: "agent-unset" });
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify([{ agentId: "agent-unset", clientId: "cli-1", runtimeProvider: "codex" }]), {
        status: 200,
      }),
    );
    const logs: Array<[string, string]> = [];

    await reconcileLocalRuntimeProviders({
      serverUrl: "http://first-tree.test",
      credential: credentialFor("tok"),
      agentsDir,
      log: (level, msg) => logs.push([level, msg]),
    });

    const after = parseYaml(readFileSync(goodPath, "utf-8")) as { runtime?: string };
    expect(after.runtime).toBe("codex");
    expect(logs).toContainEqual(["info", 'agent agent-unset: yaml runtime "(unset)" → "codex" (server authoritative)']);
  });
});

describe("uploadClientCapabilities", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("PATCHes /clients/:id/capabilities with the snapshot", async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 204 }));

    await uploadClientCapabilities({
      serverUrl: "http://first-tree.test",
      credential: { token: "tok-xyz", origin: "http://first-tree.test" },
      clientId: "cli-1",
      capabilities: {
        "claude-code": {
          state: "ok",
          available: true,
          sdkVersion: "0.2.84",
          detectedAt: "2026-04-29T00:00:00Z",
        },
      },
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const call = fetchMock.mock.calls[0];
    if (!call) throw new Error("fetch was not called");
    const [url, init] = call as [string, RequestInit];
    expect(url).toBe("http://first-tree.test/api/v1/clients/cli-1/capabilities");
    expect(init.method).toBe("PATCH");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer tok-xyz");
    expect((init.headers as Record<string, string>)["Content-Type"]).toBe("application/json");
    const body = JSON.parse(String(init.body));
    expect(body.capabilities["claude-code"].state).toBe("ok");
  });

  it("URL-encodes the clientId so paths with `/` or unicode survive", async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 204 }));
    await uploadClientCapabilities({
      serverUrl: "http://first-tree.test",
      credential: { token: "tok", origin: "http://first-tree.test" },
      clientId: "weird/client id",
      capabilities: {},
    });
    const call = fetchMock.mock.calls[0];
    if (!call) throw new Error("fetch was not called");
    const url = call[0] as string;
    expect(url).toBe("http://first-tree.test/api/v1/clients/weird%2Fclient%20id/capabilities");
  });

  it("throws on non-OK status so the caller can log + continue", async () => {
    fetchMock.mockResolvedValue(new Response("nope", { status: 403 }));
    await expect(
      uploadClientCapabilities({
        serverUrl: "http://first-tree.test",
        credential: { token: "tok", origin: "http://first-tree.test" },
        clientId: "cli-1",
        capabilities: {},
      }),
    ).rejects.toMatchObject({ statusCode: 403 });
  });

  it("retries transient fetch failures through the SDK upload path", async () => {
    vi.useFakeTimers();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    fetchMock
      .mockRejectedValueOnce(new TypeError("fetch failed"))
      .mockRejectedValueOnce(new TypeError("fetch failed"))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));

    const upload = uploadClientCapabilities({
      serverUrl: "http://first-tree.test",
      credential: { token: "tok", origin: "http://first-tree.test" },
      clientId: "cli-1",
      capabilities: {},
    });
    await flush(upload);

    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
});

async function flush(promise: Promise<unknown>, maxFlushes = 50): Promise<void> {
  let settled = false;
  let error: unknown;
  promise.then(
    () => {
      settled = true;
    },
    (err) => {
      error = err;
      settled = true;
    },
  );
  for (let i = 0; i < maxFlushes && !settled; i++) {
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(1000);
  }
  if (!settled) throw new Error("flush did not settle within maxFlushes");
  if (error !== undefined) throw error;
}

describe("uploadAgentSkills", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("PATCHes /agents/:id/skills with the scanned descriptors", async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 204 }));

    await uploadAgentSkills({
      serverUrl: "http://first-tree.test",
      credential: { token: "tok-xyz", origin: "http://first-tree.test" },
      agentId: "agent-1",
      skills: [{ name: "review", description: "Pre-landing PR review", source: "user" }],
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const call = fetchMock.mock.calls[0];
    if (!call) throw new Error("fetch was not called");
    const [url, init] = call as [string, RequestInit];
    expect(url).toBe("http://first-tree.test/api/v1/agents/agent-1/skills");
    expect(init.method).toBe("PATCH");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer tok-xyz");
    expect((init.headers as Record<string, string>)["Content-Type"]).toBe("application/json");
    const body = JSON.parse(String(init.body));
    expect(body.skills).toEqual([{ name: "review", description: "Pre-landing PR review", source: "user" }]);
  });

  it("URL-encodes the agentId so weird ids survive", async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 204 }));
    await uploadAgentSkills({
      serverUrl: "http://first-tree.test",
      credential: { token: "tok", origin: "http://first-tree.test" },
      agentId: "agent/with slash",
      skills: [],
    });
    const call = fetchMock.mock.calls[0];
    if (!call) throw new Error("fetch was not called");
    const url = call[0] as string;
    expect(url).toBe("http://first-tree.test/api/v1/agents/agent%2Fwith%20slash/skills");
  });

  it("throws on non-OK status so the caller can log + continue", async () => {
    fetchMock.mockResolvedValue(new Response("nope", { status: 500 }));
    await expect(
      uploadAgentSkills({
        serverUrl: "http://first-tree.test",
        credential: { token: "tok", origin: "http://first-tree.test" },
        agentId: "agent-1",
        skills: [],
      }),
    ).rejects.toThrow(/500/);
  });
});
