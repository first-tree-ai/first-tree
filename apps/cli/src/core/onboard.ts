import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { defaultConfigDir, defaultHome, setConfigValue } from "@first-tree/shared/config";
import { credentialForOrigin } from "./access-token.js";
import { loadCredentials, resolveServerUrl, saveAgentConfig } from "./bootstrap.js";
import { channelConfig } from "./channel.js";
import { cliFetch } from "./cli-fetch.js";
import { print } from "./output.js";

// ── Types ────────────────────────────────────────────────────────────

type OnboardArgs = {
  id: string;
  type: "human" | "agent";
  clientId?: string;
  role?: string;
  domains?: string;
  displayName?: string;
  assistant?: string;
  delegateMention?: string;
  server?: string;
};

type CheckItem = {
  key: string;
  label: string;
  status: "ok" | "missing_required" | "missing_optional" | "warning" | "error";
  value?: string;
  hint?: string;
};

// Function rather than top-level const: a `const = join(defaultHome(), …)`
// would lock at module load — same bundle hoist foot-gun that
// motivated function-izing the resolver. See `channel-env.ts` history
// note and `__tests__/no-toplevel-default-home-const.test.ts`.
function stateFile(): string {
  return join(defaultHome(), ".onboard-state.json");
}

/** Save current onboard args to state file for resume. */
export function saveOnboardState(args: Record<string, unknown>): void {
  mkdirSync(defaultHome(), { recursive: true });
  writeFileSync(stateFile(), JSON.stringify({ args }, null, 2));
}

/** Load saved onboard args from state file. */
export function loadOnboardState(): Record<string, unknown> | null {
  try {
    const data = JSON.parse(readFileSync(stateFile(), "utf-8")) as { args: Record<string, unknown> };
    return data.args;
  } catch {
    return null;
  }
}

// ── Check mode ───────────────────────────────────────────────────────

export async function onboardCheck(args: OnboardArgs): Promise<CheckItem[]> {
  const items: CheckItem[] = [];

  const creds = loadCredentials();
  if (creds) {
    items.push({ key: "connect", label: "Signed in", status: "ok", value: creds.serverUrl });
  } else {
    items.push({
      key: "connect",
      label: "Signed in",
      status: "missing_required",
      hint: `Run \`${channelConfig.binName} login <code>\` first`,
    });
  }

  try {
    const serverUrl = resolveServerUrl(args.server);
    items.push({ key: "server", label: "Server URL", status: "ok", value: serverUrl });

    try {
      const res = await cliFetch(`${serverUrl}/api/v1/health`);
      items.push({
        key: "server_reachable",
        label: "Server reachable",
        status: res.ok ? "ok" : "error",
        value: res.ok ? "healthy" : `HTTP ${res.status}`,
      });
    } catch {
      items.push({
        key: "server_reachable",
        label: "Server reachable",
        status: "error",
        hint: "Cannot connect to server",
      });
    }
  } catch {
    items.push({
      key: "server",
      label: "Server URL",
      status: "missing_required",
      hint: "Provide via --server, FIRST_TREE_SERVER_URL, or config",
    });
  }

  if (args.id) {
    items.push({ key: "id", label: "Agent ID", status: "ok", value: args.id });
  } else {
    items.push({ key: "id", label: "Agent ID", status: "missing_required", hint: "Provide via --id" });
  }

  if (args.type) {
    items.push({ key: "type", label: "Agent type", status: "ok", value: args.type });
  } else {
    items.push({ key: "type", label: "Agent type", status: "missing_required", hint: "Provide via --type" });
  }

  if (args.type && args.type !== "human") {
    if (args.clientId) {
      items.push({ key: "client", label: "Target client", status: "ok", value: args.clientId });
    } else {
      items.push({
        key: "client",
        label: "Target client",
        status: "ok",
        value: "(unbound — claimed on first WS connect)",
      });
    }
  }

  return items;
}

export function formatCheckReport(items: CheckItem[]): string {
  const lines: string[] = [];
  for (const item of items) {
    const icon =
      item.status === "ok"
        ? "\u2705"
        : item.status === "missing_required"
          ? "\u274C"
          : item.status === "error"
            ? "\u274C"
            : item.status === "warning"
              ? "\u26A0\uFE0F"
              : "\u2B1C";
    const valueStr = item.value ? `  ${item.value}` : "";
    const hintStr = item.hint ? `  (${item.hint})` : "";
    lines.push(`  ${icon} ${item.label.padEnd(20)}${valueStr}${hintStr}`);
  }
  return lines.join("\n");
}

// ── Create flow ──────────────────────────────────────────────────────

