import { Command } from "commander";
import { beforeEach, describe, expect, it, vi } from "vitest";

const bootstrapMocks = vi.hoisted(() => ({
  ensureFreshAccessToken: vi.fn(),
  resolveServerUrl: vi.fn(),
  saveAgentConfig: vi.fn(),
  loadConfig: vi.fn(),
  loadAgentConfig: vi.fn(),
  readActiveRootClientId: vi.fn(),
}));

const ioMocks = vi.hoisted(() => ({
  readStdin: vi.fn(),
  readMessageBody: vi.fn(),
  guardInlineDescription: vi.fn(),
  guardInlineShellResidue: vi.fn(),
  looksLikeEscapedNewlineBody: vi.fn(),
}));

const sdkMocks = vi.hoisted(() => ({
  createSdk: vi.fn(),
  handleSdkError: vi.fn((error: unknown) => {
    throw error instanceof Error ? error : new Error(String(error));
  }),
}));

const outputMocks = vi.hoisted(() => ({
  fail: vi.fn((code: string, message: string, exitCode = 1) => {
    throw Object.assign(new Error(message), { code, exitCode });
  }),
  success: vi.fn(),
  printLine: vi.fn(),
}));

const fetchMock = vi.hoisted(() => vi.fn());
const captureOutboundDocsMock = vi.hoisted(() => vi.fn());

vi.mock("../core/bootstrap.js", () => bootstrapMocks);
vi.mock("../core/cli-fetch.js", () => ({ cliFetch: fetchMock }));
vi.mock("../core/doc-capture.js", () => ({ captureOutboundDocs: captureOutboundDocsMock }));
vi.mock("../commands/chat/_shared/io.js", () => ioMocks);
vi.mock("../commands/_shared/local-agent.js", () => sdkMocks);
vi.mock("../cli/output.js", () => ({
  fail: outputMocks.fail,
  success: outputMocks.success,
}));
vi.mock("../core/output.js", () => ({
  print: { line: outputMocks.printLine },
  isJsonMode: () => false,
  setJsonMode: vi.fn(),
}));

function jsonResponse(body: unknown, ok = true, status = ok ? 200 : 500): Response {
  return {
    ok,
    status,
    statusText: ok ? "OK" : "Failed",
    json: async () => body,
    text: async () => (typeof body === "string" ? body : JSON.stringify(body)),
  } as Response;
}

function makeSdk(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    createTaskChat: vi.fn(async () => ({ chatId: "chat_1" })),
    sendMessage: vi.fn(async () => ({ messageId: "msg_1" })),
    listDocs: vi.fn(async () => ({ items: [], nextCursor: null })),
    ...overrides,
  };
}

async function runWith(register: (program: Command) => void, args: string[]): Promise<void> {
  const program = new Command();
  program.exitOverride();
  program.configureOutput({ writeOut: () => undefined, writeErr: () => undefined });
  program.option("--json");
  program.option("--debug");
  program.option("--quiet");
  register(program);
  await program.parseAsync(["node", "first-tree", ...args]);
}

