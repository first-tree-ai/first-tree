import type { ScmIngressContext } from "@first-tree/shared";
import { isRecord } from "../../../api/webhooks/github-entity.js";
import { createLogger } from "../../../observability/index.js";
import { GITHUB_API_BASE } from "./api-base.js";
import { type NormalizedGithubWebhook, normalizeGithubWebhook } from "./normalize.js";

const log = createLogger("GithubPoll");

/** GitHub caps every list endpoint at 100 items per page. */
const DEFAULT_PER_PAGE = 100;
/**
 * Requests allowed per resource per poll. A busy repository can otherwise push
 * one poll past the credential's hourly budget, and a poll that dies halfway
 * must not advance the watermark past what it read.
 */
const DEFAULT_MAX_PAGES = 5;

function readString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function readNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

type CommentPosition = { createdAt: string; id: number };

/** Did `candidate` come after `current` in the comment listing's order? */
function isAfterPosition(current: CommentPosition, candidate: CommentPosition): boolean {
  if (candidate.createdAt !== current.createdAt) return candidate.createdAt > current.createdAt;
  return candidate.id > current.id;
}

function laterPosition(current: CommentPosition | null, candidate: CommentPosition): CommentPosition {
  if (current === null) return candidate;
  return isAfterPosition(current, candidate) ? candidate : current;
}

/**
 * One second earlier, in GitHub's whole-second format.
 *
 * `since` on issue comments filters `updated_at`, not `created_at`, and the
 * comparison is strict. Asking from the position's own second would therefore
 * hide comments created in that same second, so the request starts a second
 * early and the position filter removes what was already read.
 */
function oneSecondEarlier(timestamp: string): string {
  const parsed = Date.parse(timestamp);
  if (Number.isNaN(parsed)) return timestamp;
  return githubTimestamp(new Date(parsed - 1_000));
}

/**
 * GitHub timestamps carry no fractional seconds, and the cursor is compared
 * lexicographically against them. `Date#toISOString` does carry milliseconds,
 * so a watermark taken from the clock is normalized to the provider's format —
 * `…00.000Z` sorts *before* `…00Z` as a string, which would silently make the
 * cursor older than the second it was taken in.
 */
function githubTimestamp(date: Date): string {
  return date.toISOString().replace(/\.\d{3}Z$/, "Z");
}

/**
 * How far the poller has read in one repository.
 *
 * `updatedAt` is GitHub's `updated_at` and `entityNumber` is the issue/PR
 * number, so the pair is a total order over the listing the poller walks
 * (`sort=updated&direction=asc`). GitHub never emits fractional seconds or
 * offsets in these timestamps, so they compare correctly as strings — the
 * cursor is always a value we stored ourselves, never caller-supplied.
 */
export type GithubPollCursor = {
  updatedAt: string;
  entityNumber: number;
  /**
   * Resume point for one entity whose comment and review streams were only
   * partly read.
   *
   * One record is enough because the poll stops at the first partially read
   * entity and the repository watermark advances only once both of its streams
   * are drained. A single timestamp for both streams — the first version —
   * let a newer review move the watermark past comments nobody had read.
   */
  continuation?: GithubPollContinuation | null;
};

export type GithubPollContinuation = {
  entityNumber: number;
  /** True once the comment stream reached its end; a finished stream is not refetched. */
  commentsDone: boolean;
  /**
   * Last comment read, as `(created_at, id)`.
   *
   * A timestamp alone is not a position: the endpoint's `since` filters on
   * `updated_at`, and a page can end in the middle of a group of comments that
   * share a `created_at`, so resuming with the bare timestamp either drops the
   * rest of the group or re-reads it forever.
   */
  commentPosition: { createdAt: string; id: number } | null;
  /** True once the review stream reached its end. */
  reviewsDone: boolean;
  /** 1-based review-list page to request next. */
  reviewsPage: number;
};

/**
 * One entry of `GET /repos/{owner}/{repo}/issues?sort=updated`.
 *
 * Anything at or before the cursor was already handled by the previous poll, so
 * it is skipped. A `null` cursor means "start now" — the first poll establishes
 * the watermark and delivers nothing, because backfilling a repository's whole
 * history into a chat is a product decision nobody asked for.
 */
