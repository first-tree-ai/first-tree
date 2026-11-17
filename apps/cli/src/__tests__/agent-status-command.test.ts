import { Command } from "commander";
import { beforeEach, describe, expect, it, vi } from "vitest";

const bootstrapMocks = vi.hoisted(() => {
  const ensureFreshAccessToken = vi.fn();
  return {
    ensureFreshAccessToken,
    // SEC-023 resolves the bound form. Derive it from the string stub so every
    // resolver/rejection in these cases applies to both without mirroring.
    ensureFreshBoundAccessToken: async (...args: unknown[]) => ({
      token: await ensureFreshAccessToken(...args),
      origin: null,
    }),
  resolveServerUrl: vi.fn(),
};
});

const fetchMock = vi.hoisted(() => vi.fn());
const printLineMock = vi.hoisted(() => vi.fn());
const failMock = vi.hoisted(() =>
  vi.fn((code: string, message: string, exitCode = 1) => {
    throw Object.assign(new Error(message), { code, exitCode });
  }),
);

vi.mock("../core/bootstrap.js", () => bootstrapMocks);
vi.mock("../core/cli-fetch.js", () => ({
  cliFetch: fetchMock,
}));
vi.mock("../core/output.js", () => ({
  print: { line: printLineMock },
}));
vi.mock("../cli/output.js", () => ({
  fail: failMock,
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

async function runStatus(args: string[] = []): Promise<void> {
  const { registerAgentStatusCommand } = await import("../commands/agent/status.js");
  const program = new Command();
  program.exitOverride();
  program.configureOutput({ writeOut: () => undefined, writeErr: () => undefined });
  const agent = program.command("agent");
  registerAgentStatusCommand(agent);
  await program.parseAsync(["node", "test", "agent", "status", ...args]);
}

function output(): string {
  return printLineMock.mock.calls.map((call) => String(call[0])).join("");
}

describe("agent status command", () => {
  beforeEach(() => {
    bootstrapMocks.resolveServerUrl.mockReset();
    bootstrapMocks.ensureFreshAccessToken.mockReset();
    fetchMock.mockReset();
    printLineMock.mockReset();
    failMock.mockClear();

    bootstrapMocks.resolveServerUrl.mockReturnValue("https://first-tree.example");
    bootstrapMocks.ensureFreshAccessToken.mockResolvedValue("access-token");
  });

  it("aggregates runtime activity across all memberships", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ memberships: [{ organizationId: "org-a" }, { organizationId: "org-b" }] }))
      .mockResolvedValueOnce(
        jsonResponse({
          total: 2,
          running: 1,
          byState: { idle: 1, working: 0, blocked: 0, error: 1 },
          clients: 1,
          agents: [
            {
              agentId: "agent-a",
              clientId: "client-a",
              runtimeType: "claude-code",
              runtimeState: "idle",
              activeSessions: 1,
              totalSessions: 3,
            },
          ],
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          total: 1,
          running: 1,
          byState: { idle: 0, working: 1, blocked: 0, error: 0 },
          clients: 2,
          agents: [
            {
              agentId: "agent-b",
              clientId: null,
              runtimeType: "codex",
              runtimeState: "working",
              activeSessions: null,
              totalSessions: null,
            },
          ],
        }),
      );

    await runStatus(["--server", "https://override.example"]);

    expect(bootstrapMocks.resolveServerUrl).toHaveBeenCalledWith("https://override.example");
    expect(fetchMock).toHaveBeenCalledWith(
      "https://first-tree.example/api/v1/orgs/org-a/activity",
      expect.objectContaining({ headers: { Authorization: "Bearer access-token" } }),
    );
    expect(output()).toContain("Clients: 3 connected");
    expect(output()).toContain("Agents: 2 running / 3 total");
    expect(output()).toContain("agent-a");
    expect(output()).toContain("agent-b");
  });

  it("renders a specific agent status and the not-running branch", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ memberships: [{ organizationId: "org-a" }] })).mockResolvedValueOnce(
      jsonResponse({
        total: 1,
        running: 1,
        byState: { idle: 0, working: 1, blocked: 0, error: 0 },
        clients: 1,
        agents: [
          {
            agentId: "agent-a",
            clientId: "client-a",
            runtimeType: "claude-code",
            runtimeState: "working",
            activeSessions: 2,
            totalSessions: 4,
          },
        ],
      }),
    );

    await runStatus(["agent-a"]);
    expect(output()).toContain("Agent: agent-a");
    expect(output()).toContain("Sessions: 2 active / 4 total");
    expect(output()).toContain("Client: client-a");

    printLineMock.mockClear();
    fetchMock.mockResolvedValueOnce(jsonResponse({ memberships: [{ organizationId: "org-a" }] })).mockResolvedValueOnce(
      jsonResponse({
        total: 0,
        running: 0,
        byState: { idle: 0, working: 0, blocked: 0, error: 0 },
        clients: 0,
        agents: [],
      }),
    );

    await runStatus(["missing-agent"]);
    expect(output()).toContain('Agent "missing-agent" is not running');
  });

  it("skips failed org activity responses and renders nullable runtime fields", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ memberships: [{ organizationId: "org-a" }, { organizationId: "org-b" }] }))
      .mockResolvedValueOnce(jsonResponse("down", false, 503))
      .mockResolvedValueOnce(
        jsonResponse({
          total: 1,
          running: 1,
          byState: { idle: 0, working: 0, blocked: 1, error: 0 },
          clients: 1,
          agents: [
            {
              agentId: "agent-nullable",
              clientId: null,
              runtimeType: null,
              runtimeState: null,
              activeSessions: 3,
              totalSessions: null,
            },
            {
              agentId: null,
              clientId: null,
              runtimeType: null,
              runtimeState: null,
              activeSessions: null,
              totalSessions: null,
            },
          ],
        }),
      );

    await runStatus();

    expect(output()).toContain("agent-nullable");
    expect(output()).toContain("3/0");
    expect(output()).toContain("—");

    printLineMock.mockClear();
    fetchMock.mockResolvedValueOnce(jsonResponse({ memberships: [{ organizationId: "org-a" }] })).mockResolvedValueOnce(
      jsonResponse({
        total: 1,
        running: 1,
        byState: { idle: 0, working: 0, blocked: 1, error: 0 },
        clients: 1,
        agents: [
          {
            agentId: "agent-nullable",
            clientId: null,
            runtimeType: null,
            runtimeState: null,
            activeSessions: 3,
            totalSessions: null,
          },
        ],
      }),
    );

    await runStatus(["agent-nullable"]);

    expect(output()).toContain("Runtime: —");
    expect(output()).toContain("State: —");
    expect(output()).toContain("Sessions: 3 active / 0 total");
  });

  it("maps /me failures and unexpected errors to clean CLI failures", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse("nope", false, 503));

    await expect(runStatus()).rejects.toMatchObject({ code: "STATUS_ERROR" });
    expect(failMock).toHaveBeenCalledWith("FETCH_ERROR", "/me HTTP 503", 1);
    expect(failMock).toHaveBeenLastCalledWith("STATUS_ERROR", "/me HTTP 503");

    failMock.mockClear();
    fetchMock.mockReset();
    bootstrapMocks.ensureFreshAccessToken.mockRejectedValueOnce(new Error("credentials missing"));

    await expect(runStatus()).rejects.toMatchObject({ code: "STATUS_ERROR" });
    expect(failMock).toHaveBeenCalledWith("STATUS_ERROR", "credentials missing");

    failMock.mockClear();
    bootstrapMocks.ensureFreshAccessToken.mockRejectedValueOnce("credentials string");

    await expect(runStatus()).rejects.toMatchObject({ code: "STATUS_ERROR" });
    expect(failMock).toHaveBeenCalledWith("STATUS_ERROR", "credentials string");
  });
});
