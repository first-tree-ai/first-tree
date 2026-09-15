import { describe, expect, it } from "vitest";
import { contextTreeSourceHref, gitlabBlobRouteForVersion } from "../context-source-link.js";

const COMMIT_40 = "0123456789abcdef0123456789abcdef01234567";
const COMMIT_64 = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

const GITHUB_REPO = "https://github.com/example/context-tree";
const GITLAB_ORIGIN = "https://gitlab.example.com";
const GITLAB_REPO = "https://gitlab.example.com/group/sub/context-tree";

function gitlabSource(overrides: { repoUrl?: string; commit?: string; nodePath?: string } = {}) {
  return {
    repoUrl: overrides.repoUrl ?? GITLAB_REPO,
    commit: overrides.commit ?? COMMIT_40,
    nodePath: overrides.nodePath ?? "domains/pricing/policy.md",
  };
}

describe("gitlabBlobRouteForVersion", () => {
  it("keeps the legacy /blob/ route for the reported 11.11.3 instance", () => {
    expect(gitlabBlobRouteForVersion("11.11.3")).toBe("/blob/");
  });

  it("keeps the legacy route through the 12.6 boundary", () => {
    expect(gitlabBlobRouteForVersion("12.6.0")).toBe("/blob/");
    expect(gitlabBlobRouteForVersion("12.6.9-ee")).toBe("/blob/");
  });

  it("uses the scoped /-/blob/ route from 12.7 on, including current CE and EE", () => {
    expect(gitlabBlobRouteForVersion("12.7.0")).toBe("/-/blob/");
    expect(gitlabBlobRouteForVersion("12.7.0-ee")).toBe("/-/blob/");
    expect(gitlabBlobRouteForVersion("17.11.2")).toBe("/-/blob/");
    expect(gitlabBlobRouteForVersion("17.11.2-ee")).toBe("/-/blob/");
    expect(gitlabBlobRouteForVersion("13.12")).toBe("/-/blob/");
  });

  it("treats a nonstable build of the 12.7 boundary conservatively as legacy", () => {
    // A 12.7.0-pre/rc build can predate the route merge, and /blob/ resolves
    // on every supported version, so the safe choice is the legacy route.
    expect(gitlabBlobRouteForVersion("12.7.0-pre")).toBe("/blob/");
    expect(gitlabBlobRouteForVersion("12.7.0-rc42-ee")).toBe("/blob/");
    // Strictly beyond the boundary the scoped route exists in any build.
    expect(gitlabBlobRouteForVersion("13.0.0-pre")).toBe("/-/blob/");
  });

  it("returns null for missing or malformed versions", () => {
    expect(gitlabBlobRouteForVersion(null)).toBeNull();
    expect(gitlabBlobRouteForVersion(undefined)).toBeNull();
    expect(gitlabBlobRouteForVersion("")).toBeNull();
    expect(gitlabBlobRouteForVersion("   ")).toBeNull();
    expect(gitlabBlobRouteForVersion("unknown")).toBeNull();
    expect(gitlabBlobRouteForVersion("12")).toBeNull();
    expect(gitlabBlobRouteForVersion("v12.7.0")).toBeNull();
    expect(gitlabBlobRouteForVersion("12.7.0.1")).toBeNull();
    expect(gitlabBlobRouteForVersion("999999999999999999999.0.0")).toBeNull();
    expect(gitlabBlobRouteForVersion("0.0.0")).toBeNull();
  });
});

