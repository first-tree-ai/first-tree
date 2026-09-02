import { z } from "zod";
import { MAX_ATTACHMENT_BYTES } from "./attachment.js";
import type { runtimeProviderSchema } from "./runtime-provider.js";

/**
 * Agent runtime configuration.
 *
 * Defines the shared user-tunable field groups that First Tree centrally manages
 * and pushes down to the client runtime: prompt append, model, MCP servers,
 * env vars, and Git repos. Tagged by `kind` (a runtime provider) so future
 * provider-specific fields can land on a dedicated variant.
 *
 * NOTE: do not co-locate with `packages/shared/src/config/` — that namespace
 * is reserved for the local YAML config (`agent.yaml` / server / client) and
 * is unrelated to the server-managed runtime config defined here.
 */

export const PROMPT_APPEND_MAX_LENGTH = 32_000;
const MCP_NAME_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/i;
const ENV_KEY_PATTERN = /^[A-Z][A-Z0-9_]*$/;
const WINDOWS_DRIVE_PATH_PATTERN = /^[A-Za-z]:/;

export const promptSectionScopeSchema = z.enum(["team", "agent"]);
export type PromptSectionScope = z.infer<typeof promptSectionScopeSchema>;

/**
 * One resolved entry of the effective prompt stack, tagged by provenance.
 *
 * `scope: "team"` rows come from team prompt resources (read-only for the
 * agent); `scope: "agent"` rows are agent-specific. Within agent scope,
 * `editable: true` marks the ONE kind of row `agent config prompt set` owns —
 * the standalone inline fragment. Agent-scope rows without it (inline
 * *replacements* of team prompts, agent-scoped prompt resources) are managed
 * via resource bindings, and the client briefing must not present them under
 * an "editable" heading, or an agent following the heading's instructions
 * would be unable to edit the content it sees.
 */
export const promptSectionSchema = z.object({
  scope: promptSectionScopeSchema,
  name: z.string().default(""),
  body: z.string().default(""),
  editable: z.boolean().optional(),
});
export type PromptSection = z.infer<typeof promptSectionSchema>;

export const promptConfigSchema = z.object({
  append: z.string().max(PROMPT_APPEND_MAX_LENGTH).default(""),
  /**
   * Structured projection of the effective prompt stack, resolved server-side
   * by the resources service at read time — never persisted. `append` keeps
   * carrying the legacy merged string so older clients keep working; new
   * clients render `sections`. Optional (not defaulted) so stored payloads
   * and patch bodies don't have to carry it.
   */
  sections: z.array(promptSectionSchema).optional(),
});
export type PromptConfig = z.infer<typeof promptConfigSchema>;

export const mcpStdioServerSchema = z.object({
  name: z.string().regex(MCP_NAME_PATTERN, "MCP name must match /^[a-z0-9][a-z0-9_-]{0,63}$/i"),
  transport: z.literal("stdio"),
  command: z.string().min(1),
  args: z.array(z.string()).optional(),
});
export type McpStdioServer = z.infer<typeof mcpStdioServerSchema>;

export const mcpHttpServerSchema = z.object({
  name: z.string().regex(MCP_NAME_PATTERN, "MCP name must match /^[a-z0-9][a-z0-9_-]{0,63}$/i"),
  transport: z.literal("http"),
  url: z.string().url(),
  headers: z.record(z.string(), z.string()).optional(),
});
export type McpHttpServer = z.infer<typeof mcpHttpServerSchema>;

export const mcpSseServerSchema = z.object({
  name: z.string().regex(MCP_NAME_PATTERN, "MCP name must match /^[a-z0-9][a-z0-9_-]{0,63}$/i"),
  transport: z.literal("sse"),
  url: z.string().url(),
  headers: z.record(z.string(), z.string()).optional(),
});
export type McpSseServer = z.infer<typeof mcpSseServerSchema>;

export const mcpServerSchema = z.discriminatedUnion("transport", [
  mcpStdioServerSchema,
  mcpHttpServerSchema,
  mcpSseServerSchema,
]);
export type McpServer = z.infer<typeof mcpServerSchema>;

export const runtimeSkillBundleSchema = z
  .object({
    attachmentId: z.string().uuid(),
    format: z.literal("zip"),
    sizeBytes: z.number().int().positive().max(MAX_ATTACHMENT_BYTES),
  })
  .strict();
export type RuntimeSkillBundle = z.infer<typeof runtimeSkillBundleSchema>;

