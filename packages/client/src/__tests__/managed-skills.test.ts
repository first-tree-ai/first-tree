import { execFileSync } from "node:child_process";
import {
  chmodSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  foldPortableTeamSkillPath,
  type RuntimeProvider,
  type RuntimeResourceSkill,
  type RuntimeSkillBundle,
} from "@first-tree/shared";
import { strToU8, type ZipOptions, zipSync } from "fflate";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CORE_SKILL_NAMES } from "../runtime/first-tree-skills/installer.js";
import {
  authoritativeTeamSkillSnapshot,
  hasUnsafeManagedWriteMode,
  type ManagedSkillsCheckpoint,
  ManagedSkillsUnsafeDiscoveryError,
  providerSkillRoot,
  reconcileManagedSkills,
} from "../runtime/managed-skills.js";
import {
  MANAGED_SKILLS_JOURNAL_REL,
  MANAGED_SKILLS_LOCK_REL,
  MANAGED_STATE_REL,
  readManagedState,
  readManagedStateResult,
} from "../runtime/managed-state.js";
import { spawnWorkspaceLockWorker } from "./workspace-file-lock-worker.js";

/** Local fail-closed skill-root fixture — runtime tests must not import providers. */
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
  zcode: ".zcode/skills",
});

const PROVIDERS: readonly RuntimeProvider[] = [
  "amp",
  "deepseek-harness",
  "claude-code",
  "claude-code-tui",
  "codex",
  "cursor",
  "grok",
  "antigravity",
  "kimi-code",
  "opencode",
  "pi",
];

function teamSkill(overrides: Partial<RuntimeResourceSkill> = {}): RuntimeResourceSkill {
  return {
    resourceId: "resource-review",
    name: "Review",
    description: "Review correctness before style.",
    body: "# Review\n\nCheck correctness first.",
    metadata: { owner: "platform" },
    ...overrides,
  };
}

const BUNDLE_ID_A = "11111111-1111-4111-8111-111111111111";
const BUNDLE_ID_B = "22222222-2222-4222-8222-222222222222";

type TestZipEntry = Uint8Array | [Uint8Array, ZipOptions];

function makeSkillZip(
  entries: Record<string, TestZipEntry> = {},
  options: Readonly<{ wrapper?: string; name?: string }> = {},
): Buffer {
  const prefix = options.wrapper ? `${options.wrapper}/` : "";
  return Buffer.from(
    zipSync(
      {
        [`${prefix}SKILL.md`]: strToU8(
          [
            "---",
            `name: ${options.name ?? "review"}`,
            "description: Bundle review instructions.",
            "metadata:",
            "  owner: platform",
            "  retained: true",
            "---",
            "",
            "# Bundle review",
            "",
            "Keep this body byte-for-byte when only the name changes.",
            "",
          ].join("\n"),
        ),
        ...Object.fromEntries(Object.entries(entries).map(([path, value]) => [`${prefix}${path}`, value])),
      },
      { level: 6 },
    ),
  );
}

function bundleSkill(
  bytes: Buffer,
  overrides: Partial<RuntimeResourceSkill> = {},
  attachmentId = BUNDLE_ID_A,
): RuntimeResourceSkill {
  return teamSkill({
    name: "review",
    body: "INLINE FALLBACK MUST NEVER BE MATERIALIZED",
    bundle: {
      attachmentId,
      format: "zip",
      sizeBytes: bytes.byteLength,
    },
    ...overrides,
  });
}

function zipWithEncryptedFlag(bytes: Buffer): Buffer {
  const patched = Buffer.from(bytes);
  for (let offset = 0; offset <= patched.byteLength - 10; offset++) {
    const signature = patched.readUInt32LE(offset);
    if (signature === 0x04034b50) {
      patched.writeUInt16LE(patched.readUInt16LE(offset + 6) | 0x1, offset + 6);
    } else if (signature === 0x02014b50) {
      patched.writeUInt16LE(patched.readUInt16LE(offset + 8) | 0x1, offset + 8);
    }
  }
  return patched;
}

function writeCoreBundle(parent: string, version = "1.0.0", label = version): string {
  const root = join(parent, `bundled-${label.replace(/[^a-z0-9-]/giu, "-")}`);
  for (const name of CORE_SKILL_NAMES) {
    const skillRoot = join(root, name);
    mkdirSync(join(skillRoot, "references"), { recursive: true });
    writeFileSync(
      join(skillRoot, "SKILL.md"),
      ["---", `name: ${name}`, `description: Fixture ${label} for ${name}.`, "---", "", `# ${name}`, ""].join("\n"),
    );
    writeFileSync(join(skillRoot, "VERSION"), `${version}\n`);
    writeFileSync(join(skillRoot, "references", "guide.md"), `supporting ${label} for ${name}\n`);
  }
  return root;
}

function target(workspace: string, provider: RuntimeProvider, name: string): string {
  return join(workspace, providerSkillRoot(provider, TEST_PROVIDER_SKILL_ROOTS), name);
}

function writeLegacyState(workspace: string, skills: readonly string[]): void {
  mkdirSync(join(workspace, ".first-tree-workspace"), { recursive: true });
  writeFileSync(
    join(workspace, MANAGED_STATE_REL),
    JSON.stringify({
      schemaVersion: 1,
      cliVersion: "0.1.0",
      updatedAt: new Date(0).toISOString(),
      skills,
    }),
  );
}