describe("contextTreeSourceHref", () => {
  it("links the reported 11.11.3 instance with the legacy /blob/ route", () => {
    expect(contextTreeSourceHref(gitlabSource(), GITLAB_ORIGIN, "11.11.3")).toBe(
      `${GITLAB_ORIGIN}/group/sub/context-tree/blob/${COMMIT_40}/domains/pricing/policy.md`,
    );
  });

  it("links a 12.6 boundary instance with /blob/ and 12.7 with /-/blob/", () => {
    expect(contextTreeSourceHref(gitlabSource(), GITLAB_ORIGIN, "12.6.0")).toBe(
      `${GITLAB_ORIGIN}/group/sub/context-tree/blob/${COMMIT_40}/domains/pricing/policy.md`,
    );
    expect(contextTreeSourceHref(gitlabSource(), GITLAB_ORIGIN, "12.7.0-ee")).toBe(
      `${GITLAB_ORIGIN}/group/sub/context-tree/-/blob/${COMMIT_40}/domains/pricing/policy.md`,
    );
  });

  it("returns null for a connected GitLab with a missing or malformed version", () => {
    expect(contextTreeSourceHref(gitlabSource(), GITLAB_ORIGIN)).toBeNull();
    expect(contextTreeSourceHref(gitlabSource(), GITLAB_ORIGIN, null)).toBeNull();
    expect(contextTreeSourceHref(gitlabSource(), GITLAB_ORIGIN, "not-a-version")).toBeNull();
  });

  it("links GitHub with /blob/ without requiring a GitLab version", () => {
    expect(contextTreeSourceHref(gitlabSource({ repoUrl: GITHUB_REPO }), null)).toBe(
      `${GITHUB_REPO}/blob/${COMMIT_40}/domains/pricing/policy.md`,
    );
    // An unrelated connected GitLab does not change GitHub routing.
    expect(contextTreeSourceHref(gitlabSource({ repoUrl: GITHUB_REPO }), GITLAB_ORIGIN, "11.11.3")).toBe(
      `${GITHUB_REPO}/blob/${COMMIT_40}/domains/pricing/policy.md`,
    );
  });

  it("rejects short SHAs and branch/tag refs on both forges", () => {
    for (const commit of ["83c3939e90b", "main", "release-2026.05", "0123456789abcdef0123456789abcdef0123456g"]) {
      expect(contextTreeSourceHref(gitlabSource({ commit }), GITLAB_ORIGIN, "17.11.2")).toBeNull();
      expect(contextTreeSourceHref(gitlabSource({ repoUrl: GITHUB_REPO, commit }), null)).toBeNull();
    }
  });

  it("accepts a complete 40-hex SHA-1 and 64-hex SHA-256 commit", () => {
    expect(contextTreeSourceHref(gitlabSource({ commit: COMMIT_40 }), GITLAB_ORIGIN, "17.11.2")).toContain(
      `/-/blob/${COMMIT_40}/`,
    );
    expect(contextTreeSourceHref(gitlabSource({ commit: COMMIT_64 }), GITLAB_ORIGIN, "17.11.2")).toContain(
      `/-/blob/${COMMIT_64}/`,
    );
    expect(contextTreeSourceHref(gitlabSource({ repoUrl: GITHUB_REPO, commit: COMMIT_64 }), null)).toContain(
      `/blob/${COMMIT_64}/`,
    );
  });

  it("encodes spaces and Unicode by path segment, keeping nested groups intact", () => {
    expect(
      contextTreeSourceHref(
        gitlabSource({ nodePath: "domains/pricing policy/定价 策略.md" }),
        GITLAB_ORIGIN,
        "17.11.2",
      ),
    ).toBe(
      `${GITLAB_ORIGIN}/group/sub/context-tree/-/blob/${COMMIT_40}/domains/pricing%20policy/%E5%AE%9A%E4%BB%B7%20%E7%AD%96%E7%95%A5.md`,
    );
  });

  it("returns null when the repo does not match the connected origin", () => {
    expect(
      contextTreeSourceHref(
        gitlabSource({ repoUrl: "https://gitlab.other.com/group/sub/context-tree" }),
        GITLAB_ORIGIN,
        "17.11.2",
      ),
    ).toBeNull();
    // HTTPS identities include the exact web port: the same host on another
    // port is not the connected instance.
    expect(
      contextTreeSourceHref(
        gitlabSource({ repoUrl: "https://gitlab.example.com:9443/group/sub/context-tree" }),
        GITLAB_ORIGIN,
        "17.11.2",
      ),
    ).toBeNull();
  });

  it("maps an SSH transport to the connected web origin without trusting its port", () => {
    const sshRepo = "ssh://git@gitlab.example.com:2222/group/sub/context-tree.git";
    expect(contextTreeSourceHref(gitlabSource({ repoUrl: sshRepo }), GITLAB_ORIGIN, "17.11.2")).toBe(
      `${GITLAB_ORIGIN}/group/sub/context-tree/-/blob/${COMMIT_40}/domains/pricing/policy.md`,
    );
    const scpRepo = "git@gitlab.example.com:group/sub/context-tree.git";
    expect(contextTreeSourceHref(gitlabSource({ repoUrl: scpRepo }), GITLAB_ORIGIN, "11.11.3")).toBe(
      `${GITLAB_ORIGIN}/group/sub/context-tree/blob/${COMMIT_40}/domains/pricing/policy.md`,
    );
  });

  it("rejects invalid, traversal, absolute, backslash, and control-character node paths", () => {
    const badPaths = [
      "",
      "/absolute/path.md",
      "C:/absolute/path.md",
      "trailing/slash/",
      "../escape.md",
      "domains/../../escape.md",
      "domains//gap.md",
      "domains/./dot.md",
      "back\\slash.md",
      "control\tchar.md",
      "line\nbreak.md",
      // Unpaired UTF-16 surrogate: `encodeURIComponent` throws on it, and the
      // builder must turn that into a rejected path, never a throw.
      "lone\uD800surrogate.md",
    ];
    for (const nodePath of badPaths) {
      expect(contextTreeSourceHref(gitlabSource({ nodePath }), GITLAB_ORIGIN, "17.11.2")).toBeNull();
    }
  });

  it("rejects credential-bearing and otherwise unsafe repo URLs", () => {
    const badRepos = [
      "https://oauth2:secret@gitlab.example.com/group/sub/context-tree.git",
      "https://user@gitlab.example.com/group/sub/context-tree.git",
      "ssh://git:pw@gitlab.example.com/group/sub/context-tree.git",
      "https://gitlab.example.com/group/sub/context-tree.git?token=x",
      "https://gitlab.example.com/group/sub/context-tree.git#frag",
      "http://gitlab.example.com/group/sub/context-tree.git",
      "not a repo url",
    ];
    for (const repoUrl of badRepos) {
      expect(contextTreeSourceHref(gitlabSource({ repoUrl }), GITLAB_ORIGIN, "17.11.2")).toBeNull();
    }
    expect(
      contextTreeSourceHref(
        gitlabSource({ repoUrl: "git@gitlab.example.com:group/tree.git" }),
        "http://gitlab.example.com",
        "11.11.3",
      ),
    ).toBeNull();
  });
});
