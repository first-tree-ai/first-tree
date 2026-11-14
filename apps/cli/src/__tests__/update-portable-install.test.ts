import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { mkdir, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, delimiter, dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const childRegistryMocks = vi.hoisted(() => ({
  classify: vi.fn(),
  ERROR_KINDS: { TRANSIENT: "transient", PERMANENT: "permanent" },
  getChildProcessRegistry: vi.fn(),
}));
const cliFetchMock = vi.hoisted(() => vi.fn());

vi.mock("@first-tree/client", () => childRegistryMocks);
vi.mock("../core/cli-fetch.js", () => ({ cliFetch: cliFetchMock }));

let tmpDirs: string[] = [];
const originalPlatform = process.platform;
const originalArch = process.arch;
const originalPath = process.env.PATH;

function sanitizedHostPath(): string {
  return (originalPath ?? "")
    .split(delimiter)
    .filter((entry) => entry.length > 0 && !existsSync(join(entry, "first-tree")) && !existsSync(join(entry, "ft")))
    .join(delimiter);
}

function isolatedPortablePath(binDir: string): string {
  const hostPath = sanitizedHostPath();
  return hostPath.length > 0 ? `${binDir}${delimiter}${hostPath}` : binDir;
}

function tempDir(name: string): string {
  const dir = mkdtempSync(join(tmpdir(), name));
  tmpDirs.push(dir);
  return dir;
}

function currentPlatform(): string | null {
  if (process.platform !== "linux" && process.platform !== "darwin") return null;
  if (process.arch !== "x64" && process.arch !== "arm64") return null;
  return `${process.platform}-${process.arch === "x64" ? "x64" : "arm64"}`;
}

function bytes(path: string): number {
  return statSync(path).size;
}

function sha256(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

async function makeArtifactPayload(options: {
  version: string;
  platform: string;
  nodeVersion?: string;
  packageName?: string;
  binName?: string;
  aliasName?: string;
  installOverrides?: Record<string, unknown>;
}): Promise<string> {
  const payload = tempDir("ft-portable-payload-");
  const nodeVersion = options.nodeVersion ?? "v24.0.0";
  const packageName = options.packageName ?? "first-tree";
  const binName = options.binName ?? "first-tree";
  const aliasName = options.aliasName ?? "ft";
  await mkdir(join(payload, "node", "bin"), { recursive: true });
  await mkdir(join(payload, "app", "cli"), { recursive: true });
  await mkdir(join(payload, "bin"), { recursive: true });
  await writeFile(join(payload, "node", "bin", "node"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  await writeFile(join(payload, "app", "cli", "index.mjs"), "// fixture\n");
  await writeFile(
    join(payload, "app", "package.json"),
    JSON.stringify({ name: packageName, version: options.version }),
  );
  await writeFile(join(payload, "VERSION"), `${options.version}\n`);
  await writeFile(
    join(payload, "INSTALL.json"),
    JSON.stringify(
      {
        schemaVersion: 1,
        channel: "prod",
        version: options.version,
        gitSha: "abc123",
        nodeVersion,
        packageName,
        binName,
        aliasName,
        generatedAt: new Date().toISOString(),
        platform: options.platform,
        installMode: "portable",
        appEntry: "app/cli/index.mjs",
        ...options.installOverrides,
      },
      null,
      2,
    ),
  );
  await writeFile(join(payload, "bin", binName), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  await writeFile(join(payload, "bin", aliasName), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  return payload;
}

async function makePortableFixture(
  options: {
    version?: string;
    nodeVersion?: string;
    packageName?: string;
    binName?: string;
    aliasName?: string;
    installOverrides?: Record<string, unknown>;
  } = {},
): Promise<{ root: string; latestPath: string; manifestPath: string; tarball: string; platform: string }> {
  const platform = currentPlatform();
  if (platform === null) throw new Error("unsupported test platform");
  const version = options.version ?? "1.2.3";
  const nodeVersion = options.nodeVersion ?? "v24.0.0";
  const packageName = options.packageName ?? "first-tree";
  const binName = options.binName ?? "first-tree";
  const aliasName = options.aliasName ?? "ft";
  const root = tempDir("ft-portable-fixture-");
  const channelDir = join(root, "prod");
  const versionDir = join(channelDir, version);
  mkdirSync(versionDir, { recursive: true });

  const payload = await makeArtifactPayload({
    version,
    platform,
    nodeVersion,
    packageName,
    binName,
    aliasName,
    installOverrides: options.installOverrides,
  });
  const tarball = join(versionDir, `${packageName}-${version}-${platform}.tar.gz`);
  const tar = spawnSync("tar", ["-czf", tarball, "-C", payload, "."], { encoding: "utf8" });
  if (tar.status !== 0) throw new Error(tar.stderr);

  const base = {
    schemaVersion: 1,
    channel: "prod",
    version,
    gitSha: "abc123",
    nodeVersion,
    packageName,
    binName,
    aliasName,
    generatedAt: new Date().toISOString(),
  };
  const asset = {
    platform,
    fileName: `${packageName}-${version}-${platform}.tar.gz`,
    url: `file://${tarball}`,
    sha256: sha256(tarball),
    size: bytes(tarball),
  };
  const latestPath = join(channelDir, "latest.json");
  const manifestPath = join(versionDir, "manifest.json");
  writeFileSync(
    latestPath,
    JSON.stringify({ ...base, manifestUrl: `file://${manifestPath}`, assets: [asset] }, null, 2),
  );
  writeFileSync(manifestPath, JSON.stringify({ ...base, assets: [asset] }, null, 2));
  return { root, latestPath, manifestPath, tarball, platform };
}

function stableShimContents(root: string, binDir: string): string {
  return `#!/bin/sh
set -eu
root='${root}'
bin_dir='${binDir}'
export FIRST_TREE_INSTALL_MODE=portable
export FIRST_TREE_PORTABLE_ROOT="$root"
export FIRST_TREE_PORTABLE_BIN_DIR="$bin_dir"
exec "$root/node/bin/node" "$root/app/cli/index.mjs" "$@"
`;
}

function configurePortableIdentity(prefix: string, binDir = join(dirname(prefix), ".local", "bin")): void {
  const root = join(prefix, "current");
  mkdirSync(binDir, { recursive: true });
  writeFileSync(join(binDir, "first-tree"), stableShimContents(root, binDir), { mode: 0o755 });
  writeFileSync(join(binDir, "ft"), stableShimContents(root, binDir), { mode: 0o755 });
  vi.stubEnv("FIRST_TREE_INSTALL_MODE", "portable");
  vi.stubEnv("FIRST_TREE_PORTABLE_ROOT", root);
  vi.stubEnv("FIRST_TREE_PORTABLE_BIN_DIR", binDir);
}

async function seedOldInstall(prefix: string, options: { nodeVersion?: string; binDir?: string } = {}): Promise<void> {
  const nodeVersion = options.nodeVersion ?? "v24.0.0";
  await mkdir(join(prefix, "versions", "old"), { recursive: true });
  await writeFile(join(prefix, "versions", "old", "VERSION"), "old\n");
  await writeFile(
    join(prefix, "versions", "old", "INSTALL.json"),
    JSON.stringify({
      schemaVersion: 1,
      channel: "prod",
      version: "0.1.0",
      gitSha: "old",
      nodeVersion,
      packageName: "first-tree",
      binName: "first-tree",
      aliasName: "ft",
      generatedAt: new Date().toISOString(),
      platform: currentPlatform(),
      installMode: "portable",
      appEntry: "app/cli/index.mjs",
    }),
  );
  await symlink(join(prefix, "versions", "old"), join(prefix, "current"));
  const binDir = options.binDir ?? join(dirname(prefix), ".local", "bin");
  configurePortableIdentity(prefix, binDir);
}

async function importProdUpdateModule(
  overrides: { channelPrefix?: string | null; downloadBaseUrl?: string | null; packageName?: string | null } = {},
): Promise<typeof import("../core/update.js")> {
  vi.resetModules();
  vi.doMock("../core/channel.js", () => ({
    channelConfig: {
      channel: "prod",
      binName: "first-tree",
      aliasName: "ft",
      packageName: overrides.packageName === undefined ? "first-tree" : overrides.packageName,
      defaultHome: "/tmp/home",
      defaultServerUrl: "https://cloud.first-tree.ai",
      serviceUnitFile: "first-tree.service",
      launchdLabel: "first-tree",
      launchdPlistFile: "first-tree.plist",
      displayName: "First Tree",
      portable: {
        channelPrefix: overrides.channelPrefix === undefined ? "prod" : overrides.channelPrefix,
        publicInstallerPath: "prod/install.sh",
        downloadBaseUrl:
          overrides.downloadBaseUrl === undefined
            ? "https://download.first-tree.ai/releases"
            : overrides.downloadBaseUrl,
      },
    },
  }));
  return import("../core/update.js");
}

beforeEach(() => {
  vi.clearAllMocks();
  childRegistryMocks.classify.mockReturnValue({ kind: "permanent", reasonCode: "classified" });
  const binDir = tempDir("ft-portable-bin-");
  writeFileSync(join(binDir, "first-tree"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  // Portable updates intentionally rewrite the first installed shim on PATH.
  // Keep every test inside a disposable shim directory and exclude operator
  // installs from the inherited PATH so a test can never rewrite them.
  vi.stubEnv("PATH", isolatedPortablePath(binDir));
  vi.stubEnv("FIRST_TREE_INSTALL_MODE", "");
  vi.stubEnv("FIRST_TREE_PORTABLE_ROOT", "");
  vi.stubEnv("FIRST_TREE_PORTABLE_BIN_DIR", "");
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.doUnmock("../core/channel.js");
  vi.doUnmock("node:child_process");
  vi.doUnmock("node:fs/promises");
  Object.defineProperty(process, "platform", { configurable: true, value: originalPlatform });
  Object.defineProperty(process, "arch", { configurable: true, value: originalArch });
  if (originalPath === undefined) delete process.env.PATH;
  else process.env.PATH = originalPath;
  for (const dir of tmpDirs) rmSync(dir, { recursive: true, force: true });
  tmpDirs = [];
});

describe("installPortableSpec", () => {
  it("rejects invalid specs and disabled portable metadata configuration", async () => {
    const prod = await importProdUpdateModule();
    await expect(prod.installPortableSpec("not-a-version")).resolves.toMatchObject({
      ok: false,
      mode: "portable",
      reason: expect.stringContaining("invalid portable version"),
    });

    const noChannel = await importProdUpdateModule({ channelPrefix: null });
    await expect(noChannel.fetchPortableLatestVersion()).resolves.toEqual({
      ok: false,
      reason: "self-update disabled: this binary's channel does not publish portable artifacts.",
    });

    const noBaseUrl = await importProdUpdateModule({ downloadBaseUrl: null });
    await expect(noBaseUrl.fetchPortableLatestVersion()).resolves.toEqual({
      ok: false,
      reason: "self-update disabled: portable download base URL is not configured for this channel.",
    });
  });

  it("surfaces HTTP metadata download failures for portable latest checks", async () => {
    const platform = currentPlatform() ?? "linux-x64";
    cliFetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      text: vi.fn(async () =>
        JSON.stringify({
          schemaVersion: 1,
          channel: "prod",
          version: "3.1.4",
          gitSha: "abc123",
          nodeVersion: "v24.0.0",
          packageName: "first-tree",
          binName: "first-tree",
          aliasName: "ft",
          generatedAt: new Date().toISOString(),
          manifestUrl: "https://download.example/releases/prod/3.1.4/manifest.json",
          assets: [
            {
              platform,
              fileName: `first-tree-3.1.4-${platform}.tar.gz`,
              url: "https://download.example/payload.tar.gz",
              sha256: "0".repeat(64),
              size: 123,
            },
          ],
        }),
      ),
    });
    const http = await importProdUpdateModule({ downloadBaseUrl: "https://download.example/releases/" });

    await expect(http.fetchPortableLatestVersion()).resolves.toEqual({ ok: true, version: "3.1.4" });

    cliFetchMock.mockResolvedValueOnce({
      ok: false,
      status: 503,
      text: vi.fn(async () => "unavailable"),
    });

    await expect(http.fetchPortableLatestVersion()).resolves.toEqual({
      ok: false,
      reason: "download failed for https://download.example/releases/prod/latest.json: HTTP 503",
    });

    cliFetchMock.mockRejectedValueOnce(new Error("network down"));
    await expect(http.fetchPortableLatestVersion()).resolves.toEqual({ ok: false, reason: "network down" });

    cliFetchMock.mockRejectedValueOnce("network string");
    await expect(http.fetchPortableLatestVersion()).resolves.toEqual({ ok: false, reason: "network string" });

    cliFetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      text: vi.fn(async () =>
        JSON.stringify({
          schemaVersion: 1,
          channel: "prod",
          version: "not-semver",
          gitSha: "abc123",
          nodeVersion: "v24.0.0",
          packageName: "first-tree",
          binName: "first-tree",
          aliasName: "ft",
          generatedAt: new Date().toISOString(),
          manifestUrl: "https://download.example/releases/prod/not-semver/manifest.json",
          assets: [
            {
              platform,
              fileName: `first-tree-not-semver-${platform}.tar.gz`,
              url: "https://download.example/payload.tar.gz",
              sha256: "0".repeat(64),
              size: 123,
            },
          ],
        }),
      ),
    });
    await expect(http.fetchPortableLatestVersion()).resolves.toEqual({
      ok: false,
      reason:
        'Refusing portable latest metadata: portable metadata version not-semver belongs to channel "unknown", not my channel "prod"',
    });

    const parseSpy = vi.spyOn(JSON, "parse").mockImplementationOnce(() => {
      throw "bad json string";
    });
    cliFetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      text: vi.fn(async () => "{}"),
    });
    try {
      await expect(http.fetchPortableLatestVersion()).resolves.toEqual({
        ok: false,
        reason: "invalid JSON from https://download.example/releases/prod/latest.json: bad json string",
      });
    } finally {
      parseSpy.mockRestore();
    }
  });

  it("fails closed when portable self-update is unsupported on this platform", async () => {
    Object.defineProperty(process, "platform", { configurable: true, value: "win32" });
    const prod = await importProdUpdateModule();

    await expect(prod.installPortableSpec("latest")).resolves.toMatchObject({
      ok: false,
      mode: "portable",
      reason: expect.stringContaining("portable self-update is not supported on win32"),
    });

    Object.defineProperty(process, "platform", { configurable: true, value: originalPlatform });
    Object.defineProperty(process, "arch", { configurable: true, value: "s390x" });
    const unsupportedArch = await importProdUpdateModule();
    await expect(unsupportedArch.installPortableSpec("latest")).resolves.toMatchObject({
      ok: false,
      mode: "portable",
      reason: expect.stringContaining(`${originalPlatform}-s390x`),
    });

    Object.defineProperty(process, "platform", { configurable: true, value: originalPlatform });
    Object.defineProperty(process, "arch", { configurable: true, value: "arm64" });
    const arm64NoChannel = await importProdUpdateModule({ channelPrefix: null });
    await expect(arm64NoChannel.installPortableSpec("latest")).resolves.toMatchObject({
      ok: false,
      mode: "portable",
      reason: "self-update disabled: this binary's channel does not publish portable artifacts.",
    });
  });

  it("fails closed before metadata fetch when portable metadata URLs are unavailable", async () => {
    const noChannel = await importProdUpdateModule({ channelPrefix: null });
    await expect(noChannel.installPortableSpec("latest")).resolves.toMatchObject({
      ok: false,
      mode: "portable",
      reason: "self-update disabled: this binary's channel does not publish portable artifacts.",
    });

    const noBaseUrl = await importProdUpdateModule({ downloadBaseUrl: null });
    await expect(noBaseUrl.installPortableSpec("latest")).resolves.toMatchObject({
      ok: false,
      mode: "portable",
      reason: "self-update disabled: portable download base URL is not configured for this channel.",
    });

    const devChannel = await importProdUpdateModule({ packageName: null });
    expect(devChannel.fetchLatestVersion()).toEqual({
      ok: false,
      reason: "this binary's channel does not publish to npm (dev channel).",
    });
  });

  it("installs latest from file metadata, switches current, and rewrites shims", async () => {
    const platform = currentPlatform();
    if (platform === null) return;
    const fixture = await makePortableFixture();
    const home = tempDir("ft-portable-home-");
    const prefix = join(home, "prefix");
    const binDir = join(home, "bin");
    const legacyBinDir = join(home, "legacy-global-bin");
    const legacyBin = join(legacyBinDir, "first-tree");
    await seedOldInstall(prefix, { binDir });
    mkdirSync(legacyBinDir, { recursive: true });
    writeFileSync(legacyBin, "#!/bin/sh\necho stale-global\n", { mode: 0o755 });
    const oldSentinel = join(prefix, "versions", "old", "node", "lib", "node_modules", "first-tree", "sentinel");
    mkdirSync(dirname(oldSentinel), { recursive: true });
    writeFileSync(oldSentinel, "immutable-old-version\n");
    vi.stubEnv("FIRST_TREE_PORTABLE_ROOT", join(prefix, "current"));
    vi.stubEnv("FIRST_TREE_PORTABLE_DOWNLOAD_BASE_URL", `file://${fixture.root}`);
    vi.stubEnv("HOME", home);
    vi.stubEnv("PATH", `${legacyBinDir}${delimiter}${binDir}${delimiter}${process.env.PATH ?? ""}`);

    const { installPortableSpec } = await importProdUpdateModule();
    await expect(installPortableSpec("latest")).resolves.toEqual({
      ok: true,
      mode: "portable",
      installedVersion: "1.2.3",
    });

    expect(readFileSync(join(prefix, "current", "VERSION"), "utf8")).toBe("1.2.3\n");
    const shim = readFileSync(join(binDir, "first-tree"), "utf8");
    expect(shim).toContain("FIRST_TREE_INSTALL_MODE=portable");
    expect(shim).toContain(`FIRST_TREE_PORTABLE_ROOT="$root"`);
    expect(shim).toContain(`FIRST_TREE_PORTABLE_BIN_DIR="$bin_dir"`);
    expect(readFileSync(join(binDir, "ft"), "utf8")).toContain("root='");
    expect(readFileSync(legacyBin, "utf8")).toBe("#!/bin/sh\necho stale-global\n");
    expect(readFileSync(oldSentinel, "utf8")).toBe("immutable-old-version\n");
  });

  it("refuses to overwrite an alias shim another tool owns", async () => {
    const platform = currentPlatform();
    if (platform === null) return;
    const fixture = await makePortableFixture();
    const home = tempDir("ft-portable-home-");
    const prefix = join(home, "prefix");
    const binDir = join(home, "bin");
    await seedOldInstall(prefix, { binDir });
    // `ft` is a generic name; the updater must not replace a file it does not
    // manage (SEC-057).
    const foreignAlias = join(binDir, "ft");
    const foreignBody = "#!/bin/sh\necho someone-elses-tool\n";
    writeFileSync(foreignAlias, foreignBody, { mode: 0o755 });
    vi.stubEnv("FIRST_TREE_PORTABLE_ROOT", join(prefix, "current"));
    vi.stubEnv("FIRST_TREE_PORTABLE_DOWNLOAD_BASE_URL", `file://${fixture.root}`);
    vi.stubEnv("HOME", home);
    vi.stubEnv("PATH", sanitizedHostPath());

    const { installPortableSpec } = await importProdUpdateModule();
    const result = await installPortableSpec("latest");

    expect(result).toMatchObject({ ok: false, mode: "portable" });
    expect(JSON.stringify(result)).toContain(foreignAlias);
    expect(JSON.stringify(result)).toContain("FIRST_TREE_PORTABLE_BIN_DIR");
    expect(readFileSync(foreignAlias, "utf8")).toBe(foreignBody);
    // Refusing happens before the commit point, so `current` still names the
    // working old version.
    expect(readFileSync(join(prefix, "current", "VERSION"), "utf8")).toBe("old\n");
  });

  it("upgrades legacy shims that already point at this prefix", async () => {
    const platform = currentPlatform();
    if (platform === null) return;
    const fixture = await makePortableFixture();
    const home = tempDir("ft-portable-home-");
    const prefix = join(home, "prefix");
    const binDir = join(home, ".local", "bin");
    await mkdir(join(prefix, "versions", "old"), { recursive: true });
    await writeFile(join(prefix, "versions", "old", "VERSION"), "old\n");
    await writeFile(
      join(prefix, "versions", "old", "INSTALL.json"),
      JSON.stringify({
        schemaVersion: 1,
        channel: "prod",
        version: "0.1.0",
        gitSha: "old",
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
    await symlink(join(prefix, "versions", "old"), join(prefix, "current"));
    // Pre-bin-dir shims: the root is double-quoted and no bin directory is
    // exported. They still belong to this install, so the ownership gate must
    // accept them or an existing user could never upgrade again.
    mkdirSync(binDir, { recursive: true });
    const legacyShim = `#!/bin/sh
set -eu
root="${join(prefix, "current")}"
export FIRST_TREE_INSTALL_MODE=portable
export FIRST_TREE_PORTABLE_ROOT="$root"
exec "$root/node/bin/node" "$root/app/cli/index.mjs" "$@"
`;
    for (const name of ["first-tree", "ft"]) {
      writeFileSync(join(binDir, name), legacyShim, { mode: 0o755 });
    }
    vi.stubEnv("FIRST_TREE_PORTABLE_ROOT", join(prefix, "current"));
    vi.stubEnv("FIRST_TREE_PORTABLE_BIN_DIR", "");
    vi.stubEnv("FIRST_TREE_PORTABLE_DOWNLOAD_BASE_URL", `file://${fixture.root}`);
    vi.stubEnv("HOME", home);
    vi.stubEnv("PATH", sanitizedHostPath());

    const { installPortableSpec } = await importProdUpdateModule();
    await expect(installPortableSpec("latest")).resolves.toEqual({
      ok: true,
      mode: "portable",
      installedVersion: "1.2.3",
    });
    expect(readFileSync(join(binDir, "first-tree"), "utf8")).toContain("FIRST_TREE_PORTABLE_BIN_DIR");
    expect(readFileSync(join(binDir, "ft"), "utf8")).toContain("FIRST_TREE_PORTABLE_BIN_DIR");
    expect(readFileSync(join(prefix, "current", "VERSION"), "utf8")).toBe("1.2.3\n");
  });

  it("downloads portable payloads over HTTP and writes fallback shims when PATH has no existing shim", async () => {
    const platform = currentPlatform();
    if (platform === null) return;
    const fixture = await makePortableFixture();
    const latest = JSON.parse(readFileSync(fixture.latestPath, "utf8")) as {
      assets: Array<{ url: string }>;
    };
    latest.assets[0].url = "https://download.example/payload.tar.gz";
    writeFileSync(fixture.latestPath, JSON.stringify(latest, null, 2));
    const payload = readFileSync(fixture.tarball);
    cliFetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      arrayBuffer: vi.fn(async () => payload.buffer.slice(payload.byteOffset, payload.byteOffset + payload.byteLength)),
    });
    const home = tempDir("ft-portable-home-");
    const prefix = join(home, "prefix");
    await seedOldInstall(prefix);
    vi.stubEnv("FIRST_TREE_PORTABLE_ROOT", join(prefix, "current"));
    vi.stubEnv("FIRST_TREE_PORTABLE_DOWNLOAD_BASE_URL", `file://${fixture.root}`);
    vi.stubEnv("HOME", home);
    vi.stubEnv("PATH", sanitizedHostPath());

    const { installPortableSpec } = await importProdUpdateModule();
    await expect(installPortableSpec("latest")).resolves.toEqual({
      ok: true,
      mode: "portable",
      installedVersion: "1.2.3",
    });

    expect(readFileSync(join(home, ".local", "bin", "first-tree"), "utf8")).toContain("FIRST_TREE_PORTABLE_ROOT");
    expect(readFileSync(join(home, ".local", "bin", "ft"), "utf8")).toContain("FIRST_TREE_PORTABLE_ROOT");
  });

  it("reports invalid portable roots and HTTP payload download failures", async () => {
    const platform = currentPlatform();
    if (platform === null) return;
    const fixture = await makePortableFixture();
    const home = tempDir("ft-portable-home-");
    const prefix = join(home, "prefix");
    await seedOldInstall(prefix);
    vi.stubEnv("FIRST_TREE_PORTABLE_DOWNLOAD_BASE_URL", `file://${fixture.root}`);
    vi.stubEnv("FIRST_TREE_PORTABLE_ROOT", join(prefix, "not-current"));

    const { installPortableSpec } = await importProdUpdateModule();
    await expect(installPortableSpec("latest")).resolves.toMatchObject({
      ok: false,
      mode: "portable",
      reason: expect.stringContaining("must name the stable current symlink"),
    });

    const httpFixture = await makePortableFixture({ version: "1.2.4" });
    const latest = JSON.parse(readFileSync(httpFixture.latestPath, "utf8")) as {
      assets: Array<{ url: string }>;
    };
    latest.assets[0].url = "https://download.example/payload.tar.gz";
    writeFileSync(httpFixture.latestPath, JSON.stringify(latest, null, 2));
    cliFetchMock.mockResolvedValueOnce({
      ok: false,
      status: 502,
      arrayBuffer: vi.fn(async () => new ArrayBuffer(0)),
    });
    vi.stubEnv("FIRST_TREE_PORTABLE_ROOT", join(prefix, "current"));
    vi.stubEnv("FIRST_TREE_PORTABLE_DOWNLOAD_BASE_URL", `file://${httpFixture.root}`);

    await expect(installPortableSpec("latest")).resolves.toMatchObject({
      ok: false,
      mode: "portable",
      reason: "download failed for https://download.example/payload.tar.gz: HTTP 502",
    });
  });

  it("installs exact versions from immutable manifests", async () => {
    const platform = currentPlatform();
    if (platform === null) return;
    const fixture = await makePortableFixture({ version: "2.0.0" });
    const home = tempDir("ft-portable-home-");
    const prefix = join(home, "prefix");
    await seedOldInstall(prefix);
    vi.stubEnv("FIRST_TREE_PORTABLE_ROOT", join(prefix, "current"));
    vi.stubEnv("FIRST_TREE_PORTABLE_DOWNLOAD_BASE_URL", `file://${fixture.root}`);
    vi.stubEnv("HOME", home);

    const { installPortableSpec } = await importProdUpdateModule();
    const result = await installPortableSpec("2.0.0");
    expect(result).toEqual({ ok: true, mode: "portable", installedVersion: "2.0.0" });
    expect(readFileSync(join(prefix, "current", "VERSION"), "utf8")).toBe("2.0.0\n");
  });

  it("validates an already extracted portable version before switching current", async () => {
    const platform = currentPlatform();
    if (platform === null) return;
    const fixture = await makePortableFixture({ version: "2.0.1" });
    const home = tempDir("ft-portable-home-");
    const prefix = join(home, "prefix");
    await seedOldInstall(prefix);
    const existingVersionDir = join(prefix, "versions", "2.0.1");
    const payload = await makeArtifactPayload({ version: "2.0.1", platform });
    mkdirSync(join(prefix, "versions"), { recursive: true });
    spawnSync("cp", ["-R", `${payload}/.`, existingVersionDir], { encoding: "utf8" });
    vi.stubEnv("FIRST_TREE_PORTABLE_ROOT", join(prefix, "current"));
    vi.stubEnv("FIRST_TREE_PORTABLE_DOWNLOAD_BASE_URL", `file://${fixture.root}`);
    vi.stubEnv("HOME", home);
    delete process.env.PATH;

    const { installPortableSpec } = await importProdUpdateModule();
    const result = await installPortableSpec("latest");

    expect(result).toEqual({ ok: true, mode: "portable", installedVersion: "2.0.1" });
    expect(readFileSync(join(prefix, "current", "VERSION"), "utf8")).toBe("2.0.1\n");
    expect(readFileSync(join(home, ".local", "bin", "first-tree"), "utf8")).toContain("FIRST_TREE_PORTABLE_ROOT");
  });

  it("hands portable installs across bundled Node major upgrades", async () => {
    const platform = currentPlatform();
    if (platform === null) return;
    const fixture = await makePortableFixture({ version: "2.0.0", nodeVersion: "v25.0.0" });
    const home = tempDir("ft-portable-home-");
    const prefix = join(home, "prefix");
    await seedOldInstall(prefix, { nodeVersion: "v24.11.1" });
    vi.stubEnv("FIRST_TREE_PORTABLE_ROOT", join(prefix, "current"));
    vi.stubEnv("FIRST_TREE_PORTABLE_DOWNLOAD_BASE_URL", `file://${fixture.root}`);
    vi.stubEnv("HOME", home);

    const { installPortableSpec } = await importProdUpdateModule();
    const result = await installPortableSpec("latest");
    expect(result).toEqual({ ok: true, mode: "portable", installedVersion: "2.0.0" });

    const currentInstall = JSON.parse(readFileSync(join(prefix, "current", "INSTALL.json"), "utf8")) as {
      nodeVersion: string;
    };
    const oldInstall = JSON.parse(readFileSync(join(prefix, "versions", "old", "INSTALL.json"), "utf8")) as {
      nodeVersion: string;
    };
    expect(oldInstall.nodeVersion).toBe("v24.11.1");
    expect(currentInstall.nodeVersion).toBe("v25.0.0");
    expect(readFileSync(join(prefix, "current", "VERSION"), "utf8")).toBe("2.0.0\n");
  });

  it("leaves current intact on checksum mismatch and malformed metadata", async () => {
    const platform = currentPlatform();
    if (platform === null) return;
    const fixture = await makePortableFixture();
    const latest = JSON.parse(readFileSync(fixture.latestPath, "utf8")) as { assets: Array<{ sha256: string }> };
    latest.assets[0].sha256 = "0".repeat(64);
    writeFileSync(fixture.latestPath, JSON.stringify(latest, null, 2));
    const home = tempDir("ft-portable-home-");
    const prefix = join(home, "prefix");
    await seedOldInstall(prefix);
    vi.stubEnv("FIRST_TREE_PORTABLE_ROOT", join(prefix, "current"));
    vi.stubEnv("FIRST_TREE_PORTABLE_DOWNLOAD_BASE_URL", `file://${fixture.root}`);

    const { installPortableSpec } = await importProdUpdateModule();
    const badChecksum = await installPortableSpec("latest");
    expect(badChecksum.ok).toBe(false);
    if (badChecksum.ok) throw new Error("expected checksum failure");
    expect(badChecksum.reason).toContain("checksum mismatch");
    expect(readFileSync(join(prefix, "current", "VERSION"), "utf8")).toBe("old\n");

    writeFileSync(fixture.latestPath, "{not-json");
    const malformed = await installPortableSpec("latest");
    expect(malformed.ok).toBe(false);
    expect(readFileSync(join(prefix, "current", "VERSION"), "utf8")).toBe("old\n");
  });

  it("keeps current on the old version when preparing a stable shim fails", async () => {
    const platform = currentPlatform();
    if (platform === null) return;
    vi.doMock("node:fs/promises", async (importOriginal) => {
      const actual = await importOriginal<typeof import("node:fs/promises")>();
      return {
        ...actual,
        writeFile: async (
          path: Parameters<typeof actual.writeFile>[0],
          data: Parameters<typeof actual.writeFile>[1],
          options?: Parameters<typeof actual.writeFile>[2],
        ) => {
          if (basename(String(path)).startsWith("ft.")) throw new Error("alias shim write denied");
          return actual.writeFile(path, data, options);
        },
      };
    });
    const fixture = await makePortableFixture({ version: "3.0.0" });
    const home = tempDir("ft-portable-home-");
    const prefix = join(home, "prefix");
    await seedOldInstall(prefix);
    vi.stubEnv("FIRST_TREE_PORTABLE_DOWNLOAD_BASE_URL", `file://${fixture.root}`);

    const { installPortableSpec } = await importProdUpdateModule();
    const result = await installPortableSpec("latest");

    expect(result).toMatchObject({ ok: false, mode: "portable", reason: "alias shim write denied" });
    expect(readFileSync(join(prefix, "current", "VERSION"), "utf8")).toBe("old\n");
    expect(readFileSync(join(home, ".local", "bin", "first-tree"), "utf8")).toContain(
      `FIRST_TREE_PORTABLE_ROOT="$root"`,
    );
  });

  it("keeps a committed update successful when temporary cleanup fails", async () => {
    const platform = currentPlatform();
    if (platform === null) return;
    const fixture = await makePortableFixture({ version: "3.1.0" });
    const home = tempDir("ft-portable-home-");
    const prefix = join(home, "prefix");
    await seedOldInstall(prefix);
    const cleanupPrefix = join(prefix, ".tmp", "update-");
    let cleanupAttempts = 0;
    vi.doMock("node:fs/promises", async (importOriginal) => {
      const actual = await importOriginal<typeof import("node:fs/promises")>();
      return {
        ...actual,
        rm: async (path: Parameters<typeof actual.rm>[0], options?: Parameters<typeof actual.rm>[1]) => {
          if (String(path).startsWith(cleanupPrefix) && options?.recursive) {
            cleanupAttempts += 1;
            throw new Error("temporary cleanup denied");
          }
          return actual.rm(path, options);
        },
      };
    });
    vi.stubEnv("FIRST_TREE_PORTABLE_DOWNLOAD_BASE_URL", `file://${fixture.root}`);

    const { installPortableSpec } = await importProdUpdateModule();
    const result = await installPortableSpec("latest");

    expect(result).toEqual({ ok: true, mode: "portable", installedVersion: "3.1.0" });
    expect(cleanupAttempts).toBe(1);
    expect(readFileSync(join(prefix, "current", "VERSION"), "utf8")).toBe("3.1.0\n");
  });

  it("rejects channel, package, bin, alias, version-channel, and asset name mismatches", async () => {
    const platform = currentPlatform();
    if (platform === null) return;
    const home = tempDir("ft-portable-home-");
    const prefix = join(home, "prefix");
    await seedOldInstall(prefix);
    vi.stubEnv("FIRST_TREE_PORTABLE_ROOT", join(prefix, "current"));

    const { installPortableSpec } = await importProdUpdateModule();
    for (const patch of [
      { channel: "staging", version: "1.2.3-staging.1.1" },
      { packageName: "first-tree-staging" },
      { binName: "first-tree-staging" },
      { aliasName: "first-tree-staging" },
      { version: "1.2.3-staging.1.1" },
    ]) {
      const fixture = await makePortableFixture();
      const latest = JSON.parse(readFileSync(fixture.latestPath, "utf8")) as Record<string, unknown>;
      Object.assign(latest, patch);
      writeFileSync(fixture.latestPath, JSON.stringify(latest, null, 2));
      vi.stubEnv("FIRST_TREE_PORTABLE_DOWNLOAD_BASE_URL", `file://${fixture.root}`);
      const result = await installPortableSpec("latest");
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("expected mismatch failure");
      expect(result.reason).toMatch(/Refusing to install portable update|invalid/i);
      expect(readFileSync(join(prefix, "current", "VERSION"), "utf8")).toBe("old\n");
    }

    const fixture = await makePortableFixture();
    const latest = JSON.parse(readFileSync(fixture.latestPath, "utf8")) as {
      assets: Array<{ fileName: string }>;
    };
    latest.assets[0].fileName = "../payload.tar.gz";
    writeFileSync(fixture.latestPath, JSON.stringify(latest, null, 2));
    vi.stubEnv("FIRST_TREE_PORTABLE_DOWNLOAD_BASE_URL", `file://${fixture.root}`);
    const badAsset = await installPortableSpec("latest");
    expect(badAsset.ok).toBe(false);
    if (badAsset.ok) throw new Error("expected unsafe asset failure");
    expect(badAsset.reason).toContain("portable asset fileName is not a safe basename");
  });

  it("rejects missing portable assets, empty roots, and null package channel mismatches", async () => {
    const platform = currentPlatform();
    if (platform === null) return;
    const fixture = await makePortableFixture();
    const latest = JSON.parse(readFileSync(fixture.latestPath, "utf8")) as {
      assets: Array<{ platform: string }>;
    };
    latest.assets[0].platform = platform === "linux-x64" ? "darwin-x64" : "linux-x64";
    writeFileSync(fixture.latestPath, JSON.stringify(latest, null, 2));
    vi.stubEnv("FIRST_TREE_PORTABLE_DOWNLOAD_BASE_URL", `file://${fixture.root}`);
    const { installPortableSpec } = await importProdUpdateModule();

    await expect(installPortableSpec("latest")).resolves.toMatchObject({
      ok: false,
      reason: expect.stringContaining(`No portable asset for ${platform}`),
    });

    const rootFixture = await makePortableFixture({ version: "1.2.4" });
    vi.stubEnv("FIRST_TREE_PORTABLE_DOWNLOAD_BASE_URL", `file://${rootFixture.root}`);
    vi.stubEnv("FIRST_TREE_INSTALL_MODE", "portable");
    vi.stubEnv("FIRST_TREE_PORTABLE_ROOT", "   ");
    await expect(installPortableSpec("latest")).resolves.toMatchObject({
      ok: false,
      reason: expect.stringContaining("missing FIRST_TREE_PORTABLE_ROOT"),
    });

    vi.stubEnv("FIRST_TREE_PORTABLE_DOWNLOAD_BASE_URL", `file://${rootFixture.root}`);
    const nullPackage = await importProdUpdateModule({ packageName: null });
    await expect(nullPackage.installPortableSpec("latest")).resolves.toMatchObject({
      ok: false,
      reason: expect.stringContaining('does not match my package "(none)"'),
    });
  });

  it("rejects extracted INSTALL.json mismatches", async () => {
    const platform = currentPlatform();
    if (platform === null) return;
    const cases: Array<{ installOverrides: Record<string, unknown>; expected: string }> = [
      { installOverrides: { channel: "staging" }, expected: "extracted INSTALL.json mismatch" },
      { installOverrides: { version: "9.9.9" }, expected: 'version "9.9.9" does not match metadata version "1.2.3"' },
      {
        installOverrides: { platform: platform === "linux-x64" ? "darwin-x64" : "linux-x64" },
        expected: "platform",
      },
      { installOverrides: { installMode: "global" }, expected: "installMode" },
      { installOverrides: { appEntry: "dist/index.mjs" }, expected: "appEntry" },
    ];

    const { installPortableSpec } = await importProdUpdateModule();
    for (const testCase of cases) {
      const fixture = await makePortableFixture({ installOverrides: testCase.installOverrides });
      const home = tempDir("ft-portable-home-");
      const prefix = join(home, "prefix");
      await seedOldInstall(prefix);
      vi.stubEnv("FIRST_TREE_PORTABLE_ROOT", join(prefix, "current"));
      vi.stubEnv("FIRST_TREE_PORTABLE_DOWNLOAD_BASE_URL", `file://${fixture.root}`);

      const result = await installPortableSpec("latest");

      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("expected extracted metadata failure");
      expect(result.reason).toContain(testCase.expected);
      expect(readFileSync(join(prefix, "current", "VERSION"), "utf8")).toBe("old\n");
    }
  });

  it("rejects prod-looking latest metadata that is not valid semver", async () => {
    const platform = currentPlatform();
    if (platform === null) return;
    const fixture = await makePortableFixture({ version: "1.2.3" });
    const latest = JSON.parse(readFileSync(fixture.latestPath, "utf8")) as Record<string, unknown>;
    latest.version = "01.2.3";
    writeFileSync(fixture.latestPath, JSON.stringify(latest, null, 2));
    vi.stubEnv("FIRST_TREE_PORTABLE_DOWNLOAD_BASE_URL", `file://${fixture.root}`);

    const { fetchPortableLatestVersion } = await importProdUpdateModule();

    await expect(fetchPortableLatestVersion()).resolves.toEqual({
      ok: false,
      reason: "portable latest metadata returned non-semver version: 01.2.3",
    });
  });

  it("returns classified portable failures for bad tarballs and invalid current links", async () => {
    const platform = currentPlatform();
    if (platform === null) return;
    childRegistryMocks.classify.mockReturnValue({ kind: "transient", reasonCode: "classified_transient" });
    const badTar = await makePortableFixture();
    const invalidTarball = join(badTar.root, "prod", "1.2.3", "not-a-tar.gz");
    writeFileSync(invalidTarball, "not a gzip payload");
    const latest = JSON.parse(readFileSync(badTar.latestPath, "utf8")) as {
      assets: Array<{ fileName: string; url: string; sha256: string; size: number }>;
    };
    latest.assets[0].fileName = "not-a-tar.gz";
    latest.assets[0].url = `file://${invalidTarball}`;
    latest.assets[0].sha256 = sha256(invalidTarball);
    latest.assets[0].size = bytes(invalidTarball);
    writeFileSync(badTar.latestPath, JSON.stringify(latest, null, 2));
    const home = tempDir("ft-portable-home-");
    const prefix = join(home, "prefix");
    await seedOldInstall(prefix);
    vi.stubEnv("FIRST_TREE_PORTABLE_ROOT", join(prefix, "current"));
    vi.stubEnv("FIRST_TREE_PORTABLE_DOWNLOAD_BASE_URL", `file://${badTar.root}`);

    const { installPortableSpec } = await importProdUpdateModule();
    const tarFailure = await installPortableSpec("latest");
    expect(tarFailure).toMatchObject({
      ok: false,
      mode: "portable",
      retryable: true,
      reasonCode: "classified_transient",
    });
    if (tarFailure.ok) throw new Error("expected tar failure");
    expect(tarFailure.reason).toContain("tar exited with code");

    const badCurrent = await makePortableFixture({ version: "2.0.0" });
    const secondHome = tempDir("ft-portable-home-");
    const secondPrefix = join(secondHome, "prefix");
    mkdirSync(join(secondPrefix, "current"), { recursive: true });
    configurePortableIdentity(secondPrefix);
    vi.stubEnv("FIRST_TREE_PORTABLE_DOWNLOAD_BASE_URL", `file://${badCurrent.root}`);
    const currentFailure = await installPortableSpec("latest");
    expect(currentFailure.ok).toBe(false);
    if (currentFailure.ok) throw new Error("expected current symlink failure");
    expect(currentFailure.reason).toContain("exists and is not a symlink");
  });

  it("classifies non-Error portable download failures with fallback reason codes", async () => {
    const platform = currentPlatform();
    if (platform === null) return;
    childRegistryMocks.classify.mockReturnValue({ kind: "transient" });
    const fixture = await makePortableFixture();
    const latest = JSON.parse(readFileSync(fixture.latestPath, "utf8")) as {
      assets: Array<{ url: string }>;
    };
    latest.assets[0].url = "https://download.example/payload.tar.gz";
    writeFileSync(fixture.latestPath, JSON.stringify(latest, null, 2));
    cliFetchMock.mockRejectedValueOnce("payload download failed");
    const home = tempDir("ft-portable-home-");
    const prefix = join(home, "prefix");
    await seedOldInstall(prefix);
    vi.stubEnv("FIRST_TREE_PORTABLE_ROOT", join(prefix, "current"));
    vi.stubEnv("FIRST_TREE_PORTABLE_DOWNLOAD_BASE_URL", `file://${fixture.root}`);

    const { installPortableSpec } = await importProdUpdateModule();
    await expect(installPortableSpec("latest")).resolves.toMatchObject({
      ok: false,
      mode: "portable",
      reason: "payload download failed",
      retryable: true,
      reasonCode: "portable_update_failed",
    });
  });

  it("reports tar start failures from the portable extractor", async () => {
    const platform = currentPlatform();
    if (platform === null) return;
    vi.doMock("node:child_process", async (importOriginal) => {
      const actual = await importOriginal<typeof import("node:child_process")>();
      return {
        ...actual,
        spawnSync: vi.fn((command: string) =>
          command === "tar" ? { error: new Error("tar executable missing") } : actual.spawnSync(command),
        ),
      };
    });
    const fixture = await makePortableFixture();
    const home = tempDir("ft-portable-home-");
    const prefix = join(home, "prefix");
    await seedOldInstall(prefix);
    vi.stubEnv("FIRST_TREE_PORTABLE_ROOT", join(prefix, "current"));
    vi.stubEnv("FIRST_TREE_PORTABLE_DOWNLOAD_BASE_URL", `file://${fixture.root}`);

    const { installPortableSpec } = await importProdUpdateModule();
    const result = await installPortableSpec("latest");

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected tar start failure");
    expect(result.reason).toContain("tar failed to start: tar executable missing");
  });

  it("reports tar exits without stdout or stderr detail", async () => {
    const platform = currentPlatform();
    if (platform === null) return;
    vi.doMock("node:child_process", async (importOriginal) => {
      const actual = await importOriginal<typeof import("node:child_process")>();
      return {
        ...actual,
        spawnSync: vi.fn((command: string) =>
          command === "tar" ? { status: 2, stdout: "", stderr: "" } : actual.spawnSync(command),
        ),
      };
    });
    const fixture = await makePortableFixture();
    const home = tempDir("ft-portable-home-");
    const prefix = join(home, "prefix");
    await seedOldInstall(prefix);
    vi.stubEnv("FIRST_TREE_PORTABLE_ROOT", join(prefix, "current"));
    vi.stubEnv("FIRST_TREE_PORTABLE_DOWNLOAD_BASE_URL", `file://${fixture.root}`);

    const { installPortableSpec } = await importProdUpdateModule();
    await expect(installPortableSpec("latest")).resolves.toMatchObject({
      ok: false,
      mode: "portable",
      reason: "tar exited with code 2",
    });
  });

  it("reports missing extracted INSTALL metadata and current symlink replacement cleanup failures", async () => {
    const platform = currentPlatform();
    if (platform === null) return;
    childRegistryMocks.classify.mockReturnValue({ kind: "transient", reasonCode: "classified_transient" });

    const missingInstall = await makePortableFixture();
    const payload = tempDir("ft-portable-no-install-");
    await mkdir(join(payload, "node", "bin"), { recursive: true });
    await mkdir(join(payload, "app", "cli"), { recursive: true });
    await writeFile(join(payload, "node", "bin", "node"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    await writeFile(join(payload, "app", "cli", "index.mjs"), "// fixture\n");
    const tarball = join(missingInstall.root, "prod", "1.2.3", `missing-install-${platform}.tar.gz`);
    const tar = spawnSync("tar", ["-czf", tarball, "-C", payload, "."], { encoding: "utf8" });
    if (tar.status !== 0) throw new Error(tar.stderr);
    const latest = JSON.parse(readFileSync(missingInstall.latestPath, "utf8")) as {
      assets: Array<{ fileName: string; url: string; sha256: string; size: number }>;
    };
    latest.assets[0].fileName = `missing-install-${platform}.tar.gz`;
    latest.assets[0].url = `file://${tarball}`;
    latest.assets[0].sha256 = sha256(tarball);
    latest.assets[0].size = bytes(tarball);
    writeFileSync(missingInstall.latestPath, JSON.stringify(latest, null, 2));
    const home = tempDir("ft-portable-home-");
    const prefix = join(home, "prefix");
    await seedOldInstall(prefix);
    vi.stubEnv("FIRST_TREE_PORTABLE_ROOT", join(prefix, "current"));
    vi.stubEnv("FIRST_TREE_PORTABLE_DOWNLOAD_BASE_URL", `file://${missingInstall.root}`);

    const { installPortableSpec } = await importProdUpdateModule();
    const missing = await installPortableSpec("latest");
    expect(missing).toMatchObject({
      ok: false,
      mode: "portable",
      retryable: true,
      reasonCode: "classified_transient",
    });
    if (missing.ok) throw new Error("expected missing INSTALL failure");
    expect(missing.reason).toContain("extracted artifact missing or invalid INSTALL.json");

    vi.doMock("node:fs/promises", async (importOriginal) => {
      const actual = await importOriginal<typeof import("node:fs/promises")>();
      return {
        ...actual,
        rename: async (oldPath: string, newPath: string) => {
          if (oldPath.includes(".current.") && newPath.endsWith("/current")) {
            throw new Error("rename current denied");
          }
          return actual.rename(oldPath, newPath);
        },
      };
    });
    const renameFixture = await makePortableFixture({ version: "4.0.0" });
    const secondHome = tempDir("ft-portable-home-");
    const secondPrefix = join(secondHome, "prefix");
    await seedOldInstall(secondPrefix);
    vi.stubEnv("FIRST_TREE_PORTABLE_ROOT", join(secondPrefix, "current"));
    vi.stubEnv("FIRST_TREE_PORTABLE_DOWNLOAD_BASE_URL", `file://${renameFixture.root}`);
    const renameModule = await importProdUpdateModule();
    const renameFailure = await renameModule.installPortableSpec("latest");
    expect(renameFailure.ok).toBe(false);
    if (renameFailure.ok) throw new Error("expected current rename failure");
    expect(renameFailure.reason).toContain("rename current denied");
  });

  it("stringifies non-Error fs failures during portable metadata validation and current switching", async () => {
    const platform = currentPlatform();
    if (platform === null) return;
    vi.doMock("node:fs/promises", async (importOriginal) => {
      const actual = await importOriginal<typeof import("node:fs/promises")>();
      return {
        ...actual,
        readFile: async (
          path: Parameters<typeof actual.readFile>[0],
          options?: Parameters<typeof actual.readFile>[1],
        ) => {
          if (String(path).endsWith("/INSTALL.json")) throw "install metadata denied";
          return actual.readFile(path, options);
        },
      };
    });
    const fixture = await makePortableFixture();
    const home = tempDir("ft-portable-home-");
    const prefix = join(home, "prefix");
    await seedOldInstall(prefix);
    vi.stubEnv("FIRST_TREE_PORTABLE_ROOT", join(prefix, "current"));
    vi.stubEnv("FIRST_TREE_PORTABLE_DOWNLOAD_BASE_URL", `file://${fixture.root}`);

    const readFailureModule = await importProdUpdateModule();
    const readFailure = await readFailureModule.installPortableSpec("latest");
    expect(readFailure.ok).toBe(false);
    if (readFailure.ok) throw new Error("expected INSTALL read failure");
    expect(readFailure.reason).toContain("extracted artifact missing or invalid INSTALL.json: install metadata denied");

    vi.doMock("node:fs/promises", async (importOriginal) => {
      const actual = await importOriginal<typeof import("node:fs/promises")>();
      return {
        ...actual,
        lstat: async (path: Parameters<typeof actual.lstat>[0], options?: Parameters<typeof actual.lstat>[1]) => {
          if (String(path).endsWith("/current")) throw "lstat denied";
          return actual.lstat(path, options);
        },
      };
    });
    const lstatFixture = await makePortableFixture({ version: "2.0.2" });
    const secondHome = tempDir("ft-portable-home-");
    const secondPrefix = join(secondHome, "prefix");
    await seedOldInstall(secondPrefix);
    vi.stubEnv("FIRST_TREE_PORTABLE_ROOT", join(secondPrefix, "current"));
    vi.stubEnv("FIRST_TREE_PORTABLE_DOWNLOAD_BASE_URL", `file://${lstatFixture.root}`);

    const lstatFailureModule = await importProdUpdateModule();
    const lstatFailure = await lstatFailureModule.installPortableSpec("latest");
    expect(lstatFailure.ok).toBe(false);
    if (lstatFailure.ok) throw new Error("expected lstat failure");
    expect(lstatFailure.reason).toBe("lstat denied");
  });

  it("fetches portable latest metadata for manual upgrade checks", async () => {
    const platform = currentPlatform();
    if (platform === null) return;
    const fixture = await makePortableFixture({ version: "3.0.0" });
    vi.stubEnv("FIRST_TREE_PORTABLE_DOWNLOAD_BASE_URL", `file://${fixture.root}`);

    const { fetchPortableLatestVersion } = await importProdUpdateModule();
    await expect(fetchPortableLatestVersion()).resolves.toEqual({ ok: true, version: "3.0.0" });
  });
});
