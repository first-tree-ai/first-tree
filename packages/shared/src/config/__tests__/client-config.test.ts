import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clientConfigSchema,
  normalizeContextTreeRepository,
  readContextTreeRepository,
  readContextTreeRepositorySetting,
} from "../client-config.js";
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

  it("returns a canonical repository when the stored value is a GitHub URL", () => {
    writeClientConfig(
      "server:\n  url: http://localhost:8000\ncontext_tree:\n  repository: https://github.com/acme/context.git\n",
    );
    expect(readContextTreeRepository()).toBe("acme/context");
  });

  it("transforms the field schema output to the canonical repository", () => {
    expect(clientConfigSchema.context_tree.repository.schema.parse("https://github.com/acme/context.git")).toBe(
      "acme/context",
    );
  });

  it("preserves a set-but-unusable value for diagnostics", () => {
    writeClientConfig("server:\n  url: http://localhost:8000\ncontext_tree:\n  repository: owner/.hidden\n");
    expect(readContextTreeRepositorySetting()).toEqual({ raw: "owner/.hidden", repository: null });
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

  // Setting this key alone switches the runtime into external mode and stands
  // down First Tree's own Tree Skills. A value the external CLI would reject
  // must therefore fail closed here rather than disable working Skills for a
  // repository that can never be connected.
  it.each(["acme/context", "a/b", "acme-co/context.tree", "acme/context_tree"])("accepts %s", (repository) => {
    writeClientConfig(`server:\n  url: http://localhost:8000\ncontext_tree:\n  repository: ${repository}\n`);
    expect(readContextTreeRepository()).toBe(repository);
  });

  it.each([
    "owner/..",
    "owner/.",
    "-acme/context",
    "acme-/context",
    "acme.co/context",
    "acme",
    "acme/context/extra",
    "owner/-repo",
    "owner/_repo",
    "owner/.hidden",
    "owner/repo.git.git",
    `${"a".repeat(40)}/context`,
    `acme/${"r".repeat(101)}`,
  ])("rejects %s, leaving external mode off", (repository) => {
    writeClientConfig(`server:\n  url: http://localhost:8000\ncontext_tree:\n  repository: "${repository}"\n`);
    expect(readContextTreeRepository()).toBeNull();
  });
});

describe("normalizeContextTreeRepository", () => {
  it.each([
    ["https://github.com/acme/context", "acme/context"],
    ["git@github.com:acme/context.git", "acme/context"],
    ["acme/context.git", "acme/context"],
    ["acme/context/", "acme/context"],
    [" acme/context ", "acme/context"],
  ])("normalizes %s", (value, expected) => {
    expect(normalizeContextTreeRepository(value)).toBe(expected);
  });

  it.each([
    "owner/-repo",
    "owner/_repo",
    "owner/.hidden",
    `${"a".repeat(40)}/repo`,
    `owner/${"r".repeat(101)}`,
  ])("rejects %s", (value) => {
    expect(normalizeContextTreeRepository(value)).toBeNull();
  });
});
