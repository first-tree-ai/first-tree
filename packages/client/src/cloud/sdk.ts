import {
  type ActiveRuntimeChatIdsResponse,
  AGENT_RUNTIME_SESSION_HEADER,
  AGENT_SELECTOR_HEADER,
  type Agent,
  type AgentContextTreeIoQueryInput,
  type AgentContextTreeIoResponse,
  type AgentRuntimeConfig,
  type AgentVisibility,
  type ArchiveChatResponse,
  ATTACHMENT_FILENAME_HEADER,
  ATTACHMENT_MIME_HEADER,
  agentContextTreeInfoSchema,
  type Chat,
  type ChatDetail,
  type ChatEngagementView,
  type ChatGithubEntityListResponse,
  type ChatGitlabEntityListResponse,
  type ChatParticipantDetail,
  type ClientCapabilities,
  type ConfirmTeamRepositories,
  type ConfirmTeamRepositoriesOutput,
  type ContextActivationRequest,
  type ContextActivationResponse,
  type ContextActivationV2Request,
  type ContextActivationV2Response,
  type ContextReviewSubmitRequest,
  type ContextReviewSubmitResponse,
  type ContextRouteCandidatesRequest,
  type ContextRouteCandidatesResponse,
  type ContextSessionCandidateIssueRequest,
  type ContextSessionCandidateIssueResponse,
  type ContextSessionCandidateValidateRequest,
  type ContextTreeSeedPreflightRequest,
  type ContextTreeSeedPreflightResponse,
  type ContextTreeWritePreflightRequest,
  type ContextTreeWritePreflightResponse,
  type CreateCronJobRequest,
  type CreateDocCommentRequest,
  type CreateTaskChat,
  type CronJob,
  type CronPreviewRequest,
  type CronPreviewResponse,
  chatDetailSchema,
  confirmTeamRepositoriesOutputSchema,
  confirmTeamRepositoriesSchema,
  contextActivationRequestSchema,
  contextActivationV2ResponseSchema,
  contextRouteCandidatesRequestSchema,
  contextRouteCandidatesResponseSchema,
  contextSessionCandidateIssueRequestSchema,
  contextSessionCandidateIssueResponseSchema,
  contextSessionCandidateValidateRequestSchema,
  contextTreeSeedPreflightRequestSchema,
  contextTreeSeedPreflightResponseSchema,
  contextTreeWritePreflightRequestSchema,
  contextTreeWritePreflightResponseSchema,
  type DeleteCronJobResponse,
  type DocComment,
  type DocCommentStatus,
  type DocStatus,
  type DocSummary,
  type DocWithVersion,
  type FollowChatGitlabEntityRequest,
  type FollowChatGitlabEntityResponse,
  type FollowGithubEntityConflict,
  type FollowGithubEntityResponse,
  followGithubEntityConflictSchema,
  type GithubTaskReplyRequest,
  type GithubTaskReplyResponse,
  getAttachmentFilenameError,
  type LegacyContextActivationRequest,
  type LegacyContextActivationResponse,
  type ListCronJobsResponse,
  type ListDocCommentsResponse,
  type ListDocsResponse,
  legacyContextActivationResponseSchema,
  listMeChatsResponseSchema,
  type Message,
  normalizeAttachmentFilename,
  type OrgContextTreeFeaturesOutput,
  type OrgContextTreeFeaturesStorage,
  type OrgContextTreeOutput,
  orgContextTreeFeaturesOutputSchema,
  orgContextTreeOutputSchema,
  type PublishDocRequest,
  type PublishDocResponse,
  type RuntimeProvider,
  type SendMessage,
  type UnfollowChatGitlabEntityResponse,
  type UnfollowGithubEntityResponse,
  type UpdateCronJobRequest,
  type UploadAttachmentResponse,
  uploadAttachmentResponseSchema,
  type WorkspaceChatListResponse,
} from "@first-tree/shared";
import { createLogger } from "./observability/logger.js";

/**
 * Callback that returns the current member access JWT.
 *
 * `minValidityMs` lets the caller declare "I need a token still valid for at
 * least N milliseconds." Implementations should refresh whenever the cached
 * token has less than that much life remaining. Without this hint the WS
 * proactive-refresh path would reuse a cached token that is about to expire
 * and immediately get kicked off with `auth:expired`.
 */
export type AccessTokenProvider = (opts?: { minValidityMs?: number; signal?: AbortSignal }) => string | Promise<string>;
export type RuntimeSessionTokenProvider = () => string | undefined;

export type SdkConfig = {
  serverUrl: string;
  /**
   * Returns the current member access JWT. Callers are expected to refresh
   * the token transparently (e.g. via a background refresher in the command
   * package). The SDK calls this on every request, so short-lived tokens
   * don't need explicit invalidation here.
   */
  getAccessToken: AccessTokenProvider;
  /**
   * Agent UUID this SDK instance acts on. When set, every request carries
   * `X-Agent-Id`; the server's agent-selector middleware translates that to
   * `request.agent`. Omit for admin/member-only calls (/me, /auth/*).
   */
  agentId?: string;
  /**
   * Token or token provider for the current runtime session.
   * Agent-scoped HTTP includes it to prove the request comes from the active
   * runtime owner, not merely from a user JWT that knows `X-Agent-Id`.
   */
  runtimeSessionToken?: string | RuntimeSessionTokenProvider;
  /**
   * Optional `User-Agent` header sent on every request. Without it Node's
   * default `User-Agent: node` lands in trace backends — useless for forensics
   * (issue #246). Construction lives in the caller (typically the `command`
   * package's `CLI_USER_AGENT` constant) so the SDK has no compile-time
   * dependency on a specific CLI version or platform discovery.
   */
  userAgent?: string;
};

export type RegisterResult = {
  agentId: string;
  inboxId: string;
  status: string;
  /**
   * Always populated post-Phase 2 of the agent-naming refactor — the server
   * guarantees `agents.display_name` is non-null (migration 0024 + service
   * default) so the client doesn't need a fallback anymore.
   */
  displayName: string;
  type: string;
  /**
   * Post-merge of `personal_assistant` / `autonomous_agent` (migration 0051)
   * the row-level "personal vs. shared" axis lives in `visibility` instead
   * of `type`. Surfaced to the runtime so CLAUDE.md / AGENTS.md generation
   * can render the personal-assistant vs. autonomous-bot framing without
   * peeking at row metadata via the SDK.
   */
  visibility: AgentVisibility;
  delegateMention: string | null;
  metadata: Record<string, unknown>;
};

export type ContextTreeConfig = {
  provider?: "github" | "gitlab" | null;
  repo: string | null;
  branch: string | null;
};

export type AgentContextTreeConfig = {
  bindingState: "bound" | "unbound" | "invalid";
  provider: "github" | "gitlab" | null;
  repo: string | null;
  branch: string | null;
};

