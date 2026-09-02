import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readContextTreeRepository } from "../client-config.js";
import { resetConfigMeta } from "../resolver.js";
import { resetConfig } from "../singleton.js";

let testDir: string;

function writeClientConfig(body: string): void {
  const configDir = join(testDir, "config");
  mkdirSync(configDir, { recursive: true });
  writeFileSync(join(configDir, "client.yaml"), body, "utf8");
  vi.stubEnv("FIRST_TREE_HOME", testDir);
}

beforeEach(() => {
  testDir = join(tmpdir(), `first-tree-client-config-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(testDir, { recursive: true });
  resetConfig();
  resetConfigMeta();
});

afterEach(() => {
  if (existsSync(testDir)) rmSync(testDir, { recursive: true, force: true });
  vi.unstubAllEnvs();
});

describe("readContextTreeRepository", () => {
  it("returns null when context_tree.repository is unset — external Context Tree mode is off", () => {
    writeClientConfig("server:\n  url: http://localhost:8000\n");
    expect(readContextTreeRepository()).toBeNull();
  });

  it("returns the configured OWNER/REPO", () => {
    writeClientConfig("server:\n  url: http://localhost:8000\ncontext_tree:\n  repository: acme/context\n");
    expect(readContextTreeRepository()).toBe("acme/context");
  });

  it("returns null rather than throwing when there is no config at all", () => {
    // Login and the standalone runtime boot both call this before any config
    // exists. Throwing here would fail the login instead of reporting a mode.
    vi.stubEnv("FIRST_TREE_HOME", join(testDir, "absent"));
    expect(() => readContextTreeRepository()).not.toThrow();
    expect(readContextTreeRepository()).toBeNull();
  });

  it("reads the env override without a config file", () => {
    writeClientConfig("server:\n  url: http://localhost:8000\n");
    vi.stubEnv("FIRST_TREE_CONTEXT_TREE_REPOSITORY", "acme/from-env");
    expect(readContextTreeRepository()).toBe("acme/from-env");
  });
});
