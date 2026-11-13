import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cpSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { mkdir, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  artifactDownloadUrl,
  artifactFileName,
  assertNativeWorkspaceLockPrebuild,
  assertNoBuildRootReferences,
  buildPortableReleaseMetadata,
  copyPortableAppTemplate,
  copyPortableSkillPayloads,
  DEFAULT_DOWNLOAD_BASE_URL,
  DEFAULT_NODE_VERSION,
  manifestDownloadUrl,
  NODE_VERSION_FILE,
  normalizeDownloadBaseUrl,
  normalizeGeneratedAt,
  normalizeNodeVersion,
  PORTABLE_LOCKFILE_INSTALL_ARGS,
  PORTABLE_NODE_MODULES_INSTALL_ARGS,
  packageJsonForApp,
  parsePlatform,
  portableBuildRoots,
  portableTarCreateArgs,
  readWorkspacePackageManager,
  readWorkspacePatchedDependencies,
  relativizeInternalSymlinks,
  renderInstallerForChannel,
  resolveNodeVersion,
  resolvePinnedDependenciesFromPnpmList,
  rewriteBinShimBuildRoots,
  rewriteBundleChannel,
  rewriteBundleChannelText,
  sanitizePortableBinShims,
  validateChannelVersion,
  writeDeterministicTarGz,
} from "../../../scripts/portable/build-portable.mjs";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const TSX_IMPORT = pathToFileURL(createRequire(import.meta.url).resolve("tsx")).href;

let tmpDirs: string[] = [];

function tempDir(name: string): string {
  const dir = mkdtempSync(join(realpathSync(tmpdir()), name));
  tmpDirs.push(dir);
  return dir;
}

function currentPlatform(): string | null {
  if (process.platform !== "linux" && process.platform !== "darwin") return null;
  if (process.arch !== "x64" && process.arch !== "arm64") return null;
  return `${process.platform}-${process.arch}`;
}

function sha256(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function shellSingleQuote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

function treeManifest(root: string): string {
  const entries: string[] = [];
  const walk = (directory: string, relativeRoot: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const absolute = join(directory, entry.name);
      const relative = join(relativeRoot, entry.name).split("\\").join("/");
      if (entry.isDirectory()) {
        entries.push(`d ${relative}`);
        walk(absolute, relative);
      } else if (entry.isSymbolicLink()) {
        entries.push(`l ${relative} ${readlinkSync(absolute)}`);
      } else {
        entries.push(`f ${relative} ${sha256(absolute)}`);
      }
    }
  };
  walk(root, "");
  return entries.join("\n");
}

function commandPath(command: string): string {
  const result = spawnSync("sh", ["-c", `command -v ${command}`], { encoding: "utf8" });
  if (result.status !== 0) throw new Error(result.stderr || `failed to resolve ${command}`);
  return result.stdout.trim();
}

function writeMvWrapper(dir: string): void {
  const wrapper = join(dir, "mv");
  writeFileSync(
    wrapper,
    `#!/bin/sh
set -eu
target=""
saw_flag=0
for arg in "$@"; do
  target="$arg"
  if [ "$arg" = "$FT_TEST_REQUIRED_MV_FLAG" ]; then
    saw_flag=1
  fi
done
if [ "$target" = "$FT_TEST_CURRENT_LINK" ]; then
  current_version="$(cat "$FT_TEST_CURRENT_LINK/VERSION" 2>/dev/null || true)"
  if [ "$current_version" != "$FT_TEST_OLD_VERSION" ]; then
    echo "expected current to remain readable as $FT_TEST_OLD_VERSION before mv, got $current_version" >&2
    exit 41
  fi
  if [ "$saw_flag" != "1" ]; then
    echo "expected current switch to use $FT_TEST_REQUIRED_MV_FLAG" >&2
    exit 42
  fi
  if [ "\${FT_TEST_FAIL_CURRENT_SWITCH:-}" = "1" ]; then
    echo "simulated current switch failure" >&2
    exit 43
  fi
fi
exec "$FT_TEST_REAL_MV" "$@"
`,
    { mode: 0o755 },
  );
}

function writeTarWrapper(dir: string): void {
  const wrapper = join(dir, "tar");
  writeFileSync(
    wrapper,
    `#!/usr/bin/env node
const { spawnSync } = require("node:child_process");

const args = process.argv.slice(2);
if (args[0] === "--version") {
  process.stdout.write("tar (GNU tar) 1.35\\n");
  process.exit(0);
}

const sawWarning = args.includes("--warning=no-unknown-keyword");
const isExtract = args.includes("-xzf");
if (process.env.FT_TEST_REQUIRE_TAR_WARNING === "1" && isExtract && !sawWarning) {
  process.stderr.write("expected GNU tar extraction to suppress unknown pax keyword warnings\\n");
  process.exit(44);
}

const filteredArgs = args.filter((arg) => arg !== "--warning=no-unknown-keyword");
const res = spawnSync(process.env.FT_TEST_REAL_TAR, filteredArgs, { stdio: "inherit" });
if (res.error) {
  process.stderr.write(String(res.error.message) + "\\n");
  process.exit(1);
}
process.exit(res.status ?? 1);
`,
    { mode: 0o755 },
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
  for (const dir of tmpDirs) rmSync(dir, { recursive: true, force: true });
  tmpDirs = [];
});

