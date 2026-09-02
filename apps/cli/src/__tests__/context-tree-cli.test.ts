import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

const HOME_VARS = ["FIRST_TREE_HOME", "HOME", "USERPROFILE"] as const;
const originalEnv = new Map<string, string | undefined>();

beforeEach(() => {
  for (const key of HOME_VARS) {
    originalEnv.set(key, process.env[key]);
    delete process.env[key];
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
    expect(invocation?.args[0]).toMatch(/@first-tree-ai[/\\]context-tree[/\\]dist[/\\]cli[/\\]index\.mjs$/);
  });
});

describe("runContextTreeCommand", () => {
  it("parses the JSON payload of a successful command", async () => {
    const { runContextTreeCommand } = await loadModule();
    const result = await runContextTreeCommand(["list"]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.payload).toMatchObject({ schemaVersion: 1 });
  });

  it("surfaces the CLI's own structured error code as the reasonCode", async () => {
    const { runContextTreeCommand } = await loadModule();
    // A directory with no connection record: the CLI exits non-zero and prints
    // {ok:false,error:{code:"NO_CONNECTION",...}} on stdout.
    const project = mkdtempSync(join(tmpdir(), "ft-context-tree-unconnected-"));
    const result = await runContextTreeCommand(["resolve", "--project-path", project]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reasonCode).toBe("NO_CONNECTION");
  });
});

describe("ensureContextTreeSkills", () => {
  it("skips entirely when external mode is off, installing nothing", async () => {
    const home = scratchHome();
    const { ensureContextTreeSkills, formatContextTreeSetupReport } = await loadModule();
    const report = await ensureContextTreeSkills();
    // This skip is what guarantees the two Skill families are never both live:
    // an unconfigured machine keeps First Tree's own Context Tree Skills.
    expect(report.status).toBe("skipped");
    expect(report.reason).toContain("context_tree.repository");
    expect(report.installedHosts).toEqual([]);
    expect(report.connectedWorkspaces).toEqual([]);
    expect(formatContextTreeSetupReport(report)).toContain("skipped");
    expect(existsSync(join(home, ".claude", "skills"))).toBe(false);
  });

  it("installs Skills into the scratch home and connects only workspaces that already exist", async () => {
    const home = scratchHome("acme/context");
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
    // Every outcome is attributed to the one existing workspace, and nothing
    // else was invented alongside it.
    expect(report.connectedWorkspaces.length + report.failures.length).toBe(1);
    for (const failure of report.failures) {
      expect(failure.workspace).toBe(join(workspaces, "alpha"));
    }
  });
});