export function isNewerThanCursor(updatedAt: string, entityNumber: number, cursor: GithubPollCursor | null): boolean {
  if (cursor === null) return false;
  if (updatedAt > cursor.updatedAt) return true;
  if (updatedAt < cursor.updatedAt) return false;
  return entityNumber > cursor.entityNumber;
}

/** Narrow seam over `fetch` so tests can drive the poller without a network. */
export type GithubPollResponse = {
  ok: boolean;
  status: number;
  headers: { get(name: string): string | null };
  json(): Promise<unknown>;
};

export type GithubPollFetch = (url: string, init: { headers: Record<string, string> }) => Promise<GithubPollResponse>;

export class GithubPollHttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly retryAfterMs: number | null = null,
  ) {
    super(message);
    this.name = "GithubPollHttpError";
  }
}

function retryAfterMs(headers: GithubPollResponse["headers"]): number | null {
  const retryAfter = headers.get("retry-after");
  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds) && seconds >= 0) return Math.ceil(seconds * 1_000);
  }
  const reset = headers.get("x-ratelimit-reset");
  if (reset) {
    const epochSeconds = Number(reset);
    if (Number.isFinite(epochSeconds)) {
      const delta = epochSeconds * 1_000 - Date.now();
      // A reset in the past means "retry now", not "retry 20 years ago".
      if (delta > 0) return Math.ceil(delta);
    }
  }
  return null;
}

type FetchPagesContext = {
  fetch: GithubPollFetch;
  apiBase: string;
  token: string | null;
  perPage: number;
  maxPages: number;
};

type FetchedPages = {
  items: Record<string, unknown>[];
  requests: number;
  /** The page cap was reached before the listing ended. */
  truncated: boolean;
  /** Page to resume at when `truncated`; ignored otherwise. */
  nextPage: number;
};

function requestHeaders(token: string | null): Record<string, string> {
  const headers: Record<string, string> = {
    accept: "application/vnd.github+json",
    "x-github-api-version": "2022-11-28",
    "user-agent": "first-tree",
  };
  if (token) headers.authorization = `Bearer ${token}`;
  return headers;
}

async function fetchPages(
  ctx: FetchPagesContext,
  path: string,
  query: Record<string, string>,
  startPage = 1,
): Promise<FetchedPages> {
  const items: Record<string, unknown>[] = [];
  let requests = 0;
  const lastPage = startPage + ctx.maxPages - 1;
  for (let page = startPage; page <= lastPage; page++) {
    const search = new URLSearchParams({ ...query, per_page: String(ctx.perPage), page: String(page) });
    const url = `${ctx.apiBase}${path}?${search.toString()}`;
    const response = await ctx.fetch(url, { headers: requestHeaders(ctx.token) });
    requests += 1;
    if (!response.ok) {
      throw new GithubPollHttpError(
        response.status,
        `GitHub responded ${response.status} for ${path}`,
        retryAfterMs(response.headers),
      );
    }
    const body = await response.json();
    if (!Array.isArray(body)) {
      throw new GithubPollHttpError(response.status, `GitHub returned a non-array body for ${path}`);
    }
    const pageItems = body.filter(isRecord);
    items.push(...pageItems);
    if (pageItems.length < ctx.perPage) return { items, requests, truncated: false, nextPage: page };
  }
  return { items, requests, truncated: true, nextPage: lastPage + 1 };
}

/**
 * GitHub's delivery ids for webhooks are UUIDs from `x-github-delivery`, so a
 * namespaced prefix cannot collide with one. Deriving the id from the GitHub
 * object id (not from "the Nth poll") is what makes two replicas — or two
 * polls that overlap — collapse into one delivered event via
 * `processed_events`.
 */
function openedDeliveryId(objectId: number | null, repository: string, number: number): string {
  return `github:issue:${objectId ?? `${repository}#${number}`}:opened`;
}

function commentDeliveryId(commentId: number | null): string | null {
  return commentId === null ? null : `github:issue_comment:${commentId}`;
}

function reviewDeliveryId(reviewId: number | null): string | null {
  return reviewId === null ? null : `github:pull_request_review:${reviewId}`;
}

function repoBlock(repository: string): Record<string, unknown> {
  return { full_name: repository };
}