describe("portable builder helpers", () => {
  it("ships private Local Context Skill variants without adding public duplicate names", () => {
    const appDir = tempDir("first-tree-portable-skills-");

    copyPortableSkillPayloads(appDir);

    const publicNames = readdirSync(join(appDir, "skills"), { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
      .map((entry) => entry.name);
    expect(publicNames.filter((name) => name === "first-tree-read")).toHaveLength(1);
    expect(publicNames.filter((name) => name === "first-tree-write")).toHaveLength(1);
    expect(
      readdirSync(join(appDir, "skills", ".variants", "local-context"), { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name)
        .sort(),
    ).toEqual(["first-tree-read", "first-tree-write"]);
    for (const name of ["first-tree-read", "first-tree-write"]) {
      expect(existsSync(join(appDir, "skills", ".variants", "local-context", name, "SKILL.md"))).toBe(true);
      expect(existsSync(join(appDir, "skills", ".variants", "local-context", name, "VERSION"))).toBe(true);
      expect(existsSync(join(appDir, "skills", ".variants", "local-context", name, "agents", "openai.yaml"))).toBe(
        true,
      );
    }
  });

  it("validates channel/version pairs", () => {
    expect(() => validateChannelVersion("prod", "1.2.3")).not.toThrow();
    expect(() => validateChannelVersion("prod", "1.2.3-staging.4.1")).toThrow(/stable/);
    expect(() => validateChannelVersion("staging", "1.2.4-staging.4.1")).not.toThrow();
    expect(() => validateChannelVersion("staging", "1.2.4")).toThrow(/-staging/);
  });

  it("maps supported platform strings", () => {
    expect(parsePlatform("linux-x64")).toEqual({ os: "linux", arch: "x64" });
    expect(parsePlatform("darwin-arm64")).toEqual({ os: "darwin", arch: "arm64" });
    expect(() => parsePlatform("win32-x64")).toThrow(/unsupported/);
  });

  it("requires the native workspace-lock prebuild for every portable target", async () => {
    const appDir = tempDir("first-tree-portable-native-lock-");
    const prebuildDir = join(appDir, "node_modules", "fs-native-extensions", "prebuilds", "darwin-arm64");
    await mkdir(prebuildDir, { recursive: true });
    await writeFile(join(prebuildDir, "fs-native-extensions.node"), "prebuild");

    expect(() => assertNativeWorkspaceLockPrebuild(appDir, "darwin-arm64")).not.toThrow();
    expect(() => assertNativeWorkspaceLockPrebuild(appDir, "linux-x64")).toThrow(
      /missing native workspace-lock prebuild for linux-x64/,
    );
  });

  it("uses immutable artifact names", () => {
    expect(artifactFileName({ packageName: "first-tree", version: "1.2.3", platform: "linux-x64" })).toBe(
      "first-tree-1.2.3-linux-x64.tar.gz",
    );
  });

  it("rewrites historical and current bundled channel shapes", () => {
    expect(rewriteBundleChannelText('const channelConfig = getChannelConfig("dev");', "staging")).toEqual({
      content: 'const channelConfig = getChannelConfig("staging");',
      replacements: 1,
    });
    expect(
      rewriteBundleChannelText('var CHANNEL = "dev";\nconst channelConfig = getChannelConfig(CHANNEL);', "prod"),
    ).toEqual({
      content: 'var CHANNEL = "prod";\nconst channelConfig = getChannelConfig(CHANNEL);',
      replacements: 1,
    });
  });

  it("accepts already-channel-built bundles without a rewrite target", async () => {
    const appDir = tempDir("first-tree-portable-bundle-channel-");
    writeFileSync(join(appDir, "index.mjs"), 'const bundled = "already staging";\n');

    await expect(rewriteBundleChannel(appDir, "staging", { sourceChannel: "staging" })).resolves.toBeUndefined();
    await expect(rewriteBundleChannel(appDir, "prod", { sourceChannel: "dev" })).rejects.toThrow(
      /expected to rewrite exactly one bundled channel constant/,
    );
  });

  it("builds portable archives from a deterministic file list without xattrs or build-user ownership", () => {
    expect(
      portableTarCreateArgs({ tarballPath: "payload.tar", sourceDir: "payload", fileListPath: "files.txt" }),
    ).toEqual([
      "--no-recursion",
      "--no-xattrs",
      "--owner=0",
      "--group=0",
      "--numeric-owner",
      "-cf",
      "payload.tar",
      "-C",
      "payload",
      "-T",
      "files.txt",
    ]);
    expect(portableTarCreateArgs({ tarballPath: "payload.tar", sourceDir: "payload", tarFlavor: "bsd" })).toEqual([
      "--no-recursion",
      "--no-xattrs",
      "--uid",
      "0",
      "--gid",
      "0",
      "--uname",
      "",
      "--gname",
      "",
      "-cf",
      "payload.tar",
      "-C",
      "payload",
      ".",
    ]);
    expect(() => portableTarCreateArgs({ tarballPath: "p.tar", sourceDir: "p", tarFlavor: "zip" })).toThrow(
      /tar flavor/,
    );
  });

  it("normalizes generatedAt timestamps for release metadata", () => {
    expect(normalizeGeneratedAt("2026-01-01T08:00:00+08:00")).toBe("2026-01-01T00:00:00.000Z");
    expect(() => normalizeGeneratedAt("not-a-date")).toThrow(/valid timestamp/);
  });

  it("uses an exact default Node runtime version from the portable pin file", () => {
    expect(readFileSync(NODE_VERSION_FILE, "utf8").trim()).toBe(DEFAULT_NODE_VERSION);
    expect(DEFAULT_NODE_VERSION).toMatch(/^v\d+\.\d+\.\d+$/);
    expect(normalizeNodeVersion(DEFAULT_NODE_VERSION.slice(1))).toBe(DEFAULT_NODE_VERSION);
  });

  it("rejects floating Node runtime specs", async () => {
    await expect(resolveNodeVersion("latest-v24.x")).rejects.toThrow(/exact Node.js version/);
  });

  it("writes portable package dependencies with exact locked versions", () => {
    const sourcePackage = {
      description: "First Tree CLI",
      license: "MIT",
      repository: { type: "git", url: "https://example.test/first-tree.git" },
      engines: { node: ">=22.13" },
      dependencies: {
        commander: "^13.1.0",
        zod: "^4.0.0",
      },
    };
    const dependencies = resolvePinnedDependenciesFromPnpmList({
      packageName: "first-tree-dev",
      sourceDependencies: sourcePackage.dependencies,
      listOutput: JSON.stringify([
        {
          name: "first-tree-dev",
          dependencies: {
            commander: { version: "13.1.0" },
            zod: { version: "4.3.6" },
          },
        },
      ]),
    });
    const appPackage = packageJsonForApp({
      channelConfig: {
        packageName: "first-tree",
        binName: "first-tree",
        aliasName: "ft",
      },
      version: "1.2.3",
      dependencies,
      sourcePackage,
      packageManager: "pnpm@10.12.1",
    });

    expect(appPackage.dependencies).toEqual({ commander: "13.1.0", zod: "4.3.6" });
    expect(
      Object.values(appPackage.dependencies).every((version) => !version.startsWith("^") && !version.startsWith("~")),
    ).toBe(true);
    expect(appPackage.packageManager).toBe("pnpm@10.12.1");
  });

  it("pins the temp-dir install to the workspace pnpm version", () => {
    expect(readWorkspacePackageManager({ packageManager: "pnpm@10.12.1" })).toBe("pnpm@10.12.1");
    expect(() => readWorkspacePackageManager({ packageManager: "pnpm@^10" })).toThrow(/exact pnpm version/);
    expect(() => readWorkspacePackageManager({})).toThrow(/exact pnpm version/);
    expect(readWorkspacePackageManager()).toMatch(/^pnpm@\d+\.\d+\.\d+$/);
  });

  it("carries workspace patchedDependencies into the portable app manifest", () => {
    const patched = readWorkspacePatchedDependencies();
    // The Kimi SDK resume-drain patch must reach the synthetic portable app;
    // without it the app's generated lockfile resolves the unpatched SDK.
    expect(patched).toHaveProperty(
      "@botiverse/kimi-code-sdk@0.26.0-botiverse.2",
      "patches/@botiverse__kimi-code-sdk@0.26.0-botiverse.2.patch",
    );
    for (const patchPath of Object.values(patched)) {
      expect(patchPath.startsWith("patches/")).toBe(true);
      expect(existsSync(join(REPO_ROOT, patchPath))).toBe(true);
    }

    const appPackage = packageJsonForApp({
      channelConfig: { packageName: "first-tree", binName: "first-tree", aliasName: "ft" },
      version: "1.2.3",
      dependencies: { commander: "13.1.0" },
      sourcePackage: {
        description: "First Tree CLI",
        license: "MIT",
        repository: { type: "git", url: "https://example.test/first-tree.git" },
        engines: { node: ">=22.13" },
      },
      patchedDependencies: patched,
    });
    expect(appPackage.pnpm).toEqual({ patchedDependencies: patched });

    const unpatched = packageJsonForApp({
      channelConfig: { packageName: "first-tree", binName: "first-tree", aliasName: "ft" },
      version: "1.2.3",
      dependencies: { commander: "13.1.0" },
      sourcePackage: {
        description: "First Tree CLI",
        license: "MIT",
        repository: { type: "git", url: "https://example.test/first-tree.git" },
        engines: { node: ">=22.13" },
      },
    });
    expect(unpatched).not.toHaveProperty("pnpm");
  });

  it("fails when a portable dependency is missing from locked pnpm output", () => {
    expect(() =>
      resolvePinnedDependenciesFromPnpmList({
        packageName: "first-tree-dev",
        sourceDependencies: {
          commander: "^13.1.0",
          zod: "^4.0.0",
        },
        listOutput: JSON.stringify([
          {
            name: "first-tree-dev",
            dependencies: {
              commander: { version: "13.1.0" },
            },
          },
        ]),
      }),
    ).toThrow(/zod.*missing/);
  });

  it("rewrites pnpm absolute internal symlinks to portable relative targets", async () => {
    const root = tempDir("first-tree-portable-symlink-");
    await mkdir(join(root, "node_modules", ".pnpm", "zod@4.3.6", "node_modules", "zod"), { recursive: true });
    await mkdir(join(root, "node_modules"), { recursive: true });
    const target = join(root, "node_modules", ".pnpm", "zod@4.3.6", "node_modules", "zod");
    const link = join(root, "node_modules", "zod");
    await writeFile(join(target, "index.js"), "export {};\n");
    await symlink(target, link);

    relativizeInternalSymlinks(root);

    expect(readlinkSync(link)).toBe(".pnpm/zod@4.3.6/node_modules/zod");
    expect(readFileSync(join(link, "index.js"), "utf8")).toBe("export {};\n");
  });

  it("generates the portable lockfile without requiring an offline pnpm metadata mirror", () => {
    expect(PORTABLE_LOCKFILE_INSTALL_ARGS).toContain("--lockfile-only");
    expect(PORTABLE_LOCKFILE_INSTALL_ARGS).toContain("--prefer-offline");
    expect(PORTABLE_LOCKFILE_INSTALL_ARGS).not.toContain("--offline");
    expect(PORTABLE_NODE_MODULES_INSTALL_ARGS).toContain("--frozen-lockfile");
    expect(PORTABLE_NODE_MODULES_INSTALL_ARGS).not.toContain("--offline");
  });

  it("orders build roots longest-first and includes the realpath variant", () => {
    const dir = tempDir("first-tree-portable-roots-");
    const roots = portableBuildRoots(dir);
    expect(roots).toContain(realpathSync(dir));
    for (let i = 1; i < roots.length; i += 1) {
      expect(roots[i - 1].length).toBeGreaterThanOrEqual(roots[i].length);
    }
  });

  it("replaces overlapping build root variants without leaving a path prefix behind", () => {
    const rewritten = rewriteBinShimBuildRoots({
      content: 'export NODE_PATH="/private/var/tmp/build/app/node_modules/.pnpm/node_modules"\n',
      shimDir: "/var/tmp/build/app/node_modules/.bin",
      appDir: "/var/tmp/build/app",
      buildRoots: ["/private/var/tmp/build/app", "/var/tmp/build/app"],
    });
    expect(rewritten).toBe('export NODE_PATH="$basedir/../../node_modules/.pnpm/node_modules"\n');
  });

  it("rewrites bin shim build paths to basedir-relative form for reproducible artifacts", async () => {
    const root = tempDir("first-tree-portable-shim-");
    const appDir = join(root, "app");
    const topBin = join(appDir, "node_modules", ".bin");
    const nestedBin = join(
      appDir,
      "node_modules",
      ".pnpm",
      "gray-matter@4.0.3",
      "node_modules",
      "gray-matter",
      "node_modules",
      ".bin",
    );
    await mkdir(topBin, { recursive: true });
    await mkdir(nestedBin, { recursive: true });
    const buildRoot = realpathSync(appDir);
    const shim = (target: string) =>
      `#!/bin/sh
basedir=$(dirname "$(echo "$0" | sed -e 's,\\\\,/,g')")
export NODE_PATH="${buildRoot}/node_modules/.pnpm/node_modules"
exec node "$basedir/../${target}" "$@"
# cmd-shim-target=${buildRoot}/node_modules/${target}
`;
    writeFileSync(join(topBin, "semver"), shim("semver/bin/semver.js"), { mode: 0o755 });
    writeFileSync(join(nestedBin, "js-yaml"), shim("js-yaml/bin/js-yaml.js"), { mode: 0o755 });

    const rewritten = sanitizePortableBinShims(appDir);

    expect(rewritten).toHaveLength(2);
    const topContent = readFileSync(join(topBin, "semver"), "utf8");
    expect(topContent).toContain('NODE_PATH="$basedir/../../node_modules/.pnpm/node_modules"');
    expect(topContent).not.toContain(buildRoot);
    const nestedContent = readFileSync(join(nestedBin, "js-yaml"), "utf8");
    expect(nestedContent).toContain('NODE_PATH="$basedir/../../../../../../../node_modules/.pnpm/node_modules"');
    expect(nestedContent).not.toContain(buildRoot);
    expect(statSync(join(topBin, "semver")).mode & 0o755).toBe(0o755);
    expect(() => assertNoBuildRootReferences(appDir)).not.toThrow();
  });

  it("fails closed when a portable app file still references its build directory", async () => {
    const root = tempDir("first-tree-portable-leak-");
    const appDir = join(root, "app");
    await mkdir(appDir, { recursive: true });
    await writeFile(join(appDir, "leak.txt"), `${realpathSync(appDir)}/node_modules\n`);
    expect(() => assertNoBuildRootReferences(appDir)).toThrow(/build directory/);
  });

  it("copies portable app templates without rewriting relative symlinks to the source temp dir", async () => {
    const source = tempDir("first-tree-portable-copy-source-");
    const output = tempDir("first-tree-portable-copy-output-");
    await mkdir(join(source, "node_modules", ".pnpm", "zod@4.3.6", "node_modules", "zod"), { recursive: true });
    const link = join(source, "node_modules", "zod");
    await symlink(".pnpm/zod@4.3.6/node_modules/zod", link);

    copyPortableAppTemplate(source, join(output, "app"));

    expect(readlinkSync(join(output, "app", "node_modules", "zod"))).toBe(".pnpm/zod@4.3.6/node_modules/zod");
  });

  it("rejects portable app symlinks that point outside the app root", async () => {
    const root = tempDir("first-tree-portable-outside-symlink-");
    await mkdir(join(root, "node_modules"), { recursive: true });
    await symlink(tmpdir(), join(root, "node_modules", "outside"));

    expect(() => relativizeInternalSymlinks(root)).toThrow(/outside app root/);
  });

  it("writes deterministic portable archive bytes for the same inputs", async () => {
    const source = tempDir("first-tree-portable-archive-source-");
    const output = tempDir("first-tree-portable-archive-output-");
    await mkdir(join(source, "bin"), { recursive: true });
    await mkdir(join(source, "app", "cli"), { recursive: true });
    await writeFile(join(source, "VERSION"), "1.2.3\n");
    await writeFile(join(source, "bin", "first-tree"), "#!/bin/sh\necho first-tree\n", { mode: 0o755 });
    await writeFile(join(source, "app", "cli", "index.mjs"), "console.log('first-tree');\n");

    const generatedAt = "2026-01-01T00:00:00.000Z";
    const first = join(output, "first.tar.gz");
    const second = join(output, "second.tar.gz");
    await writeDeterministicTarGz({ sourceDir: source, tarballPath: first, generatedAt });
    await writeFile(join(source, "app", "cli", "index.mjs"), "console.log('first-tree');\n");
    await writeDeterministicTarGz({ sourceDir: source, tarballPath: second, generatedAt });

    expect(sha256(second)).toBe(sha256(first));
  });

  it("uses the official release download base URL by default", () => {
    expect(DEFAULT_DOWNLOAD_BASE_URL).toBe("https://download.first-tree.ai/releases");
    expect(
      artifactDownloadUrl({
        downloadBaseUrl: DEFAULT_DOWNLOAD_BASE_URL,
        channel: "prod",
        version: "1.2.3",
        fileName: "first-tree-1.2.3-linux-x64.tar.gz",
      }),
    ).toBe("https://download.first-tree.ai/releases/prod/1.2.3/first-tree-1.2.3-linux-x64.tar.gz");
    expect(
      manifestDownloadUrl({
        downloadBaseUrl: DEFAULT_DOWNLOAD_BASE_URL,
        channel: "prod",
        version: "1.2.3",
      }),
    ).toBe("https://download.first-tree.ai/releases/prod/1.2.3/manifest.json");
  });

  it("normalizes custom download base URLs and rejects channel-scoped URLs", () => {
    expect(normalizeDownloadBaseUrl("https://downloads.example.test/releases///")).toBe(
      "https://downloads.example.test/releases",
    );
    expect(() => normalizeDownloadBaseUrl("https://downloads.example.test/releases/prod")).toThrow(
      /must not include the channel segment/,
    );
    expect(() => normalizeDownloadBaseUrl("https://downloads.example.test/releases/staging/")).toThrow(
      /must not include the channel segment/,
    );
  });

  it("writes custom download base URLs into portable metadata", () => {
    const downloadBaseUrl = "https://downloads.example.test/releases";
    const fileName = "first-tree-1.2.3-linux-x64.tar.gz";
    const asset = {
      platform: "linux-x64",
      fileName,
      url: artifactDownloadUrl({ downloadBaseUrl, channel: "prod", version: "1.2.3", fileName }),
      sha256: "a".repeat(64),
      size: 7,
    };
    const { manifest, latest } = buildPortableReleaseMetadata({
      channel: "prod",
      channelConfig: {
        packageName: "first-tree",
        binName: "first-tree",
        aliasName: "ft",
      },
      version: "1.2.3",
      gitSha: "abc123",
      nodeVersion: "v24.0.0",
      generatedAt: "2026-01-01T00:00:00.000Z",
      downloadBaseUrl,
      assets: [asset],
    });

    expect(manifest.assets[0]?.url).toBe(
      "https://downloads.example.test/releases/prod/1.2.3/first-tree-1.2.3-linux-x64.tar.gz",
    );
    expect(latest.manifestUrl).toBe("https://downloads.example.test/releases/prod/1.2.3/manifest.json");
    expect(latest.assets[0]?.url).toBe(manifest.assets[0]?.url);
  });

  it("bakes custom channel installer defaults while preserving runtime download override", () => {
    const installer = renderInstallerForChannel("staging", "https://downloads.example.test/releases/");
    const channelFallback = "$" + "{FIRST_TREE_PORTABLE_CHANNEL:-staging}";
    const customBaseFallback = "$" + "{FIRST_TREE_PORTABLE_DOWNLOAD_BASE_URL:-https://downloads.example.test/releases}";
    const defaultBaseFallback =
      "$" + "{FIRST_TREE_PORTABLE_DOWNLOAD_BASE_URL:-https://download.first-tree.ai/releases}";
    expect(installer).toContain(`PORTABLE_CHANNEL="${channelFallback}"`);
    expect(installer).toContain(`DOWNLOAD_BASE_URL="${customBaseFallback}"`);
    expect(installer).not.toContain(`DOWNLOAD_BASE_URL="${defaultBaseFallback}"`);
  });

  it("renders installer defaults when replacements match the template values", () => {
    const prodInstaller = renderInstallerForChannel("prod", DEFAULT_DOWNLOAD_BASE_URL);
    const prodChannelFallback = "$" + "{FIRST_TREE_PORTABLE_CHANNEL:-prod}";
    const stagingInstaller = renderInstallerForChannel("staging", DEFAULT_DOWNLOAD_BASE_URL);
    const stagingChannelFallback = "$" + "{FIRST_TREE_PORTABLE_CHANNEL:-staging}";
    const downloadBaseFallback =
      "$" + "{FIRST_TREE_PORTABLE_DOWNLOAD_BASE_URL:-https://download.first-tree.ai/releases}";

    expect(prodInstaller).toContain(`PORTABLE_CHANNEL="${prodChannelFallback}"`);
    expect(prodInstaller).toContain(`DOWNLOAD_BASE_URL="${downloadBaseFallback}"`);
    expect(stagingInstaller).toContain(`PORTABLE_CHANNEL="${stagingChannelFallback}"`);
    expect(stagingInstaller).toContain(`DOWNLOAD_BASE_URL="${downloadBaseFallback}"`);
  });
});

describe("portable installer", () => {
  async function writeFixtureVersion(
    root: string,
    version: string,
    platform: string,
    options: {
      failRuntimeSmoke?: boolean;
      integrationRuntime?: boolean;
      failEnsureService?: boolean;
      deferEnsureService?: boolean;
      /** Write a different version into INSTALL.json, so the candidate fails validation. */
      staleInstallVersion?: string;
    } = {},
  ): Promise<void> {
    const channelDir = join(root, "prod");
    const versionDir = join(channelDir, version);
    const payload = join(root, `payload-${version}`);
    await mkdir(join(payload, "node", "bin"), { recursive: true });
    await mkdir(join(payload, "app", "cli"), { recursive: true });
    await mkdir(join(payload, "bin"), { recursive: true });
    const nodeScript = options.integrationRuntime
      ? `#!/bin/sh
exec ${shellSingleQuote(process.execPath)} --import ${shellSingleQuote(TSX_IMPORT)} "$@"
`
      : `#!/bin/sh
if [ -n "\${FT_TEST_NODE_ARGS_LOG:-}" ]; then
  printf '%s\\n' "$*" >>"$FT_TEST_NODE_ARGS_LOG"
fi
if [ "$2" = "--version" ]; then ${options.failRuntimeSmoke ? "exit 51" : `echo ${version}; exit 0;`} fi
if [ "$1" = "--version" ]; then ${options.failRuntimeSmoke ? "exit 51" : `echo ${version}; exit 0;`} fi
${
  options.failEnsureService
    ? `case "$*" in
  *ensure-service*) printf 'service repair unavailable\\n' >&2; exit 9 ;;
esac`
    : ""
}
${
  // Mirrors ENSURE_SERVICE_DEFERRED_EXIT_CODE: setup skipped, not failed.
  options.deferEnsureService
    ? `case "$*" in
  *ensure-service*) printf '  ensure-service: no credentials found; run login after install.\\n'; exit 3 ;;
esac`
    : ""
}
echo node-stub "$@"
`;
    await writeFile(join(payload, "node", "bin", "node"), nodeScript, { mode: 0o755 });
    if (options.integrationRuntime) {
      const runtimeRoot = join(payload, "test-runtime");
      cpSync(join(REPO_ROOT, "apps", "cli", "src"), join(runtimeRoot, "src"), { recursive: true });
      writeFileSync(join(runtimeRoot, "package.json"), JSON.stringify({ type: "module" }));
      const buildInfoPath = join(runtimeRoot, "src", "build-info.ts");
      const buildInfo = readFileSync(buildInfoPath, "utf8").replace('= "dev";', '= "prod";');
      writeFileSync(buildInfoPath, buildInfo);
      await symlink(join(REPO_ROOT, "apps", "cli", "node_modules"), join(runtimeRoot, "node_modules"));
    }
    const integrationApp = `
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
const { resolveCliInstall, systemdPathEnv } = await import(
  new URL("../../test-runtime/src/core/supervisor/shared.ts", import.meta.url)
);
const { renderSystemdUnit } = await import(
  new URL("../../test-runtime/src/core/supervisor/systemd.ts", import.meta.url)
);
const { createExecuteUpdate } = await import(
  new URL("../../test-runtime/src/core/update-glue.ts", import.meta.url)
);

const version = ${JSON.stringify(version)};
const args = process.argv.slice(2);

function refreshService(kind) {
  const install = resolveCliInstall();
  const unit = renderSystemdUnit(install.invocation, "user", systemdPathEnv(install.portable));
  writeFileSync(process.env.FT_INTEGRATION_UNIT, unit);
  appendFileSync(process.env.FT_INTEGRATION_LOG, [kind, version, install.invocation.program].join(" ") + "\\n");
}

if (args[0] === "--version") {
  console.log(version);
} else if (args[0] === "login") {
  refreshService("login");
} else if (args[0] === "daemon" && (args[1] === "ensure-service" || args[1] === "refresh-unit")) {
  refreshService(args[1]);
} else if (args[0] === "managed-update") {
  const execute = createExecuteUpdate({
    managed: true,
    log: (_level, message) => appendFileSync(process.env.FT_INTEGRATION_LOG, "update " + message + "\\n"),
  });
  await execute({ currentVersion: version, targetVersion: args[1] });
  throw new Error("managed update returned without the restart exit");
} else if (args[0] === "tree-version") {
  console.log(readFileSync(new URL("../../VERSION", import.meta.url), "utf8").trim());
} else {
  throw new Error("unsupported integration fixture command: " + args.join(" "));
}
`;
    await writeFile(
      join(payload, "app", "cli", "index.mjs"),
      options.integrationRuntime ? integrationApp : "// fixture\n",
    );
    await writeFile(join(payload, "app", "package.json"), JSON.stringify({ name: "first-tree", version }));
    await writeFile(join(payload, "VERSION"), `${version}\n`);
    await writeFile(
      join(payload, "INSTALL.json"),
      JSON.stringify({
        schemaVersion: 1,
        channel: "prod",
        version: options.staleInstallVersion ?? version,
        gitSha: "abc123",
        nodeVersion: "v24.0.0",
        packageName: "first-tree",
        binName: "first-tree",
        aliasName: "ft",
        generatedAt: new Date().toISOString(),
        platform,
        installMode: "portable",
        appEntry: "app/cli/index.mjs",
      }),
    );
    await writeFile(
      join(payload, "bin", "first-tree"),
      '#!/bin/sh\nroot=$(CDPATH= cd "$(dirname "$0")/.." && pwd)\nexec "$root/node/bin/node" "$root/app/cli/index.mjs" "$@"\n',
      { mode: 0o755 },
    );
    await writeFile(
      join(payload, "bin", "ft"),
      '#!/bin/sh\nroot=$(CDPATH= cd "$(dirname "$0")/.." && pwd)\nexec "$root/node/bin/node" "$root/app/cli/index.mjs" "$@"\n',
      { mode: 0o755 },
    );
    await mkdir(versionDir, { recursive: true });
    const tarball = join(versionDir, `first-tree-${version}-${platform}.tar.gz`);
    const tar = spawnSync("tar", ["-czf", tarball, "-C", payload, "."], { encoding: "utf8" });
    if (tar.status !== 0) throw new Error(tar.stderr);
    const latest = {
      schemaVersion: 1,
      channel: "prod",
      version,
      gitSha: "abc123",
      nodeVersion: "v24.0.0",
      packageName: "first-tree",
      binName: "first-tree",
      aliasName: "ft",
      generatedAt: new Date().toISOString(),
      manifestUrl: `file://${versionDir}/manifest.json`,
      assets: [
        {
          platform,
          fileName: `first-tree-${version}-${platform}.tar.gz`,
          url: `file://${tarball}`,
          sha256: sha256(tarball),
          size: statSync(tarball).size,
        },
      ],
    };
    writeFileSync(join(channelDir, "latest.json"), JSON.stringify(latest, null, 2));
    writeFileSync(join(versionDir, "manifest.json"), JSON.stringify({ ...latest, manifestUrl: undefined }, null, 2));
  }

  async function makeFixture(platform: string): Promise<string> {
    const root = tempDir("first-tree-install-test-");
    await writeFixtureVersion(root, "1.2.3", platform);
    return root;
  }

  it("installs from a local manifest and writes portable shims", async () => {
    const platform = currentPlatform();
    if (platform === null) return;
    const fixture = await makeFixture(platform);
    const home = tempDir("first-tree-home-");
    const prefix = join(home, "prefix");
    const binDir = join(home, "bin");
    const res = spawnSync(
      "sh",
      [join(REPO_ROOT, "scripts", "portable", "install.sh"), "--prefix", prefix, "--bin-dir", binDir, "--no-path-edit"],
      {
        cwd: REPO_ROOT,
        env: {
          ...process.env,
          HOME: home,
          FIRST_TREE_PORTABLE_CHANNEL: "prod",
          FIRST_TREE_PORTABLE_DOWNLOAD_BASE_URL: `file://${fixture}`,
        },
        encoding: "utf8",
      },
    );
    expect(res.status, res.stderr || res.stdout).toBe(0);
    expect(readFileSync(join(prefix, "current", "VERSION"), "utf8")).toBe("1.2.3\n");
    const shim = readFileSync(join(binDir, "first-tree"), "utf8");
    expect(shim).toContain("FIRST_TREE_INSTALL_MODE=portable");
    expect(shim).toContain("FIRST_TREE_PORTABLE_ROOT");
    expect(shim).toContain("FIRST_TREE_PORTABLE_BIN_DIR");
  });

  it("skips the payload download when the installed version is already current", async () => {
    const platform = currentPlatform();
    if (platform === null) return;
    const fixture = await makeFixture(platform);
    const home = tempDir("first-tree-home-");
    const prefix = join(home, "prefix");
    const binDir = join(home, "bin");
    const env = {
      ...process.env,
      HOME: home,
      FIRST_TREE_PORTABLE_CHANNEL: "prod",
      FIRST_TREE_PORTABLE_DOWNLOAD_BASE_URL: `file://${fixture}`,
    };
    const installArgs = [
      join(REPO_ROOT, "scripts", "portable", "install.sh"),
      "--prefix",
      prefix,
      "--bin-dir",
      binDir,
      "--no-path-edit",
    ];

    const first = spawnSync("sh", installArgs, { cwd: REPO_ROOT, env, encoding: "utf8" });
    expect(first.status, first.stderr || first.stdout).toBe(0);

    // Removing the payload makes any fetch fatal, so the second run can only
    // exit 0 when it stopped before downloading the artifact.
    rmSync(join(fixture, "prod", "1.2.3", `first-tree-1.2.3-${platform}.tar.gz`));

    const second = spawnSync("sh", installArgs, { cwd: REPO_ROOT, env, encoding: "utf8" });
    expect(second.status, second.stderr || second.stdout).toBe(0);
    expect(second.stdout).toContain("is already installed; skipped the payload download");
    expect(second.stdout).toContain("nothing to download");
    expect(readFileSync(join(prefix, "current", "VERSION"), "utf8")).toBe("1.2.3\n");
  });

  it.each([
    ["the bundled runtime", "node/bin/node"],
    ["the version marker", "VERSION"],
    ["the install metadata", "INSTALL.json"],
  ])("repairs an install missing %s instead of treating it as up to date", async (_label, missing) => {
    const platform = currentPlatform();
    if (platform === null) return;
    const fixture = await makeFixture(platform);
    const home = tempDir("first-tree-home-");
    const prefix = join(home, "prefix");
    const binDir = join(home, "bin");
    const env = {
      ...process.env,
      HOME: home,
      FIRST_TREE_PORTABLE_CHANNEL: "prod",
      FIRST_TREE_PORTABLE_DOWNLOAD_BASE_URL: `file://${fixture}`,
    };
    const installArgs = [
      join(REPO_ROOT, "scripts", "portable", "install.sh"),
      "--prefix",
      prefix,
      "--bin-dir",
      binDir,
      "--no-path-edit",
    ];

    const first = spawnSync("sh", installArgs, { cwd: REPO_ROOT, env, encoding: "utf8" });
    expect(first.status, first.stderr || first.stdout).toBe(0);

    // Same version on disk, but a file a later reader depends on is gone. A
    // version-only check would skip the install; a reuse check that does not
    // match the fast path would keep the broken directory and report success.
    rmSync(join(prefix, "current", missing), { recursive: true, force: true });

    const second = spawnSync("sh", installArgs, { cwd: REPO_ROOT, env, encoding: "utf8" });
    expect(second.status, second.stderr || second.stdout).toBe(0);
    expect(second.stdout).not.toContain("is already installed");
    for (const present of ["VERSION", "INSTALL.json", "node/bin/node", "app/cli/index.mjs"]) {
      expect(existsSync(join(prefix, "current", present)), present).toBe(true);
    }
  });

  it("keeps the directory on disk when the extracted candidate fails validation", async () => {
    const platform = currentPlatform();
    if (platform === null) return;
    const fixture = await makeFixture(platform);
    // The archive is checked and extracted, but its INSTALL.json disagrees with
    // the metadata, so validation fails after extraction and before the swap.
    await writeFixtureVersion(fixture, "1.2.4", platform, { staleInstallVersion: "9.9.9" });
    const home = tempDir("first-tree-home-");
    const prefix = join(home, "prefix");
    const binDir = join(home, "bin");
    const env = {
      ...process.env,
      HOME: home,
      FIRST_TREE_PORTABLE_CHANNEL: "prod",
      FIRST_TREE_PORTABLE_DOWNLOAD_BASE_URL: `file://${fixture}`,
    };
    const installArgs = [
      join(REPO_ROOT, "scripts", "portable", "install.sh"),
      "--prefix",
      prefix,
      "--bin-dir",
      binDir,
      "--no-path-edit",
      "--version",
      "1.2.4",
    ];

    // An interrupted earlier attempt left this behind; it must survive a failed
    // retry, because the new payload never became a valid replacement.
    await mkdir(join(prefix, "versions", "1.2.4"), { recursive: true });
    writeFileSync(join(prefix, "versions", "1.2.4", "half-written.txt"), "partial\n");

    const install = spawnSync("sh", installArgs, { cwd: REPO_ROOT, env, encoding: "utf8" });
    expect(install.status, install.stderr || install.stdout).not.toBe(0);
    expect(install.stderr).toContain("INSTALL.json version does not match downloaded metadata");
    expect(readFileSync(join(prefix, "versions", "1.2.4", "half-written.txt"), "utf8")).toBe("partial\n");
  });

  it("warns before replacing a local build with a released version", async () => {
    const platform = currentPlatform();
    if (platform === null) return;
    const fixture = await makeFixture(platform);
    const home = tempDir("first-tree-home-");
    const prefix = join(home, "prefix");
    const binDir = join(home, "bin");
    const env = {
      ...process.env,
      HOME: home,
      FIRST_TREE_PORTABLE_CHANNEL: "prod",
      FIRST_TREE_PORTABLE_DOWNLOAD_BASE_URL: `file://${fixture}`,
    };
    const installArgs = [
      join(REPO_ROOT, "scripts", "portable", "install.sh"),
      "--prefix",
      prefix,
      "--bin-dir",
      binDir,
      "--no-path-edit",
    ];

    const localFixture = await makeFixture(platform);
    await writeFixtureVersion(localFixture, "local.20260101", platform);
    const local = spawnSync("sh", [...installArgs, "--version", "local.20260101"], {
      cwd: REPO_ROOT,
      env: { ...env, FIRST_TREE_PORTABLE_DOWNLOAD_BASE_URL: `file://${localFixture}` },
      encoding: "utf8",
    });
    expect(local.status, local.stderr || local.stdout).toBe(0);
    expect(readFileSync(join(prefix, "current", "VERSION"), "utf8")).toBe("local.20260101\n");

    const released = spawnSync("sh", [...installArgs, "--version", "1.2.3"], {
      cwd: REPO_ROOT,
      env,
      encoding: "utf8",
    });
    expect(released.status, released.stderr || released.stdout).toBe(0);
    expect(released.stdout).toContain("Replacing local build local.20260101 with released 1.2.3");
    expect(readFileSync(join(prefix, "current", "VERSION"), "utf8")).toBe("1.2.3\n");
  });

  it("prints shell refresh guidance for the profile it updates", async () => {
    const platform = currentPlatform();
    if (platform === null) return;
    const fixture = await makeFixture(platform);
    const home = tempDir("first-tree-home-");
    const prefix = join(home, "prefix");
    const binDir = join(home, "bin");
    const profile = join(home, ".zshrc");
    const res = spawnSync(
      "sh",
      [join(REPO_ROOT, "scripts", "portable", "install.sh"), "--prefix", prefix, "--bin-dir", binDir],
      {
        cwd: REPO_ROOT,
        env: {
          ...process.env,
          HOME: home,
          SHELL: "/bin/zsh",
          FIRST_TREE_PORTABLE_CHANNEL: "prod",
          FIRST_TREE_PORTABLE_DOWNLOAD_BASE_URL: `file://${fixture}`,
        },
        encoding: "utf8",
      },
    );

    expect(res.status, res.stderr || res.stdout).toBe(0);
    expect(readFileSync(profile, "utf8")).toContain(`export PATH="${binDir}:$PATH"`);
    expect(res.stdout).toContain(`Restart your shell, or run: . "${profile}"`);
    expect(res.stdout).not.toContain("Add this to your shell profile:");
  });

  it("keeps manual PATH guidance when path editing is disabled", async () => {
    const platform = currentPlatform();
    if (platform === null) return;
    const fixture = await makeFixture(platform);
    const home = tempDir("first-tree-home-");
    const prefix = join(home, "prefix");
    const binDir = join(home, "bin");
    const profile = join(home, ".zshrc");
    const res = spawnSync(
      "sh",
      [join(REPO_ROOT, "scripts", "portable", "install.sh"), "--prefix", prefix, "--bin-dir", binDir, "--no-path-edit"],
      {
        cwd: REPO_ROOT,
        env: {
          ...process.env,
          HOME: home,
          SHELL: "/bin/zsh",
          FIRST_TREE_PORTABLE_CHANNEL: "prod",
          FIRST_TREE_PORTABLE_DOWNLOAD_BASE_URL: `file://${fixture}`,
        },
        encoding: "utf8",
      },
    );

    expect(res.status, res.stderr || res.stdout).toBe(0);
    expect(existsSync(profile)).toBe(false);
    expect(res.stdout).not.toContain("Restart your shell, or run: . ");
    expect(res.stdout).toContain(`Add this to your shell profile: export PATH="${binDir}:$PATH"`);
  });

  it("suppresses GNU tar unknown pax keyword warnings during extraction", async () => {
    const platform = currentPlatform();
    if (platform === null) return;
    const fixture = await makeFixture(platform);
    const home = tempDir("first-tree-home-");
    const prefix = join(home, "prefix");
    const binDir = join(home, "bin");
    const realTar = commandPath("tar");
    const wrapperDir = tempDir("first-tree-tar-wrapper-");
    writeTarWrapper(wrapperDir);
    const res = spawnSync(
      "sh",
      [join(REPO_ROOT, "scripts", "portable", "install.sh"), "--prefix", prefix, "--bin-dir", binDir, "--no-path-edit"],
      {
        cwd: REPO_ROOT,
        env: {
          ...process.env,
          HOME: home,
          FIRST_TREE_PORTABLE_CHANNEL: "prod",
          FIRST_TREE_PORTABLE_DOWNLOAD_BASE_URL: `file://${fixture}`,
          FT_TEST_REAL_TAR: realTar,
          FT_TEST_REQUIRE_TAR_WARNING: "1",
          PATH: `${wrapperDir}:${process.env.PATH ?? ""}`,
        },
        encoding: "utf8",
      },
    );
    expect(res.status, res.stderr || res.stdout).toBe(0);
    expect(readFileSync(join(prefix, "current", "VERSION"), "utf8")).toBe("1.2.3\n");
  });

  it("repairs PATH shadowing, cleans npm temp residue, and invokes daemon service recovery", async () => {
    const platform = currentPlatform();
    if (platform === null) return;
    const fixture = await makeFixture(platform);
    const home = tempDir("first-tree-home-");
    const prefix = join(home, "prefix");
    const binDir = join(home, "bin");
    const npmBinDir = join(home, "npm-bin");
    const npmRoot = join(home, "npm-root");
    const wrapperDir = join(home, "wrappers");
    const argsLog = join(home, "node-args.log");
    await mkdir(npmBinDir, { recursive: true });
    await mkdir(npmRoot, { recursive: true });
    await mkdir(join(npmRoot, ".first-tree-deadbeef"), { recursive: true });
    await mkdir(wrapperDir, { recursive: true });
    await writeFile(join(npmBinDir, "first-tree"), "#!/bin/sh\necho npm-first-tree\n", { mode: 0o755 });
    await writeFile(
      join(wrapperDir, "npm"),
      '#!/bin/sh\nif [ "$1" = "root" ] && [ "$2" = "-g" ]; then echo "$FT_TEST_NPM_ROOT"; exit 0; fi\nexit 1\n',
      { mode: 0o755 },
    );

    const installArgs = [join(REPO_ROOT, "scripts", "portable", "install.sh"), "--prefix", prefix, "--bin-dir", binDir];
    const env = {
      ...process.env,
      HOME: home,
      SHELL: "/bin/zsh",
      PATH: `${npmBinDir}:${wrapperDir}:${process.env.PATH ?? ""}`,
      FIRST_TREE_PORTABLE_CHANNEL: "prod",
      FIRST_TREE_PORTABLE_DOWNLOAD_BASE_URL: `file://${fixture}`,
      FT_TEST_NODE_ARGS_LOG: argsLog,
      FT_TEST_NPM_ROOT: npmRoot,
    };

    const firstInstall = spawnSync("sh", installArgs, { cwd: REPO_ROOT, env, encoding: "utf8" });
    expect(firstInstall.status, firstInstall.stderr || firstInstall.stdout).toBe(0);
    expect(() => readdirSync(join(npmRoot, ".first-tree-deadbeef"))).toThrow();
    const zshrc = readFileSync(join(home, ".zshrc"), "utf8");
    expect(zshrc.match(/# >>> first-tree portable >>>/g)).toHaveLength(1);
    expect(zshrc).toContain(`export PATH="${binDir}:$PATH"`);

    const secondInstall = spawnSync("sh", installArgs, { cwd: REPO_ROOT, env, encoding: "utf8" });
    expect(secondInstall.status, secondInstall.stderr || secondInstall.stdout).toBe(0);
    const rewrittenZshrc = readFileSync(join(home, ".zshrc"), "utf8");
    expect(rewrittenZshrc.match(/# >>> first-tree portable >>>/g)).toHaveLength(1);

    const nodeArgs = readFileSync(argsLog, "utf8");
    expect(nodeArgs).toContain("app/cli/index.mjs --version");
    expect(nodeArgs).toContain("app/cli/index.mjs daemon ensure-service");
  });

  it("keeps one portable identity across installer, service render, managed update, and real shim refresh", async () => {
    const platform = currentPlatform();
    if (platform === null) return;
    const fixture = tempDir("first-tree-portable-integration-");
    await writeFixtureVersion(fixture, "1.0.0", platform, { integrationRuntime: true });

    const home = tempDir("first-tree-integration-home-");
    const rawPrefix = `${join(home, "portable-parent", "..", "portable-root")}/`;
    const rawBinDir = `${join(home, "bin-parent", "..", "custom-bin")}/`;
    const prefix = resolve(rawPrefix);
    const binDir = resolve(rawBinDir);
    const shim = join(binDir, "first-tree");
    const unitPath = join(home, "rendered.service");
    const integrationLog = join(home, "integration.log");
    const legacyMarker = join(home, "legacy-invoked");
    const legacyBinDir = join(home, "legacy-global-bin");
    const npmRoot = join(home, "npm-root");
    await mkdir(legacyBinDir, { recursive: true });
    await mkdir(npmRoot, { recursive: true });
    await writeFile(join(legacyBinDir, "first-tree"), '#!/bin/sh\nprintf invoked >"$FT_LEGACY_MARKER"\nexit 99\n', {
      mode: 0o755,
    });
    await writeFile(
      join(legacyBinDir, "npm"),
      '#!/bin/sh\nif [ "$1" = "root" ] && [ "$2" = "-g" ]; then echo "$FT_TEST_NPM_ROOT"; exit 0; fi\nexit 1\n',
      { mode: 0o755 },
    );

    const env = {
      ...process.env,
      HOME: home,
      FIRST_TREE_HOME: join(home, "state"),
      FIRST_TREE_CHANNEL: "prod",
      FIRST_TREE_PORTABLE_CHANNEL: "prod",
      FIRST_TREE_PORTABLE_DOWNLOAD_BASE_URL: `file://${fixture}`,
      FIRST_TREE_SERVICE_MODE: "",
      FT_INTEGRATION_UNIT: unitPath,
      FT_INTEGRATION_LOG: integrationLog,
      FT_LEGACY_MARKER: legacyMarker,
      FT_TEST_NPM_ROOT: npmRoot,
      PATH: `${legacyBinDir}:${process.env.PATH ?? ""}`,
    };
    const installer = join(REPO_ROOT, "scripts", "portable", "install.sh");
    const install = spawnSync("sh", [installer, "--prefix", rawPrefix, "--bin-dir", rawBinDir, "--no-path-edit"], {
      cwd: REPO_ROOT,
      env,
      encoding: "utf8",
    });
    expect(install.status, install.stderr || install.stdout).toBe(0);
    expect(realpathSync(join(prefix, "current"))).toBe(realpathSync(join(prefix, "versions", "1.0.0")));

    const login = spawnSync(shim, ["login", "test-code"], { cwd: REPO_ROOT, env, encoding: "utf8" });
    expect(login.status, login.stderr || login.stdout).toBe(0);
    const unitBefore = readFileSync(unitPath, "utf8");
    expect(unitBefore).toContain(shim);
    expect(unitBefore).toContain(join(prefix, "current", "node", "bin"));
    expect(unitBefore).not.toContain("/versions/");
    const oldTree = treeManifest(join(prefix, "versions", "1.0.0"));

    await writeFixtureVersion(fixture, "2.0.0", platform, { integrationRuntime: true });
    const update = spawnSync(shim, ["managed-update", "2.0.0"], { cwd: REPO_ROOT, env, encoding: "utf8" });
    expect(update.status, update.stderr || update.stdout).toBe(75);

    expect(treeManifest(join(prefix, "versions", "1.0.0"))).toBe(oldTree);
    expect(existsSync(legacyMarker)).toBe(false);
    const unitAfter = readFileSync(unitPath, "utf8");
    expect(unitAfter).toContain(shim);
    expect(unitAfter).toContain(join(prefix, "current", "node", "bin"));
    expect(unitAfter).not.toContain("/versions/");
    const log = readFileSync(integrationLog, "utf8");
    expect(log).toContain(`login 1.0.0 ${shim}`);
    expect(log).toContain(`refresh-unit 2.0.0 ${shim}`);

    const version = spawnSync(shim, ["--version"], { cwd: REPO_ROOT, env, encoding: "utf8" });
    expect(version.status, version.stderr).toBe(0);
    expect(version.stdout.trim()).toBe("2.0.0");
  }, 45_000);

  it("replaces the current symlink itself when upgrading with the shell installer", async () => {
    const platform = currentPlatform();
    if (platform === null) return;
    const fixture = await makeFixture(platform);
    const home = tempDir("first-tree-home-");
    const prefix = join(home, "prefix");
    const binDir = join(home, "bin");
    const installArgs = [
      join(REPO_ROOT, "scripts", "portable", "install.sh"),
      "--prefix",
      prefix,
      "--bin-dir",
      binDir,
      "--no-path-edit",
    ];
    const env = {
      ...process.env,
      HOME: home,
      FIRST_TREE_PORTABLE_CHANNEL: "prod",
      FIRST_TREE_PORTABLE_DOWNLOAD_BASE_URL: `file://${fixture}`,
    };

    const firstInstall = spawnSync("sh", installArgs, { cwd: REPO_ROOT, env, encoding: "utf8" });
    expect(firstInstall.status, firstInstall.stderr || firstInstall.stdout).toBe(0);
    expect(readFileSync(join(prefix, "current", "VERSION"), "utf8")).toBe("1.2.3\n");

    await writeFixtureVersion(fixture, "1.2.4", platform);
    const realMv = commandPath("mv");
    const wrapperDir = tempDir("first-tree-mv-wrapper-");
    writeMvWrapper(wrapperDir);
    const secondInstall = spawnSync("sh", installArgs, {
      cwd: REPO_ROOT,
      env: {
        ...env,
        PATH: `${wrapperDir}:${process.env.PATH ?? ""}`,
        FT_TEST_CURRENT_LINK: join(prefix, "current"),
        FT_TEST_FAIL_CURRENT_SWITCH: "0",
        FT_TEST_OLD_VERSION: "1.2.3",
        FT_TEST_REAL_MV: realMv,
        FT_TEST_REQUIRED_MV_FLAG: process.platform === "darwin" ? "-h" : "-T",
      },
      encoding: "utf8",
    });

    expect(secondInstall.status, secondInstall.stderr || secondInstall.stdout).toBe(0);
    expect(readFileSync(join(prefix, "current", "VERSION"), "utf8")).toBe("1.2.4\n");
    expect(readdirSync(join(prefix, "versions", "1.2.3")).filter((entry) => entry.startsWith(".current."))).toEqual([]);
  });

  it("keeps the old current when the candidate runtime smoke check fails", async () => {
    const platform = currentPlatform();
    if (platform === null) return;
    const fixture = await makeFixture(platform);
    const home = tempDir("first-tree-home-");
    const prefix = join(home, "prefix");
    const binDir = join(home, "bin");
    const installArgs = [
      join(REPO_ROOT, "scripts", "portable", "install.sh"),
      "--prefix",
      prefix,
      "--bin-dir",
      binDir,
      "--no-path-edit",
    ];
    const env = {
      ...process.env,
      HOME: home,
      FIRST_TREE_PORTABLE_CHANNEL: "prod",
      FIRST_TREE_PORTABLE_DOWNLOAD_BASE_URL: `file://${fixture}`,
    };

    const firstInstall = spawnSync("sh", installArgs, { cwd: REPO_ROOT, env, encoding: "utf8" });
    expect(firstInstall.status, firstInstall.stderr || firstInstall.stdout).toBe(0);
    const oldShim = readFileSync(join(binDir, "first-tree"), "utf8");

    await writeFixtureVersion(fixture, "1.2.4", platform, { failRuntimeSmoke: true });
    const failedUpgrade = spawnSync("sh", installArgs, { cwd: REPO_ROOT, env, encoding: "utf8" });

    expect(failedUpgrade.status).not.toBe(0);
    expect(failedUpgrade.stderr).toContain("pre-commit runtime smoke check");
    expect(readFileSync(join(prefix, "current", "VERSION"), "utf8")).toBe("1.2.3\n");
    expect(readFileSync(join(binDir, "first-tree"), "utf8")).toBe(oldShim);
  });

  it("leaves the previous current symlink intact when atomic current replacement fails", async () => {
    const platform = currentPlatform();
    if (platform === null) return;
    const fixture = await makeFixture(platform);
    const home = tempDir("first-tree-home-");
    const prefix = join(home, "prefix");
    const binDir = join(home, "bin");
    const installArgs = [
      join(REPO_ROOT, "scripts", "portable", "install.sh"),
      "--prefix",
      prefix,
      "--bin-dir",
      binDir,
      "--no-path-edit",
    ];
    const env = {
      ...process.env,
      HOME: home,
      FIRST_TREE_PORTABLE_CHANNEL: "prod",
      FIRST_TREE_PORTABLE_DOWNLOAD_BASE_URL: `file://${fixture}`,
    };

    const firstInstall = spawnSync("sh", installArgs, { cwd: REPO_ROOT, env, encoding: "utf8" });
    expect(firstInstall.status, firstInstall.stderr || firstInstall.stdout).toBe(0);
    expect(readFileSync(join(prefix, "current", "VERSION"), "utf8")).toBe("1.2.3\n");

    await writeFixtureVersion(fixture, "1.2.4", platform);
    const realMv = commandPath("mv");
    const wrapperDir = tempDir("first-tree-mv-wrapper-");
    writeMvWrapper(wrapperDir);
    const secondInstall = spawnSync("sh", installArgs, {
      cwd: REPO_ROOT,
      env: {
        ...env,
        PATH: `${wrapperDir}:${process.env.PATH ?? ""}`,
        FT_TEST_CURRENT_LINK: join(prefix, "current"),
        FT_TEST_FAIL_CURRENT_SWITCH: "1",
        FT_TEST_OLD_VERSION: "1.2.3",
        FT_TEST_REAL_MV: realMv,
        FT_TEST_REQUIRED_MV_FLAG: process.platform === "darwin" ? "-h" : "-T",
      },
      encoding: "utf8",
    });

    expect(secondInstall.status).not.toBe(0);
    expect(readFileSync(join(prefix, "current", "VERSION"), "utf8")).toBe("1.2.3\n");
    expect(readdirSync(prefix).filter((entry) => entry.startsWith(".current."))).toEqual([]);
    expect(readdirSync(join(prefix, "versions", "1.2.3")).filter((entry) => entry.startsWith(".current."))).toEqual([]);
  });

  it("leaves the previous current symlink intact on checksum failure", async () => {
    const platform = currentPlatform();
    if (platform === null) return;
    const fixture = await makeFixture(platform);
    const latestPath = join(fixture, "prod", "latest.json");
    const latest = JSON.parse(readFileSync(latestPath, "utf8")) as { assets: Array<{ sha256: string }> };
    latest.assets[0].sha256 = "0".repeat(64);
    writeFileSync(latestPath, JSON.stringify(latest, null, 2));
    const home = tempDir("first-tree-home-");
    const prefix = join(home, "prefix");
    await mkdir(join(prefix, "versions", "old"), { recursive: true });
    await writeFile(join(prefix, "versions", "old", "VERSION"), "old\n");
    await symlink(join(prefix, "versions", "old"), join(prefix, "current"));
    const res = spawnSync(
      "sh",
      [
        join(REPO_ROOT, "scripts", "portable", "install.sh"),
        "--prefix",
        prefix,
        "--bin-dir",
        join(home, "bin"),
        "--no-path-edit",
      ],
      {
        cwd: REPO_ROOT,
        env: { ...process.env, HOME: home, FIRST_TREE_PORTABLE_DOWNLOAD_BASE_URL: `file://${fixture}` },
        encoding: "utf8",
      },
    );
    expect(res.status).not.toBe(0);
    expect(readFileSync(join(prefix, "current", "VERSION"), "utf8")).toBe("old\n");
  });

  it("limits --quiet output to errors and the final summary", async () => {
    const platform = currentPlatform();
    if (platform === null) return;
    const fixture = await makeFixture(platform);
    const home = tempDir("first-tree-home-");
    const prefix = join(home, "prefix");
    const binDir = join(home, "bin");
    const res = spawnSync(
      "sh",
      [
        join(REPO_ROOT, "scripts", "portable", "install.sh"),
        "--prefix",
        prefix,
        "--bin-dir",
        binDir,
        "--no-path-edit",
        "--quiet",
      ],
      {
        cwd: REPO_ROOT,
        env: {
          ...process.env,
          HOME: home,
          FIRST_TREE_PORTABLE_CHANNEL: "prod",
          FIRST_TREE_PORTABLE_DOWNLOAD_BASE_URL: `file://${fixture}`,
        },
        encoding: "utf8",
      },
    );

    expect(res.status, res.stderr || res.stdout).toBe(0);
    // The fixture runtime echoes "node-stub ..." for `daemon ensure-service`;
    // quiet mode must hold back successful lifecycle output, not just its own.
    expect(res.stdout).not.toContain("node-stub");
    expect(res.stdout).not.toContain("[1/9]");
    expect(res.stdout).not.toContain("Downloading payload");
    expect(res.stdout).not.toContain("first-tree.ai");
    expect(res.stdout).toContain("First Tree 1.2.3 installed");
    expect(res.stdout).toContain(`Add this to your shell profile: export PATH="${binDir}:$PATH"`);
  });

  it("does not claim the background service is set up when service repair fails", async () => {
    const platform = currentPlatform();
    if (platform === null) return;
    const fixture = tempDir("first-tree-install-test-");
    await writeFixtureVersion(fixture, "1.2.3", platform, { failEnsureService: true });
    const home = tempDir("first-tree-home-");
    const prefix = join(home, "prefix");
    const binDir = join(home, "bin");
    const res = spawnSync(
      "sh",
      [join(REPO_ROOT, "scripts", "portable", "install.sh"), "--prefix", prefix, "--bin-dir", binDir, "--no-path-edit"],
      {
        cwd: REPO_ROOT,
        env: {
          ...process.env,
          HOME: home,
          FIRST_TREE_PORTABLE_CHANNEL: "prod",
          FIRST_TREE_PORTABLE_DOWNLOAD_BASE_URL: `file://${fixture}`,
        },
        encoding: "utf8",
      },
    );

    // A recoverable service failure must not fail the install, and must not be
    // followed by a success line contradicting the warning above it.
    expect(res.status, res.stderr || res.stdout).toBe(0);
    expect(res.stdout).toContain("Background service repair failed or is not available yet.");
    expect(res.stdout).not.toContain("Shell and background service are set up");
    expect(res.stdout).toContain("Install is complete; background service setup still needs login.");
    expect(res.stdout).toContain("First Tree 1.2.3 installed");
    expect(res.stderr).toContain("service repair unavailable");
  });

  it("does not claim readiness when service setup is deferred to a later login", async () => {
    const platform = currentPlatform();
    if (platform === null) return;
    const fixture = tempDir("first-tree-install-test-");
    await writeFixtureVersion(fixture, "1.2.3", platform, { deferEnsureService: true });
    const home = tempDir("first-tree-home-");
    const prefix = join(home, "prefix");
    const binDir = join(home, "bin");
    const res = spawnSync(
      "sh",
      [join(REPO_ROOT, "scripts", "portable", "install.sh"), "--prefix", prefix, "--bin-dir", binDir, "--no-path-edit"],
      {
        cwd: REPO_ROOT,
        env: {
          ...process.env,
          HOME: home,
          FIRST_TREE_PORTABLE_CHANNEL: "prod",
          FIRST_TREE_PORTABLE_DOWNLOAD_BASE_URL: `file://${fixture}`,
        },
        encoding: "utf8",
      },
    );

    // A fresh install with no credentials is the normal path: it succeeds, and
    // must not print a readiness line under the command's own login notice.
    expect(res.status, res.stderr || res.stdout).toBe(0);
    expect(res.stdout).toContain("no credentials found");
    expect(res.stdout).not.toContain("Shell and background service are set up");
    expect(res.stdout).toContain("Install is complete; the background service starts after login.");
    expect(res.stdout).not.toContain("Background service repair failed");
    expect(res.stdout).toContain("First Tree 1.2.3 installed");
  });

  // stdio here is pipes, not a terminal, so this exercises the same branch a
  // `curl ... | sh` bootstrap takes: no progress bar, and no test-only flag.
  it("reaps the payload transfer when the installer is signalled mid-download", async () => {
    const platform = currentPlatform();
    if (platform === null) return;
    const fixture = await makeFixture(platform);
    const home = tempDir("first-tree-home-");
    const prefix = join(home, "prefix");
    const binDir = join(home, "bin");

    const latestPath = join(fixture, "prod", "latest.json");
    const latest = JSON.parse(readFileSync(latestPath, "utf8")) as {
      assets: Array<{ fileName: string; url: string }>;
    };
    const payload = readFileSync(join(fixture, "prod", "1.2.3", latest.assets[0].fileName));

    const totalSlices = 20;
    let requestSeen = false;
    let transferClosed = false;
    let slicesSent = 0;
    const server = createServer(async (_req, res) => {
      requestSeen = true;
      res.on("close", () => {
        transferClosed = true;
      });
      res.writeHead(200, { "content-type": "application/gzip", "content-length": String(payload.length) });
      const slice = Math.max(1, Math.ceil(payload.length / totalSlices));
      for (let offset = 0; offset < payload.length; offset += slice) {
        if (res.destroyed) return;
        res.write(payload.subarray(offset, offset + slice));
        slicesSent += 1;
        await new Promise((done) => setTimeout(done, 150));
      }
      res.end();
    });
    await new Promise<void>((ready) => server.listen(0, "127.0.0.1", ready));
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("throttled fixture server has no TCP port");
    latest.assets[0].url = `http://127.0.0.1:${address.port}/payload.tar.gz`;
    writeFileSync(latestPath, JSON.stringify(latest, null, 2));

    try {
      const child = spawn(
        "sh",
        [
          join(REPO_ROOT, "scripts", "portable", "install.sh"),
          "--prefix",
          prefix,
          "--bin-dir",
          binDir,
          "--no-path-edit",
        ],
        {
          cwd: REPO_ROOT,
          env: {
            ...process.env,
            HOME: home,
            FIRST_TREE_PORTABLE_CHANNEL: "prod",
            FIRST_TREE_PORTABLE_DOWNLOAD_BASE_URL: `file://${fixture}`,
          },
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      child.stdout.resume();
      child.stderr.resume();
      const exited = new Promise<number | null>((done) => child.on("exit", (code) => done(code)));

      const startDeadline = Date.now() + 10_000;
      while (!requestSeen && Date.now() < startDeadline) await new Promise((done) => setTimeout(done, 25));
      expect(requestSeen).toBe(true);
      await new Promise((done) => setTimeout(done, 400));

      child.kill("SIGTERM");
      // The trap aborts instead of resuming, so the shell exits deliberately.
      expect(await exited).toBe(130);

      // The transfer must die with the installer. Killing only the wrapper that
      // waits on it reparents curl/wget to init, where it keeps writing into a
      // work directory that has already been removed.
      const closeDeadline = Date.now() + 5_000;
      while (!transferClosed && Date.now() < closeDeadline) await new Promise((done) => setTimeout(done, 25));
      expect(transferClosed).toBe(true);
      // Guards against passing vacuously: the signal has to cut the transfer
      // short rather than the installer quietly finishing the download first.
      expect(slicesSent).toBeLessThan(totalSlices);
      const slicesAtAbort = slicesSent;
      await new Promise((done) => setTimeout(done, 600));
      expect(slicesSent).toBe(slicesAtAbort);
      expect(existsSync(join(prefix, "current"))).toBe(false);
    } finally {
      await new Promise<void>((closed) => server.close(() => closed()));
    }
  }, 30_000);
});
