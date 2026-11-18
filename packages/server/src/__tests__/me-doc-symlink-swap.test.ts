import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, open, rename, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ForbiddenError, NotFoundError } from "../errors.js";
import { getMeDocPreview, type WorkspaceDocPreviewInput } from "../services/chat/workspace/document-preview.js";

/**
 * SEC-020: the preview used to `stat` the name, `realpath` it, confirm workspace
 * containment, and then open the *name* again for reading. Anything that can
 * write the workspace could swap the leaf for a symlink between the containment
 * check and the read.
 *
 * The swap is driven at the descriptor factory instead of inside `realpath`:
 * after the anchored-open change the interesting boundary is the open itself, and
 * a seam there is deterministic on every platform. If the implementation opened
 * the name without `O_NOFOLLOW`, the symlink would be followed and the outside
 * bytes returned — which is what these cases assert cannot happen.
 */
const baseInput = { chatId: "chat-1", agentId: "agent-1", agentName: "coder" };

/**
 * Descriptor-path seam.
 *
 * Production reads `/proc/self/fd/<fd>`, which only exists on Linux; these cases
 * wrap the real `open` so the stub answers with the path the module actually
 * opened, which is exactly what the kernel reports there.
 */
function descriptorSeam(): {
  resolve(path: string): string;
  seam: Pick<WorkspaceDocPreviewInput, "openDir" | "openFile" | "readDescriptorPath">;
} {
  const opened = new Map<number, string>();
  // Production lets the kernel resolve `/proc/self/fd/<dirfd>/<name>` inside the
  // directory object; macOS has no procfs, so the case resolves it through the
  // handle the module actually holds.
  const resolve = (path: string): string => {
    const match = /^\/proc\/self\/fd\/(\d+)\/([^/]+)$/.exec(path);
    if (!match) return path;
    const directory = opened.get(Number(match[1]));
    return directory === undefined ? path : join(directory, match[2] as string);
  };
  const track = async (path: string, flags: number) => {
    const real = resolve(path);
    const handle = await open(real, flags);
    opened.set(handle.fd, real);
    return handle;
  };
  return {
    resolve,
    seam: {
      openDir: track,
      openFile: track,
      readDescriptorPath: async (handle) => opened.get(handle.fd) ?? null,
    },
  };
}

async function makeFixture(): Promise<{ workspacesRoot: string; workspaceRoot: string; outsideFile: string }> {
  const workspacesRoot = await mkdtemp(join(tmpdir(), "first-tree-doc-swap-"));
  const workspaceRoot = join(workspacesRoot, baseInput.agentName, baseInput.chatId);
  await mkdir(workspaceRoot, { recursive: true });
  const outsideDir = await mkdtemp(join(tmpdir(), "first-tree-doc-outside-"));
  const outsideFile = join(outsideDir, "secret.md");
  await writeFile(outsideFile, "# OUTSIDE SECRET", "utf8");
  return { workspacesRoot, workspaceRoot, outsideFile };
}

describe("getMeDocPreview symlink swap", () => {
  it("refuses a file swapped for an outside symlink after the containment check", async () => {
    const { workspacesRoot, workspaceRoot, outsideFile } = await makeFixture();
    const target = join(workspaceRoot, "guide.md");
    await writeFile(target, "# Guide", "utf8");
    let swapped = false;

    const { resolve, seam } = descriptorSeam();
    const outcome = await getMeDocPreview({
      ...baseInput,
      ...seam,
      path: "guide.md",
      workspacesRoot,
      openFile: async (path, flags) => {
        // The name resolved a moment ago was a regular file; by the time the
        // descriptor is opened it is a symlink pointing outside the workspace.
        const real = resolve(path);
        await rename(real, `${real}-moved`);
        await symlink(outsideFile, real);
        swapped = true;
        return open(real, flags);
      },
    }).catch((thrown: unknown) => thrown);

    // The swap really happened; without it this test would pass for the wrong reason.
    expect(swapped).toBe(true);
    expect(outcome).toBeInstanceOf(ForbiddenError);
    expect((outcome as Error).message).toContain("must not be a symlink");
    expect(JSON.stringify(outcome)).not.toContain("OUTSIDE");
  });

  it("still refuses a symlink that already points outside the workspace", async () => {
    const { workspacesRoot, workspaceRoot, outsideFile } = await makeFixture();
    await symlink(outsideFile, join(workspaceRoot, "linked.md"));

    await expect(
      getMeDocPreview({ ...baseInput, ...descriptorSeam().seam, path: "linked.md", workspacesRoot }),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("still reads a regular file, and a symlink that stays inside", async () => {
    const { workspacesRoot, workspaceRoot } = await makeFixture();
    await writeFile(join(workspaceRoot, "guide.md"), "# Guide", "utf8");
    await writeFile(join(workspaceRoot, "real.md"), "# Real", "utf8");
    await symlink(join(workspaceRoot, "real.md"), join(workspaceRoot, "inside-link.md"));

    await expect(
      getMeDocPreview({ ...baseInput, ...descriptorSeam().seam, path: "guide.md", workspacesRoot }),
    ).resolves.toMatchObject({ content: "# Guide" });
    await expect(
      getMeDocPreview({ ...baseInput, ...descriptorSeam().seam, path: "inside-link.md", workspacesRoot }),
    ).resolves.toMatchObject({ content: "# Real" });
  });
});

describe("getMeDocPreview non-file entries", () => {
  it("treats a FIFO as not found instead of blocking on it", async () => {
    if (process.platform === "win32") return;
    const { workspacesRoot, workspaceRoot } = await makeFixture();
    const fifo = join(workspaceRoot, "pipe.md");
    const mkfifo = spawnSync("mkfifo", [fifo]);
    if (mkfifo.status !== 0) return; // no mkfifo on this host

    // Opening a FIFO for reading without O_NONBLOCK waits for a writer; the
    // request would hang rather than 404.
    await expect(
      getMeDocPreview({ ...baseInput, ...descriptorSeam().seam, path: "pipe.md", workspacesRoot }),
    ).rejects.toBeInstanceOf(NotFoundError);
  });
});
