import { describe, expect, it } from "vitest";
import { agentConfigSchema, DEFAULT_AGENT_CONCURRENCY, DEFAULT_AGENT_MAX_SESSIONS } from "../agent-config.js";
import {
  clientConfigSchema,
  getClientConfig,
  normalizeContextTreeRepository,
  readContextTreeRepositorySetting,
  updatePolicySchema,
} from "../client-config.js";
import * as config from "../index.js";
import { loadAgents } from "../loader.js";
import { UPDATE_POLICY_DEFAULT } from "../phase.js";
import {
  buildZodSchema,
  collectMissingPrompts,
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
} from "../resolver.js";
import { defineConfig, field, optional } from "../schema.js";
import { getServerConfig, serverConfigSchema } from "../server-config.js";
import { getConfig, resetConfig } from "../singleton.js";

describe("config barrel", () => {
  it("re-exports config schemas and helpers from the public entry point", () => {
    expect(config.agentConfigSchema).toBe(agentConfigSchema);
    expect(config.DEFAULT_AGENT_CONCURRENCY).toBe(DEFAULT_AGENT_CONCURRENCY);
    expect(config.DEFAULT_AGENT_MAX_SESSIONS).toBe(DEFAULT_AGENT_MAX_SESSIONS);
    expect(config.clientConfigSchema).toBe(clientConfigSchema);
    expect(config.getClientConfig).toBe(getClientConfig);
    expect(config.normalizeContextTreeRepository).toBe(normalizeContextTreeRepository);
    expect(config.readContextTreeRepositorySetting).toBe(readContextTreeRepositorySetting);
    expect(config.updatePolicySchema).toBe(updatePolicySchema);
    expect(config.loadAgents).toBe(loadAgents);
    expect(config.UPDATE_POLICY_DEFAULT).toBe(UPDATE_POLICY_DEFAULT);
    expect(config.buildZodSchema).toBe(buildZodSchema);
    expect(config.collectMissingPrompts).toBe(collectMissingPrompts);
    expect(config.defaultConfigDir).toBe(defaultConfigDir);
    expect(config.defaultDataDir).toBe(defaultDataDir);
    expect(config.defaultHome).toBe(defaultHome);
    expect(config.getConfigMeta).toBe(getConfigMeta);
    expect(config.getConfigValue).toBe(getConfigValue);
    expect(config.initConfig).toBe(initConfig);
    expect(config.readConfigFile).toBe(readConfigFile);
    expect(config.resetConfigMeta).toBe(resetConfigMeta);
    expect(config.resolveConfigReadonly).toBe(resolveConfigReadonly);
    expect(config.setConfigValue).toBe(setConfigValue);
    expect(config.defineConfig).toBe(defineConfig);
    expect(config.field).toBe(field);
    expect(config.optional).toBe(optional);
    expect(config.getServerConfig).toBe(getServerConfig);
    expect(config.serverConfigSchema).toBe(serverConfigSchema);
    expect(config.getConfig).toBe(getConfig);
    expect(config.resetConfig).toBe(resetConfig);
  });
});
