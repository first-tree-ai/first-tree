import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CORE_SKILL_NAMES } from "../runtime/first-tree-skills/installer.js";
import {
  authoritativeTeamSkillSnapshot,
  ManagedSkillsUnsafeDiscoveryError,
  providerSkillRoot,
  reconcileManagedSkills,
} from "../runtime/managed-skills.js";
import { AGENT_RUNTIME_STATE_DIRNAME, SOURCE_STATE_FILENAME } from "../runtime/workspace-manifest.js";

const TEST_PROVIDER_SKILL_ROOTS = Object.freeze({
  amp: ".agents/skills",
  "deepseek-harness": ".agents/skills",
  "claude-code": ".claude/skills",
  "claude-code-tui": ".claude/skills",
  codex: ".agents/skills",
  cursor: ".cursor/skills",
  grok: ".grok/skills",
  antigravity: ".agents/skills",
  "kimi-code": ".kimi-code/skills",
  opencode: ".opencode/skills",
  pi: ".agents/skills",
});

function writeCoreBundle(parent: string): string {
  const root = join(parent, "bundled");
  for (const name of CORE_SKILL_NAMES) {
    const skillRoot = join(root, name);
    mkdirSync(join(skillRoot, "references"), { recursive: true });
    writeFileSync(
      join(skillRoot, "SKILL.md"),
      ["---", `name: ${name}`, `description: Public ${name}.`, "---", "", `# ${name}`, ""].join("\n"),
    );
    writeFileSync(join(skillRoot, "VERSION"), "1.0.0\n");
  }
  return root;
}

function plantRemoteLatch(workspace: string): void {
  mkdirSync(join(workspace, AGENT_RUNTIME_STATE_DIRNAME), { recursive: true });
  writeFileSync(
    join(workspace, AGENT_RUNTIME_STATE_DIRNAME, SOURCE_STATE_FILENAME),
    `${JSON.stringify({
      schemaVersion: 1,
      remoteObserved: true,
      observedAt: "2026-08-13T00:00:00.000Z",
      repoUrl: "git@github.com:acme/tree.git",
      branch: "main",
    })}\n`,
  );
}

function writeLocalVariants(bundledRoot: string): void {
  for (const name of ["first-tree-read", "first-tree-write"] as const) {
    const skillRoot = join(bundledRoot, ".variants", "local-context", name);
    mkdirSync(skillRoot, { recursive: true });
    writeFileSync(
      join(skillRoot, "SKILL.md"),
      ["---", `name: ${name}`, `description: Public ${name}.`, "---", "", `# ${name} local`, ""].join("\n"),
    );
    writeFileSync(join(skillRoot, "VERSION"), "1.0.0\n");
  }
}

