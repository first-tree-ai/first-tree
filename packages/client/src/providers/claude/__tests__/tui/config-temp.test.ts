import { chmodSync, existsSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  configTempRoot,
  ensureConfigTempDir,
  writeConfigTempFile,
} from "../../tui/config-temp.js";

/**
 * SEC-032: the per-session config dir holds MCP server definitions (with
 * `Authorization` headers) and the rendered prompt. It used to live inside the
 * agent-writable workspace and to be chmod'ed after the write, so a wide umask
 * or a crash left a readable credential file behind.
 */
describe("config temp dir", () => {
  const dirs: string[] = [];
  const originalHome = process.env.FIRST_TREE_HOME;

  beforeEach(() => {
    const home = mkdtempSync(join(tmpdir(), "ft-config-home-"));
    dirs.push(home);
    process.env.FIRST_TREE_HOME = home;
  });

  afterEach(() => {
    if (originalHome === undefined) delete process.env.FIRST_TREE_HOME;
    else process.env.FIRST_TREE_HOME = originalHome;
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
    dirs.length = 0;
  });

  function scratch(): string {
    const dir = mkdtempSync(join(tmpdir(), "ft-config-temp-"));
    dirs.push(dir);
    return dir;
  }

  it("defaults to a runtime-owned root, not the workspace", () => {
    const workspace = scratch();
    const dir = ensureConfigTempDir("session-1");

    expect(dir.startsWith(workspace)).toBe(false);
    expect(dir.startsWith(configTempRoot())).toBe(true);
    expect(dir.startsWith(process.env.FIRST_TREE_HOME ?? "")).toBe(true);
  });

  it("creates the session directory 0700", () => {
    const dir = ensureConfigTempDir("session-1", scratch());
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    expect(statSync(join(dir, "..")).mode & 0o777).toBe(0o700);
  });

  it("tightens a directory that already exists with a wider mode", () => {
    const root = scratch();
    const dir = ensureConfigTempDir("session-1", root);
    chmodSync(dir, 0o755);

    expect(ensureConfigTempDir("session-1", root)).toBe(dir);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
  });

  it("writes files 0600, including over a wider pre-existing file", () => {
    const dir = ensureConfigTempDir("session-1", scratch());
    const path = join(dir, "mcp-config.json");

    writeConfigTempFile(path, '{"mcpServers":{}}');
    expect(statSync(path).mode & 0o777).toBe(0o600);

    // A credential file left by an older build must not stay group-readable,
    // even for the instant before the rewrite finishes.
    chmodSync(path, 0o644);
    writeConfigTempFile(path, '{"mcpServers":{"x":{}}}');
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  it("replaces contents instead of appending", () => {
    const dir = ensureConfigTempDir("session-1", scratch());
    const path = join(dir, "runtime-context.md");
    writeFileSync(path, "stale");

    writeConfigTempFile(path, "fresh");
    expect(statSync(path).size).toBe("fresh".length);
  });

  it("does not write into the workspace it is given", () => {
    const workspace = scratch();
    const dir = ensureConfigTempDir("session-1", scratch());
    writeConfigTempFile(join(dir, "runtime-context.md"), "x");

    expect(existsSync(join(workspace, ".claude-code-tui"))).toBe(false);
  });
});
