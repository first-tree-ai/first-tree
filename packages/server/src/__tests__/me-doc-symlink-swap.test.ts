import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, open, realpath, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { ForbiddenError, NotFoundError } from "../errors.js";
import { getMeDocPreview, type WorkspaceDocPreviewInput } from "../services/chat/workspace/document-preview.js";

/**
 * SEC-020: the preview used to `stat` the name, `realpath` it, confirm the
 * workspace containment, and then open the *name* again for reading. Anything
 * that can write the workspace could swap the file for a symlink between the
 * containment check and the read.
 *
 * A real race is not reproducible on demand, so this file makes the swap happen
 * inside `realpath` — the exact syscall that follows the check. Whatever the
 * implementation does afterwards either reads through the name again (and leaks
 * the outside file) or keeps reading the descriptor it already validated.
 */
const swap = vi.hoisted(() => ({ armed: false, path: "", target: "", fired: false }));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    realpath: (async (path: Parameters<typeof actual.realpath>[0], ...rest: unknown[]) => {
      if (swap.armed && String(path) === swap.path) {
        // Answer for the pre-swap state, then let the attacker win the race.
        const before = await actual.realpath(path);
        await actual.unlink(String(path));
        await actual.symlink(swap.target, String(path));
        swap.armed = false;
        swap.fired = true;
        return before;
      }
      return (actual.realpath as (p: typeof path, ...r: unknown[]) => Promise<string>)(path, ...rest);
    }) as typeof actual.realpath,
  };
});

/**
 * Descriptor-path seam.
 *
 * Production reads `/proc/self/fd/<fd>`, which only exists on Linux; these cases
 * wrap the real `open` so the stub answers with the path the module actually
 * opened, which is exactly what the kernel reports there.
 */
function descriptorSeam(): Pick<WorkspaceDocPreviewInput, "openDir" | "openFile" | "readDescriptorPath"> {
  const opened = new Map<number, string>();
  const track = async (path: string, flags: number) => {
    const handle = await open(path, flags);
    opened.set(handle.fd, path);
    return handle;
  };
  return {
    openDir: track,
    openFile: track,
    readDescriptorPath: async (handle) => opened.get(handle.fd) ?? null,
  };
}

const baseInput = { chatId: "chat-1", agentId: "agent-1", agentName: "coder" };

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

    swap.armed = true;
    swap.path = await realpath(target);
    swap.target = outsideFile;
    swap.fired = false;

    await expect(
      getMeDocPreview({ ...baseInput, ...descriptorSeam(), path: "guide.md", workspacesRoot }),
    ).rejects.toBeInstanceOf(ForbiddenError);
    // The swap really happened; without it this test would pass for the wrong reason.
    expect(swap.fired).toBe(true);
  });

  it("still refuses a symlink that already points outside the workspace", async () => {
    const { workspacesRoot, workspaceRoot, outsideFile } = await makeFixture();
    await symlink(outsideFile, join(workspaceRoot, "linked.md"));

    await expect(
      getMeDocPreview({ ...baseInput, ...descriptorSeam(), path: "linked.md", workspacesRoot }),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("still reads a regular file, and a symlink that stays inside", async () => {
    const { workspacesRoot, workspaceRoot } = await makeFixture();
    await writeFile(join(workspaceRoot, "guide.md"), "# Guide", "utf8");
    await writeFile(join(workspaceRoot, "real.md"), "# Real", "utf8");
    await symlink(join(workspaceRoot, "real.md"), join(workspaceRoot, "inside-link.md"));

    await expect(
      getMeDocPreview({ ...baseInput, ...descriptorSeam(), path: "guide.md", workspacesRoot }),
    ).resolves.toMatchObject({
      content: "# Guide",
    });
    await expect(
      getMeDocPreview({ ...baseInput, ...descriptorSeam(), path: "inside-link.md", workspacesRoot }),
    ).resolves.toMatchObject({
      content: "# Real",
    });
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
      getMeDocPreview({ ...baseInput, ...descriptorSeam(), path: "pipe.md", workspacesRoot }),
    ).rejects.toBeInstanceOf(NotFoundError);
  });
});