export type ContextReviewRuntimeConfig = AgentContextTreeConfig & {
  contextReviewer: OrgContextTreeFeaturesStorage["contextReviewer"];
};

export type MemberProfile = {
  memberships: Array<{ organizationId: string }>;
  defaultOrganizationId: string | null;
};

export type PaginatedResult<T> = {
  items: T[];
  nextCursor: string | null;
};

const FETCH_TIMEOUT_MS = 15_000;

/**
 * Shorter per-call budget for startup-critical GETs (currently
 * `fetchAgentConfig`). A stalled First Tree server here directly turns into a
 * bind-aborted user-visible failure, and the request is a single-row PK
 * lookup server-side — there's no legitimate reason for it to take longer.
 * Combined with `doFetch`'s 3-attempt retry, this caps the worst-case
 * wall-clock at ≈ 16.5s instead of the global 15s × 3 ≈ 46.5s.
 */
const STARTUP_FETCH_TIMEOUT_MS = 5_000;
const FEISHU_REFERENCE_CONTEXT_TIMEOUT_MS = 6_500;

/**
 * Per-call timeout override knob. Most endpoints stay on `FETCH_TIMEOUT_MS`
 * (15s — generous to survive cold-start / slow PG queries on the long-tail
 * `sendMessage` / `listMessages` paths); startup-critical GETs override
 * with `STARTUP_FETCH_TIMEOUT_MS`.
 */
type SdkCallOptions = { timeoutMs?: number; retry?: boolean; logRetries?: boolean };

/**
 * Node-level error codes (undici / DNS / TCP) treated as transient by the
 * `doFetch` retry layer. The set covers the failure modes that a *brief*
 * network blip can produce mid-request:
 *
 *   - `ECONNRESET`     — TCP RST mid-stream (commonly a keep-alive idle
 *                        connection closed by the peer and reused before we
 *                        noticed)
 *   - `ETIMEDOUT`      — kernel-level connect/read timeout (peer slow, not
 *                        absent)
 *   - `ENETUNREACH`    — transient routing-table flap (local network reload,
 *                        wifi roam)
 *   - `EAI_AGAIN`      — DNS resolver returned a temporary failure; the
 *                        resolver itself tells us to retry
 *   - `UND_ERR_SOCKET` — undici's internal socket-level error, wrapping the
 *                        above when the request happens through its
 *                        connection pool
 *
 * Deliberately **not** retried at this layer:
 *   - `ECONNREFUSED` — peer is reachable but refusing; retrying immediately
 *                      won't fix anything, and the caller's higher-level
 *                      reconnect logic is the right response
 *   - `ENOTFOUND`    — DNS reports the host doesn't exist (typo or rotated
 *                      record); a 1s retry isn't going to materialise the
 *                      record
 *   - other 4xx-class HTTP statuses — handled by the caller, never reach
 *                                     this set
 */
const RETRYABLE_NETWORK_CODES: ReadonlySet<string> = new Set([
  "ECONNRESET",
  "ETIMEDOUT",
  "ENETUNREACH",
  "EAI_AGAIN",
  "UND_ERR_SOCKET",
]);

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Serialize defined options into a query string ("" when nothing is set). */
function buildQuery(options?: Record<string, string | number | undefined>): string {
  if (!options) return "";
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(options)) {
    if (value !== undefined) params.set(key, String(value));
  }
  const qs = params.toString();
  return qs ? `?${qs}` : "";
}

/**
 * Decide whether an error thrown by `fetch()` represents a transient
 * network-layer failure that the caller should retry.
 *
 * Walks the `cause` chain (undici nests the real reason one level deep via
 * `TypeError("fetch failed").cause`) and checks each link for:
 *   - `message` containing `"fetch failed"` (undici's signature)
 *   - `name === "AbortError"` (caller-supplied `AbortController.abort()`)
 *   - `name === "TimeoutError"` (our `AbortSignal.timeout()` — Node 22+ aborts
 *     with a `DOMException("...", "TimeoutError")` per Web spec, NOT an
 *     `AbortError`; missing this signature is why production timeouts went
 *     un-retried until v0.5.x)
 *   - `code` ∈ `RETRYABLE_NETWORK_CODES`
 *
 * `unknown` input is intentional: this function is the gatekeeper for the
 * retry decision in `doFetch`'s catch block, where TS sees `unknown`.
 *
 * Depth is bounded (~5) to defend against the pathological case of a
 * self-referencing cause chain.
 */
function isTransientNetworkError(err: unknown): boolean {
  let current: unknown = err;
  let depth = 0;
  while (current !== null && current !== undefined && depth < 5) {
    if (typeof current !== "object") return false;
    // Narrow `unknown` to a property bag without losing type-safety on the
    // probe sites below. A direct `as` is unavoidable here because the
    // structural shape varies per error library (undici / DNS / our own
    // SdkError), so we cannot derive it from a single typed interface.
    const obj = current as { message?: unknown; name?: unknown; code?: unknown; cause?: unknown };
    if (typeof obj.message === "string" && obj.message.includes("fetch failed")) return true;
    if (obj.name === "AbortError" || obj.name === "TimeoutError") return true;
    if (typeof obj.code === "string" && RETRYABLE_NETWORK_CODES.has(obj.code)) return true;
    current = obj.cause;
    depth++;
  }
  return false;
}

/**
 * Short label used in `doFetch`'s retry-attempt log line. Diagnostic only —
 * not parsed by anything, just collapses the timeout family into one bucket
 * and truncates other error messages so a multi-line `fetch failed` cause
 * doesn't wrap the log.
 */
function classifyRetryReason(err: unknown): string {
  if (!(err instanceof Error)) return "unknown";
  if (err.name === "AbortError" || err.name === "TimeoutError") return "timeout";
  return err.message.slice(0, 60);
}

export class FirstTreeHubSDK {
  private readonly _baseUrl: string;
  private readonly getAccessToken: AccessTokenProvider;
  private readonly _agentId: string | undefined;
  private readonly resolveRuntimeSessionToken: RuntimeSessionTokenProvider;
  private readonly _userAgent: string | undefined;
  private readonly logger = createLogger("sdk");

  constructor(config: SdkConfig) {
    this._baseUrl = config.serverUrl.replace(/\/+$/, "");
    this.getAccessToken = config.getAccessToken;
    this._agentId = config.agentId;
    const runtimeSessionToken = config.runtimeSessionToken;
    this.resolveRuntimeSessionToken =
      typeof runtimeSessionToken === "function" ? runtimeSessionToken : () => runtimeSessionToken;
    this._userAgent = config.userAgent;
  }

  /** Server base URL (without trailing slash). */
  get serverUrl(): string {
    return this._baseUrl;
  }

  /** The agent UUID this SDK is scoped to, if any. */
  get agentId(): string | undefined {
    return this._agentId;
  }

  /** Runtime-session token scoped to the current bind, if any. */
  get runtimeSessionToken(): string | undefined {
    return this.resolveRuntimeSessionToken();
  }

