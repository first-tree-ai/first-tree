import {
  AGENT_STATUSES,
  AGENT_TYPES,
  type AgentRuntimeConfigPayload,
  agentRuntimeConfigPayloadSchema,
  defaultRuntimeConfigPayload,
  isRuntimeProviderEnabled,
  MIN_RUNTIME_SWITCH_CLIENT_VERSION,
  type RuntimeProvider,
  supportsRuntimeSwitchClientVersion,
} from "@first-tree/shared";
import { and, eq, isNull, sql } from "drizzle-orm";
import type { Database } from "../../../db/connection.js";
import { agentConfigs } from "../../../db/schema/agent-configs.js";
import { agents } from "../../../db/schema/agents.js";
import { clients } from "../../../db/schema/clients.js";
import { members } from "../../../db/schema/members.js";
import { BadRequestError, ClientRetiredError, ConflictError, ForbiddenError, NotFoundError } from "../../../errors.js";
import { uuidv7 } from "../../../uuid.js";
import { archiveAllSessionsForAgent } from "../../chat/sessions/lifecycle.js";
import type { Notifier } from "../../notifier.js";
import { forceDisconnect } from "../../runtime/connection-manager.js";
import { setOffline } from "../../runtime/presence.js";
import { ensureClientSupportsRuntimeProvider, selectAgentRowWithRuntime } from "./binding.js";
import { revokeAgentRuntimeSession } from "./session.js";

type RuntimeSwitchPhase = "claimed" | "committed";

export const RUNTIME_SWITCH_FAULTS = ["after_claim", "after_commit", "after_sessions", "after_reactivate"] as const;
export type RuntimeSwitchFault = (typeof RUNTIME_SWITCH_FAULTS)[number];

export type RuntimeSwitchClaim = {
  claimId: string;
  phase: RuntimeSwitchPhase;
  claimedAt: string;
  claimedByUserId: string;
  claimedByMemberId: string;
  oldClientId: string;
  oldRuntimeProvider: RuntimeProvider;
  targetClientId: string;
  targetRuntimeProvider: RuntimeProvider;
};

type MetadataWithRuntimeSwitch = Record<string, unknown> & {
  runtimeSwitch?: unknown;
};

function readRuntimeSwitchValue(metadata: unknown): { present: boolean; value: unknown } {
  if (!metadata || typeof metadata !== "object") return { present: false, value: undefined };
  const record = metadata as MetadataWithRuntimeSwitch;
  if (!Object.hasOwn(record, "runtimeSwitch")) {
    return { present: false, value: undefined };
  }
  return { present: true, value: record.runtimeSwitch };
}

function readRuntimeSwitchClaimId(value: unknown): string | null {
  if (!value || typeof value !== "object") return null;
  const claimId = (value as { claimId?: unknown }).claimId;
  return typeof claimId === "string" ? claimId : null;
}

export function getRuntimeSwitchClaim(metadata: unknown): RuntimeSwitchClaim | null {
  const { present, value: claim } = readRuntimeSwitchValue(metadata);
  if (!present) return null;
  if (!claim || typeof claim !== "object") return null;
  const candidate = claim as Partial<RuntimeSwitchClaim>;
  if (
    typeof candidate.claimId !== "string" ||
    (candidate.phase !== "claimed" && candidate.phase !== "committed") ||
    typeof candidate.claimedAt !== "string" ||
    typeof candidate.claimedByUserId !== "string" ||
    typeof candidate.claimedByMemberId !== "string" ||
    typeof candidate.oldClientId !== "string" ||
    typeof candidate.oldRuntimeProvider !== "string" ||
    typeof candidate.targetClientId !== "string" ||
    typeof candidate.targetRuntimeProvider !== "string"
  ) {
    return null;
  }
  return candidate as RuntimeSwitchClaim;
}

export function assertNoRuntimeSwitchInProgress(agent: { metadata: unknown }): void {
  const existing = readRuntimeSwitchValue(agent.metadata);
  if (!existing.present) return;
  const claim = getRuntimeSwitchClaim(agent.metadata);
  const claimId = claim?.claimId ?? readRuntimeSwitchClaimId(existing.value);
  throw new ConflictError(
    claimId ? `Agent runtime switch "${claimId}" is in progress` : "Agent runtime switch is in progress",
  );
}

export type SwitchAgentRuntimeInput = {
  clientId: string;
  runtimeProvider: RuntimeProvider;
};

export type SwitchAgentRuntimeActor = {
  userId: string;
  memberId: string;
};

