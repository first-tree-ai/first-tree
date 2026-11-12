import {
  isOrgSettingNamespace,
  ORG_SETTINGS_NAMESPACES,
  type OrgSettingNamespace,
  orgContextTreeFinalizeInputSchema,
  orgGithubFeaturesInputSchema,
} from "@first-tree/shared";
import type { FastifyInstance } from "fastify";
import { BadRequestError, ConflictError, GoneError } from "../../errors.js";
import { requireOrgAdmin, requireOrgMembership } from "../../scope/require-org.js";
import { putLegacyContextReviewerSetting } from "../../services/context-tree/reviewer/settings.js";
import * as contextTreeSettingsService from "../../services/context-tree/settings.js";
import * as orgSettingsService from "../../services/settings/organization.js";
import { putTeamAgentAssignment } from "../../services/team-agent-settings.js";

/**
 * Class B — `/api/v1/orgs/:orgId/settings/:namespace`.
 *
 * Generic per-org settings surface. The `:namespace` URL parameter is
 * dispatched against `ORG_SETTINGS_NAMESPACES` (in the shared package);
 * adding a new config group only requires registering it there — no new
 * route file.
 *
 * GET gating is per-namespace via `readPolicy` in the registry: namespaces
 * with no secret fields (`context_tree`, `source_repos`) are readable by
 * any active org member, so an invitee can see what tree and repos the
 * team is bound to before joining the chat. PUT and DELETE are always
 * admin-only regardless of namespace — non-admins must never mutate
 * org-wide config.
 *
 * `context_tree` has two read surfaces: the generic namespace URL is always
 * runtime-safe, while `/context_tree/raw` is an admin-only repair view for
 * loose historical rows.
 */
export async function orgSettingsRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Params: { orgId: string } }>("/context_tree/raw", async (request, reply) => {
    const scope = await requireOrgAdmin(request, app.db);
    const value = await contextTreeSettingsService.getRawOrgContextTreeSetting(app.db, scope.organizationId);
    const serialized = JSON.stringify(value);
    if (serialized === undefined) {
      throw new Error("Context Tree raw setting could not be serialized as JSON");
    }
    return reply.type("application/json").send(serialized);
  });

  app.post<{ Params: { orgId: string }; Body: unknown }>(
    "/context_tree/initialize",
    { config: { otelRecordBody: false } },
    async (request) => {
      const scope = await requireOrgAdmin(request, app.db);
      const input = orgContextTreeFinalizeInputSchema.parse(request.body);
      return contextTreeSettingsService.putInitializedOrgContextTreeBinding(
        app.db,
        scope.organizationId,
        { provider: input.provider, repo: input.repo, branch: input.branch },
        {
          updatedBy: scope.userId,
          expectedUnboundBranch: input.expectedUnboundBranch,
        },
      );
    },
  );

  app.get<{ Params: { orgId: string; namespace: string } }>("/:namespace", async (request) => {
    const namespace = parseNamespace(request.params.namespace);
    const scope =
      ORG_SETTINGS_NAMESPACES[namespace].readPolicy === "member"
        ? await requireOrgMembership(request, app.db)
        : await requireOrgAdmin(request, app.db);
    if (namespace === "context_tree") {
      const runtime = await contextTreeSettingsService.getOrgContextReviewRuntime(app.db, scope.organizationId);
      const tree = contextTreeSettingsService.projectOrgContextTreeSettingState(runtime);
      if (tree.kind === "bound") return tree.binding;
      if (tree.kind === "unbound") return { branch: tree.branch };
      throw new ConflictError("Context Tree setting contains invalid historical data and must be repaired by an admin");
    }
    return orgSettingsService.getOrgSetting(app.db, scope.organizationId, namespace);
  });

  app.put<{ Params: { orgId: string; namespace: string } }>(
    "/:namespace",
    // Context Tree settings can contain private repository coordinates, and
    // rejected legacy values can contain embedded credentials. Do not attach
    // this generic settings body to failure spans.
    { config: { otelRecordBody: false } },
    async (request) => {
      const scope = await requireOrgAdmin(request, app.db);
      const namespace = parseNamespace(request.params.namespace);
      if (namespace === "source_repos") {
        throw new GoneError("source_repos is read-only; use Team Resources instead");
      }
      if (namespace === "context_tree_features") {
        return putLegacyContextReviewerSetting(app.db, scope.organizationId, request.body, {
          updatedBy: scope.userId,
          staleSeconds: app.config.runtime.presenceCleanupSeconds,
          githubAppCredentials: app.config.oauth?.githubApp,
        });
      }
      if (namespace === "github_features") {
        const input = orgGithubFeaturesInputSchema.parse(request.body);
        return putTeamAgentAssignment(app.db, scope.organizationId, input.teamAgent.agentUuid, {
          updatedBy: scope.userId,
          appSlug: app.config.oauth?.githubApp?.slug,
        });
      }
      return orgSettingsService.putOrgSetting(app.db, scope.organizationId, namespace, request.body, {
        memberId: scope.memberId,
        updatedBy: scope.userId,
      });
    },
  );

  app.delete<{ Params: { orgId: string; namespace: string } }>("/:namespace", async (request, reply) => {
    const scope = await requireOrgAdmin(request, app.db);
    const namespace = parseNamespace(request.params.namespace);
    if (namespace === "source_repos") {
      throw new GoneError("source_repos is read-only; use Team Resources instead");
    }
    await orgSettingsService.deleteOrgSetting(app.db, scope.organizationId, namespace);
    return reply.status(204).send();
  });
}

function parseNamespace(raw: string): OrgSettingNamespace {
  if (!isOrgSettingNamespace(raw)) {
    throw new BadRequestError(`Unknown organization-settings namespace: "${raw}"`);
  }
  return raw;
}
