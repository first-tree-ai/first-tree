import { describe, expect, it } from "vitest";
import { normalizeGithubWebhook } from "../services/scm/github/normalize.js";
import {
  createGithubPollDryRunState,
  type GithubPollCursor,
  type GithubPollFetch,
  GithubPollHttpError,
  type GithubPollResponse,
  githubPollDryRunFromEnvironment,
  isNewerThanCursor,
  parseGithubPollDryRunTargets,
  pollGithubRepository,
  runGithubPollDryRunOnce,
} from "../services/scm/github/poll.js";

const ORGANIZATION_ID = "org_1";
const REPOSITORY = "acme/widgets";
const CURSOR: GithubPollCursor = { updatedAt: "2026-11-17T08:00:00Z", entityNumber: 11 };
const NOW = "2026-11-17T09:00:00Z";

function fetchStub(respond: (url: URL) => { status?: number; body?: unknown; headers?: Record<string, string> }): {
  fetch: GithubPollFetch;
  calls: string[];
} {
  const calls: string[] = [];
  const fetchImpl: GithubPollFetch = async (raw) => {
    calls.push(raw);
    const url = new URL(raw);
    const { status = 200, body = [], headers = {} } = respond(url);
    const response: GithubPollResponse = {
      ok: status >= 200 && status < 300,
      status,
      headers: { get: (name: string) => headers[name.toLowerCase()] ?? null },
      json: async () => body,
    };
    return response;
  };
  return { fetch: fetchImpl, calls };
}

function issueRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 9001,
    number: 12,
    title: "Add widget support",
    body: "Fixes #3",
    html_url: `https://github.com/${REPOSITORY}/pull/12`,
    state: "open",
    draft: false,
    created_at: "2026-11-17T07:00:00Z",
    updated_at: "2026-11-17T08:30:00Z",
    user: { login: "octocat", type: "User" },
    author_association: "OWNER",
    assignees: [],
    pull_request: {
      url: `https://api.github.com/repos/${REPOSITORY}/pulls/12`,
      html_url: `https://github.com/${REPOSITORY}/pull/12`,
      merged_at: null,
    },
    ...overrides,
  };
}

function commentRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 5001,
    body: "Looks good to me",
    html_url: `https://github.com/${REPOSITORY}/pull/12#issuecomment-5001`,
    created_at: "2026-11-17T08:20:00Z",
    user: { login: "reviewer", type: "User" },
    author_association: "CONTRIBUTOR",
    ...overrides,
  };
}

function reviewRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 7001,
    body: "LGTM",
    state: "APPROVED",
    submitted_at: "2026-11-17T08:25:00Z",
    html_url: `https://github.com/${REPOSITORY}/pull/12#pullrequestreview-7001`,
    user: { login: "reviewer", type: "User" },
    author_association: "CONTRIBUTOR",
    ...overrides,
  };
}

describe("github poll cursor", () => {
  it("treats a null cursor as 'start now' and never as 'everything is new'", () => {
    expect(isNewerThanCursor("2026-11-17T08:30:00Z", 12, null)).toBe(false);
  });

  it("orders by updated_at, then by entity number", () => {
    expect(isNewerThanCursor("2026-11-17T08:30:00Z", 1, CURSOR)).toBe(true);
    expect(isNewerThanCursor("2026-11-17T07:59:00Z", 99, CURSOR)).toBe(false);
    expect(isNewerThanCursor(CURSOR.updatedAt, 12, CURSOR)).toBe(true);
    expect(isNewerThanCursor(CURSOR.updatedAt, 11, CURSOR)).toBe(false);
    expect(isNewerThanCursor(CURSOR.updatedAt, 10, CURSOR)).toBe(false);
  });
});

describe("github poll target configuration", () => {
  it("parses, normalizes and de-duplicates org/repo pairs", () => {
    expect(parseGithubPollDryRunTargets(" org_1:Acme/Widgets , org_1:acme/widgets, ,bad-entry,org_2:a/b ")).toEqual([
      { organizationId: "org_1", repository: "acme/widgets" },
      { organizationId: "org_2", repository: "a/b" },
    ]);
  });

  it("drops entries that are not 'org:owner/repo' instead of guessing", () => {
    expect(parseGithubPollDryRunTargets("owner/repo,org:repo,nothing")).toEqual([]);
    expect(parseGithubPollDryRunTargets(undefined)).toEqual([]);
  });

  it("stays disabled until the environment names repositories", () => {
    expect(githubPollDryRunFromEnvironment({})).toBeUndefined();
    expect(githubPollDryRunFromEnvironment({ FIRST_TREE_GITHUB_POLL_DRY_RUN: "org_1:acme/widgets" })).toEqual({
      targets: [{ organizationId: "org_1", repository: "acme/widgets" }],
      token: null,
    });
  });
});

