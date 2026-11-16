import { constants as fsConstants } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import { open, realpath, stat } from "node:fs/promises";
import { extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { defaultDataDir } from "@first-tree/shared/config";
import { AppError, ForbiddenError, NotFoundError } from "../../../errors.js";
import { MAX_DOC_BYTES, readBounded } from "./bounded-read.js";

/**
 * `O_NONBLOCK` keeps a workspace entry that is not a file (a FIFO an agent
 * created, say) from blocking the request until a writer shows up; the
 * descriptor type check below turns it into a plain 404.
 */
const READ_FLAGS = fsConstants.O_RDONLY | (fsConstants.O_NONBLOCK ?? 0);

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
 * The workspace is agent-writable, so the path it names can be replaced between
 * any two syscalls. Validation therefore happens on the descriptor this function
 * actually reads (SEC-020): open once, `fstat` that descriptor for the type and
 * size limits, resolve the name to confirm it is still inside the workspace, and
 * check that the resolved name and the descriptor are the same file. A symlink
 * planted after the open changes the name, not the descriptor, so the identity
 * check fails and nothing outside the workspace is returned.
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

  const openFile = input.openFile ?? open;
  const handle = await openFile(candidate, READ_FLAGS).catch(() => {
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

    // Resolve the name *after* the open: this is what catches a path that was
    // already a symlink pointing out of the workspace, and the identity check
    // below catches a path that was swapped for another file in the meantime.
    const fileReal = await realpath(candidate).catch(() => {
      throw new NotFoundError("Document not found");
    });
    const normalizedPath = assertInsideWorkspace(workspaceRootReal, fileReal);
    const namedStat = await stat(fileReal).catch(() => {
      throw new NotFoundError("Document not found");
    });
    if (namedStat.dev !== descriptorStat.dev || namedStat.ino !== descriptorStat.ino) {
      throw new ForbiddenError("Document changed while it was being opened");
    }

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
      // Same descriptor that passed the checks above — no second lookup by name.
      content: await readBounded(handle),
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
