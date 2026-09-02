// Schema declaration utilities

export type { AgentConfig } from "./agent-config.js";
export {
  agentConfigSchema,
  DEFAULT_AGENT_CONCURRENCY,
  DEFAULT_AGENT_MAX_SESSIONS,
  DEFAULT_WORKING_GRACE_SECONDS,
} from "./agent-config.js";
export type { ClientConfig } from "./client-config.js";
export {
  clientConfigSchema,
  getClientConfig,
  readContextTreeRepository,
  updatePolicySchema,
} from "./client-config.js";
// Agent loader
export { loadAgents } from "./loader.js";
export type { UpdatePolicy } from "./phase.js";
export { UPDATE_POLICY_DEFAULT } from "./phase.js";
export type { ConfigMeta } from "./resolver.js";
// Config initialization and access
export {
  buildZodSchema,
  collectMissingPrompts,
  daemonEnvFile,
  defaultConfigDir,
  defaultDataDir,
  defaultHome,
  getConfigMeta,
  getConfigValue,
  initConfig,
  readConfigFile,
  resetConfigMeta,
  resolveConfigReadonly,
  setConfigValue,
} from "./resolver.js";
export { defineConfig, field, optional } from "./schema.js";
export type { ServerConfig } from "./server-config.js";
// Typed config schemas and accessors
export { createServerConfigSchema, getServerConfig, serverConfigSchema } from "./server-config.js";
// `setConfig` is intended for test scaffolding only — production code goes
// through `initConfig`, which sets the singleton internally. Exposed at the
// barrel so server test helpers can pin a config before constructing the
// app without dragging shared internals through a relative path.
export { getConfig, resetConfig, setConfig } from "./singleton.js";

// Types
export type {
  AutoGenerator,
  ConfigSource,
  FieldDef,
  FieldOptions,
  InferConfig,
  InitConfigOptions,
  OptionalGroupDef,
  OptionalGroupOptions,
  PromptChoice,
  PromptDef,
  ResolvedFieldInfo,
} from "./types.js";
