import { EventEmitter } from "node:events";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type AgentRuntimeConfigPayload, parseProviderRetryEventMessage, type SessionEvent } from "@first-tree/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mockCtxPlumbing } from "../../../__tests__/test-helpers.js";
import type { DeliveryToken, SessionContext, SessionMessage, TurnOutcome } from "../../../runtime/handler.js";
import type { ProviderProcessSpec, ProviderProcessSupervisor } from "../../../runtime/provider-process-supervisor.js";
import { formatProviderFailureRuntimeNotice } from "../../../runtime/runtime-notice.js";
import {
  AMP_PENDING_SESSION_PREFIX,
  buildAmpTurnArgs,
  createAmpHandler,
  isAmpPendingSessionId,
  mapAmpMcpServers,
  removeAmpRuntimeSettings,
  writeAmpRuntimeSettings,
} from "../index.js";

class FakeStdin extends EventEmitter {
  written = "";
  ended = false;
  write(chunk: string): boolean {
    this.written += chunk;
    return true;
  }
  end(): void {
    this.ended = true;
  }
}

class FakeStream extends EventEmitter {
  setEncoding(): this {
    return this;
  }
}

class FakeChild extends EventEmitter {
  stdin = new FakeStdin();
  stdout = new FakeStream();
  stderr = new FakeStream();
  // Falsy so abort uses `child.kill` instead of `process.kill(-pid)` against a
  // fake pid that is not a real process group.
  pid = 0;
  kills: string[] = [];
  kill(signal?: string): boolean {
    this.kills.push(signal ?? "SIGTERM");
    if (this.kills.length > 1) return true;
    this.stdout.emit("end");
    this.emit("close", null, signal ?? "SIGTERM");
    return true;
  }
}

type ChildScript = (child: FakeChild) => void;

function makeFakeSupervisor(scripts: ChildScript[]): {
  supervisor: ProviderProcessSupervisor;
  specs: ProviderProcessSpec[];
  children: FakeChild[];
  settingsSnapshots: unknown[];
} {
  const specs: ProviderProcessSpec[] = [];
  const children: FakeChild[] = [];
  const settingsSnapshots: unknown[] = [];
  return {
    specs,
    children,
    settingsSnapshots,
    supervisor: {
      spawn(spec) {
        specs.push(spec);
        const settingsPath = spec.args[spec.args.indexOf("--settings-file") + 1];
        if (typeof settingsPath === "string" && existsSync(settingsPath)) {
          settingsSnapshots.push(JSON.parse(readFileSync(settingsPath, "utf8")));
        }
        const child = new FakeChild();
        children.push(child);
        const script = scripts.shift();
        if (!script) throw new Error("fake Amp spawn called more times than scripted");
        setImmediate(() => script(child));
        return {
          child: child as unknown as ReturnType<ProviderProcessSupervisor["spawn"]>["child"],
          exited: new Promise<void>((resolve) => child.once("close", () => resolve())),
        };
      },
    },
  };
}

function line(value: unknown): string {
  return `${JSON.stringify(value)}\n`;
}

function successScript(input: { sessionId: string; text: string }): ChildScript {
  return (child) => {
    child.stdout.emit("data", line({ type: "system", subtype: "init", session_id: input.sessionId }));
    child.stdout.emit(
      "data",
      line({
        type: "result",
        subtype: "success",
        is_error: false,
        result: input.text,
        session_id: input.sessionId,
        usage: { input_tokens: 10, output_tokens: 5 },
      }),
    );
    child.stdout.emit("end");
    child.emit("close", 0, null);
  };
}

function authFailureScript(): ChildScript {
  return (child) => {
    child.stderr.emit("data", "Error: not logged in. Run `amp login` or set AMP_API_KEY.\n");
    child.stdout.emit("end");
    child.emit("close", 1, null);
  };
}