export const runtimeResourceSkillSchema = z.object({
  resourceId: z.string().min(1),
  name: z.string().min(1),
  description: z.string().default(""),
  body: z.string().default(""),
  metadata: z.record(z.string(), z.unknown()).default({}),
  /**
   * Immutable complete-directory source for modern Team Skills. Optional for
   * rolling compatibility: older clients ignore it and keep consuming the
   * derived inline fields, while new clients treat a present descriptor as
   * authoritative.
   */
  bundle: runtimeSkillBundleSchema.optional(),
});
export type RuntimeResourceSkill = z.infer<typeof runtimeResourceSkillSchema>;

export const envEntrySchema = z.object({
  key: z.string().regex(ENV_KEY_PATTERN, "Env key must match /^[A-Z][A-Z0-9_]*$/"),
  value: z.string(),
  sensitive: z.boolean().default(false),
});
export type EnvEntry = z.infer<typeof envEntrySchema>;

function hasControlCharacters(value: string): boolean {
  for (let idx = 0; idx < value.length; idx++) {
    const code = value.charCodeAt(idx);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

export function getRepoLocalPathSafetyError(localPath: string): string | null {
  if (localPath.length === 0) return "Git repo local path must not be empty";
  if (localPath.trim() !== localPath) return "Git repo local path must not have leading or trailing whitespace";
  if (hasControlCharacters(localPath)) return "Git repo local path must not contain control characters";
  if (localPath.includes("\\")) return "Git repo local path must use forward slashes";
  if (localPath.startsWith("/") || WINDOWS_DRIVE_PATH_PATTERN.test(localPath)) {
    return "Git repo local path must be relative";
  }
  // Single directory name only: source repos materialize as immediate
  // children of the agent workspace (`<workspace>/<localPath>/`), and the W1
  // `workspace.json.sources` manifest records immediate-subdirectory names.
  // A nested path like `services/api` cannot be expressed in that manifest, so
  // shipped skills (first-tree-seed / first-tree-sync) that discover bound
  // repos through it would never see the source. localPath's only job is to
  // override the URL-derived directory name (e.g. to de-duplicate two repos
  // that derive the same name); that override stays a single segment.
  if (localPath.includes("/")) {
    return "Git repo local path must be a single directory name (no '/'): source repos are immediate children of the workspace";
  }
  if (localPath === "." || localPath === "..") {
    return "Git repo local path must not be a dot segment";
  }

  return null;
}

export function isSafeRepoLocalPath(localPath: string): boolean {
  return getRepoLocalPathSafetyError(localPath) === null;
}

/**
 * Normalize a configured localPath to a single workspace-immediate directory
 * name, tolerating a legacy *clean nested* path by joining its segments into
 * one collision-safe segment.
 *
 * Source repos must be immediate children of the workspace — the W1
 * `workspace.json.sources` manifest records single-segment names and the
 * bare-clone/worktree layout assumes top-level dirs. New config is narrowed to
 * single-segment, but `agent_configs.payload` and
 * `agent_resource_bindings.repo_local_path` are persisted data: a value that
 * was legal under the old (nesting-permitted) schema, e.g. `repos/repo-1`,
 * must still READ cleanly rather than throwing in
 * `agentRuntimeConfigPayloadSchema.parse` on every config read / agent bind
 * (PR #1048 — baixiaohang persisted-data blocker).
 *
 * So a clean nested path is joined into a single segment with `-`
 * (`repos/repo-1` → `repos-repo-1`) and the safety check then validates that
 * segment. Joining rather than taking the basename is the faithful default:
 * nesting was used to keep two repos with the same basename apart
 * (`services/api` + `libs/api`), and joining preserves that distinction
 * (`services-api` vs `libs-api`) instead of collapsing both to `api`.
 *
 * Joining is NOT injective — `services/api` and a single-segment `services-api`
 * both reduce to `services-api` — and no pure transform that leaves common
 * single-segment names untouched can be. That is fine: a localPath collision is
 * tolerated on read and de-duplicated gracefully where the value is consumed
 * (the resources service's `applyRepoLocalPathDedup` marks the later repo
 * `unavailable`), not enforced as a fatal parse failure. See the removed
 * gitRepos duplicate check in `payloadDuplicatesRefinement`.
 *
 * A path with any hard-unsafe shape (absolute, backslash, control char,
 * `.`/`..` or empty segment, surrounding whitespace) is returned unchanged so
 * the safety check still rejects it — those shapes were never legal and so
 * were never persisted.
 */
export function normalizeRepoLocalPath(localPath: string): string {
  if (!localPath.includes("/")) return localPath;
  if (localPath.trim() !== localPath) return localPath;
  if (hasControlCharacters(localPath)) return localPath;
  if (localPath.includes("\\")) return localPath;
  if (localPath.startsWith("/") || WINDOWS_DRIVE_PATH_PATTERN.test(localPath)) return localPath;
  const segments = localPath.split("/");
  for (const segment of segments) {
    if (!segment || segment === "." || segment === ".." || segment.trim() !== segment) {
      return localPath;
    }
  }
  return segments.join("-");
}

export const gitRepoSchema = z.object({
  url: z.string().min(1),
  ref: z.string().min(1).optional(),
  /** Path relative to the session working directory; if omitted, derive from repo name. */
  localPath: z
    .string()
    .min(1)
    // Join a legacy clean nested path into one segment BEFORE validating, so
    // persisted nested values read cleanly; the safety check then enforces a
    // single safe segment. See {@link normalizeRepoLocalPath}.
    .transform(normalizeRepoLocalPath)
    .superRefine((localPath, ctx) => {
      const safetyError = getRepoLocalPathSafetyError(localPath);
      if (!safetyError) return;
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: safetyError,
      });
    })
    .optional(),
});
export type GitRepo = z.infer<typeof gitRepoSchema>;

