import { constants as fsConstants } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import { open, readlink, realpath } from "node:fs/promises";
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { defaultDataDir } from "@first-tree/shared/config";
import { AppError, ForbiddenError, NotFoundError } from "../../../errors.js";
import { MAX_DOC_BYTES, readBounded } from "./bounded-read.js";

/**
 * `O_NONBLOCK` keeps a workspace entry that is not a file (a FIFO an agent
 * created, say) from blocking the request until a writer shows up; the
 * descriptor type check below turns it into a plain 404.
 */
const READ_FLAGS = fsConstants.O_RDONLY | (fsConstants.O_NONBLOCK ?? 0) | (fsConstants.O_NOFOLLOW ?? 0);

/**
 * The containment anchor is opened as a directory and never through a symlink,
 * so once it is open no path replacement can redirect what it names.
 */
const DIRECTORY_FLAGS = fsConstants.O_RDONLY | (fsConstants.O_DIRECTORY ?? 0) | (fsConstants.O_NOFOLLOW ?? 0);

/** `readlink` reports this suffix once the descriptor's inode has been unlinked. */
const DELETED_SUFFIX = " (deleted)";

/** Root under which the kernel exposes descriptors as paths (`openat`-equivalent). */
const DESCRIPTOR_ROOT = "/proc/self/fd";

export type WorkspaceDocPreviewInput = {
  chatId: string;
  agentId: string;
  agentName: string;
  path: string;
  basePath?: string;
  workspacesRoot?: string;
  /**
   * Descriptor factory. Production uses `open`; tests pass a fake descriptor to
   * model a file that reports a small size and then yields more bytes, which no
   * real filesystem can be made to do deterministically.
   */
  openFile?: (path: string, flags: number) => Promise<FileHandle>;
  /** Directory factory for the containment anchor. */
  openDir?: (path: string, flags: number) => Promise<FileHandle>;
  /**
   * Descriptor → path resolver, and the only place containment is decided.
   *
   * Production reads `/proc/self/fd/<fd>`, which is the kernel's own answer for
   * the object the descriptor holds. Tests inject it to model a platform that
   * cannot answer, or an answer that disagrees with the anchored directory.
   */
  readDescriptorPath?: (handle: FileHandle) => Promise<string | null>;
};

export type MeDocPreview = {
  ref: {
    type: "workspace";
    chatId: string;
    agentId: string;
    basePath?: string;
    path: string;
  };
  path: string;
  content: string;
};

/**
 * Read one markdown document out of an agent workspace.
 *
 * The workspace is agent-writable, so any name in it can be replaced between two
 * syscalls. A path-based proof cannot survive that: resolving a parent and later
 * `lstat`-ing a name are two observations of a tree the agent rewrites, and a
 * matching inode only says the descriptor *was* the file at that name a moment
 * ago. So the proof is anchored on descriptors instead (SEC-020):
 *
 * 1. resolve the leaf (this keeps an in-workspace symlink such as
 *    `CLAUDE.md → AGENTS.md` working) and prove the resolved target is inside;
 * 2. open its **parent directory** with `O_DIRECTORY | O_NOFOLLOW` — this is the
 *    anchor object, and no later rename or symlink swap can redirect it;
 * 3. open the leaf through the anchor's *descriptor* (`/proc/self/fd/<fd>/name`,
 *    the portable `openat` equivalent) with `O_NOFOLLOW`, so the file is opened
 *    relative to that object rather than to a mutable path;
 * 4. ask the kernel where the opened file's descriptor lives and require it to
 *    be inside the workspace **and** to sit in the anchored directory; those two
 *    answers are about the bytes we are holding, not about a name;
 * 5. `fstat` for the type and size limits, then read that descriptor.
 *
 * Step 4 is the containment proof. When the platform cannot answer it (`/proc`
 * is absent: macOS, Windows) there is no way to establish the link, so the
 * request is refused rather than served on a weaker check.
 */
