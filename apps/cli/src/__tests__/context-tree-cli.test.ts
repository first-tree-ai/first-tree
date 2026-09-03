import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { setCliBinding } from "@first-tree/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

/**
 * Two independent homes are in play and both must be redirected.
 *
 * `FIRST_TREE_HOME` is where `resolveConfigReadonly` finds `client.yaml`, so it
 * decides whether external mode is on. The external CLI, however, resolves its
 * own Skill host directories and `~/.context-tree` state from `os.homedir()`
 * (`context-tree/src/core/install.ts`), which honours `HOME` / `USERPROFILE`.
 * The child process inherits `process.env`, so overriding those here is what
 * keeps `context-tree install` out of the developer's real `~/.claude/skills`.
 */
function scratchHome(repository?: string): string {
  const home = mkdtempSync(join(tmpdir(), "ft-context-tree-cli-"));
  const configDir = join(home, "config");
  mkdirSync(configDir, { recursive: true });
  writeFileSync(
    join(configDir, "client.yaml"),
    repository === undefined
      ? "server:\n  url: http://localhost:8000\n"
      : `server:\n  url: http://localhost:8000\ncontext_tree:\n  repository: ${repository}\n`,
    "utf8",
  );
  process.env.FIRST_TREE_HOME = home;
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  return home;
}

async function loadModule() {
  // Fresh module per test: config resolution caches nothing here, but the import
  // must observe the FIRST_TREE_HOME set by the current test.
  return import("../core/context-tree-cli.js");
}

