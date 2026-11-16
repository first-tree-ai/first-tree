import { constants as fsConstants } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import { lstat, open, realpath } from "node:fs/promises";
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
 * The workspace is agent-writable, so every name in it can be replaced between
 * two syscalls. The containment proof is therefore anchored on the **parent
 * directory** and re-established **after** the read (SEC-020):
 *
 * 1. resolve the parent, prove it is inside the workspace, and open the child
 *    through that resolved anchor with `O_NOFOLLOW` — the final component can
 *    never be a symlink;
 * 2. `fstat` the descriptor for the type and size limits, then read it;
 * 3. after the read, resolve the parent again and require the same result, and
 *    require the inode still at the anchored name to be the descriptor's inode.
 *
 * Step 3 is what ties containment to the object that was actually read: an
 * attacker who swaps the parent directory for a symlink between the open and
 * the read makes the second resolution disagree, and an attacker who replaces
 * the file makes the inode disagree. Either way the bytes are discarded rather
 * than returned. (Node has no `openat`, so the parent re-resolution is the
 * portable way to keep the proof attached to the opened object.)
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

  // Resolve the leaf once (this is what keeps an in-workspace symlink such as
  // CLAUDE.md → AGENTS.md working) and prove the resolved target is inside.
  // The open below then uses the resolved name with `O_NOFOLLOW`, so the leaf
  // cannot become a symlink between this check and the read.
  const resolvedFile = await realpathOrNotFound(candidate);
  const relativeResolved = assertInsideWorkspace(workspaceRootReal, resolvedFile);
  const parentReal = dirname(resolvedFile);
  assertDirectoryInsideWorkspace(workspaceRootReal, parentReal);
  const anchored = join(parentReal, basename(resolvedFile));

  const openFile = input.openFile ?? open;
  const handle = await openFile(anchored, READ_FLAGS).catch((error: unknown) => {
    // `O_NOFOLLOW` turns a final-component symlink into ELOOP. Say so: the path
    // exists, the shape is what we refuse.
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

    const content = await readBounded(handle);

    // Post-read re-validation: this is what makes the containment claim cover
    // the bytes above rather than the state before the read.
    const parentAfter = await realpath(dirname(anchored)).catch(() => {
      throw new ForbiddenError("Document changed while it was being read");
    });
    if (parentAfter !== parentReal) {
      throw new ForbiddenError("Document changed while it was being read");
    }
    const namedStat = await lstat(anchored).catch(() => {
      throw new NotFoundError("Document not found");
    });
    if (namedStat.dev !== descriptorStat.dev || namedStat.ino !== descriptorStat.ino) {
      throw new ForbiddenError("Document changed while it was being read");
    }

    const normalizedPath = relativeResolved;
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
      path: normalizedPath,
      content,
    };
  } finally {
    await handle.close();
  }
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
