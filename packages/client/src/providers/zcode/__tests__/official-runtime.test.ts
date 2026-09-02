import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  ensureOfficialZcodeRuntime,
  OFFICIAL_ZCODE_RUNTIME_CONTRACT,
  type OfficialZcodeRuntimeContract,
} from "../official-runtime.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function arMember(name: string, content: Buffer): Buffer {
  const header = Buffer.alloc(60);
  header.write(`${name}/`.padEnd(16, " "), 0, 16, "binary");
  header.write(sizeText(content.length), 48, "binary");
  header.write("\x60\x0a", 58, "binary");
  const padding = content.length % 2 === 0 ? Buffer.alloc(0) : Buffer.from("\n");
  return Buffer.concat([header, content, padding]);
}

function sizeText(size: number): string {
  const value = String(size);
  if (value.length > 10) throw new Error("test archive member is too large");
  return value.padStart(10, "0");
}

function testContract(runtime: Buffer, artifact: Buffer): OfficialZcodeRuntimeContract {
  const hash = (value: Buffer) => createHash("sha256").update(value).digest("hex");
  return {
    artifactUrl: "https://zcode.example.test/ZCode.deb",
    platform: "linux-x64",
    packageVersion: "test-package",
    runtimePath: "./opt/ZCode/resources/glm/zcode.cjs",
    artifact: { sha256: hash(artifact), bytes: artifact.length },
    runtime: { sha256: hash(runtime), bytes: runtime.length },
  };
}

function validArtifact(runtime: Buffer): Buffer {
  return Buffer.concat([
    Buffer.from("!<arch>\n"),
    arMember("debian-binary", Buffer.from("1")),
    arMember("data.tar.xz", runtime),
  ]);
}

async function makeRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "ft-zcode-official-"));
  roots.push(root);
  return root;
}

