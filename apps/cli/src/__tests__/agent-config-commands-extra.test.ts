import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";

import {
  type AgentRuntimeConfig,
  type AgentRuntimeConfigPatch,
  agentRuntimeConfigPayloadSchema,
} from "@first-tree/shared";
import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const bootstrapMocks = vi.hoisted(() => ({
  ensureFreshAdminToken: vi.fn(),
  resolveServerUrl: vi.fn(),
}));

const fetcherMocks = vi.hoisted(() => ({
  adminFetch: vi.fn(),
  getAgentResources: vi.fn(),
  getCurrent: vi.fn(),
  patchAgentResources: vi.fn(),
  patchConfig: vi.fn(),
  printConfig: vi.fn(),
  resolveAgentRecord: vi.fn(),
}));

const outputMocks = vi.hoisted(() => ({
  fail: vi.fn((code: string, message: string, exitCode = 1) => {
    throw Object.assign(new Error(message), { code, exitCode });
  }),
  success: vi.fn(),
}));

vi.mock("../core/bootstrap.js", () => bootstrapMocks);
vi.mock("../commands/agent/config/_shared/fetchers.js", () => fetcherMocks);

const stdinMock = vi.hoisted(() => ({ readStdin: vi.fn() }));
const printMock = vi.hoisted(() => ({ line: vi.fn() }));

vi.mock("../commands/_shared/stdin.js", () => stdinMock);
vi.mock("../core/output.js", () => ({ print: printMock }));
vi.mock("../cli/output.js", () => outputMocks);

const NOW = "2026-06-01T00:00:00.000Z";
let tempDir = "";

function config(overrides: Partial<AgentRuntimeConfig> = {}): AgentRuntimeConfig {
  return {
    agentId: overrides.agentId ?? "agent-1",
    version: overrides.version ?? 1,
    payload: overrides.payload ?? {
      kind: "claude-code",
      prompt: { append: "base prompt" },
      model: "sonnet",
      reasoningEffort: "medium",
      mcpServers: [{ name: "existing", transport: "stdio", command: "node", args: ["server.js"] }],
      env: [{ key: "KEEP", value: "1", sensitive: false }],
      gitRepos: [{ url: "https://github.com/acme/old.git", localPath: "old" }],
      resourceSkills: [],
    },
    updatedAt: overrides.updatedAt ?? NOW,
    updatedBy: overrides.updatedBy ?? "member-1",
  };
}

async function runConfig(args: string[]): Promise<void> {
  const { registerAgentConfigCommands } = await import("../commands/agent/config/index.js");
  const program = new Command();
  program.exitOverride();
  program.configureOutput({ writeErr: () => undefined, writeOut: () => undefined });
  const agent = program.command("agent");
  registerAgentConfigCommands(agent);
  await program.parseAsync(["node", "test", "agent", "config", ...args]);
}

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "ft-cli-agent-config-"));
  vi.clearAllMocks();
  bootstrapMocks.ensureFreshAdminToken.mockResolvedValue("admin-token");
  bootstrapMocks.resolveServerUrl.mockReturnValue("https://hub.example");
  fetcherMocks.resolveAgentRecord.mockResolvedValue({ uuid: "agent-uuid", name: "nova" });
  fetcherMocks.getCurrent.mockResolvedValue(config());
  fetcherMocks.getAgentResources.mockResolvedValue({
    version: 1,
    bindings: [],
    effective: { version: 1, repos: [], prompts: [], skills: [], mcp: [], unavailable: [] },
    availableTeamResources: [],
  });
  fetcherMocks.patchAgentResources.mockResolvedValue({
    version: 2,
    bindings: [],
    effective: { version: 2, repos: [], prompts: [], skills: [], mcp: [], unavailable: [] },
    availableTeamResources: [],
  });
  fetcherMocks.patchConfig.mockImplementation(
    async (
      _serverUrl: string,
      _adminToken: string,
      _uuid: string,
      _version: number,
      patch: AgentRuntimeConfigPatch,
    ) => {
      const current = config();
      return config({
        version: current.version + 1,
        payload: agentRuntimeConfigPayloadSchema.parse({
          ...current.payload,
          ...patch,
        }),
      });
    },
  );
});

afterEach(() => {
  rmSync(tempDir, { force: true, recursive: true });
});

