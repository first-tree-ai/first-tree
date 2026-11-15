import { readFileSync } from "node:fs";
import { FirstTreeHubSDK } from "@first-tree/client";
import type { Command } from "commander";
import semver from "semver";
import { accessTokenForOrigin } from "../../core/access-token.js";
import { resolveServerUrl } from "../../core/bootstrap.js";
import { channelConfig } from "../../core/channel.js";
import {
  activateExternalContext,
  renderProviderSessionStartResponse,
} from "../../core/context-integration/activation.js";
import { consumeContextAdapterNextSessionObligation } from "../../core/context-integration/adapter-observation.js";
import { assertContextAdapterPayloadHealthy } from "../../core/context-integration/adapter-payload-health.js";
import {
  AdapterSyncRejectedError,
  hasKnownCompatibleContextAdapterSession,
  issueAdapterSyncAction,
} from "../../core/context-integration/adapter-sync.js";
import { resolveSessionContextProject } from "../../core/context-integration/client-preflight.js";
import { readContextIntegrationInstallManifest } from "../../core/context-integration/manifest.js";
import { resolveContextIntegrationRelease } from "../../core/context-integration/release.js";
import { contextRepairAdditionalContext } from "../../core/context-integration/repair-guidance.js";
import { print } from "../../core/output.js";
import { CLI_USER_AGENT } from "../../core/version.js";
import type { CommandContext, SubcommandModule } from "../types.js";
import { createContextIntegrationDriver, parseContextProvider } from "./shared.js";

type ActivateOptions = {
  provider?: string;
  adapterDigest?: string;
  releaseDigest?: string;
};

function configure(command: Command): void {
  command
    .requiredOption("--provider <provider>", "provider hook owner")
    .option("--adapter-digest <digest>", "installed adapter digest")
    .option("--release-digest <digest>", "legacy installed payload digest");
}

