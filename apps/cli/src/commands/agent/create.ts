import { asRuntimeProvider, isRuntimeProviderEnabled, RUNTIME_PROVIDER_IDS } from "@first-tree/shared";
import type { Command } from "commander";
import { fail } from "../../cli/output.js";
import { ensureFreshAccessToken, resolveServerUrl, saveAgentConfig } from "../../core/bootstrap.js";
import { channelConfig } from "../../core/channel.js";
import { cliFetch } from "../../core/cli-fetch.js";
import { print } from "../../core/output.js";

export function registerAgentCreateCommand(agent: Command): void {
  const selectableRuntimes = RUNTIME_PROVIDER_IDS.filter(isRuntimeProviderEnabled);
  const runtimeChoices = selectableRuntimes.join(", ");
  agent
    .command("create <name>")
    .description("Create an agent in First Tree and bind it locally")
    .requiredOption("--type <type>", "Agent type (human, agent)")
    .requiredOption(
      "--client-id <id>",
      `Client (machine) that will run this agent — must be owned by you. Run \`${channelConfig.binName} login <code>\` on that machine first.`,
    )
    .option("--runtime <runtime>", `Runtime handler — one of: ${runtimeChoices} (default: claude-code)`, "claude-code")
    .option("--display-name <name>", "Display name")
    .option("--org <id>", "Target organization id (required when you belong to multiple orgs)")
    .option("--server <url>", "First Tree server URL")
    .action(
      async (
        name: string,
        options: {
          type: string;
          clientId: string;
          runtime: string;
          displayName?: string;
          org?: string;
          server?: string;
        },
      ) => {
        try {
          const serverUrl = resolveServerUrl(options.server);
          const adminToken = await ensureFreshAccessToken();
          const runtimeProvider = asRuntimeProvider(options.runtime);
          if (!runtimeProvider || !isRuntimeProviderEnabled(runtimeProvider)) {
            fail(
              "INVALID_RUNTIME",
              `Runtime "${options.runtime}" is not selectable. Choose one of: ${runtimeChoices}`,
              1,
            );
            return;
          }
          const headers = {
            Authorization: `Bearer ${adminToken}`,
            "Content-Type": "application/json",
          };

          // Resolve target org. Single-org users are auto-selected; multi-org
          // users must pass `--org`. JWT no longer carries default org.
          const meRes = await cliFetch(`${serverUrl}/api/v1/me`, {
            headers: { Authorization: `Bearer ${adminToken}` },
            signal: AbortSignal.timeout(10_000),
          });
          if (!meRes.ok) fail("FETCH_ERROR", `Failed to fetch /me: HTTP ${meRes.status}`, 1);
          const me = (await meRes.json()) as {
            memberships: Array<{ organizationId: string; organizationName: string; role: string }>;
            defaultOrganizationId?: string | null;
          };
          let orgId: string;
          if (options.org) {
            if (!me.memberships.some((m) => m.organizationId === options.org)) {
              fail("ORG_NOT_FOUND", `Not an active member of organization "${options.org}"`, 1);
            }
            orgId = options.org;
          } else if (me.memberships.length === 1) {
            orgId = me.memberships[0]?.organizationId ?? "";
          } else if (me.memberships.length === 0) {
            fail("NO_ORG", "You don't belong to any organization", 1);
          } else {
            const list = me.memberships.map((m) => `  ${m.organizationId}  (${m.organizationName})`).join("\n");
            fail("AMBIGUOUS_ORG", `You belong to multiple organizations — pass --org <id>:\n${list}`, 1);
            return;
          }

          const createBody: Record<string, unknown> = {
            name,
            type: options.type,
            clientId: options.clientId,
            runtimeProvider,
          };
          if (options.displayName) createBody.displayName = options.displayName;

          const createRes = await cliFetch(`${serverUrl}/api/v1/orgs/${encodeURIComponent(orgId)}/agents`, {
            method: "POST",
            headers,
            body: JSON.stringify(createBody),
            signal: AbortSignal.timeout(10_000),
          });
          if (!createRes.ok) {
            const body = (await createRes.json().catch(() => ({}))) as { error?: string };
            fail("CREATE_ERROR", body.error ?? `Failed to create agent (HTTP ${createRes.status})`, 1);
          }
          const created = (await createRes.json()) as { uuid: string; name: string | null };
          print.line(`  ✓ Agent created: ${created.name ?? created.uuid}\n`);

          const agentDir = saveAgentConfig(name, created.uuid, runtimeProvider);
          print.line(`  ✓ Config saved: ${agentDir}/agent.yaml\n`);
          print.line("  ✓ Agent ready — start the daemon on that machine to bind\n");
        } catch (error) {
          const msg = error instanceof Error ? error.message : String(error);
          fail("CREATE_ERROR", msg);
        }
      },
    );
}