export type SwitchAgentRuntimeResult = {
  agent: NonNullable<Awaited<ReturnType<typeof selectAgentRowWithRuntime>>>;
  claimId: string;
  oldClientId: string;
  targetClientId: string;
  terminatedChatIds: string[];
  recoveryAction?: "aborted" | "forwarded";
};

type RuntimeSwitchOptions = {
  notifier?: Notifier;
  fault?: RuntimeSwitchFault;
};

function assertRuntimeSwitchClientVersion(sdkVersion: string | null): void {
  if (!supportsRuntimeSwitchClientVersion(sdkVersion)) {
    throw new BadRequestError(
      `Target client must run First Tree CLI ${MIN_RUNTIME_SWITCH_CLIENT_VERSION} or newer before switching runtimes.`,
    );
  }
}

function retagRuntimeConfigPayload(
  currentPayload: unknown,
  targetProvider: RuntimeProvider,
): AgentRuntimeConfigPayload {
  const current = agentRuntimeConfigPayloadSchema.parse(currentPayload);
  const defaults = defaultRuntimeConfigPayload(targetProvider);
  return agentRuntimeConfigPayloadSchema.parse({
    ...defaults,
    prompt: current.prompt,
    mcpServers: current.mcpServers,
    env: current.env,
    gitRepos: current.gitRepos,
    resourceSkills: current.resourceSkills,
  });
}

function maybeInjectRuntimeSwitchFault(options: RuntimeSwitchOptions, point: RuntimeSwitchFault): void {
  if (options.fault !== point) return;
  throw new Error(`Injected runtime switch fault: ${point}`);
}

async function abortRuntimeSwitchClaim(db: Database, agentId: string, claim: RuntimeSwitchClaim): Promise<boolean> {
  const oldClientCondition = claim.oldClientId ? eq(agents.clientId, claim.oldClientId) : isNull(agents.clientId);
  const [row] = await db
    .update(agents)
    .set({
      status: claim.oldClientId ? AGENT_STATUSES.ACTIVE : AGENT_STATUSES.SUSPENDED,
      metadata: sql`${agents.metadata} - 'runtimeSwitch'`,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(agents.uuid, agentId),
        oldClientCondition,
        eq(agents.runtimeProvider, claim.oldRuntimeProvider),
        sql`${agents.metadata}->'runtimeSwitch'->>'claimId' = ${claim.claimId}`,
        sql`${agents.metadata}->'runtimeSwitch'->>'phase' = 'claimed'`,
      ),
    )
    .returning({ uuid: agents.uuid });
  return row !== undefined;
}

async function reactivateCommittedRuntimeSwitch(
  db: Database,
  agentId: string,
  claim: RuntimeSwitchClaim,
): Promise<boolean> {
  const [reactivated] = await db
    .update(agents)
    .set({
      status: AGENT_STATUSES.ACTIVE,
      metadata: sql`${agents.metadata} - 'runtimeSwitch'`,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(agents.uuid, agentId),
        eq(agents.status, AGENT_STATUSES.SUSPENDED),
        eq(agents.clientId, claim.targetClientId),
        eq(agents.runtimeProvider, claim.targetRuntimeProvider),
        sql`${agents.metadata}->'runtimeSwitch'->>'claimId' = ${claim.claimId}`,
        sql`${agents.metadata}->'runtimeSwitch'->>'phase' = 'committed'`,
      ),
    )
    .returning({ uuid: agents.uuid });
  return reactivated !== undefined;
}

async function detachOldRuntimeAfterCommittedRoute(
  db: Database,
  agentId: string,
  claim: Pick<RuntimeSwitchClaim, "oldClientId">,
): Promise<void> {
  if (!claim.oldClientId) return;
  await revokeAgentRuntimeSession(db, agentId, claim.oldClientId);
  forceDisconnect(agentId, "agent_runtime_switch", claim.oldClientId);
  await setOffline(db, agentId);
}

