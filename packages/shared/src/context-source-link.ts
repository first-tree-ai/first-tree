import { canonicalGitRepoIdentity, resolveGitLabRepositoryWebIdentity } from "./canonical-git-repo-url.js";
import { contextTreeRepoSchema } from "./schemas/org-settings.js";

export type ContextTreeSourceRef = {
  repoUrl: string;
  commit: string;
  nodePath: string;
};

/** GitLab blob route infix: pre-12.7 unscoped, 12.7+ scoped under `-`. */
export type GitLabBlobRoute = "/blob/" | "/-/blob/";

// An exact-commit link is the only link a citation may promise: 40-hex SHA-1
// or 64-hex SHA-256. A short SHA or a branch/tag ref names a moving or
// ambiguous target, and the parser contract (`parseExactContextSourceLink`)
// rejects them on read-back, so they are rejected here at build time.
const EXACT_COMMIT_RE = /^(?:[0-9a-fA-F]{40}|[0-9a-fA-F]{64})$/u;

// GitLab reports versions like `17.11.2`, `17.11.2-ee`, `13.12`,
// `12.7.0-pre`, or `16.11.0-rc42-ee`. Only the leading numeric triple and the
// channel suffix matter for route capability.
const GITLAB_VERSION_RE = /^(\d+)\.(\d+)(?:\.(\d+))?(-[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?$/u;
const GITLAB_STABLE_CHANNEL_SUFFIX_RE = /^-(?:ce|ee)$/iu;

/**
 * Pick the GitLab blob route for an observed instance version.
 *
 * GitLab drew the repository routes unscoped through v12.6.0 and added the
 * `-` scope in v12.7.0 (keeping the unscoped draw), so `/blob/` resolves on
 * every version back to at least 11.11.3 while `/-/blob/` resolves only from
 * 12.7 on. Version history:
 * https://gitlab.com/gitlab-org/gitlab-foss/-/raw/v12.6.0/config/routes/project.rb
 * https://gitlab.com/gitlab-org/gitlab-foss/-/raw/v12.7.0/config/routes/project.rb
 *
 * Returns `null` when the version is missing or unparseable — an unknown
 * instance stays plain text rather than guessing a route it may not serve.
 * CE/EE channel suffixes do not change routing. Other suffixes mark a
 * nonstable build; a nonstable build of exactly the 12.7 boundary can predate
 * the route merge, so it conservatively keeps that release's legacy route.
 */
export function gitlabBlobRouteForVersion(gitlabVersion: string | null | undefined): GitLabBlobRoute | null {
  const trimmed = gitlabVersion?.trim();
  if (!trimmed) return null;
  const match = GITLAB_VERSION_RE.exec(trimmed);
  if (!match) return null;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  if (!Number.isSafeInteger(major) || major < 1 || !Number.isSafeInteger(minor)) return null;
  const beforeScoped = major < 12 || (major === 12 && minor < 7);
  if (beforeScoped) return "/blob/";
  const beyondScoped = major > 12 || (major === 12 && minor > 7);
  if (beyondScoped) return "/-/blob/";
  const suffix = match[4] ?? "";
  return suffix === "" || GITLAB_STABLE_CHANNEL_SUFFIX_RE.test(suffix) ? "/-/blob/" : "/blob/";
}

/**
 * Encode a tree-root-relative node path for a forge URL, one segment at a
 * time so legitimate spaces and Unicode survive while structural attacks do
 * not. Returns `null` for absolute paths, drive/backslash forms, traversal or
 * empty segments, control characters, and unpaired UTF-16 surrogates (which
 * `encodeURIComponent` would throw on).
 */
function encodeSourceNodePath(nodePath: string): string | null {
  if (nodePath.length === 0) return null;
  if (nodePath.startsWith("/") || nodePath.endsWith("/")) return null;
  if (/^[a-z]:\//iu.test(nodePath)) return null;
  if (nodePath.includes("\\")) return null;
  const segments = nodePath.split("/");
  const encoded: string[] = [];
  for (const segment of segments) {
    if (segment.length === 0 || segment === "." || segment === "..") return null;
    for (const character of segment) {
      const codePoint = character.codePointAt(0);
      if (codePoint === undefined || codePoint <= 0x1f || codePoint === 0x7f) return null;
    }
    try {
      // Parentheses must also be escaped: the source is embedded in a
      // Markdown link and the impact-note parser treats `)` as its end.
      encoded.push(
        encodeURIComponent(segment).replace(/[!'()*]/gu, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`),
      );
    } catch {
      return null;
    }
  }
  return encoded.join("/");
}

/**
 * Exact-commit file link for a cited Context Tree node, or `null` when the
 * forge cannot be identified with confidence.
 *
 * GitHub is recognized by host and always links with `/blob/`; a non-GitHub
 * host only links when it matches the Team's connected GitLab origin
 * (including the SSH-transport vs web-port guard) AND the connection's
 * observed GitLab version selects a known blob route. Everything else stays
 * plain text — a broken link would undermine the one thing a citation can
 * promise: the cited source is inspectable, at the exact version it was read
 * at.
 */
export function contextTreeSourceHref(
  source: ContextTreeSourceRef,
  gitlabInstanceOrigin: string | null,
  gitlabVersion?: string | null,
): string | null {
  if (!EXACT_COMMIT_RE.test(source.commit)) return null;
  if (!contextTreeRepoSchema.safeParse(source.repoUrl).success) return null;
  const identity = canonicalGitRepoIdentity(source.repoUrl);
  if (!identity) return null;
  const path = encodeSourceNodePath(source.nodePath);
  if (!path) return null;
  if (identity.host === "github.com") {
    return `https://github.com/${identity.path}/blob/${source.commit}/${path}`;
  }
  const gitlab = resolveGitLabRepositoryWebIdentity(source.repoUrl, gitlabInstanceOrigin);
  if (!gitlab?.originMatchesConnection || !gitlab.origin.startsWith("https://")) return null;
  const route = gitlabBlobRouteForVersion(gitlabVersion);
  if (!route) return null;
  return `${gitlab.origin}/${gitlab.path}${route}${source.commit}/${path}`;
}
