import { z } from "zod";
import { resolveContextTreeProvider } from "../canonical-git-repo-url.js";
import { agentTemplateIdsSchema } from "./agent-template.js";
import { paginationQuerySchema } from "./common.js";
import { contextTreeActiveBindingSchema, contextTreeBranchSchema, contextTreeProviderSchema } from "./org-settings.js";
import { presenceStatusSchema, runtimeStateSchema } from "./presence.js";
import { isRuntimeProviderEnabled, runtimeProviderSchema } from "./runtime-provider.js";

export const AGENT_TYPES = {
  HUMAN: "human",
  AGENT: "agent",
} as const;

export const agentTypeSchema = z.enum(["human", "agent"]);
export type AgentType = z.infer<typeof agentTypeSchema>;

export const AGENT_VISIBILITY = {
  PRIVATE: "private",
  ORGANIZATION: "organization",
} as const;

export const agentVisibilitySchema = z.enum(["private", "organization"]);
export type AgentVisibility = z.infer<typeof agentVisibilitySchema>;

/**
 * Manager-selected avatar color. Each token references the matching
 * `--avatar-hue-*` CSS variable in the web client. `null` (the default
 * row state and the sentinel for "clear") means "auto" — the renderer
 * falls back to the deterministic djb2 hash of the agent's uuid.
 */
export const AVATAR_COLOR_TOKENS = ["hue-0", "hue-1", "hue-2", "hue-3", "hue-4", "hue-5", "hue-6", "hue-7"] as const;
export const avatarColorTokenSchema = z.enum(AVATAR_COLOR_TOKENS);
export type AvatarColorToken = z.infer<typeof avatarColorTokenSchema>;

export const AGENT_STATUSES = {
  ACTIVE: "active",
  SUSPENDED: "suspended",
  DELETED: "deleted",
} as const;

export const AGENT_SOURCES = {
  ADMIN_API: "admin-api",
  PORTAL: "portal",
} as const;

export const agentSourceSchema = z.enum(["admin-api", "portal"]);
export type AgentSource = z.infer<typeof agentSourceSchema>;

export const agentStatusSchema = z.enum(["active", "suspended"]);
export type AgentStatus = z.infer<typeof agentStatusSchema>;

export const RESERVED_AGENT_METADATA_KEYS = ["runtimeSwitch", "runtimeSession"] as const;

const reservedAgentMetadataKeySet: ReadonlySet<string> = new Set(RESERVED_AGENT_METADATA_KEYS);

export function findReservedAgentMetadataKey(metadata: Record<string, unknown> | undefined): string | null {
  if (!metadata) return null;
  for (const key of Object.keys(metadata)) {
    if (reservedAgentMetadataKeySet.has(key)) return key;
  }
  return null;
}

export const userAgentMetadataSchema = z.record(z.string(), z.unknown()).superRefine((metadata, ctx) => {
  const key = findReservedAgentMetadataKey(metadata);
  if (!key) return;
  ctx.addIssue({
    code: z.ZodIssueCode.custom,
    message: `metadata.${key} is reserved for First Tree internal runtime state`,
    path: [key],
  });
});

/**
 * Agent-name rules (see first-tree-context:agent-hub/agent-naming.md §3.1):
 *   - Lowercase ASCII slug, hyphens + underscores allowed.
 *   - Must start with alphanumeric: `-` / `_` as first char collide with
 *     CLI flag parsing and markdown list syntax.
 *   - 1–64 chars — aligned with `MENTION_REGEX` so any valid name can be
 *     @-mentioned in chat. Older rows created under the previous 1–100
 *     regex are grandfathered; the tight rule only gates new creates.
 */
export const AGENT_NAME_REGEX = /^[a-z0-9][a-z0-9_-]{0,63}$/;
export const AGENT_NAME_MAX_LENGTH = 64;

/**
 * Names users cannot claim in the portal. Prefix `__` is separately
 * reserved for First Tree-internal pseudo-agents (enforced in the server service
 * layer) — this list covers short, obvious squatters that would confuse
 * routing, docs, or CLI help.
 */
export const RESERVED_AGENT_NAMES: readonly string[] = [
  "admin",
  "agent",
  "first-tree",
  "hub",
  "me",
  "null",
  "system",
  "undefined",
];

const RESERVED_AGENT_NAMES_SET: ReadonlySet<string> = new Set(RESERVED_AGENT_NAMES);

export function isReservedAgentName(name: string): boolean {
  return RESERVED_AGENT_NAMES_SET.has(name);
}

/**
 * New public selection is narrower than the persisted provider union: a
 * temporarily disabled provider can remain on an already-bound agent, but it
 * must not enter through create or runtime switch.
 */