describe("CLI command branch sweeper", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.FIRST_TREE_CHAT_ID;
    bootstrapMocks.resolveServerUrl.mockReturnValue("https://first-tree.example");
    bootstrapMocks.ensureFreshAccessToken.mockResolvedValue("access-token");
    bootstrapMocks.saveAgentConfig.mockReturnValue("/tmp/agent-alpha");
    ioMocks.readStdin.mockResolvedValue("stdin body");
    ioMocks.readMessageBody.mockResolvedValue("file body");
    ioMocks.looksLikeEscapedNewlineBody.mockReturnValue(false);
    captureOutboundDocsMock.mockImplementation(async (content: string) => ({ content }));
    sdkMocks.createSdk.mockReturnValue(makeSdk());
  });

  it("exercises agent create org selection and error branches", async () => {
    const { registerAgentCommands } = await import("../commands/agent/index.js");

    fetchMock
      .mockResolvedValueOnce(
        jsonResponse({
          memberships: [{ organizationId: "org-one", organizationName: "One", role: "admin" }],
        }),
      )
      .mockResolvedValueOnce(jsonResponse({ uuid: "agent-uuid", name: null }));

    await runWith(registerAgentCommands, [
      "agent",
      "create",
      "agent-alpha",
      "--type",
      "agent",
      "--client-id",
      "client-a",
      "--runtime",
      "codex",
      "--display-name",
      "Agent Alpha",
    ]);

    expect(outputMocks.success).not.toHaveBeenCalled();
    expect(outputMocks.printLine.mock.calls.join("\n")).toContain("agent-uuid");

    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        memberships: [
          { organizationId: "org-one", organizationName: "One", role: "admin" },
          { organizationId: "org-two", organizationName: "Two", role: "member" },
        ],
      }),
    );
    await expect(
      runWith(registerAgentCommands, ["agent", "create", "agent-beta", "--type", "agent", "--client-id", "client-a"]),
    ).rejects.toMatchObject({ code: "CREATE_ERROR" });
    expect(outputMocks.fail).toHaveBeenCalledWith(
      "AMBIGUOUS_ORG",
      expect.stringContaining("multiple organizations"),
      1,
    );

    fetchMock.mockResolvedValueOnce(jsonResponse({ memberships: [] }));
    await expect(
      runWith(registerAgentCommands, ["agent", "create", "agent-gamma", "--type", "human", "--client-id", "client-a"]),
    ).rejects.toMatchObject({ code: "CREATE_ERROR" });
    expect(outputMocks.fail).toHaveBeenCalledWith("NO_ORG", "You don't belong to any organization", 1);

    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        memberships: [{ organizationId: "org-one", organizationName: "One", role: "admin" }],
      }),
    );
    await expect(
      runWith(registerAgentCommands, [
        "agent",
        "create",
        "agent-delta",
        "--type",
        "agent",
        "--client-id",
        "client-a",
        "--org",
        "missing",
      ]),
    ).rejects.toMatchObject({ code: "CREATE_ERROR" });
    expect(outputMocks.fail).toHaveBeenCalledWith("ORG_NOT_FOUND", 'Not an active member of organization "missing"', 1);

    fetchMock.mockResolvedValueOnce(jsonResponse("down", false, 503));
    await expect(
      runWith(registerAgentCommands, [
        "agent",
        "create",
        "agent-epsilon",
        "--type",
        "agent",
        "--client-id",
        "client-a",
      ]),
    ).rejects.toMatchObject({ code: "CREATE_ERROR" });
    expect(outputMocks.fail).toHaveBeenCalledWith("FETCH_ERROR", "Failed to fetch /me: HTTP 503", 1);
  });

  it("hides release-gated providers from agent create selection", async () => {
    const { registerAgentCommands } = await import("../commands/agent/index.js");

    const program = new Command();
    program.configureOutput({ writeOut: () => undefined, writeErr: () => undefined });
    registerAgentCommands(program);
    const agentCommand = program.commands.find((command) => command.name() === "agent");
    const createCommand = agentCommand?.commands.find((command) => command.name() === "create");
    const help = createCommand?.helpInformation() ?? "";
    expect(help).toContain("codex");
    expect(help).not.toContain("antigravity");

    await expect(
      runWith(registerAgentCommands, [
        "agent",
        "create",
        "agent-gated",
        "--type",
        "agent",
        "--client-id",
        "client-a",
        "--runtime",
        "antigravity",
      ]),
    ).rejects.toMatchObject({ code: "CREATE_ERROR" });
    expect(outputMocks.fail).toHaveBeenCalledWith(
      "INVALID_RUNTIME",
      expect.stringContaining('Runtime "antigravity" is not selectable'),
      1,
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("exercises chat create optional payload and validation branches", async () => {
    const { registerChatCommands } = await import("../commands/chat/index.js");
    const sdk = makeSdk();
    sdkMocks.createSdk.mockReturnValue(sdk);
    captureOutboundDocsMock.mockResolvedValueOnce({
      content: "captured body",
      attachments: [{ documentId: "doc_1" }],
      documentContext: { excerpts: [] },
    });

    await runWith(registerChatCommands, [
      "chat",
      "create",
      "hello",
      "--to",
      "alice",
      "--with",
      "bob",
      "--topic",
      "Topic",
      "--description",
      "Inline description",
      "--metadata",
      '{"source":"test"}',
      "--request",
      "--options",
      '[{"label":"Yes","description":"Approve"},{"label":"No","description":"Reject"}]',
      "--multi-select",
    ]);

    expect(sdk.createTaskChat).toHaveBeenCalledWith(
      expect.objectContaining({
        contextParticipantNames: ["bob"],
        topic: "Topic",
        description: "Inline description",
        initialMessage: expect.objectContaining({
          format: "request",
          metadata: expect.objectContaining({
            source: "test",
            attachments: [{ documentId: "doc_1" }],
            documentContext: { excerpts: [] },
          }),
        }),
      }),
    );

    await expect(runWith(registerChatCommands, ["chat", "create", "hello"])).rejects.toMatchObject({
      code: "NO_TARGET",
    });
    await expect(
      runWith(registerChatCommands, ["chat", "create", "hello", "--to", "alice", "--to", "bob", "--request"]),
    ).rejects.toMatchObject({ code: "REQUEST_NEEDS_ONE_TARGET" });
    await expect(
      runWith(registerChatCommands, ["chat", "create", "hello", "--to", "alice", "--metadata", "{bad"]),
    ).rejects.toMatchObject({ code: "INVALID_METADATA" });
    await expect(
      runWith(registerChatCommands, ["chat", "create", "hello", "--to", "alice", "--format", "xml"]),
    ).rejects.toMatchObject({ code: "INVALID_FORMAT" });
  });

  it("exercises chat send optional payload and validation branches", async () => {
    const { registerChatCommands } = await import("../commands/chat/index.js");
    const sdk = makeSdk();
    sdkMocks.createSdk.mockReturnValue(sdk);
    process.env.FIRST_TREE_CHAT_ID = "chat_1";
    captureOutboundDocsMock.mockResolvedValueOnce({
      content: "captured file body",
      attachments: [{ documentId: "doc_1" }],
      documentContext: { excerpts: [] },
    });

    await runWith(registerChatCommands, [
      "chat",
      "send",
      "alice",
      "--message-file",
      "message.md",
      "--metadata",
      '{"kind":"status"}',
      "--reply-to",
      "msg_parent",
    ]);

    expect(sdk.sendMessage).toHaveBeenCalledWith(
      "chat_1",
      expect.objectContaining({
        receiverNames: ["alice"],
        inReplyTo: "msg_parent",
        metadata: expect.objectContaining({
          kind: "status",
          attachments: [{ documentId: "doc_1" }],
          documentContext: { excerpts: [] },
        }),
      }),
    );

    await expect(
      runWith(registerChatCommands, ["chat", "send", "alice", "inline", "--message-file", "x"]),
    ).rejects.toMatchObject({
      code: "CONFLICTING_ARGS",
    });

    ioMocks.looksLikeEscapedNewlineBody.mockReturnValueOnce(true);
    await expect(runWith(registerChatCommands, ["chat", "send", "alice", "line\\nline"])).rejects.toMatchObject({
      code: "ESCAPED_NEWLINES",
    });

    ioMocks.looksLikeEscapedNewlineBody.mockReturnValue(false);
    await expect(
      runWith(registerChatCommands, ["chat", "send", "alice", "hello", "--metadata", "{bad"]),
    ).rejects.toMatchObject({
      code: "INVALID_METADATA",
    });

    delete process.env.FIRST_TREE_CHAT_ID;
    await expect(runWith(registerChatCommands, ["chat", "send", "alice", "hello"])).rejects.toMatchObject({
      code: "NO_CHAT_CONTEXT",
    });
  });

  it("exercises doc list option parsing branches", async () => {
    const { registerDocCommands } = await import("../commands/doc/index.js");
    const sdk = makeSdk();
    sdkMocks.createSdk.mockReturnValue(sdk);

    await runWith(registerDocCommands, [
      "doc",
      "list",
      "--project",
      "alpha",
      "--status",
      "approved",
      "--limit",
      "25",
      "--cursor",
      "next",
      "--agent",
      "agent-alpha",
    ]);

    expect(sdk.listDocs).toHaveBeenCalledWith({
      project: "alpha",
      status: "approved",
      limit: 25,
      cursor: "next",
    });

    await expect(runWith(registerDocCommands, ["doc", "list", "--status", "unknown"])).rejects.toMatchObject({
      code: "INVALID_STATUS",
    });
  });
});
