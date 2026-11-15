import { dryRunAgentRuntimeConfigSchema, updateAgentRuntimeConfigSchema } from "@first-tree/shared";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { agentPresence } from "../db/schema/agent-presence.js";
import { requireAgentAccess } from "../scope/require-resource.js";
import { assertNoRuntimeSwitchInProgress } from "../services/agents/runtime/switch.js";
import { assertMutableAgentIsNotLandingCampaignTrial } from "../services/landing-campaigns/guards.js";

/**
 * Class C — `/api/v1/agents/:uuid/config`. Runtime config (system prompt,
 * tools, env) is behavior-sensitive — gated on `manage`, not `visible`.
 */
export async function agentConfigRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Params: { uuid: string } }>("/:uuid/config", async (request) => {
    await requireAgentAccess(request, app.db, "manage");
    const cfg = await app.configService.get(request.params.uuid);
    return app.resourcesService.resolveRuntimeConfig(cfg);
  });

  // Body capture stays off on the two write routes: the payload carries agent
  // credentials (`env[].value`, MCP `Authorization` headers) and the capture
  // hook redacts top-level keys only, so a nested secret would reach the trace
  // on any 400/409/500 (SEC-018).
  app.patch<{ Params: { uuid: string } }>("/:uuid/config", { config: { otelRecordBody: false } }, async (request) => {
    const { agent, scope } = await requireAgentAccess(request, app.db, "manage");
    assertMutableAgentIsNotLandingCampaignTrial(agent);
    assertNoRuntimeSwitchInProgress(agent);
    const body = updateAgentRuntimeConfigSchema.parse(request.body);
    const cfg = await app.configService.update(request.params.uuid, body, scope.memberId);
    return app.resourcesService.resolveRuntimeConfig(cfg);
  });

  app.post<{ Params: { uuid: string } }>(
    "/:uuid/config/dry-run",
    { config: { otelRecordBody: false } },
    async (request) => {
      await requireAgentAccess(request, app.db, "manage");
      const body = dryRunAgentRuntimeConfigSchema.parse(request.body);
      return app.configService.dryRun(request.params.uuid, body.payload);
    },
  );

  app.get<{ Params: { uuid: string } }>("/:uuid/client-status", async (request) => {
    const { agent } = await requireAgentAccess(request, app.db, "visible");
    const [presence] = await app.db
      .select({ status: agentPresence.status, lastSeenAt: agentPresence.lastSeenAt })
      .from(agentPresence)
      .where(eq(agentPresence.agentId, agent.uuid))
      .limit(1);

    const online = presence?.status === "online";
    return {
      online,
      clientId: agent.clientId ?? null,
      offlineSince: !online && presence?.lastSeenAt ? presence.lastSeenAt.toISOString() : null,
    };
  });
}