describe("ensureOfficialZcodeRuntime", () => {
  it("downloads, digest-checks, extracts, and atomically installs the managed runtime", async () => {
    const runtime = Buffer.from("official-runtime-bytes");
    const artifact = Buffer.concat([
      Buffer.from("!<arch>\n"),
      arMember("debian-binary", Buffer.from("1")),
      arMember("data.tar.xz", Buffer.from("compressed-payload")),
    ]);
    const cacheRoot = join(await makeRoot(), "runtime");
    const calls: { fetch: number; tar: number } = { fetch: 0, tar: 0 };

    const first = await ensureOfficialZcodeRuntime({
      cacheRoot,
      contract: testContract(runtime, artifact),
      platform: "linux",
      arch: "x64",
      fetchImpl: (async () => {
        calls.fetch += 1;
        return new Response(artifact, { status: 200 });
      }) as typeof fetch,
      runTar: async (args, cwd) => {
        calls.tar += 1;
        expect(args.at(-1)).toBe("./opt/ZCode/resources/glm/zcode.cjs");
        expect(args).toContain("--no-same-owner");
        expect(args).toContain("--no-same-permissions");
        const target = join(cwd, "opt/ZCode/resources/glm/zcode.cjs");
        await mkdir(dirname(target), { recursive: true });
        await writeFile(target, runtime);
      },
    });

    expect(first).toEqual({
      ok: true,
      command: process.execPath,
      args: [join(cacheRoot, "zcode.cjs")],
      runtimePath: join(cacheRoot, "zcode.cjs"),
    });
    expect(calls).toEqual({ fetch: 1, tar: 1 });
    const manifest = JSON.parse(await readFile(join(cacheRoot, "manifest.json"), "utf8"));
    expect(manifest.schema).toBe("first-tree.zcode-official-runtime.v1");

    const second = await ensureOfficialZcodeRuntime({
      cacheRoot,
      contract: testContract(runtime, artifact),
      platform: "linux",
      arch: "x64",
      fetchImpl: (async () => {
        calls.fetch += 1;
        throw new Error("must use the valid cache");
      }) as typeof fetch,
      runTar: async () => {
        calls.tar += 1;
      },
    });
    expect(second).toEqual(first);
    expect(calls).toEqual({ fetch: 1, tar: 1 });
  });

  it("admits the runtime on a truly clean host with no pre-existing cache directory tree", async () => {
    // A fresh `$HOME` has no `.../zcode/official/` path at all yet — unlike
    // every other case here, whose `cacheRoot` sits directly inside an
    // already-created `mkdtemp` root, this one nests it under directories
    // that do not exist yet, so lock acquisition must create its own parent
    // before the first `mkdir(lockPath, { recursive: false })` attempt.
    const runtime = Buffer.from("clean-host-runtime-bytes");
    const artifact = validArtifact(Buffer.from("compressed-payload"));
    const cacheRoot = join(await makeRoot(), "cache", "first-tree", "zcode", "official", "test-package", "runtime");

    const result = await ensureOfficialZcodeRuntime({
      cacheRoot,
      contract: testContract(runtime, artifact),
      platform: "linux",
      arch: "x64",
      fetchImpl: (async () => new Response(artifact, { status: 200 })) as typeof fetch,
      runTar: async (_args, cwd) => {
        const target = join(cwd, "opt/ZCode/resources/glm/zcode.cjs");
        await mkdir(dirname(target), { recursive: true });
        await writeFile(target, runtime);
      },
    });

    expect(result).toEqual({
      ok: true,
      command: process.execPath,
      args: [join(cacheRoot, "zcode.cjs")],
      runtimePath: join(cacheRoot, "zcode.cjs"),
    });
  });

  it("rejects a downloaded artifact whose digest does not match and removes the cache", async () => {
    const cacheRoot = join(await makeRoot(), "runtime");
    let tarCalls = 0;
    const malicious = Buffer.concat([Buffer.from("tampered"), Buffer.alloc(Buffer.from("malicious").length - 8)]);
    const result = await ensureOfficialZcodeRuntime({
      cacheRoot,
      contract: testContract(Buffer.from("expected"), Buffer.from("malicious")),
      platform: "linux",
      arch: "x64",
      fetchImpl: (async () => new Response(malicious, { status: 200 })) as typeof fetch,
      runTar: async () => {
        tarCalls += 1;
      },
    });
    expect(result).toMatchObject({
      ok: false,
      transient: false,
      error: expect.stringContaining("official ZCode artifact SHA-256 mismatch"),
    });
    expect(tarCalls).toBe(0);
    await expect(stat(cacheRoot)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("classifies acquisition timeouts and network failures as retryable", async () => {
    const cacheRoot = join(await makeRoot(), "runtime");
    const artifact = Buffer.from("stalled-artifact");
    let requestSignal: AbortSignal | undefined;
    const stalledBody = {
      [Symbol.asyncIterator]: () => {
        let sent = false;
        return {
          next: (): Promise<IteratorResult<Uint8Array>> => {
            if (!sent) {
              sent = true;
              return Promise.resolve({ value: new Uint8Array(artifact), done: false });
            }
            return new Promise((_, reject) => {
              requestSignal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
            });
          },
        };
      },
    };
    const result = await ensureOfficialZcodeRuntime({
      cacheRoot,
      contract: testContract(Buffer.from("runtime"), artifact),
      platform: "linux",
      arch: "x64",
      downloadTimeouts: { connectTimeoutMs: 1_000, bodyIdleTimeoutMs: 20, overallTimeoutMs: 5_000 },
      fetchImpl: (async (_url, init) => {
        requestSignal = init?.signal ?? undefined;
        return {
          ok: true,
          status: 200,
          headers: new Headers(),
          body: stalledBody,
          cancel: async () => {},
        } as unknown as Response;
      }) as typeof fetch,
    });
    expect(result).toMatchObject({
      ok: false,
      transient: true,
      error: expect.stringContaining("download stalled"),
    });
    await expect(stat(cacheRoot)).rejects.toMatchObject({ code: "ENOENT" });

    const networkFailure = await ensureOfficialZcodeRuntime({
      cacheRoot,
      contract: testContract(Buffer.from("runtime"), artifact),
      platform: "linux",
      arch: "x64",
      fetchImpl: (async () => {
        throw new Error("connection reset");
      }) as typeof fetch,
    });
    expect(networkFailure).toMatchObject({ ok: false, transient: true });
  });

  it("coalesces concurrent preparations and never deletes a valid winner", async () => {
    const runtime = Buffer.from("concurrent-runtime");
    const artifact = validArtifact(runtime);
    const cacheRoot = join(await makeRoot(), "runtime");
    const calls = { fetch: 0, tar: 0 };
    const options = {
      cacheRoot,
      contract: testContract(runtime, artifact),
      platform: "linux" as const,
      arch: "x64",
      fetchImpl: (async () => {
        calls.fetch += 1;
        await new Promise((resolveDelay) => setTimeout(resolveDelay, 20));
        return new Response(artifact, { status: 200 });
      }) as typeof fetch,
      runTar: async (_args: readonly string[], cwd: string) => {
        calls.tar += 1;
        const target = join(cwd, "opt/ZCode/resources/glm/zcode.cjs");
        await mkdir(dirname(target), { recursive: true });
        await writeFile(target, runtime);
      },
    };
    const [first, second] = await Promise.all([
      ensureOfficialZcodeRuntime(options),
      ensureOfficialZcodeRuntime(options),
    ]);
    expect(first).toEqual(second);
    expect(calls).toEqual({ fetch: 1, tar: 1 });
    expect(first).toMatchObject({ ok: true, runtimePath: join(cacheRoot, "zcode.cjs") });
  });

  it("waits instead of destroying another process's preparation", async () => {
    const cacheRoot = join(await makeRoot(), "runtime");
    await mkdir(cacheRoot, { recursive: true });
    await writeFile(join(cacheRoot, "unrelated.txt"), "owned by another invocation");
    const lockPath = `${cacheRoot}.lock`;
    await mkdir(lockPath);
    let fetchCalls = 0;
    const result = await ensureOfficialZcodeRuntime({
      cacheRoot,
      contract: testContract(Buffer.from("runtime"), Buffer.from("artifact")),
      platform: "linux",
      arch: "x64",
      lockTimeoutMs: 30,
      lockPollMs: 5,
      fetchImpl: (async () => {
        fetchCalls += 1;
        throw new Error("must not race the lock owner");
      }) as typeof fetch,
    });
    expect(result).toMatchObject({ ok: false, transient: true });
    expect(fetchCalls).toBe(0);
    expect(await readFile(join(cacheRoot, "unrelated.txt"), "utf8")).toBe("owned by another invocation");
    await rm(lockPath, { recursive: true, force: true });
  });

  it("restores a valid installation when a new preparation fails", async () => {
    const runtime = Buffer.from("valid-runtime");
    const artifact = validArtifact(runtime);
    const cacheRoot = join(await makeRoot(), "runtime");
    const validContract = testContract(runtime, artifact);
    const installed = await ensureOfficialZcodeRuntime({
      cacheRoot,
      contract: validContract,
      platform: "linux",
      arch: "x64",
      fetchImpl: (async () => new Response(artifact, { status: 200 })) as typeof fetch,
      runTar: async (_args, cwd) => {
        const target = join(cwd, "opt/ZCode/resources/glm/zcode.cjs");
        await mkdir(dirname(target), { recursive: true });
        await writeFile(target, runtime);
      },
    });
    expect(installed).toMatchObject({ ok: true });

    const failedContract = testContract(Buffer.from("different-runtime"), artifact);
    const failed = await ensureOfficialZcodeRuntime({
      cacheRoot,
      contract: failedContract,
      platform: "linux",
      arch: "x64",
      fetchImpl: (async () => new Response(artifact, { status: 200 })) as typeof fetch,
      runTar: async (_args, cwd) => {
        const target = join(cwd, "opt/ZCode/resources/glm/zcode.cjs");
        await mkdir(dirname(target), { recursive: true });
        await writeFile(target, runtime);
      },
    });
    expect(failed).toMatchObject({
      ok: false,
      transient: false,
      error: expect.stringContaining("extracted ZCode runtime size mismatch"),
    });
    const manifest = JSON.parse(await readFile(join(cacheRoot, "manifest.json"), "utf8"));
    expect(manifest.runtimeSha256).toBe(validContract.runtime.sha256);
  });

  it("rejects a malformed ar artifact before invoking tar", async () => {
    const cacheRoot = join(await makeRoot(), "runtime");
    const artifact = Buffer.from("not-an-archive");
    let tarCalls = 0;
    const result = await ensureOfficialZcodeRuntime({
      cacheRoot,
      contract: testContract(Buffer.from("runtime"), artifact),
      platform: "linux",
      arch: "x64",
      fetchImpl: (async () => new Response(artifact, { status: 200 })) as typeof fetch,
      runTar: async () => {
        tarCalls += 1;
      },
    });
    expect(result).toMatchObject({ ok: false, transient: false });
    expect(tarCalls).toBe(0);
  });

  it("fails closed when the pinned member does not extract a runtime", async () => {
    const runtime = Buffer.from("official-runtime-bytes");
    const artifact = Buffer.concat([
      Buffer.from("!<arch>\n"),
      arMember("data.tar.xz", Buffer.from("payload-without-runtime")),
    ]);
    const cacheRoot = join(await makeRoot(), "runtime");
    const result = await ensureOfficialZcodeRuntime({
      cacheRoot,
      contract: testContract(runtime, artifact),
      platform: "linux",
      arch: "x64",
      fetchImpl: (async () => new Response(artifact, { status: 200 })) as typeof fetch,
      runTar: async () => {},
    });
    expect(result).toMatchObject({
      ok: false,
      transient: false,
      error: expect.stringContaining("the pinned runtime member was not extracted"),
    });
    await expect(stat(cacheRoot)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("fails closed on any host platform outside the pinned official artifact", async () => {
    let fetchCalls = 0;
    const result = await ensureOfficialZcodeRuntime({
      cacheRoot: "/should-not-be-written",
      platform: "darwin",
      arch: "arm64",
      fetchImpl: (async () => {
        fetchCalls += 1;
        throw new Error("must not download");
      }) as typeof fetch,
    });
    expect(result).toMatchObject({
      ok: false,
      transient: false,
      error: expect.stringContaining("pinned to linux-x64"),
    });
    expect(fetchCalls).toBe(0);
  });

  it("keeps the production contract tied to the verified official provider artifact", () => {
    expect(OFFICIAL_ZCODE_RUNTIME_CONTRACT.artifactUrl).toBe(
      "https://cdn-zcode.z.ai/zcode/electron/releases/3.10.2/linux-x64/ZCode-3.10.2-linux-x64.deb",
    );
    expect(OFFICIAL_ZCODE_RUNTIME_CONTRACT.artifact.sha256).toBe(
      "b618cfa70c8f7c8a1a6e2950565cc441c298b801bb2389c292eb0d3add6bf0c0",
    );
    expect(OFFICIAL_ZCODE_RUNTIME_CONTRACT.runtime.sha256).toBe(
      "3597160465b67da248fa3fb919920ca30d4e093003a4d70cde2a2e33903cbabc",
    );
  });
});