const selectableRuntimeProviderSchema = runtimeProviderSchema.refine(isRuntimeProviderEnabled, {
  message: "Runtime provider is disabled for new selection until release acceptance.",
});

export const createAgentSchema = z.object({
  name: z
    .string()
    .min(1)
    .max(AGENT_NAME_MAX_LENGTH)
    .regex(
      AGENT_NAME_REGEX,
      "Must start with a letter or digit and contain only lowercase letters, digits, hyphens (-), and underscores (_). Max 64 chars.",
    )
    .refine((n) => !isReservedAgentName(n), {
      message: "That agent name is reserved — pick a different one.",
    })
    .optional(),
  type: agentTypeSchema,
  /**
   * Post-Phase 2 the DB enforces `NOT NULL`; the service layer defaults
   * missing/empty values to `name` (or "Unnamed Agent") so callers can
   * still omit this. Reject empty / whitespace-only strings at the edge
   * so the silent server-side replacement doesn't mask a user typo.
   */
  displayName: z.string().min(1).max(200).optional(),
  delegateMention: z.string().max(100).optional(),
  organizationId: z.string().min(1).max(100).optional(),
  /** How this agent was created */
  source: agentSourceSchema.optional(),
  /** Agent visibility: "private" (manager only) or "organization" (all members) */
  visibility: agentVisibilitySchema.optional(),
  metadata: userAgentMetadataSchema.optional(),
  /** Member who manages this agent */
  managerId: z.string().optional(),
  /**
   * Physical client this agent is pinned to. Optional — when omitted for a
   * non-human agent the row stays NULL and is claimed on the first WS bind
   * (see `api/agent/ws-client.ts`). Human agents must omit it.
   */
  clientId: z.string().min(1).max(100).optional(),
  /**
   * Runtime provider that drives this agent. Defaults to `"claude-code"` at
   * the service layer when omitted. Must match a provider available in the
   * pinned client's reported capabilities (or be force-overridden).
   */
  runtimeProvider: selectableRuntimeProviderSchema.optional(),
  /**
   * Official Agent Templates to adopt atomically with creation. The server
   * imports their components into Team Resources and creates explicit
   * bindings inside the same transaction; omit for a plain create.
   */
  templateIds: agentTemplateIdsSchema.optional(),
});
export type CreateAgent = z.infer<typeof createAgentSchema>;

export const updateAgentSchema = z.object({
  // Agent kind is established at creation. Human mirrors are owned by the
  // member lifecycle, so generic PATCH must not support human <-> agent flips.
  type: z.never().optional(),
  /**
   * Phase 2 of the agent-naming refactor promoted `displayName` to NOT NULL
   * at the DB level, so null is no longer an accepted update — clearing the
   * label would violate the constraint. Callers that used to PATCH
   * `{ displayName: null }` must omit the field (leaves the row untouched)
   * or send a real string.
   */
  displayName: z.string().min(1).max(200).optional(),
  delegateMention: z.string().max(100).nullable().optional(),
  visibility: agentVisibilitySchema.optional(),
  metadata: userAgentMetadataSchema.optional(),
  /** Admin-only: reassign the manager */
  managerId: z.string().nullable().optional(),
  /**
   * One-shot bind. NULL → ID still allowed (admin claims an unbound agent for
   * a known client). ID → another ID and ID → null are rejected at the
   * generic PATCH service layer; moving a bound runtime must go through the
   * managed switch-runtime endpoint.
   */
  clientId: z.string().min(1).max(100).nullable().optional(),
  /**
   * Avatar color override. Explicit `null` clears the override (falls back
   * to the deterministic hash). Omitting the field leaves the row untouched.
   */
  avatarColorToken: avatarColorTokenSchema.nullable().optional(),
});
export type UpdateAgent = z.infer<typeof updateAgentSchema>;

export const switchAgentRuntimeSchema = z.object({
  /**
   * Target computer/client id. This is intentionally a required explicit
   * choice: runtime switches may move local workspace state between machines.
   */
  clientId: z.string().min(1).max(100),
  runtimeProvider: selectableRuntimeProviderSchema,
  /**
   * Product-level confirmation that the user accepts interruption of active
   * sessions and possible local-runtime state loss. This is not a safety-check
   * bypass; server preconditions still run.
   */
  confirmLocalDataLoss: z.literal(true),
});
export type SwitchAgentRuntime = z.infer<typeof switchAgentRuntimeSchema>;

