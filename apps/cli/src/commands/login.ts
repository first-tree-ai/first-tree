import { join } from "node:path";
import { ClientOrgMismatchError } from "@first-tree/client";
import {
  agentConfigSchema,
  type ClientConfig,
  clientConfigSchema,
  defaultConfigDir,
  defaultDataDir,
  initConfig,
  loadAgents,
  resetConfig,
  resetConfigMeta,
  setConfigValue,
} from "@first-tree/shared/config";
import type { Command } from "commander";
import { fail } from "../cli/output.js";
import { channelConfig } from "../core/channel.js";
import {
  ClientRuntime,
  COMMAND_VERSION,
  cliFetch,
  confirmLocalClientSwitch,
  createApiNameResolver,
  createExecuteUpdate,
  ensureActiveRootClientIdPersisted,
  ensureContextTreeSkills,
  ensureFreshAccessToken,
  formatContextTreeSetupReport,
  getClientServiceStatus,
  handleClientOrgMismatch,
  hasIncompleteClientSwitch,
  installClientService,
  isServiceSupported,
  loadCredentials,
  migrateLocalAgentDirs,
  promptUpdate,
  readActiveClientOwner,
  readActiveRootClientId,
  readRememberedLocalClientIdForAccount,
  recordActiveClientOwner,
  refreshServerUpdateTarget,
  resolveClientRuntimeStopReason,
  restartClientService,
  saveCredentials,
  switchLocalClientForLogin,
} from "../core/index.js";
import { print } from "../core/output.js";
import { shouldRestartServiceAfterRefresh } from "../core/service-recovery.js";
import { decodeJwtPayload, deriveHubUrlFromToken, HubUrlDerivationError } from "./_shared/connect-token.js";

/** Owning user id (`sub`) from a server-issued JWT, or null if undecodable. */
function readOwnerSub(token: string | undefined): string | null {
  if (!token) return null;
  const payload = decodeJwtPayload(token);
  return typeof payload?.sub === "string" ? payload.sub : null;
}

async function exchangeToken(url: string, token: string): Promise<{ accessToken: string; refreshToken: string }> {
  const res = await cliFetch(`${url}/api/v1/auth/connect-token`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    const message =
      body.error === "Invalid or expired connect token"
        ? "This connect code is expired or has already been used. Ask the user for a fresh setup prompt from First Tree Settings; never reuse this code."
        : (body.error ?? `Token exchange failed (HTTP ${res.status})`);
    fail("AUTH_ERROR", message, 1);
  }
  return (await res.json()) as { accessToken: string; refreshToken: string };
}

async function readServerClientStatus(url: string, accessToken: string, clientId: string): Promise<string | null> {
  try {
    const res = await cliFetch(`${url}/api/v1/clients/${encodeURIComponent(clientId)}`, {
      method: "GET",
      headers: { Authorization: `Bearer ${accessToken}` },
      signal: AbortSignal.timeout(10_000),
    });
    if (res.status === 404 || !res.ok) return null;
    const body = (await res.json().catch(() => null)) as { status?: unknown } | null;
    return typeof body?.status === "string" ? body.status : null;
  } catch {
    return null;
  }
}

async function assertReusableClientAccepted(url: string, accessToken: string, clientId: string): Promise<void> {
  const status = await readServerClientStatus(url, accessToken, clientId);
  if (status !== "retired") return;
  fail(
    "CLIENT_RETIRED_REQUIRES_RESET",
    `Client "${clientId}" has been retired. Run \`${channelConfig.binName} computer reset\`, then run \`${channelConfig.binName} login <code>\` with a fresh connect code.`,
    1,
  );
}

/**
 * `login <code>` — single entry point. Short connect codes route through the
 * current CLI channel's default server URL, unless FIRST_TREE_SERVER_URL is set.
 * Legacy JWT connect tokens still carry their own server URL, so already-issued
 * rollout JWTs remain accepted.
 *
 * Account switches are explicit local-client switches. The stored access token
 * owner is compared with the new server-issued access token's `sub` claim; a
 * mismatch prompts in TTY mode, requires `--force-switch` in non-TTY mode, then
 * stops/drains the current runtime before moving root state.
 */
