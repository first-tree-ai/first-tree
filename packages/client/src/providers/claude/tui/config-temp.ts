import { chmodSync, closeSync, fchmodSync, mkdirSync, openSync, writeSync } from "node:fs";
import { join } from "node:path";
import { defaultDataDir } from "@first-tree/shared/config";

/**
 * Per-session scratch directory for the TUI provider.
 *
 * The files written here carry material the agent's own process should not share
 * with the rest of the workspace: MCP server definitions (including
 * `Authorization` headers) and the rendered prompt. Two properties matter
 * (SEC-032):
 *
 * 1. **Location.** It lives under the runtime's own data directory, not under
 *    the agent-writable workspace, so a wide `chmod`, a `git add -A`, or a
 *    workspace sync never picks up a credential file.
 * 2. **Creation mode.** The directory is 0700 and each file 0600 from the moment
 *    it exists — the file is opened with that mode and re-tightened on the
 *    descriptor before any bytes are written, so there is no window where a
 *    wider mode is observable (and a pre-existing file is not trusted).
 */

/** Runtime-owned root for per-session scratch dirs. */
export function configTempRoot(): string {
  return join(defaultDataDir(), "tmp", "tui");
}

/**
 * Create (or tighten) the scratch directory for one session.
 *
 * `root` exists for tests; production callers use the runtime-owned default.
 */
export function ensureConfigTempDir(sessionId: string, root: string = configTempRoot()): string {
  const dir = join(root, sessionId);
  for (const path of [root, dir]) {
    // `recursive: true` leaves an existing directory's mode untouched, so the
    // chmod after it is what tightens a directory created by an older build.
    mkdirSync(path, { recursive: true, mode: 0o700 });
    chmodSync(path, 0o700);
  }
  return dir;
}

/** Write one private file into a config temp dir. */
export function writeConfigTempFile(path: string, contents: string): void {
  const fd = openSync(path, "w", 0o600);
  try {
    // The mode above only applies to a file this call creates; this also covers
    // a file left behind by an earlier build, before a single byte is written.
    fchmodSync(fd, 0o600);
    writeSync(fd, contents);
  } finally {
    closeSync(fd);
  }
}
