import type { Command } from "commander";
import { fail } from "../../cli/output.js";
import { accessTokenForOrigin } from "../../core/access-token.js";
import { resolveServerUrl } from "../../core/bootstrap.js";
import { cliFetch } from "../../core/cli-fetch.js";
import { print } from "../../core/output.js";

export function registerAgentStatusCommand(agent: Command): void {
  agent
    .command("status [name]")
    .description("Show agent runtime status from the First Tree server")
    .option("--server <url>", "First Tree server URL")
    .action(async (name?: string, options?: { server?: string }) => {
      try {
        const serverUrl = resolveServerUrl(options?.server);
        const accessToken = await accessTokenForOrigin(serverUrl);
        // Activity is org-scoped — gather across every org the caller belongs
        // to so a multi-org user's `status` aggregates all runtimes.
        const meRes = await cliFetch(`${serverUrl}/api/v1/me`, {
          headers: { Authorization: `Bearer ${accessToken}` },
          signal: AbortSignal.timeout(10_000),
        });
        if (!meRes.ok) fail("FETCH_ERROR", `/me HTTP ${meRes.status}`, 1);
        const me = (await meRes.json()) as { memberships: Array<{ organizationId: string }> };
        type ActivityResponse = {
          total: number;
          running: number;
          byState: { idle: number; working: number; blocked: number; error: number };
          clients: number;
          agents: Array<{
            agentId: string;
            clientId: string | null;
            runtimeType: string | null;
            runtimeState: string | null;
            activeSessions: number | null;
            totalSessions: number | null;
          }>;
        };
        const data: ActivityResponse = {
          total: 0,
          running: 0,
          byState: { idle: 0, working: 0, blocked: 0, error: 0 },
          clients: 0,
          agents: [],
        };
        for (const m of me.memberships) {
          const r = await cliFetch(`${serverUrl}/api/v1/orgs/${encodeURIComponent(m.organizationId)}/activity`, {
            headers: { Authorization: `Bearer ${accessToken}` },
            signal: AbortSignal.timeout(10_000),
          });
          if (!r.ok) continue;
          const part = (await r.json()) as ActivityResponse;
          data.total += part.total;
          data.running += part.running;
          data.byState.idle += part.byState.idle;
          data.byState.working += part.byState.working;
          data.byState.blocked += part.byState.blocked;
          data.byState.error += part.byState.error;
          data.clients += part.clients;
          data.agents.push(...part.agents);
        }

        if (name) {
          const ag = data.agents.find((a) => a.agentId === name);
          if (!ag) {
            print.line(`\n  Agent "${name}" is not running.\n\n`);
            return;
          }
          print.line(`\n  Agent: ${ag.agentId}\n`);
          print.line(`  Runtime: ${ag.runtimeType ?? "—"}\n`);
          print.line(`  State: ${ag.runtimeState ?? "—"}\n`);
          if (ag.activeSessions !== null) {
            print.line(`  Sessions: ${ag.activeSessions} active / ${ag.totalSessions ?? 0} total\n`);
          }
          if (ag.clientId) {
            print.line(`  Client: ${ag.clientId}\n`);
          }
          print.line("\n");
          return;
        }

        print.line(`\n  Server: ${serverUrl}\n\n`);
        print.line(`  Clients: ${data.clients} connected\n`);
        print.line(`  Agents: ${data.running} running / ${data.total} total\n`);
        print.line(
          `  Errors: ${data.byState.error} | Blocked: ${data.byState.blocked} | Working: ${data.byState.working} | Idle: ${data.byState.idle}\n\n`,
        );

        if (data.agents.length > 0) {
          const header = `  ${"AGENT".padEnd(18)} ${"RUNTIME".padEnd(14)} ${"STATE".padEnd(10)} SESSIONS`;
          print.line(`${header}\n`);
          print.line(`  ${"─".repeat(header.length - 2)}\n`);
          for (const a of data.agents) {
            const sessions = a.activeSessions !== null ? `${a.activeSessions}/${a.totalSessions ?? 0}` : "—";
            print.line(
              `  ${(a.agentId ?? "").padEnd(18)} ${(a.runtimeType ?? "—").padEnd(14)} ${(a.runtimeState ?? "—").padEnd(10)} ${sessions}\n`,
            );
          }
          print.line("\n");
        }
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        fail("STATUS_ERROR", msg);
      }
    });
}
