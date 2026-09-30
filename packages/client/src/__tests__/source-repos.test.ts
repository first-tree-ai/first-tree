import { join } from "node:path";
import { DEFAULT_AGENT_RUNTIME_CONFIG_PAYLOAD, SOURCE_REPOS_DIRNAME } from "@first-tree/shared";
import { afterEach, describe, expect, it } from "vitest";
import { codexDesktopAppBinDirs, wellKnownBinDirs } from "../runtime/install-locations.js";
import { currentSourceRepoNamesFromPayload, declaredSourceRepos } from "../runtime/source-repos.js";

const originalPlatform = process.platform;

function setPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, "platform", { configurable: true, value: platform });
}

afterEach(() => {
  setPlatform(originalPlatform);
});

describe("wellKnownBinDirs", () => {
  it("includes macOS-only package-manager locations on darwin", () => {
    setPlatform("darwin");

    const dirs = wellKnownBinDirs("/Users/gandy");

    expect(dirs).toContain(join("/Users/gandy", "Library", "pnpm"));
    expect(dirs).toContain("/opt/homebrew/bin");
    expect(dirs).toContain(join("/Users/gandy", ".local", "bin"));
    expect(dirs).toContain("/usr/local/bin");
  });

  it("omits macOS-only locations on Linux while keeping cross-platform shims", () => {
    setPlatform("linux");

    const dirs = wellKnownBinDirs("/home/gandy");

    expect(dirs).toContain(join("/home/gandy", ".volta", "bin"));
    expect(dirs).toContain(join("/home/gandy", ".local", "share", "pnpm"));
    expect(dirs).not.toContain(join("/home/gandy", "Library", "pnpm"));
    expect(dirs).not.toContain("/opt/homebrew/bin");
  });
});

describe("codexDesktopAppBinDirs", () => {
  it("checks the current ChatGPT app paths before legacy Codex app paths on macOS", () => {
    expect(codexDesktopAppBinDirs("/Users/gandy", "darwin")).toEqual([
      join("/Applications", "ChatGPT.app", "Contents", "Resources"),
      join("/Users/gandy", "Applications", "ChatGPT.app", "Contents", "Resources"),
      join("/Applications", "ChatGPT.app", "Contents", "Resources", "codex-cli", "CodexCLI.app", "Contents", "MacOS"),
      join(
        "/Users/gandy",
        "Applications",
        "ChatGPT.app",
        "Contents",
        "Resources",
        "codex-cli",
        "CodexCLI.app",
        "Contents",
        "MacOS",
      ),
      join("/Applications", "Codex.app", "Contents", "Resources"),
      join("/Users/gandy", "Applications", "Codex.app", "Contents", "Resources"),
    ]);
  });

  it("does not add macOS app bundle paths on other platforms", () => {
    expect(codexDesktopAppBinDirs("/home/gandy", "linux")).toEqual([]);
  });
});

describe("source repo derivation", () => {
  it("defers current source names when the payload was not resolved", () => {
    expect(currentSourceRepoNamesFromPayload(DEFAULT_AGENT_RUNTIME_CONFIG_PAYLOAD, false)).toBeNull();
  });

  it("returns an empty set for a resolved payload without git repos", () => {
    expect([...(currentSourceRepoNamesFromPayload(undefined, true) ?? [])]).toEqual([]);
  });

  it("derives current source repo names from explicit and URL-derived local paths", () => {
    const names = currentSourceRepoNamesFromPayload(
      {
        ...DEFAULT_AGENT_RUNTIME_CONFIG_PAYLOAD,
        gitRepos: [
          { url: "https://github.com/acme/service-api.git" },
          { url: "git@github.com:acme/service-api.git", localPath: "service-api-ssh" },
        ],
      },
      true,
    );

    expect([...(names ?? [])]).toEqual(["service-api", "service-api-ssh"]);
  });

  it("maps declared repos to source-repos paths and keeps optional refs sparse", () => {
    const workspace = join("/tmp", "agent-home");

    const repos = declaredSourceRepos(workspace, {
      ...DEFAULT_AGENT_RUNTIME_CONFIG_PAYLOAD,
      gitRepos: [
        { url: "https://github.com/acme/service-api.git" },
        { url: "git@github.com:acme/docs.git", localPath: "docs-site", ref: "release" },
      ],
    });

    expect(repos).toEqual([
      {
        absolutePath: join(workspace, SOURCE_REPOS_DIRNAME, "service-api"),
        url: "https://github.com/acme/service-api.git",
      },
      {
        absolutePath: join(workspace, SOURCE_REPOS_DIRNAME, "docs-site"),
        url: "git@github.com:acme/docs.git",
        ref: "release",
      },
    ]);
  });

  it("rejects unsafe declared repo local paths", () => {
    expect(() =>
      declaredSourceRepos("/tmp/agent-home", {
        ...DEFAULT_AGENT_RUNTIME_CONFIG_PAYLOAD,
        gitRepos: [{ url: "https://github.com/acme/repo.git", localPath: "../escape" }],
      }),
    ).toThrow('Unsafe git repo localPath "../escape"');
  });
});
