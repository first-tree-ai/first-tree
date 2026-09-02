import type { Stats } from "node:fs";
import { lstatSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { FirstTreeHubSDK, probeCapabilities } from "@first-tree/client";
import {
  clientConfigSchema,
  defaultDataDir,
  defaultHome,
  initConfig,
  readContextTreeRepository,
  resetConfig,
  resetConfigMeta,
} from "@first-tree/shared/config";
import { z } from "zod";
import type { CheckResult } from "../../core/doctor.js";
import {
  CLI_USER_AGENT,
  checkAgentConfigs,
  checkBackgroundService,
  checkClientConfig,
  checkDaemonRuntimeOwnership,
  checkNodeVersion,
  checkServerReachable,
  checkWebSocket,
  ensureFreshAccessToken,
  inspectLocalContextTree,
  listLocalContextDataLoss,
  reconcileAgentConfigs,
  resolveContextTreeCli,
  resolveServerUrl,
  runContextTreeCommand,
  runtimeProviderChecks,
} from "../../core/index.js";
import { verifyTreeRoot } from "../tree/verify.js";

/**
 * Runtime-provider readiness: a resolve-only capability detection per built-in
 * provider, rendered one CheckResult per provider. Detection only locates each
 * provider's executable and checks platform support — it never launches the
 * provider, checks authentication, or makes model calls, so it stays cheap;
 * provider credentials are validated on the first real provider turn.
 * Detection failures are captured per-provider (never thrown), so this never
 * rejects.
 */
export async function checkRuntimeProviders(): Promise<CheckResult[]> {
  return runtimeProviderChecks(await probeCapabilities());
}

const doctorIdentitySchema = z
  .object({
    agentId: z.string().min(1),
    agentName: z.string().min(1),
    contextSourceKind: z.enum(["remote", "local", "none"]),
    contextTreePath: z.string().min(1).nullable(),
    serverUrl: z.string().url(),
  })
  .passthrough();

const doctorRemoteLatchSchema = z
  .object({
    branch: z.string().min(1),
    observedAt: z.string().min(1),
    remoteObserved: z.literal(true),
    repoUrl: z.string().min(1),
    schemaVersion: z.literal(1),
  })
  .strict();

/**
 * External Context Tree mode readiness.
 *
 * Off is a healthy state, not a gap: an unconfigured machine keeps First Tree's
 * own Context Tree Skills. When it IS configured, the packaged CLI must be
 * resolvable or the `context-tree-*` Skills were never installed.
 */
export async function checkContextTreeCli(): Promise<CheckResult> {
  const repository = readContextTreeRepository();
  if (!repository) {
    return { label: "Context Tree CLI", ok: true, detail: "external mode off (context_tree.repository unset)" };
  }
  if (!resolveContextTreeCli()) {
    return {
      label: "Context Tree CLI",
      ok: false,
      detail: `configured for ${repository} but @first-tree-ai/context-tree is not installed beside this CLI`,
    };
  }
  // `list` is the cheapest JSON-emitting probe: no connection, no network, and
  // it tolerates an absent managed root. `--version` prints a bare string, so it
  // is not usable through the JSON envelope parser.
  const probe = await runContextTreeCommand(["list"]);
  if (!probe.ok) {
    return { label: "Context Tree CLI", ok: false, detail: `${repository}: ${probe.reason}` };
  }
  return { label: "Context Tree CLI", ok: true, detail: `external mode on (${repository})` };
}

export function checkLocalContexts(): CheckResult {
  const contexts = listLocalContextDataLoss({ dataDir: defaultDataDir(), home: defaultHome() });
  if (contexts.length === 0) {
    return { label: "Local Context", ok: true, detail: "no Agent Local Context directories" };
  }

  const problems: string[] = [];
  let active = 0;
  let frozen = 0;
  for (const context of contexts) {
    try {
      inspectLocalContextTree(context.path);
      const verification = verifyTreeRoot(context.path);
      if (!verification.ok) problems.push(`${context.agentName}: tree verify failed`);

      const workspace = dirname(context.path);
      const identityPath = join(workspace, ".first-tree-workspace", "identity.json");
      let identityEntry: Stats;
      try {
        identityEntry = lstatSync(identityPath);
      } catch (error) {
        if (typeof error === "object" && error !== null && "code" in error && Reflect.get(error, "code") === "ENOENT") {
          problems.push(`${context.agentName}: identity.json is missing`);
        } else {
          problems.push(`${context.agentName}: identity.json cannot be inspected`);
        }
        continue;
      }
      if (identityEntry.isSymbolicLink() || !identityEntry.isFile()) {
        problems.push(`${context.agentName}: identity.json is not a trusted regular file`);
        continue;
      }
      let identityText: string;
      try {
        identityText = readFileSync(identityPath, "utf8");
      } catch {
        problems.push(`${context.agentName}: identity.json is unreadable`);
        continue;
      }
      let identity: z.infer<typeof doctorIdentitySchema>;
      try {
        identity = doctorIdentitySchema.parse(JSON.parse(identityText));
      } catch {
        problems.push(`${context.agentName}: identity.json is malformed or incomplete`);
        continue;
      }
      if (identity.agentName !== context.agentName) {
        problems.push(`${context.agentName}: identity agentName mismatch`);
      }
      if (identity.contextSourceKind === "local" && resolve(identity.contextTreePath ?? "") !== resolve(context.path)) {
        problems.push(`${context.agentName}: Local identity contextTreePath mismatch`);
      }

      const statePath = join(workspace, ".first-tree-workspace", "source-state.json");
      try {
        const stateEntry = lstatSync(statePath);
        if (stateEntry.isSymbolicLink() || !stateEntry.isFile()) {
          problems.push(`${context.agentName}: source-state.json is not a trusted regular file`);
          continue;
        }
        doctorRemoteLatchSchema.parse(JSON.parse(readFileSync(statePath, "utf8")));
        frozen += 1;
      } catch (error) {
        if (typeof error === "object" && error !== null && "code" in error && Reflect.get(error, "code") === "ENOENT") {
          if (identity.contextSourceKind !== "local") {
            problems.push(`${context.agentName}: Local tree has neither local identity nor remote latch`);
          } else {
            active += 1;
          }
        } else if (error instanceof z.ZodError || error instanceof SyntaxError) {
          problems.push(`${context.agentName}: corrupt or unsupported source-state.json`);
        } else {
          problems.push(`${context.agentName}: unreadable source-state.json`);
        }
      }
    } catch (error) {
      problems.push(`${context.agentName}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  return {
    label: "Local Context",
    ok: problems.length === 0,
    detail:
      problems.length === 0
        ? `${contexts.length} found (${active} active, ${frozen} frozen), identity/containment/limits/verify healthy`
        : problems.slice(0, 4).join("; "),
  };
}

/**
 * Daemon-side readiness checks. Shared by `daemon doctor` (which renders
 * exactly this list) and the top-level `doctor` (which will append cross-
 * subsystem checks once more package-specific checks are wired through). Keeping
 * the check list in one place means a regression / new check only gets
 * authored once.
 *
 * Returns the same shape `printResults` expects so callers can render it
 * directly, or splice it into a larger array before rendering.
 */
export async function runDaemonChecks(): Promise<CheckResult[]> {
  // The "Agents" line cross-references local aliases against the server's
  // pinned-agent set, filtered to THIS client.id (so the verdict matches
  // what R-RUN will accept). Without a configured server URL we can't talk
  // to anything; fall back to the legacy local-only count.
  let agentCheck: CheckResult;
  try {
    const serverUrl = resolveServerUrl();
    const cfg = await initConfig({ schema: clientConfigSchema, role: "client" });
    const sdk = new FirstTreeHubSDK({
      serverUrl,
      getAccessToken: (opts) => ensureFreshAccessToken(opts),
      userAgent: CLI_USER_AGENT,
    });
    agentCheck = await reconcileAgentConfigs({
      clientId: cfg.client.id,
      listPinnedAgents: () => sdk.listMyAgents(),
    });
  } catch {
    agentCheck = checkAgentConfigs();
  } finally {
    // Doctor is read-only; release the singleton so subsequent commands
    // re-resolve config cleanly.
    resetConfig();
    resetConfigMeta();
  }

  return [
    checkNodeVersion(),
    checkClientConfig(),
    await checkServerReachable(),
    agentCheck,
    await checkWebSocket(),
    checkBackgroundService(),
    checkDaemonRuntimeOwnership(),
    checkLocalContexts(),
    await checkContextTreeCli(),
    ...(await checkRuntimeProviders()),
  ];
}