/**
 * Untagged base shape — shared user-tunable fields, no `kind` discriminator.
 * Used for `.partial()` derivations on the PATCH side, where `kind` is
 * pinned to `agents.runtime_provider` and never changes via config PATCH.
 * Zod 4 forbids `.partial()` on a refined object, so we keep refinements
 * on the tagged schema below.
 */
export const agentRuntimeConfigPayloadShape = z.object({
  prompt: promptConfigSchema.default({ append: "" }),
  /**
   * Model identifier. Accepts either an alias (`opus` / `sonnet` / `haiku`) or
   * a full model id (`claude-opus-4-7`). Alias follows the SDK's latest-in-family
   * mapping and may shift across CLI releases; pin a full id if you need stability.
   */
  model: z.string().default("opus"),
  mcpServers: z.array(mcpServerSchema).default([]),
  env: z.array(envEntrySchema).default([]),
  gitRepos: z.array(gitRepoSchema).default([]),
  resourceSkills: z.array(runtimeResourceSkillSchema).default([]),
});

/**
 * Tagged variants — read-side, full payload including `kind`. Adding a new
 * provider means adding a variant here, plus a handler factory and a
 * capability probe module on the client side.
 *
 * Provider-specific fields (e.g. codex `sandboxMode`) belong on the
 * matching variant, not on the base shape.
 */
const claudeRuntimeConfigPayloadShape = agentRuntimeConfigPayloadShape.extend({
  kind: z.literal("claude-code"),
  // Maps to claude-agent-sdk Options.effort (the `--effort` flag). The empty
  // string is an "inherit" sentinel: when set, the handler omits the effort
  // option so the SDK falls back to the operator's local
  // `~/.claude/settings.json` effortLevel (the pre-feature behavior). A
  // non-empty value is passed explicitly and overrides that local setting —
  // verified against cli.js, which resolves `effort ?? settings.effortLevel`.
  reasoningEffort: z.enum(["", "low", "medium", "high", "max"]).default(""),
});
const claudeCodeTuiRuntimeConfigPayloadShape = agentRuntimeConfigPayloadShape.extend({
  kind: z.literal("claude-code-tui"),
  // Same `reasoningEffort` contract as claude-code — the TUI runtime drives the
  // identical `claude` CLI, just through tmux instead of the SDK. The empty
  // string is the same "inherit local settings.json effortLevel" sentinel.
  reasoningEffort: z.enum(["", "low", "medium", "high", "max"]).default(""),
});
const codexRuntimeConfigPayloadShape = agentRuntimeConfigPayloadShape.extend({
  kind: z.literal("codex"),
  // Maps to codex-sdk ThreadOptions.modelReasoningEffort. Default "high"
  // preserves the value the handler previously hardcoded. Newer Codex models
  // additionally advertise provider-native "max" and "ultra" values. Support
  // is model-dependent, so the runtime passes them through and lets the
  // provider return an explicit compatibility error. "minimal" remains
  // intentionally excluded — it is incompatible with the default tool set and
  // breaks tool calls (see the codex handler's footgun notes).
  reasoningEffort: z.enum(["low", "medium", "high", "xhigh", "max", "ultra"]).default("high"),
  // Provider-native service tier id forwarded to Codex unchanged. "default"
  // is Standard mode; "fast" selects Fast mode. Keep this open to future
  // provider-advertised tier ids instead of maintaining a local compatibility
  // matrix — an unsupported model/account combination fails visibly at the
  // provider boundary.
  serviceTier: z.string().min(1).default("default"),
});