async function resolveDefaultOrgId(serverUrl: string, accessToken: string): Promise<string> {
  const res = await cliFetch(`${serverUrl}/api/v1/me`, {
    headers: { Authorization: `Bearer ${accessToken}` },
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`/me HTTP ${res.status}`);
  const me = (await res.json()) as {
    memberships: Array<{ organizationId: string; organizationName: string }>;
    defaultOrganizationId?: string | null;
  };
  if (me.defaultOrganizationId && me.memberships.some((m) => m.organizationId === me.defaultOrganizationId)) {
    return me.defaultOrganizationId;
  }
  if (me.memberships.length === 1 && me.memberships[0]) return me.memberships[0].organizationId;
  if (me.memberships.length === 0) throw new Error("You don't belong to any organization");
  throw new Error("Multiple organizations — pass --org explicitly to onboard");
}

async function createAgentViaAdmin(
  serverUrl: string,
  accessToken: string,
  orgId: string,
  body: Record<string, unknown>,
): Promise<{ uuid: string; name: string | null }> {
  const res = await cliFetch(`${serverUrl}/api/v1/orgs/${encodeURIComponent(orgId)}/agents`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) {
    const errBody = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(errBody.error ?? `Failed to create agent (HTTP ${res.status})`);
  }
  return (await res.json()) as { uuid: string; name: string | null };
}

export async function onboardCreate(args: OnboardArgs): Promise<void> {
  const serverUrl = resolveServerUrl(args.server).replace(/\/+$/, "");
  // One binding for every request this flow makes: the agent lookup, the org
  // lookup and each created agent carry the same issuing origin (SEC-023).
  const credential = await credentialForOrigin(serverUrl);
  const accessToken = credential.token;

  const metadata: Record<string, unknown> = {};
  if (args.role) metadata.role = args.role;
  if (args.domains) metadata.domains = args.domains.split(",").map((d) => d.trim());

  print.line(`Creating agent "${args.id}"...\n`);
  const orgId = await resolveDefaultOrgId(serverUrl, accessToken);
  const primary = await createAgentViaAdmin(serverUrl, accessToken, orgId, {
    name: args.id,
    type: args.type,
    displayName: args.displayName ?? args.id,
    delegateMention: args.assistant ?? args.delegateMention,
    metadata: Object.keys(metadata).length > 0 ? metadata : undefined,
    clientId: args.type === "human" ? undefined : args.clientId,
  });
  // Phase 3: always prefer the server-returned `name` over the submitted
  // `args.id`. The two usually agree, but the server may normalise or
  // reject on collision and a subsequent rename would be needed on first
  // start. Using `primary.name` here keeps the log message, local dir key,
  // and the server's view aligned from the outset. The `?? args.id` fallback
  // covers servers that (for some reason) return a null name — the
  // idempotent migration on next start will reconcile.
  const primaryLocalName = primary.name ?? args.id;
  print.line(`Agent "${primaryLocalName}" created (uuid ${primary.uuid}).\n`);

  if (args.type !== "human") {
    saveAgentConfig(primaryLocalName, primary.uuid, "claude-code");
  }

  if (args.assistant) {
    print.line(`Creating assistant "${args.assistant}"...\n`);
    try {
      const assistant = await createAgentViaAdmin(serverUrl, accessToken, orgId, {
        name: args.assistant,
        type: "agent",
        // Personal-assistant framing is now carried by visibility=private.
        // The server's `defaultVisibility("agent")` returns "organization"
        // (the autonomous-bot default), so callers wanting the
        // personal-assistant framing MUST pass `visibility: "private"`
        // explicitly — otherwise this assistant would surface as an
        // org-visible agent.
        visibility: "private",
        displayName: args.assistant,
        metadata: { role: `Personal Assistant to ${args.id}`, domains: ["message triage", "task coordination"] },
        clientId: args.clientId,
      });
      const assistantLocalName = assistant.name ?? args.assistant;
      saveAgentConfig(assistantLocalName, assistant.uuid, "claude-code");
      print.line(`Assistant "${assistantLocalName}" ready.\n`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      print.line(`Warning: Failed to create assistant "${args.assistant}": ${msg}\n`);
    }
  }

  const runtimeAgent = args.type === "human" ? args.assistant : args.id;

  const clientConfigPath = join(defaultConfigDir(), "client.yaml");
  setConfigValue(clientConfigPath, "server.url", serverUrl);

  try {
    const { unlinkSync } = await import("node:fs");
    unlinkSync(stateFile());
  } catch {
    // Ignore
  }

  const typeLabel = args.type === "human" ? "Human" : "Agent";
  print.line("\n\u2705 Onboard complete!\n\n");
  print.line(`  ${typeLabel}:${" ".repeat(Math.max(1, 10 - typeLabel.length))}${args.id}\n`);
  if (args.assistant) {
    print.line(`  Assistant: ${args.assistant}\n`);
  }
  if (runtimeAgent) {
    print.line(`  Config:    ${defaultHome()}/config/agents/${runtimeAgent}/agent.yaml\n`);
  }

  if (runtimeAgent) {
    print.line("\n  Start the agent:\n");
    print.line(`    ${channelConfig.binName} daemon start\n`);
  }
  print.line("\n");
}
