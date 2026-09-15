import { execFileSync } from "node:child_process";
import { canonicalGitRepoIdentity, contextTreeSourceHref } from "@first-tree/shared";
import { type ContextTreeForgeRunner, resolveContextTreeForgeCoordinate } from "./context-tree-forge/index.js";

export type ContextTreeSourceLinkInput = {
  repoUrl: string;
  commit: string;
  nodePath: string;
  gitlabInstanceOrigin?: string | null;
  /** A version verified for this instance; omit to read it through local glab. */
  gitlabVersion?: string | null;
};

export type ContextTreeSourceLinkResult = {
  url: string;
  commit: string;
  gitlabVersion: string | null;
};

/** Formats a citation; binding authority and file existence remain the caller's responsibility. */
export function resolveContextTreeSourceLink(
  input: ContextTreeSourceLinkInput,
  run: ContextTreeForgeRunner = runSourceLinkForgeCommand,
): ContextTreeSourceLinkResult {
  if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/iu.test(input.commit)) {
    throw new Error(
      "Use the complete 40- or 64-character commit from git rev-parse HEAD; short SHAs are not citations.",
    );
  }
  const provider = canonicalGitRepoIdentity(input.repoUrl)?.host === "github.com" ? "github" : "gitlab";
  if (provider === "gitlab" && !input.gitlabInstanceOrigin) {
    throw new Error("--gitlab-origin must name the bound repository's verified GitLab web origin.");
  }
  const coordinate = resolveContextTreeForgeCoordinate(provider, input.repoUrl, input.gitlabInstanceOrigin);
  let gitlabVersion: string | null = null;
  if (provider === "gitlab") {
    gitlabVersion = input.gitlabVersion ?? readGitlabVersion(coordinate.host, run);
  }
  const url = contextTreeSourceHref(input, input.gitlabInstanceOrigin ?? null, gitlabVersion);
  if (!url) {
    throw new Error(
      "Cannot build an exact source link: verify the repository, relative node path, and GitLab instance version. Omit the citation instead of guessing a URL.",
    );
  }
  return { url, commit: input.commit.toLowerCase(), gitlabVersion };
}

function readGitlabVersion(host: string, run: ContextTreeForgeRunner): string {
  try {
    const result: unknown = JSON.parse(run("glab", ["api", "version", "--hostname", host], process.cwd()));
    if (typeof result === "object" && result !== null && "version" in result && typeof result.version === "string") {
      return result.version;
    }
  } catch {
    // CLI output can contain credentials or private response data; report only the recovery step.
  }
  throw new Error(
    "Cannot determine the GitLab instance version with glab. Verify local glab access or supply --gitlab-version from that instance; omit the citation if neither is available.",
  );
}

function runSourceLinkForgeCommand(command: string, args: string[], cwd: string): string {
  return execFileSync(command, args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 15_000,
    maxBuffer: 1024 * 1024,
  });
}
