import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentRuntimeConfigPayload } from "@first-tree/shared";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildAntigravityMcpConfigContent,
  mapAntigravityMcpServers,
  mergeAntigravityMcpConfig,
  projectAntigravityMcpConfig,
} from "../mcp-config.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function payload(mcpServers: AgentRuntimeConfigPayload["mcpServers"]): AgentRuntimeConfigPayload {
  return {
    kind: "antigravity",
    prompt: { append: "" },
    model: "",
    mcpServers,
    env: [],
    gitRepos: [],
    resourceSkills: [],
    reasoningEffort: "",
  };
}

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "antigravity-mcp-"));
  roots.push(root);
  return root;
}

describe("Antigravity MCP projection", () => {
  it("maps stdio and remote servers into the provider-native shape", () => {
    expect(
      mapAntigravityMcpServers(
        payload([
          { name: "local", transport: "stdio", command: "mcp-local", args: ["--stdio"] },
          {
            name: "remote",
            transport: "http",
            url: "https://mcp.example.test",
            headers: { Authorization: "Bearer x" },
          },
        ]),
      ),
    ).toEqual({
      "first-tree-managed-1": { command: "mcp-local", args: ["--stdio"] },
      "first-tree-managed-2": {
        serverUrl: "https://mcp.example.test",
        headers: { Authorization: "Bearer x" },
      },
    });
  });

  it("preserves user servers and rejects unowned reserved-name collisions", () => {
    const managed = { "first-tree-managed-1": { command: "mcp-local", args: [] } };
    const merged = mergeAntigravityMcpConfig(
      { mcpServers: { user: { serverUrl: "https://user.example.test" } } },
      managed,
    );
    expect(merged).toEqual({
      mcpServers: {
        user: { serverUrl: "https://user.example.test" },
        "first-tree-managed-1": { command: "mcp-local", args: [] },
      },
    });
    expect(() =>
      mergeAntigravityMcpConfig(
        { mcpServers: { "first-tree-managed-1": { command: "operator-owned", args: [] } } },
        managed,
      ),
    ).toThrow("reserves the server name first-tree-managed-1");
  });

  it("fails closed on malformed provider config roots", () => {
    expect(() => mergeAntigravityMcpConfig(["not-an-object"], {})).toThrow("config must be an object");
    expect(() => mergeAntigravityMcpConfig({ mcpServers: [] }, {})).toThrow("non-object mcpServers");
  });

  it("replaces only a previously projected entry", () => {
    const oldConfig = { "first-tree-managed-1": { command: "old", args: [] } };
    const nextConfig = { "first-tree-managed-1": { command: "new", args: ["--flag"] } };
    expect(mergeAntigravityMcpConfig({ mcpServers: oldConfig }, nextConfig, oldConfig)).toEqual({
      mcpServers: nextConfig,
    });
    expect(() =>
      mergeAntigravityMcpConfig(
        { mcpServers: { "first-tree-managed-1": { command: "tampered", args: [] } } },
        nextConfig,
        oldConfig,
      ),
    ).toThrow("modified outside First Tree");
  });

  it("projects atomically, carries ownership across turns, and removes only its entries", async () => {
    const workspace = tempRoot();
    const agentsDir = join(workspace, ".agents");
    mkdirSync(agentsDir, { recursive: true });
    const configPath = join(agentsDir, "mcp_config.json");
    writeFileSync(configPath, JSON.stringify({ mcpServers: { user: { serverUrl: "https://user.example.test" } } }));

    expect(
      await projectAntigravityMcpConfig(
        workspace,
        payload([{ name: "managed", transport: "stdio", command: "old", args: [] }]),
      ),
    ).toBe(configPath);
    expect(JSON.parse(readFileSync(configPath, "utf8"))).toEqual({
      mcpServers: {
        user: { serverUrl: "https://user.example.test" },
        "first-tree-managed-1": { command: "old", args: [] },
      },
    });
    expect(existsSync(join(agentsDir, ".mcp_config.first-tree.json"))).toBe(true);

    await projectAntigravityMcpConfig(
      workspace,
      payload([{ name: "managed", transport: "stdio", command: "new", args: ["--x"] }]),
    );
    expect(JSON.parse(readFileSync(configPath, "utf8"))).toEqual({
      mcpServers: {
        user: { serverUrl: "https://user.example.test" },
        "first-tree-managed-1": { command: "new", args: ["--x"] },
      },
    });

    await projectAntigravityMcpConfig(workspace, payload([]));
    expect(JSON.parse(readFileSync(configPath, "utf8"))).toEqual({
      mcpServers: { user: { serverUrl: "https://user.example.test" } },
    });
    expect(existsSync(join(agentsDir, ".mcp_config.first-tree.json"))).toBe(false);
  });

  it("does not create a provider config when no MCP servers are configured", async () => {
    const workspace = tempRoot();
    expect(await projectAntigravityMcpConfig(workspace, payload([]))).toBeNull();
    expect(existsSync(join(workspace, ".agents"))).toBe(false);
  });

  it("renders valid JSON content for direct callers", () => {
    expect(JSON.parse(buildAntigravityMcpConfigContent(undefined, payload([])))).toEqual({ mcpServers: {} });
  });
});