export function registerLoginCommand(program: Command): void {
  program
    .command("login <code>")
    .description("Sign this computer into First Tree using a short code from the web console")
    .option("--no-start", "Skip background daemon install/start (writes credentials and exits)")
    .option("--force-switch", "Confirm switching this computer to a different First Tree user in non-TTY mode")
    .action(async (token: string, options: { start?: boolean; forceSwitch?: boolean }) => {
      try {
        const connectToken = token.trim();
        const fallbackServerUrl = process.env.FIRST_TREE_SERVER_URL?.trim() || channelConfig.defaultServerUrl;
        let url: string;
        try {
          url = deriveHubUrlFromToken(connectToken, fallbackServerUrl);
        } catch (err) {
          if (err instanceof HubUrlDerivationError) {
            fail(err.code, err.message, 1);
          }
          throw err;
        }

        const configDir = defaultConfigDir();
        const rootClientIdBeforeLogin = readActiveRootClientId(configDir);
        let reusedLocalClientIdentity = false;
        const existingCredentials = loadCredentials();
        const previousOwnerSub = readOwnerSub(existingCredentials?.accessToken);
        const rememberedOwner = readActiveClientOwner();

        const tokens = await exchangeToken(url, connectToken);
        const newOwnerSub = readOwnerSub(tokens.accessToken);
        if (!newOwnerSub) {
          fail("AUTH_ERROR", "Server access token is missing the required `sub` claim.", 1);
        }
        let config: ClientConfig | null = null;
        if (existingCredentials && !previousOwnerSub) {
          fail(
            "CLIENT_OWNER_UNKNOWN_REQUIRES_RESET_OR_OWNER_LOGIN",
            "Existing credentials do not expose an owner user id, so First Tree cannot safely decide whether this is a same-user refresh or account switch.",
            1,
          );
        }
        if (hasIncompleteClientSwitch()) {
          config = await switchLocalClientForLogin({
            targetTokens: { ...tokens, serverUrl: url },
            targetOwnerSub: newOwnerSub,
          });
          reusedLocalClientIdentity = true;
          print.line("\n  ✓ Interrupted local client switch recovered\n");
        }
        const existingOwnerSub = previousOwnerSub;
        const switchFrom = config
          ? null
          : existingCredentials && existingOwnerSub && existingOwnerSub !== newOwnerSub
            ? { serverUrl: existingCredentials.serverUrl, userId: existingOwnerSub }
            : rememberedOwner && rememberedOwner.userId !== newOwnerSub
              ? { serverUrl: rememberedOwner.serverUrl, userId: rememberedOwner.userId }
              : null;
        if (switchFrom) {
          await confirmLocalClientSwitch({
            existingServerUrl: switchFrom.serverUrl,
            targetServerUrl: url,
            existingUserId: switchFrom.userId,
            targetUserId: newOwnerSub,
            existingClientId: readActiveRootClientId(configDir) ?? rememberedOwner?.clientId,
            targetClientId: readRememberedLocalClientIdForAccount(url, newOwnerSub) ?? undefined,
            forceSwitch: options.forceSwitch === true,
          });
          config = await switchLocalClientForLogin({
            existingCredentials: {
              accessToken: existingCredentials?.accessToken ?? "",
              refreshToken: existingCredentials?.refreshToken ?? "",
              serverUrl: switchFrom.serverUrl,
            },
            previousOwnerSub: switchFrom.userId,
            targetTokens: { ...tokens, serverUrl: url },
            targetOwnerSub: newOwnerSub,
          });
          reusedLocalClientIdentity = true;
          print.line("\n  ✓ Previous local client parked\n");
        }
        if (!existingCredentials && !rememberedOwner && rootClientIdBeforeLogin) {
          fail(
            "CLIENT_OWNER_UNKNOWN_REQUIRES_RESET_OR_OWNER_LOGIN",
            `Existing client.yaml has no credentials or remembered owner metadata, so First Tree cannot safely decide whether this is a same-user reconnect or account switch. Run \`${channelConfig.binName} computer reset\` after backing up local state, or restore/log in from a state that still has the current owner's credentials.`,
            1,
          );
        }

        print.line(`\n  ✓ Server: ${url}\n`);

        if (!config) {
          const clientConfigPath = join(configDir, "client.yaml");
          setConfigValue(clientConfigPath, "server.url", url);
          saveCredentials({ ...tokens, serverUrl: url });

          resetConfig();
          resetConfigMeta();
          config = await initConfig({ schema: clientConfigSchema, role: "client" });
          reusedLocalClientIdentity = reusedLocalClientIdentity || rootClientIdBeforeLogin === config.client.id;
          ensureActiveRootClientIdPersisted(config.client.id, configDir);
          recordActiveClientOwner({ clientId: config.client.id, userId: newOwnerSub, serverUrl: url });
        }
        if (reusedLocalClientIdentity) {
          await assertReusableClientAccepted(url, tokens.accessToken, config.client.id);
        }
        print.line("  ✓ Authenticated\n");
        print.line(`  ✓ Computer registered (id: ${config.client.id})\n`);

        // External Context Tree mode, when `context_tree.repository` is set.
        // Best-effort: a machine that cannot install or clone still logs in.
        const contextTree = await ensureContextTreeSkills();
        if (contextTree.status === "installed") {
          print.line(`  ✓ ${formatContextTreeSetupReport(contextTree)}\n`);
        } else if (contextTree.status === "failed") {
          print.line(`  ⚠️  ${formatContextTreeSetupReport(contextTree)}\n`);
        } else if (contextTree.status === "removed" && (contextTree.removedSkillPaths?.length ?? 0) > 0) {
          print.line(`  ✓ ${formatContextTreeSetupReport(contextTree)}\n`);
        }

        const shouldInstallService = options.start !== false && isServiceSupported();
        if (shouldInstallService) {
          const beforeService = getClientServiceStatus();
          const info = installClientService();
          if (shouldRestartServiceAfterRefresh(beforeService)) {
            const restart = restartClientService();
            if (!restart.ok) {
              print.line(`\n  Background service refreshed but restart failed: ${restart.reason}\n`);
              print.line(`  Run \`${channelConfig.binName} daemon restart\` to retry.\n\n`);
              process.exit(1);
            }
          }
          print.line(`  ✓ Background service installed (${info.platform}) — you may close this terminal.\n`);
          print.line(`    Logs: ${info.logDir}\n\n`);
          return;
        }

        if (options.start === false) {
          print.line("  (--no-start) credentials written; daemon not launched.\n");
          print.line(
            `  Run \`${channelConfig.binName} daemon start\` when ready, or re-run \`login\` without \`--no-start\`.\n\n`,
          );
          return;
        }

        // Service not supported on this platform — fall back to inline run so
        // the user still gets a connected client without manually invoking
        // `daemon start` afterward.
        print.line(`  Background service not supported on ${process.platform}; running inline.\n`);

        const agentsDir = join(defaultConfigDir(), "agents");
        try {
          await migrateLocalAgentDirs({
            agentsDir,
            workspacesDir: join(defaultDataDir(), "workspaces"),
            sessionsDir: join(defaultDataDir(), "sessions"),
            resolver: createApiNameResolver(config.server.url, () => ensureFreshAccessToken()),
          });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          print.status("⚠️", `agent-dir migration skipped: ${msg}`);
        }
        const agents = loadAgents({ schema: agentConfigSchema, agentsDir });

        const runtime = new ClientRuntime(config.server.url, config.client.id, {
          currentVersion: COMMAND_VERSION,
          update: {
            updateConfig: config.update,
            prompt: promptUpdate,
            executeUpdate: createExecuteUpdate({ managed: false }),
            refreshServerTarget: refreshServerUpdateTarget,
          },
        });
        for (const [name, agentConfig] of agents) runtime.addAgent(name, agentConfig);
        await runtime.start();
        runtime.watchAgentsDir(agentsDir);

        const shutdown = async () => {
          print.line("\n  Shutting down...\n");
          runtime.unwatchAgentsDir();
          await runtime.stop(resolveClientRuntimeStopReason());
          process.exit(0);
        };
        process.on("SIGINT", () => void shutdown());
        process.on("SIGTERM", () => void shutdown());
        await new Promise(() => {});
      } catch (error) {
        if ((error as { name?: string }).name === "ExitPromptError") {
          print.line("\n  Cancelled.\n");
          return;
        }
        if (error instanceof ClientOrgMismatchError) {
          await handleClientOrgMismatch(error, {
            managed: false,
            configDir: defaultConfigDir(),
            rerunCommand: `${channelConfig.binName} login <code>`,
          });
        }
        const msg = error instanceof Error ? error.message : String(error);
        print.line(`  Error: ${msg}\n`);
        process.exit(1);
      } finally {
        resetConfig();
        resetConfigMeta();
      }
    });
}