function absentKeyAuthFailureScript(): ChildScript {
  return (child) => {
    child.stdout.emit(
      "data",
      [
        'No API key found. Starting login flow... AMP_API_KEY=qa-amp-key-placeholder AMP_API_KEY="qa-amp-quoted-placeholder" {"AMP_API_KEY":"qa-amp-json-placeholder"} Authorization: Bearer qa-bearer-placeholder sk-ant-abcdefghijklmnopqrstuvwxyz012345',
        "If your browser does not open automatically, visit:",
        "",
        "https://ampcode.com/auth/cli-login?authToken=qa-one-time-placeholder&state=qa-state-placeholder",
        "",
        "When prompted, paste your code here: ",
      ].join("\n"),
    );
    child.stdout.emit("end");
    child.emit("close", 1, null);
  };
}

function assertNoAmpLoginAuthorizationMaterial(text: string): void {
  expect(text).not.toMatch(/https?:\/\//i);
  expect(text).not.toMatch(/authToken=|auth_token=|[?&]code=|[?&]state=|[?&]token=/i);
  expect(text).not.toContain("qa-one-time-placeholder");
  expect(text).not.toContain("qa-state-placeholder");
}

function assertNoAmpGenericCredentialMaterial(text: string): void {
  expect(text).not.toContain("qa-amp-key-placeholder");
  expect(text).not.toContain("qa-amp-quoted-placeholder");
  expect(text).not.toContain("qa-amp-json-placeholder");
  expect(text).not.toContain("qa-bearer-placeholder");
  expect(text).not.toContain("sk-ant-abcdefghijklmnopqrstuvwxyz012345");
}

function makeToken(): DeliveryToken & { completed: TurnOutcome[]; retried: string[] } {
  const completed: TurnOutcome[] = [];
  const retried: string[] = [];
  return {
    completed,
    retried,
    processingStarted: () => {},
    complete: async (_messages, outcome) => {
      completed.push(outcome);
    },
    retry: (_messages, reason) => {
      retried.push(reason);
    },
    terminalRejected: async () => {},
  };
}

function makeMessage(id: string, content: string): SessionMessage {
  return {
    inboxEntryId: 1,
    id,
    chatId: "chat-amp",
    senderId: "human-1",
    format: "text",
    content,
    metadata: {},
  };
}

let workspaceRoot: string;

function makeContext(opts: {
  events: SessionEvent[];
  forwardResult?: (text: string) => Promise<void>;
  replaceSessionId?: (sessionId: string, reason: string) => void;
}): SessionContext {
  const sendMessage = vi.fn().mockResolvedValue(undefined);
  const plumbing = mockCtxPlumbing({ sendMessage }, "chat-amp");
  return {
    agent: {
      agentId: "agent-amp-1",
      inboxId: "inbox_agent-amp-1",
      displayName: "amp-assistant",
      type: "agent",
      visibility: "organization",
      delegateMention: null,
      metadata: {},
    },
    sdk: {
      serverUrl: "https://first-tree.test",
      sendMessage,
      getAgentContextTreeConfig: async () => ({
        bindingState: "invalid",
        repo: null,
        branch: null,
        provider: null,
      }),
    } as unknown as SessionContext["sdk"],
    chatId: "chat-amp",
    log: () => {},
    recordProviderActivity: () => {},
    noteTurnStart: () => {},
    emitEvent: (event) => {
      opts.events.push(event);
    },
    ...plumbing,
    ...(opts.forwardResult ? { forwardResult: opts.forwardResult } : {}),
    ...(opts.replaceSessionId ? { replaceSessionId: opts.replaceSessionId } : {}),
  };
}

function ampPayload(
  over: Partial<Omit<Extract<AgentRuntimeConfigPayload, { kind: "amp" }>, "kind">> = {},
): Extract<AgentRuntimeConfigPayload, { kind: "amp" }> {
  return {
    kind: "amp",
    prompt: { append: "" },
    model: "",
    mcpServers: [],
    env: [],
    gitRepos: [],
    resourceSkills: [],
    ...over,
  };
}

function makeHandler(supervisor: ProviderProcessSupervisor, extraConfig: Record<string, unknown> = {}) {
  const payload = extraConfig.payload as AgentRuntimeConfigPayload | undefined;
  const runtimeConfig = {
    agentId: "agent-amp-1",
    version: 1,
    payload: payload ?? ampPayload(),
    updatedAt: new Date(0).toISOString(),
    updatedBy: "test",
  };
  return createAmpHandler({
    workspaceRoot,
    agentName: "amp-test-agent",
    runtimeProvider: "amp",
    ampBinaryResolver: () => ({ ok: true, binary: "/fake/bin/amp" }),
    providerProcessSupervisor: supervisor,
    ampTurnTimeoutMs: 5_000,
    agentConfigCache: {
      refresh: async () => runtimeConfig,
      get: () => runtimeConfig,
    },
    ...extraConfig,
  });
}

beforeEach(() => {
  workspaceRoot = mkdtempSync(join(tmpdir(), "amp-handler-test-"));
});

afterEach(() => {
  rmSync(workspaceRoot, { recursive: true, force: true });
});

describe("buildAmpTurnArgs — canonical spawn contract", () => {
  it("locks execute/stream-json/settings-file and never puts the prompt on argv", () => {
    expect(
      buildAmpTurnArgs({
        mode: "",
        resumeSessionId: null,
        settingsFile: "/tmp/amp-runtime-settings.json",
      }),
    ).toEqual([
      "--execute",
      "--stream-json",
      "--stream-json-thinking",
      "--no-remote-control-terminal",
      "--no-archive-after-execute",
      "--settings-file",
      "/tmp/amp-runtime-settings.json",
      "--visibility",
      "private",
    ]);
    expect(
      buildAmpTurnArgs({
        mode: "high",
        resumeSessionId: "T-aaaa",
        settingsFile: "/tmp/settings.json",
      }),
    ).toEqual([
      "threads",
      "continue",
      "T-aaaa",
      "--execute",
      "--stream-json",
      "--stream-json-thinking",
      "--no-remote-control-terminal",
      "--no-archive-after-execute",
      "--settings-file",
      "/tmp/settings.json",
      "--mode",
      "high",
    ]);
  });

  it("maps caller MCP servers onto first-tree-mcp-N without writing Amp user settings", () => {
    expect(
      mapAmpMcpServers(
        ampPayload({
          mcpServers: [
            { name: "docs", transport: "stdio", command: "docs-server", args: ["--stdio"] },
            { name: "http", transport: "sse", url: "https://example.test/mcp" },
          ],
        }),
      ),
    ).toEqual({
      "first-tree-mcp-1": { command: "docs-server", args: ["--stdio"] },
      "first-tree-mcp-2": { url: "https://example.test/mcp" },
    });
  });

  it("writes runtime-owned dangerouslyAllowAll settings under a unique per-turn path", () => {
    const path = writeAmpRuntimeSettings(workspaceRoot);
    expect(path).toMatch(/amp-runtime-settings\.[0-9a-f-]{36}\.json$/);
    expect(path.startsWith(join(workspaceRoot, ".first-tree", "amp-runtime-settings."))).toBe(true);
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ "amp.dangerouslyAllowAll": true });
    expect(statSync(path).mode & 0o777).toBe(0o600);
    removeAmpRuntimeSettings(path);
    expect(existsSync(path)).toBe(false);
  });

  it("keeps concurrent MCP snapshots on distinct paths so neither turn can overwrite the other", () => {
    const first = writeAmpRuntimeSettings(
      workspaceRoot,
      mapAmpMcpServers(
        ampPayload({
          mcpServers: [
            {
              name: "a",
              transport: "http",
              url: "https://example.test/a",
              headers: { Authorization: "Bearer token-a" },
            },
          ],
        }),
      ),
    );
    const second = writeAmpRuntimeSettings(
      workspaceRoot,
      mapAmpMcpServers(
        ampPayload({
          mcpServers: [
            {
              name: "b",
              transport: "http",
              url: "https://example.test/b",
              headers: { Authorization: "Bearer token-b" },
            },
          ],
        }),
      ),
    );
    expect(first).not.toBe(second);
    expect(JSON.parse(readFileSync(first, "utf8"))).toEqual({
      "amp.dangerouslyAllowAll": true,
      "amp.mcpServers": {
        "first-tree-mcp-1": { url: "https://example.test/a", headers: { Authorization: "Bearer token-a" } },
      },
    });
    expect(JSON.parse(readFileSync(second, "utf8"))).toEqual({
      "amp.dangerouslyAllowAll": true,
      "amp.mcpServers": {
        "first-tree-mcp-1": { url: "https://example.test/b", headers: { Authorization: "Bearer token-b" } },
      },
    });
    removeAmpRuntimeSettings(first);
    removeAmpRuntimeSettings(second);
  });

  it("folds MCP servers including headers into the 0600 settings file, never argv", () => {
    const mcp = mapAmpMcpServers(
      ampPayload({
        mcpServers: [
          {
            name: "http",
            transport: "http",
            url: "https://example.test/mcp",
            headers: { Authorization: "Bearer secret-token" },
          },
        ],
      }),
    );
    const path = writeAmpRuntimeSettings(workspaceRoot, mcp);
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({
      "amp.dangerouslyAllowAll": true,
      "amp.mcpServers": {
        "first-tree-mcp-1": { url: "https://example.test/mcp", headers: { Authorization: "Bearer secret-token" } },
      },
    });
    expect(buildAmpTurnArgs({ mode: "high", resumeSessionId: null, settingsFile: path }).join(" ")).not.toContain(
      "secret-token",
    );
    expect(buildAmpTurnArgs({ mode: "high", resumeSessionId: null, settingsFile: path })).not.toContain("--mcp-config");
    removeAmpRuntimeSettings(path);
  });
});

