import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CommandContext } from "../commands/types.js";

const bootstrapMocks = vi.hoisted(() => ({
  ensureFreshAccessToken: vi.fn(),
  resolveServerUrl: vi.fn(),
}));

const treeSharedMocks = vi.hoisted(() => ({
  runCommand: vi.fn(),
}));

vi.mock("../core/bootstrap.js", () => ({
  ensureFreshAccessToken: bootstrapMocks.ensureFreshAccessToken,
  // SEC-023 resolves the bound form; these cases never check an origin, so the
  // pair abstains (`origin: null`) and the assertion is a no-op.
  ensureFreshBoundAccessToken: async (...args: unknown[]) => ({
    token: await bootstrapMocks.ensureFreshAccessToken(...args),
    origin: null,
  }),
  resolveServerUrl: bootstrapMocks.resolveServerUrl,
}));

vi.mock("../commands/tree/shared.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../commands/tree/shared.js")>();
  return {
    ...actual,
    runCommand: treeSharedMocks.runCommand,
  };
});

const originalCwd = process.cwd();
const tempDirs: string[] = [];
type FetchInput = Parameters<typeof fetch>[0];
type FetchInit = Parameters<typeof fetch>[1];

function requestPath(input: FetchInput): string {
  return new URL(String(input)).pathname;
}

function isPath(input: FetchInput, path: string): boolean {
  return requestPath(input) === path;
}

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "ft-tree-init-action-"));
  tempDirs.push(dir);
  return dir;
}

function context(command: Command, json = false): CommandContext {
  return { command, options: { debug: false, json, quiet: false } };
}

function commandWithOptions(options: Record<string, unknown>): Command {
  const command = new Command("init");
  for (const [key, value] of Object.entries(options)) {
    command.setOptionValue(key, value);
  }
  return command;
}

function response(body: unknown, init: ResponseInit = {}): Response {
  return new Response(typeof body === "string" ? body : JSON.stringify(body), {
    headers: { "content-type": "application/json" },
    ...init,
  });
}

function bindingResponse(init?: FetchInit): Response {
  if (typeof init?.body !== "string") throw new Error("expected a JSON binding request body");
  const body: unknown = JSON.parse(init.body);
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new Error("expected an object binding request body");
  }
  return response({
    provider: Reflect.get(body, "provider"),
    repo: Reflect.get(body, "repo"),
    branch: Reflect.get(body, "branch"),
  });
}

