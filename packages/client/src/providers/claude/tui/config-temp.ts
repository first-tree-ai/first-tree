import { chmodSync, closeSync, mkdirSync, mkdtempSync, openSync, writeSync } from "node:fs";
import { join } from "node:path";
import { defaultDataDir } from "@first-tree/shared/config";

/**
 * Per-launch scratch directory for the TUI provider.
 *
 * The files written here carry material the agent's own process should not share
 * with the rest of the workspace: MCP server definitions (including
 * `Authorization` headers) and the rendered prompt. Three properties matter
 * (SEC-032):
 *
 * 1. **Location.** It lives under the runtime's own data directory, not under
 *    the agent-writable workspace, so a wide `chmod`, a `git add -A`, or a
 *    workspace sync never picks up a credential file.
 * 2. **Fresh per launch.** `mkdtemp` creates a directory no other process has a
 *    name for, and it is 0700 by construction. Nothing is reused, so nothing
 *    left behind by an earlier build can be inherited.
 * 3. **Exclusive files.** Each file is created with `wx` and mode 0600: an
 *    existing path makes the write fail instead of silently truncating whatever
 *    is there.
 */

/** Runtime-owned root for per-launch scratch directories. */
export function configTempRoot(): string {
  return join(defaultDataDir(), "tmp", "tui");
}

/**
 * Create a fresh scratch directory for one launch.
 *
 * `root` exists for tests; production callers use the runtime-owned default.
 */
export function ensureConfigTempDir(root: string = configTempRoot()): string {
  // `recursive: true` leaves an existing directory's mode untouched, so the
  // chmod after it is what tightens a root created by an older build.
  mkdirSync(root, { recursive: true, mode: 0o700 });
  chmodSync(root, 0o700);
  return mkdtempSync(join(root, "launch-"));
}

/** Write one private file into a fresh launch directory. */
export function writeConfigTempFile(path: string, contents: string): void {
  // `wx` + 0600: exclusive creation with the final mode from the first byte. A
  // pre-existing path is an error, never a truncate.
  const fd = openSync(path, "wx", 0o600);
  try {
    writeSync(fd, contents);
  } finally {
    closeSync(fd);
  }
}
