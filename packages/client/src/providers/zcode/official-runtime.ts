import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, mkdtemp, open, readFile, rename, rm, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { pipeline } from "node:stream/promises";
import { promisify } from "node:util";
import {
  ZCODE_OFFICIAL_ARTIFACT_BYTES,
  ZCODE_OFFICIAL_ARTIFACT_SHA256,
  ZCODE_OFFICIAL_ARTIFACT_URL,
  ZCODE_OFFICIAL_PACKAGE_VERSION,
  ZCODE_OFFICIAL_PLATFORM,
  ZCODE_OFFICIAL_RUNTIME_BYTES,
  ZCODE_OFFICIAL_RUNTIME_SHA256,
} from "@first-tree/shared";

const execFileAsync = promisify(execFile);
const DEB_MAGIC = "!<arch>\n";
const AR_HEADER_BYTES = 60;
const DATA_MEMBER = "data.tar.xz";
const RUNTIME_MEMBER = "./opt/ZCode/resources/glm/zcode.cjs";
const RUNTIME_MANIFEST_SCHEMA = "first-tree.zcode-official-runtime.v1";
const DOWNLOAD_CONNECT_TIMEOUT_MS = 20_000;
const DOWNLOAD_BODY_IDLE_TIMEOUT_MS = 30_000;
const DOWNLOAD_OVERALL_TIMEOUT_MS = 300_000;
const RUNTIME_LOCK_TIMEOUT_MS = 300_000;
const RUNTIME_LOCK_POLL_MS = 100;
const RUNTIME_LOCK_STALE_MS = 600_000;

export type DigestContract = {
  sha256: string;
  bytes: number;
};

export type OfficialZcodeRuntimeContract = {
  artifactUrl: string;
  artifact: DigestContract;
  platform: string;
  packageVersion: string;
  runtimePath: string;
  runtime: DigestContract;
};

export const OFFICIAL_ZCODE_RUNTIME_CONTRACT: OfficialZcodeRuntimeContract = {
  artifactUrl: ZCODE_OFFICIAL_ARTIFACT_URL,
  platform: ZCODE_OFFICIAL_PLATFORM,
  packageVersion: ZCODE_OFFICIAL_PACKAGE_VERSION,
  runtimePath: RUNTIME_MEMBER,
  artifact: { sha256: ZCODE_OFFICIAL_ARTIFACT_SHA256, bytes: ZCODE_OFFICIAL_ARTIFACT_BYTES },
  runtime: { sha256: ZCODE_OFFICIAL_RUNTIME_SHA256, bytes: ZCODE_OFFICIAL_RUNTIME_BYTES },
};

export type OfficialZcodeRuntimeResolution =
  | { ok: true; command: string; args: readonly string[]; runtimePath: string }
  | { ok: false; error: string; transient: boolean };

type ExtractOfficialZcodeRuntimeDeps = {
  cacheRoot?: string;
  contract?: OfficialZcodeRuntimeContract;
  platform?: NodeJS.Platform;
  arch?: string;
  fetchImpl?: typeof fetch;
  runTar?: (args: readonly string[], cwd: string) => Promise<void>;
  downloadTimeouts?: {
    connectTimeoutMs?: number;
    bodyIdleTimeoutMs?: number;
    overallTimeoutMs?: number;
  };
  lockTimeoutMs?: number;
  lockPollMs?: number;
};

type RuntimeManifest = {
  schema: typeof RUNTIME_MANIFEST_SCHEMA;
  platform: string;
  packageVersion: string;
  runtimePath: string;
  artifactUrl: string;
  artifactSha256: string;
  artifactBytes: number;
  runtimeSha256: string;
  runtimeBytes: number;
};

type OfficialArtifactTimeouts = {
  connectTimeoutMs: number;
  bodyIdleTimeoutMs: number;
  overallTimeoutMs: number;
};

class OfficialArtifactError extends Error {
  readonly transient: boolean;

  constructor(message: string, transient: boolean) {
    super(message);
    this.name = "OfficialArtifactError";
    this.transient = transient;
  }
}

