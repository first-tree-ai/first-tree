import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { setCliBinding } from "@first-tree/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

/**
 * Everything here runs the real bundled `@first-tree-ai/context-tree` 1.x CLI.
 *
 * Three things are redirected so nothing reaches the developer's machine or the
 * network:
 * - `FIRST_TREE_HOME` decides where `client.yaml` and First Tree's data dir
 *   (workspaces, shim, records) live;
 * - `HOME` / `USERPROFILE` decide where the external CLI keeps snapshots and
 *   where legacy account-level Skills are looked for;
 * - a Git `url.<base>.insteadOf` rule passed through `GIT_CONFIG_*` turns
 *   `https://github.com/OWNER/REPO.git` into a local bare repository, so
 *   `connect` and the default-branch lookup run offline.
 */
const ENV_VARS = [
  "FIRST_TREE_HOME",
  "HOME",
  "USERPROFILE",
  "PATH",
  "GIT_CONFIG_COUNT",
  "GIT_CONFIG_KEY_0",
  "GIT_CONFIG_VALUE_0",
] as const;
const originalEnv = new Map<string, string | undefined>();

let home: string;
let remotes: string;

function writeConfig(context?: { repository?: string; ref?: string }): void {
  const lines = ["server:", "  url: http://localhost:8000"];
  if (context) {
    lines.push("context_tree:");
    if (context.repository !== undefined) lines.push(`  repository: ${context.repository}`);
    if (context.ref !== undefined) lines.push(`  ref: ${context.ref}`);
  }
  writeFileSync(join(home, "config", "client.yaml"), `${lines.join("\n")}\n`, "utf8");
}

/** A valid 1.x tree in a bare repository served as `https://github.com/<repository>.git`. */
function createRemoteTree(repository: string, branches: readonly string[] = ["trunk"]): void {
  const source = mkdtempSync(join(tmpdir(), "ft-context-tree-src-"));
  const git = (...args: string[]) =>
    execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", ...args], { cwd: source });
  git("init", "-q", "-b", branches[0] ?? "trunk");
  writeFileSync(
    join(source, "NODE.md"),
    '---\nschemaVersion: 1\ntitle: "context"\n---\n\n# context\n\nFixture tree.\n',
  );
  git("add", ".");
  git("commit", "-qm", "init");
  for (const branch of branches.slice(1)) git("branch", branch);
  execFileSync("git", ["clone", "-q", "--bare", source, join(remotes, `${repository}.git`)]);
}

function workspace(name: string): string {
  const path = join(home, "data", "workspaces", name);
  mkdirSync(path, { recursive: true });
  return path;
}

function declaredTrees(ws: string): unknown[] {
  return (JSON.parse(readFileSync(join(ws, ".context-tree.json"), "utf8")) as { trees: unknown[] }).trees;
}

/**
 * A scratch bin directory holding a fake channel CLI, placed first on `PATH`,
 * so the legacy shim cleanup looks there and never at a real global bin.
 */
function scratchBinDir(binName: string): string {
  const binDir = mkdtempSync(join(tmpdir(), "ft-context-tree-bin-"));
  const fakeCli = join(binDir, binName);
  writeFileSync(fakeCli, "#!/bin/sh\nexit 0\n", "utf8");
  chmodSync(fakeCli, 0o755);
  setCliBinding({ binName, packageName: null });
  process.env.PATH = [binDir, process.env.PATH ?? ""].join(delimiter);
  return binDir;
}

async function loadModule() {
  return import("../core/context-tree-cli.js");
}

beforeEach(() => {
  for (const key of ENV_VARS) originalEnv.set(key, process.env[key]);
  home = realpathSync(mkdtempSync(join(tmpdir(), "ft-context-tree-cli-")));
  remotes = realpathSync(mkdtempSync(join(tmpdir(), "ft-context-tree-remotes-")));
  mkdirSync(join(home, "config"), { recursive: true });
  process.env.FIRST_TREE_HOME = home;
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  process.env.GIT_CONFIG_COUNT = "1";
  process.env.GIT_CONFIG_KEY_0 = `url.file://${remotes}/.insteadOf`;
  process.env.GIT_CONFIG_VALUE_0 = "https://github.com/";
  writeConfig();
});

afterEach(() => {
  for (const key of ENV_VARS) {
    const previous = originalEnv.get(key);
    if (previous === undefined) delete process.env[key];
    else process.env[key] = previous;
  }
});

describe("resolveContextTreeCli", () => {
  it("resolves the packaged 1.x bin and invokes it through the current Node binary", async () => {
    const { resolveContextTreeCli, inspectContextTreeCli } = await loadModule();
    const invocation = resolveContextTreeCli();
    expect(invocation?.command).toBe(process.execPath);
    // Spawning the .mjs entry directly (rather than a bin shim) is what keeps
    // this working on Windows, where a `.cmd` shim raises EINVAL.
    expect(invocation?.args[0]).toMatch(/[/\\]context-tree[/\\]dist[/\\]cli[/\\]index\.mjs$/);
    expect(inspectContextTreeCli().version).toMatch(/^1\./);
  });
});