/** Amp CLI/SDK capability presets. Empty config omits `--mode` (Amp default: medium). */
export const AMP_RUNTIME_MODES = ["low", "medium", "high", "ultra"] as const;
export type AmpRuntimeMode = (typeof AMP_RUNTIME_MODES)[number];

export function isAmpRuntimeMode(value: string): value is AmpRuntimeMode {
  return (AMP_RUNTIME_MODES as readonly string[]).includes(value);
}

const deepseekRuntimeConfigPayloadShape = agentRuntimeConfigPayloadShape.extend({
  kind: z.literal("deepseek-harness"),
  // DeepSeek model identifiers are provider-native ids. Empty delegates to
  // deepseek-v4-flash at harness initialize; non-empty values are forwarded
  // through DSH_MODEL to the cordis template.
});

const ampRuntimeConfigPayloadShape = agentRuntimeConfigPayloadShape.extend({
  kind: z.literal("amp"),
  // Amp's official CLI/SDK contract exposes `mode` (capability presets), not a
  // model id. Empty omits `--mode` so Amp uses its local default (medium). A
  // leftover model id fails closed at parse and at spawn.
  model: z.union([z.literal(""), z.enum(AMP_RUNTIME_MODES)]).default(""),
});

const cursorRuntimeConfigPayloadShape = agentRuntimeConfigPayloadShape.extend({
  kind: z.literal("cursor"),
  // No `reasoningEffort` — Cursor has no separate effort channel; effort/fast/
  // context selection is already encoded in the provider-native model id the
  // free-form `model` field carries. The safety posture (`--sandbox disabled
  // --force`) is a runtime decision, not a configurable field, so no
  // `sandboxMode` / `approvalPolicy` either.
});

const kimiCodeRuntimeConfigPayloadShape = agentRuntimeConfigPayloadShape.extend({
  kind: z.literal("kimi-code"),
  // No First Tree reasoning-effort field in V1. Kimi thinking configuration is
  // provider-native; an empty model delegates to the operator's local Kimi
  // configuration while a non-empty exact id is passed to the SDK.
});

const opencodeRuntimeConfigPayloadShape = agentRuntimeConfigPayloadShape.extend({
  kind: z.literal("opencode"),
  // OpenCode model identifiers are provider-native `provider/model` values.
  // An empty value delegates selection to the operator's local OpenCode
  // configuration; non-empty values are forwarded as one argv entry.
});

const piRuntimeConfigPayloadShape = agentRuntimeConfigPayloadShape.extend({
  kind: z.literal("pi"),
  // Pi model identifiers are provider-native `provider/model` values (optional
  // `:<thinking>` suffix). Empty model semantics: an existing stable Pi session
  // keeps its persisted model; only a new session uses Pi's local default.
  // Non-empty values are forwarded as one `--model` argv entry.
});

const grokRuntimeConfigPayloadShape = agentRuntimeConfigPayloadShape.extend({
  kind: z.literal("grok"),
  // Maps to the Grok Build CLI `--effort <low|medium|high>` flag. The empty
  // string is an "inherit" sentinel: when set, the handler omits `--effort`
  // AND sends no effort meta — but it still calls `session/set_model` after
  // every session open (new or load), so an EMPTY effort only removes the
  // override; it never silently keeps a resumed session's persisted effort.
  // A non-empty value is passed through verbatim as one argv entry. An empty
  // `model` likewise omits `--model`; after every session open the handler
  // then applies the INITIALIZE-advertised current/default model via
  // `session/set_model` — the resumed session's persisted model is never
  // silently inherited.
  reasoningEffort: z.enum(["", "low", "medium", "high"]).default(""),
});

const antigravityRuntimeConfigPayloadShape = agentRuntimeConfigPayloadShape.extend({
  kind: z.literal("antigravity"),
  // Antigravity accepts provider-native model slugs and a separate low /
  // medium / high effort flag. Empty values delegate to the operator's local
  // Antigravity defaults; non-empty values are passed through verbatim.
  reasoningEffort: z.enum(["", "low", "medium", "high"]).default(""),
});

const taggedPayloadUnion = z.discriminatedUnion("kind", [
  ampRuntimeConfigPayloadShape,
  deepseekRuntimeConfigPayloadShape,
  claudeRuntimeConfigPayloadShape,
  claudeCodeTuiRuntimeConfigPayloadShape,
  codexRuntimeConfigPayloadShape,
  cursorRuntimeConfigPayloadShape,
  antigravityRuntimeConfigPayloadShape,
  grokRuntimeConfigPayloadShape,
  kimiCodeRuntimeConfigPayloadShape,
  opencodeRuntimeConfigPayloadShape,
  piRuntimeConfigPayloadShape,
]);
type TaggedPayload = z.infer<typeof taggedPayloadUnion>;