/** Descriptor of the entity a listing row refers to, in webhook shape. */
function issueBlock(item: Record<string, unknown>, isPullRequest: boolean): Record<string, unknown> {
  const pullRequest = isRecord(item.pull_request) ? item.pull_request : {};
  return {
    number: item.number,
    title: item.title,
    body: item.body,
    html_url: item.html_url,
    state: item.state,
    draft: item.draft,
    assignees: item.assignees,
    author_association: item.author_association,
    user: item.user,
    ...(isPullRequest ? { pull_request: pullRequest } : {}),
  };
}

/**
 * REST → webhook payload, for the three things REST can prove are new.
 *
 * The poller does not carry a second event vocabulary: it rebuilds the payload
 * the webhook would have carried and hands it to the same pure normalizer, so
 * mention extraction, surface titles, entity keys and involve reasons cannot
 * drift between the two ingresses.
 */
function openedPayload(
  repository: string,
  item: Record<string, unknown>,
  isPullRequest: boolean,
): Record<string, unknown> {
  const pr = isRecord(item.pull_request) ? item.pull_request : {};
  return {
    action: "opened",
    repository: repoBlock(repository),
    sender: item.user,
    ...(isPullRequest
      ? {
          pull_request: {
            ...issueBlock(item, true),
            merged: readString(pr.merged_at) !== null,
            requested_reviewers: item.requested_reviewers,
          },
        }
      : { issue: issueBlock(item, false) }),
  };
}

function commentPayload(
  repository: string,
  item: Record<string, unknown>,
  comment: Record<string, unknown>,
  isPullRequest: boolean,
): Record<string, unknown> {
  return {
    action: "created",
    repository: repoBlock(repository),
    sender: comment.user,
    issue: issueBlock(item, isPullRequest),
    comment: {
      body: comment.body,
      html_url: comment.html_url,
      author_association: comment.author_association,
      user: comment.user,
    },
  };
}

function reviewPayload(
  repository: string,
  item: Record<string, unknown>,
  review: Record<string, unknown>,
): Record<string, unknown> {
  const pr = isRecord(item.pull_request) ? item.pull_request : {};
  return {
    action: "submitted",
    repository: repoBlock(repository),
    sender: review.user,
    // `buildPullRequestReviewRule` reads `pull_request.merged` for the state
    // seed; `merged_at` on the issues listing is the only signal REST gives us.
    pull_request: {
      ...issueBlock(item, true),
      merged: readString(pr.merged_at) !== null,
    },
    review: {
      body: review.body,
      state: review.state,
      html_url: review.html_url,
      author_association: review.author_association,
      user: review.user,
    },
  };
}

export type PolledGithubWebhook = {
  deliveryId: string;
  eventType: string;
  action: string | null;
  entityKey: string | null;
  kind: string | null;
  actor: string | null;
  webhook: NormalizedGithubWebhook;
};

export type PollGithubRepositoryInput = {
  organizationId: string;
  /** `owner/repo`, already normalized. */
  repository: string;
  cursor: GithubPollCursor | null;
  fetch: GithubPollFetch;
  /** Classic/user token when the repository is not App-installed; `null` reads anonymously. */
  token?: string | null;
  apiBase?: string;
  now?: () => Date;
  perPage?: number;
  maxPages?: number;
};

export type PollGithubRepositoryResult = {
  requests: number;
  /** Events the poller would hand to the processing kernel, oldest first. */
  webhooks: PolledGithubWebhook[];
  /** Listings that carried a change the normalizer deliberately drops. */
  dropped: number;
  nextCursor: GithubPollCursor | null;
  truncated: boolean;
};

/**
 * Read one repository once, oldest change first, and stop at the first resource
 * that hit the page cap.
 *
 * The watermark only advances past an entity once that entity's comments and
 * reviews were read to the end: re-reading is free (ids dedupe), skipping is
 * not. Truncation therefore parks the cursor before the affected entity instead
 * of stepping over it.
 */