  /** Validate current JWT + X-Agent-Id, return agent identity. */
  async register(): Promise<RegisterResult> {
    const agent = await this.requestJson<Agent>("/api/v1/agent/me");
    return {
      agentId: agent.uuid,
      inboxId: agent.inboxId,
      status: agent.status,
      displayName: agent.displayName,
      type: agent.type,
      visibility: agent.visibility,
      delegateMention: agent.delegateMention ?? null,
      metadata: (agent.metadata as Record<string, unknown>) ?? {},
    };
  }

  /** Fetch Context Tree configuration from the server (public endpoint). */
  async getContextTreeConfig(): Promise<ContextTreeConfig> {
    return this.requestJson<ContextTreeConfig>("/api/v1/context-tree/info");
  }

  async fetchAgentConfig(): Promise<AgentRuntimeConfig> {
    return this.requestJson<AgentRuntimeConfig>("/api/v1/agent/config", undefined, {
      timeoutMs: STARTUP_FETCH_TIMEOUT_MS,
    });
  }

  /**
   * Member-scoped: report this client's runtime-provider capabilities. The
   * server stores them under `clients.metadata.capabilities` after checking
   * that the connected member owns the client.
   */
  async updateCapabilities(clientId: string, capabilities: ClientCapabilities): Promise<void> {
    await this.requestVoid(`/api/v1/clients/${encodeURIComponent(clientId)}/capabilities`, {
      method: "PATCH",
      body: JSON.stringify({ capabilities }),
    });
  }

  /** Obtain this Agent's Bot credential for a local, direct official lark-cli call. */
  async createFeishuCredentialGrant(): Promise<import("@first-tree/shared").FeishuCredentialGrant> {
    return this.requestJson("/api/v1/agent/feishu/credentials", { method: "POST" });
  }

  /** Record and validate an immutable outbound Feishu intent before direct provider delivery. */
  async createFeishuOutboundIntent(
    body: import("@first-tree/shared").FeishuOutboundIntentRequest,
  ): Promise<import("@first-tree/shared").FeishuOutboundIntentResult> {
    return this.requestJson("/api/v1/agent/feishu/intents", {
      method: "POST",
      body: JSON.stringify(body),
    });
  }

  /** Load a bounded, server-authorized provider history window for one inbound Feishu trigger. */
  async getFeishuReferenceContext(
    firstTreeMessageId: string,
  ): Promise<import("@first-tree/shared").FeishuReferenceContext> {
    return this.requestJson(
      `/api/v1/agent/feishu/messages/${encodeURIComponent(firstTreeMessageId)}/reference-context`,
      undefined,
      { timeoutMs: FEISHU_REFERENCE_CONTEXT_TIMEOUT_MS, retry: false, logRetries: false },
    );
  }

  /**
   * Member-scoped: every non-deleted agent pinned to a client owned by the
   * calling user. Includes suspended agents so local reconciliation/prune can
   * preserve their config, workspace, and saved sessions while disabled.
   */
  async listMyAgents(): Promise<
    Array<{ agentId: string; clientId: string; runtimeProvider: RuntimeProvider; status?: string }>
  > {
    return this.requestJson("/api/v1/me/pinned-agents");
  }

