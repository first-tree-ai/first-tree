import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const cliFetchMock = vi.hoisted(() => vi.fn());
const ensureFreshAccessTokenMock = vi.hoisted(() => vi.fn());
const credentialForOriginMock = vi.hoisted(() => vi.fn());
const inputMock = vi.hoisted(() => vi.fn());
const passwordMock = vi.hoisted(() => vi.fn());
const selectMock = vi.hoisted(() => vi.fn());

vi.mock("../core/access-token.js", () => ({ credentialForOrigin: credentialForOriginMock }));
vi.mock("../core/cli-fetch.js", () => ({
  cliFetch: cliFetchMock,
}));

vi.mock("@inquirer/prompts", () => ({
  input: inputMock,
  password: passwordMock,
  select: selectMock,
}));

const originalFirstTreeHome = process.env.FIRST_TREE_HOME;
const originalServerUrl = process.env.FIRST_TREE_SERVER_URL;
const originalIsTty = process.stdin.isTTY;

let home: string;

function setTty(value: boolean): void {
  Object.defineProperty(process.stdin, "isTTY", { configurable: true, value });
}

function writeCredentials(serverUrl = "http://first-tree.test"): void {
  mkdirSync(join(home, "config"), { recursive: true });
  const credentialsPath = join(home, "config", "credentials.json");
  const payload = Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600 })).toString("base64url");
  const token = `h.${payload}.s`;
  writeFileSync(credentialsPath, JSON.stringify({ accessToken: token, refreshToken: "refresh", serverUrl }));
}