const payloadDuplicatesRefinement = (payload: TaggedPayload, ctx: z.RefinementCtx) => {
  const seenMcp = new Set<string>();
  payload.mcpServers.forEach((server, idx) => {
    const lower = server.name.toLowerCase();
    if (seenMcp.has(lower)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["mcpServers", idx, "name"],
        message: `Duplicate MCP server name "${server.name}"`,
      });
    }
    seenMcp.add(lower);
  });

  const seenEnv = new Set<string>();
  payload.env.forEach((entry, idx) => {
    if (seenEnv.has(entry.key)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["env", idx, "key"],
        message: `Duplicate env key "${entry.key}"`,
      });
    }
    seenEnv.add(entry.key);
  });

  // No gitRepos duplicate-localPath check here, by design (PR #1048).
  //
  // `gitRepos` is no longer writable through the config payload — the PATCH
  // path rejects it with `legacy_resource_config_disabled` — so this read-side
  // schema only ever sees `gitRepos` as carried-forward legacy data
  // (`applyPatch` preserves `current.gitRepos`, then `commitWrite` re-parses
  // the whole merged payload on EVERY config edit). A hard duplicate-localPath
  // failure here would therefore brick reads AND unrelated edits (e.g. a model
  // change) of any pre-narrowing config whose nested localPaths now normalize
  // to the same single segment (`services/api` + `services-api` → `services-api`).
  //
  // Runtime uniqueness is enforced where it actually matters: `resolveRuntimeConfig`
  // REPLACES `payload.gitRepos` with the resource-derived repos before the client
  // ever sees them, and `applyRepoLocalPathDedup` resolves a collision gracefully
  // (marks the later repo `unavailable` with reason `duplicate_local_path` — the
  // operator-visible audit signal) instead of throwing. No pure normalization can
  // be both injective and identity-preserving on common single-segment names, so
  // tolerating collisions on read (and de-duping gracefully at resolution) is the
  // correct contract rather than chasing a collision-free mapping.
};

/**
 * Read-side full payload schema. Rows persisted before 0026 do not carry
 * `kind`; `z.preprocess` injects `"claude-code"` so they parse cleanly into
 * the claude variant. The service layer separately enforces
 * `payload.kind === agents.runtime_provider` on writes.
 */
export const agentRuntimeConfigPayloadSchema = z
  .preprocess((input) => {
    if (
      input &&
      typeof input === "object" &&
      !Array.isArray(input) &&
      !("kind" in (input as Record<string, unknown>))
    ) {
      return { ...(input as Record<string, unknown>), kind: "claude-code" };
    }
    return input;
  }, taggedPayloadUnion)
  .superRefine((payload, ctx) => {
    payloadDuplicatesRefinement(payload as TaggedPayload, ctx);
  });
export type AgentRuntimeConfigPayload = z.infer<typeof agentRuntimeConfigPayloadSchema>;

/**
 * Provider-specific payload variants. Default constants are typed against these
 * rather than the union so spreading a default and overriding `model` (or other
 * variant-narrowed fields) stays assignable — Amp's `model` is
 * `"" | low | medium | high | ultra`, which otherwise poisons union spreads.
 */
export type ClaudeCodeRuntimeConfigPayload = Extract<AgentRuntimeConfigPayload, { kind: "claude-code" }>;
export type ClaudeCodeTuiRuntimeConfigPayload = Extract<AgentRuntimeConfigPayload, { kind: "claude-code-tui" }>;
export type CodexRuntimeConfigPayload = Extract<AgentRuntimeConfigPayload, { kind: "codex" }>;
export type AmpRuntimeConfigPayload = Extract<AgentRuntimeConfigPayload, { kind: "amp" }>;
export type DeepseekRuntimeConfigPayload = Extract<AgentRuntimeConfigPayload, { kind: "deepseek-harness" }>;
export type CursorRuntimeConfigPayload = Extract<AgentRuntimeConfigPayload, { kind: "cursor" }>;
export type KimiCodeRuntimeConfigPayload = Extract<AgentRuntimeConfigPayload, { kind: "kimi-code" }>;
export type OpenCodeRuntimeConfigPayload = Extract<AgentRuntimeConfigPayload, { kind: "opencode" }>;
export type PiRuntimeConfigPayload = Extract<AgentRuntimeConfigPayload, { kind: "pi" }>;
export type GrokRuntimeConfigPayload = Extract<AgentRuntimeConfigPayload, { kind: "grok" }>;
export type AntigravityRuntimeConfigPayload = Extract<AgentRuntimeConfigPayload, { kind: "antigravity" }>;