export const agentSchema = z.object({
  uuid: z.string(),
  name: z.string().nullable(),
  organizationId: z.string(),
  type: agentTypeSchema,
  /**
   * Always populated post-Phase 2 (migration 0024 backfilled + `NOT NULL`).
   * The shared type used to be nullable; old row-shape consumers were
   * retired alongside the server service default.
   */
  displayName: z.string(),
  delegateMention: z.string().nullable(),
  inboxId: z.string(),
  status: z.string(),
  /** How this agent was created */
  source: z.string().nullable().optional(),
  /** Agent visibility: "private" (manager only) or "organization" (all members) */
  visibility: agentVisibilitySchema,
  metadata: z.record(z.string(), z.unknown()),
  /** Member who manages this agent */
  managerId: z.string().nullable(),
  /** Physical client this agent is pinned to. NULL for human agents only. */
  clientId: z.string().nullable(),
  /** Which runtime provider drives this agent. NOT NULL post-0026. */
  runtimeProvider: runtimeProviderSchema,
  /**
   * Manager-selected avatar color token (one of `AVATAR_COLOR_TOKENS`).
   * NULL means "auto" — the web renderer falls back to the deterministic
   * djb2 hash of `uuid`. Kept loose (`string`) on the read side so legacy
   * or unrecognised values flow through harmlessly; the renderer guards
   * on the known set.
   */
  avatarColorToken: z.string().nullable(),
  /**
   * Synthesized URL for the manager-uploaded avatar image. NULL when no
   * image is set. Carries a cache-busting suffix derived from the image's
   * last-upload timestamp so browsers refetch after a change. The image
   * itself is served by `GET /api/v1/agents/:uuid/avatar`.
   */
  avatarImageUrl: z.string().nullable(),
  presenceStatus: presenceStatusSchema.optional(),
  /**
   * ISO timestamp of the agent's last presence heartbeat
   * (`agent_presence.last_seen_at`). Drives the "active X ago" hover on the
   * Team page status cell. Absent on single-agent reads that don't join
   * presence; null when the agent has never connected.
   */
  lastSeenAt: z.string().nullable().optional(),
  /**
   * Runtime-A business state from `agent_presence.runtime_state` (the M1+
   * authority for "is this agent running"; NULL when not bound). Carried on
   * single-agent reads + mutations so management surfaces can derive
   * reachability (`runtimeState != null` ⟺ reachable) without depending on
   * the legacy `presenceStatus` column.
   */
  runtimeState: runtimeStateSchema.nullable().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type Agent = z.infer<typeof agentSchema>;

export const newChatDefaultCandidateAgentSchema = z.object({
  uuid: z.string(),
  name: z.string().nullable(),
  displayName: z.string(),
  type: agentTypeSchema,
  status: z.string(),
  managerId: z.string().nullable(),
  createdAt: z.string(),
});
export type NewChatDefaultCandidateAgent = z.infer<typeof newChatDefaultCandidateAgentSchema>;

export const newChatDefaultCandidatesRequestSchema = z.object({
  cachedAgentId: z.string().min(1).nullable().optional(),
});
export type NewChatDefaultCandidatesRequest = z.infer<typeof newChatDefaultCandidatesRequestSchema>;

export const newChatDefaultCandidatesResponseSchema = z.object({
  agent: newChatDefaultCandidateAgentSchema.nullable(),
});
export type NewChatDefaultCandidatesResponse = z.infer<typeof newChatDefaultCandidatesResponseSchema>;

export const contextTreeInfoSchema = z.object({
  repo: z.string().nullable(),
  branch: z.string().nullable(),
});
export type ContextTreeInfo = z.infer<typeof contextTreeInfoSchema>;

export const CONTEXT_TREE_BINDING_STATES = ["bound", "unbound", "invalid"] as const;
export const contextTreeBindingStateSchema = z.enum(CONTEXT_TREE_BINDING_STATES);
export type ContextTreeBindingState = z.infer<typeof contextTreeBindingStateSchema>;

/**
 * Agent-scoped Context Tree wire contract. `bindingState`, `repo`, `branch`,
 * and `provider` are all required keys.
 *
 * - `bound` uses the same repo/branch/provider constraints as the active
 *   Context Tree binding schema.
 * - `unbound` is `repo: null`, a valid branch (typically `"main"`), and
 *   `provider: null`.
 * - `invalid` carries no usable coordinates: repo, branch, and provider are
 *   all `null`.
 * Missing keys and any other combination fail closed (schema error → unknown).
 */
/**
 * Agent-scoped bound wire: a recognized GitHub host must carry `provider:
 * "github"`. Only an unclassified/generic host may omit an executable
 * provider (`null`). Org `contextTreeActiveBindingSchema` stays compatible
 * with legacy GitHub + omitted provider; this Agent contract does not.
 */
function boundAgentProviderMatchesRepo(repo: string, provider: "github" | "gitlab" | null): boolean {
  const resolution = resolveContextTreeProvider({ repo });
  if (resolution.source === "github_host") return provider === "github";
  if (resolution.identity?.host === "gitlab.com") return provider === "gitlab";
  if (provider === "github") return false;
  return true;
}

export const agentContextTreeInfoSchema = z
  .object({
    bindingState: contextTreeBindingStateSchema,
    repo: z.string().nullable(),
    branch: z.string().nullable(),
    provider: contextTreeProviderSchema.nullable(),
  })
  .superRefine((value, ctx) => {
    if (value.bindingState === "bound") {
      const branch = contextTreeBranchSchema.safeParse(value.branch);
      const binding = contextTreeActiveBindingSchema.safeParse({
        repo: value.repo,
        branch: value.branch,
        ...(value.provider ? { provider: value.provider } : {}),
      });
      if (!binding.success || !branch.success) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "bound bindingState must include an active repository and an explicit valid branch",
          path: branch.success ? ["repo"] : ["branch"],
        });
        return;
      }
      if (!boundAgentProviderMatchesRepo(binding.data.repo, value.provider)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "bound provider must match a recognized GitHub or GitLab host, or stay null on a generic host",
          path: ["provider"],
        });
      }
      return;
    }

    if (value.bindingState === "unbound") {
      if (value.repo !== null) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "unbound bindingState must not include a repository",
          path: ["repo"],
        });
      }
      if (value.provider !== null) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "unbound bindingState must not include a provider",
          path: ["provider"],
        });
      }
      if (!contextTreeBranchSchema.safeParse(value.branch).success) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "unbound bindingState requires a valid Git branch",
          path: ["branch"],
        });
      }
      return;
    }

    if (value.repo !== null || value.branch !== null || value.provider !== null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "invalid bindingState must not include usable coordinates",
      });
    }
  })
  .transform((value) => {
    if (value.bindingState !== "bound") return value;
    const binding = contextTreeActiveBindingSchema.parse({
      repo: value.repo,
      branch: value.branch,
      ...(value.provider ? { provider: value.provider } : {}),
    });
    return {
      bindingState: "bound" as const,
      repo: binding.repo,
      branch: binding.branch,
      provider: value.provider,
    };
  });