export async function switchAgentRuntime(
  db: Database,
  agentId: string,
  input: SwitchAgentRuntimeInput,
  actor: SwitchAgentRuntimeActor,
  options: RuntimeSwitchOptions = {},
): Promise<SwitchAgentRuntimeResult> {
  const current = await selectAgentRowWithRuntime(db, agentId);
  if (!current || current.status === AGENT_STATUSES.DELETED) {
    throw new NotFoundError(`Agent "${agentId}" not found`);
  }
  if (current.type === AGENT_TYPES.HUMAN) {
    throw new BadRequestError("Human agents do not have a runtime to switch");
  }
  const activeBoundRoute = current.status === AGENT_STATUSES.ACTIVE && !!current.clientId;
  const clearedSuspendedRoute = current.status === AGENT_STATUSES.SUSPENDED && !current.clientId;
  if (!activeBoundRoute && !clearedSuspendedRoute) {
    throw new BadRequestError("Only active agents or suspended agents without a computer can switch runtime");
  }
  const oldClientId = current.clientId ?? "";
  const oldClientCondition = oldClientId ? eq(agents.clientId, oldClientId) : isNull(agents.clientId);
  assertNoRuntimeSwitchInProgress(current);

  const oldRuntimeProvider = current.runtimeProvider as RuntimeProvider;
  if (oldClientId && input.clientId === oldClientId && input.runtimeProvider === oldRuntimeProvider) {
    throw new BadRequestError("Target computer and runtime match the agent's current configuration");
  }

  const [manager] = await db
    .select({ userId: members.userId, status: members.status })
    .from(members)
    .where(eq(members.id, current.managerId))
    .limit(1);
  if (!manager || manager.status !== "active") {
    throw new BadRequestError(`Manager "${current.managerId}" not found`);
  }

  const [targetClient] = await db
    .select({
      id: clients.id,
      userId: clients.userId,
      sdkVersion: clients.sdkVersion,
      retiredAt: clients.retiredAt,
    })
    .from(clients)
    .where(eq(clients.id, input.clientId))
    .limit(1);
  if (!targetClient) {
    throw new BadRequestError(`Client "${input.clientId}" not found`);
  }
  if (!targetClient.userId) {
    throw new BadRequestError(`Client "${input.clientId}" has not been claimed by a user yet`);
  }
  if (targetClient.userId !== manager.userId) {
    throw new ForbiddenError(`Client "${input.clientId}" is not owned by the agent manager's user`);
  }
  if (targetClient.retiredAt) {
    throw new ClientRetiredError(`Client "${input.clientId}" has been retired`);
  }
  assertRuntimeSwitchClientVersion(targetClient.sdkVersion);

  // Reject rollout-gated targets before consulting capability data. An
  // already-bound disabled provider can keep running, but switch is new
  // selection and cannot bypass the release gate.
  if (!isRuntimeProviderEnabled(input.runtimeProvider)) {
    throw new BadRequestError(
      `Runtime provider "${input.runtimeProvider}" is disabled for new selection until release acceptance.`,
    );
  }
  await ensureClientSupportsRuntimeProvider(db, targetClient.id, input.runtimeProvider);

  const claim: RuntimeSwitchClaim = {
    claimId: uuidv7(),
    phase: "claimed",
    claimedAt: new Date().toISOString(),
    claimedByUserId: actor.userId,
    claimedByMemberId: actor.memberId,
    oldClientId,
    oldRuntimeProvider,
    targetClientId: input.clientId,
    targetRuntimeProvider: input.runtimeProvider,
  };

  const claimed = await db.transaction(async (tx) => {
    const [row] = await tx
      .update(agents)
      .set({
        status: AGENT_STATUSES.SUSPENDED,
        metadata: sql`jsonb_set(${agents.metadata}, '{runtimeSwitch}', ${JSON.stringify(claim)}::jsonb, true)`,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(agents.uuid, current.uuid),
          eq(agents.status, current.status),
          oldClientCondition,
          eq(agents.runtimeProvider, oldRuntimeProvider),
          sql`NOT (${agents.metadata} ? 'runtimeSwitch')`,
        ),
      )
      .returning({ uuid: agents.uuid });
    return row !== undefined;
  });
  if (!claimed) {
    throw new ConflictError("Agent changed before the runtime switch claim could be recorded");
  }

  try {
    maybeInjectRuntimeSwitchFault(options, "after_claim");
    const committed = await db.transaction(async (tx) => {
      const committedClaim: RuntimeSwitchClaim = { ...claim, phase: "committed" };
      const [row] = await tx
        .update(agents)
        .set({
          clientId: input.clientId,
          runtimeProvider: input.runtimeProvider,
          metadata: sql`jsonb_set(${agents.metadata}, '{runtimeSwitch}', ${JSON.stringify(committedClaim)}::jsonb, true)`,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(agents.uuid, current.uuid),
            eq(agents.status, AGENT_STATUSES.SUSPENDED),
            oldClientCondition,
            eq(agents.runtimeProvider, oldRuntimeProvider),
            sql`${agents.metadata}->'runtimeSwitch'->>'claimId' = ${claim.claimId}`,
            sql`${agents.metadata}->'runtimeSwitch'->>'phase' = 'claimed'`,
            sql`EXISTS (
              SELECT 1 FROM ${clients}
              WHERE ${clients.id} = ${input.clientId}
                AND ${clients.retiredAt} IS NULL
            )`,
          ),
        )
        .returning({ uuid: agents.uuid });
      if (!row) return false;

      const [config] = await tx
        .select({ payload: agentConfigs.payload })
        .from(agentConfigs)
        .where(eq(agentConfigs.agentId, current.uuid))
        .limit(1);
      if (config) {
        const nextPayload = retagRuntimeConfigPayload(config.payload, input.runtimeProvider);
        await tx
          .update(agentConfigs)
          .set({
            version: sql`${agentConfigs.version} + 1`,
            payload: nextPayload,
            updatedAt: new Date(),
            updatedBy: actor.memberId,
          })
          .where(eq(agentConfigs.agentId, current.uuid));
      }

      return true;
    });
    if (!committed) {
      throw new ConflictError("Agent changed before the runtime switch could be committed");
    }
  } catch (err) {
    await abortRuntimeSwitchClaim(db, current.uuid, claim);
    throw err;
  }

  await detachOldRuntimeAfterCommittedRoute(db, current.uuid, claim);
  maybeInjectRuntimeSwitchFault(options, "after_commit");

  const committedClaim: RuntimeSwitchClaim = { ...claim, phase: "committed" };
  const archived = await archiveAllSessionsForAgent(db, current.uuid, current.organizationId, options.notifier, {
    runtimeSwitchClaimId: claim.claimId,
  });
  maybeInjectRuntimeSwitchFault(options, "after_sessions");

  const reactivated = await reactivateCommittedRuntimeSwitch(db, current.uuid, committedClaim);
  if (!reactivated) {
    throw new ConflictError("Agent changed before the runtime switch claim could be cleared");
  }
  maybeInjectRuntimeSwitchFault(options, "after_reactivate");

  const refreshed = await selectAgentRowWithRuntime(db, current.uuid);
  if (!refreshed) throw new Error("Unexpected: agent disappeared after runtime switch");

  return {
    agent: refreshed,
    claimId: claim.claimId,
    oldClientId,
    targetClientId: input.clientId,
    terminatedChatIds: archived.chatIds,
  };
}