/** Default payload used when creating a fresh claude-code agent. */
export const DEFAULT_AGENT_RUNTIME_CONFIG_PAYLOAD: ClaudeCodeRuntimeConfigPayload = {
  kind: "claude-code",
  prompt: { append: "" },
  model: "opus",
  mcpServers: [],
  env: [],
  gitRepos: [],
  resourceSkills: [],
  reasoningEffort: "",
};

/**
 * Default payload for a fresh codex agent. It carries the shared fields plus
 * Codex-native reasoning-effort and service-tier controls.
 * `model` is left empty by default so the Codex CLI picks one matching the
 * user's auth mode — `gpt-5-codex` is rejected by ChatGPT-account auth, while
 * an empty string lets the SDK fall through to its built-in default.
 */
export const DEFAULT_CODEX_RUNTIME_CONFIG_PAYLOAD: CodexRuntimeConfigPayload = {
  kind: "codex",
  prompt: { append: "" },
  model: "",
  mcpServers: [],
  env: [],
  gitRepos: [],
  resourceSkills: [],
  reasoningEffort: "high",
  serviceTier: "default",
};

/**
 * Default payload for a fresh claude-code-tui agent. Same fields as claude-code
 * (including the reasoningEffort inherit sentinel) since both drive the same
 * `claude` CLI; the provider differs only in how the client runtime
 * communicates with that CLI (TUI through tmux vs SDK).
 */
export const DEFAULT_CLAUDE_CODE_TUI_RUNTIME_CONFIG_PAYLOAD: ClaudeCodeTuiRuntimeConfigPayload = {
  kind: "claude-code-tui",
  prompt: { append: "" },
  model: "opus",
  mcpServers: [],
  env: [],
  gitRepos: [],
  resourceSkills: [],
  reasoningEffort: "",
};

/** Default payload for a fresh DeepSeek Harness agent. Empty model uses deepseek-v4-flash. */
export const DEFAULT_DEEPSEEK_RUNTIME_CONFIG_PAYLOAD: DeepseekRuntimeConfigPayload = {
  kind: "deepseek-harness",
  prompt: { append: "" },
  model: "",
  mcpServers: [],
  env: [],
  gitRepos: [],
  resourceSkills: [],
};

/** Default payload for a fresh Amp agent. Empty model omits `--mode` (Amp default: medium). */
export const DEFAULT_AMP_RUNTIME_CONFIG_PAYLOAD: AmpRuntimeConfigPayload = {
  kind: "amp",
  prompt: { append: "" },
  model: "",
  mcpServers: [],
  env: [],
  gitRepos: [],
  resourceSkills: [],
};

/**
 * Default payload for a fresh cursor agent. `model` is empty by default so the
 * spawn omits `--model` and the Cursor CLI picks its local default (`auto`); a
 * non-empty operator value is passed through verbatim as one argv entry.
 */
export const DEFAULT_CURSOR_RUNTIME_CONFIG_PAYLOAD: CursorRuntimeConfigPayload = {
  kind: "cursor",
  prompt: { append: "" },
  model: "",
  mcpServers: [],
  env: [],
  gitRepos: [],
  resourceSkills: [],
};

/** Default payload for Kimi Code. Empty model inherits ~/.kimi-code config. */
export const DEFAULT_KIMI_CODE_RUNTIME_CONFIG_PAYLOAD: KimiCodeRuntimeConfigPayload = {
  kind: "kimi-code",
  prompt: { append: "" },
  model: "",
  mcpServers: [],
  env: [],
  gitRepos: [],
  resourceSkills: [],
};

/** Default payload for OpenCode. Empty model inherits the host-local config. */
export const DEFAULT_OPENCODE_RUNTIME_CONFIG_PAYLOAD: OpenCodeRuntimeConfigPayload = {
  kind: "opencode",
  prompt: { append: "" },
  model: "",
  mcpServers: [],
  env: [],
  gitRepos: [],
  resourceSkills: [],
};

/** Default payload for Pi. Empty model inherits the host-local Pi default. */
export const DEFAULT_PI_RUNTIME_CONFIG_PAYLOAD: PiRuntimeConfigPayload = {
  kind: "pi",
  prompt: { append: "" },
  model: "",
  mcpServers: [],
  env: [],
  gitRepos: [],
  resourceSkills: [],
};

/**
 * Default payload for a fresh grok agent. `model` is empty by default so the
 * spawn omits `--model`; `reasoningEffort` defaults to the inherit sentinel
 * so `--effort` is omitted as well. Empty values do NOT inherit a resumed
 * session's persisted selection: after every session open the handler still
 * calls `session/set_model` (initialize default model, no effort meta when
 * unset). A non-empty operator value for either is passed through verbatim.
 */
