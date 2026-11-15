import { chmodSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ensureConfigTempDir, writeConfigTempFile } from "../../tui/config-temp.js";

/**
 * SEC-032: the per-session config dir holds MCP server definitions (with
 * `Authorization` headers) and the rendered prompt, and it sits inside the
 * agent-writable workspace. Nothing outside the agent process needs to read it,
 * so it is 0700/0600 even when an older build or a wide umask left it wider.
 */
describe("config temp dir", () => {
  const dirs: string[] = [];

  afterEach(() => {
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
    dirs.length = 0;
  });

  function workspace(): string {
    const dir = mkdtempSync(join(tmpdir(), "ft-config-temp-"));
    dirs.push(dir);
    return dir;
  }

  it("creates the session directory 0700", () => {
    const dir = ensureConfigTempDir(workspace(), "session-1");
    expect(statSync(dir).mode & 0o777).toBe(0o700);
  });

  it("tightens a directory that already exists with a wider mode", () => {
    const root = workspace();
    const dir = ensureConfigTempDir(root, "session-1");
    chmodSync(dir, 0o755);

    expect(ensureConfigTempDir(root, "session-1")).toBe(dir);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
  });

  it("writes files 0600, including over a wider pre-existing file", () => {
    const dir = ensureConfigTempDir(workspace(), "session-1");
    const path = join(dir, "mcp-config.json");

    writeConfigTempFile(path, '{"mcpServers":{}}');
    expect(statSync(path).mode & 0o777).toBe(0o600);

    chmodSync(path, 0o644);
    writeConfigTempFile(path, '{"mcpServers":{"x":{}}}');
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  it("keeps the existing contents semantics of a write", () => {
    const dir = ensureConfigTempDir(workspace(), "session-1");
    const path = join(dir, "runtime-context.md");
    writeFileSync(path, "stale");

    writeConfigTempFile(path, "fresh");
    expect(statSync(path).size).toBe("fresh".length);
  });
});