export async function recoverAgentRuntimeSwitch(
  db: Database,
  agentId: string,
  options: RuntimeSwitchOptions = {},
): Promise<SwitchAgentRuntimeResult> {
  const current = await selectAgentRowWithRuntime(db, agentId);
  if (!current || current.status === AGENT_STATUSES.DELETED) {
    throw new NotFoundError(`Agent "${agentId}" not found`);
  }
  const runtimeSwitch = readRuntimeSwitchValue(current.metadata);
  if (!runtimeSwitch.present) {
    throw new BadRequestError("Agent has no runtime switch recovery state");
  }
  const claim = getRuntimeSwitchClaim(current.metadata);
  if (!claim) {
    const claimId = readRuntimeSwitchClaimId(runtimeSwitch.value);
    throw new ConflictError(
      claimId
        ? `Agent runtime switch "${claimId}" has malformed recovery state`
        : "Agent runtime switch recovery state is malformed",
    );
  }

  if (claim.phase === "claimed") {
    const aborted = await abortRuntimeSwitchClaim(db, current.uuid, claim);
    if (!aborted) {
      throw new ConflictError("Agent changed before the runtime switch claim could be aborted");
    }
    const refreshed = await selectAgentRowWithRuntime(db, current.uuid);
    if (!refreshed) throw new Error("Unexpected: agent disappeared after runtime switch recovery");
    return {
      agent: refreshed,
      claimId: claim.claimId,
      oldClientId: claim.oldClientId,
      targetClientId: claim.targetClientId,
      terminatedChatIds: [],
      recoveryAction: "aborted",
    };
  }

  await detachOldRuntimeAfterCommittedRoute(db, current.uuid, claim);
  maybeInjectRuntimeSwitchFault(options, "after_commit");
  const archived = await archiveAllSessionsForAgent(db, current.uuid, current.organizationId, options.notifier, {
    runtimeSwitchClaimId: claim.claimId,
  });
  maybeInjectRuntimeSwitchFault(options, "after_sessions");
  const reactivated = await reactivateCommittedRuntimeSwitch(db, current.uuid, claim);
  if (!reactivated) {
    throw new ConflictError("Agent changed before the runtime switch claim could be cleared");
  }
  maybeInjectRuntimeSwitchFault(options, "after_reactivate");

  const refreshed = await selectAgentRowWithRuntime(db, current.uuid);
  if (!refreshed) throw new Error("Unexpected: agent disappeared after runtime switch recovery");

  return {
    agent: refreshed,
    claimId: claim.claimId,
    oldClientId: claim.oldClientId,
    targetClientId: claim.targetClientId,
    terminatedChatIds: archived.chatIds,
    recoveryAction: "forwarded",
  };
}
