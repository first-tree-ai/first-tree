import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { configTempRoot, ensureConfigTempDir, writeConfigTempFile } from "../../tui/config-temp.js";

/**
 * SEC-032: the launch scratch dir holds MCP server definitions (with
 * `Authorization` headers) and the rendered prompt. It must not live in the
 * agent-writable workspace, must not be reused across launches, and its files
 * must not be able to overwrite an existing path.
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
    const dir = ensureConfigTempDir();

    expect(dir.startsWith(workspace)).toBe(false);
    expect(dir.startsWith(configTempRoot())).toBe(true);
    expect(dir.startsWith(process.env.FIRST_TREE_HOME ?? "")).toBe(true);
  });

  it("creates a fresh 0700 directory per launch", () => {
    const root = scratch();
    const first = ensureConfigTempDir(root);
    const second = ensureConfigTempDir(root);

    expect(first).not.toBe(second);
    expect(statSync(first).mode & 0o777).toBe(0o700);
    expect(statSync(second).mode & 0o777).toBe(0o700);
    expect(statSync(root).mode & 0o777).toBe(0o700);
  });

  it("writes files 0600", () => {
    const dir = ensureConfigTempDir(scratch());
    const path = join(dir, "mcp-config.json");

    writeConfigTempFile(path, '{"mcpServers":{}}');

    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(readFileSync(path, "utf8")).toBe('{"mcpServers":{}}');
  });

  it("refuses to overwrite an existing path instead of truncating it", () => {
    const dir = ensureConfigTempDir(scratch());
    const path = join(dir, "runtime-context.md");
    writeFileSync(path, "stale", { mode: 0o644 });

    expect(() => writeConfigTempFile(path, "fresh")).toThrow(/EEXIST/u);
    // The original bytes are untouched: the failure happened at open, not
    // after a truncate.
    expect(readFileSync(path, "utf8")).toBe("stale");
  });

  it("replaces contents within a fresh directory", () => {
    const dir = ensureConfigTempDir(scratch());
    const path = join(dir, "runtime-context.md");

    writeConfigTempFile(path, "fresh");
    expect(statSync(path).size).toBe("fresh".length);
  });

  it("does not write into the workspace it is given", () => {
    const workspace = scratch();
    const dir = ensureConfigTempDir(scratch());
    writeConfigTempFile(join(dir, "runtime-context.md"), "x");

    expect(existsSync(join(workspace, ".claude-code-tui"))).toBe(false);
  });
});