export async function getMeDocPreview(input: WorkspaceDocPreviewInput): Promise<MeDocPreview> {
  const workspacesRoot = input.workspacesRoot ?? join(defaultDataDir(), "workspaces");
  const workspaceRoot = join(workspacesRoot, input.agentName, input.chatId);
  const workspaceRootReal = await realpathOrNotFound(workspaceRoot);
  const relativePath = join(input.basePath ?? "", input.path);
  const candidate = resolve(workspaceRootReal, relativePath);
  const relativeCandidate = assertInsideWorkspace(workspaceRootReal, candidate);

  if (extname(relativeCandidate).toLowerCase() !== ".md") {
    throw new ForbiddenError("Document preview only supports markdown files in the agent workspace");
  }

  const resolvedFile = await realpathOrNotFound(candidate);
  const relativeResolved = assertInsideWorkspace(workspaceRootReal, resolvedFile);
  const parentReal = dirname(resolvedFile);
  assertDirectoryInsideWorkspace(workspaceRootReal, parentReal);

  const readDescriptorPath = input.readDescriptorPath ?? pathOfDescriptor;
  const openDir = input.openDir ?? open;

  const directory = await openDir(parentReal, DIRECTORY_FLAGS).catch(() => {
    // A directory swapped for a symlink fails `O_NOFOLLOW` here, and a directory
    // that vanished fails the open: both are refusals, and both happen before any
    // byte is read.
    throw new NotFoundError("Document not found");
  });

  try {
    // Where the anchor object actually lives. `null` means this platform cannot
    // answer, and then there is nothing to anchor the containment claim to.
    const anchorPath = await readDescriptorPath(directory);
    if (anchorPath === null) {
      throw new ForbiddenError(UNPROVABLE_PLATFORM_MESSAGE);
    }
    if (anchorPath !== parentReal) {
      throw new ForbiddenError("Document changed while it was being opened");
    }
    assertDirectoryInsideWorkspace(workspaceRootReal, anchorPath);

    const openFile = input.openFile ?? open;
    // Opened *through the descriptor*: the kernel resolves the directory object
    // the anchor holds and looks the leaf up inside it. `join(anchorPath, name)`
    // would have been a fresh pathname lookup against a string that may name a
    // different directory by the time the open runs.
    const leafPath = join(`${DESCRIPTOR_ROOT}/${directory.fd}`, basename(resolvedFile));
    const handle = await openFile(leafPath, READ_FLAGS).catch((error: unknown) => {
      // `O_NOFOLLOW` turns a final-component symlink into ELOOP. Say so: the
      // path exists, the shape is what we refuse.
      if (isErrnoCode(error, "ELOOP")) {
        throw new ForbiddenError("Document path must not be a symlink");
      }
      throw new NotFoundError("Document not found");
    });

    try {
      const descriptorStat = await handle.stat();
      if (!descriptorStat.isFile()) {
        throw new NotFoundError("Document not found");
      }
      if (descriptorStat.size > MAX_DOC_BYTES) {
        throw new AppError(413, "Document is larger than the 5MB preview limit");
      }

      // Containment, decided on the opened object rather than on a name.
      const filePath = await readDescriptorPath(handle);
      if (filePath === null) {
        throw new ForbiddenError(UNPROVABLE_PLATFORM_MESSAGE);
      }
      assertInsideWorkspace(workspaceRootReal, filePath);
      if (dirname(filePath) !== anchorPath) {
        throw new ForbiddenError("Document changed while it was being opened");
      }

      const content = await readBounded(handle);
      const refPath = normalizeRefPath(input.path);
      const normalizedBasePath = input.basePath ? normalizeRefPath(input.basePath) : undefined;

      return {
        ref: {
          type: "workspace",
          chatId: input.chatId,
          agentId: input.agentId,
          ...(normalizedBasePath ? { basePath: normalizedBasePath } : {}),
          path: refPath,
        },
        path: relativeResolved,
        content,
      };
    } finally {
      await handle.close();
    }
  } finally {
    await directory.close();
  }
}

const UNPROVABLE_PLATFORM_MESSAGE =
  "This platform cannot prove that the document is inside the agent workspace (no descriptor paths), so the preview is refused.";

/**
 * Kernel-truth path of an opened object, or `null` when the platform cannot say.
 *
 * `/proc/self/fd/<fd>` is a symlink the kernel maintains for the object the
 * descriptor holds; `readlink` therefore describes the bytes, not a name that the
 * agent could have replaced in the meantime.
 */
async function pathOfDescriptor(handle: FileHandle): Promise<string | null> {
  let target: string;
  try {
    target = await readlink(`${DESCRIPTOR_ROOT}/${handle.fd}`);
  } catch {
    // No procfs (macOS, Windows) or the descriptor is already closed.
    return null;
  }
  return target.endsWith(DELETED_SUFFIX) ? target.slice(0, -DELETED_SUFFIX.length) : target;
}

async function realpathOrNotFound(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch {
    throw new NotFoundError("Document not found");
  }
}

/** Like `assertInsideWorkspace`, but the workspace root itself is allowed. */
function assertDirectoryInsideWorkspace(workspaceRoot: string, target: string): void {
  const rel = relative(workspaceRoot, target);
  if (rel === "") return;
  if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new ForbiddenError("Document path must stay inside the agent workspace");
  }
}

function isErrnoCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error as { code?: unknown }).code === code;
}

function assertInsideWorkspace(workspaceRoot: string, target: string): string {
  const rel = relative(workspaceRoot, target);
  if (!rel || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new ForbiddenError("Document path must stay inside the agent workspace");
  }
  return rel.split(sep).join("/");
}

function normalizeRefPath(path: string): string {
  const parts: string[] = [];
  for (const part of path.split(/[\\/]/)) {
    if (!part || part === ".") continue;
    if (part === "..") {
      if (parts.length === 0) throw new ForbiddenError("Document path must stay inside the agent workspace");
      parts.pop();
      continue;
    }
    parts.push(part);
  }
  if (parts.length === 0) throw new ForbiddenError("Document path must name a markdown file");
  return parts.join("/");
}