export async function runContextActivate(
  context: CommandContext,
  dependencies: { readHookInput?: typeof readHookInput } = {},
): Promise<void> {
  try {
    if (isManagedFirstTreeAgentSession(process.env)) {
      print.hook({ continue: true });
      return;
    }
    const options = context.command.opts<ActivateOptions>();
    const provider = parseContextProvider(options.provider ?? "");
    const suppliedAdapterDigest = options.adapterDigest ?? options.releaseDigest;
    if (!suppliedAdapterDigest) throw new Error("The Context adapter digest is required.");
    const hookInput = (dependencies.readHookInput ?? readHookInput)();
    const release = resolveContextIntegrationRelease();
    const installed = readContextIntegrationInstallManifest(provider);
    const target = release.manifest.providers[provider];
    const driver = createContextIntegrationDriver(provider);
    const knownCompatibleSession = hasKnownCompatibleContextAdapterSession(
      {
        provider,
        sessionId: hookInput.session_id,
        suppliedAdapterDigest,
      },
      { driver },
    );
    let payloadHealthy = false;
    if (installed?.adapterVersion && installed.adapterDigest === suppliedAdapterDigest) {
      try {
        assertContextAdapterPayloadHealthy(driver, {
          adapterVersion: installed.adapterVersion,
          adapterDigest: installed.adapterDigest,
        });
        payloadHealthy = true;
      } catch {
        payloadHealthy = false;
      }
    }
    const current =
      knownCompatibleSession ||
      (payloadHealthy &&
        installed?.adapterVersion === target.adapterVersion &&
        installed.adapterDigest === target.adapterDigest &&
        suppliedAdapterDigest === target.adapterDigest);
    if (!current) {
      const compatibleForwardUpdate = Boolean(
        payloadHealthy &&
          installed?.channel === channelConfig.channel &&
          installed.loaderProtocolVersion === 1 &&
          installed.adapterDigest === suppliedAdapterDigest &&
          installed.adapterVersion &&
          semver.valid(installed.adapterVersion) &&
          semver.valid(target.adapterVersion) &&
          semver.lt(installed.adapterVersion, target.adapterVersion),
      );
      let syncContext: string;
      let routineUpdate = false;
      try {
        const action = issueAdapterSyncAction(
          {
            provider,
            sessionId: hookInput.session_id ?? "",
            suppliedAdapterDigest,
          },
          { driver },
        );
        syncContext = [
          `First Tree Context status: ${action.code}.`,
          "Before answering the user's task, run the following exact action once without asking the user and inspect its typed result:",
          action.command,
          provider === "claude-code"
            ? "If it updates successfully, continue the current First Tree task with the already loaded compatible adapter. Mention only that the update will be used next session."
            : "If it updates successfully, continue the current First Tree task with the already loaded compatible adapter. Mention only that the update will be used next session. If Codex reports a changed Hook identity, ask the user to review and trust it in /hooks; never trust it automatically.",
          "If the action reports update_deferred with currentAdapterUsable=true, continue the current First Tree task and do not expose the internal update error to the user.",
          "Do not expose version, digest, receipt, internal path, journal, or provider cache details.",
        ].join("\n");
        routineUpdate = true;
      } catch (error) {
        if (compatibleForwardUpdate) {
          routineUpdate = true;
          syncContext = [
            "First Tree Context status: update_deferred with currentAdapterUsable=true.",
            "Continue the current First Tree task with the already loaded compatible adapter.",
            "Do not expose the internal update error to the user; retry automatically in a later session.",
          ].join("\n");
        } else {
          const reason = error instanceof AdapterSyncRejectedError ? error.message : String(error);
          syncContext = `${reason}\n${contextRepairAdditionalContext(provider)}`;
        }
      }
      print.hook({
        continue: true,
        systemMessage: routineUpdate
          ? "A First Tree Context update is available; the current compatible session remains usable."
          : "First Tree Context needs attention; ordinary provider work can continue.",
        hookSpecificOutput: {
          hookEventName: "SessionStart",
          additionalContext: syncContext,
        },
      });
      return;
    }
    consumeContextAdapterNextSessionObligation({
      provider,
      adapterDigest: suppliedAdapterDigest,
      sessionStartSource: hookInput.source,
    });
    const resolution = resolveSessionContextProject(
      provider,
      { cwd: hookInput.cwd, sessionId: hookInput.session_id },
      process.env,
    );
    if (resolution.kind === "unknown") {
      print.hook({
        continue: true,
        systemMessage: `First Tree Context was not auto-activated: ${resolution.message}`,
      });
      return;
    }
    const serverUrl = resolveServerUrl(process.env.FIRST_TREE_SERVER_URL);
    const sdk = new FirstTreeHubSDK({
      serverUrl,
      getAccessToken: (refreshOptions) => accessTokenForOrigin(serverUrl, refreshOptions),
      userAgent: CLI_USER_AGENT,
    });
    const activation = await activateExternalContext(sdk, { provider, project: resolution.project });
    print.hook(renderProviderSessionStartResponse(activation));
  } catch (error) {
    print.hook({
      continue: true,
      systemMessage: `First Tree Context unavailable: ${
        error instanceof Error ? error.message : String(error)
      }. Ordinary provider work can continue.`,
    });
  }
}

function readHookInput(): { cwd?: string; session_id?: string; source?: string } {
  const input = readFileSync(0, "utf8");
  if (Buffer.byteLength(input) > 64 * 1024) throw new Error("hook input is too large");
  if (!input.trim()) return {};
  const parsed = JSON.parse(input) as { cwd?: unknown; session_id?: unknown; source?: unknown };
  return {
    ...(typeof parsed.cwd === "string" && parsed.cwd.length > 0 ? { cwd: parsed.cwd } : {}),
    ...(typeof parsed.session_id === "string" && parsed.session_id.length > 0 ? { session_id: parsed.session_id } : {}),
    ...(typeof parsed.source === "string" && parsed.source.length > 0 ? { source: parsed.source } : {}),
  };
}

/** Managed providers can still discover the user's BYO Plugin; never let its hook override the managed briefing. */
function isManagedFirstTreeAgentSession(env: NodeJS.ProcessEnv): boolean {
  return Boolean(env.FIRST_TREE_AGENT_ID?.trim()) && Boolean(env.FIRST_TREE_CHAT_ID?.trim());
}

export const contextActivateCommand: SubcommandModule = {
  name: "activate",
  hidden: true,
  alias: "",
  summary: "",
  description: "Internal provider SessionStart activation bridge.",
  configure,
  action: runContextActivate,
};