function mockGithubApi(): void {
  treeSharedMocks.runCommand.mockImplementation((tool: string, args: string[]) => {
    if (args[0] === "--version" || (tool === "gh" && args[0] === "auth" && args[1] === "status")) {
      return "";
    }
    if (tool === "gh" && args[0] === "api" && args[1] === "user") {
      return "octocat";
    }
    if (tool === "gh" && args[0] === "api" && typeof args[1] === "string" && args[1].startsWith("users/")) {
      return decodeURIComponent(args[1].slice("users/".length)).toLowerCase();
    }
    if (tool === "gh" && args[0] === "api" && typeof args[1] === "string" && args[1].startsWith("repos/")) {
      return JSON.stringify({ html_url: `https://github.com/${args[1].slice("repos/".length)}` });
    }
    return "";
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  bootstrapMocks.resolveServerUrl.mockReturnValue("https://server.example");
  bootstrapMocks.ensureFreshAccessToken.mockResolvedValue("access-token");
  mockGithubApi();
  process.exitCode = undefined;
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  process.chdir(originalCwd);
  process.exitCode = undefined;
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

describe("tree init command action", () => {
  it("creates and summarizes an unbound Context Tree with local gh/git only", async () => {
    const { initCommand } = await import("../commands/tree/init.js");
    const base = makeTempDir();
    process.chdir(base);
    const command = commandWithOptions({
      bind: false,
      dir: "local-tree",
      name: "custom-tree",
      public: true,
      title: "Acme Product",
      withWorkflow: true,
    });

    await initCommand.action(context(command, true));

    const root = join(base, "local-tree");
    const commandRoot = realpathSync(root);
    expect(process.exitCode).toBeUndefined();
    expect(existsSync(join(root, "NODE.md"))).toBe(true);
    expect(existsSync(join(root, "members", "octocat", "NODE.md"))).toBe(true);
    expect(existsSync(join(root, ".github", "workflows", "validate-tree.yml"))).toBe(true);
    expect(readFileSync(join(root, "NODE.md"), "utf8")).toContain("Acme Product Context Tree");
    expect(treeSharedMocks.runCommand).toHaveBeenCalledWith(
      "gh",
      ["repo", "create", "octocat/custom-tree", "--public", "--source", commandRoot, "--remote", "origin", "--push"],
      commandRoot,
    );

    const summary = JSON.parse(String(vi.mocked(console.log).mock.calls.at(-1)?.[0])) as Record<string, unknown>;
    expect(summary).toMatchObject({
      bound: false,
      branch: "main",
      htmlUrl: "https://github.com/octocat/custom-tree",
      owner: "octocat",
      withWorkflow: true,
    });
    expect(summary.coverage).toBeNull();
    expect(summary).not.toHaveProperty("outcome");
    expect(summary).not.toHaveProperty("teamId");
  });

  it("canonicalizes a case-variant owner before creating the remote", async () => {
    const { initCommand } = await import("../commands/tree/init.js");
    const base = makeTempDir();
    process.chdir(base);

    await initCommand.action(
      context(commandWithOptions({ bind: false, owner: "ACME-Org", title: "Case Owner" }), true),
    );

    const root = join(base, "case-owner-context-tree");
    const commandRoot = realpathSync(root);
    expect(process.exitCode).toBeUndefined();
    expect(treeSharedMocks.runCommand).toHaveBeenCalledWith(
      "gh",
      [
        "repo",
        "create",
        "acme-org/case-owner-context-tree",
        "--private",
        "--source",
        commandRoot,
        "--remote",
        "origin",
        "--push",
      ],
      commandRoot,
    );
    const ownerLookupIndex = treeSharedMocks.runCommand.mock.calls.findIndex(
      ([tool, args]) => tool === "gh" && Array.isArray(args) && args[0] === "api" && args[1] === "users/ACME-Org",
    );
    const repoCreateIndex = treeSharedMocks.runCommand.mock.calls.findIndex(
      ([tool, args]) => tool === "gh" && Array.isArray(args) && args[0] === "repo" && args[1] === "create",
    );
    expect(ownerLookupIndex).toBeGreaterThanOrEqual(0);
    expect(ownerLookupIndex).toBeLessThan(repoCreateIndex);
    const summary = JSON.parse(String(vi.mocked(console.log).mock.calls.at(-1)?.[0])) as Record<string, unknown>;
    expect(summary).toMatchObject({
      owner: "acme-org",
      htmlUrl: "https://github.com/acme-org/case-owner-context-tree",
    });
  });

  it("canonicalizes a case-variant owner before binding and remote create", async () => {
    const { initCommand } = await import("../commands/tree/init.js");
    const base = makeTempDir();
    process.chdir(base);
    const fetchMock = vi.fn(async (input: FetchInput, init?: FetchInit) => {
      const url = String(input);
      if (url.endsWith("/api/v1/me")) {
        return response({ defaultOrganizationId: "org_1", memberships: [{ organizationId: "org_1", role: "admin" }] });
      }
      if (url.endsWith("/api/v1/orgs/org_1/settings/context_tree/raw")) {
        return response({ branch: "main" });
      }
      if (url.endsWith("/api/v1/orgs/org_1/context-tree/installation")) {
        return response({
          accountLogin: "acme-org",
          accountType: "Organization",
          installationId: 123,
          suspended: false,
        });
      }
      if (url.endsWith("/api/v1/orgs/org_1/settings/context_tree/initialize") && init?.method === "POST") {
        expect(init.body).toBe(
          JSON.stringify({
            provider: "github",
            repo: "https://github.com/acme-org/case-owner-context-tree",
            branch: "main",
            expectedUnboundBranch: "main",
          }),
        );
        return bindingResponse(init);
      }
      return response("not found", { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);

    await initCommand.action(context(commandWithOptions({ bind: true, owner: "ACME-Org", title: "Case Owner" }), true));

    expect(process.exitCode).toBeUndefined();
    expect(treeSharedMocks.runCommand).toHaveBeenCalledWith(
      "gh",
      [
        "repo",
        "create",
        "acme-org/case-owner-context-tree",
        "--private",
        "--source",
        expect.any(String),
        "--remote",
        "origin",
        "--push",
      ],
      expect.any(String),
    );
    const ownerLookupIndex = treeSharedMocks.runCommand.mock.calls.findIndex(
      ([tool, args]) => tool === "gh" && Array.isArray(args) && args[0] === "api" && args[1] === "users/ACME-Org",
    );
    const repoCreateIndex = treeSharedMocks.runCommand.mock.calls.findIndex(
      ([tool, args]) => tool === "gh" && Array.isArray(args) && args[0] === "repo" && args[1] === "create",
    );
    expect(ownerLookupIndex).toBeGreaterThanOrEqual(0);
    expect(ownerLookupIndex).toBeLessThan(repoCreateIndex);
    const summary = JSON.parse(String(vi.mocked(console.log).mock.calls.at(-1)?.[0])) as Record<string, unknown>;
    expect(summary).toMatchObject({
      bound: true,
      owner: "acme-org",
      htmlUrl: "https://github.com/acme-org/case-owner-context-tree",
    });
  });

  it("reports a binding failure with the canonical owner and manual deletion guidance", async () => {
    const { initCommand } = await import("../commands/tree/init.js");
    const base = makeTempDir();
    process.chdir(base);
    const fetchMock = vi.fn(async (input: FetchInput, init?: FetchInit) => {
      const url = String(input);
      if (url.endsWith("/api/v1/me")) {
        return response({ memberships: [{ organizationId: "org_1", role: "admin" }] });
      }
      if (url.endsWith("/api/v1/orgs/org_1/settings/context_tree/raw")) {
        return response({ branch: "main" });
      }
      if (url.endsWith("/api/v1/orgs/org_1/context-tree/installation")) {
        return response({ code: "no_installation" }, { status: 404 });
      }
      if (url.endsWith("/api/v1/orgs/org_1/settings/context_tree/initialize") && init?.method === "POST") {
        return response("private upstream detail: do-not-leak", { status: 500 });
      }
      return response("not found", { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);

    await initCommand.action(
      context(commandWithOptions({ bind: true, owner: "ACME-Org", title: "Case Owner" }), false),
    );

    expect(process.exitCode).toBe(1);
    const error = String(vi.mocked(console.error).mock.calls.at(-1)?.[0]);
    expect(error).toContain("binding failed (server returned 500)");
    expect(error).toContain("organization org_1");
    expect(error).toContain("https://github.com/acme-org/case-owner-context-tree");
    expect(error).toContain("repo was created but not bound");
    expect(error).toContain("delete it manually");
    expect(error).toContain("branch main");
    expect(error).toContain("Read back");
    expect(error).not.toContain("do-not-leak");
    expect(treeSharedMocks.runCommand).toHaveBeenCalledWith(
      "gh",
      [
        "repo",
        "create",
        "acme-org/case-owner-context-tree",
        "--private",
        "--source",
        expect.any(String),
        "--remote",
        "origin",
        "--push",
      ],
      expect.any(String),
    );
    const ownerLookupIndex = treeSharedMocks.runCommand.mock.calls.findIndex(
      ([tool, args]) => tool === "gh" && Array.isArray(args) && args[0] === "api" && args[1] === "users/ACME-Org",
    );
    const repoCreateIndex = treeSharedMocks.runCommand.mock.calls.findIndex(
      ([tool, args]) => tool === "gh" && Array.isArray(args) && args[0] === "repo" && args[1] === "create",
    );
    expect(ownerLookupIndex).toBeGreaterThanOrEqual(0);
    expect(ownerLookupIndex).toBeLessThan(repoCreateIndex);
  });

  it("binds under the GitHub App installation account and reports coverage guidance", async () => {
    const { initCommand } = await import("../commands/tree/init.js");
    const base = makeTempDir();
    process.chdir(base);
    const fetchMock = vi.fn(async (input: FetchInput, init?: FetchInit) => {
      const url = String(input);
      if (url.endsWith("/api/v1/me")) {
        return response({
          defaultOrganizationId: "org_1",
          memberships: [{ organizationId: "org_1", role: "admin" }],
        });
      }
      if (url.endsWith("/api/v1/orgs/org_1/settings/context_tree/raw")) {
        return response({ branch: "main" });
      }
      if (url.endsWith("/api/v1/orgs/org_1/context-tree/installation")) {
        return response({
          accountLogin: "acme-org",
          accountType: "Organization",
          installationId: 123,
          suspended: false,
        });
      }
      if (url.endsWith("/api/v1/orgs/org_1/settings/context_tree/initialize") && init?.method === "POST") {
        expect(init.body).toBe(
          JSON.stringify({
            provider: "github",
            repo: "https://github.com/acme-org/acme-context-tree",
            branch: "main",
            expectedUnboundBranch: "main",
          }),
        );
        return bindingResponse(init);
      }
      return response("not found", { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const command = commandWithOptions({
      bind: true,
      public: false,
      title: "Acme",
      withWorkflow: false,
    });

    await initCommand.action(context(command, true));

    const summary = JSON.parse(String(vi.mocked(console.log).mock.calls.at(-1)?.[0])) as Record<string, unknown>;
    expect(process.exitCode).toBeUndefined();
    expect(summary).toMatchObject({
      bound: true,
      htmlUrl: "https://github.com/acme-org/acme-context-tree",
      name: "acme-context-tree",
      owner: "acme-org",
    });
    expect(summary.coverage).toMatchObject({
      appSettingsUrl: "https://github.com/organizations/acme-org/settings/installations/123",
      status: "guided",
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "https://server.example/api/v1/orgs/org_1/settings/context_tree/initialize",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("binds the branch it actually created when the raw preflight is branch-only", async () => {
    const { initCommand } = await import("../commands/tree/init.js");
    const base = makeTempDir();
    process.chdir(base);
    const fetchMock = vi.fn(async (input: FetchInput, init?: FetchInit) => {
      const url = String(input);
      if (url.endsWith("/api/v1/me")) {
        return response({ memberships: [{ organizationId: "org_1", role: "admin" }] });
      }
      if (url.endsWith("/api/v1/orgs/org_1/settings/context_tree/raw")) {
        return response({ branch: "trunk" });
      }
      if (url.endsWith("/api/v1/orgs/org_1/context-tree/installation")) {
        return response({ code: "no_installation" }, { status: 404 });
      }
      if (url.endsWith("/api/v1/orgs/org_1/settings/context_tree/initialize") && init?.method === "POST") {
        expect(init.body).toBe(
          JSON.stringify({
            provider: "github",
            repo: "https://github.com/octocat/branch-only-context-tree",
            branch: "trunk",
            expectedUnboundBranch: "trunk",
          }),
        );
        return bindingResponse(init);
      }
      return response("not found", { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);

    await initCommand.action(context(commandWithOptions({ bind: true, org: "org_1", title: "Branch Only" }), true));

    expect(process.exitCode).toBeUndefined();
    const summary = JSON.parse(String(vi.mocked(console.log).mock.calls.at(-1)?.[0])) as Record<string, unknown>;
    expect(summary).toMatchObject({ bound: true, branch: "trunk" });
  });

  it("rebinds a non-main existing binding to the branch it actually created", async () => {
    const { initCommand } = await import("../commands/tree/init.js");
    const base = makeTempDir();
    process.chdir(base);
    const fetchMock = vi.fn(async (input: FetchInput, init?: FetchInit) => {
      const url = String(input);
      if (url.endsWith("/api/v1/me")) {
        return response({ memberships: [{ organizationId: "org_1", role: "admin" }] });
      }
      if (url.endsWith("/api/v1/orgs/org_1/settings/context_tree/raw")) {
        return response({ repo: "https://github.com/acme/old-tree", branch: "trunk" });
      }
      if (url.endsWith("/api/v1/orgs/org_1/context-tree/installation")) {
        return response({ code: "no_installation" }, { status: 404 });
      }
      if (isPath(input, "/api/v1/orgs/org_1/settings/context_tree") && init?.method === "PUT") {
        expect(init.body).toBe(
          JSON.stringify({
            provider: "github",
            repo: "https://github.com/octocat/rebind-context-tree",
            branch: "trunk",
          }),
        );
        return bindingResponse(init);
      }
      return response("not found", { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);

    await initCommand.action(
      context(commandWithOptions({ bind: true, org: "org_1", rebind: true, title: "Rebind" }), true),
    );

    expect(process.exitCode).toBeUndefined();
    const summary = JSON.parse(String(vi.mocked(console.log).mock.calls.at(-1)?.[0])) as Record<string, unknown>;
    expect(summary).toMatchObject({ bound: true, branch: "trunk" });
  });

  it("falls back to the legacy settings read for an explicit rebind when the server lacks the raw endpoint", async () => {
    const { initCommand } = await import("../commands/tree/init.js");
    const base = makeTempDir();
    process.chdir(base);
    const fetchMock = vi.fn(async (input: FetchInput, init?: FetchInit) => {
      const url = String(input);
      if (url.endsWith("/api/v1/me")) {
        return response({ memberships: [{ organizationId: "org_1", role: "admin" }] });
      }
      if (url.endsWith("/api/v1/orgs/org_1/settings/context_tree/raw")) {
        return response("not found", { status: 404 });
      }
      if (isPath(input, "/api/v1/orgs/org_1/settings/context_tree") && init?.method !== "PUT") {
        return response({ branch: "legacy-release" });
      }
      if (url.endsWith("/api/v1/orgs/org_1/context-tree/installation")) {
        return response({ code: "no_installation" }, { status: 404 });
      }
      if (isPath(input, "/api/v1/orgs/org_1/settings/context_tree") && init?.method === "PUT") {
        return bindingResponse(init);
      }
      return response("not found", { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);

    await initCommand.action(
      context(commandWithOptions({ bind: true, org: "org_1", rebind: true, title: "Legacy Server" }), true),
    );

    expect(process.exitCode).toBeUndefined();
    expect(fetchMock).toHaveBeenCalledWith(
      "https://server.example/api/v1/orgs/org_1/settings/context_tree/raw",
      expect.any(Object),
    );
    const legacyPutCall = fetchMock.mock.calls.find(
      ([input, init]) => isPath(input, "/api/v1/orgs/org_1/settings/context_tree") && init?.method === "PUT",
    );
    expect(legacyPutCall).toBeDefined();
    expect(new URL(String(legacyPutCall?.[0])).search).toBe("");
    expect(JSON.parse(String(legacyPutCall?.[1]?.body))).toEqual({
      provider: "github",
      repo: "https://github.com/octocat/legacy-server-context-tree",
      branch: "legacy-release",
    });
    expect(treeSharedMocks.runCommand).toHaveBeenCalledWith(
      "git",
      ["init", "-b", "legacy-release"],
      expect.any(String),
    );
    const summary = JSON.parse(String(vi.mocked(console.log).mock.calls.at(-1)?.[0])) as Record<string, unknown>;
    expect(summary).toMatchObject({ bound: true, branch: "legacy-release", owner: "octocat" });
  });

  it("preserves a literal !/+ retained branch in git and the validation workflow", async () => {
    const { initCommand } = await import("../commands/tree/init.js");
    const base = makeTempDir();
    process.chdir(base);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: FetchInput, init?: FetchInit) => {
        const url = String(input);
        if (url.endsWith("/api/v1/me")) {
          return response({ memberships: [{ organizationId: "org_1", role: "admin" }] });
        }
        if (url.endsWith("/api/v1/orgs/org_1/settings/context_tree/raw")) {
          return response({ branch: "!release+candidate" });
        }
        if (url.endsWith("/api/v1/orgs/org_1/context-tree/installation")) {
          return response({ code: "no_installation" }, { status: 404 });
        }
        if (url.endsWith("/api/v1/orgs/org_1/settings/context_tree/initialize") && init?.method === "POST") {
          expect(init.body).toBe(
            JSON.stringify({
              provider: "github",
              repo: "https://github.com/octocat/literal-branch-context-tree",
              branch: "!release+candidate",
              expectedUnboundBranch: "!release+candidate",
            }),
          );
          return bindingResponse(init);
        }
        return response("not found", { status: 404 });
      }),
    );

    await initCommand.action(
      context(commandWithOptions({ bind: true, org: "org_1", title: "Literal Branch", withWorkflow: true }), true),
    );

    expect(process.exitCode).toBeUndefined();
    expect(treeSharedMocks.runCommand).toHaveBeenCalledWith(
      "git",
      ["init", "-b", "!release+candidate"],
      expect.any(String),
    );
    const summary = JSON.parse(String(vi.mocked(console.log).mock.calls.at(-1)?.[0])) as Record<string, unknown>;
    expect(summary).toMatchObject({ bound: true, branch: "!release+candidate" });
    expect(readFileSync(join(String(summary.treeRoot), ".github", "workflows", "validate-tree.yml"), "utf8")).toContain(
      String.raw`branches: ['\!release\+candidate']`,
    );
  });

  it("uses the existing non-main branch when intentionally rebinding", async () => {
    const { initCommand } = await import("../commands/tree/init.js");
    const base = makeTempDir();
    process.chdir(base);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: FetchInput, init?: FetchInit) => {
        const url = String(input);
        if (url.endsWith("/api/v1/me")) {
          return response({ memberships: [{ organizationId: "org_1", role: "admin" }] });
        }
        if (url.endsWith("/api/v1/orgs/org_1/settings/context_tree/raw")) {
          return response({ repo: "https://github.com/acme/old-tree", branch: "release/next" });
        }
        if (url.endsWith("/api/v1/orgs/org_1/context-tree/installation")) {
          return response({ code: "no_installation" }, { status: 404 });
        }
        if (isPath(input, "/api/v1/orgs/org_1/settings/context_tree") && init?.method === "PUT") {
          expect(init.body).toBe(
            JSON.stringify({
              provider: "github",
              repo: "https://github.com/octocat/rebound-tree-context-tree",
              branch: "release/next",
            }),
          );
          return bindingResponse(init);
        }
        return response("not found", { status: 404 });
      }),
    );

    await initCommand.action(
      context(commandWithOptions({ bind: true, org: "org_1", rebind: true, title: "Rebound Tree" }), true),
    );

    expect(process.exitCode).toBeUndefined();
    expect(treeSharedMocks.runCommand).toHaveBeenCalledWith("git", ["init", "-b", "release/next"], expect.any(String));
    const summary = JSON.parse(String(vi.mocked(console.log).mock.calls.at(-1)?.[0])) as Record<string, unknown>;
    expect(summary).toMatchObject({ bound: true, branch: "release/next" });
  });

  it.each([
    {
      label: "branch mismatch",
      binding: { repo: "https://github.com/octocat/mismatch-context-tree", branch: "main" },
    },
    {
      label: "repo mismatch",
      binding: { repo: "https://github.com/octocat/other-context-tree", branch: "trunk" },
    },
    {
      label: "missing branch",
      binding: { repo: "https://github.com/octocat/mismatch-context-tree" },
    },
    {
      label: "missing repo",
      binding: { branch: "trunk" },
    },
    {
      label: "unknown response field",
      binding: {
        repo: "https://github.com/octocat/mismatch-context-tree",
        branch: "trunk",
        unexpected: true,
      },
    },
    { label: "invalid response shape", binding: "not-a-binding" },
  ])("does not report success for a $label in the settings response", async ({ binding }) => {
    const { initCommand } = await import("../commands/tree/init.js");
    process.chdir(makeTempDir());
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: FetchInput, init?: FetchInit) => {
        const url = String(input);
        if (url.endsWith("/api/v1/me")) {
          return response({ memberships: [{ organizationId: "org_1", role: "admin" }] });
        }
        if (url.endsWith("/api/v1/orgs/org_1/settings/context_tree/raw")) {
          return response({ branch: "trunk" });
        }
        if (url.endsWith("/api/v1/orgs/org_1/context-tree/installation")) {
          return response({ code: "no_installation" }, { status: 404 });
        }
        if (url.endsWith("/api/v1/orgs/org_1/settings/context_tree/initialize") && init?.method === "POST") {
          return response(binding);
        }
        return response("not found", { status: 404 });
      }),
    );

    await initCommand.action(context(commandWithOptions({ bind: true, org: "org_1", title: "Mismatch" }), false));

    expect(process.exitCode).toBe(1);
    const error = String(vi.mocked(console.error).mock.calls.at(-1)?.[0]);
    expect(error).toContain("server did not confirm the requested Context Tree binding");
    expect(error).toContain("organization org_1");
    expect(error).toContain("https://github.com/octocat/mismatch-context-tree");
    expect(error).toContain("branch trunk");
    expect(error).toContain("read back");
    expect(error).toContain("Do not retry");
  });

  it("fails stop when an older server lacks conflict-safe tree init finalization", async () => {
    const { initCommand } = await import("../commands/tree/init.js");
    const base = makeTempDir();
    process.chdir(base);
    const fetchMock = vi.fn(async (input: FetchInput, init?: FetchInit) => {
      const url = String(input);
      if (url.endsWith("/api/v1/me")) {
        return response({ memberships: [{ organizationId: "org_1", role: "admin" }] });
      }
      if (url.endsWith("/api/v1/orgs/org_1/settings/context_tree/raw")) {
        return response("not found", { status: 404 });
      }
      if (url.endsWith("/api/v1/orgs/org_1/settings/context_tree") && init?.method !== "PUT") {
        return response({ branch: "main" });
      }
      return response("not found", { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);

    await initCommand.action(context(commandWithOptions({ bind: true, org: "org_1", title: "Old Server" }), false));

    expect(process.exitCode).toBe(1);
    const error = String(vi.mocked(console.error).mock.calls.at(-1)?.[0]);
    expect(error).toContain("Server support for conflict-safe tree init finalization is required");
    expect(error).toContain("Upgrade the server before retrying; no repository was created");
    expect(fetchMock.mock.calls.some(([input]) => String(input).includes("/context-tree/installation"))).toBe(false);
    expect(
      fetchMock.mock.calls.some(
        ([input, init]) =>
          String(input).endsWith("/api/v1/orgs/org_1/settings/context_tree/initialize") && init?.method === "POST",
      ),
    ).toBe(false);
    expect(
      treeSharedMocks.runCommand.mock.calls.some(
        ([tool, args]) => tool === "gh" && Array.isArray(args) && args[0] === "repo" && args[1] === "create",
      ),
    ).toBe(false);
  });

  it("continues binding with no installation and warns that snapshots are not covered yet", async () => {
    const { initCommand } = await import("../commands/tree/init.js");
    const base = makeTempDir();
    process.chdir(base);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: FetchInput, init?: FetchInit) => {
        const url = String(input);
        if (url.endsWith("/api/v1/me")) {
          return response({ memberships: [{ organizationId: "org_1", role: "admin" }] });
        }
        if (url.endsWith("/api/v1/orgs/org_1/settings/context_tree/raw")) {
          return response({ branch: "main" });
        }
        if (url.endsWith("/api/v1/orgs/org_1/context-tree/installation")) {
          return response({ code: "no_installation" }, { status: 404 });
        }
        if (url.endsWith("/api/v1/orgs/org_1/settings/context_tree/initialize") && init?.method === "POST") {
          return bindingResponse(init);
        }
        return response("not found", { status: 404 });
      }),
    );

    await initCommand.action(context(commandWithOptions({ bind: true, org: "org_1", title: "Solo" }), true));

    const summary = JSON.parse(String(vi.mocked(console.log).mock.calls.at(-1)?.[0])) as Record<string, unknown>;
    expect(summary).toMatchObject({
      bound: true,
      htmlUrl: "https://github.com/octocat/solo-context-tree",
      owner: "octocat",
    });
    expect(summary.coverage).toMatchObject({ appSettingsUrl: null, status: "no_installation" });
  });

  it("prints the human summary for a single-org bind with no GitHub App installation", async () => {
    const { initCommand } = await import("../commands/tree/init.js");
    const base = makeTempDir();
    process.chdir(base);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: FetchInput, init?: FetchInit) => {
        const url = String(input);
        if (url.endsWith("/api/v1/me")) {
          return response({ memberships: [{ organizationId: "org_1", role: "admin" }] });
        }
        if (url.endsWith("/api/v1/orgs/org_1/settings/context_tree/raw")) {
          return response({ branch: "main" });
        }
        if (url.endsWith("/api/v1/orgs/org_1/context-tree/installation")) {
          return response({ code: "no_installation" }, { status: 404 });
        }
        if (url.endsWith("/api/v1/orgs/org_1/settings/context_tree/initialize") && init?.method === "POST") {
          return bindingResponse(init);
        }
        return response("not found", { status: 404 });
      }),
    );

    await initCommand.action(context(commandWithOptions({ bind: true, title: "Solo Human" }), false));

    const output = vi
      .mocked(console.log)
      .mock.calls.map((call) => String(call[0]))
      .join("\n");
    expect(process.exitCode).toBeUndefined();
    expect(output).toContain("Context Tree Init");
    expect(output).toContain("Repository:   octocat/solo-human-context-tree");
    expect(output).toContain("GitHub App coverage:");
    expect(output).toContain("No GitHub App installation is connected");
    expect(output).toContain("Context Tree created and bound.");
  });

  it("prints the human summary for an unbound tree using default title and repo name", async () => {
    const { initCommand } = await import("../commands/tree/init.js");
    const base = makeTempDir();
    process.chdir(base);

    await initCommand.action(context(commandWithOptions({ bind: false, withWorkflow: false }), false));

    const output = vi
      .mocked(console.log)
      .mock.calls.map((call) => String(call[0]))
      .join("\n");
    expect(process.exitCode).toBeUndefined();
    expect(output).toContain("Repository:   octocat/octocat-context-tree");
    expect(output).toContain("Validate CI:  not seeded");
    expect(output).toContain("Bound to org: no (--no-bind)");
    expect(output).toContain("Context Tree created.");
  });

  it("fails before remote writes when binding preconditions are not satisfied", async () => {
    const { initCommand } = await import("../commands/tree/init.js");
    const cases: Array<{
      name: string;
      command: Command;
      fetch: (input: FetchInput, init?: FetchInit) => Promise<Response>;
      message: string;
      absent?: string[];
    }> = [
      {
        name: "non-admin",
        command: commandWithOptions({ bind: true, org: "org_1", title: "No Admin" }),
        fetch: async (input) =>
          String(input).endsWith("/api/v1/me")
            ? response({ memberships: [{ organizationId: "org_1", role: "member" }] })
            : response("not found", { status: 404 }),
        message: "requires admin of org org_1",
      },
      {
        name: "existing binding",
        command: commandWithOptions({ bind: true, org: "org_1", title: "Existing" }),
        fetch: async (input) => {
          const url = String(input);
          if (url.endsWith("/api/v1/me")) {
            return response({ memberships: [{ organizationId: "org_1", role: "admin" }] });
          }
          if (url.endsWith("/api/v1/orgs/org_1/settings/context_tree/raw")) {
            return response({ repo: "https://github.com/acme/live-tree" });
          }
          return response("not found", { status: 404 });
        },
        message: "already bound to a Context Tree",
      },
      {
        name: "repo-less invalid branch",
        command: commandWithOptions({ bind: true, org: "org_1", title: "Invalid Branch" }),
        fetch: async (input) => {
          const url = String(input);
          if (url.endsWith("/api/v1/me")) {
            return response({ memberships: [{ organizationId: "org_1", role: "admin" }] });
          }
          if (url.endsWith("/api/v1/orgs/org_1/settings/context_tree/raw")) {
            return response({ branch: "--bad" });
          }
          throw new Error(`unexpected request after invalid Context Tree preflight: ${url}`);
        },
        message: "invalid historical data",
      },
      {
        name: "empty historical repo",
        command: commandWithOptions({ bind: true, org: "org_1", title: "Empty Repo" }),
        fetch: async (input) => {
          const url = String(input);
          if (url.endsWith("/api/v1/me")) {
            return response({ memberships: [{ organizationId: "org_1", role: "admin" }] });
          }
          if (url.endsWith("/api/v1/orgs/org_1/settings/context_tree/raw")) {
            return response({ repo: "", branch: "main" });
          }
          throw new Error(`unexpected request after empty Context Tree repo: ${url}`);
        },
        message: "invalid historical data",
      },
      {
        name: "credential-bearing invalid historical repo",
        command: commandWithOptions({ bind: true, org: "org_1", title: "Secret Repo" }),
        fetch: async (input) => {
          const url = String(input);
          if (url.endsWith("/api/v1/me")) {
            return response({ memberships: [{ organizationId: "org_1", role: "admin" }] });
          }
          if (url.endsWith("/api/v1/orgs/org_1/settings/context_tree/raw")) {
            return response({ repo: "https://user:super-secret@example.com/private/tree.git", branch: "main" });
          }
          throw new Error(`unexpected request after credential-bearing Context Tree repo: ${url}`);
        },
        message: "invalid historical data",
        absent: ["super-secret", "private/tree.git"],
      },
      {
        name: "legacy fallback repo-less invalid branch",
        command: commandWithOptions({ bind: true, org: "org_1", title: "Legacy Invalid Branch" }),
        fetch: async (input) => {
          const url = String(input);
          if (url.endsWith("/api/v1/me")) {
            return response({ memberships: [{ organizationId: "org_1", role: "admin" }] });
          }
          if (url.endsWith("/api/v1/orgs/org_1/settings/context_tree/raw")) {
            return response("not found", { status: 404 });
          }
          if (isPath(input, "/api/v1/orgs/org_1/settings/context_tree")) {
            return response({ branch: "--bad" });
          }
          throw new Error(`unexpected request after invalid legacy Context Tree preflight: ${url}`);
        },
        message: "invalid historical data",
      },
      {
        name: "legacy fallback empty historical repo",
        command: commandWithOptions({ bind: true, org: "org_1", title: "Legacy Empty Repo" }),
        fetch: async (input) => {
          const url = String(input);
          if (url.endsWith("/api/v1/me")) {
            return response({ memberships: [{ organizationId: "org_1", role: "admin" }] });
          }
          if (url.endsWith("/api/v1/orgs/org_1/settings/context_tree/raw")) {
            return response("not found", { status: 404 });
          }
          if (isPath(input, "/api/v1/orgs/org_1/settings/context_tree")) {
            return response({ repo: "", branch: "main" });
          }
          throw new Error(`unexpected request after legacy empty Context Tree repo: ${url}`);
        },
        message: "invalid historical data",
      },
      {
        name: "binding read failure",
        command: commandWithOptions({ bind: true, org: "org_1", title: "Binding Read" }),
        fetch: async (input) => {
          const url = String(input);
          if (url.endsWith("/api/v1/me")) {
            return response({ memberships: [{ organizationId: "org_1", role: "admin" }] });
          }
          if (url.endsWith("/api/v1/orgs/org_1/settings/context_tree/raw")) {
            return response("server down", { status: 503 });
          }
          throw new Error(`unexpected fallback after raw Context Tree 503: ${url}`);
        },
        message: "Could not read the team's current Context Tree binding",
      },
      {
        name: "installation lookup failure",
        command: commandWithOptions({ bind: true, org: "org_1", title: "Lookup" }),
        fetch: async (input) => {
          const url = String(input);
          if (url.endsWith("/api/v1/me")) {
            return response({ memberships: [{ organizationId: "org_1", role: "admin" }] });
          }
          if (url.endsWith("/api/v1/orgs/org_1/settings/context_tree/raw")) {
            return response({ branch: "main" });
          }
          if (url.endsWith("/api/v1/orgs/org_1/context-tree/installation")) {
            return response("server down", { status: 500 });
          }
          return response("not found", { status: 404 });
        },
        message: "Could not read the team's GitHub App installation",
      },
      {
        name: "installation network failure",
        command: commandWithOptions({ bind: true, org: "org_1", title: "Lookup Network" }),
        fetch: async (input) => {
          const url = String(input);
          if (url.endsWith("/api/v1/me")) {
            return response({ memberships: [{ organizationId: "org_1", role: "admin" }] });
          }
          if (url.endsWith("/api/v1/orgs/org_1/settings/context_tree/raw")) {
            return response({ branch: "main" });
          }
          if (url.endsWith("/api/v1/orgs/org_1/context-tree/installation")) {
            throw new Error("network down");
          }
          return response("not found", { status: 404 });
        },
        message: "Could not read the team's GitHub App installation",
      },
      {
        name: "installation invalid body",
        command: commandWithOptions({ bind: true, org: "org_1", title: "Lookup Invalid" }),
        fetch: async (input) => {
          const url = String(input);
          if (url.endsWith("/api/v1/me")) {
            return response({ memberships: [{ organizationId: "org_1", role: "admin" }] });
          }
          if (url.endsWith("/api/v1/orgs/org_1/settings/context_tree/raw")) {
            return response({ branch: "main" });
          }
          if (url.endsWith("/api/v1/orgs/org_1/context-tree/installation")) {
            return response({ installationId: "not-a-number" });
          }
          return response("not found", { status: 404 });
        },
        message: "Could not read the team's GitHub App installation",
      },
      {
        name: "installation malformed 404",
        command: commandWithOptions({ bind: true, org: "org_1", title: "Lookup Malformed 404" }),
        fetch: async (input) => {
          const url = String(input);
          if (url.endsWith("/api/v1/me")) {
            return response({ memberships: [{ organizationId: "org_1", role: "admin" }] });
          }
          if (url.endsWith("/api/v1/orgs/org_1/settings/context_tree/raw")) {
            return response({ branch: "main" });
          }
          if (url.endsWith("/api/v1/orgs/org_1/context-tree/installation")) {
            return response("not-json", { status: 404 });
          }
          throw new Error(`unexpected request after malformed installation 404: ${url}`);
        },
        message: "Could not read the team's GitHub App installation",
      },
      {
        name: "owner mismatch",
        command: commandWithOptions({ bind: true, org: "org_1", owner: "octocat", title: "Mismatch" }),
        fetch: async (input) => {
          const url = String(input);
          if (url.endsWith("/api/v1/me")) {
            return response({ memberships: [{ organizationId: "org_1", role: "admin" }] });
          }
          if (url.endsWith("/api/v1/orgs/org_1/settings/context_tree/raw")) {
            return response({ branch: "main" });
          }
          if (url.endsWith("/api/v1/orgs/org_1/context-tree/installation")) {
            return response({
              accountLogin: "acme-org",
              accountType: "Organization",
              installationId: 456,
              suspended: false,
            });
          }
          return response("not found", { status: 404 });
        },
        message: "does not match this team's GitHub App installation account",
      },
    ];

    for (const testCase of cases) {
      vi.clearAllMocks();
      vi.spyOn(console, "log").mockImplementation(() => {});
      vi.spyOn(console, "error").mockImplementation(() => {});
      mockGithubApi();
      process.exitCode = undefined;
      const base = makeTempDir();
      process.chdir(base);
      vi.stubGlobal("fetch", vi.fn(testCase.fetch));

      await initCommand.action(context(testCase.command, false));

      expect(process.exitCode, testCase.name).toBe(1);
      expect(String(vi.mocked(console.error).mock.calls.at(-1)?.[0]), testCase.name).toContain(testCase.message);
      for (const forbidden of testCase.absent ?? []) {
        expect(String(vi.mocked(console.error).mock.calls.at(-1)?.[0]), testCase.name).not.toContain(forbidden);
      }
      expect(
        treeSharedMocks.runCommand.mock.calls.some(
          ([tool, args]) => tool === "gh" && Array.isArray(args) && args[0] === "repo" && args[1] === "create",
        ),
        testCase.name,
      ).toBe(false);
      vi.unstubAllGlobals();
    }
  });

  it("fails early for missing tools, unauthenticated gh, missing login, and non-empty targets", async () => {
    const { initCommand } = await import("../commands/tree/init.js");
    const cases: Array<{
      name: string;
      command?: Command;
      runCommand: (tool: string, args: string[]) => string;
      message: string;
      setup?: (base: string) => void;
    }> = [
      {
        name: "missing git",
        runCommand: (tool, args) => {
          if (tool === "git" && args[0] === "--version") throw new Error("missing git");
          return "";
        },
        message: "`git` is required",
      },
      {
        name: "gh auth",
        runCommand: (tool, args) => {
          if (args[0] === "--version") return "";
          if (tool === "gh" && args[0] === "auth") throw new Error("not logged in");
          return "";
        },
        message: "GitHub CLI is not authenticated",
      },
      {
        name: "missing login",
        runCommand: (tool, args) => {
          if (args[0] === "--version" || (tool === "gh" && args[0] === "auth")) return "";
          if (tool === "gh" && args[0] === "api" && args[1] === "user") return "";
          return "";
        },
        message: "Could not resolve your GitHub login",
      },
      {
        name: "non-empty dir",
        command: commandWithOptions({ bind: false, dir: "already-here", title: "Busy" }),
        setup: (base) => {
          const dir = join(base, "already-here");
          rmSync(dir, { recursive: true, force: true });
          mkdirSync(dir, { recursive: true });
          writeFileSync(join(dir, "README.md"), "busy\n");
        },
        runCommand: (tool, args) => {
          if (args[0] === "--version" || (tool === "gh" && args[0] === "auth")) return "";
          if (tool === "gh" && args[0] === "api" && args[1] === "user") return "octocat";
          return "";
        },
        message: "Target directory is not empty",
      },
    ];

    for (const testCase of cases) {
      vi.clearAllMocks();
      vi.spyOn(console, "log").mockImplementation(() => {});
      vi.spyOn(console, "error").mockImplementation(() => {});
      process.exitCode = undefined;
      const base = makeTempDir();
      process.chdir(base);
      testCase.setup?.(base);
      treeSharedMocks.runCommand.mockImplementation(testCase.runCommand);

      await initCommand.action(
        context(testCase.command ?? commandWithOptions({ bind: false, title: "Broken" }), false),
      );

      expect(process.exitCode, testCase.name).toBe(1);
      expect(String(vi.mocked(console.error).mock.calls.at(-1)?.[0]), testCase.name).toContain(testCase.message);
    }
  });

  it("fails org resolution before GitHub writes when /me is unusable or ambiguous", async () => {
    const { initCommand } = await import("../commands/tree/init.js");
    const cases: Array<{ name: string; me: unknown; status?: number; message: string }> = [
      { name: "me 500", me: "down", status: 500, message: "server returned 500 on /me" },
      { name: "missing memberships", me: {}, message: "don't belong to any organization" },
      { name: "no orgs", me: { memberships: [] }, message: "don't belong to any organization" },
      {
        name: "multiple orgs",
        me: { memberships: [{ organizationId: "org_1" }, { organizationId: "org_2" }] },
        message: "Multiple organizations",
      },
    ];

    for (const testCase of cases) {
      vi.clearAllMocks();
      vi.spyOn(console, "log").mockImplementation(() => {});
      vi.spyOn(console, "error").mockImplementation(() => {});
      mockGithubApi();
      process.exitCode = undefined;
      const base = makeTempDir();
      process.chdir(base);
      vi.stubGlobal(
        "fetch",
        vi.fn(async (input: FetchInput) =>
          String(input).endsWith("/api/v1/me")
            ? response(testCase.me, { status: testCase.status ?? 200 })
            : response("not found", { status: 404 }),
        ),
      );

      await initCommand.action(context(commandWithOptions({ bind: true, title: testCase.name }), false));

      expect(process.exitCode, testCase.name).toBe(1);
      expect(String(vi.mocked(console.error).mock.calls.at(-1)?.[0]), testCase.name).toContain(testCase.message);
      expect(
        treeSharedMocks.runCommand.mock.calls.some(
          ([tool, args]) => tool === "gh" && Array.isArray(args) && args[0] === "repo" && args[1] === "create",
        ),
      ).toBe(false);
      vi.unstubAllGlobals();
    }
  });

  it("rejects an unconfirmed GitHub URL and sanitizes a failed binding response", async () => {
    const { initCommand } = await import("../commands/tree/init.js");
    const base = makeTempDir();
    process.chdir(base);
    treeSharedMocks.runCommand.mockImplementation((tool: string, args: string[]) => {
      if (args[0] === "--version" || (tool === "gh" && args[0] === "auth" && args[1] === "status")) return "";
      if (tool === "gh" && args[0] === "api" && args[1] === "user") return "octocat";
      if (tool === "gh" && args[0] === "api" && typeof args[1] === "string" && args[1].startsWith("repos/")) {
        return "{}";
      }
      return "";
    });

    await initCommand.action(context(commandWithOptions({ bind: false, title: "Missing Repo Url" }), false));
    expect(process.exitCode).toBe(1);
    expect(String(vi.mocked(console.error).mock.calls.at(-1)?.[0])).toContain(
      "GitHub did not confirm the expected URL for octocat/missing-repo-url-context-tree",
    );

    vi.clearAllMocks();
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    mockGithubApi();
    process.exitCode = undefined;
    process.chdir(makeTempDir());
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: FetchInput, init?: FetchInit) => {
        const url = String(input);
        if (url.endsWith("/api/v1/me")) return response({ memberships: [{ organizationId: "org_1", role: "admin" }] });
        if (url.endsWith("/api/v1/orgs/org_1/settings/context_tree/raw")) {
          return response({ branch: "main" });
        }
        if (url.endsWith("/api/v1/orgs/org_1/context-tree/installation")) {
          return response({ code: "no_installation" }, { status: 404 });
        }
        if (url.endsWith("/api/v1/orgs/org_1/settings/context_tree/initialize") && init?.method === "POST") {
          return response("private upstream detail: do-not-leak", { status: 500 });
        }
        return response("not found", { status: 404 });
      }),
    );

    await initCommand.action(context(commandWithOptions({ bind: true, org: "org_1", title: "Bind Fails" }), false));
    expect(process.exitCode).toBe(1);
    const error = String(vi.mocked(console.error).mock.calls.at(-1)?.[0]);
    expect(error).toContain("binding failed (server returned 500)");
    expect(error).toContain("organization org_1");
    expect(error).toContain("https://github.com/octocat/bind-fails-context-tree");
    expect(error).toContain("repo was created but not bound");
    expect(error).toContain("delete it manually");
    expect(error).toContain("branch main");
    expect(error).toContain("Read back");
    expect(error).not.toContain("do-not-leak");
  });

  it("reports a final binding conflict without retrying or overwriting the competing setting", async () => {
    const { initCommand } = await import("../commands/tree/init.js");
    process.chdir(makeTempDir());
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: FetchInput, init?: FetchInit) => {
        const url = String(input);
        if (url.endsWith("/api/v1/me")) {
          return response({ memberships: [{ organizationId: "org_1", role: "admin" }] });
        }
        if (url.endsWith("/api/v1/orgs/org_1/settings/context_tree/raw")) {
          return response({ branch: "main" });
        }
        if (url.endsWith("/api/v1/orgs/org_1/context-tree/installation")) {
          return response({ code: "no_installation" }, { status: 404 });
        }
        if (url.endsWith("/api/v1/orgs/org_1/settings/context_tree/initialize") && init?.method === "POST") {
          return response(
            { competingRepo: "https://github.com/private/other-tree", secret: "do-not-leak" },
            { status: 409 },
          );
        }
        return response("not found", { status: 404 });
      }),
    );

    await initCommand.action(context(commandWithOptions({ bind: true, org: "org_1", title: "Conflict Tree" }), false));

    expect(process.exitCode).toBe(1);
    const error = String(vi.mocked(console.error).mock.calls.at(-1)?.[0]);
    expect(error).toContain("organization org_1");
    expect(error).toContain("server returned 409");
    expect(error).toContain("do not retry or overwrite");
    expect(error).toContain("repo was created but not bound");
    expect(error).toContain("delete it manually");
    expect(error).toContain("Read back");
    expect(error).toContain("https://github.com/octocat/conflict-tree-context-tree");
    expect(error).toContain("branch main");
    expect(error).not.toContain("do-not-leak");
    expect(
      treeSharedMocks.runCommand.mock.calls.filter(
        ([tool, args]) => tool === "gh" && Array.isArray(args) && args[0] === "repo" && args[1] === "create",
      ),
    ).toHaveLength(1);
  });

  it("reports an unknown binding outcome after a finalize transport failure without leaking the cause", async () => {
    const { initCommand } = await import("../commands/tree/init.js");
    process.chdir(makeTempDir());
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: FetchInput, init?: FetchInit) => {
        const url = String(input);
        if (url.endsWith("/api/v1/me")) {
          return response({ memberships: [{ organizationId: "org_1", role: "admin" }] });
        }
        if (url.endsWith("/api/v1/orgs/org_1/settings/context_tree/raw")) {
          return response({ branch: "main" });
        }
        if (url.endsWith("/api/v1/orgs/org_1/context-tree/installation")) {
          return response({ code: "no_installation" }, { status: 404 });
        }
        if (url.endsWith("/api/v1/orgs/org_1/settings/context_tree/initialize") && init?.method === "POST") {
          throw new Error("socket secret do-not-leak");
        }
        return response("not found", { status: 404 });
      }),
    );

    await initCommand.action(context(commandWithOptions({ bind: true, org: "org_1", title: "Transport Tree" }), false));

    expect(process.exitCode).toBe(1);
    const error = String(vi.mocked(console.error).mock.calls.at(-1)?.[0]);
    expect(error).toContain("organization org_1");
    expect(error).toContain("unknown");
    expect(error).toContain("Do not retry");
    expect(error).toContain("repo was created but not bound");
    expect(error).toContain("delete it manually");
    expect(error).toContain("read back");
    expect(error).toContain("https://github.com/octocat/transport-tree-context-tree");
    expect(error).toContain("branch main");
    expect(error).not.toContain("do-not-leak");
  });

  it("preserves the exact org and branch in conflict-safe finalization recovery", async () => {
    const { initCommand } = await import("../commands/tree/init.js");
    const base = makeTempDir();
    process.chdir(base);
    const fetchMock = vi.fn(async (input: FetchInput, init?: FetchInit) => {
      const url = String(input);
      if (url.endsWith("/api/v1/me")) {
        return response({
          defaultOrganizationId: "org_1",
          memberships: [
            { organizationId: "org_1", role: "admin" },
            { organizationId: "org_2", role: "admin" },
          ],
        });
      }
      if (url.endsWith("/api/v1/orgs/org_2/settings/context_tree/raw")) {
        return response({ branch: "trunk" });
      }
      if (url.endsWith("/api/v1/orgs/org_2/context-tree/installation")) {
        return response({ code: "no_installation" }, { status: 404 });
      }
      if (url.endsWith("/api/v1/orgs/org_2/settings/context_tree/initialize") && init?.method === "POST") {
        expect(init.body).toBe(
          JSON.stringify({
            provider: "github",
            repo: "https://github.com/octocat/conflict-context-tree",
            branch: "trunk",
            expectedUnboundBranch: "trunk",
          }),
        );
        return response("already configured", { status: 409 });
      }
      return response("not found", { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);

    await initCommand.action(context(commandWithOptions({ bind: true, org: "org_2", title: "Conflict" }), false));

    expect(process.exitCode).toBe(1);
    const error = String(vi.mocked(console.error).mock.calls.at(-1)?.[0]);
    expect(error).toContain("organization org_2");
    expect(error).toContain("server returned 409");
    expect(error).toContain("Read back /api/v1/orgs/org_2/settings/context_tree first");
    expect(error).toContain("https://github.com/octocat/conflict-context-tree");
    expect(error).toContain("repo was created but not bound");
    expect(error).toContain("delete it manually");
    expect(error).toContain("branch trunk");
    expect(error).not.toContain("org bind-tree");
    expect(
      fetchMock.mock.calls.some(
        ([input, init]) =>
          String(input).endsWith("/api/v1/orgs/org_2/settings/context_tree") &&
          (init as RequestInit | undefined)?.method === "PUT",
      ),
    ).toBe(false);
  });

  it("requires read-back before retry when final binding outcome is unknown", async () => {
    const { initCommand } = await import("../commands/tree/init.js");
    const base = makeTempDir();
    process.chdir(base);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: FetchInput, init?: FetchInit) => {
        const url = String(input);
        if (url.endsWith("/api/v1/me")) {
          return response({ memberships: [{ organizationId: "org_2", role: "admin" }] });
        }
        if (url.endsWith("/api/v1/orgs/org_2/settings/context_tree/raw")) {
          return response({ branch: "trunk" });
        }
        if (url.endsWith("/api/v1/orgs/org_2/context-tree/installation")) {
          return response({ code: "no_installation" }, { status: 404 });
        }
        if (url.endsWith("/api/v1/orgs/org_2/settings/context_tree/initialize") && init?.method === "POST") {
          throw new Error("socket closed");
        }
        return response("not found", { status: 404 });
      }),
    );

    await initCommand.action(context(commandWithOptions({ bind: true, org: "org_2", title: "Unknown" }), false));

    expect(process.exitCode).toBe(1);
    const error = String(vi.mocked(console.error).mock.calls.at(-1)?.[0]);
    expect(error).toContain("binding outcome is unknown for organization org_2");
    expect(error).toContain("read back /api/v1/orgs/org_2/settings/context_tree");
    expect(error).toContain("repo was created but not bound");
    expect(error).toContain("delete it manually");
    expect(error).toContain("repo https://github.com/octocat/unknown-context-tree at branch trunk");
    expect(error).toContain(
      "org bind-tree 'https://github.com/octocat/unknown-context-tree' --org 'org_2' --branch 'trunk'",
    );
  });

  it("surfaces unexpected GitHub API response shapes after remote create", async () => {
    const { initCommand } = await import("../commands/tree/init.js");
    const base = makeTempDir();
    process.chdir(base);
    treeSharedMocks.runCommand.mockImplementation((tool: string, args: string[]) => {
      if (args[0] === "--version" || (tool === "gh" && args[0] === "auth" && args[1] === "status")) return "";
      if (tool === "gh" && args[0] === "api" && args[1] === "user") return "octocat";
      if (tool === "gh" && args[0] === "api" && typeof args[1] === "string" && args[1].startsWith("repos/")) {
        return "null";
      }
      return "";
    });

    await initCommand.action(context(commandWithOptions({ bind: false, title: "Bad Api" }), false));

    expect(process.exitCode).toBe(1);
    expect(String(vi.mocked(console.error).mock.calls.at(-1)?.[0])).toContain("Unexpected GitHub API response");
  });

  it("surfaces suspended installation guidance in the final summary", async () => {
    const { initCommand } = await import("../commands/tree/init.js");
    const base = makeTempDir();
    process.chdir(base);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: FetchInput, init?: FetchInit) => {
        const url = String(input);
        if (url.endsWith("/api/v1/me")) {
          return response({ memberships: [{ organizationId: "org_1", role: "admin" }] });
        }
        if (url.endsWith("/api/v1/orgs/org_1/settings/context_tree/raw")) {
          return response({ branch: "main" });
        }
        if (url.endsWith("/api/v1/orgs/org_1/context-tree/installation")) {
          return response({
            accountLogin: "bestony",
            accountType: "User",
            installationId: 789,
            suspended: true,
          });
        }
        if (url.endsWith("/api/v1/orgs/org_1/settings/context_tree/initialize") && init?.method === "POST") {
          return bindingResponse(init);
        }
        return response("not found", { status: 404 });
      }),
    );

    await initCommand.action(context(commandWithOptions({ bind: true, org: "org_1", title: "Personal" }), true));

    const summary = JSON.parse(String(vi.mocked(console.log).mock.calls.at(-1)?.[0])) as Record<string, unknown>;
    expect(summary.coverage).toMatchObject({
      appSettingsUrl: "https://github.com/settings/installations/789",
      status: "suspended",
    });
  });

  it("initializes one explicit Team without consulting /me or managed default-Team state", async () => {
    const { initCommand } = await import("../commands/tree/init.js");
    const base = makeTempDir();
    process.chdir(base);
    let seedReads = 0;
    const fetchMock = vi.fn(async (input: FetchInput, init?: FetchInit) => {
      const url = String(input);
      if (url.endsWith("/api/v1/orgs/team_1/context-tree/seed-preflight") && init?.method === "POST") {
        seedReads++;
        return response({ organizationId: "team_1", state: { status: "unbound", branch: "main" } });
      }
      if (url.endsWith("/api/v1/orgs/team_1/context-tree/installation")) {
        return response({ code: "no_installation" }, { status: 404 });
      }
      if (url.endsWith("/api/v1/orgs/team_1/settings/context_tree/initialize") && init?.method === "POST") {
        return bindingResponse(init);
      }
      throw new Error(`unexpected explicit-Team request: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    await initCommand.action(context(commandWithOptions({ bind: true, team: "team_1", title: "Portable Team" }), true));

    expect(process.exitCode).toBeUndefined();
    expect(seedReads).toBe(3);
    expect(fetchMock.mock.calls.some(([input]) => String(input).endsWith("/api/v1/me"))).toBe(false);
    expect(fetchMock.mock.calls.some(([input]) => String(input).includes("/settings/context_tree/raw"))).toBe(false);
    const summary = JSON.parse(String(vi.mocked(console.log).mock.calls.at(-1)?.[0])) as Record<string, unknown>;
    expect(summary).toMatchObject({
      outcome: "created",
      teamId: "team_1",
      bound: true,
      htmlUrl: "https://github.com/octocat/portable-team-context-tree",
    });
  });

  it.each([
    {
      options: { bind: true, org: "legacy_org", team: "team_1" },
      message: "Pass exactly one Team selector",
    },
    {
      options: { bind: false, team: "team_1" },
      message: "--team cannot be combined with --no-bind",
    },
    {
      options: { bind: true, rebind: true, team: "team_1" },
      message: "--team cannot be combined with --rebind",
    },
  ])("rejects incompatible explicit-Team init options before admission: $message", async ({ options, message }) => {
    const { initCommand } = await import("../commands/tree/init.js");

    await initCommand.action(context(commandWithOptions(options), true));

    expect(process.exitCode).toBe(1);
    expect(String(vi.mocked(console.error).mock.calls.at(-1)?.[0])).toContain(message);
    expect(treeSharedMocks.runCommand).not.toHaveBeenCalled();
  });

  it("returns the same Server binding on an explicit-Team repeat before checking local tools", async () => {
    const { initCommand } = await import("../commands/tree/init.js");
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: FetchInput, init?: FetchInit) => {
        if (String(input).endsWith("/api/v1/orgs/team_repeat/context-tree/seed-preflight") && init?.method === "POST") {
          return response({
            organizationId: "team_repeat",
            state: {
              status: "bound",
              binding: { repo: "git@github.com:acme/live-tree.git", branch: "release" },
            },
          });
        }
        throw new Error(`unexpected repeat request: ${String(input)}`);
      }),
    );

    await initCommand.action(context(commandWithOptions({ bind: true, team: "team_repeat" }), true));

    expect(process.exitCode).toBeUndefined();
    expect(treeSharedMocks.runCommand).not.toHaveBeenCalled();
    const summary = JSON.parse(String(vi.mocked(console.log).mock.calls.at(-1)?.[0])) as Record<string, unknown>;
    expect(summary).toEqual({
      outcome: "existing",
      teamId: "team_repeat",
      repo: "git@github.com:acme/live-tree.git",
      branch: "release",
      bound: true,
    });
  });

  it("returns stable Needs Admin for an ordinary member before any local or remote mutation", async () => {
    const { initCommand } = await import("../commands/tree/init.js");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        response(
          {
            error: "Context Tree Seed requires an active Team Admin.",
            code: "CONTEXT_TREE_SEED_NEEDS_ADMIN",
          },
          { status: 403 },
        ),
      ),
    );

    await initCommand.action(context(commandWithOptions({ bind: true, team: "team_member" }), true));

    expect(process.exitCode).toBe(3);
    expect(treeSharedMocks.runCommand).not.toHaveBeenCalled();
    expect(String(vi.mocked(console.error).mock.calls.at(-1)?.[0])).toContain(
      "needs an active Admin of the selected Team",
    );
  });

  it("rechecks the explicit Team before GitHub creation and preserves a concurrent binding", async () => {
    const { initCommand } = await import("../commands/tree/init.js");
    const base = makeTempDir();
    process.chdir(base);
    let seedReads = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: FetchInput, init?: FetchInit) => {
        const url = String(input);
        if (url.endsWith("/api/v1/orgs/team_race/context-tree/seed-preflight") && init?.method === "POST") {
          seedReads++;
          return seedReads === 1
            ? response({ organizationId: "team_race", state: { status: "unbound", branch: "main" } })
            : response({
                organizationId: "team_race",
                state: {
                  status: "bound",
                  binding: { repo: "https://github.com/acme/winner-tree", branch: "main" },
                },
              });
        }
        if (url.endsWith("/api/v1/orgs/team_race/context-tree/installation")) {
          return response({ code: "no_installation" }, { status: 404 });
        }
        throw new Error(`unexpected race request: ${url}`);
      }),
    );

    await initCommand.action(context(commandWithOptions({ bind: true, team: "team_race", title: "Race Team" }), true));

    expect(process.exitCode).toBe(1);
    expect(
      treeSharedMocks.runCommand.mock.calls.some(
        ([tool, args]) => tool === "gh" && args[0] === "repo" && args[1] === "create",
      ),
    ).toBe(false);
    const error = String(vi.mocked(console.error).mock.calls.at(-1)?.[0]);
    expect(error).toContain("became bound to https://github.com/acme/winner-tree#main");
    expect(error).toContain("No remote mutation was attempted");
  });

  it("reconciles an uncertain finalization to the same explicit-Team binding", async () => {
    const { initCommand } = await import("../commands/tree/init.js");
    const base = makeTempDir();
    process.chdir(base);
    let seedReads = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: FetchInput, init?: FetchInit) => {
        const url = String(input);
        if (url.endsWith("/api/v1/orgs/team_retry/context-tree/seed-preflight") && init?.method === "POST") {
          seedReads++;
          return seedReads < 4
            ? response({ organizationId: "team_retry", state: { status: "unbound", branch: "main" } })
            : response({
                organizationId: "team_retry",
                state: {
                  status: "bound",
                  binding: { repo: "git@github.com:octocat/retry-team-context-tree.git", branch: "main" },
                },
              });
        }
        if (url.endsWith("/api/v1/orgs/team_retry/context-tree/installation")) {
          return response({ code: "no_installation" }, { status: 404 });
        }
        if (url.endsWith("/api/v1/orgs/team_retry/settings/context_tree/initialize") && init?.method === "POST") {
          throw new Error("response lost after commit");
        }
        throw new Error(`unexpected reconciliation request: ${url}`);
      }),
    );

    await initCommand.action(
      context(commandWithOptions({ bind: true, team: "team_retry", title: "Retry Team" }), true),
    );

    expect(process.exitCode).toBeUndefined();
    expect(seedReads).toBe(4);
    const summary = JSON.parse(String(vi.mocked(console.log).mock.calls.at(-1)?.[0])) as Record<string, unknown>;
    expect(summary).toMatchObject({ outcome: "converged", teamId: "team_retry", bound: true });
  });

  it("reports the created repo truthfully when Admin authority changes before binding", async () => {
    const { initCommand } = await import("../commands/tree/init.js");
    const base = makeTempDir();
    process.chdir(base);
    let seedReads = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: FetchInput, init?: FetchInit) => {
        const url = String(input);
        if (url.endsWith("/api/v1/orgs/team_revoked/context-tree/seed-preflight") && init?.method === "POST") {
          seedReads++;
          if (seedReads < 3) {
            return response({ organizationId: "team_revoked", state: { status: "unbound", branch: "main" } });
          }
          return response(
            {
              error: "Context Tree Seed requires an active Team Admin.",
              code: "CONTEXT_TREE_SEED_NEEDS_ADMIN",
            },
            { status: 403 },
          );
        }
        if (url.endsWith("/api/v1/orgs/team_revoked/context-tree/installation")) {
          return response({ code: "no_installation" }, { status: 404 });
        }
        throw new Error(`unexpected revocation request: ${url}`);
      }),
    );

    await initCommand.action(
      context(commandWithOptions({ bind: true, team: "team_revoked", title: "Revoked Team" }), true),
    );

    expect(process.exitCode).toBe(1);
    const error = String(vi.mocked(console.error).mock.calls.at(-1)?.[0]);
    expect(error).toContain("repo was created but not bound");
    expect(error).toContain("https://github.com/octocat/revoked-team-context-tree");
    expect(error).toContain("current Seed authority could not be revalidated");
  });

  it("stops with Needs Admin when authority changes before GitHub creation", async () => {
    const { initCommand } = await import("../commands/tree/init.js");
    const base = makeTempDir();
    process.chdir(base);
    let seedReads = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: FetchInput, init?: FetchInit) => {
        const url = String(input);
        if (url.endsWith("/api/v1/orgs/team_revoked_early/context-tree/seed-preflight") && init?.method === "POST") {
          seedReads++;
          if (seedReads === 1) {
            return response({
              organizationId: "team_revoked_early",
              state: { status: "unbound", branch: "main" },
            });
          }
          return response(
            {
              code: "CONTEXT_TREE_SEED_NEEDS_ADMIN",
              error: "Context Tree Seed requires an active Team Admin.",
            },
            { status: 403 },
          );
        }
        if (url.endsWith("/api/v1/orgs/team_revoked_early/context-tree/installation")) {
          return response({ code: "no_installation" }, { status: 404 });
        }
        throw new Error(`unexpected early revocation request: ${url}`);
      }),
    );

    await initCommand.action(
      context(commandWithOptions({ bind: true, team: "team_revoked_early", title: "Early Revoked" }), true),
    );

    expect(process.exitCode).toBe(3);
    expect(seedReads).toBe(2);
    expect(
      treeSharedMocks.runCommand.mock.calls.some(
        ([tool, args]) => tool === "gh" && args[0] === "repo" && args[1] === "create",
      ),
    ).toBe(false);
    expect(String(vi.mocked(console.error).mock.calls.at(-1)?.[0])).toContain(
      "needs an active Admin of the selected Team",
    );
  });

  it("preserves a competing binding that appears after GitHub creation", async () => {
    const { initCommand } = await import("../commands/tree/init.js");
    const base = makeTempDir();
    process.chdir(base);
    let seedReads = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: FetchInput, init?: FetchInit) => {
        const url = String(input);
        if (url.endsWith("/api/v1/orgs/team_late_race/context-tree/seed-preflight") && init?.method === "POST") {
          seedReads++;
          if (seedReads < 3) {
            return response({
              organizationId: "team_late_race",
              state: { status: "unbound", branch: "main" },
            });
          }
          return response({
            organizationId: "team_late_race",
            state: {
              status: "bound",
              binding: { repo: "https://github.com/acme/competing-tree", branch: "release" },
            },
          });
        }
        if (url.endsWith("/api/v1/orgs/team_late_race/context-tree/installation")) {
          return response({ code: "no_installation" }, { status: 404 });
        }
        throw new Error(`unexpected late race request: ${url}`);
      }),
    );

    await initCommand.action(
      context(commandWithOptions({ bind: true, team: "team_late_race", title: "Late Race" }), true),
    );

    expect(process.exitCode).toBe(1);
    expect(
      treeSharedMocks.runCommand.mock.calls.some(
        ([tool, args]) => tool === "gh" && args[0] === "repo" && args[1] === "create",
      ),
    ).toBe(true);
    const error = String(vi.mocked(console.error).mock.calls.at(-1)?.[0]);
    expect(error).toContain("repo was created but not bound");
    expect(error).toContain("https://github.com/octocat/late-race-context-tree");
    expect(error).toContain("became bound to https://github.com/acme/competing-tree#release");
    expect(error).toContain("That current binding was preserved");
  });

  it("reports uncertain GitHub create truth without claiming rollback", async () => {
    const { initCommand } = await import("../commands/tree/init.js");
    const base = makeTempDir();
    process.chdir(base);
    let seedReads = 0;
    treeSharedMocks.runCommand.mockImplementation((tool: string, args: string[]) => {
      if (tool === "gh" && args[0] === "repo" && args[1] === "create") {
        throw new Error("transport closed");
      }
      if (args[0] === "--version" || (tool === "gh" && args[0] === "auth" && args[1] === "status")) return "";
      if (tool === "gh" && args[0] === "api" && args[1] === "user") return "octocat";
      return "";
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: FetchInput, init?: FetchInit) => {
        const url = String(input);
        if (url.endsWith("/api/v1/orgs/team_transport/context-tree/seed-preflight") && init?.method === "POST") {
          seedReads++;
          return response({
            organizationId: "team_transport",
            state: { status: "unbound", branch: "main" },
          });
        }
        if (url.endsWith("/api/v1/orgs/team_transport/context-tree/installation")) {
          return response({ code: "no_installation" }, { status: 404 });
        }
        throw new Error(`unexpected transport request: ${url}`);
      }),
    );

    await initCommand.action(
      context(commandWithOptions({ bind: true, team: "team_transport", title: "Transport" }), true),
    );

    expect(process.exitCode).toBe(1);
    expect(seedReads).toBe(3);
    const error = String(vi.mocked(console.error).mock.calls.at(-1)?.[0]);
    expect(error).toContain("GitHub create/push did not complete cleanly");
    expect(error).toContain("remote repository may exist");
    expect(error).toContain("no rollback is claimed");
    expect(error).toContain("remains unbound at branch main");
  });

  it("creates and binds a nested Self-Managed GitLab repository with only local glab/git credentials", async () => {
    const { initCommand } = await import("../commands/tree/init.js");
    const base = makeTempDir();
    process.chdir(base);
    let seedReads = 0;
    treeSharedMocks.runCommand.mockImplementation((tool: string, args: string[]) => {
      if (args[0] === "--version") return "";
      if (tool === "glab" && args[0] === "auth" && args[1] === "status") return "";
      if (tool === "glab" && args[0] === "api" && args[1] === "user") {
        return JSON.stringify({ username: "gitlab-admin" });
      }
      if (tool === "glab" && args[0] === "repo" && args[1] === "view") {
        throw new Error("404 project not found");
      }
      return "";
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: FetchInput, init?: FetchInit) => {
        const url = String(input);
        if (url.endsWith("/api/v1/orgs/team_gitlab/context-tree/seed-preflight") && init?.method === "POST") {
          seedReads++;
          expect(JSON.parse(String(init.body))).toEqual({});
          return response({
            organizationId: "team_gitlab",
            state: { status: "unbound", branch: "main" },
            gitlabConnection: {
              id: "connection-1",
              instanceOrigin: "https://gitlab.example:8443",
            },
          });
        }
        if (url.endsWith("/api/v1/orgs/team_gitlab/settings/context_tree/initialize") && init?.method === "POST") {
          expect(JSON.parse(String(init.body))).toEqual({
            provider: "gitlab",
            repo: "ssh://git@gitlab.example/acme/platform/context-tree.git",
            branch: "main",
            expectedUnboundBranch: "main",
          });
          return bindingResponse(init);
        }
        throw new Error(`unexpected GitLab Seed request: ${url}`);
      }),
    );

    await initCommand.action(
      context(
        commandWithOptions({
          team: "team_gitlab",
          provider: "gitlab",
          repo: "ssh://git@gitlab.example/acme/platform/context-tree.git",
          branch: "main",
          create: true,
          bind: true,
          dir: "gitlab-tree",
        }),
        true,
      ),
    );

    expect(process.exitCode).toBeUndefined();
    expect(seedReads).toBe(3);
    expect(treeSharedMocks.runCommand).toHaveBeenCalledWith(
      "glab",
      ["auth", "status", "--hostname", "gitlab.example:8443"],
      base,
    );
    expect(treeSharedMocks.runCommand).toHaveBeenCalledWith(
      "glab",
      ["api", "user", "--hostname", "gitlab.example:8443"],
      base,
      { GITLAB_HOST: "gitlab.example:8443" },
    );
    expect(treeSharedMocks.runCommand).toHaveBeenCalledWith(
      "glab",
      ["repo", "create", "acme/platform/context-tree", "--private", "--defaultBranch", "main"],
      expect.any(String),
      { GITLAB_HOST: "gitlab.example:8443" },
    );
    expect(treeSharedMocks.runCommand.mock.calls.some(([tool]) => tool === "gh")).toBe(false);
    const root = join(base, "gitlab-tree");
    expect(readFileSync(join(root, "NODE.md"), "utf8")).toContain("gitlab-admin");
    expect(existsSync(join(root, ".github"))).toBe(false);
    const summary = JSON.parse(String(vi.mocked(console.log).mock.calls.at(-1)?.[0])) as Record<string, unknown>;
    expect(summary).toMatchObject({
      outcome: "created",
      provider: "gitlab",
      mode: "create",
      teamId: "team_gitlab",
      repo: "ssh://git@gitlab.example/acme/platform/context-tree.git",
      branch: "main",
      bound: true,
    });
  });

  it("stops before local auth or forge mutation when the Team has no current GitLab connection", async () => {
    const { initCommand } = await import("../commands/tree/init.js");
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: FetchInput, init?: FetchInit) => {
        const url = String(input);
        expect(url).toMatch(/\/api\/v1\/orgs\/team_denied\/context-tree\/seed-preflight$/u);
        expect(init?.method).toBe("POST");
        expect(JSON.parse(String(init?.body))).toEqual({});
        return response({
          organizationId: "team_denied",
          state: { status: "unbound", branch: "main" },
          gitlabConnection: null,
        });
      }),
    );

    await initCommand.action(
      context(
        commandWithOptions({
          team: "team_denied",
          provider: "gitlab",
          repo: "https://gitlab.example/acme/context-tree.git",
          branch: "main",
          create: true,
          bind: true,
        }),
        true,
      ),
    );

    expect(process.exitCode).toBe(1);
    expect(treeSharedMocks.runCommand).not.toHaveBeenCalled();
    expect(String(vi.mocked(console.error).mock.calls.at(-1)?.[0])).toContain(
      "requires the Team's current GitLab connection",
    );
  });

  it("requires an explicit Team for provider-aware init even in a managed working directory", async () => {
    const { initCommand } = await import("../commands/tree/init.js");

    await initCommand.action(
      context(
        commandWithOptions({
          provider: "gitlab",
          repo: "https://gitlab.example/acme/context-tree.git",
          branch: "main",
          create: true,
          bind: true,
        }),
        true,
      ),
    );

    expect(process.exitCode).toBe(1);
    expect(treeSharedMocks.runCommand).not.toHaveBeenCalled();
    expect(String(vi.mocked(console.error).mock.calls.at(-1)?.[0])).toContain(
      "--team is required by the provider-aware Seed contract",
    );
  });
});
