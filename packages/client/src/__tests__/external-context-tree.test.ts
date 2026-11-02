import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { FIRST_TREE_CORE_SKILL_NAMES } from "@first-tree/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { withContextTreeShimDirOnPath } from "../runtime/agent-io.js";
import {
  CONTEXT_TREE_SHIM_MARKER,
  contextTreeCliVersion,
  contextTreeShimDir,
  ensureExternalContextTreeWorkspace,
  packagedContextTreeSkillNames,
  prepareExternalContextTreeForSession,
  recordedExternalContextTreeWorkspaces,
  removeExternalContextTreeWorkspace,
  resolveContextTreeRef,
  writeContextTreeShim,
} from "../runtime/external-context-tree.js";

/**
 * Runs against the real bundled CLI. Only paths that never reach the network
 * are exercised here; connect and the default-branch lookup are covered
 * offline by the CLI's `context-tree-cli.test.ts`.
 */
const ENV_VARS = ["FIRST_TREE_HOME", "GIT_CONFIG_COUNT", "GIT_CONFIG_KEY_0", "GIT_CONFIG_VALUE_0"] as const;
const originalEnv = new Map<string, string | undefined>();
let home: string;

beforeEach(() => {
  for (const key of ENV_VARS) originalEnv.set(key, process.env[key]);
  home = realpathSync(mkdtempSync(join(tmpdir(), "ft-external-context-tree-")));
  process.env.FIRST_TREE_HOME = home;
  // Any GitHub URL resolves to an empty local directory, so a connect fails
  // offline instead of reaching github.com.
  process.env.GIT_CONFIG_COUNT = "1";
  process.env.GIT_CONFIG_KEY_0 = `url.file://${join(home, "no-remotes")}/.insteadOf`;
  process.env.GIT_CONFIG_VALUE_0 = "https://github.com/";
});

afterEach(() => {
  for (const key of ENV_VARS) {
    const previous = originalEnv.get(key);
    if (previous === undefined) delete process.env[key];
    else process.env[key] = previous;
  }
});

describe("packaged Context Tree Skills", () => {
  it("bundles a 1.x CLI whose Skills never collide with First Tree Core Skills", () => {
    expect(contextTreeCliVersion()).toMatch(/^1\./);
    const names = packagedContextTreeSkillNames();
    expect(names).toEqual(expect.arrayContaining(["context-tree-read", "context-tree-write"]));
    for (const core of FIRST_TREE_CORE_SKILL_NAMES) expect(names).not.toContain(core);
  });
});

describe("context-tree shim", () => {
  it("writes a marked shim into First Tree's own directory and puts it first on PATH", () => {
    const written = writeContextTreeShim();
    expect(written).toEqual({ path: join(home, "data", "context-tree", "bin", "context-tree") });
    expect(readFileSync(join(contextTreeShimDir(), "context-tree"), "utf8")).toContain(CONTEXT_TREE_SHIM_MARKER);

    const env = withContextTreeShimDirOnPath({ PATH: ["/usr/bin", contextTreeShimDir(), "/bin"].join(delimiter) });
    expect(env.PATH).toBe([contextTreeShimDir(), "/usr/bin", "/bin"].join(delimiter));
  });

  it("leaves PATH alone until the shim exists", () => {
    expect(withContextTreeShimDirOnPath({ PATH: "/usr/bin" }).PATH).toBe("/usr/bin");
  });
});

describe("workspace Skills", () => {
  it("copies only packaged names, records the workspace, and removes only those names on revert", async () => {
    const workspace = join(home, "data", "workspaces", "agent");
    const core = join(workspace, ".claude", "skills", "context-tree-review");
    const team = join(workspace, ".agents", "skills", "context-tree-team-playbook");
    for (const dir of [core, team]) {
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "SKILL.md"), "keep\n");
    }

    // An unreachable repository: the Skills still land and the workspace is
    // recorded, so a later revert finds it.
    const result = await ensureExternalContextTreeWorkspace(workspace, {
      repository: "acme/does-not-resolve-offline",
      ref: "main",
    });
    expect(result.ok).toBe(false);
    for (const root of [".claude", ".agents"]) {
      for (const name of packagedContextTreeSkillNames()) {
        expect(existsSync(join(workspace, root, "skills", name, "SKILL.md"))).toBe(true);
      }
    }
    expect(recordedExternalContextTreeWorkspaces()).toEqual([workspace]);

    expect(await removeExternalContextTreeWorkspace(workspace)).toEqual({ ok: true, preservedSkillPaths: [] });
    for (const root of [".claude", ".agents"]) {
      for (const name of packagedContextTreeSkillNames()) {
        expect(existsSync(join(workspace, root, "skills", name))).toBe(false);
      }
    }
    expect(readFileSync(join(core, "SKILL.md"), "utf8")).toBe("keep\n");
    expect(readFileSync(join(team, "SKILL.md"), "utf8")).toBe("keep\n");
    expect(recordedExternalContextTreeWorkspaces()).toEqual([]);
  });
});

describe("best-effort boundaries", () => {
  it("reports a failed ownership-record write instead of rejecting session preparation", async () => {
    const workspace = join(home, "data", "workspaces", "ledger");
    mkdirSync(workspace, { recursive: true });
    // The record path is a directory, so every write fails with EISDIR.
    mkdirSync(join(home, "data", "context-tree-connections.json"), { recursive: true });

    const result = await ensureExternalContextTreeWorkspace(workspace, { repository: "acme/ledger", ref: "main" });
    expect(result.ok).toBe(false);

    const logs: string[] = [];
    await expect(
      prepareExternalContextTreeForSession(workspace, "acme/ledger", (message) => logs.push(message)),
    ).resolves.toBeUndefined();
    expect(logs.some((message) => message.startsWith("Context Tree:"))).toBe(true);
  });
});

describe("resolveContextTreeRef", () => {
  it("uses a configured ref without touching the network", async () => {
    expect(await resolveContextTreeRef("acme/context", "release")).toEqual({ ref: "release" });
  });
});