export const DEFAULT_GROK_RUNTIME_CONFIG_PAYLOAD: GrokRuntimeConfigPayload = {
  kind: "grok",
  prompt: { append: "" },
  model: "",
  mcpServers: [],
  env: [],
  gitRepos: [],
  resourceSkills: [],
  reasoningEffort: "",
};

/** Default payload for a fresh Antigravity agent. */
export const DEFAULT_ANTIGRAVITY_RUNTIME_CONFIG_PAYLOAD: AntigravityRuntimeConfigPayload = {
  kind: "antigravity",
  prompt: { append: "" },
  model: "",
  mcpServers: [],
  env: [],
  gitRepos: [],
  resourceSkills: [],
  reasoningEffort: "",
};

/**
 * Default payload selector by runtime provider.
 */
export function defaultRuntimeConfigPayload(
  provider: z.infer<typeof runtimeProviderSchema>,
): AgentRuntimeConfigPayload {
  switch (provider) {
    case "amp":
      return { ...DEFAULT_AMP_RUNTIME_CONFIG_PAYLOAD };
    case "deepseek-harness":
      return { ...DEFAULT_DEEPSEEK_RUNTIME_CONFIG_PAYLOAD };
    case "codex":
      return { ...DEFAULT_CODEX_RUNTIME_CONFIG_PAYLOAD };
    case "cursor":
      return { ...DEFAULT_CURSOR_RUNTIME_CONFIG_PAYLOAD };
    case "grok":
      return { ...DEFAULT_GROK_RUNTIME_CONFIG_PAYLOAD };
    case "antigravity":
      return { ...DEFAULT_ANTIGRAVITY_RUNTIME_CONFIG_PAYLOAD };
    case "kimi-code":
      return { ...DEFAULT_KIMI_CODE_RUNTIME_CONFIG_PAYLOAD };
    case "opencode":
      return { ...DEFAULT_OPENCODE_RUNTIME_CONFIG_PAYLOAD };
    case "pi":
      return { ...DEFAULT_PI_RUNTIME_CONFIG_PAYLOAD };
    case "claude-code-tui":
      return { ...DEFAULT_CLAUDE_CODE_TUI_RUNTIME_CONFIG_PAYLOAD };
    case "claude-code":
      return { ...DEFAULT_AGENT_RUNTIME_CONFIG_PAYLOAD };
    default: {
      const _exhaustive: never = provider;
      void _exhaustive;
      return { ...DEFAULT_AGENT_RUNTIME_CONFIG_PAYLOAD };
    }
  }
}

export const agentRuntimeConfigSchema = z.object({
  agentId: z.string(),
  version: z.number().int().positive(),
  payload: agentRuntimeConfigPayloadSchema,
  updatedAt: z.string(),
  updatedBy: z.string(),
});
export type AgentRuntimeConfig = z.infer<typeof agentRuntimeConfigSchema>;

/**
 * Write-side shape with no `.default()` per field.
 *
 * `agentRuntimeConfigPayloadShape` carries `.default()` on every field for the
 * read path (so legacy DB rows parse cleanly). On the PATCH side those defaults
 * are actively harmful: Zod 4's `.partial()` makes a field optional but keeps
 * the inner `ZodDefault`, so a body like `{ mcpServers: [...] }` parses to a
 * fully-populated patch where the omitted fields are filled with their
 * defaults — the service layer's `patch.x ?? current.x` then sees a truthy
 * default and *replaces* the user's saved value with empty. Mirroring the 5
 * fields here without defaults keeps "field absent" → `undefined` in the
 * parsed patch, which is what the merge logic expects.
 */
const agentRuntimeConfigPatchShape = z
  .object({
    // `sections` is a read-side projection computed by the resources service;
    // it is never writable, so the patch prompt shape omits it (and Zod's
    // default strip mode silently drops it if a client echoes it back).
    prompt: promptConfigSchema.omit({ sections: true }),
    model: z.string(),
    mcpServers: z.array(mcpServerSchema),
    env: z.array(envEntrySchema),
    gitRepos: z.array(gitRepoSchema),
    // Loose `z.string()` here (like `model`), not a per-provider enum: the
    // patch shape is flat and provider-agnostic, while the allowed values
    // differ per provider. Validity is enforced when the merged payload is
    // re-parsed against the tagged union in `commitWrite` — an out-of-range
    // value (e.g. "" for codex, "xhigh" for claude) is rejected there.
    reasoningEffort: z.string(),
    // Codex-only provider-native service tier. The service layer rejects this
    // field for other runtime providers; Codex validates model/account support.
    serviceTier: z.string().min(1),
  })
  .partial();