describe("runContextTreeCommand", () => {
  it("parses the JSON payload of a successful command", async () => {
    createRemoteTree("acme/run-ok");
    const ws = workspace("run-ok");
    const { runContextTreeCommand } = await loadModule();
    const result = await runContextTreeCommand([
      "connect",
      "acme/run-ok",
      "--ref",
      "trunk",
      "--project-path",
      ws,
      "--json",
    ]);
    expect(result).toMatchObject({ ok: true, payload: { schemaVersion: 3 } });
  });

  it("surfaces the CLI's own structured error code as the reasonCode", async () => {
    const { runContextTreeCommand } = await loadModule();
    const result = await runContextTreeCommand(["read", "--project-path", workspace("unconnected"), "--json"]);
    expect(result).toMatchObject({ ok: false, reasonCode: "NO_CONNECTION" });
  });
});

describe("ensureContextTreeSkills", () => {
  it("is a clean no-op revert when external mode was never on", async () => {
    const ws = workspace("plain");
    mkdirSync(join(ws, ".claude", "skills", "context-tree-read"), { recursive: true });
    const { ensureContextTreeSkills, formatContextTreeSetupReport } = await loadModule();
    const report = await ensureContextTreeSkills();
    expect(report).toMatchObject({ status: "removed", failures: [], removedSkillPaths: [] });
    // Never recorded, so never touched — this might be a Team Skill.
    expect(existsSync(join(ws, ".claude", "skills", "context-tree-read"))).toBe(true);
    expect(formatContextTreeSetupReport(report)).toContain("external mode is off");
  });

  it("installs workspace Skills, connects every workspace, and writes First Tree's own shim", async () => {
    createRemoteTree("acme/context");
    writeConfig({ repository: "acme/context", ref: "trunk" });
    const first = workspace("alpha");
    const second = workspace("beta");
    // A First Tree Core Skill sharing the prefix must survive the install.
    const core = join(first, ".claude", "skills", "context-tree-review");
    mkdirSync(core, { recursive: true });
    writeFileSync(join(core, "SKILL.md"), "managed core skill\n");

    const { ensureContextTreeSkills, formatContextTreeSetupReport } = await loadModule();
    const report = await ensureContextTreeSkills();
    expect(report.failures).toEqual([]);
    expect(report).toMatchObject({ status: "installed", ref: "trunk" });
    expect(report.connectedWorkspaces.sort()).toEqual([first, second].sort());

    for (const ws of [first, second]) {
      for (const root of [join(".claude", "skills"), join(".agents", "skills")]) {
        expect(existsSync(join(ws, root, "context-tree-read", "SKILL.md"))).toBe(true);
        expect(existsSync(join(ws, root, "context-tree-write", "SKILL.md"))).toBe(true);
      }
      expect(declaredTrees(ws)).toEqual([{ kind: "git", repository: "acme/context", path: ".", ref: "trunk" }]);
    }
    expect(readFileSync(join(core, "SKILL.md"), "utf8")).toBe("managed core skill\n");

    const shim = join(home, "data", "context-tree", "bin", "context-tree");
    expect(report.shimPath).toBe(shim);
    expect(readFileSync(shim, "utf8")).toContain("first-tree-managed context-tree shim");
    expect(formatContextTreeSetupReport(report)).toMatch(
      /installed \(context-tree 1\.[^,]+, trunk\); linked 2 workspaces$/,
    );
  });

  it("follows the repository's default branch when no ref is configured", async () => {
    createRemoteTree("acme/default-branch", ["develop"]);
    writeConfig({ repository: "acme/default-branch" });
    const ws = workspace("default-branch");
    const { ensureContextTreeSkills } = await loadModule();
    const report = await ensureContextTreeSkills();
    expect(report).toMatchObject({ status: "installed", ref: "develop", failures: [] });
    expect(declaredTrees(ws)).toEqual([{ kind: "git", repository: "acme/default-branch", path: ".", ref: "develop" }]);
  });

  it("replaces the tree it declared when the configured ref changes", async () => {
    createRemoteTree("acme/moving", ["trunk", "release"]);
    writeConfig({ repository: "acme/moving", ref: "trunk" });
    const ws = workspace("moving");
    const { ensureContextTreeSkills } = await loadModule();
    expect((await ensureContextTreeSkills()).failures).toEqual([]);

    writeConfig({ repository: "acme/moving", ref: "release" });
    const report = await ensureContextTreeSkills();
    expect(report.failures).toEqual([]);
    expect(declaredTrees(ws)).toEqual([{ kind: "git", repository: "acme/moving", path: ".", ref: "release" }]);
  });

  it("reports an unusable ref without touching any workspace", async () => {
    writeConfig({ repository: "acme/context", ref: "bad..ref" });
    const ws = workspace("bad-ref");
    const { ensureContextTreeSkills, formatContextTreeSetupReport } = await loadModule();
    const report = await ensureContextTreeSkills();
    expect(report.status).toBe("failed");
    expect(formatContextTreeSetupReport(report)).toContain("context_tree.ref");
    expect(existsSync(join(ws, ".claude", "skills"))).toBe(false);
  });

  it("reports a per-workspace connect failure and still installs the Skills", async () => {
    writeConfig({ repository: "acme/missing", ref: "trunk" });
    const ws = workspace("missing");
    const { ensureContextTreeSkills, formatContextTreeSetupReport } = await loadModule();
    const report = await ensureContextTreeSkills();
    expect(report.status).toBe("installed");
    expect(report.failures).toHaveLength(1);
    expect(report.failures[0]?.workspace).toBe(ws);
    expect(existsSync(join(ws, ".claude", "skills", "context-tree-read"))).toBe(true);
    expect(formatContextTreeSetupReport(report)).toContain("1 failed");
  });

  it("reverts workspace Skills, declarations, and the shim when the key is unset", async () => {
    createRemoteTree("acme/revert");
    writeConfig({ repository: "acme/revert", ref: "trunk" });
    const ws = workspace("revert");
    const { ensureContextTreeSkills } = await loadModule();
    expect((await ensureContextTreeSkills()).failures).toEqual([]);
    const core = join(ws, ".agents", "skills", "context-tree-audit");
    mkdirSync(core, { recursive: true });

    writeConfig();
    const report = await ensureContextTreeSkills();
    expect(report).toMatchObject({ status: "removed", failures: [] });
    for (const root of [join(".claude", "skills"), join(".agents", "skills")]) {
      expect(existsSync(join(ws, root, "context-tree-read"))).toBe(false);
    }
    expect(existsSync(core)).toBe(true);
    expect(declaredTrees(ws)).toEqual([]);
    expect(existsSync(join(home, "data", "context-tree", "bin"))).toBe(false);
  });

  it("removes its own legacy channel shim and never a user's global context-tree", async () => {
    createRemoteTree("acme/shim");
    writeConfig({ repository: "acme/shim", ref: "trunk" });
    const binDir = scratchBinDir("ft-legacy-shim");
    const legacyShim = join(binDir, "context-tree");
    writeFileSync(legacyShim, "#!/bin/sh\n# first-tree-managed context-tree shim\nexec node old.mjs\n");
    const { ensureContextTreeSkills } = await loadModule();
    await ensureContextTreeSkills();
    expect(existsSync(legacyShim)).toBe(false);

    writeFileSync(legacyShim, "#!/usr/bin/env node\n// a real global install\n");
    await ensureContextTreeSkills();
    expect(readFileSync(legacyShim, "utf8")).toContain("a real global install");
  });

  it("preserves and reports account-level Skills it cannot prove are its unedited 0.1 copies", async () => {
    createRemoteTree("acme/legacy");
    writeConfig({ repository: "acme/legacy", ref: "trunk" });
    const owned = join(home, ".claude", "skills", "context-tree-setup");
    const unowned = join(home, ".codex", "skills", "context-tree-read");
    const unrelated = join(home, ".claude", "skills", "context-tree-mine");
    for (const dir of [owned, unowned, unrelated]) {
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "SKILL.md"), "edited\n");
    }
    mkdirSync(join(home, "data"), { recursive: true });
    writeFileSync(
      join(home, "data", "context-tree-owned-skills.json"),
      JSON.stringify({ schemaVersion: 1, paths: [owned] }),
    );

    const { ensureContextTreeSkills, formatContextTreeSetupReport } = await loadModule();
    const report = await ensureContextTreeSkills();
    expect(report.removedSkillPaths).toEqual([]);
    expect(report.preservedSkillPaths?.sort()).toEqual([owned, unowned].sort());
    for (const dir of [owned, unowned, unrelated]) expect(existsSync(dir)).toBe(true);
    // Provenance survives while anything it covers is still in place.
    expect(existsSync(join(home, "data", "context-tree-owned-skills.json"))).toBe(true);
    expect(formatContextTreeSetupReport(report)).toContain("left 2 hand-installed or edited account-level Skills");
  });
});

describe("skillTreeDigest", () => {
  it("is stable across copies and changes with any byte", async () => {
    const { skillTreeDigest } = await loadModule();
    const make = (body: string) => {
      const dir = mkdtempSync(join(tmpdir(), "ft-skill-digest-"));
      mkdirSync(join(dir, "references"));
      writeFileSync(join(dir, "SKILL.md"), body);
      writeFileSync(join(dir, "references", "a.md"), "a\n");
      return dir;
    };
    expect(skillTreeDigest(make("x\n"))).toBe(skillTreeDigest(make("x\n")));
    expect(skillTreeDigest(make("x\n"))).not.toBe(skillTreeDigest(make("y\n")));
    expect(skillTreeDigest(join(tmpdir(), "does-not-exist"))).toBeNull();
  });
});