export async function pollGithubRepository(input: PollGithubRepositoryInput): Promise<PollGithubRepositoryResult> {
  const ctx: FetchPagesContext = {
    fetch: input.fetch,
    apiBase: input.apiBase ?? GITHUB_API_BASE,
    token: input.token ?? null,
    perPage: input.perPage ?? DEFAULT_PER_PAGE,
    maxPages: input.maxPages ?? DEFAULT_MAX_PAGES,
  };
  const now = input.now ?? (() => new Date());
  const since = input.cursor?.updatedAt ?? githubTimestamp(now());
  const ingressFor = (deliveryId: string): ScmIngressContext => ({
    provider: "github",
    source: { organizationId: input.organizationId, externalId: `poll:${input.repository}` },
    stableDeliveryId: deliveryId,
    ingressAuthority: "server_observed",
  });

  const webhooks: PolledGithubWebhook[] = [];
  let dropped = 0;
  let requests = 0;

  const record = (deliveryId: string, eventType: string, payload: Record<string, unknown>): void => {
    const webhook = normalizeGithubWebhook(eventType, payload, ingressFor(deliveryId));
    if (webhook.event === null) {
      // The listing changed, but the shared normalizer drops this shape on
      // purpose (PR state transitions, content-less payloads, …). Counting it
      // keeps the dry run honest about coverage instead of silently reporting
      // "nothing happened".
      dropped += 1;
      return;
    }
    webhooks.push({
      deliveryId,
      eventType,
      action: webhook.event.action,
      entityKey: webhook.event.entity.key,
      kind: webhook.event.kind,
      actor: webhook.event.actor.externalUsername,
      webhook,
    });
  };

  const listing = await fetchPages(ctx, `/repos/${input.repository}/issues`, {
    state: "all",
    sort: "updated",
    direction: "asc",
    since,
  });
  requests += listing.requests;
  let truncated = listing.truncated;

  const changed = listing.items
    .map((item) => ({
      item,
      number: readNumber(item.number),
      updatedAt: readString(item.updated_at),
    }))
    .filter((entry): entry is { item: Record<string, unknown>; number: number; updatedAt: string } => {
      if (entry.number === null || entry.updatedAt === null) return false;
      return isNewerThanCursor(entry.updatedAt, entry.number, input.cursor);
    })
    .sort((a, b) => (a.updatedAt === b.updatedAt ? a.number - b.number : a.updatedAt < b.updatedAt ? -1 : 1));

  let nextCursor = input.cursor;

  // A first poll has no cursor yet, and `isNewerThanCursor` deliberately says
  // "nothing is new" for `null` so history is never backfilled. The watermark
  // still has to start somewhere: without this line the cursor would stay null
  // forever and the poller would never deliver anything.
  if (nextCursor === null) nextCursor = { updatedAt: since, entityNumber: 0 };

  const continuationFor = (entityNumber: number): GithubPollContinuation | null => {
    const stored = input.cursor?.continuation ?? null;
    return stored !== null && stored.entityNumber === entityNumber ? stored : null;
  };

  for (const { item, number, updatedAt } of changed) {
    const isPullRequest = isRecord(item.pull_request);
    const createdAt = readString(item.created_at);
    const continuation = continuationFor(number);

    // `opened` is emitted once. A resumed entity already had its creation
    // announced in the pass that capped out, and re-emitting it would only
    // rely on downstream dedupe to hide the repeat.
    if (continuation === null && createdAt !== null && createdAt > since) {
      record(
        openedDeliveryId(readNumber(item.id), input.repository, number),
        isPullRequest ? "pull_request" : "issues",
        openedPayload(input.repository, item, isPullRequest),
      );
    }

    // Each stream resumes on its own axis and remembers whether it finished:
    // comments by `(created_at, id)` position (the endpoint filters `since` on
    // `updated_at`, so a bare timestamp loses same-second ties), reviews by
    // page. A stream that reached its end is not requested again.
    let commentsDone = continuation?.commentsDone ?? false;
    let commentPosition: CommentPosition | null = continuation?.commentPosition ?? null;
    let reviewsDone = continuation?.reviewsDone ?? !isPullRequest;
    let reviewsPage = continuation?.reviewsPage ?? 1;

    if (!commentsDone) {
      const comments = await fetchPages(ctx, `/repos/${input.repository}/issues/${number}/comments`, {
        since: commentPosition === null ? since : oneSecondEarlier(commentPosition.createdAt),
        sort: "created",
        direction: "asc",
      });
      requests += comments.requests;
      for (const comment of comments.items) {
        const createdAtComment = readString(comment.created_at);
        const commentId = readNumber(comment.id);
        const deliveryId = commentDeliveryId(commentId);
        if (createdAtComment === null || commentId === null || deliveryId === null) continue;
        const position = { createdAt: createdAtComment, id: commentId };
        const isNew = commentPosition === null ? createdAtComment > since : isAfterPosition(commentPosition, position);
        commentPosition = laterPosition(commentPosition, position);
        if (!isNew) continue;
        record(deliveryId, "issue_comment", commentPayload(input.repository, item, comment, isPullRequest));
      }
      commentsDone = !comments.truncated;
    }

    if (!reviewsDone) {
      const reviews = await fetchPages(ctx, `/repos/${input.repository}/pulls/${number}/reviews`, {}, reviewsPage);
      requests += reviews.requests;
      reviewsDone = !reviews.truncated;
      reviewsPage = reviews.truncated ? reviews.nextPage : reviewsPage;
      for (const review of reviews.items) {
        const submittedAt = readString(review.submitted_at);
        const deliveryId = reviewDeliveryId(readNumber(review.id));
        // A pending review has no `submitted_at`; it becomes deliverable only
        // once GitHub stamps the submission.
        if (submittedAt === null || deliveryId === null) continue;
        if (submittedAt <= since) continue;
        record(deliveryId, "pull_request_review", reviewPayload(input.repository, item, review));
      }
    }

    if (!commentsDone || !reviewsDone) {
      // At least one stream is still open: keep the repository watermark where
      // it is and remember exactly how far each one got.
      truncated = true;
      return {
        requests,
        webhooks,
        dropped,
        nextCursor: {
          ...(nextCursor ?? { updatedAt: since, entityNumber: 0 }),
          continuation: {
            entityNumber: number,
            commentsDone,
            commentPosition,
            reviewsDone,
            reviewsPage,
          },
        },
        truncated: true,
      };
    }

    // Both streams drained: this entity is fully read, and only now does the
    // repository watermark move past it.
    nextCursor = { updatedAt, entityNumber: number, continuation: null };
  }

  return { requests, webhooks, dropped, nextCursor, truncated };
}

