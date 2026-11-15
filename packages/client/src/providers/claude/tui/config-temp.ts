import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Per-session scratch directory for the TUI provider.
 *
 * The files written here carry material the agent's own process should not share
 * with the rest of the workspace: MCP server definitions (including
 * `Authorization` headers) and the rendered prompt. They live under the
 * agent-writable workspace, so the directory itself is 0700 and every file 0600
 * (SEC-032). A crash leaves them behind, hence the sweep in
 * `removeConfigTempDir`'s callers and the mode re-assertion here: a directory
 * created by an older build, or by anything else, is tightened rather than
 * trusted.
 */
export function ensureConfigTempDir(workspaceCwd: string, sessionId: string): string {
  const dir = join(workspaceCwd, ".claude-code-tui", sessionId);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  // `recursive: true` leaves an existing directory's mode untouched.
  chmodSync(dir, 0o700);
  return dir;
}

/** Write one private file into a config temp dir. */
export function writeConfigTempFile(path: string, contents: string): void {
  writeFileSync(path, contents, { encoding: "utf-8", mode: 0o600 });
  // `mode` on write only applies to a file this call creates; an older file
  // keeps whatever it had.
  chmodSync(path, 0o600);
}
