import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI_ROOT = resolve(HERE, "../..");
const REPO_ROOT = resolve(CLI_ROOT, "../..");

function readText(path: string): string {
  return readFileSync(path, "utf-8");
}

function readJson(path: string): unknown {
  return JSON.parse(readText(path));
}

function packageFiles(value: unknown): string[] {
  if (
    typeof value !== "object" ||
    value === null ||
    !("files" in value) ||
    !Array.isArray(value.files) ||
    !value.files.every((entry) => typeof entry === "string")
  ) {
    throw new Error("apps/cli/package.json must declare a string[] files list");
  }
  return value.files;
}

function packageDependencies(value: unknown): Record<string, string> {
  if (
    typeof value !== "object" ||
    value === null ||
    !("dependencies" in value) ||
    typeof value.dependencies !== "object" ||
    value.dependencies === null ||
    Array.isArray(value.dependencies) ||
    !Object.values(value.dependencies).every((entry) => typeof entry === "string")
  ) {
    throw new Error("apps/cli/package.json must declare a string-valued dependencies object");
  }
  return value.dependencies as Record<string, string>;
}

describe("npm package metadata", () => {
  it("includes package-root documentation and license files in the tarball allow-list", () => {
    const files = packageFiles(readJson(join(CLI_ROOT, "package.json")));

    expect(files).toEqual(expect.arrayContaining(["dist", "README.md", "LICENSE"]));
  });

  it("keeps a package-local README for the npm registry page", () => {
    const readmePath = join(CLI_ROOT, "README.md");

    expect(existsSync(readmePath)).toBe(true);

    const readme = readText(readmePath);

    expect(readme).toContain(
      "curl -fsSL --proto '=https' --proto-redir '=https' https://download.first-tree.ai/releases/prod/install.sh | sh",
    );
    expect(readme).toContain("~/.local/bin/first-tree login <connect-code>");
    expect(readme).toContain(
      "curl -fsSL --proto '=https' --proto-redir '=https' https://download.first-tree.ai/releases/staging/install.sh | sh",
    );
    expect(readme).toContain("~/.local/bin/first-tree-staging login <connect-code>");
    expect(readme).not.toContain("npm install -g first-tree");
    expect(readme).toContain("https://github.com/agent-team-foundation/first-tree/blob/main/docs/cli-reference.md");
    expect(readme).toContain("Apache-2.0");
  });

  it("ships the Apache-2.0 license text at the package root", () => {
    const licensePath = join(CLI_ROOT, "LICENSE");

    expect(existsSync(licensePath)).toBe(true);
    expect(readText(licensePath)).toBe(readText(join(REPO_ROOT, "LICENSE")));
    expect(readText(licensePath)).toContain("Apache License");
    expect(readText(licensePath)).toContain("Version 2.0, January 2004");
  });

  it("installs the external native workspace-lock addon with the published CLI", () => {
    const dependencies = packageDependencies(readJson(join(CLI_ROOT, "package.json")));

    expect(dependencies["fs-native-extensions"]).toBe("^1.5.0");
  });

  it("bundles the patched Kimi SDK and declares its runtime dependencies for consumers", () => {
    const pkg = readJson(join(CLI_ROOT, "package.json")) as Record<string, unknown>;
    // The workspace pins the Kimi SDK through a pnpm patch (see
    // pnpm-workspace.yaml). npm consumers cannot apply that patch, so the
    // tarball must carry the patched artifact as a bundled dependency, and
    // the SDK's own runtime deps must be regular CLI dependencies so the
    // bundled copy resolves them from the consumer's top-level node_modules.
    expect(pkg.bundleDependencies).toEqual([
      "@botiverse/kimi-code-sdk",
      "@deepseek-ai/dsh-agent-spine-demo",
      "@deepseek-ai/dsh-bash-local",
      "@deepseek-ai/dsh-fs-local",
      "@deepseek-ai/dsh-llm-deepseek",
      "@deepseek-ai/dsh-sdk-client",
      "@deepseek-ai/dsh-sdk-jsonrpc-demo",
      "@deepseek-ai/dsh-sdk-jsonrpc-server",
      "@deepseek-ai/dsh-sdk-protocol",
      "@deepseek-ai/dsh-session",
      "@deepseek-ai/dsh-session-persistence-jsonl",
    ]);
    const dependencies = packageDependencies(pkg);
    for (const sdkRuntimeDep of ["@antfu/utils", "smol-toml", "yazl"]) {
      expect(dependencies[sdkRuntimeDep]).toBeDefined();
    }
    expect(dependencies["@botiverse/kimi-code-sdk"]).toBe("0.26.0-botiverse.2");
    for (const deepseekPkg of [
      "@deepseek-ai/dsh-agent-spine-demo",
      "@deepseek-ai/dsh-bash-local",
      "@deepseek-ai/dsh-fs-local",
      "@deepseek-ai/dsh-llm-deepseek",
      "@deepseek-ai/dsh-sdk-client",
      "@deepseek-ai/dsh-sdk-jsonrpc-demo",
      "@deepseek-ai/dsh-sdk-jsonrpc-server",
      "@deepseek-ai/dsh-sdk-protocol",
      "@deepseek-ai/dsh-session",
      "@deepseek-ai/dsh-session-persistence-jsonl",
    ]) {
      expect(dependencies[deepseekPkg]).toBeDefined();
    }
    // dsh-sdk-client imports this peer at module load; without it the packed
    // CLI fails `first-tree-dev --version` with ERR_MODULE_NOT_FOUND.
    expect(dependencies["@deepseek-ai/dsh-sdk-protocol"]).toBe("0.0.1-rc.5");
  });
});