describe("pollGithubRepository", () => {
  it("delivers nothing on the first poll, even if the listing is not empty", async () => {
    const { fetch } = fetchStub(() => ({ body: [issueRow()] }));

    const result = await pollGithubRepository({
      organizationId: ORGANIZATION_ID,
      repository: REPOSITORY,
      cursor: null,
      fetch,
      now: () => new Date(NOW),
    });

    expect(result.webhooks).toEqual([]);
    // The watermark starts at "now" — that is what makes the first poll
    // silent, and what the next poll measures against.
    expect(result.nextCursor).toEqual({ updatedAt: NOW, entityNumber: 0 });
    // The watermark starts at "now", so the request itself asks for nothing
    // older than that — the no-backfill rule is enforced at the query, not by
    // filtering afterwards. One request, no per-entity follow-ups.
    expect(result.requests).toBe(1);
  });

  it("turns a new comment into one event keyed by the GitHub comment id", async () => {
    const { fetch, calls } = fetchStub((url) => {
      if (url.pathname.endsWith("/issues")) return { body: [issueRow()] };
      if (url.pathname.endsWith("/comments")) return { body: [commentRow()] };
      return { body: [] };
    });

    const result = await pollGithubRepository({
      organizationId: ORGANIZATION_ID,
      repository: REPOSITORY,
      cursor: CURSOR,
      fetch,
    });

    expect(result.webhooks).toHaveLength(1);
    expect(result.webhooks[0]).toMatchObject({
      deliveryId: "github:issue_comment:5001",
      eventType: "issue_comment",
      action: "created",
      entityKey: `${REPOSITORY}#12`,
      kind: "commented",
      actor: "reviewer",
    });
    expect(result.nextCursor).toEqual({ updatedAt: "2026-11-17T08:30:00Z", entityNumber: 12 });
    expect(calls.some((url) => new URL(url).searchParams.get("since") === CURSOR.updatedAt)).toBe(true);
  });

  it("produces no duplicate when the same window is polled twice", async () => {
    const { fetch } = fetchStub((url) => {
      if (url.pathname.endsWith("/issues")) return { body: [issueRow()] };
      if (url.pathname.endsWith("/comments")) return { body: [commentRow()] };
      return { body: [] };
    });

    const first = await pollGithubRepository({
      organizationId: ORGANIZATION_ID,
      repository: REPOSITORY,
      cursor: CURSOR,
      fetch,
    });
    const second = await pollGithubRepository({
      organizationId: ORGANIZATION_ID,
      repository: REPOSITORY,
      cursor: first.nextCursor,
      fetch,
    });

    expect(first.webhooks).toHaveLength(1);
    // Same data, later cursor: the entity is no longer newer, so it is never
    // re-synthesized. Duplicate suppression downstream is a second line of
    // defence, not the only one.
    expect(second.webhooks).toEqual([]);
  });

  it("synthesizes `opened` only for entities created after the watermark", async () => {
    const { fetch } = fetchStub((url) => {
      if (url.pathname.endsWith("/issues")) {
        return { body: [issueRow({ created_at: "2026-11-17T08:10:00Z", updated_at: "2026-11-17T08:10:00Z" })] };
      }
      return { body: [] };
    });

    const result = await pollGithubRepository({
      organizationId: ORGANIZATION_ID,
      repository: REPOSITORY,
      cursor: CURSOR,
      fetch,
    });

    expect(result.webhooks.map((webhook) => webhook.deliveryId)).toEqual(["github:issue:9001:opened"]);
    expect(result.webhooks[0]).toMatchObject({
      kind: "opened",
      eventType: "pull_request",
      entityKey: `${REPOSITORY}#12`,
    });
  });

  it("carries submitted reviews as their own event", async () => {
    const { fetch } = fetchStub((url) => {
      if (url.pathname.endsWith("/issues")) return { body: [issueRow()] };
      if (url.pathname.endsWith("/comments")) return { body: [] };
      if (url.pathname.endsWith("/reviews")) return { body: [reviewRow()] };
      return { body: [] };
    });

    const result = await pollGithubRepository({
      organizationId: ORGANIZATION_ID,
      repository: REPOSITORY,
      cursor: CURSOR,
      fetch,
    });

    expect(result.webhooks).toHaveLength(1);
    expect(result.webhooks[0]).toMatchObject({
      deliveryId: "github:pull_request_review:7001",
      eventType: "pull_request_review",
      kind: "reviewed",
      entityKey: `${REPOSITORY}#12`,
      actor: "reviewer",
    });
  });

  it("ignores a pending review that was never submitted", async () => {
    const { fetch } = fetchStub((url) => {
      if (url.pathname.endsWith("/issues")) return { body: [issueRow()] };
      if (url.pathname.endsWith("/reviews")) return { body: [reviewRow({ submitted_at: null })] };
      return { body: [] };
    });

    const result = await pollGithubRepository({
      organizationId: ORGANIZATION_ID,
      repository: REPOSITORY,
      cursor: CURSOR,
      fetch,
    });

    expect(result.webhooks).toEqual([]);
  });

  it("parks at the newest object it read when a resource hits the page cap", async () => {
    const { fetch, calls } = fetchStub((url) => {
      const page = Number(url.searchParams.get("page"));
      if (url.pathname.endsWith("/issues")) return { body: page === 1 ? [issueRow()] : [] };
      if (url.pathname.endsWith("/comments")) {
        // A full page on every allowed page: the listing did not end.
        return { body: [commentRow({ id: 5000 + page, created_at: `2026-11-17T08:2${page}:00Z` })] };
      }
      return { body: [] };
    });

    const result = await pollGithubRepository({
      organizationId: ORGANIZATION_ID,
      repository: REPOSITORY,
      cursor: CURSOR,
      fetch,
      perPage: 1,
      maxPages: 2,
    });

    expect(result.truncated).toBe(true);
    expect(result.webhooks).toHaveLength(2);
    // Not the entity's `updated_at` (08:30): the newest comment actually read
    // (08:22). Parking further would skip the unread tail; parking at the
    // entity would re-read the same two comments forever.
    expect(result.nextCursor).toEqual({ updatedAt: "2026-11-17T08:22:00Z", entityNumber: 0 });

    // The tail is not duplicated on the next pass, and the next pass resumes
    // from what was read rather than from the entity boundary.
    const followUp = await pollGithubRepository({
      organizationId: ORGANIZATION_ID,
      repository: REPOSITORY,
      cursor: result.nextCursor,
      fetch,
      perPage: 1,
      maxPages: 2,
    });
    expect(followUp.webhooks).toEqual([]);
    expect(
      calls.filter((url) => new URL(url).pathname.endsWith("/comments")).at(-1) &&
        new URL(calls.filter((url) => new URL(url).pathname.endsWith("/comments")).at(-1) as string).searchParams.get(
          "since",
        ),
    ).toBe("2026-11-17T08:22:00Z");
  });

  it("surfaces a rate-limit refusal with the time to wait", async () => {
    // Relative to the wall clock, not to the fixture: a reset time in the past
    // legitimately means "retry now", which would make this case time-dependent.
    const reset = String(Math.floor(Date.now() / 1000) + 60);
    const { fetch } = fetchStub(() => ({
      status: 403,
      body: { message: "API rate limit exceeded" },
      headers: { "x-ratelimit-reset": reset },
    }));

    const failure = await pollGithubRepository({
      organizationId: ORGANIZATION_ID,
      repository: REPOSITORY,
      cursor: CURSOR,
      fetch,
    }).catch((thrown: unknown) => thrown);

    expect(failure).toBeInstanceOf(GithubPollHttpError);
    expect((failure as GithubPollHttpError).status).toBe(403);
    expect((failure as GithubPollHttpError).retryAfterMs).toBeGreaterThan(0);
  });

  it("reuses the shared normalizer, so polled and webhook events agree", async () => {
    const comment = commentRow();
    const issue = issueRow();
    const { fetch } = fetchStub((url) => {
      if (url.pathname.endsWith("/issues")) return { body: [issue] };
      if (url.pathname.endsWith("/comments")) return { body: [comment] };
      return { body: [] };
    });

    const polled = await pollGithubRepository({
      organizationId: ORGANIZATION_ID,
      repository: REPOSITORY,
      cursor: CURSOR,
      fetch,
    });
    const fromWebhook = normalizeGithubWebhook(
      "issue_comment",
      {
        action: "created",
        repository: { full_name: REPOSITORY },
        sender: comment.user,
        issue: {
          number: issue.number,
          title: issue.title,
          body: issue.body,
          html_url: issue.html_url,
          state: issue.state,
          draft: issue.draft,
          assignees: issue.assignees,
          author_association: issue.author_association,
          user: issue.user,
          pull_request: issue.pull_request,
        },
        comment: {
          body: comment.body,
          html_url: comment.html_url,
          author_association: comment.author_association,
          user: comment.user,
        },
      },
      {
        provider: "github",
        source: { organizationId: ORGANIZATION_ID, externalId: `poll:${REPOSITORY}` },
        stableDeliveryId: "github:issue_comment:5001",
        ingressAuthority: "verified_signature",
      },
    );

    // The two ingresses differ in exactly the two fields that describe the
    // ingress: the delivery id and the authority. Everything a card, an
    // audience resolver or an entity projection reads must be identical.
    const semantic = (event: NonNullable<typeof fromWebhook.event>) => {
      const { stableDeliveryId: _deliveryId, ingressAuthority: _authority, ...rest } = event;
      return rest;
    };
    expect(semantic(polled.webhooks[0]?.webhook.event as NonNullable<typeof fromWebhook.event>)).toEqual(
      semantic(fromWebhook.event as NonNullable<typeof fromWebhook.event>),
    );
  });
});