  async isHubReachable(timeoutMs = 3_000): Promise<boolean> {
    try {
      const url = `${this._baseUrl}/api/v1/health`;
      // Health is anonymous — can't go through `doFetch` (which calls
      // `getAccessToken`). Stamp UA explicitly so this anonymous probe
      // is grouped with the rest of the install's traffic in trace backends.
      const headers: Record<string, string> = {};
      if (this._userAgent) headers["User-Agent"] = this._userAgent;
      const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs), headers });
      return response.ok;
    } catch {
      return false;
    }
  }

  async sendMessage(chatId: string, data: SendMessage): Promise<Message> {
    return this.requestJson<Message>(`/api/v1/agent/chats/${chatId}/messages`, {
      method: "POST",
      body: JSON.stringify(data),
    });
  }

  async createAgentOutboxToken(chatId: string): Promise<{ accessToken: string; expiresIn: number }> {
    return this.requestJson(`/api/v1/agent/chats/${encodeURIComponent(chatId)}/outbox-token`, {
      method: "POST",
    });
  }

  async createTaskChat(data: CreateTaskChat): Promise<{
    chatId: string;
    messageId: string;
    topic: string | null;
    effectiveSenderId: string;
    initialRecipientAgentIds: string[];
    contextParticipantAgentIds: string[];
  }> {
    return this.requestJson(
      "/api/v1/agent/chats",
      {
        method: "POST",
        body: JSON.stringify(data),
      },
      { retry: false },
    );
  }

  /**
   * Member-scoped, stateless admission check for a clean Context Tree Write.
   * The explicit Team stays in the URL; Server live state supplies the
   * binding and Reviewer. This call creates no task, Chat, PR, or review.
   */
  async preflightMemberContextTreeWrite(
    organizationId: string,
    data: ContextTreeWritePreflightRequest,
    options: { retry?: boolean } = {},
  ): Promise<ContextTreeWritePreflightResponse> {
    const body = contextTreeWritePreflightRequestSchema.parse(data);
    const response = await this.requestJson<unknown>(
      `/api/v1/orgs/${encodeURIComponent(organizationId)}/context-tree/write-preflight`,
      {
        method: "POST",
        body: JSON.stringify(body),
      },
      { retry: options.retry ?? true },
    );
    return contextTreeWritePreflightResponseSchema.parse(response);
  }

  /**
   * Member-scoped, stateless admission check for Context Tree Seed. The
   * Server resolves the explicit Team's current role and binding on every
   * call; this creates no repository, binding, branch, pull request, or Chat.
   */
  async preflightMemberContextTreeSeed(
    organizationId: string,
    data: ContextTreeSeedPreflightRequest,
    options: { retry?: boolean } = {},
  ): Promise<ContextTreeSeedPreflightResponse> {
    const body = contextTreeSeedPreflightRequestSchema.parse(data);
    const response = await this.requestJson<unknown>(
      `/api/v1/orgs/${encodeURIComponent(organizationId)}/context-tree/seed-preflight`,
      {
        method: "POST",
        body: JSON.stringify(body),
      },
      { retry: options.retry ?? true },
    );
    return contextTreeSeedPreflightResponseSchema.parse(response);
  }

  /**
   * Validate one handoff-selected Team and its current Context Tree readiness.
   * The Server does not search other memberships or mint durable authority.
   */
  async validateMemberContextActivation(
    organizationId: string,
    data: ContextActivationV2Request,
    options?: { retry?: boolean; timeoutMs?: number },
  ): Promise<ContextActivationV2Response>;
  async validateMemberContextActivation(
    organizationId: string,
    data: LegacyContextActivationRequest,
    options?: { retry?: boolean; timeoutMs?: number },
  ): Promise<LegacyContextActivationResponse>;
  async validateMemberContextActivation(
    organizationId: string,
    data: ContextActivationRequest,
    options: { retry?: boolean; timeoutMs?: number } = {},
  ): Promise<ContextActivationResponse> {
    const body = contextActivationRequestSchema.parse(data);
    const response = await this.requestJson<unknown>(
      `/api/v1/orgs/${encodeURIComponent(organizationId)}/context-activation/validate`,
      {
        method: "POST",
        body: JSON.stringify(body),
      },
      {
        retry: options.retry ?? false,
        timeoutMs: options.timeoutMs,
      },
    );
    return body.schemaVersion === 2
      ? contextActivationV2ResponseSchema.parse(response)
      : legacyContextActivationResponseSchema.parse(response);
  }

  /** Batch-validate only the locally authorized BYO routing candidates. */
  async validateMemberContextRouteCandidates(
    data: ContextRouteCandidatesRequest,
    options: { retry?: boolean; timeoutMs?: number } = {},
  ): Promise<ContextRouteCandidatesResponse> {
    const body = contextRouteCandidatesRequestSchema.parse(data);
    const response = await this.requestJson<unknown>(
      "/api/v1/me/context-activation/candidates/validate",
      { method: "POST", body: JSON.stringify(body) },
      { retry: options.retry ?? false, timeoutMs: options.timeoutMs },
    );
    return contextRouteCandidatesResponseSchema.parse(response);
  }

  /** Mint a short-lived, server-signed session-only Team candidate. */
  async issueMemberContextSessionCandidate(
    data: ContextSessionCandidateIssueRequest,
    options: { retry?: boolean; timeoutMs?: number } = {},
  ): Promise<ContextSessionCandidateIssueResponse> {
    const body = contextSessionCandidateIssueRequestSchema.parse(data);
    const response = await this.requestJson<unknown>(
      "/api/v1/me/context-activation/session-candidate/issue",
      { method: "POST", body: JSON.stringify(body) },
      { retry: options.retry ?? false, timeoutMs: options.timeoutMs },
    );
    return contextSessionCandidateIssueResponseSchema.parse(response);
  }

  /** Validate one opaque session-only candidate without enumerating memberships. */
  async validateMemberContextSessionCandidate(
    data: ContextSessionCandidateValidateRequest,
    options: { retry?: boolean; timeoutMs?: number } = {},
  ): Promise<ContextRouteCandidatesResponse> {
    const body = contextSessionCandidateValidateRequestSchema.parse(data);
    const response = await this.requestJson<unknown>(
      "/api/v1/me/context-activation/session-candidate/validate",
      { method: "POST", body: JSON.stringify(body) },
      { retry: options.retry ?? false, timeoutMs: options.timeoutMs },
    );
    return contextRouteCandidatesResponseSchema.parse(response);
  }

  /**
   * Atomically register the Admin-confirmed source repository set for one
   * explicit Team. The expected keys prevent a stale setup chat from silently
   * overwriting repository changes made by another Admin.
   */
  async confirmMemberTeamRepositories(
    organizationId: string,
    data: ConfirmTeamRepositories,
  ): Promise<ConfirmTeamRepositoriesOutput> {
    const body = confirmTeamRepositoriesSchema.parse(data);
    const response = await this.requestJson<unknown>(
      `/api/v1/orgs/${encodeURIComponent(organizationId)}/resources/repositories/confirm`,
      {
        method: "POST",
        body: JSON.stringify(body),
      },
      { retry: false },
    );
    return confirmTeamRepositoriesOutputSchema.parse(response);
  }

  /** Read the signed-in member's Team memberships for explicit org selection. */
  async getMemberProfile(): Promise<MemberProfile> {
    const response = await this.requestJson<unknown>("/api/v1/me");
    if (typeof response !== "object" || response === null) {
      throw new SyntaxError("Invalid response from GET /api/v1/me");
    }
    const value = response as { memberships?: unknown; defaultOrganizationId?: unknown };
    if (!Array.isArray(value.memberships)) {
      throw new SyntaxError("Invalid response from GET /api/v1/me: memberships must be an array");
    }
    const memberships = value.memberships;
    if (
      !memberships.every(
        (membership) =>
          typeof membership === "object" &&
          membership !== null &&
          typeof (membership as { organizationId?: unknown }).organizationId === "string",
      )
    ) {
      throw new SyntaxError("Invalid response from GET /api/v1/me: membership organizationId is required");
    }
    if (
      value.defaultOrganizationId !== undefined &&
      value.defaultOrganizationId !== null &&
      typeof value.defaultOrganizationId !== "string"
    ) {
      throw new SyntaxError("Invalid response from GET /api/v1/me: defaultOrganizationId must be a string or null");
    }
    return {
      memberships,
      defaultOrganizationId: value.defaultOrganizationId ?? null,
    };
  }

  /** Member-readable Context Tree binding from the existing generic settings API. */
  async getMemberContextTreeSetting(
    organizationId: string,
    options: { retry?: boolean } = {},
  ): Promise<OrgContextTreeOutput> {
    const response = await this.requestJson<unknown>(
      `/api/v1/orgs/${encodeURIComponent(organizationId)}/settings/context_tree`,
      undefined,
      { retry: options.retry ?? true },
    );
    return orgContextTreeOutputSchema.parse(response);
  }

  /** Member-readable Reviewer assignment from the existing generic settings API. */
  async getMemberContextTreeFeatures(organizationId: string): Promise<OrgContextTreeFeaturesOutput> {
    const response = await this.requestJson<unknown>(
      `/api/v1/orgs/${encodeURIComponent(organizationId)}/settings/context_tree_features`,
    );
    return orgContextTreeFeaturesOutputSchema.parse(response);
  }

  /**
   * Member-JWT Workspace conversation list (`GET /orgs/:orgId/chats`) for one
   * engagement view, optionally restricted to chats where `withAgentId` is a
   * speaker (server-side `with` filter). The response `rows` is the complete
   * additive stream — pinned chats also appear in `rows` — so items are the
   * rows with an `id` alias on `chatId`. Deleted rows are never included.
   * Schema field defaults absorb version skew with older server builds.
   */
  async listWorkspaceChats(
    organizationId: string,
    options: { engagement: ChatEngagementView; withAgentId?: string; limit?: number; cursor?: string },
  ): Promise<WorkspaceChatListResponse> {
    const params = new URLSearchParams();
    params.set("engagement", options.engagement);
    if (options.withAgentId) params.set("with", options.withAgentId);
    if (options.limit !== undefined) params.set("limit", String(options.limit));
    if (options.cursor) params.set("cursor", options.cursor);
    const response = await this.requestJson<unknown>(
      `/api/v1/orgs/${encodeURIComponent(organizationId)}/chats?${params.toString()}`,
    );
    const parsed = listMeChatsResponseSchema.parse(response);
    return {
      items: parsed.rows.map((row) => ({ id: row.chatId, ...row })),
      nextCursor: parsed.nextCursor,
    };
  }

  /**
   * Member-JWT chat detail (`GET /chats/:chatId`). The payload carries the
   * raw chat `metadata` and the caller's own `engagementStatus`
   * (server-defaulted to "active"), which powers the CLI's exact-chat
   * archive preflight.
   */
  async getMemberChatDetail(chatId: string): Promise<ChatDetail> {
    const response = await this.requestJson<unknown>(`/api/v1/chats/${encodeURIComponent(chatId)}`);
    return chatDetailSchema.parse(response);
  }

  async listChats(options?: { limit?: number; cursor?: string }): Promise<PaginatedResult<Chat>> {
    return this.requestJson(`/api/v1/agent/chats${this.queryString(options)}`);
  }

  async listActiveRuntimeChatIds(): Promise<ActiveRuntimeChatIdsResponse> {
    return this.requestJson<ActiveRuntimeChatIdsResponse>("/api/v1/agent/chats/active-runtime-ids");
  }

  /**
   * Archive a chat from the signed-in user's private conversation view.
   * Server authorization requires this SDK's selected agent to be a speaker in
   * the chat, matching the scope returned by `listChats`.
   */
  async archiveChat(chatId: string): Promise<ArchiveChatResponse> {
    return this.requestJson<ArchiveChatResponse>(`/api/v1/agent/chats/${encodeURIComponent(chatId)}/archive`, {
      method: "POST",
    });
  }

  /**
   * Fetch full chat detail (topic + participant membership rows). Used by the
   * runtime bootstrap path to assemble a chat-level identity block injected
   * into CLAUDE.md / AGENTS.md so the agent knows the chat's topic and who
   * else is in the room. Participant rows here lack name/displayName/type —
   * call `listChatParticipants` for that.
   */
  async getChatDetail(chatId: string): Promise<ChatDetail> {
    return this.requestJson<ChatDetail>(`/api/v1/agent/chats/${chatId}`);
  }

  async listMessages(chatId: string, options?: { limit?: number; cursor?: string }): Promise<PaginatedResult<Message>> {
    return this.requestJson(`/api/v1/agent/chats/${chatId}/messages${this.queryString(options)}`);
  }

  /**
   * List participants of a chat with agent names/displayNames — used by the
   * runtime to resolve `@<name>` mentions against the authoritative set.
   */
  async listChatParticipants(chatId: string): Promise<ChatParticipantDetail[]> {
    return this.requestJson<ChatParticipantDetail[]>(`/api/v1/agent/chats/${chatId}/participants`);
  }

  /**
   * Follow a GitHub entity: wire its webhook event stream into the chat.
   *
   * Returns a discriminated result for the structured elsewhere-follow 409 —
   * that body is decision input for the caller, so the CLI relays it with a
   * `--rebind` hint. Every other 409 and non-2xx status throws `SdkError` with
   * the server's original message.
   */
  async followGithubEntity(
    chatId: string,
    body: { entity: string; rebind?: boolean },
  ): Promise<{ ok: true; result: FollowGithubEntityResponse } | { ok: false; conflict: FollowGithubEntityConflict }> {
    const response = await this.doFetch(`/api/v1/agent/chats/${chatId}/github-entities`, {
      method: "POST",
      body: JSON.stringify(body),
    });
    if (response.status === 409) {
      const responseBody = await response.text();
      try {
        const parsed = followGithubEntityConflictSchema.safeParse(JSON.parse(responseBody));
        if (parsed.success) return { ok: false, conflict: parsed.data };
      } catch {
        // A proxy or middleware may return a non-JSON 409. It is not an
        // elsewhere-follow conflict, so preserve the body through the generic
        // SDK error path instead of inventing rebind guidance.
      }
      throw this.sdkErrorFromBody(response, responseBody);
    }
    if (!response.ok) {
      throw await this.toSdkError(response);
    }
    return { ok: true, result: (await response.json()) as FollowGithubEntityResponse };
  }

  /**
   * Unfollow a GitHub entity: sever every line wired into this chat for it.
   * Idempotent — `removed: 0` means the chat wasn't following (success).
   */
  async unfollowGithubEntity(chatId: string, entity: string): Promise<UnfollowGithubEntityResponse> {
    return this.requestJson<UnfollowGithubEntityResponse>(
      `/api/v1/agent/chats/${chatId}/github-entities?entity=${encodeURIComponent(entity)}`,
      { method: "DELETE" },
    );
  }

  /** List the GitHub entities currently wired into a chat. */
  async listChatGithubEntities(chatId: string): Promise<ChatGithubEntityListResponse> {
    return this.requestJson<ChatGithubEntityListResponse>(`/api/v1/agent/chats/${chatId}/github-entities`);
  }

  /** Record a local, pending-capable GitLab Issue/MR declaration without provider egress. */
  async followGitlabEntity(
    chatId: string,
    body: FollowChatGitlabEntityRequest,
  ): Promise<FollowChatGitlabEntityResponse> {
    return this.requestJson<FollowChatGitlabEntityResponse>(`/api/v1/agent/chats/${chatId}/gitlab-entities`, {
      method: "POST",
      body: JSON.stringify(body),
    });
  }

  /** List automatic and manual GitLab bindings for this chat from the local webhook projection. */
  async listChatGitlabEntities(chatId: string): Promise<ChatGitlabEntityListResponse> {
    return this.requestJson<ChatGitlabEntityListResponse>(`/api/v1/agent/chats/${chatId}/gitlab-entities`);
  }

  /** Remove every automatic or manual binding for this entity in this chat. Idempotent. */
  async unfollowGitlabEntity(chatId: string, entityUrl: string): Promise<UnfollowChatGitlabEntityResponse> {
    return this.requestJson<UnfollowChatGitlabEntityResponse>(
      `/api/v1/agent/chats/${chatId}/gitlab-entities?entity=${encodeURIComponent(entityUrl)}`,
      { method: "DELETE" },
    );
  }

  /** Preview a five-field cron schedule without side effects. */
  async previewCronJob(chatId: string, body: CronPreviewRequest): Promise<CronPreviewResponse> {
    return this.requestJson<CronPreviewResponse>(`/api/v1/agent/chats/${chatId}/cron-jobs/preview`, {
      method: "POST",
      body: JSON.stringify(body),
    });
  }

  async listCronJobs(chatId: string): Promise<ListCronJobsResponse> {
    return this.requestJson<ListCronJobsResponse>(`/api/v1/agent/chats/${chatId}/cron-jobs`);
  }

  async createCronJob(chatId: string, body: CreateCronJobRequest): Promise<CronJob> {
    return this.requestJson<CronJob>(`/api/v1/agent/chats/${chatId}/cron-jobs`, {
      method: "POST",
      body: JSON.stringify(body),
    });
  }

  async getCronJob(chatId: string, jobId: string): Promise<CronJob> {
    return this.requestJson<CronJob>(`/api/v1/agent/chats/${chatId}/cron-jobs/${encodeURIComponent(jobId)}`);
  }

  async updateCronJob(chatId: string, jobId: string, body: UpdateCronJobRequest, revision: number): Promise<CronJob> {
    return this.requestJson<CronJob>(
      `/api/v1/agent/chats/${chatId}/cron-jobs/${encodeURIComponent(jobId)}`,
      {
        method: "PATCH",
        body: JSON.stringify(body),
        headers: { "If-Match": String(revision) },
      },
      // Revisioned mutations are not safe to replay after a lost response.
      { retry: false },
    );
  }

  async deleteCronJob(chatId: string, jobId: string, revision: number): Promise<DeleteCronJobResponse> {
    return this.requestJson<DeleteCronJobResponse>(
      `/api/v1/agent/chats/${chatId}/cron-jobs/${encodeURIComponent(jobId)}`,
      {
        method: "DELETE",
        headers: { "If-Match": String(revision) },
      },
      { retry: false },
    );
  }

  /** Submit one server-authored Context Reviewer run for App publication. */
  async submitContextReview(
    chatId: string,
    runId: string,
    body: ContextReviewSubmitRequest,
  ): Promise<ContextReviewSubmitResponse> {
    return this.requestJson<ContextReviewSubmitResponse>(
      `/api/v1/agent/chats/${encodeURIComponent(chatId)}/context-review-runs/${encodeURIComponent(runId)}/submit`,
      { method: "POST", body: JSON.stringify(body) },
      // The server reconciles an unknown GitHub mutation. The client must not
      // replay a possibly committed submission after a transient response.
      { retry: false },
    );
  }

  /** Publish one server-authored, automatically routed GitHub task reply. */
  async submitGithubTaskReply(
    chatId: string,
    runId: string,
    body: GithubTaskReplyRequest,
  ): Promise<GithubTaskReplyResponse> {
    return this.requestJson<GithubTaskReplyResponse>(
      `/api/v1/agent/chats/${encodeURIComponent(chatId)}/github-task-runs/${encodeURIComponent(runId)}/reply`,
      { method: "POST", body: JSON.stringify(body) },
      // An upstream timeout can hide a committed GitHub comment. The server
      // reconciles the hidden run marker; the client never auto-replays.
      { retry: false },
    );
  }

  /**
   * Update chat metadata. Mutable fields are `topic` and/or `description`
   * (pass at least one):
   * - `topic` — the human-readable label rendered by `resolveChatTitle` and
   *   shown in the workspace chat list.
   * - `description` — the chat's Summary: a current-state brief serving both
   *   self-location (agent / teammate) and a human switching between chats.
   *   Rewritten in place from blank on each write, leading with a standalone
   *   line that states the current result and what it means for the reader,
   *   then only the context needed to trust it. May use Markdown. Max 1500
   *   chars, which is a ceiling rather than a target (2–4 short sentences is
   *   the default shape); surfaced to the agent each turn and via `chat list`.
   *   Keep human decisions out of it — those go to `chat ask`. The full
   *   authoring contract lives in the generated agent briefing's "Chat Topic
   *   & Description" section.
   * Pass either field as `null` to clear it (a cleared `topic` makes the title
   * fall back to first-message preview / participant names).
   *
   * `chat update` (CLI) is the user-facing entry point for this; the
   * `set-topic` command is a retained deprecated alias.
   *
   * Auth: caller must count as the chat's owner (server-side `assertOwner`
   * gate) — either the creator, or any worker agent when no agent owner is
   * present in the chat (human-created chats — Web / GitHub-minted — and
   * chats whose creating agent left). A non-owner agent in an agent-created
   * chat whose creator still speaks is refused with 403.
   */
  async updateChat(chatId: string, body: { topic?: string | null; description?: string | null }): Promise<Chat> {
    return this.requestJson<Chat>(`/api/v1/agent/chats/${chatId}`, {
      method: "PATCH",
      body: JSON.stringify(body),
    });
  }

  /**
   * Add a participant to a chat by uuid or by name. Names resolve within the
   * chat's organization. Idempotent: re-adding an existing speaker returns
   * the chat's current participant list (the server treats it as a conflict
   * the caller can safely ignore — see `chat invite` CLI for the
   * UX wrapper that swallows that case).
   */
  async addChatParticipant(
    chatId: string,
    target: { agentId: string } | { agentName: string },
  ): Promise<ChatParticipantDetail[]> {
    return this.requestJson<ChatParticipantDetail[]>(`/api/v1/agent/chats/${chatId}/participants`, {
      method: "POST",
      body: JSON.stringify(target),
    });
  }

  /** Fetch Context Tree configuration for this SDK's authenticated agent. */
  async getAgentContextTreeConfig(): Promise<AgentContextTreeConfig> {
    const info = await this.requestJson<unknown>("/api/v1/agent/context-tree/info");
    const parsed = agentContextTreeInfoSchema.safeParse(info);
    if (!parsed.success) {
      throw new Error("Agent Context Tree info failed the Agent-scoped binding schema");
    }
    return {
      bindingState: parsed.data.bindingState,
      repo: parsed.data.repo,
      branch: parsed.data.branch,
      provider: parsed.data.provider,
    };
  }

  /** Read the live bound Tree plus Reviewer assignment as one runtime tuple. */
  async getAgentContextReviewConfig(): Promise<ContextReviewRuntimeConfig> {
    return this.requestJson<ContextReviewRuntimeConfig>("/api/v1/agent/context-tree/info");
  }

  /**
   * Read this authenticated agent's own durable Context Tree read/write facts.
   *
   * `context_tree_io_events` outlives `session_events`, so a value audit can
   * answer "which nodes did this agent actually open, and when" for historical
   * work without scanning local runtime transcripts.
   */
  async listAgentContextTreeIo(options?: AgentContextTreeIoQueryInput): Promise<AgentContextTreeIoResponse> {
    // Built here rather than through `queryString()`, which serializes only
    // `limit` / `cursor`. Every filter below must reach the server, otherwise
    // a caller that asked for one chat silently receives the whole feed.
    const params = new URLSearchParams();
    if (options?.chatId) params.set("chatId", options.chatId);
    if (options?.action) params.set("action", options.action);
    if (options?.since) params.set("since", options.since);
    if (options?.until) params.set("until", options.until);
    if (options?.limit !== undefined) params.set("limit", String(options.limit));
    if (options?.cursor) params.set("cursor", options.cursor);
    const query = params.toString();
    return this.requestJson<AgentContextTreeIoResponse>(`/api/v1/agent/context-tree/io${query ? `?${query}` : ""}`);
  }

  /**
   * Resolve the organization this SDK's authenticated agent belongs to via
   * `GET /api/v1/agent/me`. Throws a SyntaxError when the payload carries no
   * usable `organizationId`, matching the validation the context-tree binding
   * path has always applied.
   */
  public async getAgentOrganizationId(): Promise<string> {
    const agent = await this.requestJson<unknown>("/api/v1/agent/me", { redirect: "manual" }, { logRetries: false });
    const organizationId =
      typeof agent === "object" &&
      agent !== null &&
      "organizationId" in agent &&
      typeof agent.organizationId === "string"
        ? agent.organizationId
        : undefined;
    if (!organizationId || organizationId.trim() !== organizationId) {
      throw new SyntaxError(
        "Invalid response from GET /api/v1/agent/me: organizationId must be a non-empty, unpadded string",
      );
    }
    return organizationId;
  }

  /** Bind Context Tree configuration for this SDK's authenticated agent organization. */
  public async setAgentContextTreeConfig(input: { repo: string; branch?: string }): Promise<ContextTreeConfig> {
    this.logger.debug(
      { agentId: this._agentId, stage: "resolve_agent_organization" },
      "context tree binding update started",
    );
    const organizationId = await this.getAgentOrganizationId();

    this.logger.debug(
      { agentId: this._agentId, organizationId, stage: "update_org_setting" },
      "context tree binding organization resolved",
    );
    const body = input.branch === undefined ? { repo: input.repo } : { repo: input.repo, branch: input.branch };
    const config = await this.requestJson<ContextTreeConfig>(
      `/api/v1/orgs/${encodeURIComponent(organizationId)}/settings/context_tree`,
      {
        method: "PUT",
        body: JSON.stringify(body),
        redirect: "manual",
      },
      { retry: false },
    );
    this.logger.debug(
      { agentId: this._agentId, organizationId, stage: "complete" },
      "context tree binding update completed",
    );
    return config;
  }

  /**
   * Upload bytes to the server's object-storage primitive. Returns the
   * stored attachment's metadata; the `id` is what upstream consumers
   * (image messages, future bookmarks) reference.
   *
   * `orgId` is required: upload is org-scoped (`uploaded_by` resolves to the
   * caller's member identity in that org), so the org rides in the path.
   * The filename is percent-encoded because it travels in an HTTP header; the
   * Server decodes it before applying the canonical filename validation.
   */
  public async uploadAttachment(opts: {
    bytes: Uint8Array | Buffer;
    mimeType: string;
    filename: string;
    orgId: string;
  }): Promise<UploadAttachmentResponse> {
    const filename = normalizeAttachmentFilename(opts.filename);
    const filenameError = getAttachmentFilenameError(filename);
    if (filenameError) throw new TypeError(filenameError);
    const json = await this.requestJson<unknown>(`/api/v1/orgs/${encodeURIComponent(opts.orgId)}/attachments`, {
      method: "POST",
      body: opts.bytes,
      headers: {
        "Content-Type": "application/octet-stream",
        [ATTACHMENT_MIME_HEADER]: opts.mimeType,
        [ATTACHMENT_FILENAME_HEADER]: encodeURIComponent(filename),
      },
    });
    return uploadAttachmentResponseSchema.parse(json);
  }

  /**
   * Fetch attachment bytes. Download is a capability model — a valid session
   * plus the unguessable id is sufficient; there is no per-attachment ACL.
   */
  public async fetchAttachment(opts: {
    id: string;
  }): Promise<{ bytes: Buffer; mimeType: string; filename: string; size: number }> {
    const response = await this.doFetch(`/api/v1/attachments/${encodeURIComponent(opts.id)}`);
    if (!response.ok) {
      throw await this.toSdkError(response);
    }
    const arrayBuffer = await response.arrayBuffer();
    const bytes = Buffer.from(arrayBuffer);
    return {
      bytes,
      mimeType: response.headers.get("content-type") ?? "application/octet-stream",
      filename: parseContentDispositionFilename(response.headers.get("content-disposition")) ?? "blob",
      size: bytes.byteLength,
    };
  }

  // ── Documents (docloop) — agent self surface, /api/v1/agent/documents ──

  /** Publish a markdown document: creates it on first publish of a slug, appends the next version after. */
  public async publishDoc(body: PublishDocRequest): Promise<PublishDocResponse> {
    // No transport retry: publish is non-idempotent (a lost response +
    // retry would append a duplicate version), same as createTaskChat.
    return this.requestJson<PublishDocResponse>(
      "/api/v1/agent/documents",
      {
        method: "POST",
        body: JSON.stringify(body),
      },
      { retry: false },
    );
  }

  /** List the org's documents. `slug` filter is the slug→id resolution path for the CLI. */
  public async listDocs(options?: {
    slug?: string;
    project?: string;
    status?: DocStatus;
    limit?: number;
    cursor?: string;
  }): Promise<ListDocsResponse> {
    return this.requestJson<ListDocsResponse>(`/api/v1/agent/documents${buildQuery(options)}`);
  }

  /** Read a document with one version's content (latest when `version` is omitted). */
  public async getDoc(docId: string, options?: { version?: number }): Promise<DocWithVersion> {
    return this.requestJson<DocWithVersion>(
      `/api/v1/agent/documents/${encodeURIComponent(docId)}${buildQuery(options)}`,
    );
  }

  public async setDocStatus(docId: string, status: DocStatus): Promise<DocSummary> {
    return this.requestJson<DocSummary>(`/api/v1/agent/documents/${encodeURIComponent(docId)}`, {
      method: "PATCH",
      body: JSON.stringify({ status }),
    });
  }

  public async listDocComments(
    docId: string,
    options?: { status?: DocCommentStatus; versionNumber?: number },
  ): Promise<ListDocCommentsResponse> {
    return this.requestJson<ListDocCommentsResponse>(
      `/api/v1/agent/documents/${encodeURIComponent(docId)}/comments${buildQuery(options)}`,
    );
  }

  public async createDocComment(docId: string, body: CreateDocCommentRequest): Promise<DocComment> {
    // No transport retry: comment creation is non-idempotent (duplicate
    // comments would pollute the review thread).
    return this.requestJson<DocComment>(
      `/api/v1/agent/documents/${encodeURIComponent(docId)}/comments`,
      {
        method: "POST",
        body: JSON.stringify(body),
      },
      { retry: false },
    );
  }

  /** Reply in a comment thread. The comment id alone addresses it — no document id needed. */
  public async replyDocComment(commentId: string, body: string): Promise<DocComment> {
    // No transport retry — same non-idempotency as createDocComment.
    return this.requestJson<DocComment>(
      `/api/v1/agent/document-comments/${encodeURIComponent(commentId)}/replies`,
      {
        method: "POST",
        body: JSON.stringify({ body }),
      },
      { retry: false },
    );
  }

  /** Resolve or reopen a top-level comment (replies follow their thread). */
  public async setDocCommentStatus(commentId: string, status: DocCommentStatus): Promise<DocComment> {
    return this.requestJson<DocComment>(`/api/v1/agent/document-comments/${encodeURIComponent(commentId)}`, {
      method: "PATCH",
      body: JSON.stringify({ status }),
    });
  }

  private queryString(options?: { limit?: number; cursor?: string }): string {
    const params = new URLSearchParams();
    if (options?.limit !== undefined) params.set("limit", String(options.limit));
    if (options?.cursor) params.set("cursor", options.cursor);
    const qs = params.toString();
    return qs ? `?${qs}` : "";
  }

  private async requestVoid(path: string, init?: RequestInit, opts?: SdkCallOptions): Promise<void> {
    const response = await this.doFetch(path, init, opts);
    if (!response.ok) {
      throw await this.toSdkError(response);
    }
  }

  private async requestJson<T>(path: string, init?: RequestInit, opts?: SdkCallOptions): Promise<T> {
    const response = await this.doFetch(path, init, opts);
    if (!response.ok) {
      throw await this.toSdkError(response);
    }
    return (await response.json()) as T;
  }

  /**
   * Retry transient network-layer failures and HTTP 5xx with a fixed backoff
   * schedule. Short-term fix for the chat-visible `Result forward failed:
   * fetch failed` errors (see docs/sdk-fetch-retry-design.md): undici's
   * "fetch failed" / `AbortError` / `TimeoutError` / `ECONNRESET`-class errors
   * and any 5xx response trigger up to two retries with `[0, 500ms, 1000ms]`
   * spacing, adding at most ~1.5s of latency beyond the per-attempt timeout.
   *
   * 4xx responses and non-network exceptions are returned/thrown unchanged
   * — they indicate a deterministic failure that retrying cannot fix.
   *
   * Idempotency caveat: `sendMessage` is not natively idempotent, so any
   * transient signature (`fetch failed`, `AbortError`, `TimeoutError`, …)
   * from a request the server actually committed will produce a duplicate
   * message on retry. The design accepts this for now (small window, low
   * rate, mitigated long-term by an Outbox pattern with client-generated
   * UUIDs).
   *
   * The retry signature and externally-visible behaviour match `doFetch`'s
   * pre-retry contract: callers see the same Response on success or the
   * same error type on terminal failure.
   */
  private async doFetch(path: string, init?: RequestInit, opts?: SdkCallOptions): Promise<Response> {
    const delays = opts?.retry === false ? [0] : [0, 500, 1000];
    let lastErr: unknown;
    for (let attempt = 0; attempt < delays.length; attempt++) {
      const delay = delays[attempt];
      if (delay !== undefined && delay > 0) {
        await sleep(delay);
      }
      try {
        const response = await this.doFetchOnce(path, init, opts);
        const isLastAttempt = attempt === delays.length - 1;
        if (response.status >= 500 && !isLastAttempt) {
          if (opts?.logRetries !== false) {
            this.logger.warn(`retry attempt=${attempt + 1} reason=http-${response.status} path=${path}`);
          }
          lastErr = new Error(`HTTP ${response.status}`);
          continue;
        }
        return response;
      } catch (err) {
        lastErr = err;
        if (!isTransientNetworkError(err)) throw err;
        const isLastAttempt = attempt === delays.length - 1;
        if (!isLastAttempt && opts?.logRetries !== false) {
          this.logger.warn(`retry attempt=${attempt + 1} reason=${classifyRetryReason(err)} path=${path}`);
        }
      }
    }
    throw lastErr;
  }

  private async doFetchOnce(path: string, init?: RequestInit, opts?: SdkCallOptions): Promise<Response> {
    const url = `${this._baseUrl}${path}`;
    const timeout = AbortSignal.timeout(opts?.timeoutMs ?? FETCH_TIMEOUT_MS);
    const signal = init?.signal ? AbortSignal.any([init.signal, timeout]) : timeout;
    signal.throwIfAborted();
    const token = await this.getAccessToken({ signal });
    signal.throwIfAborted();
    const headers: Record<string, string> = {
      Authorization: `Bearer ${token}`,
    };
    if (this._agentId) {
      headers[AGENT_SELECTOR_HEADER] = this._agentId;
      const runtimeSessionToken = this.resolveRuntimeSessionToken();
      if (runtimeSessionToken) {
        headers[AGENT_RUNTIME_SESSION_HEADER] = runtimeSessionToken;
      }
    }
    if (this._userAgent) {
      headers["User-Agent"] = this._userAgent;
    }
    if (init?.body) {
      headers["Content-Type"] = "application/json";
    }
    // Merge caller-supplied headers last so attachment uploads can set
    // Content-Type: application/octet-stream and the X-Attachment-* metadata
    // headers without the default JSON Content-Type clobbering them. No
    // existing SDK call path passes init.headers, so this is backwards
    // compatible.
    if (init?.headers) {
      Object.assign(headers, init.headers as Record<string, string>);
    }
    return fetch(url, { ...init, headers, signal });
  }

  private async toSdkError(response: Response): Promise<SdkError> {
    const body = await response.text();
    return this.sdkErrorFromBody(response, body);
  }

  private sdkErrorFromBody(response: Response, body: string): SdkError {
    let message: string;
    let code: string | undefined;
    try {
      const json = JSON.parse(body) as { error?: string; code?: string };
      message = json.error ?? body;
      code = json.code;
    } catch {
      message = body;
    }
    const retryAfter = response.headers.get("retry-after") ?? undefined;
    return new SdkError(response.status, message, {
      code,
      retryAfter,
      retryAfterMs: parseRetryAfterMs(retryAfter),
    });
  }
}