/**
 * A scratch bin directory holding a fake channel CLI, placed on `PATH`.
 *
 * `writeContextTreeShim` writes beside whatever `getCliBinding().binName`
 * resolves to on `PATH`. Pointing that at a temp dir is what stops the shim
 * being written into the developer's real npm global bin.
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

const HOME_VARS = ["FIRST_TREE_HOME", "HOME", "USERPROFILE", "PATH"] as const;
const originalEnv = new Map<string, string | undefined>();

beforeEach(() => {
  for (const key of HOME_VARS) {
    originalEnv.set(key, process.env[key]);
    if (key !== "PATH") delete process.env[key];
  }
  // Nothing below should ever reach the real home, so default every test to an
  // empty scratch one and let those that need config overwrite it.
  scratchHome();
});

afterEach(() => {
  for (const key of HOME_VARS) {
    const previous = originalEnv.get(key);
    if (previous === undefined) delete process.env[key];
    else process.env[key] = previous;
  }
});

describe("resolveContextTreeCli", () => {
  it("resolves the packaged bin and invokes it through the current Node binary", async () => {
    const { resolveContextTreeCli } = await loadModule();
    const invocation = resolveContextTreeCli();
    expect(invocation).not.toBeNull();
    expect(invocation?.command).toBe(process.execPath);
    // Spawning the .mjs entry directly (rather than the bin shim) is what keeps
    // this working on Windows, where a `.cmd` shim raises EINVAL.
    expect(invocation?.args[0]).toMatch(/[/\\]context-tree[/\\]dist[/\\]cli[/\\]index\.mjs$/);
  });
});

describe("runContextTreeCommand", () => {
  it("parses the JSON payload of a successful command", async () => {
    const { runContextTreeCommand } = await loadModule();
    const result = await runContextTreeCommand(["list", "--json"]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.payload).toMatchObject({ schemaVersion: 1 });
  });

  it("rejects text output when a text-default command omits --json", async () => {
    const { runContextTreeCommand } = await loadModule();
    const result = await runContextTreeCommand(["list"]);
    expect(result).toMatchObject({ ok: false, reasonCode: "context_tree_bad_payload" });
  });

  it("surfaces the CLI's own structured error code as the reasonCode", async () => {
    const { runContextTreeCommand } = await loadModule();
    // A directory with no connection record: the CLI exits non-zero and prints
    // {ok:false,error:{code:"NO_CONNECTION",...}} on stdout.
    const project = mkdtempSync(join(tmpdir(), "ft-context-tree-unconnected-"));
    const result = await runContextTreeCommand(["resolve", "--project-path", project, "--json"]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reasonCode).toBe("NO_CONNECTION");
  });
});

describe("ensureContextTreeSkills", () => {
  it("inspects cleanup when external mode is off, installing nothing", async () => {
    const home = scratchHome();
    const { ensureContextTreeSkills, formatContextTreeSetupReport } = await loadModule();
    const report = await ensureContextTreeSkills();
    // Cleanup is what guarantees the two Skill families are never both live:
    // an unconfigured machine keeps First Tree's own Context Tree Skills.
    expect(report.status).toBe("removed");
    expect(report.reason).toContain("context_tree.repository");
    expect(report.installedHosts).toEqual([]);
    expect(report.connectedWorkspaces).toEqual([]);
    expect(formatContextTreeSetupReport(report)).toContain("removed");
    expect(existsSync(join(home, ".claude", "skills"))).toBe(false);
  });

  it("installs Skills into the scratch home and connects only workspaces that already exist", async () => {
    const home = scratchHome("acme/context");
    const binDir = scratchBinDir("first-tree-test");
    // A host config dir must exist for a home install to target it.
    mkdirSync(join(home, ".claude"), { recursive: true });
    // One existing agent home, so connect has exactly one candidate. The repo is
    // unreachable from a test, so the connect is expected to fail — what matters
    // is that install succeeded and no workspace was fabricated.
    const workspaces = join(home, "data", "workspaces");
    mkdirSync(join(workspaces, "alpha"), { recursive: true });

    const { ensureContextTreeSkills } = await loadModule();
    const report = await ensureContextTreeSkills();

    expect(report.status).toBe("installed");
    expect(report.installedHosts).toContain("claude");
    // Isolation guard: the Skills landed under the scratch home, which is the
    // only reason this test is safe to run on a developer machine.
    expect(existsSync(join(home, ".claude", "skills", "context-tree-read"))).toBe(true);
    // The shim is what makes the installed Skills runnable at all: every one of
    // them invokes `context-tree` by name, which npm never puts on PATH for a
    // transitive dependency.
    expect(report.shimPath).toBe(join(binDir, "context-tree"));
    expect(readFileSync(join(binDir, "context-tree"), "utf8")).toContain("index.mjs");
    // The one existing workspace accounts for every non-shim outcome, and
    // nothing else was invented alongside it.
    const connectFailures = report.failures.filter((failure) => failure.workspace !== "context-tree shim");
    expect(report.connectedWorkspaces.length + connectFailures.length).toBe(1);
    for (const failure of connectFailures) {
      expect(failure.workspace).toBe(join(workspaces, "alpha"));
    }
  });

  it("leaves a context-tree the user installed globally in place", async () => {
    const home = scratchHome("acme/context");
    const binDir = scratchBinDir("first-tree-test");
    mkdirSync(join(home, ".claude"), { recursive: true });
    // A real `npm i -g @first-tree-ai/context-tree` puts its own bin in exactly
    // this directory, and it already satisfies the Skills. Overwriting it would
    // replace a binary this CLI does not own.
    const theirs = "#!/bin/sh\n# installed by npm, not first-tree\nexit 0\n";
    writeFileSync(join(binDir, "context-tree"), theirs, "utf8");

    const { ensureContextTreeSkills } = await loadModule();
    const report = await ensureContextTreeSkills();

    expect(report.status).toBe("installed");
    expect(readFileSync(join(binDir, "context-tree"), "utf8")).toBe(theirs);

    // And the revert path must not delete it either, so it was never recorded.
    writeFileSync(join(home, "config", "client.yaml"), "server:\n  url: http://localhost:8000\n", "utf8");
    expect((await ensureContextTreeSkills()).status).toBe("removed");
    expect(existsSync(join(binDir, "context-tree"))).toBe(true);
  });

  it("reports a shim it cannot write instead of failing the login", async () => {
    const home = scratchHome("acme/context");
    mkdirSync(join(home, ".claude"), { recursive: true });
    // No channel CLI anywhere on PATH, so the bin directory cannot be located.
    setCliBinding({ binName: "first-tree-absent", packageName: null });
    process.env.PATH = mkdtempSync(join(tmpdir(), "ft-empty-bin-"));

    const { ensureContextTreeSkills, formatContextTreeSetupReport } = await loadModule();
    const report = await ensureContextTreeSkills();

    // Degraded, not fatal: `login` must still succeed.
    expect(report.status).toBe("installed");
    expect(report.shimPath).toBeNull();
    const shimFailure = report.failures.find((failure) => failure.workspace === "context-tree shim");
    expect(shimFailure?.reason).toContain("bin directory");
    expect(formatContextTreeSetupReport(report)).toContain("failed");
  });
});

describe("ensureContextTreeSkills switched back off", () => {
  it("removes every context-tree-* Skill and preserves foreign Skills", async () => {
    const home = scratchHome("acme/context");
    const binDir = scratchBinDir("first-tree-test");
    const skillsRoot = join(home, ".claude", "skills");
    mkdirSync(join(home, ".claude"), { recursive: true });

    const { ensureContextTreeSkills } = await loadModule();
    expect((await ensureContextTreeSkills()).status).toBe("installed");
    expect(existsSync(join(skillsRoot, "context-tree-read"))).toBe(true);

    const ownedByPrefix = join(skillsRoot, "context-tree-mine");
    mkdirSync(ownedByPrefix, { recursive: true });
    const foreign = join(skillsRoot, "mine");
    mkdirSync(foreign, { recursive: true });
    writeFileSync(join(foreign, "SKILL.md"), "# mine\n", "utf8");
    const legacyLedger = join(home, "data", "context-tree-install.json");
    mkdirSync(join(home, "data"), { recursive: true });
    writeFileSync(legacyLedger, "{}\n", "utf8");

    // Now unset the key, keeping the same home and installed Skills.
    writeFileSync(join(home, "config", "client.yaml"), "server:\n  url: http://localhost:8000\n", "utf8");
    const report = await ensureContextTreeSkills();

    expect(report.status).toBe("removed");
    expect(existsSync(join(skillsRoot, "context-tree-read"))).toBe(false);
    expect(existsSync(ownedByPrefix)).toBe(false);
    expect(existsSync(foreign)).toBe(true);
    expect(existsSync(join(binDir, "context-tree"))).toBe(false);
    expect(existsSync(legacyLedger)).toBe(false);
  });

  it("removes Skills left by a dependency postinstall with no ledger", async () => {
    const home = scratchHome();
    const orphan = join(home, ".claude", "skills", "context-tree-read");
    mkdirSync(orphan, { recursive: true });
    const reportedOrphan = join(realpathSync(home), ".claude", "skills", "context-tree-read");

    const { ensureContextTreeSkills } = await loadModule();
    const report = await ensureContextTreeSkills();

    expect(report.status).toBe("removed");
    expect(report.removedSkillPaths).toContain(reportedOrphan);
    expect(existsSync(orphan)).toBe(false);
  });

  it("leaves connections and managed trees alone", async () => {
    const home = scratchHome();
    const connections = join(home, ".context-tree", "connections.json");
    const tree = join(home, ".context-tree", "trees", "mine");
    mkdirSync(tree, { recursive: true });
    writeFileSync(connections, "[]\n", "utf8");
    mkdirSync(join(home, ".claude", "skills", "context-tree-read"), { recursive: true });

    const { ensureContextTreeSkills } = await loadModule();
    await ensureContextTreeSkills();

    expect(readFileSync(connections, "utf8")).toBe("[]\n");
    expect(existsSync(tree)).toBe(true);
  });

  it("reports removed with an empty list when installed hosts are already clean", async () => {
    const home = scratchHome();
    mkdirSync(join(home, ".claude", "skills"), { recursive: true });

    const { ensureContextTreeSkills } = await loadModule();
    const report = await ensureContextTreeSkills();

    expect(report.status).toBe("removed");
    expect(report.removedSkillPaths).toEqual([]);
  });

  it("reports a set-but-unusable repository while keeping external mode off", async () => {
    const home = scratchHome("owner/.hidden");
    const orphan = join(home, ".claude", "skills", "context-tree-read");
    mkdirSync(orphan, { recursive: true });

    const { ensureContextTreeSkills } = await loadModule();
    const report = await ensureContextTreeSkills();

    expect(report.status).toBe("failed");
    expect(report.reason).toContain("owner/.hidden");
    expect(report.reason).toContain("external mode is off");
    expect(existsSync(orphan)).toBe(false);
  });
});