describe("managed Local Context Skill variants", () => {
  let sandbox: string;
  let workspace: string;
  let bundledSkillsRoot: string;

  beforeEach(() => {
    sandbox = mkdtempSync(join(realpathSync(tmpdir()), "ft-managed-local-"));
    workspace = join(sandbox, "workspace");
    mkdirSync(workspace, { recursive: true });
    bundledSkillsRoot = writeCoreBundle(sandbox);
  });

  afterEach(() => {
    rmSync(sandbox, { recursive: true, force: true });
  });

  it("replaces Read/Write payloads in place while keeping public name, key, and target", async () => {
    writeLocalVariants(bundledSkillsRoot);
    const remote = await reconcileManagedSkills({
      workspace,
      provider: "codex",
      providerSkillRoots: TEST_PROVIDER_SKILL_ROOTS,
      teamSnapshot: authoritativeTeamSkillSnapshot(1, []),
      bundledSkillsRoot,
      contextSourceKind: "remote",
    });
    expect(remote.ok).toBe(true);

    const local = await reconcileManagedSkills({
      workspace,
      provider: "codex",
      providerSkillRoots: TEST_PROVIDER_SKILL_ROOTS,
      teamSnapshot: authoritativeTeamSkillSnapshot(1, []),
      bundledSkillsRoot,
      contextSourceKind: "local",
    });
    expect(local.ok).toBe(true);

    const readRoot = join(workspace, providerSkillRoot("codex", TEST_PROVIDER_SKILL_ROOTS), "first-tree-read");
    const writeRoot = join(workspace, providerSkillRoot("codex", TEST_PROVIDER_SKILL_ROOTS), "first-tree-write");
    expect(readFileSync(join(readRoot, "SKILL.md"), "utf8")).toContain("# first-tree-read local");
    expect(readFileSync(join(writeRoot, "SKILL.md"), "utf8")).toContain("# first-tree-write local");
    expect(JSON.parse(readFileSync(join(readRoot, ".first-tree-managed.json"), "utf8"))).toMatchObject({
      key: "core:first-tree-read",
      revision: "local-context:1.0.0",
    });
    expect(JSON.parse(readFileSync(join(writeRoot, ".first-tree-managed.json"), "utf8"))).toMatchObject({
      key: "core:first-tree-write",
      revision: "local-context:1.0.0",
    });

    const restored = await reconcileManagedSkills({
      workspace,
      provider: "codex",
      providerSkillRoots: TEST_PROVIDER_SKILL_ROOTS,
      teamSnapshot: authoritativeTeamSkillSnapshot(1, []),
      bundledSkillsRoot,
      contextSourceKind: "remote",
    });
    expect(restored.ok).toBe(true);
    expect(readFileSync(join(readRoot, "SKILL.md"), "utf8")).toContain("# first-tree-read\n");
    expect(JSON.parse(readFileSync(join(readRoot, ".first-tree-managed.json"), "utf8"))).toMatchObject({
      revision: "1.0.0",
    });
  });

  it("blocks Local admission when the private variant payload is missing", async () => {
    await expect(
      reconcileManagedSkills({
        workspace,
        provider: "codex",
        providerSkillRoots: TEST_PROVIDER_SKILL_ROOTS,
        teamSnapshot: authoritativeTeamSkillSnapshot(1, []),
        bundledSkillsRoot,
        contextSourceKind: "local",
      }),
    ).rejects.toBeInstanceOf(ManagedSkillsUnsafeDiscoveryError);
  });

  it("refuses Local variant publication after a remote latch is on disk", async () => {
    writeLocalVariants(bundledSkillsRoot);
    const remote = await reconcileManagedSkills({
      workspace,
      provider: "codex",
      providerSkillRoots: TEST_PROVIDER_SKILL_ROOTS,
      teamSnapshot: authoritativeTeamSkillSnapshot(1, []),
      bundledSkillsRoot,
      contextSourceKind: "remote",
    });
    expect(remote.ok).toBe(true);
    plantRemoteLatch(workspace);

    await expect(
      reconcileManagedSkills({
        workspace,
        provider: "codex",
        providerSkillRoots: TEST_PROVIDER_SKILL_ROOTS,
        teamSnapshot: authoritativeTeamSkillSnapshot(1, []),
        bundledSkillsRoot,
        contextSourceKind: "local",
      }),
    ).rejects.toBeInstanceOf(ManagedSkillsUnsafeDiscoveryError);

    const readRoot = join(workspace, providerSkillRoot("codex", TEST_PROVIDER_SKILL_ROOTS), "first-tree-read");
    expect(readFileSync(join(readRoot, "SKILL.md"), "utf8")).toContain("# first-tree-read\n");
    expect(JSON.parse(readFileSync(join(readRoot, ".first-tree-managed.json"), "utf8"))).toMatchObject({
      revision: "1.0.0",
    });
  });

  it("keeps projected Remote Skills when a stale Local reconcile races after the latch", async () => {
    writeLocalVariants(bundledSkillsRoot);
    await reconcileManagedSkills({
      workspace,
      provider: "codex",
      providerSkillRoots: TEST_PROVIDER_SKILL_ROOTS,
      teamSnapshot: authoritativeTeamSkillSnapshot(1, []),
      bundledSkillsRoot,
      contextSourceKind: "remote",
    });
    plantRemoteLatch(workspace);

    const [localResult, remoteResult] = await Promise.allSettled([
      reconcileManagedSkills({
        workspace,
        provider: "codex",
        providerSkillRoots: TEST_PROVIDER_SKILL_ROOTS,
        teamSnapshot: authoritativeTeamSkillSnapshot(1, []),
        bundledSkillsRoot,
        contextSourceKind: "local",
      }),
      reconcileManagedSkills({
        workspace,
        provider: "codex",
        providerSkillRoots: TEST_PROVIDER_SKILL_ROOTS,
        teamSnapshot: authoritativeTeamSkillSnapshot(1, []),
        bundledSkillsRoot,
        contextSourceKind: "remote",
      }),
    ]);

    expect(localResult.status).toBe("rejected");
    if (localResult.status === "rejected") {
      expect(localResult.reason).toBeInstanceOf(ManagedSkillsUnsafeDiscoveryError);
    }
    expect(remoteResult.status).toBe("fulfilled");
    const readRoot = join(workspace, providerSkillRoot("codex", TEST_PROVIDER_SKILL_ROOTS), "first-tree-read");
    expect(readFileSync(join(readRoot, "SKILL.md"), "utf8")).toContain("# first-tree-read\n");
    expect(JSON.parse(readFileSync(join(readRoot, ".first-tree-managed.json"), "utf8"))).toMatchObject({
      revision: "1.0.0",
    });
  });
});