describe("agent config command behavior", () => {
  it("rejects legacy per-agent MCP writes", async () => {
    await expect(
      runConfig(["add-mcp", "nova", "--name", "tools", "--transport", "stdio", "--command", "uvx", "--args", "a", "b"]),
    ).rejects.toMatchObject({
      code: "LEGACY_MCP_CONFIG_DISABLED",
      exitCode: 2,
    });
    expect(outputMocks.fail).toHaveBeenCalledWith(
      "LEGACY_MCP_CONFIG_DISABLED",
      "Legacy per-agent MCP config writes are disabled. MCP configuration will be managed by Team MCP Resources.",
      2,
    );
    expect(fetcherMocks.patchConfig).not.toHaveBeenCalled();
  });

  it("updates git repos, env vars, model, reasoning effort, and prompt append", async () => {
    await runConfig(["add-repo", "nova", "https://github.com/acme/web.git", "--ref", "main", "--path", "web"]);
    expect(fetcherMocks.patchAgentResources).toHaveBeenLastCalledWith(
      "https://hub.example",
      "admin-token",
      "agent-uuid",
      {
        expectedVersion: 1,
        bindings: [
          {
            type: "repo",
            mode: "include",
            agentExtraRepo: { url: "https://github.com/acme/web.git" },
            repoRef: "main",
            repoLocalPath: "web",
            order: 1,
          },
        ],
      },
    );

    await runConfig(["set-env", "nova", "OPENAI_API_KEY=secret", "--sensitive"]);
    expect(fetcherMocks.patchConfig).toHaveBeenLastCalledWith("https://hub.example", "admin-token", "agent-uuid", 1, {
      env: [
        { key: "KEEP", value: "1", sensitive: false },
        { key: "OPENAI_API_KEY", value: "secret", sensitive: true },
      ],
    });

    await expect(runConfig(["set-env", "nova", "BROKEN"])).rejects.toMatchObject({ code: "BAD_KV", exitCode: 2 });

    // SEC-052: with --value-stdin the value never appears in argv, and the
    // trailing newline a pipe adds is not part of the credential.
    stdinMock.readStdin.mockResolvedValueOnce("s3cret-value\n");
    await runConfig(["set-env", "nova", "OPENAI_API_KEY", "--sensitive", "--value-stdin"]);
    expect(fetcherMocks.patchConfig).toHaveBeenLastCalledWith("https://hub.example", "admin-token", "agent-uuid", 1, {
      env: [
        { key: "KEEP", value: "1", sensitive: false },
        { key: "OPENAI_API_KEY", value: "s3cret-value", sensitive: true },
      ],
    });
    await expect(runConfig(["set-env", "nova", "OPENAI_API_KEY=inline", "--value-stdin"])).rejects.toMatchObject({
      code: "BAD_KV",
      exitCode: 2,
    });
    await expect(runConfig(["set-env", "nova", "--value-stdin"])).rejects.toMatchObject({
      code: "BAD_KV",
      exitCode: 2,
    });
    stdinMock.readStdin.mockResolvedValueOnce(null);
    await expect(runConfig(["set-env", "nova", "OPENAI_API_KEY", "--value-stdin"])).rejects.toMatchObject({
      code: "NO_STDIN",
      exitCode: 2,
    });

    // A positional value still works, but a sensitive one is nudged to the pipe.
    printMock.line.mockClear();
    await runConfig(["set-env", "nova", "PLAIN=visible"]);
    expect(printMock.line).not.toHaveBeenCalled();
    await runConfig(["set-env", "nova", "SECRET=inline", "--sensitive"]);
    expect(printMock.line.mock.calls.map((call) => String(call[0])).join("")).toContain("--value-stdin");

    await runConfig(["set-model", "nova", "opus"]);
    expect(fetcherMocks.patchConfig).toHaveBeenLastCalledWith("https://hub.example", "admin-token", "agent-uuid", 1, {
      model: "opus",
    });
    expect(outputMocks.success).toHaveBeenLastCalledWith({ agentId: "agent-1", version: 2, model: "opus" });

    await runConfig(["set-reasoning-effort", "nova", "high"]);
    expect(fetcherMocks.patchConfig).toHaveBeenLastCalledWith("https://hub.example", "admin-token", "agent-uuid", 1, {
      reasoningEffort: "high",
    });
    expect(outputMocks.success).toHaveBeenLastCalledWith({
      agentId: "agent-1",
      version: 2,
      reasoningEffort: "high",
    });

    const promptFile = join(tempDir, "prompt.md");
    writeFileSync(promptFile, "Prefer small diffs.");
    await runConfig(["append-prompt", "nova", "--file", promptFile]);
    expect(fetcherMocks.patchAgentResources).toHaveBeenLastCalledWith(
      "https://hub.example",
      "admin-token",
      "agent-uuid",
      {
        expectedVersion: 1,
        bindings: [
          {
            type: "prompt",
            mode: "include",
            resourceId: null,
            inlinePromptBody: "Prefer small diffs.",
            order: 1,
          },
        ],
      },
    );
    expect(outputMocks.success).toHaveBeenLastCalledWith({ agentId: "agent-uuid", version: 2, append_length: 19 });
  });

  it("sets the Codex provider-native service tier", async () => {
    const codexPayload: AgentRuntimeConfig["payload"] = {
      kind: "codex",
      prompt: { append: "" },
      model: "",
      reasoningEffort: "high",
      serviceTier: "default",
      mcpServers: [],
      env: [],
      gitRepos: [],
      resourceSkills: [],
    };
    fetcherMocks.getCurrent.mockResolvedValueOnce(config({ payload: codexPayload }));
    fetcherMocks.patchConfig.mockResolvedValueOnce(
      config({ version: 2, payload: { ...codexPayload, serviceTier: "fast" } }),
    );

    await runConfig(["set-service-tier", "nova", "fast"]);

    expect(fetcherMocks.patchConfig).toHaveBeenCalledWith("https://hub.example", "admin-token", "agent-uuid", 1, {
      serviceTier: "fast",
    });
    expect(outputMocks.success).toHaveBeenCalledWith({
      agentId: "agent-1",
      version: 2,
      serviceTier: "fast",
    });
  });

  it("replaces the existing inline append prompt binding", async () => {
    fetcherMocks.getAgentResources.mockResolvedValueOnce({
      version: 3,
      bindings: [
        {
          id: "old-prompt",
          type: "prompt",
          mode: "include",
          resourceId: null,
          replacesResourceId: null,
          inlinePromptBody: "Old prompt.",
          order: 2,
        },
        {
          id: "keep-repo",
          type: "repo",
          mode: "include",
          resourceId: "team-repo",
          order: 1,
        },
      ],
      effective: { version: 3, repos: [], prompts: [], skills: [], mcp: [], unavailable: [] },
      availableTeamResources: [],
    });

    const promptFile = join(tempDir, "prompt-replacement.md");
    writeFileSync(promptFile, "New prompt.");
    await runConfig(["append-prompt", "nova", "--file", promptFile]);

    expect(fetcherMocks.patchAgentResources).toHaveBeenLastCalledWith(
      "https://hub.example",
      "admin-token",
      "agent-uuid",
      {
        expectedVersion: 3,
        bindings: [
          {
            id: "keep-repo",
            type: "repo",
            mode: "include",
            resourceId: "team-repo",
            order: 1,
          },
          {
            type: "prompt",
            mode: "include",
            resourceId: null,
            inlinePromptBody: "New prompt.",
            order: 2,
          },
        ],
      },
    );
  });

  it("replaces an existing agent-scoped repo binding by canonical url", async () => {
    fetcherMocks.getAgentResources.mockResolvedValueOnce({
      version: 4,
      bindings: [
        {
          id: "old-agent-repo",
          type: "repo",
          mode: "include",
          resourceId: "agent-repo-resource",
          repoRef: "old",
          repoLocalPath: "web",
          order: 3,
        },
      ],
      effective: {
        version: 4,
        repos: [
          {
            id: "binding:old-agent-repo:enabled",
            bindingId: "old-agent-repo",
            resourceId: "agent-repo-resource",
            replacesResourceId: null,
            type: "repo",
            name: "web",
            scope: "agent",
            source: "agent_extra",
            mode: "enabled",
            defaultEnabled: null,
            payload: { url: "git@github.com:Acme/Web.git" },
            repo: { url: "git@github.com:Acme/Web.git", localPath: "web" },
            promptBody: null,
            unavailableReason: null,
            order: 3,
          },
        ],
        prompts: [],
        skills: [],
        mcp: [],
        unavailable: [],
      },
      availableTeamResources: [],
    });

    await runConfig(["add-repo", "nova", "https://github.com/acme/web.git", "--ref", "main", "--path", "web"]);

    expect(fetcherMocks.patchAgentResources).toHaveBeenLastCalledWith(
      "https://hub.example",
      "admin-token",
      "agent-uuid",
      {
        expectedVersion: 4,
        bindings: [
          {
            type: "repo",
            mode: "include",
            agentExtraRepo: { url: "https://github.com/acme/web.git" },
            repoRef: "main",
            repoLocalPath: "web",
            order: 3,
          },
        ],
      },
    );
  });

  it("updates a matching team repo binding without converting it to an agent extra", async () => {
    fetcherMocks.getAgentResources.mockResolvedValueOnce({
      version: 5,
      bindings: [
        {
          id: "team-binding",
          type: "repo",
          mode: "include",
          resourceId: "team-repo",
          repoRef: "old",
          repoLocalPath: "web",
          order: 2,
        },
      ],
      effective: {
        version: 5,
        repos: [
          {
            id: "binding:team-binding:enabled",
            bindingId: "team-binding",
            resourceId: "team-repo",
            replacesResourceId: null,
            type: "repo",
            name: "web",
            scope: "team",
            source: "team_available",
            mode: "enabled",
            defaultEnabled: "available",
            payload: { url: "git@github.com:Acme/Web.git" },
            repo: { url: "git@github.com:Acme/Web.git", ref: "old", localPath: "web" },
            promptBody: null,
            unavailableReason: null,
            order: 2,
          },
        ],
        prompts: [],
        skills: [],
        mcp: [],
        unavailable: [],
      },
      availableTeamResources: [
        {
          id: "team-repo",
          organizationId: "org-1",
          type: "repo",
          scope: "team",
          ownerAgentId: null,
          name: "web",
          repoCanonicalKey: "github.com/acme/web",
          defaultEnabled: "available",
          status: "active",
          payload: { url: "https://github.com/acme/web.git" },
          createdBy: "member-1",
          updatedBy: "member-1",
          createdAt: NOW,
          updatedAt: NOW,
        },
      ],
    });

    await runConfig(["add-repo", "nova", "https://github.com/acme/web.git", "--ref", "main", "--path", "web"]);

    expect(fetcherMocks.patchAgentResources).toHaveBeenLastCalledWith(
      "https://hub.example",
      "admin-token",
      "agent-uuid",
      {
        expectedVersion: 5,
        bindings: [
          {
            type: "repo",
            mode: "include",
            resourceId: "team-repo",
            repoRef: "main",
            repoLocalPath: "web",
            order: 2,
          },
        ],
      },
    );
  });

  it("matches repo resources from payload fallback and preserves unrelated bindings", async () => {
    fetcherMocks.getAgentResources.mockResolvedValueOnce({
      version: 6,
      bindings: [
        {
          id: "prompt-binding",
          type: "prompt",
          mode: "include",
          resourceId: null,
          inlinePromptBody: "Keep me.",
          order: 1,
        },
        {
          id: "team-binding",
          type: "repo",
          mode: "include",
          resourceId: "payload-team-repo",
          order: 4,
        },
      ],
      effective: {
        version: 6,
        repos: [
          {
            id: "binding:team-binding:enabled",
            bindingId: "team-binding",
            resourceId: "payload-team-repo",
            replacesResourceId: null,
            type: "repo",
            name: "web",
            scope: "team",
            source: "team_available",
            mode: "enabled",
            defaultEnabled: "available",
            payload: { url: "git@github.com:Acme/Web.git" },
            repo: null,
            promptBody: null,
            unavailableReason: null,
            order: 4,
          },
        ],
        prompts: [],
        skills: [],
        mcp: [],
        unavailable: [],
      },
      availableTeamResources: [],
    });

    await runConfig(["add-repo", "nova", "https://github.com/acme/web.git"]);

    expect(fetcherMocks.patchAgentResources).toHaveBeenLastCalledWith(
      "https://hub.example",
      "admin-token",
      "agent-uuid",
      {
        expectedVersion: 6,
        bindings: [
          {
            id: "prompt-binding",
            type: "prompt",
            mode: "include",
            resourceId: null,
            inlinePromptBody: "Keep me.",
            order: 1,
          },
          {
            type: "repo",
            mode: "include",
            resourceId: "payload-team-repo",
            repoRef: undefined,
            repoLocalPath: undefined,
            order: 4,
          },
        ],
      },
    );
  });

  it("adds invalid repo URLs as agent extras without canonical matching", async () => {
    fetcherMocks.getAgentResources.mockResolvedValueOnce({
      version: 7,
      bindings: [
        {
          id: "keep-repo",
          type: "repo",
          mode: "include",
          agentExtraRepo: { url: "not a canonical url either" },
          order: 1,
        },
      ],
      effective: { version: 7, repos: [], prompts: [], skills: [], mcp: [], unavailable: [] },
      availableTeamResources: [],
    });

    await runConfig(["add-repo", "nova", "not a repo url"]);

    expect(fetcherMocks.patchAgentResources).toHaveBeenLastCalledWith(
      "https://hub.example",
      "admin-token",
      "agent-uuid",
      {
        expectedVersion: 7,
        bindings: [
          {
            id: "keep-repo",
            type: "repo",
            mode: "include",
            agentExtraRepo: { url: "not a canonical url either" },
            order: 1,
          },
          {
            type: "repo",
            mode: "include",
            agentExtraRepo: { url: "not a repo url" },
            repoRef: undefined,
            repoLocalPath: undefined,
            order: 2,
          },
        ],
      },
    );
  });

  it("`prompt set` replaces the inline fragment exactly like append-prompt", async () => {
    const promptFile = join(tempDir, "fragment.md");
    writeFileSync(promptFile, "Prefer small diffs.");
    await runConfig(["prompt", "set", "nova", "--file", promptFile]);
    expect(fetcherMocks.patchAgentResources).toHaveBeenLastCalledWith(
      "https://hub.example",
      "admin-token",
      "agent-uuid",
      {
        expectedVersion: 1,
        bindings: [
          {
            type: "prompt",
            mode: "include",
            resourceId: null,
            inlinePromptBody: "Prefer small diffs.",
            order: 1,
          },
        ],
      },
    );
    expect(outputMocks.success).toHaveBeenLastCalledWith({ agentId: "agent-uuid", version: 2, append_length: 19 });
  });

  it("`prompt set` reads the fragment from piped stdin when no file is provided", async () => {
    const stdin = new PassThrough();
    Object.defineProperty(stdin, "isTTY", { value: false });
    const stdinSpy = vi.spyOn(process, "stdin", "get").mockReturnValue(stdin as unknown as typeof process.stdin);

    try {
      const pending = runConfig(["prompt", "set", "nova"]);
      stdin.end("Prefer stdin fragments.");
      await pending;
    } finally {
      stdinSpy.mockRestore();
    }

    expect(fetcherMocks.patchAgentResources).toHaveBeenLastCalledWith(
      "https://hub.example",
      "admin-token",
      "agent-uuid",
      {
        expectedVersion: 1,
        bindings: [
          {
            type: "prompt",
            mode: "include",
            resourceId: null,
            inlinePromptBody: "Prefer stdin fragments.",
            order: 1,
          },
        ],
      },
    );
  });

  it("`prompt set` hard-rejects a body carrying the generated-briefing marker (no --force escape)", async () => {
    const promptFile = join(tempDir, "assembled-agents-md.md");
    writeFileSync(promptFile, "<!-- first-tree:generated — rebuilt every session -->\n# Identity\n\nYou are nova.");

    await expect(runConfig(["prompt", "set", "nova", "--file", promptFile])).rejects.toMatchObject({
      code: "ASSEMBLED_BRIEFING",
      exitCode: 2,
    });
    // --force must NOT bypass the conclusive marker tier.
    await expect(runConfig(["prompt", "set", "nova", "--file", promptFile, "--force"])).rejects.toMatchObject({
      code: "ASSEMBLED_BRIEFING",
      exitCode: 2,
    });
    // The deprecated alias carries the same guard.
    await expect(runConfig(["append-prompt", "nova", "--file", promptFile])).rejects.toMatchObject({
      code: "ASSEMBLED_BRIEFING",
      exitCode: 2,
    });
    expect(fetcherMocks.patchAgentResources).not.toHaveBeenCalled();
    // The error message must point at the correct round-trip flow.
    expect(outputMocks.fail).toHaveBeenCalledWith(
      "ASSEMBLED_BRIEFING",
      expect.stringContaining("agent config prompt show <agent> --raw"),
      2,
    );
  });

  it("`prompt set` rejects briefing-shaped headings as a heuristic, overridable with --force", async () => {
    const promptFile = join(tempDir, "heading.md");
    writeFileSync(promptFile, "# Working in First Tree (First Tree Managed)\n\nPasted section.");

    await expect(runConfig(["prompt", "set", "nova", "--file", promptFile])).rejects.toMatchObject({
      code: "ASSEMBLED_BRIEFING_HEADING",
      exitCode: 2,
    });
    expect(fetcherMocks.patchAgentResources).not.toHaveBeenCalled();

    await runConfig(["prompt", "set", "nova", "--file", promptFile, "--force"]);
    expect(fetcherMocks.patchAgentResources).toHaveBeenCalledTimes(1);
  });

  it("`prompt show --raw` prints the stored fragment verbatim (byte-for-byte) for edit round-trips", async () => {
    // Intentional leading indentation and trailing blank line: whitespace is
    // content (e.g. an indented code block) and must survive the round-trip
    // untouched — no trim, no appended newline.
    const storedBody = "  indented code block\nPrefer small diffs.\n\n";
    fetcherMocks.getAgentResources.mockResolvedValueOnce({
      version: 3,
      bindings: [
        {
          id: "inline-1",
          type: "prompt",
          mode: "include",
          resourceId: null,
          replacesResourceId: null,
          inlinePromptBody: storedBody,
          order: 1,
        },
        // Inline *replacement* of a team prompt: not owned by `prompt set`,
        // so it must not leak into the raw export either.
        {
          id: "replace-1",
          type: "prompt",
          mode: "replace",
          resourceId: null,
          replacesResourceId: "team-prompt",
          inlinePromptBody: "Agent-specific tone override.",
          order: 2,
        },
      ],
      effective: { version: 3, repos: [], prompts: [], skills: [], mcp: [], unavailable: [] },
      availableTeamResources: [],
    });
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    await runConfig(["prompt", "show", "nova", "--raw"]);
    expect(stdout.mock.calls.map((call) => String(call[0])).join("")).toBe(storedBody);
    stdout.mockRestore();
  });

  it("`prompt show` (no --raw) renders the effective prompt stack with provenance and the round-trip hint", async () => {
    fetcherMocks.getAgentResources.mockResolvedValueOnce({
      version: 3,
      bindings: [
        {
          id: "inline-1",
          type: "prompt",
          mode: "include",
          resourceId: null,
          replacesResourceId: null,
          inlinePromptBody: "Prefer small diffs.",
          order: 2,
        },
      ],
      effective: {
        version: 3,
        repos: [],
        prompts: [
          {
            id: "res:team-prompt:enabled",
            bindingId: null,
            resourceId: "team-prompt",
            replacesResourceId: null,
            type: "prompt",
            name: "Review rules",
            scope: "team",
            source: "team_recommended",
            mode: "enabled",
            defaultEnabled: "recommended",
            payload: { body: "Always review twice." },
            repo: null,
            promptBody: "Always review twice.",
            unavailableReason: null,
            order: 1,
          },
          {
            id: "binding:inline-1:enabled",
            bindingId: "inline-1",
            resourceId: null,
            replacesResourceId: null,
            type: "prompt",
            name: "",
            scope: "agent",
            source: "inline_prompt",
            mode: "enabled",
            defaultEnabled: null,
            payload: null,
            repo: null,
            promptBody: "Prefer small diffs.",
            unavailableReason: null,
            order: 2,
          },
          // Inline replacement of a team prompt — agent scope, but managed
          // via resource bindings, so it must not be called the fragment.
          {
            id: "binding:replace-1:enabled",
            bindingId: "replace-1",
            resourceId: null,
            replacesResourceId: "team-prompt-2",
            type: "prompt",
            name: "Tone guide",
            scope: "agent",
            source: "inline_prompt",
            mode: "enabled",
            defaultEnabled: null,
            payload: null,
            repo: null,
            promptBody: "Agent-specific tone override.",
            unavailableReason: null,
            order: 3,
          },
        ],
        skills: [],
        mcp: [],
        unavailable: [],
      },
      availableTeamResources: [],
    });
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    await runConfig(["prompt", "show", "nova"]);
    const out = stdout.mock.calls.map((call) => String(call[0])).join("");
    stdout.mockRestore();

    expect(out).toContain("[team] Review rules");
    expect(out).toContain("[agent] per-agent fragment");
    expect(out).toContain('[agent] inline replacement of team prompt "Tone guide" (managed via resource bindings)');
    expect(out).toContain("Prefer small diffs.");
    // Round-trip hint: how to edit the only agent-editable source.
    expect(out).toContain("prompt show <agent> --raw");
    expect(out).toContain("prompt set <agent> -f");
    expect(out).toContain("team prompts are managed in Cloud");
  });

  it("`prompt show` renders empty effective and fragment states", async () => {
    fetcherMocks.getAgentResources.mockResolvedValueOnce({
      version: 8,
      bindings: [],
      effective: {
        version: 8,
        repos: [],
        prompts: [],
        skills: [],
        mcp: [],
        unavailable: [],
      },
      availableTeamResources: [],
    });
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    await runConfig(["prompt", "show", "nova"]);
    const out = stdout.mock.calls.map((call) => String(call[0])).join("");
    stdout.mockRestore();

    expect(out).toContain("  (none)");
    expect(out).toContain("Per-agent fragment: (empty)");
  });

  it("`prompt show` describes empty and disabled prompt rows", async () => {
    fetcherMocks.getAgentResources.mockResolvedValueOnce({
      version: 9,
      bindings: [],
      effective: {
        version: 9,
        repos: [],
        prompts: [
          {
            id: "team-disabled",
            bindingId: null,
            resourceId: "team-disabled",
            replacesResourceId: null,
            type: "prompt",
            name: "Dormant guide",
            scope: "team",
            source: "team_available",
            mode: "disabled",
            defaultEnabled: "available",
            payload: { body: "" },
            repo: null,
            promptBody: "",
            unavailableReason: null,
            order: 1,
          },
        ],
        skills: [],
        mcp: [],
        unavailable: [],
      },
      availableTeamResources: [],
    });
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    await runConfig(["prompt", "show", "nova"]);
    const out = stdout.mock.calls.map((call) => String(call[0])).join("");
    stdout.mockRestore();

    expect(out).toContain("[team] Dormant guide (disabled)");
  });

  it("`prompt set` fails when no file is provided and stdin is interactive", async () => {
    const stdinSpy = vi.spyOn(process, "stdin", "get").mockReturnValue({ isTTY: true } as typeof process.stdin);
    try {
      await expect(runConfig(["prompt", "set", "nova"])).rejects.toMatchObject({
        code: "MISSING_INPUT",
        exitCode: 2,
      });
    } finally {
      stdinSpy.mockRestore();
    }
  });

  it("shows config and prints dry-run diffs", async () => {
    await runConfig(["show", "nova"]);
    expect(fetcherMocks.printConfig).toHaveBeenCalledWith(config());

    const patchFile = join(tempDir, "patch.json");
    writeFileSync(patchFile, JSON.stringify({ model: "haiku", env: [] }));
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    fetcherMocks.adminFetch.mockResolvedValueOnce({
      current: config(),
      next: { ...config().payload, model: "haiku" },
      diff: [
        { op: "replace", path: "/model", before: "sonnet", after: "haiku" },
        { op: "replace", path: "/env", before: [{ key: "KEEP", value: "1", sensitive: false }], after: [] },
      ],
    });

    await runConfig(["dry-run", "nova", "--file", patchFile]);

    expect(fetcherMocks.adminFetch).toHaveBeenCalledWith(
      "https://hub.example/api/v1/agents/agent-uuid/config/dry-run",
      {
        method: "POST",
        adminToken: "admin-token",
        body: JSON.stringify({ payload: { model: "haiku", env: [] } }),
      },
    );
    expect(stdout.mock.calls.map((call) => String(call[0])).join("")).toContain("Diff (2 changes):");
    stdout.mockRestore();
  });
});
