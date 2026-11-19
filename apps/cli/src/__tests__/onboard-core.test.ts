import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const cliFetchMock = vi.hoisted(() => vi.fn());
const ensureFreshAccessTokenMock = vi.hoisted(() => vi.fn());
const credentialForOriginMock = vi.hoisted(() => vi.fn());
const loadCredentialsMock = vi.hoisted(() => vi.fn());
const stderrMock = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

vi.mock("../core/access-token.js", () => ({ credentialForOrigin: credentialForOriginMock }));
vi.mock("../core/cli-fetch.js", () => ({
  cliFetch: cliFetchMock,
}));

const originalFirstTreeHome = process.env.FIRST_TREE_HOME;
const originalServerUrl = process.env.FIRST_TREE_SERVER_URL;

let home: string;

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

beforeEach(() => {
  vi.resetModules();
  home = join(tmpdir(), `ft-onboard-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(join(home, "config"), { recursive: true });
  process.env.FIRST_TREE_HOME = home;
  delete process.env.FIRST_TREE_SERVER_URL;
  cliFetchMock.mockReset();
  ensureFreshAccessTokenMock.mockReset();
  credentialForOriginMock.mockReset();
  loadCredentialsMock.mockReset();
  stderrMock.mockClear();
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  if (originalFirstTreeHome === undefined) delete process.env.FIRST_TREE_HOME;
  else process.env.FIRST_TREE_HOME = originalFirstTreeHome;
  if (originalServerUrl === undefined) delete process.env.FIRST_TREE_SERVER_URL;
  else process.env.FIRST_TREE_SERVER_URL = originalServerUrl;
});

describe("onboard core", () => {
  it("persists and loads resumable onboard state", async () => {
    const { loadOnboardState, saveOnboardState } = await import("../core/onboard.js");

    expect(loadOnboardState()).toBeNull();
    saveOnboardState({ id: "nova", type: "agent", domains: "runtime,tools" });

    expect(loadOnboardState()).toEqual({ id: "nova", type: "agent", domains: "runtime,tools" });
  });

  it("checks credentials, server health, and required inputs", async () => {
    vi.doMock("../core/bootstrap.js", async (importOriginal) => ({
      ...(await importOriginal<typeof import("../core/bootstrap.js")>()),
      loadCredentials: loadCredentialsMock,
    }));
    const { formatCheckReport, onboardCheck } = await import("../core/onboard.js");

    loadCredentialsMock.mockReturnValueOnce({
      accessToken: "a",
      refreshToken: "r",
      serverUrl: "http://first-tree.test",
    });
    process.env.FIRST_TREE_SERVER_URL = "http://first-tree.test";
    cliFetchMock.mockResolvedValueOnce({ ok: true, status: 200 });

    const ok = await onboardCheck({ id: "nova", type: "agent", clientId: "client-1" });
    expect(ok.map((item) => [item.key, item.status, item.value])).toEqual([
      ["connect", "ok", "http://first-tree.test"],
      ["server", "ok", "http://first-tree.test"],
      ["server_reachable", "ok", "healthy"],
      ["id", "ok", "nova"],
      ["type", "ok", "agent"],
      ["client", "ok", "client-1"],
    ]);
    expect(formatCheckReport(ok)).toContain("Signed in");

    loadCredentialsMock.mockReturnValueOnce(null);
    delete process.env.FIRST_TREE_SERVER_URL;
    const missing = await onboardCheck({ id: "", type: "human" });
    expect(missing.map((item) => [item.key, item.status])).toEqual([
      ["connect", "missing_required"],
      ["server", "missing_required"],
      ["id", "missing_required"],
      ["type", "ok"],
    ]);
    expect(formatCheckReport(missing)).toContain("Run `first-tree-dev login <code>` first");

    loadCredentialsMock.mockReturnValueOnce(null);
    process.env.FIRST_TREE_SERVER_URL = "http://hub.test";
    cliFetchMock.mockResolvedValueOnce({ ok: false, status: 503 });
    const unhealthy = await onboardCheck({ id: "nova", type: "agent" });
    expect(unhealthy.map((item) => [item.key, item.status, item.value])).toContainEqual([
      "server_reachable",
      "error",
      "HTTP 503",
    ]);
    expect(unhealthy.map((item) => [item.key, item.value])).toContainEqual([
      "client",
      "(unbound — claimed on first WS connect)",
    ]);

    loadCredentialsMock.mockReturnValueOnce(null);
    cliFetchMock.mockRejectedValueOnce(new Error("offline"));
    const offline = await onboardCheck({ id: "", type: undefined as never });
    expect(offline.map((item) => [item.key, item.status, item.hint])).toContainEqual([
      "server_reachable",
      "error",
      "Cannot connect to server",
    ]);
    expect(offline.map((item) => [item.key, item.status, item.hint])).toContainEqual([
      "type",
      "missing_required",
      "Provide via --type",
    ]);
    expect(
      formatCheckReport([
        { key: "warning", label: "Warning", status: "warning" },
        { key: "optional", label: "Optional", status: "missing_optional" },
      ]),
    ).toContain("Warning");
  });

  it("creates agent and assistant rows and writes local config", async () => {
    vi.doMock("../core/bootstrap.js", async (importOriginal) => ({
      ...(await importOriginal<typeof import("../core/bootstrap.js")>()),
      ensureFreshAccessToken: ensureFreshAccessTokenMock,
    }));
    const { onboardCreate, saveOnboardState } = await import("../core/onboard.js");

    process.env.FIRST_TREE_SERVER_URL = "http://first-tree.test/";
    credentialForOriginMock.mockResolvedValue({ token: "access-1", origin: "http://first-tree.test" });
    cliFetchMock
      .mockResolvedValueOnce(
        jsonResponse(200, {
          memberships: [{ organizationId: "org-1", organizationName: "Acme" }],
          defaultOrganizationId: "org-1",
        }),
      )
      .mockResolvedValueOnce(jsonResponse(200, { uuid: "human-uuid", name: "gandy" }))
      .mockResolvedValueOnce(jsonResponse(200, { uuid: "assistant-uuid", name: "gandy-assistant" }));
    saveOnboardState({ id: "gandy" });

    await onboardCreate({
      id: "gandy",
      type: "human",
      displayName: "Gandy",
      assistant: "helper",
      role: "Lead",
      domains: "runtime, tools",
      clientId: "client-1",
    });

    // The flow binds to the destination it resolved, and never reads a bare
    // saved token: a regression to `ensureFreshAccessToken` fails here instead
    // of silently sending `Bearer undefined`.
    expect(credentialForOriginMock).toHaveBeenCalledWith("http://first-tree.test");
    expect(ensureFreshAccessTokenMock).not.toHaveBeenCalled();
    expect(cliFetchMock.mock.calls.map((call) => String(call[0]))).toEqual([
      "http://first-tree.test/api/v1/me",
      "http://first-tree.test/api/v1/orgs/org-1/agents",
      "http://first-tree.test/api/v1/orgs/org-1/agents",
    ]);
    expect(JSON.parse(String(cliFetchMock.mock.calls[1]?.[1]?.body))).toMatchObject({
      name: "gandy",
      type: "human",
      displayName: "Gandy",
      delegateMention: "helper",
      metadata: { role: "Lead", domains: ["runtime", "tools"] },
    });
    expect(JSON.parse(String(cliFetchMock.mock.calls[2]?.[1]?.body))).toMatchObject({
      name: "helper",
      type: "agent",
      visibility: "private",
      clientId: "client-1",
    });
    expect(readFileSync(join(home, "config", "agents", "gandy-assistant", "agent.yaml"), "utf8")).toContain(
      'agentId: "assistant-uuid"',
    );
    expect(readFileSync(join(home, "config", "client.yaml"), "utf8")).toContain("url: http://first-tree.test");
    expect(stderrMock.mock.calls.map((call) => String(call[0])).join("")).toContain("Onboard complete");
  });

  it("surfaces organization ambiguity and agent creation errors", async () => {
    vi.doMock("../core/bootstrap.js", async (importOriginal) => ({
      ...(await importOriginal<typeof import("../core/bootstrap.js")>()),
      ensureFreshAccessToken: ensureFreshAccessTokenMock,
    }));
    const { onboardCreate } = await import("../core/onboard.js");

    process.env.FIRST_TREE_SERVER_URL = "http://first-tree.test";
    credentialForOriginMock.mockResolvedValue({ token: "access-1", origin: "http://first-tree.test" });
    cliFetchMock.mockResolvedValueOnce(
      jsonResponse(200, {
        memberships: [
          { organizationId: "org-1", organizationName: "Acme" },
          { organizationId: "org-2", organizationName: "Other" },
        ],
      }),
    );

    await expect(onboardCreate({ id: "nova", type: "agent" })).rejects.toThrow(
      "Multiple organizations — pass --org explicitly to onboard",
    );

    cliFetchMock.mockReset();
    cliFetchMock
      .mockResolvedValueOnce(
        jsonResponse(200, { memberships: [{ organizationId: "org-1", organizationName: "Acme" }] }),
      )
      .mockResolvedValueOnce(jsonResponse(409, { error: "name already exists" }));

    await expect(onboardCreate({ id: "nova", type: "agent" })).rejects.toThrow("name already exists");
  });

  it("creates runtime agent configs and tolerates assistant/state cleanup failures", async () => {
    vi.doMock("../core/bootstrap.js", async (importOriginal) => ({
      ...(await importOriginal<typeof import("../core/bootstrap.js")>()),
      ensureFreshAccessToken: ensureFreshAccessTokenMock,
    }));
    const { onboardCreate } = await import("../core/onboard.js");

    process.env.FIRST_TREE_SERVER_URL = "http://hub.test";
    credentialForOriginMock.mockResolvedValue({ token: "access-1", origin: "http://first-tree.test" });
    cliFetchMock
      .mockResolvedValueOnce(
        jsonResponse(200, {
          memberships: [
            { organizationId: "org-1", organizationName: "Acme" },
            { organizationId: "org-2", organizationName: "Other" },
          ],
          defaultOrganizationId: "org-2",
        }),
      )
      .mockResolvedValueOnce(jsonResponse(200, { uuid: "agent-uuid", name: null }))
      .mockResolvedValueOnce(jsonResponse(500, { error: "assistant failed" }));
    mkdirSync(join(home, ".onboard-state.json"), { recursive: true });

    await onboardCreate({
      id: "nova",
      type: "agent",
      assistant: "helper",
      clientId: "client-1",
    });

    expect(JSON.parse(String(cliFetchMock.mock.calls[1]?.[1]?.body))).toMatchObject({
      name: "nova",
      type: "agent",
      displayName: "nova",
      delegateMention: "helper",
      clientId: "client-1",
    });
    expect(readFileSync(join(home, "config", "agents", "nova", "agent.yaml"), "utf8")).toContain(
      'agentId: "agent-uuid"',
    );
    const output = stderrMock.mock.calls.map((call) => String(call[0])).join("");
    expect(output).toContain('Warning: Failed to create assistant "helper": assistant failed');
    expect(output).toContain("Agent:     nova");
  });
});