export type GithubPollTarget = {
  organizationId: string;
  /** `owner/repo`, lower-cased. */
  repository: string;
};

/**
 * `orgId:owner/repo,orgId:owner/repo` → targets.
 *
 * Malformed entries are dropped rather than guessed: a typo that silently polls
 * the wrong repository is worse than a dry run that does nothing. Entries are
 * de-duplicated because the same repository can be followed from several chats.
 */
export function parseGithubPollDryRunTargets(raw: string | null | undefined): GithubPollTarget[] {
  if (!raw) return [];
  const seen = new Set<string>();
  const targets: GithubPollTarget[] = [];
  for (const entry of raw.split(",")) {
    const trimmed = entry.trim();
    if (!trimmed) continue;
    const separator = trimmed.indexOf(":");
    if (separator <= 0) continue;
    const organizationId = trimmed.slice(0, separator).trim();
    const repository = trimmed
      .slice(separator + 1)
      .trim()
      .toLowerCase();
    if (!organizationId || !repository.includes("/")) continue;
    const key = `${organizationId}\u0000${repository}`;
    if (seen.has(key)) continue;
    seen.add(key);
    targets.push({ organizationId, repository });
  }
  return targets;
}

/**
 * Dry-run wiring: repositories to observe on an interval, nothing else.
 *
 * There is deliberately no target store yet — the dry run is an operator-facing
 * experiment, and deriving targets from `github_entity_chat_mappings` belongs
 * with the cursor table in the delivery phase, where "which repos does this org
 * follow" is a real query rather than a config string.
 */
export type GithubPollDryRunOptions = {
  targets: GithubPollTarget[];
  token?: string | null;
  intervalMs?: number;
  /** Test seam; production polls with the global `fetch`. */
  fetch?: GithubPollFetch;
};

export const GITHUB_POLL_DRY_RUN_DEFAULT_INTERVAL_MS = 5 * 60_000;
/** Below this, a mistyped interval turns into a rate-limit incident. */
export const GITHUB_POLL_DRY_RUN_MIN_INTERVAL_MS = 30_000;