class RuntimeLockBusyError extends Error {
  constructor() {
    super("another First Tree process is already preparing the managed official ZCode runtime");
    this.name = "RuntimeLockBusyError";
  }
}

type RuntimeLockOwner = {
  pid: number;
  acquiredAt: number;
};

const runtimePreparations = new Map<string, Promise<OfficialZcodeRuntimeResolution>>();

function commandName(filePath: string): string {
  return basename(filePath);
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function sha256File(filePath: string): Promise<{ hash: string; bytes: number }> {
  const file = await stat(filePath);
  const hash = createHash("sha256");
  const handle = await open(filePath, "r");
  try {
    for await (const chunk of handle.createReadStream()) hash.update(chunk as Buffer);
  } finally {
    await handle.close();
  }
  return { hash: hash.digest("hex"), bytes: file.size };
}

function verifyDigest(label: string, observed: { hash: string; bytes: number }, expected: DigestContract): void {
  if (observed.bytes !== expected.bytes) {
    throw new Error(`${label} size mismatch: observed ${observed.bytes}, expected ${expected.bytes}`);
  }
  if (observed.hash !== expected.sha256) {
    throw new Error(`${label} SHA-256 mismatch: observed ${observed.hash}, expected ${expected.sha256}`);
  }
}

function artifactContractError(message: string): OfficialArtifactError {
  return new OfficialArtifactError(message, false);
}

async function downloadExactArtifact(
  artifactPath: string,
  contract: OfficialZcodeRuntimeContract,
  fetchImpl: typeof fetch,
  timeouts: OfficialArtifactTimeouts = {
    connectTimeoutMs: DOWNLOAD_CONNECT_TIMEOUT_MS,
    bodyIdleTimeoutMs: DOWNLOAD_BODY_IDLE_TIMEOUT_MS,
    overallTimeoutMs: DOWNLOAD_OVERALL_TIMEOUT_MS,
  },
): Promise<void> {
  await mkdir(dirname(artifactPath), { recursive: true });
  const controller = new AbortController();
  let timeoutMessage: string | null = null;
  const abortDownload = (message: string): void => {
    timeoutMessage ??= message;
    if (!controller.signal.aborted) controller.abort();
  };
  const connectTimer = setTimeout(
    () => abortDownload(`official ZCode download did not respond within ${timeouts.connectTimeoutMs}ms`),
    timeouts.connectTimeoutMs,
  );
  let idleTimer = setTimeout(
    () => abortDownload(`official ZCode download stalled for over ${timeouts.bodyIdleTimeoutMs}ms`),
    timeouts.bodyIdleTimeoutMs,
  );
  const overallTimer = setTimeout(
    () => abortDownload(`official ZCode download exceeded ${timeouts.overallTimeoutMs}ms`),
    timeouts.overallTimeoutMs,
  );
  const clearTimers = (): void => {
    clearTimeout(connectTimer);
    clearTimeout(idleTimer);
    clearTimeout(overallTimer);
  };
  const resetIdleTimer = (): void => {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(
      () => abortDownload(`official ZCode download stalled for over ${timeouts.bodyIdleTimeoutMs}ms`),
      timeouts.bodyIdleTimeoutMs,
    );
    idleTimer.unref?.();
  };
  connectTimer.unref?.();
  idleTimer.unref?.();
  overallTimer.unref?.();
  let response: Response | undefined;
  try {
    response = await fetchImpl(contract.artifactUrl, { redirect: "error", signal: controller.signal });
    clearTimeout(connectTimer);
    if (!response.ok) {
      const retryable = response.status === 408 || response.status === 429 || response.status >= 500;
      throw new OfficialArtifactError(`official ZCode download returned HTTP ${response.status}`, retryable);
    }
    const declaredLength = Number(response.headers.get("content-length"));
    if (response.headers.has("content-length") && (!Number.isSafeInteger(declaredLength) || declaredLength < 0)) {
      throw artifactContractError("official ZCode download has a malformed Content-Length");
    }
    if (response.headers.has("content-length") && declaredLength !== contract.artifact.bytes) {
      throw artifactContractError(`official ZCode download size mismatch: HTTP declared ${declaredLength} bytes`);
    }
    if (!response.body) throw new OfficialArtifactError("official ZCode download has no body", true);

    const output = await open(artifactPath, "wx", 0o600);
    let bytes = 0;
    try {
      const body = response.body as unknown as AsyncIterable<Uint8Array>;
      for await (const chunk of body) {
        resetIdleTimer();
        bytes += chunk.byteLength;
        if (bytes > contract.artifact.bytes) {
          throw artifactContractError(`official ZCode download exceeds ${contract.artifact.bytes} bytes`);
        }
        await output.write(chunk);
      }
      if (bytes !== contract.artifact.bytes) {
        throw artifactContractError(`official ZCode download size mismatch: received ${bytes} bytes`);
      }
      await output.sync();
    } finally {
      await output.close();
    }
    if (timeoutMessage) throw new OfficialArtifactError(timeoutMessage, true);
  } catch (error) {
    try {
      await rm(artifactPath, { force: true });
    } catch {
      // Keep the acquisition failure; a partial file is in invocation-owned
      // staging and cannot affect the shared cache installation.
    }
    if (error instanceof OfficialArtifactError) throw error;
    if (timeoutMessage) throw new OfficialArtifactError(timeoutMessage, true);
    if (controller.signal.aborted) {
      throw new OfficialArtifactError("official ZCode download was cancelled", true);
    }
    throw new OfficialArtifactError(`official ZCode download failed: ${describeError(error)}`, true);
  } finally {
    clearTimers();
    try {
      await response?.body?.cancel();
    } catch {
      // The body may already have errored or been cancelled by the deadline.
    }
  }
}

type ArDataMember = {
  start: number;
  end: number;
};

async function findDebDataMember(
  artifactPath: string,
  artifactBytes: number,
  memberName: string,
): Promise<ArDataMember> {
  const handle = await open(artifactPath, "r");
  try {
    const magic = Buffer.alloc(DEB_MAGIC.length);
    await handle.read(magic, 0, magic.length, 0);
    if (!magic.equals(Buffer.from(DEB_MAGIC, "utf8"))) {
      throw new Error("official ZCode artifact is not a Debian ar archive");
    }

    let offset = magic.length;
    while (offset < artifactBytes) {
      const header = Buffer.alloc(AR_HEADER_BYTES);
      const read = await handle.read(header, 0, header.length, offset);
      if (read.bytesRead !== header.length) throw new Error("official ZCode ar archive ends inside a header");
      if (!header.subarray(58, 60).equals(Buffer.from("\x60\x0a", "binary"))) {
        throw new Error("official ZCode ar archive has a malformed member header");
      }
      const rawName = header.subarray(0, 16).toString("binary").trimEnd();
      const name = rawName.endsWith("/") && rawName !== "//" ? rawName.slice(0, -1) : rawName;
      const sizeText = header.subarray(48, 58).toString("binary").trim();
      if (!/^[0-9]+$/.test(sizeText)) throw new Error("official ZCode ar archive has a malformed member size");
      const size = Number(sizeText);
      const start = offset + AR_HEADER_BYTES;
      const end = start + size;
      if (size <= 0 || end > artifactBytes) {
        throw new Error("official ZCode ar archive member exceeds the verified artifact");
      }
      if (name === memberName) return { start, end };
      offset = end + (size % 2);
      if (offset > artifactBytes) throw new Error("official ZCode ar archive ends inside member padding");
    }
    throw new Error(`official ZCode artifact does not contain ${memberName}`);
  } finally {
    await handle.close();
  }
}

async function defaultRunTar(args: readonly string[], cwd: string): Promise<void> {
  try {
    await execFileAsync("tar", [...args], { cwd, timeout: 120_000, maxBuffer: 1024 * 1024, shell: false });
  } catch (error) {
    throw new Error(`could not extract the official ZCode artifact with tar: ${describeError(error)}`);
  }
}

async function extractRuntime(
  artifactPath: string,
  artifactBytes: number,
  stagingDir: string,
  contract: OfficialZcodeRuntimeContract,
  runTar: (args: readonly string[], cwd: string) => Promise<void>,
): Promise<void> {
  const member = await findDebDataMember(artifactPath, artifactBytes, DATA_MEMBER);
  const compressedPath = join(stagingDir, `${DATA_MEMBER}.incoming`);
  const input = await open(artifactPath, "r");
  try {
    await pipeline(
      input.createReadStream({ start: member.start, end: member.end - 1 }),
      createWriteStream(compressedPath, {
        mode: 0o600,
        flags: "wx",
      }),
    );
  } finally {
    await input.close();
  }

  await runTar(
    ["-xJf", compressedPath, "--no-same-owner", "--no-same-permissions", "-C", stagingDir, contract.runtimePath],
    stagingDir,
  );
  const extractedPath = join(stagingDir, contract.runtimePath);
  await stat(extractedPath).catch(() => {
    throw new Error(`the pinned runtime member was not extracted: ${contract.runtimePath}`);
  });
  await rename(extractedPath, join(stagingDir, commandName(contract.runtimePath)));
}

function parseManifest(raw: string, contract: OfficialZcodeRuntimeContract): RuntimeManifest | null {
  try {
    const value = JSON.parse(raw) as Partial<RuntimeManifest>;
    if (
      value.schema !== RUNTIME_MANIFEST_SCHEMA ||
      value.platform !== contract.platform ||
      value.packageVersion !== contract.packageVersion ||
      value.runtimePath !== contract.runtimePath ||
      value.artifactUrl !== contract.artifactUrl ||
      value.artifactSha256 !== contract.artifact.sha256 ||
      value.artifactBytes !== contract.artifact.bytes ||
      value.runtimeSha256 !== contract.runtime.sha256 ||
      value.runtimeBytes !== contract.runtime.bytes
    ) {
      return null;
    }
    return value as RuntimeManifest;
  } catch {
    return null;
  }
}

export async function officialZcodeRuntimeCacheRoot(
  env: Record<string, string | undefined> = process.env,
): Promise<string> {
  const configured = env.FIRST_TREE_ZCODE_RUNTIME_CACHE?.trim();
  if (configured) return resolve(configured);
  const home = env.HOME?.trim() || env.USERPROFILE?.trim() || homedir();
  const cacheHome = env.XDG_CACHE_HOME?.trim() || join(home, ".cache");
  return join(cacheHome, "first-tree", "zcode", "official", contractOrThrow().packageVersion);
}

function contractOrThrow(): OfficialZcodeRuntimeContract {
  return OFFICIAL_ZCODE_RUNTIME_CONTRACT;
}

async function readValidManagedRuntime(
  runtimeDir: string,
  contract: OfficialZcodeRuntimeContract,
): Promise<string | null> {
  try {
    const manifestRaw = await readFile(join(runtimeDir, "manifest.json"), "utf8");
    if (!parseManifest(manifestRaw, contract)) return null;
    const runtimePath = join(runtimeDir, "zcode.cjs");
    verifyDigest("managed ZCode runtime", await sha256File(runtimePath), contract.runtime);
    return runtimePath;
  } catch {
    return null;
  }
}

async function removeRuntimeLock(lockPath: string): Promise<void> {
  await rm(lockPath, { recursive: true, force: true });
}

async function clearStaleRuntimeLock(lockPath: string, backupPath: string): Promise<boolean> {
  try {
    const owner = JSON.parse(await readFile(join(lockPath, "owner.json"), "utf8")) as RuntimeLockOwner;
    if (Date.now() - owner.acquiredAt < RUNTIME_LOCK_STALE_MS) return false;
    await rename(lockPath, backupPath);
    await removeRuntimeLock(backupPath);
    return true;
  } catch {
    return false;
  }
}

async function withRuntimeLock<T>(
  cacheRoot: string,
  timeoutMs: number,
  pollMs: number,
  task: () => Promise<T>,
): Promise<T> {
  const lockPath = `${cacheRoot}.lock`;
  const deadline = Date.now() + timeoutMs;
  // A truly clean host has no `.../zcode/official/` directory at all yet, and
  // the non-recursive `mkdir(lockPath)` below requires that parent to already
  // exist. Ensure it up front so first-ever admission on a clean host doesn't
  // fail closed with a bare ENOENT before it ever reaches the retry loop.
  await mkdir(dirname(lockPath), { recursive: true });
  for (;;) {
    try {
      await mkdir(lockPath, { recursive: false });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const backupPath = `${lockPath}.stale-${Date.now()}-${Math.random().toString(36).slice(2)}`;
      await clearStaleRuntimeLock(lockPath, backupPath);
      if (Date.now() >= deadline) throw new RuntimeLockBusyError();
      await new Promise((resolvePoll) => setTimeout(resolvePoll, pollMs).unref?.());
      continue;
    }

    const owner: RuntimeLockOwner = { pid: process.pid, acquiredAt: Date.now() };
    try {
      await writeFileUtf8(join(lockPath, "owner.json"), JSON.stringify(owner));
      return await task();
    } finally {
      await removeRuntimeLock(lockPath);
    }
  }
}

export async function ensureOfficialZcodeRuntime(
  deps: ExtractOfficialZcodeRuntimeDeps = {},
): Promise<OfficialZcodeRuntimeResolution> {
  const platform = deps.platform ?? process.platform;
  const arch = deps.arch ?? process.arch;
  const contract = contractOrThrow();
  const effectiveContract = deps.contract ?? contract;
  if (platform !== "linux" || arch !== "x64") {
    return {
      ok: false,
      transient: false,
      error: `First Tree's managed ZCode runtime is pinned to ${contract.platform}; this host is ${platform}-${arch}`,
    };
  }

  const cacheRoot = deps.cacheRoot ?? (await officialZcodeRuntimeCacheRoot());
  const singleFlightKey = `${cacheRoot}\0${JSON.stringify(effectiveContract)}`;
  const existingPreparation = runtimePreparations.get(singleFlightKey);
  if (existingPreparation) return existingPreparation;

  const preparation = (async (): Promise<OfficialZcodeRuntimeResolution> => {
    const existing = await readValidManagedRuntime(cacheRoot, effectiveContract);
    if (existing) return { ok: true, command: process.execPath, args: [existing], runtimePath: existing };

    try {
      return await withRuntimeLock(
        cacheRoot,
        deps.lockTimeoutMs ?? RUNTIME_LOCK_TIMEOUT_MS,
        Math.max(1, deps.lockPollMs ?? RUNTIME_LOCK_POLL_MS),
        async () => {
          const winner = await readValidManagedRuntime(cacheRoot, effectiveContract);
          if (winner) return { ok: true, command: process.execPath, args: [winner], runtimePath: winner };

          await mkdir(dirname(cacheRoot), { recursive: true });
          const work = await mkdtemp(join(dirname(cacheRoot), `.${basename(cacheRoot)}.extract-`));
          const artifactPath = join(work, "ZCode.deb");
          const stagingDir = join(work, "runtime");
          let ownedInvalidInstall: string | null = null;
          try {
            await mkdir(stagingDir, { recursive: true });
            await downloadExactArtifact(artifactPath, effectiveContract, deps.fetchImpl ?? fetch, {
              connectTimeoutMs: deps.downloadTimeouts?.connectTimeoutMs ?? DOWNLOAD_CONNECT_TIMEOUT_MS,
              bodyIdleTimeoutMs: deps.downloadTimeouts?.bodyIdleTimeoutMs ?? DOWNLOAD_BODY_IDLE_TIMEOUT_MS,
              overallTimeoutMs: deps.downloadTimeouts?.overallTimeoutMs ?? DOWNLOAD_OVERALL_TIMEOUT_MS,
            });
            const observedArtifact = await sha256File(artifactPath);
            verifyDigest("official ZCode artifact", observedArtifact, effectiveContract.artifact);
            await extractRuntime(
              artifactPath,
              observedArtifact.bytes,
              stagingDir,
              effectiveContract,
              deps.runTar ?? defaultRunTar,
            );
            const observedRuntime = await sha256File(join(stagingDir, "zcode.cjs"));
            verifyDigest("extracted ZCode runtime", observedRuntime, effectiveContract.runtime);
            const manifest: RuntimeManifest = {
              schema: RUNTIME_MANIFEST_SCHEMA,
              platform: effectiveContract.platform,
              packageVersion: effectiveContract.packageVersion,
              runtimePath: effectiveContract.runtimePath,
              artifactUrl: effectiveContract.artifactUrl,
              artifactSha256: effectiveContract.artifact.sha256,
              artifactBytes: effectiveContract.artifact.bytes,
              runtimeSha256: effectiveContract.runtime.sha256,
              runtimeBytes: effectiveContract.runtime.bytes,
            };
            await writeFileUtf8(join(stagingDir, "manifest.json"), JSON.stringify(manifest, null, 2));
            await rm(artifactPath, { force: true });

            let existingInvalid = false;
            try {
              await stat(cacheRoot);
              existingInvalid = true;
            } catch (error) {
              if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
            }
            if (existingInvalid) {
              ownedInvalidInstall = `${cacheRoot}.invalid-${Date.now()}-${Math.random().toString(36).slice(2)}`;
              await rename(cacheRoot, ownedInvalidInstall);
            }
            try {
              await rename(stagingDir, cacheRoot);
            } catch (error) {
              const code = (error as NodeJS.ErrnoException).code;
              if (code !== "ENOTEMPTY" && code !== "EEXIST") throw error;
              const concurrentWinner = await readValidManagedRuntime(cacheRoot, effectiveContract);
              if (!concurrentWinner) throw error;
              ownedInvalidInstall = null;
              return {
                ok: true,
                command: process.execPath,
                args: [concurrentWinner],
                runtimePath: concurrentWinner,
              };
            }

            const installed = await readValidManagedRuntime(cacheRoot, effectiveContract);
            if (!installed) throw new Error("the managed official ZCode runtime did not settle atomically");
            const retired = ownedInvalidInstall;
            ownedInvalidInstall = null;
            if (retired) await rm(retired, { recursive: true, force: true });
            return { ok: true, command: process.execPath, args: [installed], runtimePath: installed };
          } finally {
            if (ownedInvalidInstall) await rename(ownedInvalidInstall, cacheRoot);
            await rm(work, { recursive: true, force: true });
          }
        },
      );
    } catch (error) {
      const transient =
        error instanceof OfficialArtifactError ? error.transient : error instanceof RuntimeLockBusyError;
      return {
        ok: false,
        transient,
        error: `could not prepare the managed official ZCode runtime: ${describeError(error)}`,
      };
    }
  })();

  runtimePreparations.set(singleFlightKey, preparation);
  try {
    return await preparation;
  } finally {
    if (runtimePreparations.get(singleFlightKey) === preparation) runtimePreparations.delete(singleFlightKey);
  }
}

async function writeFileUtf8(path: string, content: string): Promise<void> {
  const handle = await open(path, "wx", 0o600);
  try {
    await handle.writeFile(content, "utf8");
  } finally {
    await handle.close();
  }
}

export function officialRuntimeCommand(resolution: Extract<OfficialZcodeRuntimeResolution, { ok: true }>): {
  command: string;
  args: readonly string[];
} {
  return { command: resolution.command, args: resolution.args };
}

export function officialRuntimeLabel(runtimePath: string): string {
  return `${commandName(process.execPath)} ${runtimePath}`;
}

export function officialRuntimeLoginCommand(resolution: Extract<OfficialZcodeRuntimeResolution, { ok: true }>): string {
  const quote = (value: string): string =>
    value.match(/^[A-Za-z0-9_./@+=:-]+$/) ? value : `'${value.replaceAll("'", `'\\''`)}'`;
  return `${quote(resolution.command)} ${quote(resolution.runtimePath)} login`;
}
