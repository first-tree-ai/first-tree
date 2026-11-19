import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AGENT_RUNTIME_SESSION_HEADER, AGENT_SELECTOR_HEADER } from "@first-tree/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const configMocks = vi.hoisted(() => ({
  agentConfigSchema: {},
  clientConfigSchema: {},
  defaultConfigDir: vi.fn(),
  defaultDataDir: vi.fn(),
  loadAgents: vi.fn(),
  resolveConfigReadonly: vi.fn(),
}));

const bootstrapMocks = vi.hoisted(() => ({
  ensureFreshAccessToken: vi.fn(),
  ensureFreshBoundAccessToken: vi.fn(),
  resolveServerUrl: vi.fn(),
}));

const outputMocks = vi.hoisted(() => ({
  fail: vi.fn((code: string, message: string, exitCode = 1) => {
    throw Object.assign(new Error(message), { code, exitCode });
  }),
}));

vi.mock("@first-tree/shared/config", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@first-tree/shared/config")>()),
  ...configMocks,
}));
vi.mock("../core/bootstrap.js", () => bootstrapMocks);
vi.mock("../cli/output.js", () => outputMocks);

const originalAgentId = process.env.FIRST_TREE_AGENT_ID;
const originalRuntimeSessionToken = process.env.FIRST_TREE_RUNTIME_SESSION_TOKEN;
const originalRuntimeSessionTokenFile = process.env.FIRST_TREE_RUNTIME_SESSION_TOKEN_FILE;
const originalServerUrl = process.env.FIRST_TREE_SERVER_URL;

function restoreEnv(): void {
  for (const [key, value] of [
    ["FIRST_TREE_AGENT_ID", originalAgentId],
    ["FIRST_TREE_RUNTIME_SESSION_TOKEN", originalRuntimeSessionToken],
    ["FIRST_TREE_RUNTIME_SESSION_TOKEN_FILE", originalRuntimeSessionTokenFile],
    ["FIRST_TREE_SERVER_URL", originalServerUrl],
  ] as const) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

function requestHeaders(fetchMock: ReturnType<typeof vi.fn>, index: number): Headers {
  return new Headers(fetchMock.mock.calls[index]?.[1]?.headers as Record<string, string>);
}

beforeEach(() => {
  restoreEnv();
  configMocks.defaultConfigDir.mockReturnValue("/tmp/first-tree-config");
  configMocks.defaultDataDir.mockReturnValue("/tmp/first-tree-data");
  configMocks.loadAgents.mockReturnValue(new Map([["nova", { agentId: "agent-1" }]]));
  bootstrapMocks.ensureFreshAccessToken.mockResolvedValue("member-token");
  bootstrapMocks.ensureFreshBoundAccessToken.mockResolvedValue({ token: "member-token", origin: null });
  bootstrapMocks.resolveServerUrl.mockReturnValue("https://hub.example");
});

afterEach(() => {
  restoreEnv();
  vi.unstubAllGlobals();
});

describe("local agent runtime-session token requests", () => {
  it("uses the latest token file value for each request after SDK construction", async () => {
    const dir = mkdtempSync(join(tmpdir(), "first-tree-token-request-"));
    try {
      const tokenFile = join(dir, "runtime.token");
      writeFileSync(tokenFile, "runtime-token-1\n", "utf8");
      process.env.FIRST_TREE_RUNTIME_SESSION_TOKEN = "stale-env-token";
      process.env.FIRST_TREE_AGENT_ID = "agent-1";
      process.env.FIRST_TREE_RUNTIME_SESSION_TOKEN_FILE = tokenFile;

      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ accessToken: "outbox-token-1", expiresIn: 60 }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }),
        )
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ accessToken: "outbox-token-2", expiresIn: 60 }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }),
        );
      vi.stubGlobal("fetch", fetchMock);

      const { createSdk } = await import("../commands/_shared/local-agent.js");
      const sdk = createSdk("nova");

      await sdk.createAgentOutboxToken("chat-1");
      writeFileSync(tokenFile, "runtime-token-2\n", "utf8");
      await sdk.createAgentOutboxToken("chat-2");

      expect(requestHeaders(fetchMock, 0).get(AGENT_RUNTIME_SESSION_HEADER)).toBe("runtime-token-1");
      expect(requestHeaders(fetchMock, 1).get(AGENT_RUNTIME_SESSION_HEADER)).toBe("runtime-token-2");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("adds the canonical local runtime-session proof for a manual --agent invocation", async () => {
    const dir = mkdtempSync(join(tmpdir(), "first-tree-token-request-"));
    try {
      const tokenDir = join(dir, "runtime-session-tokens");
      mkdirSync(tokenDir, { recursive: true });
      writeFileSync(join(tokenDir, "agent-1.token"), "runtime-token-manual\n", "utf8");
      configMocks.defaultDataDir.mockReturnValue(dir);
      delete process.env.FIRST_TREE_RUNTIME_SESSION_TOKEN_FILE;
      const fetchMock = vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ items: [] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );
      vi.stubGlobal("fetch", fetchMock);

      const { createSdk } = await import("../commands/_shared/local-agent.js");
      await createSdk("nova").listChatGitlabEntities("chat-1");

      expect(requestHeaders(fetchMock, 0).get(AGENT_RUNTIME_SESSION_HEADER)).toBe("runtime-token-manual");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("uses the selected agent's canonical proof when --agent overrides the current runtime agent", async () => {
    const dir = mkdtempSync(join(tmpdir(), "first-tree-token-request-"));
    try {
      const tokenDir = join(dir, "runtime-session-tokens");
      const injectedTokenFile = join(dir, "agent-a-injected.token");
      mkdirSync(tokenDir, { recursive: true });
      writeFileSync(injectedTokenFile, "runtime-token-a\n", "utf8");
      writeFileSync(join(tokenDir, "agent-b.token"), "runtime-token-b\n", "utf8");
      configMocks.defaultDataDir.mockReturnValue(dir);
      configMocks.loadAgents.mockReturnValue(
        new Map([
          ["alpha", { agentId: "agent-a" }],
          ["beta", { agentId: "agent-b" }],
        ]),
      );
      process.env.FIRST_TREE_AGENT_ID = "agent-a";
      process.env.FIRST_TREE_RUNTIME_SESSION_TOKEN_FILE = injectedTokenFile;
      const fetchMock = vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ items: [] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );
      vi.stubGlobal("fetch", fetchMock);

      const { createSdk } = await import("../commands/_shared/local-agent.js");
      await createSdk("beta").listChatGitlabEntities("chat-1");

      const headers = requestHeaders(fetchMock, 0);
      expect(headers.get(AGENT_SELECTOR_HEADER)).toBe("agent-b");
      expect(headers.get(AGENT_RUNTIME_SESSION_HEADER)).toBe("runtime-token-b");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