export class SdkError extends Error {
  constructor(
    public readonly statusCode: number,
    message: string,
    opts: { code?: string; retryAfter?: string; retryAfterMs?: number } = {},
  ) {
    super(message);
    this.name = "SdkError";
    this.code = opts.code;
    this.retryAfter = opts.retryAfter;
    this.retryAfterMs = opts.retryAfterMs;
  }

  public readonly retryAfter?: string;
  public readonly retryAfterMs?: number;
  public readonly code?: string;
}

function parseRetryAfterMs(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.floor(seconds * 1000);
  const dateMs = Date.parse(value);
  if (!Number.isFinite(dateMs)) return undefined;
  return Math.max(0, dateMs - Date.now());
}

/**
 * Parse the percent-encoded `filename="..."` directive from a
 * `Content-Disposition` header. Returns `null` when the header is absent or
 * has no filename. The server encodes the complete filename for an
 * ASCII-only wire value; the unquoted / RFC 5987 `filename*` forms are
 * outside our wire contract.
 */
function parseContentDispositionFilename(header: string | null): string | null {
  if (!header) return null;
  const match = /filename="([^"]*)"/.exec(header);
  if (!match || !match[1]) return null;
  // Reverse the server's complete percent-encoding so callers get the stored
  // filename. decodeURIComponent throws on malformed sequences; fall back to
  // the raw match in that case.
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return match[1];
  }
}