describe("managed Skill reconciler", () => {
  let sandbox: string;
  let workspace: string;
  let bundledSkillsRoot: string;

  beforeEach(() => {
    sandbox = mkdtempSync(join(tmpdir(), "ft-managed-skills-"));
    workspace = join(sandbox, "workspace");
    mkdirSync(workspace, { recursive: true });
    bundledSkillsRoot = writeCoreBundle(sandbox);
  });

  afterEach(() => {
    rmSync(sandbox, { recursive: true, force: true });
  });

  it("maps every runtime to its provider-native discovery root", () => {
    expect(PROVIDERS.map((provider) => [provider, providerSkillRoot(provider, TEST_PROVIDER_SKILL_ROOTS)])).toEqual([
      ["amp", ".agents/skills"],
      ["deepseek-harness", ".agents/skills"],
      ["claude-code", ".claude/skills"],
      ["claude-code-tui", ".claude/skills"],
      ["codex", ".agents/skills"],
      ["cursor", ".cursor/skills"],
      ["grok", ".grok/skills"],
      ["antigravity", ".agents/skills"],
      ["kimi-code", ".kimi-code/skills"],
      ["opencode", ".opencode/skills"],
      ["pi", ".agents/skills"],
    ]);
  });

  it("enforces unsafe write-bit drift only on platforms with reliable POSIX modes", () => {
    expect(hasUnsafeManagedWriteMode(0o666, "darwin")).toBe(true);
    expect(hasUnsafeManagedWriteMode(0o666, "linux")).toBe(true);
    expect(hasUnsafeManagedWriteMode(0o666, "win32")).toBe(false);
  });

  it("keeps every provider reconcile call on the unsafe-discovery throwing contract", () => {
    const handlerSources = [
      "src/providers/claude/index.ts",
      "src/providers/claude/tui/index.ts",
      "src/providers/codex/sdk.ts",
      "src/providers/codex/app-server/index.ts",
      "src/providers/cursor/index.ts",
      "src/providers/kimi-code/index.ts",
      "src/providers/opencode/index.ts",
      "src/providers/pi/index.ts",
      "src/providers/amp/index.ts",
      "src/providers/deepseek-harness/index.ts",
    ].map((path) => readFileSync(join(process.cwd(), path), "utf-8"));
    // Normal start/resume and hot-switch publication own reconcile inside
    // projectManagedWorkspace under the source-publication lock.
    const directReconcileCalls = handlerSources.reduce(
      (count, source) => count + (source.match(/reconcileManagedSkillsForConfig\(/g)?.length ?? 0),
      0,
    );
    expect(directReconcileCalls).toBe(0);
    expect(handlerSources.every((source) => source.includes("prepareManagedSession("))).toBe(true);
    expect(handlerSources.every((source) => !source.includes("reconcileManagedSkills({"))).toBe(true);
    const preparation = readFileSync(join(process.cwd(), "src/runtime/provider-support/preparation.ts"), "utf-8");
    expect(preparation).toContain("reconcileManagedSkillsForConfig(");
    expect(preparation).toContain("teamSkillBundleResolverFromSdk(sessionCtx.sdk)");
    for (const source of [handlerSources[2] ?? "", handlerSources[3] ?? "", handlerSources[4] ?? ""]) {
      expect(source).toContain("if (isManagedSkillsUnsafeDiscoveryError(err)) throw err;");
    }
    expect(handlerSources[0]).toContain('failFatalSessionForRecovery(sessionCtx, "claude_config_restart_failed")');
    expect(handlerSources[3]).toContain('retryBatch(batch, "codex_managed_skills_unsafe")');
    expect(handlerSources[6]).toContain('token.retry(messages, "opencode_managed_skills_unsafe")');
    expect(handlerSources[6]).toContain("if (isManagedSkillsUnsafeDiscoveryError(error))");
    expect(handlerSources[8]).toContain('token.retry(messages, "amp_unsafe_skill_discovery")');
    expect(handlerSources[8]).toContain("if (isManagedSkillsUnsafeDiscoveryError(error))");
    expect(handlerSources[9]).toContain('token.retry(messages, "deepseek_unsafe_skill_discovery")');
    expect(handlerSources[9]).toContain("if (isManagedSkillsUnsafeDiscoveryError(error))");
  });

  it.each(PROVIDERS)("projects Core Skills only into the active %s discovery root", async (provider) => {
    const result = await reconcileManagedSkills({
      workspace,
      providerSkillRoots: TEST_PROVIDER_SKILL_ROOTS,
      provider,
      teamSnapshot: authoritativeTeamSkillSnapshot(1, []),
      bundledSkillsRoot,
    });

    expect(result.ok, JSON.stringify(result.failures)).toBe(true);
    expect(result.installed).toHaveLength(CORE_SKILL_NAMES.length);
    for (const name of CORE_SKILL_NAMES) {
      const installedRoot = target(workspace, provider, name);
      expect(readFileSync(join(installedRoot, "VERSION"), "utf-8")).toBe("1.0.0\n");
      expect(readFileSync(join(installedRoot, "references", "guide.md"), "utf-8")).toContain(
        `supporting 1.0.0 for ${name}`,
      );
      expect(JSON.parse(readFileSync(join(installedRoot, ".first-tree-managed.json"), "utf-8"))).toMatchObject({
        schemaVersion: 1,
        key: `core:${name}`,
        revision: "1.0.0",
      });
    }

    for (const otherProvider of PROVIDERS) {
      if (
        providerSkillRoot(otherProvider, TEST_PROVIDER_SKILL_ROOTS) ===
        providerSkillRoot(provider, TEST_PROVIDER_SKILL_ROOTS)
      )
        continue;
      expect(existsSync(target(workspace, otherProvider, CORE_SKILL_NAMES[0]))).toBe(false);
    }
  });

  it("hashes the final tree and repairs supporting-file drift even when VERSION is unchanged", async () => {
    await reconcileManagedSkills({
      workspace,
      provider: "codex",
      providerSkillRoots: TEST_PROVIDER_SKILL_ROOTS,
      teamSnapshot: authoritativeTeamSkillSnapshot(1, []),
      bundledSkillsRoot,
    });
    const drifted = target(workspace, "codex", "first-tree-read");
    writeFileSync(join(drifted, "references", "guide.md"), "user drift\n");

    const result = await reconcileManagedSkills({
      workspace,
      provider: "codex",
      providerSkillRoots: TEST_PROVIDER_SKILL_ROOTS,
      teamSnapshot: authoritativeTeamSkillSnapshot(1, []),
      bundledSkillsRoot,
    });

    expect(result.installed).toContain("core:first-tree-read");
    expect(readFileSync(join(drifted, "references", "guide.md"), "utf-8")).toContain(
      "supporting 1.0.0 for first-tree-read",
    );
    expect(result.skipped).toContain("core:first-tree-write");
  });

  it("installs, updates, preserves, and revokes Team Skills only from authoritative snapshots", async () => {
    const v10 = teamSkill();
    const installed = await reconcileManagedSkills({
      workspace,
      provider: "codex",
      providerSkillRoots: TEST_PROVIDER_SKILL_ROOTS,
      teamSnapshot: authoritativeTeamSkillSnapshot(10, [v10]),
      bundledSkillsRoot,
    });
    expect(installed.ok, JSON.stringify(installed.failures)).toBe(true);
    expect(installed.teamSkills).toMatchObject([
      {
        key: "resource:resource-review",
        name: "review",
        description: "Review correctness before style.",
        target: ".agents/skills/review",
      },
    ]);
    expect(readFileSync(`${target(workspace, "codex", "review")}/SKILL.md`, "utf-8")).toContain(
      "Check correctness first.",
    );

    const unavailable = await reconcileManagedSkills({
      workspace,
      provider: "codex",
      providerSkillRoots: TEST_PROVIDER_SKILL_ROOTS,
      teamSnapshot: { kind: "unavailable" },
      bundledSkillsRoot,
    });
    expect(unavailable.ok).toBe(true);
    expect(unavailable.teamSkills).toEqual([]);
    // A non-authoritative snapshot carries no registry publication — the
    // previously published command map stays in force.
    expect(unavailable.teamSkillCommands).toBeNull();
    expect(existsSync(target(workspace, "codex", "review"))).toBe(true);

    const stale = await reconcileManagedSkills({
      workspace,
      provider: "codex",
      providerSkillRoots: TEST_PROVIDER_SKILL_ROOTS,
      teamSnapshot: authoritativeTeamSkillSnapshot(9, []),
      bundledSkillsRoot,
    });
    expect(stale.staleTeamSnapshot).toBe(true);
    expect(existsSync(target(workspace, "codex", "review"))).toBe(true);
    expect(readManagedState(workspace)?.resourceConfigVersion).toBe(10);

    const updated = await reconcileManagedSkills({
      workspace,
      provider: "codex",
      providerSkillRoots: TEST_PROVIDER_SKILL_ROOTS,
      teamSnapshot: authoritativeTeamSkillSnapshot(11, [teamSkill({ body: "# Review\n\nUpdated policy." })]),
      bundledSkillsRoot,
    });
    expect(updated.installed).toContain("resource:resource-review");
    expect(readFileSync(`${target(workspace, "codex", "review")}/SKILL.md`, "utf-8")).toContain("Updated policy.");

    const revoked = await reconcileManagedSkills({
      workspace,
      provider: "codex",
      providerSkillRoots: TEST_PROVIDER_SKILL_ROOTS,
      teamSnapshot: authoritativeTeamSkillSnapshot(12, []),
      bundledSkillsRoot,
    });
    expect(revoked.removed).toContain("resource:resource-review@.agents/skills/review");
    expect(existsSync(target(workspace, "codex", "review"))).toBe(false);
    expect(readManagedState(workspace)?.resourceConfigVersion).toBe(12);
  });

  it("serializes callers and prevents an older Team snapshot from rolling back a newer one", async () => {
    const newer = reconcileManagedSkills({
      workspace,
      provider: "codex",
      providerSkillRoots: TEST_PROVIDER_SKILL_ROOTS,
      teamSnapshot: authoritativeTeamSkillSnapshot(18, [teamSkill()]),
      bundledSkillsRoot,
    });
    const older = reconcileManagedSkills({
      workspace,
      provider: "codex",
      providerSkillRoots: TEST_PROVIDER_SKILL_ROOTS,
      teamSnapshot: authoritativeTeamSkillSnapshot(17, []),
      bundledSkillsRoot,
    });
    const [newResult, oldResult] = await Promise.all([newer, older]);

    expect(newResult.ok).toBe(true);
    expect(oldResult.staleTeamSnapshot).toBe(true);
    expect(readManagedState(workspace)?.resourceConfigVersion).toBe(18);
    expect(existsSync(target(workspace, "codex", "review"))).toBe(true);
  });

  it.each([
    ["unavailable", { kind: "unavailable" } as const],
    ["stale", authoritativeTeamSkillSnapshot(9, [])],
  ])("quarantines a tampered Team LKG under a %s snapshot", async (_label, snapshot) => {
    await reconcileManagedSkills({
      workspace,
      provider: "codex",
      providerSkillRoots: TEST_PROVIDER_SKILL_ROOTS,
      teamSnapshot: authoritativeTeamSkillSnapshot(10, [teamSkill()]),
      bundledSkillsRoot,
    });
    const installed = target(workspace, "codex", "review");
    writeFileSync(join(installed, "SKILL.md"), "tampered\n");

    const result = await reconcileManagedSkills({
      workspace,
      provider: "codex",
      providerSkillRoots: TEST_PROVIDER_SKILL_ROOTS,
      teamSnapshot: snapshot,
      bundledSkillsRoot,
    });
    expect(result.staleTeamSnapshot).toBe(_label === "stale");
    expect(existsSync(installed)).toBe(false);
  });

  it("blocks an unavailable-snapshot preflight when a tampered Team LKG cannot be quarantined", async () => {
    await reconcileManagedSkills({
      workspace,
      provider: "codex",
      providerSkillRoots: TEST_PROVIDER_SKILL_ROOTS,
      teamSnapshot: authoritativeTeamSkillSnapshot(10, [teamSkill()]),
      bundledSkillsRoot,
    });
    const installed = target(workspace, "codex", "review");
    writeFileSync(join(installed, "SKILL.md"), "tampered\n");

    await expect(
      reconcileManagedSkills({
        workspace,
        provider: "codex",
        providerSkillRoots: TEST_PROVIDER_SKILL_ROOTS,
        teamSnapshot: { kind: "unavailable" },
        bundledSkillsRoot,
        testFailureAt: "quarantine_rename",
      }),
    ).rejects.toBeInstanceOf(ManagedSkillsUnsafeDiscoveryError);
    expect(existsSync(installed)).toBe(true);
  });

  it("uses a deterministic suffix for Team Skill conflicts and never overwrites the user target", async () => {
    const userTarget = target(workspace, "codex", "review");
    mkdirSync(userTarget, { recursive: true });
    writeFileSync(join(userTarget, "SKILL.md"), "user-owned review\n");

    const result = await reconcileManagedSkills({
      workspace,
      provider: "codex",
      providerSkillRoots: TEST_PROVIDER_SKILL_ROOTS,
      teamSnapshot: authoritativeTeamSkillSnapshot(1, [teamSkill()]),
      bundledSkillsRoot,
    });

    expect(result.ok, JSON.stringify(result.failures)).toBe(true);
    expect(result.teamSkills[0]?.name).toBe("review-first-tree");
    expect(result.teamSkillCommands).toEqual([
      { requestedSlug: "review", resourceId: "resource-review", effectiveName: "review-first-tree" },
    ]);
    expect(readFileSync(join(userTarget, "SKILL.md"), "utf-8")).toBe("user-owned review\n");
    expect(existsSync(target(workspace, "codex", "review-first-tree"))).toBe(true);

    const retry = await reconcileManagedSkills({
      workspace,
      provider: "codex",
      providerSkillRoots: TEST_PROVIDER_SKILL_ROOTS,
      teamSnapshot: authoritativeTeamSkillSnapshot(1, [teamSkill()]),
      bundledSkillsRoot,
    });
    expect(retry.teamSkills[0]?.name).toBe("review-first-tree");
  });

  it("reports a configured-but-unverified Team Skill command with a null effective name", async () => {
    await reconcileManagedSkills({
      workspace,
      provider: "codex",
      providerSkillRoots: TEST_PROVIDER_SKILL_ROOTS,
      teamSnapshot: authoritativeTeamSkillSnapshot(1, [teamSkill()]),
      bundledSkillsRoot,
    });
    const installed = target(workspace, "codex", "review");

    // Tampering before the publication gate invalidates the install: the
    // base command stays configured but has no verified target.
    const drifted = await reconcileManagedSkills({
      workspace,
      provider: "codex",
      providerSkillRoots: TEST_PROVIDER_SKILL_ROOTS,
      teamSnapshot: authoritativeTeamSkillSnapshot(1, [teamSkill()]),
      bundledSkillsRoot,
      testBeforeTeamRows: () => {
        writeFileSync(join(installed, "SKILL.md"), "tampered after main loop\n");
      },
    });

    expect(drifted.teamSkills).toEqual([]);
    expect(drifted.teamSkillCommands).toEqual([
      { requestedSlug: "review", resourceId: "resource-review", effectiveName: null },
    ]);
  });

  it("installs complete root and wrapped Team ZIPs with nested, executable, and binary files", async () => {
    const binary = Uint8Array.from([0, 255, 1, 128, 64]);
    const rootZip = makeSkillZip({
      "scripts/run.sh": [strToU8("#!/bin/sh\necho bundle\n"), { os: 3, attrs: 0o100777 << 16 }],
      "references/guide.md": strToU8("# Guide\n"),
      "references/nested/deep.md": strToU8("deep\n"),
      "assets/pixel.bin": binary,
    });
    const resolver = async (): Promise<Buffer> => rootZip;
    const rootResult = await reconcileManagedSkills({
      workspace,
      provider: "codex",
      providerSkillRoots: TEST_PROVIDER_SKILL_ROOTS,
      teamSnapshot: authoritativeTeamSkillSnapshot(1, [bundleSkill(rootZip)]),
      bundledSkillsRoot,
      bundleResolver: resolver,
    });

    expect(rootResult.ok, JSON.stringify(rootResult.failures)).toBe(true);
    const installed = target(workspace, "codex", "review");
    expect(readFileSync(join(installed, "scripts", "run.sh"), "utf-8")).toContain("echo bundle");
    expect(lstatSync(join(installed, "scripts", "run.sh")).mode & 0o777).toBe(0o755);
    expect(readFileSync(join(installed, "references", "nested", "deep.md"), "utf-8")).toBe("deep\n");
    expect(readFileSync(join(installed, "assets", "pixel.bin"))).toEqual(Buffer.from(binary));
    expect(readFileSync(join(installed, "SKILL.md"), "utf-8")).not.toContain("INLINE FALLBACK");

    const wrappedZip = makeSkillZip(
      {
        "scripts/wrapped.sh": strToU8("echo wrapped\n"),
        "assets/wrapped.bin": Uint8Array.from([9, 8, 7]),
      },
      { wrapper: "review-skill" },
    );
    const wrappedResult = await reconcileManagedSkills({
      workspace,
      provider: "codex",
      providerSkillRoots: TEST_PROVIDER_SKILL_ROOTS,
      teamSnapshot: authoritativeTeamSkillSnapshot(2, [bundleSkill(wrappedZip, {}, BUNDLE_ID_B)]),
      bundledSkillsRoot,
      bundleResolver: async () => wrappedZip,
    });
    expect(wrappedResult.ok, JSON.stringify(wrappedResult.failures)).toBe(true);
    expect(readFileSync(join(installed, "scripts", "wrapped.sh"), "utf-8")).toBe("echo wrapped\n");
    expect(existsSync(join(installed, "review-skill"))).toBe(false);
  });

  it("normalizes uploaded Unix modes so owner access is always usable and unsafe writes are removed", async () => {
    const bundle = makeSkillZip({
      "locked/": [new Uint8Array(), { os: 3, attrs: 0o040000 << 16 }],
      "locked/run.sh": [strToU8("echo safe\n"), { os: 3, attrs: 0o100000 << 16 }],
      "group-exec.sh": [strToU8("echo executable\n"), { os: 3, attrs: 0o100010 << 16 }],
    });
    const result = await reconcileManagedSkills({
      workspace,
      provider: "codex",
      providerSkillRoots: TEST_PROVIDER_SKILL_ROOTS,
      teamSnapshot: authoritativeTeamSkillSnapshot(1, [bundleSkill(bundle)]),
      bundledSkillsRoot,
      bundleResolver: async () => bundle,
    });

    expect(result.ok, JSON.stringify(result.failures)).toBe(true);
    const installed = target(workspace, "codex", "review");
    expect(lstatSync(join(installed, "locked")).mode & 0o777).toBe(0o700);
    expect(lstatSync(join(installed, "locked", "run.sh")).mode & 0o777).toBe(0o600);
    expect(lstatSync(join(installed, "group-exec.sh")).mode & 0o777).toBe(0o710);
    expect(readFileSync(join(installed, "locked", "run.sh"), "utf-8")).toBe("echo safe\n");
  });

  it("repairs chmod-only unsafe write drift without changing the legacy digest format", async () => {
    const bundle = makeSkillZip({
      "scripts/": [new Uint8Array(), { os: 3, attrs: 0o040755 << 16 }],
      "scripts/run.sh": [strToU8("#!/bin/sh\necho safe\n"), { os: 3, attrs: 0o100755 << 16 }],
    });
    const resolver = vi.fn(async () => bundle);
    const snapshot = authoritativeTeamSkillSnapshot(1, [bundleSkill(bundle)]);
    await reconcileManagedSkills({
      workspace,
      provider: "codex",
      providerSkillRoots: TEST_PROVIDER_SKILL_ROOTS,
      teamSnapshot: snapshot,
      bundledSkillsRoot,
      bundleResolver: resolver,
    });
    const installed = target(workspace, "codex", "review");
    const scripts = join(installed, "scripts");
    const script = join(scripts, "run.sh");

    chmodSync(script, 0o777);
    const fileRepair = await reconcileManagedSkills({
      workspace,
      provider: "codex",
      providerSkillRoots: TEST_PROVIDER_SKILL_ROOTS,
      teamSnapshot: snapshot,
      bundledSkillsRoot,
      bundleResolver: resolver,
    });
    expect(fileRepair.installed).toContain("resource:resource-review");
    expect(lstatSync(script).mode & 0o777).toBe(0o755);

    chmodSync(scripts, 0o777);
    const directoryRepair = await reconcileManagedSkills({
      workspace,
      provider: "codex",
      providerSkillRoots: TEST_PROVIDER_SKILL_ROOTS,
      teamSnapshot: snapshot,
      bundledSkillsRoot,
      bundleResolver: resolver,
    });
    expect(directoryRepair.installed).toContain("resource:resource-review");
    expect(lstatSync(scripts).mode & 0o777).toBe(0o755);

    chmodSync(installed, 0o777);
    const rootRepair = await reconcileManagedSkills({
      workspace,
      provider: "codex",
      providerSkillRoots: TEST_PROVIDER_SKILL_ROOTS,
      teamSnapshot: snapshot,
      bundledSkillsRoot,
      bundleResolver: resolver,
    });
    expect(rootRepair.installed).toContain("resource:resource-review");
    expect(lstatSync(installed).mode & 0o777).toBe(0o700);
    expect(resolver).toHaveBeenCalledTimes(4);
  });

  it("accepts Windows-synthesized write bits through a fresh install and clean LKG reconcile", async () => {
    const bundle = makeSkillZip({
      "scripts/run.sh": [strToU8("#!/bin/sh\necho safe\n"), { os: 3, attrs: 0o100644 << 16 }],
    });
    const resolver = vi.fn(async () => bundle);
    const snapshot = authoritativeTeamSkillSnapshot(1, [bundleSkill(bundle)]);
    const installedResult = await reconcileManagedSkills({
      workspace,
      provider: "codex",
      providerSkillRoots: TEST_PROVIDER_SKILL_ROOTS,
      teamSnapshot: snapshot,
      bundledSkillsRoot,
      bundleResolver: resolver,
      testModePlatform: "win32",
    });
    expect(installedResult.installed).toContain("resource:resource-review");
    const installed = target(workspace, "codex", "review");
    chmodSync(installed, 0o777);
    chmodSync(join(installed, "scripts", "run.sh"), 0o666);

    const clean = await reconcileManagedSkills({
      workspace,
      provider: "codex",
      providerSkillRoots: TEST_PROVIDER_SKILL_ROOTS,
      teamSnapshot: snapshot,
      bundledSkillsRoot,
      bundleResolver: resolver,
      testModePlatform: "win32",
    });
    expect(clean.skipped).toContain("resource:resource-review");
    expect(clean.installed).not.toContain("resource:resource-review");
    expect(resolver).toHaveBeenCalledTimes(1);
  });

  it("normalizes npm-style bundled Core modes and keeps the projected digest stable", async () => {
    for (const name of CORE_SKILL_NAMES) {
      const skillRoot = join(bundledSkillsRoot, name);
      const executable = join(skillRoot, "run.sh");
      writeFileSync(executable, "#!/bin/sh\necho safe\n");
      chmodSync(skillRoot, 0o775);
      chmodSync(join(skillRoot, "references"), 0o775);
      chmodSync(join(skillRoot, "SKILL.md"), 0o664);
      chmodSync(join(skillRoot, "VERSION"), 0o664);
      chmodSync(join(skillRoot, "references", "guide.md"), 0o664);
      chmodSync(executable, 0o775);
    }
    const installed = await reconcileManagedSkills({
      workspace,
      provider: "codex",
      providerSkillRoots: TEST_PROVIDER_SKILL_ROOTS,
      teamSnapshot: authoritativeTeamSkillSnapshot(1, []),
      bundledSkillsRoot,
    });
    expect(installed.ok, JSON.stringify(installed.failures)).toBe(true);
    for (const name of CORE_SKILL_NAMES) {
      const installedRoot = target(workspace, "codex", name);
      expect(lstatSync(installedRoot).mode & 0o777).toBe(0o700);
      expect(lstatSync(join(installedRoot, "references")).mode & 0o777).toBe(0o700);
      expect(lstatSync(join(installedRoot, "SKILL.md")).mode & 0o777).toBe(0o600);
      expect(lstatSync(join(installedRoot, "VERSION")).mode & 0o777).toBe(0o600);
      expect(lstatSync(join(installedRoot, "references", "guide.md")).mode & 0o777).toBe(0o600);
      expect(lstatSync(join(installedRoot, "run.sh")).mode & 0o777).toBe(0o700);
    }

    const stable = await reconcileManagedSkills({
      workspace,
      provider: "codex",
      providerSkillRoots: TEST_PROVIDER_SKILL_ROOTS,
      teamSnapshot: authoritativeTeamSkillSnapshot(1, []),
      bundledSkillsRoot,
    });
    expect(stable.ok, JSON.stringify(stable.failures)).toBe(true);
    expect(stable.installed).toEqual([]);
    expect(stable.skipped).toHaveLength(CORE_SKILL_NAMES.length);

    const driftedRoot = target(workspace, "codex", CORE_SKILL_NAMES[0] ?? "");
    chmodSync(driftedRoot, 0o775);
    chmodSync(join(driftedRoot, "SKILL.md"), 0o664);
    const repaired = await reconcileManagedSkills({
      workspace,
      provider: "codex",
      providerSkillRoots: TEST_PROVIDER_SKILL_ROOTS,
      teamSnapshot: authoritativeTeamSkillSnapshot(1, []),
      bundledSkillsRoot,
    });
    expect(repaired.ok, JSON.stringify(repaired.failures)).toBe(true);
    expect(repaired.installed).toContain(`core:${CORE_SKILL_NAMES[0]}`);
    expect(lstatSync(driftedRoot).mode & 0o777).toBe(0o700);
    expect(lstatSync(join(driftedRoot, "SKILL.md")).mode & 0o777).toBe(0o600);
  });

  it("rewrites only the manifest name for an allocated collision target", async () => {
    const userTarget = target(workspace, "codex", "review");
    mkdirSync(userTarget, { recursive: true });
    writeFileSync(join(userTarget, "SKILL.md"), "user-owned review\n");
    const bundle = makeSkillZip({
      "scripts/run.sh": strToU8("echo retained\n"),
      "assets/data.bin": Uint8Array.from([3, 1, 4]),
    });

    const result = await reconcileManagedSkills({
      workspace,
      provider: "codex",
      providerSkillRoots: TEST_PROVIDER_SKILL_ROOTS,
      teamSnapshot: authoritativeTeamSkillSnapshot(1, [bundleSkill(bundle)]),
      bundledSkillsRoot,
      bundleResolver: async () => bundle,
    });

    expect(result.ok, JSON.stringify(result.failures)).toBe(true);
    expect(result.teamSkills[0]?.name).toBe("review-first-tree");
    const markdown = readFileSync(`${target(workspace, "codex", "review-first-tree")}/SKILL.md`, "utf-8");
    expect(markdown).toContain("name: review-first-tree");
    expect(markdown).toContain("owner: platform");
    expect(markdown).toContain("retained: true");
    expect(markdown).toContain("Keep this body byte-for-byte when only the name changes.");
    expect(readFileSync(`${target(workspace, "codex", "review-first-tree")}/assets/data.bin`)).toEqual(
      Buffer.from([3, 1, 4]),
    );
    expect(readFileSync(join(userTarget, "SKILL.md"), "utf-8")).toBe("user-owned review\n");
  });

  it("uses immutable bundle revision identity, repairs drift, and preserves last-known-good on resolve failure", async () => {
    const firstBundle = makeSkillZip({ "assets/version.txt": strToU8("one\n") });
    let currentBytes = firstBundle;
    let resolveError: Error | null = null;
    let fetches = 0;
    const resolver = async (): Promise<Buffer> => {
      fetches++;
      if (resolveError) throw resolveError;
      return currentBytes;
    };
    const firstSkill = bundleSkill(firstBundle);
    await reconcileManagedSkills({
      workspace,
      provider: "codex",
      providerSkillRoots: TEST_PROVIDER_SKILL_ROOTS,
      teamSnapshot: authoritativeTeamSkillSnapshot(1, [firstSkill]),
      bundledSkillsRoot,
      bundleResolver: resolver,
    });
    const installed = target(workspace, "codex", "review");
    expect(fetches).toBe(1);

    const unchanged = await reconcileManagedSkills({
      workspace,
      provider: "codex",
      providerSkillRoots: TEST_PROVIDER_SKILL_ROOTS,
      teamSnapshot: authoritativeTeamSkillSnapshot(1, [firstSkill]),
      bundledSkillsRoot,
      bundleResolver: resolver,
    });
    expect(unchanged.skipped).toContain("resource:resource-review");
    expect(fetches).toBe(1);

    writeFileSync(join(installed, "assets", "version.txt"), "drift\n");
    await reconcileManagedSkills({
      workspace,
      provider: "codex",
      providerSkillRoots: TEST_PROVIDER_SKILL_ROOTS,
      teamSnapshot: authoritativeTeamSkillSnapshot(1, [firstSkill]),
      bundledSkillsRoot,
      bundleResolver: resolver,
    });
    expect(fetches).toBe(2);
    expect(readFileSync(join(installed, "assets", "version.txt"), "utf-8")).toBe("one\n");

    const secondBundle = makeSkillZip({ "assets/version.txt": strToU8("two\n") });
    currentBytes = secondBundle;
    resolveError = new Error("temporary attachment download failure");
    const failedUpdate = await reconcileManagedSkills({
      workspace,
      provider: "codex",
      providerSkillRoots: TEST_PROVIDER_SKILL_ROOTS,
      teamSnapshot: authoritativeTeamSkillSnapshot(2, [bundleSkill(secondBundle, {}, BUNDLE_ID_B)]),
      bundledSkillsRoot,
      bundleResolver: resolver,
    });
    expect(failedUpdate.failures).toContainEqual({
      key: "resource:resource-review",
      reason: "temporary attachment download failure",
    });
    expect(readFileSync(join(installed, "assets", "version.txt"), "utf-8")).toBe("one\n");

    resolveError = null;
    const updated = await reconcileManagedSkills({
      workspace,
      provider: "codex",
      providerSkillRoots: TEST_PROVIDER_SKILL_ROOTS,
      teamSnapshot: authoritativeTeamSkillSnapshot(2, [bundleSkill(secondBundle, {}, BUNDLE_ID_B)]),
      bundledSkillsRoot,
      bundleResolver: resolver,
    });
    expect(updated.installed).toContain("resource:resource-review");
    expect(readFileSync(join(installed, "assets", "version.txt"), "utf-8")).toBe("two\n");

    const runtimeEntries = (): string[] =>
      readdirSync(join(workspace, ".first-tree-workspace")).filter((name) =>
        name.startsWith(".managed-skill-quarantine-"),
      );
    const quarantinesBeforeFailedRepair = runtimeEntries().length;
    writeFileSync(join(installed, "assets", "version.txt"), "tampered\n");
    resolveError = new Error("temporary attachment download failure");
    const failedRepair = await reconcileManagedSkills({
      workspace,
      provider: "codex",
      providerSkillRoots: TEST_PROVIDER_SKILL_ROOTS,
      teamSnapshot: authoritativeTeamSkillSnapshot(2, [bundleSkill(secondBundle, {}, BUNDLE_ID_B)]),
      bundledSkillsRoot,
      bundleResolver: resolver,
    });
    expect(failedRepair.failures).toContainEqual({
      key: "resource:resource-review",
      reason: "temporary attachment download failure",
    });
    expect(existsSync(installed)).toBe(false);
    expect(runtimeEntries()).toHaveLength(quarantinesBeforeFailedRepair);

    resolveError = null;
    const repaired = await reconcileManagedSkills({
      workspace,
      provider: "codex",
      providerSkillRoots: TEST_PROVIDER_SKILL_ROOTS,
      teamSnapshot: authoritativeTeamSkillSnapshot(2, [bundleSkill(secondBundle, {}, BUNDLE_ID_B)]),
      bundledSkillsRoot,
      bundleResolver: resolver,
    });
    expect(repaired.installed).toContain("resource:resource-review");
    expect(readFileSync(join(installed, "assets", "version.txt"), "utf-8")).toBe("two\n");
  });

  it("keeps repeated drift and repair quarantine storage bounded to the stable slot", async () => {
    const bundle = makeSkillZip({ "assets/version.txt": strToU8("safe\n") });
    const resolver = vi.fn(async () => bundle);
    const snapshot = authoritativeTeamSkillSnapshot(1, [bundleSkill(bundle)]);
    const runtimeEntries = (): string[] =>
      readdirSync(join(workspace, ".first-tree-workspace")).filter((name) =>
        name.startsWith(".managed-skill-quarantine-"),
      );
    await reconcileManagedSkills({
      workspace,
      provider: "codex",
      providerSkillRoots: TEST_PROVIDER_SKILL_ROOTS,
      teamSnapshot: snapshot,
      bundledSkillsRoot,
      bundleResolver: resolver,
    });
    const installed = target(workspace, "codex", "review");

    for (let attempt = 0; attempt < 3; attempt++) {
      writeFileSync(join(installed, "assets", "version.txt"), `tampered ${attempt}\n`);
      const repaired = await reconcileManagedSkills({
        workspace,
        provider: "codex",
        providerSkillRoots: TEST_PROVIDER_SKILL_ROOTS,
        teamSnapshot: snapshot,
        bundledSkillsRoot,
        bundleResolver: resolver,
      });
      expect(repaired.installed).toContain("resource:resource-review");
      expect(readFileSync(join(installed, "assets", "version.txt"), "utf-8")).toBe("safe\n");
      expect(runtimeEntries()).toHaveLength(0);
    }
  });

  it("blocks provider preflight when an unverifiable target cannot be quarantined", async () => {
    const bundle = makeSkillZip({ "scripts/run.sh": strToU8("#!/bin/sh\necho safe\n") });
    const skill = bundleSkill(bundle);
    await reconcileManagedSkills({
      workspace,
      provider: "codex",
      providerSkillRoots: TEST_PROVIDER_SKILL_ROOTS,
      teamSnapshot: authoritativeTeamSkillSnapshot(1, [skill]),
      bundledSkillsRoot,
      bundleResolver: async () => bundle,
    });
    const installed = target(workspace, "codex", "review");
    rmSync(join(installed, "scripts", "run.sh"));
    symlinkSync("../../SKILL.md", join(installed, "scripts", "run.sh"));

    await expect(
      reconcileManagedSkills({
        workspace,
        provider: "codex",
        providerSkillRoots: TEST_PROVIDER_SKILL_ROOTS,
        teamSnapshot: authoritativeTeamSkillSnapshot(1, [skill]),
        bundledSkillsRoot,
        bundleResolver: async () => {
          throw new Error("download must not make an unsafe target runnable");
        },
        testFailureAt: "quarantine_rename",
      }),
    ).rejects.toBeInstanceOf(ManagedSkillsUnsafeDiscoveryError);
    expect(existsSync(installed)).toBe(true);

    const recovered = await reconcileManagedSkills({
      workspace,
      provider: "codex",
      providerSkillRoots: TEST_PROVIDER_SKILL_ROOTS,
      teamSnapshot: authoritativeTeamSkillSnapshot(1, [skill]),
      bundledSkillsRoot,
      bundleResolver: async () => bundle,
    });
    expect(recovered.installed).toContain("resource:resource-review");
    expect(lstatSync(join(installed, "scripts", "run.sh")).isFile()).toBe(true);
  });

  it("quarantines drift introduced after the main loop but before provider publication", async () => {
    const bundle = makeSkillZip({ "scripts/run.sh": strToU8("#!/bin/sh\necho safe\n") });
    const skill = bundleSkill(bundle);
    await reconcileManagedSkills({
      workspace,
      provider: "codex",
      providerSkillRoots: TEST_PROVIDER_SKILL_ROOTS,
      teamSnapshot: authoritativeTeamSkillSnapshot(1, [skill]),
      bundledSkillsRoot,
      bundleResolver: async () => bundle,
    });
    const installed = target(workspace, "codex", "review");

    const drifted = await reconcileManagedSkills({
      workspace,
      provider: "codex",
      providerSkillRoots: TEST_PROVIDER_SKILL_ROOTS,
      teamSnapshot: authoritativeTeamSkillSnapshot(1, [skill]),
      bundledSkillsRoot,
      bundleResolver: async () => bundle,
      testBeforeTeamRows: () => {
        writeFileSync(join(installed, "scripts", "run.sh"), "tampered after main loop\n");
      },
    });
    expect(drifted.ok).toBe(false);
    expect(drifted.teamSkills).toEqual([]);
    expect(drifted.installed).not.toContain("resource:resource-review");
    expect(drifted.skipped).not.toContain("resource:resource-review");
    expect(drifted.failures).toContainEqual({
      key: "resource:resource-review",
      reason: "managed Skill changed during final provider publication verification and was quarantined",
    });
    expect(existsSync(installed)).toBe(false);

    const recovered = await reconcileManagedSkills({
      workspace,
      provider: "codex",
      providerSkillRoots: TEST_PROVIDER_SKILL_ROOTS,
      teamSnapshot: authoritativeTeamSkillSnapshot(1, [skill]),
      bundledSkillsRoot,
      bundleResolver: async () => bundle,
    });
    expect(recovered.installed).toContain("resource:resource-review");
    expect(readFileSync(join(installed, "scripts", "run.sh"), "utf-8")).toContain("safe");
  });

  it("blocks final provider publication when late drift cannot leave discovery", async () => {
    const bundle = makeSkillZip({ "scripts/run.sh": strToU8("#!/bin/sh\necho safe\n") });
    const skill = bundleSkill(bundle);
    await reconcileManagedSkills({
      workspace,
      provider: "codex",
      providerSkillRoots: TEST_PROVIDER_SKILL_ROOTS,
      teamSnapshot: authoritativeTeamSkillSnapshot(1, [skill]),
      bundledSkillsRoot,
      bundleResolver: async () => bundle,
    });
    const installed = target(workspace, "codex", "review");

    await expect(
      reconcileManagedSkills({
        workspace,
        provider: "codex",
        providerSkillRoots: TEST_PROVIDER_SKILL_ROOTS,
        teamSnapshot: authoritativeTeamSkillSnapshot(1, [skill]),
        bundledSkillsRoot,
        bundleResolver: async () => bundle,
        testBeforePublication: () => {
          writeFileSync(join(installed, "scripts", "run.sh"), "tampered after main loop\n");
        },
        testFailureAt: "quarantine_rename",
      }),
    ).rejects.toBeInstanceOf(ManagedSkillsUnsafeDiscoveryError);
    expect(existsSync(installed)).toBe(true);
  });

  it("quarantines Core drift introduced after the main loop at the universal publication gate", async () => {
    await reconcileManagedSkills({
      workspace,
      provider: "codex",
      providerSkillRoots: TEST_PROVIDER_SKILL_ROOTS,
      teamSnapshot: authoritativeTeamSkillSnapshot(1, []),
      bundledSkillsRoot,
    });
    const installed = target(workspace, "codex", "first-tree-read");

    const result = await reconcileManagedSkills({
      workspace,
      provider: "codex",
      providerSkillRoots: TEST_PROVIDER_SKILL_ROOTS,
      teamSnapshot: authoritativeTeamSkillSnapshot(1, []),
      bundledSkillsRoot,
      testBeforePublication: () => {
        writeFileSync(join(installed, "references", "guide.md"), "late Core tamper\n");
      },
    });

    expect(result.failures).toContainEqual({
      key: "core:first-tree-read",
      reason: "managed Skill changed during final provider publication verification and was quarantined",
    });
    expect(result.skipped).not.toContain("core:first-tree-read");
    expect(existsSync(installed)).toBe(false);
  });

  it("blocks final provider publication when late Core drift cannot leave discovery", async () => {
    await reconcileManagedSkills({
      workspace,
      provider: "codex",
      providerSkillRoots: TEST_PROVIDER_SKILL_ROOTS,
      teamSnapshot: authoritativeTeamSkillSnapshot(1, []),
      bundledSkillsRoot,
    });
    const installed = target(workspace, "codex", "first-tree-read");

    await expect(
      reconcileManagedSkills({
        workspace,
        provider: "codex",
        providerSkillRoots: TEST_PROVIDER_SKILL_ROOTS,
        teamSnapshot: authoritativeTeamSkillSnapshot(1, []),
        bundledSkillsRoot,
        testBeforePublication: () => {
          writeFileSync(join(installed, "references", "guide.md"), "late Core tamper\n");
        },
        testFailureAt: "quarantine_rename",
      }),
    ).rejects.toBeInstanceOf(ManagedSkillsUnsafeDiscoveryError);
    expect(existsSync(installed)).toBe(true);
  });

  it("rechecks unavailable-snapshot Team LKG at publication and blocks when late drift cannot be quarantined", async () => {
    await reconcileManagedSkills({
      workspace,
      provider: "codex",
      providerSkillRoots: TEST_PROVIDER_SKILL_ROOTS,
      teamSnapshot: authoritativeTeamSkillSnapshot(1, [teamSkill()]),
      bundledSkillsRoot,
    });
    const installed = target(workspace, "codex", "review");

    await expect(
      reconcileManagedSkills({
        workspace,
        provider: "codex",
        providerSkillRoots: TEST_PROVIDER_SKILL_ROOTS,
        teamSnapshot: { kind: "unavailable" },
        bundledSkillsRoot,
        testBeforePublication: () => {
          writeFileSync(join(installed, "SKILL.md"), "late unavailable-snapshot tamper\n");
        },
        testFailureAt: "quarantine_rename",
      }),
    ).rejects.toBeInstanceOf(ManagedSkillsUnsafeDiscoveryError);
    expect(existsSync(installed)).toBe(true);
  });

  it("quarantines unavailable-snapshot Team drift introduced only at the publication gate", async () => {
    await reconcileManagedSkills({
      workspace,
      provider: "codex",
      providerSkillRoots: TEST_PROVIDER_SKILL_ROOTS,
      teamSnapshot: authoritativeTeamSkillSnapshot(1, [teamSkill()]),
      bundledSkillsRoot,
    });
    const installed = target(workspace, "codex", "review");

    const result = await reconcileManagedSkills({
      workspace,
      provider: "codex",
      providerSkillRoots: TEST_PROVIDER_SKILL_ROOTS,
      teamSnapshot: { kind: "unavailable" },
      bundledSkillsRoot,
      testBeforePublication: () => {
        writeFileSync(join(installed, "SKILL.md"), "late unavailable-snapshot tamper\n");
      },
    });
    expect(result.failures).toContainEqual({
      key: "resource:resource-review",
      reason: "managed Skill changed during final provider publication verification and was quarantined",
    });
    expect(existsSync(installed)).toBe(false);
  });

  it("quarantines stale-snapshot Team drift introduced only at the publication gate", async () => {
    await reconcileManagedSkills({
      workspace,
      provider: "codex",
      providerSkillRoots: TEST_PROVIDER_SKILL_ROOTS,
      teamSnapshot: authoritativeTeamSkillSnapshot(2, [teamSkill()]),
      bundledSkillsRoot,
    });
    const installed = target(workspace, "codex", "review");

    const result = await reconcileManagedSkills({
      workspace,
      provider: "codex",
      providerSkillRoots: TEST_PROVIDER_SKILL_ROOTS,
      teamSnapshot: authoritativeTeamSkillSnapshot(1, [teamSkill()]),
      bundledSkillsRoot,
      testBeforePublication: () => {
        writeFileSync(join(installed, "SKILL.md"), "late stale-snapshot tamper\n");
      },
    });
    expect(result.staleTeamSnapshot).toBe(true);
    expect(result.failures).toContainEqual({
      key: "resource:resource-review",
      reason: "managed Skill changed during final provider publication verification and was quarantined",
    });
    expect(existsSync(installed)).toBe(false);
  });

  it("recovers after interruption immediately after quarantine leaves discovery", async () => {
    const bundle = makeSkillZip({ "scripts/run.sh": strToU8("#!/bin/sh\necho safe\n") });
    const skill = bundleSkill(bundle);
    await reconcileManagedSkills({
      workspace,
      provider: "codex",
      providerSkillRoots: TEST_PROVIDER_SKILL_ROOTS,
      teamSnapshot: authoritativeTeamSkillSnapshot(1, [skill]),
      bundledSkillsRoot,
      bundleResolver: async () => bundle,
    });
    const installed = target(workspace, "codex", "review");
    writeFileSync(join(installed, "scripts", "run.sh"), "tampered\n");

    const interrupted = await reconcileManagedSkills({
      workspace,
      provider: "codex",
      providerSkillRoots: TEST_PROVIDER_SKILL_ROOTS,
      teamSnapshot: authoritativeTeamSkillSnapshot(1, [skill]),
      bundledSkillsRoot,
      bundleResolver: async () => bundle,
      testCrashAt: "quarantine_moved",
    });
    expect(interrupted.ok).toBe(false);
    expect(existsSync(installed)).toBe(false);
    expect(
      readdirSync(join(workspace, ".first-tree-workspace")).filter((name) =>
        name.startsWith(".managed-skill-quarantine-"),
      ),
    ).toHaveLength(1);

    const recovered = await reconcileManagedSkills({
      workspace,
      provider: "codex",
      providerSkillRoots: TEST_PROVIDER_SKILL_ROOTS,
      teamSnapshot: authoritativeTeamSkillSnapshot(1, [skill]),
      bundledSkillsRoot,
      bundleResolver: async () => bundle,
    });
    expect(recovered.installed).toContain("resource:resource-review");
    expect(readFileSync(join(installed, "scripts", "run.sh"), "utf-8")).toContain("safe");
    expect(
      readdirSync(join(workspace, ".first-tree-workspace")).filter((name) =>
        name.startsWith(".managed-skill-quarantine-"),
      ),
    ).toHaveLength(0);
  });

  it("cleans an interrupted quarantine when the next authoritative snapshot revokes the Skill", async () => {
    const bundle = makeSkillZip({ "scripts/run.sh": strToU8("#!/bin/sh\necho safe\n") });
    const skill = bundleSkill(bundle);
    await reconcileManagedSkills({
      workspace,
      provider: "codex",
      providerSkillRoots: TEST_PROVIDER_SKILL_ROOTS,
      teamSnapshot: authoritativeTeamSkillSnapshot(1, [skill]),
      bundledSkillsRoot,
      bundleResolver: async () => bundle,
    });
    const installed = target(workspace, "codex", "review");
    writeFileSync(join(installed, "scripts", "run.sh"), "tampered\n");

    await reconcileManagedSkills({
      workspace,
      provider: "codex",
      providerSkillRoots: TEST_PROVIDER_SKILL_ROOTS,
      teamSnapshot: authoritativeTeamSkillSnapshot(1, [skill]),
      bundledSkillsRoot,
      bundleResolver: async () => bundle,
      testCrashAt: "quarantine_moved",
    });
    expect(existsSync(installed)).toBe(false);
    expect(
      readdirSync(join(workspace, ".first-tree-workspace")).filter((name) =>
        name.startsWith(".managed-skill-quarantine-"),
      ),
    ).toHaveLength(1);

    const revoked = await reconcileManagedSkills({
      workspace,
      provider: "codex",
      providerSkillRoots: TEST_PROVIDER_SKILL_ROOTS,
      teamSnapshot: authoritativeTeamSkillSnapshot(2, []),
      bundledSkillsRoot,
    });
    expect(revoked.removed).toContain("resource:resource-review@.agents/skills/review");
    expect(readManagedState(workspace)?.skills.some((entry) => entry.key === "resource:resource-review")).toBe(false);
    expect(existsSync(installed)).toBe(false);
    expect(
      readdirSync(join(workspace, ".first-tree-workspace")).filter((name) =>
        name.startsWith(".managed-skill-quarantine-"),
      ),
    ).toHaveLength(0);
  });

  it("blocks provider preflight when authoritative removal cannot leave discovery", async () => {
    await reconcileManagedSkills({
      workspace,
      provider: "codex",
      providerSkillRoots: TEST_PROVIDER_SKILL_ROOTS,
      teamSnapshot: authoritativeTeamSkillSnapshot(1, [teamSkill()]),
      bundledSkillsRoot,
    });
    const installed = target(workspace, "codex", "review");

    await expect(
      reconcileManagedSkills({
        workspace,
        provider: "codex",
        providerSkillRoots: TEST_PROVIDER_SKILL_ROOTS,
        teamSnapshot: authoritativeTeamSkillSnapshot(2, []),
        bundledSkillsRoot,
        testFailureAt: "remove_target",
      }),
    ).rejects.toBeInstanceOf(ManagedSkillsUnsafeDiscoveryError);
    expect(existsSync(installed)).toBe(true);

    const removed = await reconcileManagedSkills({
      workspace,
      provider: "codex",
      providerSkillRoots: TEST_PROVIDER_SKILL_ROOTS,
      teamSnapshot: authoritativeTeamSkillSnapshot(2, []),
      bundledSkillsRoot,
    });
    expect(removed.removed).toContain("resource:resource-review@.agents/skills/review");
    expect(existsSync(installed)).toBe(false);
  });

  it("projects files above the legacy digest limits within the shared admission budget", async () => {
    const bundle = makeSkillZip({
      "assets/single.bin": new Uint8Array(5 * 1024 * 1024),
      "assets/remaining.bin": new Uint8Array(12 * 1024 * 1024),
    });
    const result = await reconcileManagedSkills({
      workspace,
      provider: "codex",
      providerSkillRoots: TEST_PROVIDER_SKILL_ROOTS,
      teamSnapshot: authoritativeTeamSkillSnapshot(1, [bundleSkill(bundle)]),
      bundledSkillsRoot,
      bundleResolver: async () => bundle,
    });
    expect(result.ok, JSON.stringify(result.failures)).toBe(true);
    expect(lstatSync(join(target(workspace, "codex", "review"), "assets", "single.bin")).size).toBe(5 * 1024 * 1024);
  });

  it.each([
    ["Review", "review"],
    ["my_skill", "my-skill"],
  ])("aligns attachment manifest %s with target and briefing name %s", async (manifestName, effectiveName) => {
    const bundle = makeSkillZip({}, { name: manifestName });
    const result = await reconcileManagedSkills({
      workspace,
      provider: "codex",
      providerSkillRoots: TEST_PROVIDER_SKILL_ROOTS,
      teamSnapshot: authoritativeTeamSkillSnapshot(1, [
        bundleSkill(bundle, { name: manifestName, resourceId: `resource-${effectiveName}` }),
      ]),
      bundledSkillsRoot,
      bundleResolver: async () => bundle,
    });
    expect(result.teamSkills).toContainEqual(expect.objectContaining({ name: effectiveName }));
    const manifest = readFileSync(join(target(workspace, "codex", effectiveName), "SKILL.md"), "utf-8");
    expect(manifest).toMatch(new RegExp(`^---\\nname: ${effectiveName}$`, "m"));
  });

  it("rejects an attachment whose valid raw manifest name differs from its snapshot descriptor", async () => {
    const bundle = makeSkillZip({}, { name: "different" });
    const result = await reconcileManagedSkills({
      workspace,
      provider: "codex",
      providerSkillRoots: TEST_PROVIDER_SKILL_ROOTS,
      teamSnapshot: authoritativeTeamSkillSnapshot(1, [bundleSkill(bundle, { name: "review" })]),
      bundledSkillsRoot,
      bundleResolver: async () => bundle,
    });

    expect(result.failures).toContainEqual(
      expect.objectContaining({
        key: "resource:resource-review",
        reason: expect.stringContaining('name "different" does not match effective name "review"'),
      }),
    );
    expect(existsSync(target(workspace, "codex", "review"))).toBe(false);
  });

  it("never downgrades persisted attachment authority when an old Server omits the bundle descriptor", async () => {
    const firstBundle = makeSkillZip({ "references/guide.md": strToU8("complete attachment\n") });
    const replacementBundle = makeSkillZip(
      { "references/guide.md": strToU8("replacement attachment\n") },
      { name: "review" },
    );
    const resolver = vi.fn(async (bundle: RuntimeSkillBundle) =>
      bundle.attachmentId === BUNDLE_ID_A ? firstBundle : replacementBundle,
    );
    const bundled = bundleSkill(firstBundle);
    await reconcileManagedSkills({
      workspace,
      provider: "codex",
      providerSkillRoots: TEST_PROVIDER_SKILL_ROOTS,
      teamSnapshot: authoritativeTeamSkillSnapshot(1, [bundled]),
      bundledSkillsRoot,
      bundleResolver: resolver,
    });
    const installed = target(workspace, "codex", "review");
    const installedRevision = readManagedState(workspace)?.skills.find(
      (entry) => entry.key === "resource:resource-review",
    )?.revision;
    expect(installedRevision).toBe(`attachment:${BUNDLE_ID_A}:${firstBundle.byteLength}`);

    const oldServerSkill = teamSkill({
      name: "review",
      body: "INLINE FALLBACK MUST NOT REPLACE THE BUNDLE",
    });
    for (const version of [1, 2]) {
      const preserved = await reconcileManagedSkills({
        workspace,
        provider: "codex",
        providerSkillRoots: TEST_PROVIDER_SKILL_ROOTS,
        teamSnapshot: authoritativeTeamSkillSnapshot(version, [oldServerSkill]),
        bundledSkillsRoot,
        bundleResolver: resolver,
      });
      expect(preserved.skipped).toContain("resource:resource-review");
      expect(preserved.teamSkills).toContainEqual(
        expect.objectContaining({
          key: "resource:resource-review",
          revision: installedRevision,
        }),
      );
      expect(readFileSync(join(installed, "references", "guide.md"), "utf-8")).toBe("complete attachment\n");
      expect(readFileSync(join(installed, "SKILL.md"), "utf-8")).not.toContain("INLINE FALLBACK");
      expect(
        readManagedState(workspace)?.skills.find((entry) => entry.key === "resource:resource-review")?.revision,
      ).toBe(installedRevision);
    }
    expect(resolver).toHaveBeenCalledTimes(1);

    const restored = await reconcileManagedSkills({
      workspace,
      provider: "codex",
      providerSkillRoots: TEST_PROVIDER_SKILL_ROOTS,
      teamSnapshot: authoritativeTeamSkillSnapshot(3, [bundleSkill(replacementBundle, {}, BUNDLE_ID_B)]),
      bundledSkillsRoot,
      bundleResolver: resolver,
    });
    expect(restored.installed).toContain("resource:resource-review");
    expect(readFileSync(join(installed, "references", "guide.md"), "utf-8")).toBe("replacement attachment\n");

    const revoked = await reconcileManagedSkills({
      workspace,
      provider: "codex",
      providerSkillRoots: TEST_PROVIDER_SKILL_ROOTS,
      teamSnapshot: authoritativeTeamSkillSnapshot(4, []),
      bundledSkillsRoot,
      bundleResolver: resolver,
    });
    expect(revoked.removed).toContain("resource:resource-review@.agents/skills/review");
    expect(existsSync(installed)).toBe(false);
  });

  it("never invents an inline copy when a first bundle install cannot resolve", async () => {
    const bundle = makeSkillZip();
    const result = await reconcileManagedSkills({
      workspace,
      provider: "codex",
      providerSkillRoots: TEST_PROVIDER_SKILL_ROOTS,
      teamSnapshot: authoritativeTeamSkillSnapshot(1, [bundleSkill(bundle)]),
      bundledSkillsRoot,
    });

    expect(result.ok).toBe(false);
    expect(result.failures).toContainEqual(
      expect.objectContaining({
        key: "resource:resource-review",
        reason: expect.stringContaining("bundle resolver is unavailable"),
      }),
    );
    expect(existsSync(target(workspace, "codex", "review"))).toBe(false);
  });

  it.each([
    [
      "traversal",
      () =>
        makeSkillZip({
          "../escape.txt": strToU8("escape"),
        }),
      "invalid",
    ],
    [
      "absolute path",
      () =>
        makeSkillZip({
          "/absolute.txt": strToU8("escape"),
        }),
      "absolute",
    ],
    [
      "backslash path",
      () =>
        makeSkillZip({
          "scripts\\escape.sh": strToU8("escape"),
        }),
      "invalid",
    ],
    [
      "case-folded duplicate",
      () =>
        makeSkillZip({
          "assets/Icon.bin": Uint8Array.from([1]),
          "assets/icon.bin": Uint8Array.from([2]),
        }),
      "duplicate case-folded",
    ],
    [
      "Unicode-normalized duplicate",
      () =>
        makeSkillZip({
          "assets/Café.bin": Uint8Array.from([1]),
          "assets/Cafe\u0301.bin": Uint8Array.from([2]),
        }),
      "duplicate case-folded",
    ],
    [
      "implicit ancestor spelling collision",
      () =>
        makeSkillZip({
          "A/x.txt": strToU8("one"),
          "a/y.txt": strToU8("two"),
        }),
      "spelling collision",
    ],
    [
      "expanded Unicode case-fold ancestor collision",
      () =>
        makeSkillZip({
          "Straße/x.txt": strToU8("one"),
          "STRASSE/y.txt": strToU8("two"),
        }),
      "spelling collision",
    ],
    [
      "uppercase sharp-S case-fold ancestor collision",
      () =>
        makeSkillZip({
          "ẞ/x.txt": strToU8("one"),
          "SS/y.txt": strToU8("two"),
        }),
      "spelling collision",
    ],
    [
      "reserved ownership marker",
      () =>
        makeSkillZip({
          ".first-tree-managed.json": strToU8("{}"),
        }),
      "reserved",
    ],
    [
      "reserved ownership marker tree",
      () =>
        makeSkillZip({
          ".first-tree-managed.json/child": strToU8("{}"),
        }),
      "reserved",
    ],
    [
      "ambiguous second manifest",
      () =>
        makeSkillZip({
          "nested/SKILL.md": strToU8("---\nname: nested\ndescription: nested\n---\n"),
        }),
      "exactly one SKILL.md",
    ],
    [
      "symlink",
      () =>
        makeSkillZip({
          "scripts/link": [strToU8("../SKILL.md"), { os: 3, attrs: 0o120777 << 16 }],
        }),
      "symlinks",
    ],
    [
      "special file",
      () =>
        makeSkillZip({
          "scripts/fifo": [new Uint8Array(), { os: 3, attrs: 0o010644 << 16 }],
        }),
      "special files",
    ],
    ["encrypted entry", () => zipWithEncryptedFlag(makeSkillZip()), "encrypted"],
    [
      "excessive depth",
      () =>
        makeSkillZip({
          [`${Array.from({ length: 18 }, (_, index) => `d${index}`).join("/")}/deep.txt`]: strToU8("deep"),
        }),
      "directory depth",
    ],
    [
      "excessive empty-directory depth",
      () =>
        makeSkillZip({
          [`${Array.from({ length: 17 }, (_, index) => `d${index}`).join("/")}/`]: [
            new Uint8Array(),
            { os: 3, attrs: 0o040755 << 16 },
          ],
        }),
      "directory depth",
    ],
    [
      "Windows-reserved segment",
      () =>
        makeSkillZip({
          "references/CON/file.txt": strToU8("unsafe"),
        }),
      "Windows-reserved",
    ],
    [
      "Windows superscript-device segment",
      () =>
        makeSkillZip({
          "references/LPT².log": strToU8("unsafe"),
        }),
      "Windows-reserved",
    ],
    [
      "overlong segment",
      () =>
        makeSkillZip({
          [`assets/${"a".repeat(241)}`]: strToU8("unsafe"),
        }),
      "portable length",
    ],
    [
      "raw overlong Unicode segment",
      () =>
        makeSkillZip({
          [`assets/${"e\u0301".repeat(100)}`]: strToU8("unsafe"),
        }),
      "portable length",
    ],
    [
      "overlong relative path",
      () =>
        makeSkillZip({
          [`${Array.from({ length: 4 }, () => "a".repeat(200)).join("/")}/file.txt`]: strToU8("unsafe"),
        }),
      "relative path exceeds portable length",
    ],
    [
      "raw overlong Unicode relative path",
      () =>
        makeSkillZip({
          [Array.from({ length: 4 }, () => "e\u0301".repeat(80)).join("/")]: strToU8("unsafe"),
        }),
      "relative path exceeds portable length",
    ],
    [
      "excessive file count",
      () =>
        makeSkillZip(
          Object.fromEntries(
            Array.from({ length: 256 }, (_, index) => [`assets/${index}.txt`, strToU8(String(index))]),
          ),
        ),
      "file count",
    ],
    [
      "excessive entry count",
      () =>
        makeSkillZip(
          Object.fromEntries(
            Array.from({ length: 512 }, (_, index) => [
              `empty/${index}/`,
              [new Uint8Array(), { os: 3, attrs: 0o040755 << 16 }] as TestZipEntry,
            ]),
          ),
        ),
      "entry count",
    ],
    [
      "regular-file wrapper anchor",
      () =>
        Buffer.from(
          zipSync({
            wrapper: strToU8("not a directory"),
            "wrapper/SKILL.md": strToU8("---\nname: review\ndescription: review\n---\n"),
          }),
        ),
      "anchor must be a directory",
    ],
    [
      "non-exact manifest filename",
      () =>
        Buffer.from(
          zipSync({
            "skill.md": strToU8("---\nname: review\ndescription: review\n---\n"),
          }),
        ),
      "root or inside one top-level directory",
    ],
    [
      "non-exact frontmatter closing delimiter",
      () =>
        Buffer.from(
          zipSync({
            "SKILL.md": strToU8("---\nname: review\ndescription: review\n---junk\nBody"),
          }),
        ),
      "YAML frontmatter",
    ],
    [
      "trim-dependent manifest name",
      () =>
        Buffer.from(
          zipSync({
            "SKILL.md": strToU8('---\nname: " review "\ndescription: review\n---\nBody'),
          }),
        ),
      "does not match effective name",
    ],
    [
      "oversized expansion",
      () =>
        makeSkillZip({
          "assets/large.bin": new Uint8Array(25 * 1024 * 1024 + 1),
        }),
      "max size",
    ],
  ])("rejects a %s ZIP without escaping or corrupting the prior target", async (_label, buildZip, reason) => {
    const prior = await reconcileManagedSkills({
      workspace,
      provider: "codex",
      providerSkillRoots: TEST_PROVIDER_SKILL_ROOTS,
      teamSnapshot: authoritativeTeamSkillSnapshot(1, [teamSkill()]),
      bundledSkillsRoot,
    });
    expect(prior.ok).toBe(true);
    const priorMarkdown = readFileSync(`${target(workspace, "codex", "review")}/SKILL.md`, "utf-8");
    const malicious = buildZip();

    const result = await reconcileManagedSkills({
      workspace,
      provider: "codex",
      providerSkillRoots: TEST_PROVIDER_SKILL_ROOTS,
      teamSnapshot: authoritativeTeamSkillSnapshot(2, [bundleSkill(malicious, {}, BUNDLE_ID_B)]),
      bundledSkillsRoot,
      bundleResolver: async () => malicious,
    });

    expect(result.ok).toBe(false);
    expect(result.failures).toContainEqual(
      expect.objectContaining({
        key: "resource:resource-review",
        reason: expect.stringContaining(reason),
      }),
    );
    expect(readFileSync(`${target(workspace, "codex", "review")}/SKILL.md`, "utf-8")).toBe(priorMarkdown);
    expect(existsSync(join(workspace, "escape.txt"))).toBe(false);
    expect(existsSync(join(workspace, "absolute.txt"))).toBe(false);
  });

  it("refuses unowned Core targets and case-insensitive Core collisions", async () => {
    const exact = target(workspace, "codex", "first-tree-read");
    mkdirSync(exact, { recursive: true });
    writeFileSync(join(exact, "SKILL.md"), "user exact target\n");
    const caseVariant = target(workspace, "codex", "FIRST-TREE-WRITE");
    mkdirSync(caseVariant, { recursive: true });
    writeFileSync(join(caseVariant, "SKILL.md"), "user case variant\n");

    const result = await reconcileManagedSkills({
      workspace,
      provider: "codex",
      providerSkillRoots: TEST_PROVIDER_SKILL_ROOTS,
      teamSnapshot: authoritativeTeamSkillSnapshot(1, []),
      bundledSkillsRoot,
    });

    expect(result.failures.map((failure) => failure.key)).toEqual(
      expect.arrayContaining(["core:first-tree-read", "core:first-tree-write"]),
    );
    expect(readFileSync(join(exact, "SKILL.md"), "utf-8")).toBe("user exact target\n");
    expect(readFileSync(join(caseVariant, "SKILL.md"), "utf-8")).toBe("user case variant\n");
    expect(existsSync(join(caseVariant, ".first-tree-managed.json"))).toBe(false);
  });

  it("allocates around unmanaged targets that collide under expanded Unicode case-folding", async () => {
    const unmanaged = target(workspace, "codex", "ſkill");
    mkdirSync(unmanaged, { recursive: true });
    writeFileSync(join(unmanaged, "user-owned.txt"), "preserve me\n");

    const result = await reconcileManagedSkills({
      workspace,
      provider: "codex",
      providerSkillRoots: TEST_PROVIDER_SKILL_ROOTS,
      teamSnapshot: authoritativeTeamSkillSnapshot(1, [teamSkill({ resourceId: "resource-skill", name: "skill" })]),
      bundledSkillsRoot,
    });

    expect(foldPortableTeamSkillPath("ſkill")).toBe(foldPortableTeamSkillPath("skill"));
    expect(result.teamSkills).toContainEqual(
      expect.objectContaining({
        key: "resource:resource-skill",
        name: "skill-first-tree",
        target: ".agents/skills/skill-first-tree",
      }),
    );
    expect(readFileSync(join(unmanaged, "user-owned.txt"), "utf-8")).toBe("preserve me\n");
    expect(existsSync(target(workspace, "codex", "skill-first-tree"))).toBe(true);
  });

  it("repairs installed-tree drift containing uppercase sharp-S case-fold collisions", async () => {
    const skill = teamSkill();
    await reconcileManagedSkills({
      workspace,
      provider: "codex",
      providerSkillRoots: TEST_PROVIDER_SKILL_ROOTS,
      teamSnapshot: authoritativeTeamSkillSnapshot(1, [skill]),
      bundledSkillsRoot,
    });
    const installed = target(workspace, "codex", "review");
    const references = join(installed, "references");
    mkdirSync(join(references, "ẞ"), { recursive: true });
    writeFileSync(join(references, "ẞ", "sharp-s.txt"), "sharp s\n");
    mkdirSync(join(references, "SS"), { recursive: true });
    writeFileSync(join(references, "SS", "ascii-ss.txt"), "ascii ss\n");
    const preservedSpellings = readdirSync(references);
    const logs: string[] = [];

    const repaired = await reconcileManagedSkills({
      workspace,
      provider: "codex",
      providerSkillRoots: TEST_PROVIDER_SKILL_ROOTS,
      teamSnapshot: authoritativeTeamSkillSnapshot(1, [skill]),
      bundledSkillsRoot,
      log: (message) => logs.push(message),
    });

    expect(repaired.installed).toContain("resource:resource-review");
    expect(existsSync(references)).toBe(false);
    if (preservedSpellings.includes("ẞ") && preservedSpellings.includes("SS")) {
      expect(logs.some((message) => message.includes("case-insensitive path collision"))).toBe(true);
    } else {
      // Case-insensitive APFS merges the spellings before Node can enumerate
      // both; the shared key still proves the same collision contract used by
      // the digest path on case-sensitive hosts.
      expect(foldPortableTeamSkillPath("ẞ")).toBe(foldPortableTeamSkillPath("SS"));
    }
  });

  it("rejects reserved, path-bearing, and Windows-device Team names without removing prior good targets", async () => {
    const initial = await reconcileManagedSkills({
      workspace,
      provider: "codex",
      providerSkillRoots: TEST_PROVIDER_SKILL_ROOTS,
      teamSnapshot: authoritativeTeamSkillSnapshot(1, [teamSkill()]),
      bundledSkillsRoot,
    });
    expect(initial.ok).toBe(true);

    const result = await reconcileManagedSkills({
      workspace,
      provider: "codex",
      providerSkillRoots: TEST_PROVIDER_SKILL_ROOTS,
      teamSnapshot: authoritativeTeamSkillSnapshot(2, [
        teamSkill({ name: "first-tree-read" }),
        teamSkill({ resourceId: "resource-path", name: "../escape" }),
        teamSkill({ resourceId: "resource-device", name: "CON" }),
      ]),
      bundledSkillsRoot,
    });

    expect(result.ok).toBe(false);
    expect(result.failures.map((failure) => failure.key)).toEqual(
      expect.arrayContaining(["resource:resource-review", "resource:resource-path", "resource:resource-device"]),
    );
    expect(existsSync(target(workspace, "codex", "review"))).toBe(true);
    expect(existsSync(join(workspace, "escape"))).toBe(false);
  });

  it("rejects duplicate Team resource ids as an ambiguous snapshot and preserves the prior target", async () => {
    await reconcileManagedSkills({
      workspace,
      provider: "codex",
      providerSkillRoots: TEST_PROVIDER_SKILL_ROOTS,
      teamSnapshot: authoritativeTeamSkillSnapshot(1, [teamSkill()]),
      bundledSkillsRoot,
    });

    const result = await reconcileManagedSkills({
      workspace,
      provider: "codex",
      providerSkillRoots: TEST_PROVIDER_SKILL_ROOTS,
      teamSnapshot: authoritativeTeamSkillSnapshot(2, [
        teamSkill({ name: "Review A" }),
        teamSkill({ name: "Review B", body: "different" }),
      ]),
      bundledSkillsRoot,
    });

    expect(result.failures).toContainEqual({
      key: "resource:resource-review",
      reason: "duplicate resourceId in authoritative snapshot",
    });
    expect(result.teamSkills).toEqual([]);
    expect(readFileSync(join(target(workspace, "codex", "review"), "SKILL.md"), "utf-8")).toContain(
      "Check correctness first.",
    );
  });

  it("migrates only v1 targets with conservative ownership proof", async () => {
    const agentsRead = target(workspace, "codex", "first-tree-read");
    mkdirSync(join(workspace, ".agents", "skills"), { recursive: true });
    cpSync(join(bundledSkillsRoot, "first-tree-read"), agentsRead, { recursive: true });
    mkdirSync(join(workspace, ".claude", "skills"), { recursive: true });
    symlinkSync("../../.agents/skills/first-tree-read", join(workspace, ".claude", "skills", "first-tree-read"));

    const userWrite = target(workspace, "codex", "first-tree-write");
    mkdirSync(userWrite, { recursive: true });
    writeFileSync(join(userWrite, "SKILL.md"), "unowned same-name user Skill\n");
    writeLegacyState(workspace, []);

    const result = await reconcileManagedSkills({
      workspace,
      provider: "codex",
      providerSkillRoots: TEST_PROVIDER_SKILL_ROOTS,
      teamSnapshot: authoritativeTeamSkillSnapshot(1, []),
      bundledSkillsRoot,
    });

    expect(result.installed).toContain("core:first-tree-read");
    expect(result.failures.map((failure) => failure.key)).toContain("core:first-tree-write");
    expect(JSON.parse(readFileSync(join(agentsRead, ".first-tree-managed.json"), "utf-8"))).toMatchObject({
      key: "core:first-tree-read",
    });
    expect(readFileSync(join(userWrite, "SKILL.md"), "utf-8")).toBe("unowned same-name user Skill\n");
    expect(existsSync(join(workspace, ".claude", "skills", "first-tree-read"))).toBe(false);
    expect(readManagedStateResult(workspace)).toMatchObject({ kind: "current" });
  });

  it.skipIf(process.platform === "win32")(
    "reprojects a v1-owned Core target with legacy npm write modes before publication",
    async () => {
      const skillName = "first-tree-read";
      const bundledRoot = join(bundledSkillsRoot, skillName);
      const bundledExecutable = join(bundledRoot, "run.sh");
      writeFileSync(bundledExecutable, "#!/bin/sh\necho legacy\n");
      chmodSync(bundledExecutable, 0o755);

      const legacyTarget = target(workspace, "codex", skillName);
      mkdirSync(dirname(legacyTarget), { recursive: true });
      cpSync(bundledRoot, legacyTarget, { recursive: true });
      chmodSync(legacyTarget, 0o775);
      chmodSync(join(legacyTarget, "references"), 0o775);
      chmodSync(join(legacyTarget, "SKILL.md"), 0o664);
      chmodSync(join(legacyTarget, "VERSION"), 0o664);
      chmodSync(join(legacyTarget, "references", "guide.md"), 0o664);
      chmodSync(join(legacyTarget, "run.sh"), 0o775);
      writeLegacyState(workspace, [skillName]);

      const result = await reconcileManagedSkills({
        workspace,
        provider: "codex",
        providerSkillRoots: TEST_PROVIDER_SKILL_ROOTS,
        teamSnapshot: authoritativeTeamSkillSnapshot(1, []),
        bundledSkillsRoot,
      });

      expect(result.ok, JSON.stringify(result.failures)).toBe(true);
      expect(result.installed).toContain(`core:${skillName}`);
      expect(lstatSync(legacyTarget).mode & 0o777).toBe(0o700);
      expect(lstatSync(join(legacyTarget, "references")).mode & 0o777).toBe(0o700);
      expect(lstatSync(join(legacyTarget, "SKILL.md")).mode & 0o777).toBe(0o600);
      expect(lstatSync(join(legacyTarget, "VERSION")).mode & 0o777).toBe(0o600);
      expect(lstatSync(join(legacyTarget, "references", "guide.md")).mode & 0o777).toBe(0o600);
      expect(lstatSync(join(legacyTarget, "run.sh")).mode & 0o777).toBe(0o700);
      expect(lstatSync(join(legacyTarget, ".first-tree-managed.json")).mode & 0o777).toBe(0o600);
      expect(JSON.parse(readFileSync(join(legacyTarget, ".first-tree-managed.json"), "utf-8"))).toMatchObject({
        key: `core:${skillName}`,
      });
      const state = readManagedState(workspace);
      expect(state).not.toBeNull();
      expect(state?.skills).toContainEqual(
        expect.objectContaining({
          key: `core:${skillName}`,
          target: `.agents/skills/${skillName}`,
        }),
      );
    },
  );

  it.skipIf(process.platform === "win32")(
    "preserves an unowned unsafe Core-name target and reports its full managed path",
    async () => {
      const skillName = "first-tree-write";
      const userTarget = target(workspace, "codex", skillName);
      mkdirSync(userTarget, { recursive: true });
      writeFileSync(join(userTarget, "SKILL.md"), "unowned same-name user Skill\n");
      chmodSync(userTarget, 0o775);
      chmodSync(join(userTarget, "SKILL.md"), 0o664);
      writeLegacyState(workspace, []);

      let thrown: unknown;
      try {
        await reconcileManagedSkills({
          workspace,
          provider: "codex",
          providerSkillRoots: TEST_PROVIDER_SKILL_ROOTS,
          teamSnapshot: authoritativeTeamSkillSnapshot(1, []),
          bundledSkillsRoot,
        });
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBeInstanceOf(ManagedSkillsUnsafeDiscoveryError);
      expect(thrown).toMatchObject({
        cause: expect.objectContaining({
          message: expect.stringContaining(`Managed Skill target .agents/skills/${skillName}`),
        }),
      });
      expect(readFileSync(join(userTarget, "SKILL.md"), "utf-8")).toBe("unowned same-name user Skill\n");
      expect(lstatSync(userTarget).mode & 0o777).toBe(0o775);
      expect(lstatSync(join(userTarget, "SKILL.md")).mode & 0o777).toBe(0o664);
      expect(existsSync(join(userTarget, ".first-tree-managed.json"))).toBe(false);
    },
  );

  it.skipIf(process.platform === "win32")(
    "reprojects an unsafe exact-bundle Core target without marker, ledger entry, or pair",
    async () => {
      const skillName = "first-tree-seed";
      const bundledRoot = join(bundledSkillsRoot, skillName);
      const legacyTarget = target(workspace, "codex", skillName);
      mkdirSync(dirname(legacyTarget), { recursive: true });
      cpSync(bundledRoot, legacyTarget, { recursive: true });
      chmodSync(legacyTarget, 0o775);
      chmodSync(join(legacyTarget, "references"), 0o775);
      chmodSync(join(legacyTarget, "SKILL.md"), 0o664);
      chmodSync(join(legacyTarget, "VERSION"), 0o664);
      chmodSync(join(legacyTarget, "references", "guide.md"), 0o664);
      writeLegacyState(workspace, []);

      const result = await reconcileManagedSkills({
        workspace,
        provider: "codex",
        providerSkillRoots: TEST_PROVIDER_SKILL_ROOTS,
        teamSnapshot: authoritativeTeamSkillSnapshot(1, []),
        bundledSkillsRoot,
      });

      expect(result.ok, JSON.stringify(result.failures)).toBe(true);
      expect(result.installed).toContain(`core:${skillName}`);
      expect(lstatSync(legacyTarget).mode & 0o777).toBe(0o700);
      expect(lstatSync(join(legacyTarget, "references")).mode & 0o777).toBe(0o700);
      expect(lstatSync(join(legacyTarget, "SKILL.md")).mode & 0o777).toBe(0o600);
      expect(lstatSync(join(legacyTarget, "VERSION")).mode & 0o777).toBe(0o600);
      expect(lstatSync(join(legacyTarget, "references", "guide.md")).mode & 0o777).toBe(0o600);
      expect(JSON.parse(readFileSync(join(legacyTarget, ".first-tree-managed.json"), "utf-8"))).toMatchObject({
        key: `core:${skillName}`,
      });
    },
  );

  it("rejects a symlink inside a v1-owned Core target without mutating it", async () => {
    const skillName = "first-tree-read";
    const legacyTarget = target(workspace, "codex", skillName);
    mkdirSync(dirname(legacyTarget), { recursive: true });
    cpSync(join(bundledSkillsRoot, skillName), legacyTarget, { recursive: true });
    const linkedGuide = join(legacyTarget, "references", "guide.md");
    rmSync(linkedGuide);
    symlinkSync("../SKILL.md", linkedGuide);
    writeLegacyState(workspace, [skillName]);

    let thrown: unknown;
    try {
      await reconcileManagedSkills({
        workspace,
        provider: "codex",
        providerSkillRoots: TEST_PROVIDER_SKILL_ROOTS,
        teamSnapshot: authoritativeTeamSkillSnapshot(1, []),
        bundledSkillsRoot,
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(ManagedSkillsUnsafeDiscoveryError);
    expect(thrown).toMatchObject({
      cause: expect.objectContaining({
        message: expect.stringContaining(`Managed Skill target .agents/skills/${skillName}`),
      }),
    });
    expect(lstatSync(linkedGuide).isSymbolicLink()).toBe(true);
    expect(existsSync(join(legacyTarget, ".first-tree-managed.json"))).toBe(false);
  });

  it.skipIf(process.platform === "win32")(
    "rejects a special file inside a v1-owned Core target without mutating it",
    async () => {
      const skillName = "first-tree-read";
      const legacyTarget = target(workspace, "codex", skillName);
      mkdirSync(dirname(legacyTarget), { recursive: true });
      cpSync(join(bundledSkillsRoot, skillName), legacyTarget, { recursive: true });
      const fifo = join(legacyTarget, "references", "legacy.fifo");
      execFileSync("mkfifo", [fifo]);
      writeLegacyState(workspace, [skillName]);

      let thrown: unknown;
      try {
        await reconcileManagedSkills({
          workspace,
          provider: "codex",
          providerSkillRoots: TEST_PROVIDER_SKILL_ROOTS,
          teamSnapshot: authoritativeTeamSkillSnapshot(1, []),
          bundledSkillsRoot,
        });
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBeInstanceOf(ManagedSkillsUnsafeDiscoveryError);
      expect(thrown).toMatchObject({
        cause: expect.objectContaining({
          message: expect.stringContaining(`Managed Skill target .agents/skills/${skillName}`),
        }),
      });
      expect(lstatSync(fifo).isFIFO()).toBe(true);
      expect(existsSync(join(legacyTarget, ".first-tree-managed.json"))).toBe(false);
    },
  );

  it("does not follow a legacy managed-name symlink outside the workspace", async () => {
    const outside = join(sandbox, "outside-user-skill");
    mkdirSync(outside, { recursive: true });
    writeFileSync(join(outside, "SKILL.md"), "outside user content\n");
    const linkedTarget = target(workspace, "codex", "first-tree-seed");
    mkdirSync(join(workspace, ".agents", "skills"), { recursive: true });
    symlinkSync(outside, linkedTarget);
    writeLegacyState(workspace, ["first-tree-seed"]);

    const result = await reconcileManagedSkills({
      workspace,
      provider: "codex",
      providerSkillRoots: TEST_PROVIDER_SKILL_ROOTS,
      teamSnapshot: authoritativeTeamSkillSnapshot(1, []),
      bundledSkillsRoot,
    });

    expect(result.failures.map((failure) => failure.key)).toContain("core:first-tree-seed");
    expect(readFileSync(join(outside, "SKILL.md"), "utf-8")).toBe("outside user content\n");
    expect(existsSync(linkedTarget)).toBe(true);
  });

  it.each([
    ["provider discovery root", ".agents/skills"],
    ["managed runtime root", ".first-tree-workspace"],
  ] as const)("fails closed before mutation when the %s is a symlink", async (_label, linkedRoot) => {
    const outside = join(sandbox, `outside-${linkedRoot.replaceAll("/", "-")}`);
    mkdirSync(outside, { recursive: true });
    writeFileSync(join(outside, "user-owned.txt"), "preserve\n");
    if (linkedRoot === ".agents/skills") {
      mkdirSync(join(workspace, ".agents"), { recursive: true });
    }
    symlinkSync(outside, join(workspace, linkedRoot));

    const reconcile = reconcileManagedSkills({
      workspace,
      provider: "codex",
      providerSkillRoots: TEST_PROVIDER_SKILL_ROOTS,
      teamSnapshot: authoritativeTeamSkillSnapshot(1, []),
      bundledSkillsRoot,
    });

    if (linkedRoot === ".agents/skills") {
      await expect(reconcile).rejects.toBeInstanceOf(ManagedSkillsUnsafeDiscoveryError);
    } else {
      const result = await reconcile;
      expect(result.ok).toBe(false);
      expect(result.failures).toEqual([
        expect.objectContaining({
          key: "workspace",
          reason: expect.stringContaining("symlinked managed ancestor"),
        }),
      ]);
    }
    expect(readdirSync(outside)).toEqual(["user-owned.txt"]);
    expect(readFileSync(join(outside, "user-owned.txt"), "utf-8")).toBe("preserve\n");
  });

  it("adopts an exact legacy Team materialization before moving it to the provider root", async () => {
    const skill = teamSkill({ resourceId: "Resource_ABC" });
    const legacyRoot = join(workspace, ".first-tree", "resources", "skills", skill.resourceId);
    mkdirSync(legacyRoot, { recursive: true });
    writeFileSync(
      join(legacyRoot, "SKILL.md"),
      [
        "---",
        `name: ${JSON.stringify(skill.name)}`,
        `description: ${JSON.stringify(skill.description)}`,
        `metadata: ${JSON.stringify(skill.metadata)}`,
        "---",
        "",
        skill.body,
        "",
      ].join("\n"),
    );

    const result = await reconcileManagedSkills({
      workspace,
      provider: "codex",
      providerSkillRoots: TEST_PROVIDER_SKILL_ROOTS,
      teamSnapshot: authoritativeTeamSkillSnapshot(3, [skill]),
      bundledSkillsRoot,
    });

    expect(result.ok, JSON.stringify(result.failures)).toBe(true);
    expect(existsSync(target(workspace, "codex", "review"))).toBe(true);
    expect(existsSync(legacyRoot)).toBe(false);
    expect(result.removed).toContain("resource:Resource_ABC@.first-tree/resources/skills/Resource_ABC");
  });

  it.each([
    ["future", { schemaVersion: 99 }],
    ["corrupt", "{not json"],
  ] as const)("fails closed when managed state is %s", async (_label, rawState) => {
    mkdirSync(join(workspace, ".first-tree-workspace"), { recursive: true });
    writeFileSync(
      join(workspace, MANAGED_STATE_REL),
      typeof rawState === "string" ? rawState : JSON.stringify(rawState),
    );

    const result = await reconcileManagedSkills({
      workspace,
      provider: "codex",
      providerSkillRoots: TEST_PROVIDER_SKILL_ROOTS,
      teamSnapshot: authoritativeTeamSkillSnapshot(2, [teamSkill()]),
      bundledSkillsRoot,
    });

    expect(result.ok).toBe(false);
    expect(result.failures[0]?.key).toBe("workspace");
    expect(existsSync(join(workspace, ".agents", "skills"))).toBe(false);
    expect(readFileSync(join(workspace, MANAGED_STATE_REL), "utf-8")).toBe(
      typeof rawState === "string" ? rawState : JSON.stringify(rawState),
    );
  });

  it.each([
    ["invalid state", MANAGED_STATE_REL, "{not json"],
    ["future journal", MANAGED_SKILLS_JOURNAL_REL, JSON.stringify({ schemaVersion: 99 })],
  ] as const)("blocks provider preflight when %s hides an existing managed target", async (_label, path, contents) => {
    await reconcileManagedSkills({
      workspace,
      provider: "codex",
      providerSkillRoots: TEST_PROVIDER_SKILL_ROOTS,
      teamSnapshot: authoritativeTeamSkillSnapshot(1, [teamSkill()]),
      bundledSkillsRoot,
    });
    const installed = target(workspace, "codex", "review");
    writeFileSync(join(workspace, path), contents);

    await expect(
      reconcileManagedSkills({
        workspace,
        provider: "codex",
        providerSkillRoots: TEST_PROVIDER_SKILL_ROOTS,
        teamSnapshot: authoritativeTeamSkillSnapshot(1, [teamSkill()]),
        bundledSkillsRoot,
      }),
    ).rejects.toBeInstanceOf(ManagedSkillsUnsafeDiscoveryError);
    expect(existsSync(installed)).toBe(true);
  });

  it("blocks provider preflight when the existing discovery root cannot be enumerated before final verification", async () => {
    await reconcileManagedSkills({
      workspace,
      provider: "codex",
      providerSkillRoots: TEST_PROVIDER_SKILL_ROOTS,
      teamSnapshot: authoritativeTeamSkillSnapshot(1, [teamSkill()]),
      bundledSkillsRoot,
    });

    await expect(
      reconcileManagedSkills({
        workspace,
        provider: "codex",
        providerSkillRoots: TEST_PROVIDER_SKILL_ROOTS,
        teamSnapshot: authoritativeTeamSkillSnapshot(1, [teamSkill()]),
        bundledSkillsRoot,
        testFailureAt: "provider_root_read",
      }),
    ).rejects.toBeInstanceOf(ManagedSkillsUnsafeDiscoveryError);
    expect(existsSync(target(workspace, "codex", "review"))).toBe(true);
  });

  it("blocks provider preflight when startup journal recovery hits an ordinary filesystem ambiguity", async () => {
    await reconcileManagedSkills({
      workspace,
      provider: "codex",
      providerSkillRoots: TEST_PROVIDER_SKILL_ROOTS,
      teamSnapshot: authoritativeTeamSkillSnapshot(1, []),
      bundledSkillsRoot,
    });
    const v2Root = writeCoreBundle(sandbox, "2.0.0", "journal-ambiguity");
    await reconcileManagedSkills({
      workspace,
      provider: "codex",
      providerSkillRoots: TEST_PROVIDER_SKILL_ROOTS,
      teamSnapshot: authoritativeTeamSkillSnapshot(2, []),
      bundledSkillsRoot: v2Root,
      testCrashAt: "prepared",
    });
    expect(existsSync(join(workspace, MANAGED_SKILLS_JOURNAL_REL))).toBe(true);

    await expect(
      reconcileManagedSkills({
        workspace,
        provider: "codex",
        providerSkillRoots: TEST_PROVIDER_SKILL_ROOTS,
        teamSnapshot: authoritativeTeamSkillSnapshot(2, []),
        bundledSkillsRoot: v2Root,
        testFailureAt: "journal_recovery",
      }),
    ).rejects.toBeInstanceOf(ManagedSkillsUnsafeDiscoveryError);
    expect(existsSync(join(workspace, MANAGED_SKILLS_JOURNAL_REL))).toBe(true);
  });

  it.each([
    "prepared",
    "target_backed_up",
    "target_installed",
    "state_committed",
    "backup_cleaned",
  ] satisfies readonly ManagedSkillsCheckpoint[])("recovers an interrupted install/update at %s", async (checkpoint) => {
    await reconcileManagedSkills({
      workspace,
      provider: "codex",
      providerSkillRoots: TEST_PROVIDER_SKILL_ROOTS,
      teamSnapshot: authoritativeTeamSkillSnapshot(1, []),
      bundledSkillsRoot,
    });
    const v2Root = writeCoreBundle(sandbox, "2.0.0", `v2-${checkpoint}`);
    const interrupted = await reconcileManagedSkills({
      workspace,
      provider: "codex",
      providerSkillRoots: TEST_PROVIDER_SKILL_ROOTS,
      teamSnapshot: authoritativeTeamSkillSnapshot(2, []),
      bundledSkillsRoot: v2Root,
      testCrashAt: checkpoint,
    });
    expect(interrupted.ok).toBe(false);
    expect(existsSync(join(workspace, MANAGED_SKILLS_JOURNAL_REL))).toBe(true);

    const recovered = await reconcileManagedSkills({
      workspace,
      provider: "codex",
      providerSkillRoots: TEST_PROVIDER_SKILL_ROOTS,
      teamSnapshot: authoritativeTeamSkillSnapshot(2, []),
      bundledSkillsRoot: v2Root,
    });
    expect(recovered.ok, JSON.stringify(recovered.failures)).toBe(true);
    expect(readFileSync(`${target(workspace, "codex", CORE_SKILL_NAMES[0])}/VERSION`, "utf-8")).toBe("2.0.0\n");
    expect(existsSync(join(workspace, MANAGED_SKILLS_JOURNAL_REL))).toBe(false);
  });

  it.each([
    "prepared",
    "target_backed_up",
    "state_committed",
    "backup_cleaned",
  ] satisfies readonly ManagedSkillsCheckpoint[])("recovers an interrupted revoke at %s", async (checkpoint) => {
    await reconcileManagedSkills({
      workspace,
      provider: "codex",
      providerSkillRoots: TEST_PROVIDER_SKILL_ROOTS,
      teamSnapshot: authoritativeTeamSkillSnapshot(1, [teamSkill()]),
      bundledSkillsRoot,
    });
    const interrupted = await reconcileManagedSkills({
      workspace,
      provider: "codex",
      providerSkillRoots: TEST_PROVIDER_SKILL_ROOTS,
      teamSnapshot: authoritativeTeamSkillSnapshot(2, []),
      bundledSkillsRoot,
      testCrashAt: checkpoint,
    });
    expect(interrupted.ok).toBe(false);
    expect(existsSync(join(workspace, MANAGED_SKILLS_JOURNAL_REL))).toBe(true);

    const recovered = await reconcileManagedSkills({
      workspace,
      provider: "codex",
      providerSkillRoots: TEST_PROVIDER_SKILL_ROOTS,
      teamSnapshot: authoritativeTeamSkillSnapshot(2, []),
      bundledSkillsRoot,
    });
    expect(recovered.ok, JSON.stringify(recovered.failures)).toBe(true);
    expect(existsSync(target(workspace, "codex", "review"))).toBe(false);
    expect(existsSync(join(workspace, MANAGED_SKILLS_JOURNAL_REL))).toBe(false);
  });

  it("aborts the workspace reconcile and preserves the journal when transaction recovery fails", async () => {
    await expect(
      reconcileManagedSkills({
        workspace,
        provider: "codex",
        providerSkillRoots: TEST_PROVIDER_SKILL_ROOTS,
        teamSnapshot: authoritativeTeamSkillSnapshot(1, []),
        bundledSkillsRoot,
        testFailureAt: "target_installed",
        testRecoveryFailure: true,
      }),
    ).rejects.toBeInstanceOf(ManagedSkillsUnsafeDiscoveryError);
    expect(existsSync(join(workspace, MANAGED_SKILLS_JOURNAL_REL))).toBe(true);
    expect(existsSync(target(workspace, "codex", CORE_SKILL_NAMES[0]))).toBe(true);
    expect(existsSync(target(workspace, "codex", CORE_SKILL_NAMES[1]))).toBe(false);

    const journal = JSON.parse(readFileSync(join(workspace, MANAGED_SKILLS_JOURNAL_REL), "utf-8"));
    expect(journal.target).toBe(`.agents/skills/${CORE_SKILL_NAMES[0]}`);

    const recovered = await reconcileManagedSkills({
      workspace,
      provider: "codex",
      providerSkillRoots: TEST_PROVIDER_SKILL_ROOTS,
      teamSnapshot: authoritativeTeamSkillSnapshot(1, []),
      bundledSkillsRoot,
    });
    expect(recovered.ok, JSON.stringify(recovered.failures)).toBe(true);
    expect(existsSync(join(workspace, MANAGED_SKILLS_JOURNAL_REL))).toBe(false);
    expect(existsSync(target(workspace, "codex", CORE_SKILL_NAMES[1]))).toBe(true);
  });

  it("installs the new provider projection before retiring the previous provider targets", async () => {
    await reconcileManagedSkills({
      workspace,
      provider: "codex",
      providerSkillRoots: TEST_PROVIDER_SKILL_ROOTS,
      teamSnapshot: authoritativeTeamSkillSnapshot(1, [teamSkill()]),
      bundledSkillsRoot,
    });

    const switched = await reconcileManagedSkills({
      workspace,
      provider: "claude-code",
      providerSkillRoots: TEST_PROVIDER_SKILL_ROOTS,
      teamSnapshot: authoritativeTeamSkillSnapshot(1, [teamSkill()]),
      bundledSkillsRoot,
    });

    expect(switched.ok, JSON.stringify(switched.failures)).toBe(true);
    expect(switched.installed).toEqual(expect.arrayContaining(["core:first-tree-read", "resource:resource-review"]));
    expect(switched.removed).toEqual(
      expect.arrayContaining([
        "core:first-tree-read@.agents/skills/first-tree-read",
        "resource:resource-review@.agents/skills/review",
      ]),
    );
    expect(existsSync(target(workspace, "claude-code", "review"))).toBe(true);
    expect(existsSync(target(workspace, "codex", "review"))).toBe(false);
  });

  it("rejects bundled symlinks and leaves the affected Core target absent", async () => {
    const readRoot = join(bundledSkillsRoot, "first-tree-read");
    rmSync(join(readRoot, "references", "guide.md"));
    symlinkSync("../SKILL.md", join(readRoot, "references", "guide.md"));

    const result = await reconcileManagedSkills({
      workspace,
      provider: "codex",
      providerSkillRoots: TEST_PROVIDER_SKILL_ROOTS,
      teamSnapshot: authoritativeTeamSkillSnapshot(1, []),
      bundledSkillsRoot,
    });

    expect(result.failures.map((failure) => failure.key)).toContain("core:first-tree-read");
    expect(existsSync(target(workspace, "codex", "first-tree-read"))).toBe(false);
  });

  it("requires Core VERSION and rejects non-portable bundle paths", async () => {
    rmSync(join(bundledSkillsRoot, "first-tree-read", "VERSION"));
    writeFileSync(join(bundledSkillsRoot, "first-tree-write", "references", "CON.txt"), "not portable to Windows\n");

    const result = await reconcileManagedSkills({
      workspace,
      provider: "codex",
      providerSkillRoots: TEST_PROVIDER_SKILL_ROOTS,
      teamSnapshot: authoritativeTeamSkillSnapshot(1, []),
      bundledSkillsRoot,
    });

    expect(result.failures).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          key: "core:first-tree-read",
          reason: expect.stringContaining("missing VERSION"),
        }),
        expect.objectContaining({
          key: "core:first-tree-write",
          reason: expect.stringContaining("unsafe path segment"),
        }),
      ]),
    );
    expect(existsSync(target(workspace, "codex", "first-tree-read"))).toBe(false);
    expect(existsSync(target(workspace, "codex", "first-tree-write"))).toBe(false);
  });

  it("keeps one persistent regular lock inode across reconciliations", async () => {
    const lockPath = join(workspace, MANAGED_SKILLS_LOCK_REL);

    const first = await reconcileManagedSkills({
      workspace,
      provider: "codex",
      providerSkillRoots: TEST_PROVIDER_SKILL_ROOTS,
      teamSnapshot: authoritativeTeamSkillSnapshot(1, []),
      bundledSkillsRoot,
    });

    expect(first.ok, JSON.stringify(first.failures)).toBe(true);
    const firstStats = lstatSync(lockPath);
    expect(firstStats.isFile()).toBe(true);

    const second = await reconcileManagedSkills({
      workspace,
      provider: "codex",
      providerSkillRoots: TEST_PROVIDER_SKILL_ROOTS,
      teamSnapshot: authoritativeTeamSkillSnapshot(1, []),
      bundledSkillsRoot,
    });

    expect(second.ok, JSON.stringify(second.failures)).toBe(true);
    const secondStats = lstatSync(lockPath);
    expect(secondStats.isFile()).toBe(true);
    expect(secondStats.dev).toBe(firstStats.dev);
    expect(secondStats.ino).toBe(firstStats.ino);
  });

  it("returns an availability failure when the real workspace lock times out against empty discovery", async () => {
    const lockPath = join(workspace, MANAGED_SKILLS_LOCK_REL);
    mkdirSync(dirname(lockPath), { recursive: true });
    const holder = spawnWorkspaceLockWorker(lockPath);
    await holder.waitForLine("acquired");
    try {
      const result = await reconcileManagedSkills({
        workspace,
        provider: "codex",
        providerSkillRoots: TEST_PROVIDER_SKILL_ROOTS,
        teamSnapshot: authoritativeTeamSkillSnapshot(1, []),
        bundledSkillsRoot,
        lockTimeoutMs: 50,
      });
      expect(result.ok).toBe(false);
      expect(result.failures).toContainEqual({
        key: "workspace",
        reason: expect.stringContaining("timed out waiting for managed skills workspace lock"),
      });
      expect(existsSync(join(workspace, providerSkillRoot("codex", TEST_PROVIDER_SKILL_ROOTS)))).toBe(false);
    } finally {
      holder.child.stdin.end("release\n");
      const holderExit = await holder.waitForExit();
      expect(holderExit, holder.stderr()).toEqual({ code: 0, signal: null });
    }
  });

  it("blocks provider preflight when the real workspace lock times out against nonempty discovery", async () => {
    const bundle = makeSkillZip({ "scripts/run.sh": strToU8("#!/bin/sh\necho safe\n") });
    const skill = bundleSkill(bundle);
    const first = await reconcileManagedSkills({
      workspace,
      provider: "codex",
      providerSkillRoots: TEST_PROVIDER_SKILL_ROOTS,
      teamSnapshot: authoritativeTeamSkillSnapshot(1, [skill]),
      bundledSkillsRoot,
      bundleResolver: async () => bundle,
    });
    expect(first.ok, JSON.stringify(first.failures)).toBe(true);

    const lockPath = join(workspace, MANAGED_SKILLS_LOCK_REL);
    const holder = spawnWorkspaceLockWorker(lockPath);
    await holder.waitForLine("acquired");
    try {
      await expect(
        reconcileManagedSkills({
          workspace,
          provider: "codex",
          providerSkillRoots: TEST_PROVIDER_SKILL_ROOTS,
          teamSnapshot: authoritativeTeamSkillSnapshot(1, [skill]),
          bundledSkillsRoot,
          bundleResolver: async () => {
            throw new Error("lock timeout must happen before bundle resolution");
          },
          lockTimeoutMs: 50,
        }),
      ).rejects.toBeInstanceOf(ManagedSkillsUnsafeDiscoveryError);
      expect(existsSync(target(workspace, "codex", "review"))).toBe(true);
      expect(existsSync(target(workspace, "codex", "first-tree-read"))).toBe(true);
    } finally {
      holder.child.stdin.end("release\n");
      const holderExit = await holder.waitForExit();
      expect(holderExit, holder.stderr()).toEqual({ code: 0, signal: null });
    }
  });
});
