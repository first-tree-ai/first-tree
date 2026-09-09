import { randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { AgentRuntimeConfigPayload } from "@first-tree/shared";

const MANAGED_NAME_PREFIX = "first-tree-managed-";
const MANAGED_MANIFEST_NAME = ".mcp_config.first-tree.json";

type ManagedManifest = {
  version: 1;
  servers: Record<string, AntigravityMcpConfig>;
  nextServers?: Record<string, AntigravityMcpConfig>;
};

type ParsedManagedManifest = {
  current: Record<string, AntigravityMcpConfig>;
  next: Record<string, AntigravityMcpConfig>;
};

export type AntigravityMcpConfig =
  | { command: string; args: string[] }
  | { serverUrl: string; headers?: Record<string, string> };

function object(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function isMcpConfig(value: unknown): value is AntigravityMcpConfig {
  const row = object(value);
  if (!row) return false;
  if (typeof row.command === "string" && Array.isArray(row.args) && row.args.every((arg) => typeof arg === "string")) {
    return true;
  }
  if (typeof row.serverUrl !== "string") return false;
  if (row.headers === undefined) return true;
  const headers = object(row.headers);
  return Boolean(headers && Object.values(headers).every((header) => typeof header === "string"));
}

function sameJson(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (Array.isArray(left) || Array.isArray(right)) {
    return (
      Array.isArray(left) &&
      Array.isArray(right) &&
      left.length === right.length &&
      left.every((item, index) => sameJson(item, right[index]))
    );
  }
  const leftObject = object(left);
  const rightObject = object(right);
  if (!leftObject || !rightObject) return false;
  const leftKeys = Object.keys(leftObject).sort();
  const rightKeys = Object.keys(rightObject).sort();
  return (
    leftKeys.length === rightKeys.length &&
    leftKeys.every((key, index) => key === rightKeys[index] && sameJson(leftObject[key], rightObject[key]))
  );
}

function parseManagedServers(value: unknown, label: string): Record<string, AntigravityMcpConfig> {
  const row = object(value);
  if (!row) throw new Error("Antigravity managed MCP " + label + " must be an object");
  const servers: Record<string, AntigravityMcpConfig> = {};
  for (const [name, config] of Object.entries(row)) {
    if (!name.startsWith(MANAGED_NAME_PREFIX)) {
      throw new Error("Antigravity managed MCP " + label + " contains an unreserved server name " + name);
    }
    if (!isMcpConfig(config)) {
      throw new Error("Antigravity managed MCP " + label + " contains an invalid server " + name);
    }
    servers[name] = config;
  }
  return servers;
}

function parseManagedManifest(value: unknown): ParsedManagedManifest {
  const row = object(value);
  if (!row || row.version !== 1) throw new Error("Antigravity managed MCP manifest has an unsupported version");
  const current = parseManagedServers(row.servers, "manifest");
  const next = row.nextServers === undefined ? {} : parseManagedServers(row.nextServers, "transition");
  return { current, next };
}

function mcpServersFromConfig(existing: unknown): Record<string, unknown> {
  if (existing === undefined) return {};
  const root = object(existing);
  if (!root) throw new Error("Antigravity MCP config must be an object");
  if (root.mcpServers === undefined) return {};
  const servers = object(root.mcpServers);
  if (!servers) throw new Error("Antigravity MCP config has a non-object mcpServers field");
  return servers;
}

function selectManagedOwnership(
  existing: unknown,
  manifest: ParsedManagedManifest,
): Record<string, AntigravityMcpConfig> {
  const servers = mcpServersFromConfig(existing);
  const selected: Record<string, AntigravityMcpConfig> = {};
  const names = new Set([...Object.keys(manifest.current), ...Object.keys(manifest.next)]);
  for (const name of names) {
    const onDisk = servers[name];
    const next = manifest.next[name];
    const current = manifest.current[name];
    if (onDisk === undefined) {
      if (current) selected[name] = current;
      continue;
    }
    if (next && sameJson(onDisk, next)) {
      selected[name] = next;
      continue;
    }
    if (current && sameJson(onDisk, current)) {
      selected[name] = current;
      continue;
    }
    throw new Error("Antigravity managed MCP server was modified outside First Tree: " + name);
  }
  return selected;
}

function serializeManagedManifest(manifest: ManagedManifest): string {
  return JSON.stringify(manifest, null, 2) + "\n";
}

async function readRegularJson(path: string, label: string): Promise<unknown | undefined> {
  try {
    const stat = await lstat(path);
    if (stat.isSymbolicLink() || !stat.isFile()) {
      throw new Error("Antigravity " + label + " is not a regular file");
    }
    return JSON.parse(await readFile(path, "utf8")) as unknown;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

async function writeAtomic(path: string, content: string, label: string): Promise<void> {
  const temporaryPath = path + "." + process.pid + "." + randomUUID() + ".tmp";
  try {
    await writeFile(temporaryPath, content, { encoding: "utf8", mode: 0o600, flag: "wx" });
    await rename(temporaryPath, path);
  } catch (error) {
    try {
      await unlink(temporaryPath);
    } catch {
      // Best effort cleanup; the unique temp name is not provider-visible.
    }
    throw new Error(
      "Unable to project Antigravity " + label + ": " + (error instanceof Error ? error.message : String(error)),
      { cause: error },
    );
  }
}

export function mapAntigravityMcpServers(payload: AgentRuntimeConfigPayload): Record<string, AntigravityMcpConfig> {
  const out: Record<string, AntigravityMcpConfig> = {};
  for (const [index, server] of payload.mcpServers.entries()) {
    const name = `${MANAGED_NAME_PREFIX}${index + 1}`;
    if (server.transport === "stdio") {
      out[name] = { command: server.command, args: server.args ?? [] };
    } else {
      out[name] = {
        serverUrl: server.url,
        ...(server.headers ? { headers: server.headers } : {}),
      };
    }
  }
  return out;
}

/**
 * Merge only the reserved First Tree entries into a provider workspace config.
 * Existing user entries are retained; collisions with the reserved namespace
 * fail closed instead of overwriting credentials or server definitions.
 */
export function mergeAntigravityMcpConfig(
  existing: unknown,
  managed: Record<string, AntigravityMcpConfig>,
  previousManaged: Record<string, AntigravityMcpConfig> = {},
): Record<string, unknown> {
  const root =
    existing === undefined
      ? {}
      : (() => {
          const value = object(existing);
          if (!value) throw new Error("Antigravity MCP config must be an object");
          return { ...value };
        })();
  const servers: Record<string, unknown> = { ...mcpServersFromConfig(existing) };
  for (const [name, config] of Object.entries(previousManaged)) {
    if (!name.startsWith(MANAGED_NAME_PREFIX) || !isMcpConfig(config)) {
      throw new Error("Antigravity previous MCP ownership contains an invalid server " + name);
    }
    const existingConfig = servers[name];
    if (existingConfig === undefined) continue;
    if (!sameJson(existingConfig, config)) {
      throw new Error("Antigravity managed MCP server was modified outside First Tree: " + name);
    }
    delete servers[name];
  }
  for (const name of Object.keys(servers)) {
    if (name.startsWith(MANAGED_NAME_PREFIX)) {
      throw new Error("Antigravity MCP config reserves the server name " + name);
    }
  }
  for (const [name, config] of Object.entries(managed)) {
    if (!name.startsWith(MANAGED_NAME_PREFIX) || !isMcpConfig(config)) {
      throw new Error("Antigravity managed MCP contains an invalid server " + name);
    }
    if (servers[name] !== undefined) {
      throw new Error(`Antigravity MCP config reserves the server name ${name}`);
    }
    servers[name] = config;
  }
  root.mcpServers = servers;
  return root;
}

/** Render the exact JSON bytes used by the workspace projection. */
export function buildAntigravityMcpConfigContent(
  existing: unknown,
  payload: AgentRuntimeConfigPayload,
  previousManaged: Record<string, AntigravityMcpConfig> = {},
): string {
  return (
    JSON.stringify(mergeAntigravityMcpConfig(existing, mapAntigravityMcpServers(payload), previousManaged), null, 2) +
    "\n"
  );
}

/**
 * Atomically project managed MCP entries into Antigravity's documented
 * workspace `.agents/mcp_config.json` file. The projection is intentionally
 * persistent: Antigravity resolves MCP from this workspace path, and the
 * next turn removes/replaces only First Tree's reserved entries.
 */
export async function projectAntigravityMcpConfig(
  workspace: string,
  payload: AgentRuntimeConfigPayload,
): Promise<string | null> {
  const agentsDir = join(workspace, ".agents");
  const configPath = join(agentsDir, "mcp_config.json");
  const manifestPath = join(agentsDir, MANAGED_MANIFEST_NAME);
  let agentsDirPresent = false;
  try {
    const stat = await lstat(agentsDir);
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new Error("Antigravity .agents is not a regular directory");
    }
    agentsDirPresent = true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }

  const existing = await readRegularJson(configPath, "MCP config");
  const manifestValue = await readRegularJson(manifestPath, "managed MCP manifest");
  const manifest = manifestValue === undefined ? { current: {}, next: {} } : parseManagedManifest(manifestValue);
  const managed = mapAntigravityMcpServers(payload);
  const managedNames = Object.keys(managed);
  const manifestNames = [...Object.keys(manifest.current), ...Object.keys(manifest.next)];

  if (existing === undefined && managedNames.length === 0) {
    if (manifestValue !== undefined) {
      try {
        await unlink(manifestPath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
    return null;
  }

  const physicalOwnership = selectManagedOwnership(existing, manifest);
  if (existing !== undefined && managedNames.length === 0 && manifestNames.length === 0) {
    // Validate the reserved namespace without rewriting an unrelated user
    // config when First Tree has no servers to project.
    mergeAntigravityMcpConfig(existing, {}, physicalOwnership);
    return configPath;
  }

  const content = buildAntigravityMcpConfigContent(existing, payload, physicalOwnership);
  const oldContent = existing === undefined ? null : JSON.stringify(existing, null, 2) + "\n";
  const stableManifest = managedNames.length === 0 ? null : serializeManagedManifest({ version: 1, servers: managed });
  const transitionManifest =
    managedNames.length === 0 && manifestNames.length === 0
      ? null
      : serializeManagedManifest({
          version: 1,
          servers: physicalOwnership,
          ...(managedNames.length > 0 ? { nextServers: managed } : {}),
        });
  const oldManifestContent = manifestValue === undefined ? null : JSON.stringify(manifestValue, null, 2) + "\n";

  if (!agentsDirPresent) {
    await mkdir(agentsDir, { recursive: true, mode: 0o700 });
    agentsDirPresent = true;
  }
  if (transitionManifest && oldManifestContent !== transitionManifest) {
    // The transition record is written first so an interrupted config
    // replacement still leaves enough ownership information to recover.
    await writeAtomic(manifestPath, transitionManifest, "MCP manifest");
  }
  if (oldContent !== content) {
    await writeAtomic(configPath, content, "MCP config");
  }
  if (stableManifest && stableManifest !== transitionManifest) {
    await writeAtomic(manifestPath, stableManifest, "MCP manifest");
  } else if (!stableManifest && manifestValue !== undefined) {
    try {
      await unlink(manifestPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  return existing === undefined && managedNames.length === 0 ? null : configPath;
}