function response(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

beforeEach(() => {
  vi.resetModules();
  home = join(tmpdir(), `ft-prompt-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(join(home, "config"), { recursive: true });
  process.env.FIRST_TREE_HOME = home;
  delete process.env.FIRST_TREE_SERVER_URL;
  cliFetchMock.mockReset();
  ensureFreshAccessTokenMock.mockReset();
  credentialForOriginMock.mockReset();
  inputMock.mockReset();
  passwordMock.mockReset();
  selectMock.mockReset();
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  if (originalFirstTreeHome === undefined) delete process.env.FIRST_TREE_HOME;
  else process.env.FIRST_TREE_HOME = originalFirstTreeHome;
  if (originalServerUrl === undefined) delete process.env.FIRST_TREE_SERVER_URL;
  else process.env.FIRST_TREE_SERVER_URL = originalServerUrl;
  Object.defineProperty(process.stdin, "isTTY", { configurable: true, value: originalIsTty });
});

describe("prompt core", () => {
  it("detects interactive availability", async () => {
    const { isInteractive } = await import("../core/prompt.js");

    setTty(true);
    expect(isInteractive()).toBe(true);
    expect(isInteractive(true)).toBe(false);
    setTty(false);
    expect(isInteractive()).toBe(false);
  });

  it("reports missing fields with environment hints in non-interactive mode", async () => {
    const { promptMissingFields } = await import("../core/prompt.js");
    const schema = {
      server: {
        url: { _tag: "field", options: { prompt: { message: "Server URL" }, env: "FIRST_TREE_SERVER_URL" } },
      },
      token: { _tag: "field", options: { prompt: { message: "Token", type: "password" }, env: "TOKEN" } },
      nested: {
        _tag: "optional",
        shape: {
          value: { _tag: "field", options: { prompt: { message: "Nested" }, env: "NESTED_VALUE" } },
        },
      },
      unlabeled: { _tag: "field", options: { prompt: { message: "No Env" } } },
    };

    await expect(
      promptMissingFields({
        schema,
        role: "client",
        configDir: join(home, "config"),
        noInteractive: true,
      }),
    ).rejects.toThrow("unlabeled");
  });

  it("writes prompted input, password, select, and follow-up input values", async () => {
    const { promptMissingFields } = await import("../core/prompt.js");
    const schema = {
      server: {
        url: { _tag: "field", options: { prompt: { message: "Server URL" } } },
        token: { _tag: "field", options: { prompt: { message: "Server Token" } } },
      },
      secret: { _tag: "field", options: { prompt: { message: "Secret", type: "password" } } },
      runtime: {
        _tag: "field",
        options: {
          prompt: {
            message: "Runtime",
            type: "select",
            choices: [
              { name: "Claude Code", value: "claude-code" },
              { name: "Other", value: "__input__" },
            ],
          },
        },
      },
      skip: {
        _tag: "field",
        options: {
          prompt: {
            message: "Skip",
            type: "select",
            choices: [{ name: "Auto", value: "__auto__" }],
          },
        },
      },
      provider: {
        _tag: "field",
        options: {
          prompt: {
            message: "Provider",
            type: "select",
            choices: [{ name: "Codex", value: "codex" }],
          },
        },
      },
    };
    setTty(true);
    inputMock
      .mockResolvedValueOnce("http://first-tree.test")
      .mockResolvedValueOnce("server-token")
      .mockResolvedValueOnce("custom-runtime");
    passwordMock.mockResolvedValueOnce("secret-value");
    selectMock.mockResolvedValueOnce("__input__").mockResolvedValueOnce("__auto__").mockResolvedValueOnce("codex");

    await expect(promptMissingFields({ schema, role: "client", configDir: join(home, "config") })).resolves.toEqual({
      server: { url: "http://first-tree.test", token: "server-token" },
      secret: "secret-value",
      runtime: "custom-runtime",
      provider: "codex",
    });

    const yaml = readFileSync(join(home, "config", "client.yaml"), "utf8");
    expect(yaml).toContain("url: http://first-tree.test");
    expect(yaml).toContain("token: server-token");
    expect(yaml).toContain("secret: secret-value");
    expect(yaml).toContain("runtime: custom-runtime");
    expect(yaml).toContain("provider: codex");
    expect(yaml).not.toContain("skip:");

    const customValueValidate = inputMock.mock.calls[2]?.[0]?.validate as
      | ((value: string) => true | string)
      | undefined;
    expect(customValueValidate?.("")).toBe("Value is required");
    expect(customValueValidate?.("filled")).toBe(true);
  });

  it("uses the default client config path when configDir is omitted", async () => {
    const { promptMissingFields } = await import("../core/prompt.js");
    setTty(true);
    inputMock.mockResolvedValueOnce("https://default-config.test");

    await expect(
      promptMissingFields({
        schema: {
          server: {
            url: { _tag: "field", options: { prompt: { message: "Server URL" } } },
          },
        },
        role: "client",
      }),
    ).resolves.toEqual({ server: { url: "https://default-config.test" } });

    expect(readFileSync(join(home, "config", "client.yaml"), "utf8")).toContain("url: https://default-config.test");
  });

  it("returns an empty prompt result when no schema prompts are missing", async () => {
    const { promptMissingFields } = await import("../core/prompt.js");

    await expect(
      promptMissingFields({
        schema: {},
        role: "client",
        configDir: join(home, "config"),
        noInteractive: true,
      }),
    ).resolves.toEqual({});
  });

  it("resolves add-agent canonical names and rejects missing setup or tombstones", async () => {
    vi.doMock("../core/bootstrap.js", async (importOriginal) => ({
      ...(await importOriginal<typeof import("../core/bootstrap.js")>()),
      ensureFreshAccessToken: ensureFreshAccessTokenMock,
    }));
    const { promptAddAgent } = await import("../core/prompt.js");

    await expect(promptAddAgent({ agentId: "agent-1" })).rejects.toThrow("first-tree-dev login <code>");

    writeCredentials();
    process.env.FIRST_TREE_SERVER_URL = "http://first-tree.test";
    credentialForOriginMock.mockResolvedValue({ token: "access-1", origin: "https://hub.example" });
    cliFetchMock.mockResolvedValueOnce(response(200, { name: "nova" }));
    await expect(promptAddAgent({ agentId: "agent-1" })).resolves.toEqual({ name: "nova", agentId: "agent-1" });
    expect(cliFetchMock.mock.calls[0]?.[0]).toBe("http://first-tree.test/api/v1/agents/agent-1");

    cliFetchMock.mockResolvedValueOnce(response(404, { error: "missing" }));
    await expect(promptAddAgent({ agentId: "missing" })).rejects.toThrow("HTTP 404");

    cliFetchMock.mockResolvedValueOnce(response(200, { name: null }));
    await expect(promptAddAgent({ agentId: "tombstone" })).rejects.toThrow("has no server-side name");
  });

  it("adds login guidance when server URL resolution fails during add-agent", async () => {
    vi.doMock("../core/bootstrap.js", async (importOriginal) => ({
      ...(await importOriginal<typeof import("../core/bootstrap.js")>()),
      ensureFreshAccessToken: ensureFreshAccessTokenMock,
      loadCredentials: vi.fn(() => ({ accessToken: "access", refreshToken: "refresh", serverUrl: "https://old.test" })),
      resolveServerUrl: vi.fn(() => {
        throw new Error("invalid server URL");
      }),
    }));
    const { promptAddAgent } = await import("../core/prompt.js");

    await expect(promptAddAgent({ agentId: "bad-url" })).rejects.toThrow("Run `first-tree-dev login <code>`");
  });

  it("stringifies non-Error server URL resolution failures during add-agent", async () => {
    vi.doMock("../core/bootstrap.js", async (importOriginal) => ({
      ...(await importOriginal<typeof import("../core/bootstrap.js")>()),
      ensureFreshAccessToken: ensureFreshAccessTokenMock,
      loadCredentials: vi.fn(() => ({ accessToken: "access", refreshToken: "refresh", serverUrl: "https://old.test" })),
      resolveServerUrl: vi.fn(() => {
        throw "invalid server URL string";
      }),
    }));
    const { promptAddAgent } = await import("../core/prompt.js");

    await expect(promptAddAgent({ agentId: "bad-url" })).rejects.toThrow("invalid server URL string");
  });

  it("prompts for an agent id when omitted", async () => {
    vi.doMock("../core/bootstrap.js", async (importOriginal) => ({
      ...(await importOriginal<typeof import("../core/bootstrap.js")>()),
      ensureFreshAccessToken: ensureFreshAccessTokenMock,
    }));
    const { promptAddAgent } = await import("../core/prompt.js");

    writeCredentials("http://first-tree.test/");
    process.env.FIRST_TREE_SERVER_URL = "http://override.test";
    inputMock.mockResolvedValueOnce("agent-from-prompt");
    credentialForOriginMock.mockResolvedValue({ token: "access-1", origin: "https://hub.example" });
    cliFetchMock.mockResolvedValueOnce(response(200, { name: "prompted" }));

    await expect(promptAddAgent()).resolves.toEqual({ name: "prompted", agentId: "agent-from-prompt" });
    expect(cliFetchMock.mock.calls[0]?.[0]).toBe("http://override.test/api/v1/agents/agent-from-prompt");

    const validate = inputMock.mock.calls[0]?.[0]?.validate as ((value: string) => true | string) | undefined;
    expect(validate?.("")).toBe("Agent UUID is required");
    expect(validate?.("agent-from-prompt")).toBe(true);
  });
});