describe("runGithubPollDryRunOnce", () => {
  it("counts what it would deliver and keeps its cursor between passes", async () => {
    let phase = 1;
    const { fetch } = fetchStub((url) => {
      if (url.pathname.endsWith("/issues")) {
        return { body: [issueRow(phase === 1 ? {} : { updated_at: "2026-11-17T08:50:00Z" })] };
      }
      if (url.pathname.endsWith("/comments")) {
        return { body: phase === 1 ? [] : [commentRow({ created_at: "2026-11-17T08:45:00Z" })] };
      }
      return { body: [] };
    });
    const state = createGithubPollDryRunState();
    const targets = [
      { organizationId: ORGANIZATION_ID, repository: REPOSITORY },
      { organizationId: ORGANIZATION_ID, repository: "acme/other" },
    ];

    // Pin "now" so the first pass starts its watermark before the fixture
    // times; otherwise the assertion depends on the wall clock.
    const now = () => new Date("2026-11-17T08:05:00Z");
    const first = await runGithubPollDryRunOnce({ targets, state, fetch, now });
    phase = 2;
    const second = await runGithubPollDryRunOnce({ targets, state, fetch, now });
    const third = await runGithubPollDryRunOnce({ targets, state, fetch, now });

    expect(first.repositories).toBe(2);
    // The first pass establishes the watermark; it never backfills history.
    expect(first.wouldDeliver).toBe(0);
    // One new comment per repository once the data actually moved.
    expect(second.wouldDeliver).toBe(2);
    expect(second.failures).toBe(0);
    expect(state.size).toBe(2);
    // The in-memory cursor advanced, so the third pass is quiet.
    expect(third.wouldDeliver).toBe(0);
  });

  it("isolates one failing repository from the rest", async () => {
    const { fetch } = fetchStub((url) => {
      if (url.pathname.includes("acme/broken")) return { status: 404, body: { message: "Not Found" } };
      if (url.pathname.endsWith("/issues")) return { body: [issueRow()] };
      return { body: [] };
    });

    const summary = await runGithubPollDryRunOnce({
      targets: [
        { organizationId: ORGANIZATION_ID, repository: "acme/broken" },
        { organizationId: ORGANIZATION_ID, repository: REPOSITORY },
      ],
      state: createGithubPollDryRunState(),
      fetch,
    });

    expect(summary.failures).toBe(1);
    expect(summary.repositories).toBe(2);
    // The healthy repository was still polled.
    expect(summary.requests).toBeGreaterThan(0);
  });
});