/**
 * `FIRST_TREE_GITHUB_POLL_DRY_RUN=orgId:owner/repo,…` enables the experiment;
 * `FIRST_TREE_GITHUB_POLL_DRY_RUN_TOKEN` supplies the read credential (the
 * anonymous 60 requests/hour is enough for one or two repositories).
 */
export function githubPollDryRunFromEnvironment(
  env: Record<string, string | undefined> = process.env,
): GithubPollDryRunOptions | undefined {
  const targets = parseGithubPollDryRunTargets(env.FIRST_TREE_GITHUB_POLL_DRY_RUN);
  if (targets.length === 0) return undefined;
  const rawInterval = Number(env.FIRST_TREE_GITHUB_POLL_DRY_RUN_INTERVAL_MS);
  const intervalMs = Number.isFinite(rawInterval) && rawInterval > 0 ? rawInterval : undefined;
  return {
    targets,
    token: env.FIRST_TREE_GITHUB_POLL_DRY_RUN_TOKEN ?? null,
    ...(intervalMs === undefined ? {} : { intervalMs }),
  };
}

/** In-memory cursor per repository. P1 dry run only; the table lands with P1b. */
export type GithubPollDryRunState = Map<string, GithubPollCursor>;

export function createGithubPollDryRunState(): GithubPollDryRunState {
  return new Map();
}

function dryRunStateKey(target: GithubPollTarget): string {
  return `${target.organizationId}\u0000${target.repository}`;
}

export type GithubPollDryRunSummary = {
  repositories: number;
  requests: number;
  wouldDeliver: number;
  dropped: number;
  failures: number;
  truncated: number;
};

/**
 * One dry-run pass. Nothing is delivered: every event that the processing
 * kernel would have received is logged instead, so the experiment can compare
 * what REST reconstructs against the webhooks the same repository already
 * delivers.
 */
export async function runGithubPollDryRunOnce(options: {
  targets: GithubPollTarget[];
  state: GithubPollDryRunState;
  fetch: GithubPollFetch;
  token?: string | null;
  apiBase?: string;
  now?: () => Date;
}): Promise<GithubPollDryRunSummary> {
  const summary: GithubPollDryRunSummary = {
    repositories: options.targets.length,
    requests: 0,
    wouldDeliver: 0,
    dropped: 0,
    failures: 0,
    truncated: 0,
  };
  if (options.targets.length === 0) {
    log.info("github poll dry run: no targets configured");
    return summary;
  }

  for (const target of options.targets) {
    try {
      const result = await pollGithubRepository({
        organizationId: target.organizationId,
        repository: target.repository,
        cursor: options.state.get(dryRunStateKey(target)) ?? null,
        fetch: options.fetch,
        token: options.token ?? null,
        apiBase: options.apiBase,
        now: options.now,
      });
      if (result.nextCursor !== null) options.state.set(dryRunStateKey(target), result.nextCursor);
      summary.requests += result.requests;
      summary.wouldDeliver += result.webhooks.length;
      summary.dropped += result.dropped;
      if (result.truncated) summary.truncated += 1;
      log.info(
        {
          repository: target.repository,
          requests: result.requests,
          wouldDeliver: result.webhooks.length,
          dropped: result.dropped,
          truncated: result.truncated,
          cursor: result.nextCursor,
        },
        "github poll dry run: repository polled",
      );
      for (const webhook of result.webhooks) {
        log.info(
          {
            repository: target.repository,
            deliveryId: webhook.deliveryId,
            eventType: webhook.eventType,
            action: webhook.action,
            kind: webhook.kind,
            entityKey: webhook.entityKey,
            actor: webhook.actor,
          },
          "github poll dry run: would deliver",
        );
      }
    } catch (err) {
      summary.failures += 1;
      log.warn(
        {
          repository: target.repository,
          status: err instanceof GithubPollHttpError ? err.status : undefined,
          retryAfterMs: err instanceof GithubPollHttpError ? err.retryAfterMs : undefined,
          err,
        },
        "github poll dry run: poll failed",
      );
    }
  }
  return summary;
}