describe("workspace dependency-patch distribution", () => {
  it("copies the pnpm patch files into the Docker dependency stage before install", () => {
    const dockerfile = readText(join(REPO_ROOT, "Dockerfile"));
    const copyPatches = dockerfile.indexOf("COPY patches/ patches/");
    const install = dockerfile.indexOf("pnpm install --frozen-lockfile");
    expect(copyPatches).toBeGreaterThan(-1);
    expect(install).toBeGreaterThan(-1);
    expect(copyPatches).toBeLessThan(install);
  });

  it("points every patchedDependencies entry at a patch file that exists and ships to Docker", () => {
    const workspaceYaml = readText(join(REPO_ROOT, "pnpm-workspace.yaml"));
    const match = workspaceYaml.match(/patchedDependencies:\n((?:[ \t]+\S.*\n?)+)/);
    expect(match).not.toBeNull();
    if (!match) throw new Error("patchedDependencies block missing from pnpm-workspace.yaml");
    const entries = [...match[1].matchAll(/^\s+(['"]?)([^'":]+)\1:\s*(.+?)\s*$/gm)];
    expect(entries.length).toBeGreaterThan(0);
    const dockerignore = readText(join(REPO_ROOT, ".dockerignore"));
    for (const entry of entries) {
      const patchPath = entry[3];
      expect(patchPath.startsWith("patches/")).toBe(true);
      expect(existsSync(join(REPO_ROOT, patchPath))).toBe(true);
    }
    expect(dockerignore).not.toMatch(/^patches\/?$/m);
  });
});

describe("trusted-publishing npm toolchain contract", () => {
  const PUBLISH_WORKFLOW = join(REPO_ROOT, ".github", "workflows", "publish-npm-package.yml");
  const CI_WORKFLOW = join(REPO_ROOT, ".github", "workflows", "ci.yml");

  it("pins every trusted-publishing npm install to the exact QA-qualified version, with no moving selector", () => {
    const workflow = readText(PUBLISH_WORKFLOW);
    const installs = [...workflow.matchAll(/npm install -g npm@(\S+)/g)].map((match) => match[1]);
    // prod CLI, staging CLI, and shared alpha must all be covered.
    expect(installs.length).toBeGreaterThanOrEqual(3);
    for (const selector of installs) {
      expect(selector).toBe("11.5.1");
    }
    expect(workflow).not.toMatch(/npm@(latest|next|\^|~)/);
  });

  it("runs a real release-pack smoke under the pinned client on CLI-affecting PRs", () => {
    const ci = readText(CI_WORKFLOW);
    expect(ci).toContain("npm install -g npm@11.5.1");
    // Heavy turbo cache + real pack smoke stays a shell step outside Vitest
    // (same class of failure as building dist inside beforeAll).
    expect(ci).toContain("node scripts/release-pack-smoke.mjs selftest-turbo-context-integration-cache");
    expect(ci).toContain("Release pack smoke (bundled Kimi SDK + turbo context-integration cache)");
    // Do not also run the default smoke in the same job — the selftest already
    // ends in runSmoke() (pack → consumer → bundled SDK).
    expect(ci).not.toMatch(/^\s*run:\s*node scripts\/release-pack-smoke\.mjs\s*$/m);
    expect(existsSync(join(REPO_ROOT, "scripts", "release-pack-smoke.mjs"))).toBe(true);

    const smoke = readText(join(REPO_ROOT, "scripts", "release-pack-smoke.mjs"));
    // Prove the CI-selected selftest does not bypass the real release smoke.
    const cacheFnStart = smoke.indexOf("function selftestTurboContextIntegrationCache()");
    const mainFnStart = smoke.indexOf("\nfunction main()");
    expect(cacheFnStart).toBeGreaterThanOrEqual(0);
    expect(mainFnStart).toBeGreaterThan(cacheFnStart);
    const cacheSelftest = smoke.slice(cacheFnStart, mainFnStart);
    expect(cacheSelftest).toContain("runSmoke()");
    expect(cacheSelftest).toContain('turbo.json build.outputs must include "context-integration/**"');
    // This file must not spawn the heavy selftest inside Vitest workers.
    const thisFile = readText(join(HERE, "package-metadata.test.ts"));
    expect(thisFile).not.toMatch(/spawnSync\([\s\S]{0,400}selftest-turbo-context-integration-cache/);
  });

  it("materializes bundled deps around pack so pnpm symlink targets cannot escape the tarball", () => {
    const pkg = readJson(join(CLI_ROOT, "package.json")) as {
      scripts?: Record<string, string>;
    };
    const materialize = join(CLI_ROOT, "scripts", "materialize-bundled-deps.mjs");
    const safety = join(REPO_ROOT, "scripts", "npm-tarball-safety.mjs");
    expect(existsSync(materialize)).toBe(true);
    expect(existsSync(safety)).toBe(true);
    expect(pkg.scripts?.prepack ?? "").toContain("materialize-bundled-deps.mjs prepare");
    expect(pkg.scripts?.prepack ?? "").toContain("copy-skill-payloads.mjs --target skills --clean");
    expect(pkg.scripts?.postpack ?? "").toContain("materialize-bundled-deps.mjs restore");
    // Restore must run before skill cleanup so a failed restore still leaves the
    // workspace symlink graph recoverable by a subsequent prepare/restore.
    const postpack = pkg.scripts?.postpack ?? "";
    expect(postpack.indexOf("materialize-bundled-deps.mjs restore")).toBeLessThan(postpack.indexOf("rm -rf skills"));
    const smoke = readText(join(REPO_ROOT, "scripts", "release-pack-smoke.mjs"));
    expect(smoke).toContain("assertNpmTarballRegistrySafe");
    expect(smoke).toContain("assertTarballContainsLocalSkillVariants");
    expect(smoke).toContain("package/skills/.variants/local-context/first-tree-read/SKILL.md");
    expect(smoke).toContain("package/skills/.variants/local-context/first-tree-write/SKILL.md");
    // Pack into a run-owned destination so the deterministic name/version
    // filename cannot overwrite a pre-existing apps/cli artifact.
    expect(smoke).toContain("--pack-destination");
    // Incomplete Turbo cache restores (dist-only) must not PASS smoke.
    expect(smoke).toContain("assertSourceContextIntegrationPresent");
    expect(smoke).toContain("assertConsumerContextIntegration");
    expect(smoke).toContain("package/context-integration/release-manifest.json");
    // Helpers must throw so finally/cleanup always runs; only the outermost
    // main() may set process.exitCode.
    const failFn = smoke.match(/function fail\([^)]*\) \{[^}]*\}/)?.[0] ?? "";
    expect(failFn).toContain("throw new SmokeFailure");
    expect(failFn).not.toContain("process.exit");
  });

  it("declares context-integration as a turbo build output so cache hits restore the release payload", () => {
    const turbo = readJson(join(CLI_ROOT, "turbo.json")) as {
      tasks?: { build?: { outputs?: string[] } };
    };
    const outputs = turbo.tasks?.build?.outputs ?? [];
    expect(outputs).toContain("dist/**");
    expect(outputs).toContain("context-integration/**");
  });

  it("restores every original symlink after a mid-prepare failure", () => {
    const materialize = join(CLI_ROOT, "scripts", "materialize-bundled-deps.mjs");
    const result = spawnSync(process.execPath, [materialize, "selftest-recovery"], {
      cwd: CLI_ROOT,
      encoding: "utf8",
    });
    if (result.status !== 0) {
      throw new Error(`materialize selftest-recovery failed:\n${result.stderr || result.stdout}`);
    }
    expect(result.stdout).toContain("selftest-recovery PASS");
  });

  it("cleans tarballs, temp consumers, and symlinks after a release-pack smoke failure", () => {
    const result = spawnSync(
      process.execPath,
      [join(REPO_ROOT, "scripts", "release-pack-smoke.mjs"), "selftest-cleanup"],
      {
        cwd: REPO_ROOT,
        encoding: "utf8",
      },
    );
    if (result.status !== 0) {
      throw new Error(`release-pack-smoke selftest-cleanup failed:\n${result.stderr || result.stdout}`);
    }
    expect(result.stdout).toContain("selftest-cleanup PASS");
  });

  it("preserves a same-name pre-existing first-tree-dev tarball across smoke success and failure cleanup", () => {
    const result = spawnSync(
      process.execPath,
      [join(REPO_ROOT, "scripts", "release-pack-smoke.mjs"), "selftest-preserve-preexisting"],
      {
        cwd: REPO_ROOT,
        encoding: "utf8",
      },
    );
    if (result.status !== 0) {
      throw new Error(`release-pack-smoke selftest-preserve-preexisting failed:\n${result.stderr || result.stdout}`);
    }
    expect(result.stdout).toContain("selftest-preserve-preexisting PASS");
  });
});

describe("npm tarball registry-safety helper", () => {
  it("accepts canonical package-root paths and rejects traversal, rootless, and escaping layouts", () => {
    const result = spawnSync(process.execPath, [join(REPO_ROOT, "scripts", "npm-tarball-safety.mjs")], {
      encoding: "utf8",
    });
    if (result.status !== 0) {
      throw new Error(`npm-tarball-safety selftest failed:\n${result.stderr || result.stdout}`);
    }
    expect(result.stdout).toContain("selftest PASS");
  });
});