describe("Amp handler — per-turn CLI transport", () => {
  it("start: prompt on stdin only, canonical args, session id from stream", async () => {
    const events: SessionEvent[] = [];
    const { supervisor, specs, children, settingsSnapshots } = makeFakeSupervisor([
      successScript({ sessionId: "T-sess-real-1", text: "hello world" }),
    ]);
    const forwarded: string[] = [];
    const handler = makeHandler(supervisor);
    const token = makeToken();

    const result = await handler.start(
      makeMessage("m1", "do the thing"),
      makeContext({ events, forwardResult: async (text) => void forwarded.push(text) }),
      token,
    );

    expect(specs).toHaveLength(1);
    const spec = specs[0];
    if (!spec) throw new Error("unreachable");
    expect(spec.command).toBe("/fake/bin/amp");
    expect(spec.args[0]).toBe("--execute");
    expect(spec.args).toEqual(
      expect.arrayContaining([
        "--stream-json",
        "--stream-json-thinking",
        "--no-remote-control-terminal",
        "--no-archive-after-execute",
        "--settings-file",
        "--visibility",
        "private",
      ]),
    );
    expect(spec.args.join(" ")).not.toContain("do the thing");
    expect(spec.args).not.toContain("threads");
    expect((spec.options.env as Record<string, string> | undefined)?.AMP_REMOTE_CONTROL_TERMINAL).toBe("0");
    const settingsPath = spec.args[spec.args.indexOf("--settings-file") + 1];
    expect(settingsPath).toMatch(/amp-runtime-settings\.[0-9a-f-]{36}\.json$/);
    expect(settingsSnapshots[0]).toEqual({ "amp.dangerouslyAllowAll": true });
    expect(existsSync(settingsPath ?? "")).toBe(false);
    expect(children[0]?.stdin.written).toContain("do the thing");
    expect(children[0]?.stdin.ended).toBe(true);

    expect(result).toMatchObject({ sessionId: "T-sess-real-1", route: { kind: "owned", mode: "processing" } });
    expect(token.completed).toMatchObject([{ status: "success" }]);
    expect(forwarded).toEqual(["hello world"]);
    expect(events.some((event) => event.kind === "assistant_text" && event.payload.text === "hello world")).toBe(true);
    expect(events.at(-1)).toMatchObject({ kind: "turn_end", payload: { status: "success" } });
    await handler.shutdown();
  });

  it("resume: threads continue plus --mode; MCP lives in settings, never --mcp-config", async () => {
    const events: SessionEvent[] = [];
    const { supervisor, specs, settingsSnapshots } = makeFakeSupervisor([
      successScript({ sessionId: "T-sess-real-2", text: "resumed" }),
    ]);
    const handler = makeHandler(supervisor, {
      payload: ampPayload({
        model: "high",
        mcpServers: [
          {
            name: "docs",
            transport: "http",
            url: "https://example.test/mcp",
            headers: { Authorization: "Bearer secret-token" },
          },
        ],
      }),
    });

    await handler.resume(makeMessage("m2", "continue"), "T-sess-real-2", makeContext({ events }), makeToken());

    const spec = specs[0];
    if (!spec) throw new Error("unreachable");
    expect(spec.args.slice(0, 3)).toEqual(["threads", "continue", "T-sess-real-2"]);
    expect(spec.args).toEqual(expect.arrayContaining(["--mode", "high", "--no-remote-control-terminal"]));
    expect(spec.args).not.toContain("--visibility");
    expect(spec.args).not.toContain("--model");
    expect(spec.args).not.toContain("--mcp-config");
    expect((spec.options.env as Record<string, string> | undefined)?.AMP_REMOTE_CONTROL_TERMINAL).toBe("0");
    expect(spec.args.join(" ")).not.toContain("secret-token");
    const settingsPath = spec.args[spec.args.indexOf("--settings-file") + 1];
    expect(settingsPath).toMatch(/amp-runtime-settings\.[0-9a-f-]{36}\.json$/);
    expect(settingsSnapshots[0]).toEqual({
      "amp.dangerouslyAllowAll": true,
      "amp.mcpServers": {
        "first-tree-mcp-1": { url: "https://example.test/mcp", headers: { Authorization: "Bearer secret-token" } },
      },
    });
    expect(existsSync(settingsPath ?? "")).toBe(false);
    await handler.shutdown();
  });

  it("classifies official Amp absent-key stdout as credential recovery, not unknown", async () => {
    const events: SessionEvent[] = [];
    const { supervisor, specs } = makeFakeSupervisor([absentKeyAuthFailureScript()]);
    const handler = makeHandler(supervisor);
    const token = makeToken();

    const first = await handler.start(makeMessage("m1", "hello"), makeContext({ events }), token);
    expect(isAmpPendingSessionId(first.sessionId)).toBe(true);
    expect(specs[0]?.args).not.toContain("threads");
    expect(token.retried).toEqual([]);
    expect(token.completed).toMatchObject([
      { status: "error", completion: "consumed", reason: "provider_credential_required" },
    ]);
    expect(events.some((event) => event.kind === "error" && String(event.payload.message).includes("amp login"))).toBe(
      true,
    );
    expect(
      events.some((event) => event.kind === "error" && String(event.payload.message).includes("No API key found")),
    ).toBe(true);
    const errorTexts = events.filter((event) => event.kind === "error").map((event) => String(event.payload.message));
    expect(errorTexts.length).toBeGreaterThan(0);
    assertNoAmpLoginAuthorizationMaterial(JSON.stringify(events));
    assertNoAmpGenericCredentialMaterial(JSON.stringify(events));
    for (const text of errorTexts) {
      assertNoAmpLoginAuthorizationMaterial(text);
      assertNoAmpGenericCredentialMaterial(text);
      const retryPayload = parseProviderRetryEventMessage(text);
      if (!retryPayload) continue;
      assertNoAmpLoginAuthorizationMaterial(JSON.stringify(retryPayload));
      assertNoAmpGenericCredentialMaterial(JSON.stringify(retryPayload));
      assertNoAmpLoginAuthorizationMaterial(formatProviderFailureRuntimeNotice(retryPayload));
      assertNoAmpGenericCredentialMaterial(formatProviderFailureRuntimeNotice(retryPayload));
    }
    await handler.shutdown();
  });

  it("first-turn auth failure returns a synthetic id that must never be sent to threads continue", async () => {
    const events: SessionEvent[] = [];
    const { supervisor, specs } = makeFakeSupervisor([
      authFailureScript(),
      successScript({ sessionId: "T-sess-real-3", text: "recovered" }),
    ]);
    const handler = makeHandler(supervisor);
    const token = makeToken();
    const ctx = makeContext({ events });

    const first = await handler.start(makeMessage("m1", "hello"), ctx, token);
    expect(isAmpPendingSessionId(first.sessionId)).toBe(true);
    expect(first.sessionId.startsWith(AMP_PENDING_SESSION_PREFIX)).toBe(true);
    expect(specs[0]?.args).not.toContain("threads");
    expect(events.some((event) => event.kind === "error" && String(event.payload.message).includes("amp login"))).toBe(
      true,
    );

    await handler.resume(makeMessage("m2", "retry"), first.sessionId, ctx, makeToken());
    expect(specs[1]?.args).not.toContain("threads");
    expect(specs[1]?.args).not.toContain(first.sessionId);
    await handler.shutdown();
  });

  it("does not consume an aborted normal stream as credential recovery when assistant text mentions login-flow wording", async () => {
    const events: SessionEvent[] = [];
    const { supervisor } = makeFakeSupervisor([
      (child) => {
        child.stdout.emit("data", line({ type: "system", subtype: "init", session_id: "T-sess-real-abort" }));
        child.stdout.emit(
          "data",
          line({
            type: "assistant",
            message: {
              content: [{ type: "text", text: "No API key found. Starting login flow..." }],
            },
          }),
        );
      },
    ]);
    const handler = makeHandler(supervisor, {
      ampTurnTimeoutMs: 80,
      ampRetrySleep: async () => true,
    });
    const token = makeToken();

    await handler.start(makeMessage("m1", "explain missing credentials"), makeContext({ events }), token);

    expect(token.completed.some((outcome) => outcome.reason === "provider_credential_required")).toBe(false);
    expect(token.retried).not.toContain("provider_credential_required");
    const errorText = events
      .filter((event) => event.kind === "error")
      .map((event) => String(event.payload.message))
      .join("\n")
      .toLowerCase();
    expect(errorText).not.toContain("amp login");
    expect(errorText).toMatch(/abort|timed out/);
    await handler.shutdown();
  });

  it("does not treat a successful answer that mentions an auth phrase as an auth failure", async () => {
    const events: SessionEvent[] = [];
    const { supervisor } = makeFakeSupervisor([
      successScript({
        sessionId: "T-sess-real-4",
        text: "An invalid api key error usually means AMP_API_KEY is wrong; run amp login. No API key found. Starting login flow is the missing-key path.",
      }),
    ]);
    const forwarded: string[] = [];
    const handler = makeHandler(supervisor);
    const token = makeToken();

    await handler.start(
      makeMessage("m1", "explain an invalid api key error"),
      makeContext({ events, forwardResult: async (text) => void forwarded.push(text) }),
      token,
    );

    expect(token.completed).toMatchObject([{ status: "success" }]);
    expect(token.retried).toEqual([]);
    expect(forwarded[0]).toContain("invalid api key");
    expect(events.some((event) => event.kind === "error")).toBe(false);
    await handler.shutdown();
  });

  it("marks a mixed write+read assistant message unsafe so a later failure is not replayed", async () => {
    const events: SessionEvent[] = [];
    const { supervisor, specs } = makeFakeSupervisor([
      (child) => {
        child.stdout.emit("data", line({ type: "system", subtype: "init", session_id: "T-sess-real-5" }));
        child.stdout.emit(
          "data",
          line({
            type: "assistant",
            message: {
              content: [
                { type: "tool_use", id: "call_write", name: "write", input: { path: "secret.txt" } },
                { type: "tool_use", id: "call_read", name: "read", input: { path: "README.md" } },
              ],
            },
          }),
        );
        child.stdout.emit(
          "data",
          line({
            type: "result",
            subtype: "error",
            is_error: true,
            error: "rate limit exceeded",
            session_id: "T-sess-real-5",
          }),
        );
        child.stdout.emit("end");
        child.emit("close", 1, null);
      },
    ]);
    const handler = makeHandler(supervisor, {
      ampRetrySleep: async () => true,
    });
    const token = makeToken();

    await handler.start(makeMessage("m1", "do the thing"), makeContext({ events }), token);

    expect(specs).toHaveLength(1);
    expect(events.filter((event) => event.kind === "tool_call").map((event) => event.payload.name)).toEqual([
      "write",
      "read",
    ]);
    expect(token.retried).toEqual([]);
    expect(token.completed).toMatchObject([{ status: "error", completion: "consumed" }]);
    await handler.shutdown();
  });

  it("fails closed on a leftover model id without spawning --model", async () => {
    const events: SessionEvent[] = [];
    const { supervisor, specs } = makeFakeSupervisor([
      successScript({ sessionId: "T-should-not-spawn", text: "nope" }),
    ]);
    const handler = makeHandler(supervisor, {
      payload: {
        ...ampPayload(),
        model: "claude-opus-4.6",
      } as AgentRuntimeConfigPayload,
    });
    const token = makeToken();

    await handler.start(makeMessage("m1", "hello"), makeContext({ events }), token);

    expect(specs).toHaveLength(0);
    expect(token.retried).toEqual([]);
    expect(token.completed[0]).toMatchObject({ status: "error" });
    expect(
      events.some((event) => event.kind === "error" && String(event.payload.message).includes("amp_mode_invalid")),
    ).toBe(true);
    await handler.shutdown();
  });

  it("emits token_usage from assistant message.usage when result omits usage", async () => {
    const events: SessionEvent[] = [];
    const { supervisor } = makeFakeSupervisor([
      (child) => {
        child.stdout.emit("data", line({ type: "system", subtype: "init", session_id: "T-usage-2" }));
        child.stdout.emit(
          "data",
          line({
            type: "assistant",
            message: {
              role: "assistant",
              content: [{ type: "text", text: "ok" }],
              usage: { input_tokens: 11, output_tokens: 3, cache_read_input_tokens: 2 },
            },
            session_id: "T-usage-2",
          }),
        );
        child.stdout.emit(
          "data",
          line({
            type: "result",
            subtype: "success",
            is_error: false,
            result: "ok",
            session_id: "T-usage-2",
          }),
        );
        child.stdout.emit("end");
        child.emit("close", 0, null);
      },
    ]);
    const handler = makeHandler(supervisor);
    const token = makeToken();

    await handler.start(makeMessage("m1", "hi"), makeContext({ events }), token);

    expect(token.completed).toMatchObject([{ status: "success" }]);
    expect(events.some((event) => event.kind === "token_usage")).toBe(true);
    expect(events.find((event) => event.kind === "token_usage")).toMatchObject({
      kind: "token_usage",
      payload: { provider: "amp", inputTokens: 11, outputTokens: 3, cachedInputTokens: 2 },
    });
    await handler.shutdown();
  });

  it("clears initialTurnPreparing when resume formatInboundContent throws so inject can drain", async () => {
    const events: SessionEvent[] = [];
    const { supervisor, specs } = makeFakeSupervisor([
      successScript({ sessionId: "T-sess-real", text: "queued turn" }),
    ]);
    const handler = makeHandler(supervisor);
    const ctx = makeContext({ events });
    let failFormat = true;
    ctx.formatInboundContent = async (entry) => {
      if (failFormat) throw new Error("attachment decode failed");
      return String(entry.content);
    };

    await expect(handler.resume(makeMessage("m1", "hello"), "T-sess-real", ctx, makeToken())).rejects.toThrow(
      "attachment decode failed",
    );
    expect(specs).toHaveLength(0);

    failFormat = false;
    const injectToken = makeToken();
    expect(handler.inject(makeMessage("m2", "follow up"), injectToken)).toMatchObject({
      kind: "owned",
      mode: "queued",
    });
    await vi.waitFor(() => {
      if (injectToken.completed.length === 0) throw new Error("queued turn not settled yet");
    });
    expect(specs).toHaveLength(1);
    expect(injectToken.completed).toMatchObject([{ status: "success" }]);
    await handler.shutdown();
  });

  it("gives concurrent same-agent turns distinct settings files across an MCP config change", async () => {
    const releaseFirst: { value: (() => void) | null } = { value: null };
    const releaseSecond: { value: (() => void) | null } = { value: null };
    const firstSettings: { path: string | null; body: unknown } = { path: null, body: null };
    const secondSettings: { path: string | null; body: unknown } = { path: null, body: null };

    const holdScript = (release: { value: (() => void) | null }, sessionId: string) => (child: FakeChild) => {
      void new Promise<void>((resolve) => {
        release.value = resolve;
      }).then(() => {
        child.stdout.emit("data", line({ type: "system", subtype: "init", session_id: sessionId }));
        child.stdout.emit(
          "data",
          line({
            type: "result",
            subtype: "success",
            is_error: false,
            result: "ok",
            session_id: sessionId,
            usage: { input_tokens: 1, output_tokens: 1 },
          }),
        );
        child.stdout.emit("end");
        child.emit("close", 0, null);
      });
    };

    const first = makeFakeSupervisor([holdScript(releaseFirst, "T-concurrent-a")]);
    // Capture settings path at spawn into the outer holders.
    const firstSpawn = first.supervisor.spawn.bind(first.supervisor);
    first.supervisor.spawn = (spec) => {
      const settingsPath = String(spec.args[spec.args.indexOf("--settings-file") + 1]);
      firstSettings.path = settingsPath;
      firstSettings.body = JSON.parse(readFileSync(settingsPath, "utf8"));
      return firstSpawn(spec);
    };

    const second = makeFakeSupervisor([holdScript(releaseSecond, "T-concurrent-b")]);
    const secondSpawn = second.supervisor.spawn.bind(second.supervisor);
    second.supervisor.spawn = (spec) => {
      const settingsPath = String(spec.args[spec.args.indexOf("--settings-file") + 1]);
      secondSettings.path = settingsPath;
      secondSettings.body = JSON.parse(readFileSync(settingsPath, "utf8"));
      return secondSpawn(spec);
    };

    const handlerA = makeHandler(first.supervisor, {
      payload: ampPayload({
        mcpServers: [
          {
            name: "a",
            transport: "http",
            url: "https://example.test/a",
            headers: { Authorization: "Bearer token-a" },
          },
        ],
      }),
    });
    const handlerB = makeHandler(second.supervisor, {
      payload: ampPayload({
        mcpServers: [
          {
            name: "b",
            transport: "http",
            url: "https://example.test/b",
            headers: { Authorization: "Bearer token-b" },
          },
        ],
      }),
    });

    const turnA = handlerA.start(makeMessage("a1", "first"), makeContext({ events: [] }), makeToken());
    await vi.waitFor(() => {
      if (!firstSettings.path) throw new Error("first settings not captured");
    });
    const turnB = handlerB.start(makeMessage("b1", "second"), makeContext({ events: [] }), makeToken());
    await vi.waitFor(() => {
      if (!secondSettings.path) throw new Error("second settings not captured");
    });

    expect(firstSettings.path).not.toBe(secondSettings.path);
    expect(existsSync(firstSettings.path ?? "")).toBe(true);
    expect(existsSync(secondSettings.path ?? "")).toBe(true);
    expect(firstSettings.body).toEqual({
      "amp.dangerouslyAllowAll": true,
      "amp.mcpServers": {
        "first-tree-mcp-1": { url: "https://example.test/a", headers: { Authorization: "Bearer token-a" } },
      },
    });
    expect(secondSettings.body).toEqual({
      "amp.dangerouslyAllowAll": true,
      "amp.mcpServers": {
        "first-tree-mcp-1": { url: "https://example.test/b", headers: { Authorization: "Bearer token-b" } },
      },
    });
    // While both children are still live, neither file may have been replaced with the other's snapshot.
    expect(JSON.parse(readFileSync(firstSettings.path ?? "", "utf8"))).toEqual(firstSettings.body);
    expect(JSON.parse(readFileSync(secondSettings.path ?? "", "utf8"))).toEqual(secondSettings.body);

    releaseFirst.value?.();
    releaseSecond.value?.();
    await Promise.all([turnA, turnB]);
    expect(existsSync(firstSettings.path ?? "")).toBe(false);
    expect(existsSync(secondSettings.path ?? "")).toBe(false);
    await handlerA.shutdown();
    await handlerB.shutdown();
  });
});