/**
 * Patch payload for PATCH /api/v1/admin/agents/:uuid/config.
 *
 * - `expectedVersion` enforces optimistic locking; mismatch → 409.
 * - All payload fields are optional; omitted fields are left untouched.
 */
export const updateAgentRuntimeConfigSchema = z.object({
  expectedVersion: z.number().int().positive(),
  payload: agentRuntimeConfigPatchShape,
});
export type UpdateAgentRuntimeConfig = z.infer<typeof updateAgentRuntimeConfigSchema>;

/**
 * The patch half of an update — every payload field optional, and
 * provider-specific scalar fields typed loosely enough for the flat PATCH
 * surface. Use this for merge helpers instead of
 * `Partial<AgentRuntimeConfigPayload>`: the latter is a partial of the tagged
 * union, so provider-only fields do not form one assignable patch shape.
 */
export type AgentRuntimeConfigPatch = UpdateAgentRuntimeConfig["payload"];

export const dryRunAgentRuntimeConfigSchema = z.object({
  payload: agentRuntimeConfigPatchShape,
});
export type DryRunAgentRuntimeConfig = z.infer<typeof dryRunAgentRuntimeConfigSchema>;

export const agentRuntimeConfigDryRunResultSchema = z.object({
  current: agentRuntimeConfigSchema,
  next: agentRuntimeConfigPayloadSchema,
  diff: z.array(
    z.object({
      path: z.string(),
      op: z.enum(["add", "remove", "replace"]),
      before: z.unknown().optional(),
      after: z.unknown().optional(),
    }),
  ),
});
export type AgentRuntimeConfigDryRunResult = z.infer<typeof agentRuntimeConfigDryRunResultSchema>;

/**
 * Branded payload sent over the wire to the client runtime.
 *
 * `__brand` prevents accidentally serialising raw DB rows / inbox entries —
 * every dispatch path must go through `buildClientMessagePayload` (Step 3).
 */
export type ClientMessagePayload = {
  readonly __brand: "client-message-payload";
  messageId: string;
  chatId: string;
  inboxId: string;
  senderId: string | null;
  format: string;
  content: unknown;
  createdAt: string;
  configVersion: number;
};

export const ENV_REDACTED_PLACEHOLDER = "***";

/** Mask of a previously-stored sensitive value when echoing back to admin. */
export function isRedactedEnvValue(value: string): boolean {
  return value === ENV_REDACTED_PLACEHOLDER;
}

/**
 * Derive a default local path from a repo URL.
 * Used both for validation (duplicate detection) and at runtime when the user
 * leaves `localPath` empty.
 */
export function deriveRepoLocalPath(url: string): string {
  const trimmed = url.trim();
  if (!trimmed) return "";
  const noQuery = trimmed.split(/[?#]/)[0] ?? "";
  const lastSegment = noQuery.split(/[/:]/).filter(Boolean).pop() ?? "";
  return lastSegment.replace(/\.git$/i, "");
}

const DEFAULT_BRANCH_NAMES: ReadonlySet<string> = new Set(["main", "master"]);

/**
 * Short `owner/repo` label from a repo URL — drops the host, the `.git` suffix,
 * and any query/fragment. Falls back to the bare repo name when no owner segment
 * is present. For compact, non-technical repo display (vs the full URL).
 */
export function deriveRepoShortLabel(url: string): string {
  const trimmed = url.trim();
  if (!trimmed) return "";
  const noQuery = trimmed.split(/[?#]/)[0] ?? "";
  const segments = noQuery.split(/[/:]/).filter(Boolean);
  const repo = (segments.pop() ?? "").replace(/\.git$/i, "");
  const owner = segments.pop() ?? "";
  return owner ? `${owner}/${repo}` : repo;
}

/**
 * One-line repo coordinate for display: `owner/repo`, with `@branch` appended
 * only for a non-default branch and `→ localPath` only for a non-default mount
 * path. Defaults (main/master, the path derived from the repo name) are omitted
 * so common repos stay clean and only deviations draw the eye.
 */
export function formatRepoCoordinate(repo: { url: string; ref?: string; localPath?: string }): string {
  const base = deriveRepoShortLabel(repo.url);
  const branchPart = repo.ref && !DEFAULT_BRANCH_NAMES.has(repo.ref) ? `@${repo.ref}` : "";
  const pathPart = repo.localPath && repo.localPath !== deriveRepoLocalPath(repo.url) ? ` → ${repo.localPath}` : "";
  return `${base}${branchPart}${pathPart}`;
}