export type AgentContextTreeInfo = z.infer<typeof agentContextTreeInfoSchema>;

/**
 * Server → client WebSocket frame announcing that an agent has just been
 * pinned to the connected client (either created with `clientId` or bound via
 * PATCH NULL → ID). The client can auto-register a local config from this so
 * the operator doesn't have to run `agent add` manually.
 */
export const agentPinnedMessageSchema = z.object({
  type: z.literal("agent:pinned"),
  agentId: z.string(),
  name: z.string().nullable(),
  /**
   * Always populated post-Phase 2 (agents.display_name is NOT NULL). Old
   * clients that parsed the previous `nullable` variant still accept a
   * non-null string, so tightening this here is wire-compatible.
   */
  displayName: z.string(),
  agentType: agentTypeSchema,
  /**
   * Authoritative runtime provider for this agent (post-0026). Older clients
   * that omit this field on parse are tolerated by the consumer side, which
   * falls back to `"claude-code"` for legacy compatibility.
   */
  runtimeProvider: runtimeProviderSchema,
});
export type AgentPinnedMessage = z.infer<typeof agentPinnedMessageSchema>;

/**
 * Query string accepted by `GET /orgs/:orgId/agents` — pagination + the
 * agent-type filter + an optional substring search.
 *
 * `query` powers the participant picker's server-side search so orgs with
 * more than `limit` (100) visible agents can still reach agents past the
 * first page (issue 494). The cap on `limit` is unchanged; `query` is the
 * other dimension along which the picker narrows the result set.
 *
 * Trimming happens at the schema level so a whitespace-only input behaves
 * the same as an omitted param (no filtering) instead of erroring out —
 * the service treats an empty string as "no search". 60 chars is generous
 * for slug + display name without giving the ILIKE predicate an unbounded
 * input.
 */
export const listAgentsQuerySchema = paginationQuerySchema.extend({
  type: agentTypeSchema.optional(),
  query: z.string().trim().max(60).optional(),
  addressableOnly: z
    .preprocess((value) => {
      if (value === undefined || value === "") return undefined;
      if (value === true || value === "true" || value === "1") return true;
      if (value === false || value === "false" || value === "0") return false;
      return value;
    }, z.boolean().optional())
    .default(false),
});
export type ListAgentsQuery = z.infer<typeof listAgentsQuerySchema>;
