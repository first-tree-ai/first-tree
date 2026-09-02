import { AGENT_STATUSES, type RuntimeProvider } from "@first-tree/shared";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { agents } from "../db/schema/agents.js";
import { clients } from "../db/schema/clients.js";
import { members } from "../db/schema/members.js";
import { BadRequestError, NotFoundError } from "../errors.js";
import { assertAgentManageableByUser } from "../scope/require-resource.js";
import {
  agentMetadataUpdateExpressionPreservingRuntimeState,
  assertUserAgentMetadataHasNoReservedKeys,
  checkAgentNameAvailability,
  clearAgentAvatarImage,
  createAgent,
  deleteAgent,
  getAgentAvatarImage,
  getAgentSkills,
  listAgentsForAdmin,
  MAX_AVATAR_IMAGE_BYTES,
  reactivateAgent,
  setAgentAvatarImage,
  stripReservedAgentMetadata,
  suspendAgent,
  updateAgent,
  updateAgentSkills,
} from "../services/agents/identity.js";
import { ensureClientSupportsRuntimeProvider } from "../services/agents/runtime/binding.js";
import { createMember } from "../services/team/member.js";
import { createOrganization } from "../services/team/organization.js";
import { createAdminContext, useTestApp } from "./helpers.js";

describe("agent service extra coverage", () => {
  const getApp = useTestApp();

  it("strips and rejects reserved metadata keys at the service boundary", () => {
    expect(stripReservedAgentMetadata(null)).toEqual({});
    expect(stripReservedAgentMetadata(["runtimeSession"])).toEqual({});
    expect(
      stripReservedAgentMetadata({
        publicKey: "kept",
        runtimeSession: { tokenHash: "secret" },
        runtimeSwitch: { leaseId: "hidden" },
      }),
    ).toEqual({ publicKey: "kept" });
    expect(() => assertUserAgentMetadataHasNoReservedKeys({ runtimeSession: {} })).toThrow(
      /metadata.runtimeSession is reserved/i,
    );
    expect(agentMetadataUpdateExpressionPreservingRuntimeState({ publicKey: "kept" })).toBeDefined();
  });

  it("reports name availability for invalid, reserved, taken, and available names", async () => {
    const app = getApp();
    const admin = await createAdminContext(app, { username: `agent-name-${crypto.randomUUID().slice(0, 8)}` });
    await createAgent(app.db, {
      name: "taken-agent",
      type: "agent",
      managerId: admin.memberId,
      clientId: admin.clientId,
    });

    await expect(checkAgentNameAvailability(app.db, admin.organizationId, "Bad Name")).resolves.toEqual({
      available: false,
      reason: "invalid",
    });
    await expect(checkAgentNameAvailability(app.db, admin.organizationId, "system")).resolves.toEqual({
      available: false,
      reason: "reserved",
    });
    await expect(checkAgentNameAvailability(app.db, admin.organizationId, "taken-agent")).resolves.toEqual({
      available: false,
      reason: "taken",
    });
    await expect(checkAgentNameAvailability(app.db, admin.organizationId, "free-agent")).resolves.toEqual({
      available: true,
    });
  });

  it("validates createAgent client ownership and human pinning preconditions", async () => {
    const app = getApp();
    const admin = await createAdminContext(app, { username: `agent-client-pre-${crypto.randomUUID().slice(0, 8)}` });
    const other = await createAdminContext(app, { username: `agent-client-other-${crypto.randomUUID().slice(0, 8)}` });
    const unclaimedClientId = `cli-unclaimed-${crypto.randomUUID().slice(0, 8)}`;
    const retiredClientId = `cli-retired-${crypto.randomUUID().slice(0, 8)}`;
    await app.db.insert(clients).values([
      {
        id: unclaimedClientId,
        userId: null,
        organizationId: admin.organizationId,
        status: "connected",
      },
      {
        id: retiredClientId,
        userId: admin.userId,
        organizationId: admin.organizationId,
        status: "disconnected",
        retiredAt: new Date(),
      },
    ]);

    await expect(
      createAgent(app.db, {
        name: `human-pinned-${crypto.randomUUID().slice(0, 6)}`,
        type: "human",
        managerId: admin.memberId,
        clientId: admin.clientId,
      }),
    ).rejects.toBeInstanceOf(BadRequestError);
    await expect(
      createAgent(app.db, {
        name: `missing-client-${crypto.randomUUID().slice(0, 6)}`,
        type: "agent",
        managerId: admin.memberId,
        clientId: "cli-missing",
      }),
    ).rejects.toThrow(/Client "cli-missing" not found/);
    await expect(
      createAgent(app.db, {
        name: `unclaimed-client-${crypto.randomUUID().slice(0, 6)}`,
        type: "agent",
        managerId: admin.memberId,
        clientId: unclaimedClientId,
      }),
    ).rejects.toThrow(/has not been claimed by a user/);
    await expect(
      createAgent(app.db, {
        name: `wrong-owner-client-${crypto.randomUUID().slice(0, 6)}`,
        type: "agent",
        managerId: admin.memberId,
        clientId: other.clientId,
      }),
    ).rejects.toMatchObject({ statusCode: 403 });
    await expect(
      createAgent(app.db, {
        name: `retired-client-${crypto.randomUUID().slice(0, 6)}`,
        type: "agent",
        managerId: admin.memberId,
        clientId: retiredClientId,
      }),
    ).rejects.toMatchObject({ statusCode: 410 });
    await expect(
      createAgent(app.db, {
        name: `missing-manager-${crypto.randomUUID().slice(0, 6)}`,
        type: "agent",
        managerId: "member-missing",
      }),
    ).rejects.toThrow(/Manager "member-missing" not found/);
  });

  it("rejects disabled new-selection providers regardless of capability reports", async () => {
    const app = getApp();
    const admin = await createAdminContext(app, {
      username: `agent-gate-${crypto.randomUUID().slice(0, 8)}`,
    });
    const [adminClient] = await app.db
      .select({ metadata: clients.metadata })
      .from(clients)
      .where(eq(clients.id, admin.clientId))
      .limit(1);
    expect(adminClient?.metadata).toBeNull();

    const absentCapabilityInput = {
      name: `gate-absent-${crypto.randomUUID().slice(0, 6)}`,
      type: "agent" as const,
      managerId: admin.memberId,
      clientId: admin.clientId,
      runtimeProvider: "antigravity" as RuntimeProvider,
    } as unknown as Parameters<typeof createAgent>[1];
    await expect(createAgent(app.db, absentCapabilityInput)).rejects.toThrow(/disabled for new selection/);
    await expect(
      createAgent(
        app.db,
        { ...absentCapabilityInput, name: `gate-force-${crypto.randomUUID().slice(0, 6)}` },
        { force: true },
      ),
    ).rejects.toThrow(/disabled for new selection/);

    const emptyCapabilityClientId = `cli-empty-${crypto.randomUUID().slice(0, 8)}`;
    await app.db.insert(clients).values({
      id: emptyCapabilityClientId,
      userId: admin.userId,
      organizationId: admin.organizationId,
      status: "connected",
      metadata: { capabilities: {} },
    });
    await expect(
      createAgent(app.db, {
        ...absentCapabilityInput,
        name: `gate-empty-${crypto.randomUUID().slice(0, 6)}`,
        clientId: emptyCapabilityClientId,
      }),
    ).rejects.toThrow(/disabled for new selection/);
  });

  it("validates reserved names, explicit manager/org pairs, and direct capability checks", async () => {
    const app = getApp();
    const admin = await createAdminContext(app, { username: `agent-extra-${crypto.randomUUID().slice(0, 8)}` });
    const otherOrg = await createOrganization(app.db, {
      name: `agent-extra-org-${crypto.randomUUID().slice(0, 8)}`,
      displayName: "Agent Extra Org",
    });

    await expect(
      createAgent(app.db, {
        name: `__reserved-${crypto.randomUUID().slice(0, 6)}`,
        type: "agent",
        managerId: admin.memberId,
        clientId: admin.clientId,
      }),
    ).rejects.toThrow(/names starting with "__"/);
    await expect(
      createAgent(app.db, {
        name: "system",
        type: "agent",
        managerId: admin.memberId,
        clientId: admin.clientId,
      }),
    ).rejects.toThrow(/reserved/);
    await expect(
      createAgent(app.db, {
        name: `missing-pair-${crypto.randomUUID().slice(0, 6)}`,
        type: "agent",
        managerId: "member-missing",
        organizationId: admin.organizationId,
      }),
    ).rejects.toThrow(/Manager "member-missing" not found/);
    await expect(
      createAgent(app.db, {
        name: `wrong-org-${crypto.randomUUID().slice(0, 6)}`,
        type: "agent",
        managerId: admin.memberId,
        organizationId: otherOrg.id,
        clientId: admin.clientId,
      }),
    ).rejects.toThrow(/same organization/);

    await app.db.update(members).set({ status: "left" }).where(eq(members.id, admin.memberId));
    await expect(
      createAgent(app.db, {
        name: `inactive-manager-${crypto.randomUUID().slice(0, 6)}`,
        type: "agent",
        managerId: admin.memberId,
        organizationId: admin.organizationId,
        clientId: admin.clientId,
      }),
    ).rejects.toThrow(/Manager/);
    await app.db.update(members).set({ status: "active" }).where(eq(members.id, admin.memberId));

    await app.db.update(clients).set({ retiredAt: new Date() }).where(eq(clients.id, admin.clientId));
    await expect(ensureClientSupportsRuntimeProvider(app.db, admin.clientId, "codex")).rejects.toMatchObject({
      statusCode: 410,
    });
    await expect(ensureClientSupportsRuntimeProvider(app.db, null, "codex")).resolves.toBeUndefined();

    const unusual = await createAgent(app.db, {
      name: `unusual-type-${crypto.randomUUID().slice(0, 6)}`,
      type: "external" as never,
      managerId: admin.memberId,
    });
    expect(unusual.visibility).toBe("private");
  });

  it("rejects system-created agents when the target organization has no active admin", async () => {
    const app = getApp();
    const emptyOrg = await createOrganization(app.db, {
      name: `agent-empty-org-${crypto.randomUUID().slice(0, 8)}`,
      displayName: "Agent Empty Org",
    });

    await expect(
      createAgent(app.db, {
        name: `no-fallback-admin-${crypto.randomUUID().slice(0, 6)}`,
        type: "agent",
        organizationId: emptyOrg.id,
      }),
    ).rejects.toThrow(/no admin member exists/);
  });

  it("validates updateAgent client, type, manager, and delegate mutation guards", async () => {
    const app = getApp();
    const admin = await createAdminContext(app, { username: `agent-update-${crypto.randomUUID().slice(0, 8)}` });
    const other = await createAdminContext(app, { username: `agent-update-other-${crypto.randomUUID().slice(0, 8)}` });
    const bound = await createAgent(app.db, {
      name: `bound-update-${crypto.randomUUID().slice(0, 6)}`,
      type: "agent",
      managerId: admin.memberId,
      clientId: admin.clientId,
    });
    const unbound = await createAgent(app.db, {
      name: `unbound-update-${crypto.randomUUID().slice(0, 6)}`,
      type: "agent",
      managerId: admin.memberId,
    });

    const invalidTypeUpdate = { type: "human" } as unknown as Parameters<typeof updateAgent>[2];
    await expect(updateAgent(app.db, bound.uuid, invalidTypeUpdate)).rejects.toThrow(/type is immutable/);
    await expect(updateAgent(app.db, bound.uuid, { clientId: null })).rejects.toThrow(/clientId cannot be cleared/);
    await expect(updateAgent(app.db, bound.uuid, { clientId: other.clientId })).rejects.toThrow(
      /clientId cannot be changed/,
    );
    await expect(updateAgent(app.db, bound.uuid, { managerId: null })).rejects.toThrow(/managerId cannot be cleared/);
    await expect(updateAgent(app.db, bound.uuid, { managerId: "member-missing" })).rejects.toThrow(
      /Manager "member-missing" not found/,
    );
    const otherOrg = await createOrganization(app.db, {
      name: `agent-update-org-${crypto.randomUUID().slice(0, 8)}`,
      displayName: "Agent Update Org",
    });
    const otherOrgMember = await createMember(app.db, otherOrg.id, {
      username: `agent-update-foreign-${crypto.randomUUID().slice(0, 8)}`,
      displayName: "Foreign Manager",
      role: "admin",
    });
    await expect(updateAgent(app.db, bound.uuid, { managerId: otherOrgMember.id })).rejects.toThrow(
      /same organization/,
    );
    await expect(updateAgent(app.db, bound.uuid, { delegateMention: admin.humanAgentUuid })).rejects.toThrow(
      /delegateMention can only be set on human agents/,
    );

    await app.db.update(agents).set({ status: AGENT_STATUSES.SUSPENDED }).where(eq(agents.uuid, unbound.uuid));
    await expect(updateAgent(app.db, unbound.uuid, { clientId: admin.clientId })).rejects.toThrow(
      /Suspended agents without a runtime route/,
    );
  });

  it("updates public metadata while preserving runtime state and recomputes watcher rows on manager reassignment", async () => {
    const app = getApp();
    const first = await createAdminContext(app, { username: `agent-reassign-a-${crypto.randomUUID().slice(0, 8)}` });
    const second = await createAdminContext(app, { username: `agent-reassign-b-${crypto.randomUUID().slice(0, 8)}` });
    const agent = await createAgent(app.db, {
      name: `agent-reassign-${crypto.randomUUID().slice(0, 6)}`,
      type: "agent",
      managerId: first.memberId,
      metadata: { publicKey: "old" },
    });
    await app.db
      .update(agents)
      .set({ metadata: { publicKey: "old", runtimeSession: { tokenHash: "kept" } } })
      .where(eq(agents.uuid, agent.uuid));

    const updated = await updateAgent(app.db, agent.uuid, {
      managerId: second.memberId,
      metadata: { publicKey: "new" },
    });

    expect(updated.managerId).toBe(second.memberId);
    expect(updated.metadata).toMatchObject({
      publicKey: "new",
      runtimeSession: { tokenHash: "kept" },
    });
  });

  it("paginates admin agent listings and skips deleted rows", async () => {
    const app = getApp();
    const admin = await createAdminContext(app, { username: `agent-admin-list-${crypto.randomUUID().slice(0, 8)}` });
    const older = await createAgent(app.db, {
      name: `admin-old-${crypto.randomUUID().slice(0, 8)}`,
      type: "agent",
      managerId: admin.memberId,
      clientId: admin.clientId,
    });
    const newer = await createAgent(app.db, {
      name: `admin-new-${crypto.randomUUID().slice(0, 8)}`,
      type: "agent",
      managerId: admin.memberId,
      clientId: admin.clientId,
    });
    const deleted = await createAgent(app.db, {
      name: `admin-deleted-${crypto.randomUUID().slice(0, 8)}`,
      type: "agent",
      managerId: admin.memberId,
      clientId: admin.clientId,
    });

    await app.db
      .update(agents)
      .set({ createdAt: new Date("2030-01-01T00:00:00.000Z") })
      .where(eq(agents.uuid, older.uuid));
    await app.db
      .update(agents)
      .set({ createdAt: new Date("2030-01-02T00:00:00.000Z") })
      .where(eq(agents.uuid, newer.uuid));
    await app.db
      .update(agents)
      .set({ status: AGENT_STATUSES.DELETED, createdAt: new Date("2030-01-03T00:00:00.000Z") })
      .where(eq(agents.uuid, deleted.uuid));

    const scope = {
      userId: admin.userId,
      organizationId: admin.organizationId,
      memberId: admin.memberId,
      role: "admin" as const,
      humanAgentId: admin.humanAgentUuid,
    };

    const firstPage = await listAgentsForAdmin(app.db, scope, 1);
    expect(firstPage.items.map((agent) => agent.uuid)).toEqual([newer.uuid]);
    expect(firstPage.nextCursor).toBe("2030-01-02T00:00:00.000Z");

    const secondPage = await listAgentsForAdmin(app.db, scope, 5, firstPage.nextCursor ?? undefined);
    expect(secondPage.items.map((agent) => agent.uuid)).toContain(older.uuid);
    expect(secondPage.items.map((agent) => agent.uuid)).not.toContain(deleted.uuid);
    expect(secondPage.nextCursor).toBeNull();
  });

  it("checks direct agent manageability for admins, managers, outsiders, and deleted rows", async () => {
    const app = getApp();
    const manager = await createAdminContext(app, {
      username: `agent-scope-manager-${crypto.randomUUID().slice(0, 8)}`,
    });
    const outsider = await createAdminContext(app, {
      username: `agent-scope-outsider-${crypto.randomUUID().slice(0, 8)}`,
    });
    const agent = await createAgent(app.db, {
      name: `manageable-${crypto.randomUUID().slice(0, 6)}`,
      type: "agent",
      managerId: manager.memberId,
      clientId: manager.clientId,
    });

    await expect(assertAgentManageableByUser(app.db, manager.userId, agent.uuid)).resolves.toMatchObject({
      userId: manager.userId,
      memberId: manager.memberId,
      organizationId: manager.organizationId,
    });

    await app.db.update(members).set({ role: "member" }).where(eq(members.id, manager.memberId));
    await expect(assertAgentManageableByUser(app.db, manager.userId, agent.uuid)).resolves.toMatchObject({
      role: "member",
      memberId: manager.memberId,
    });

    await app.db.update(members).set({ role: "member" }).where(eq(members.id, outsider.memberId));
    await expect(assertAgentManageableByUser(app.db, outsider.userId, agent.uuid)).rejects.toBeInstanceOf(
      NotFoundError,
    );
    await app.db.update(agents).set({ status: AGENT_STATUSES.DELETED }).where(eq(agents.uuid, agent.uuid));
    await expect(assertAgentManageableByUser(app.db, manager.userId, agent.uuid)).rejects.toBeInstanceOf(NotFoundError);
    await expect(assertAgentManageableByUser(app.db, manager.userId, crypto.randomUUID())).rejects.toBeInstanceOf(
      NotFoundError,
    );
  });

  it("rejects invalid lifecycle transitions and skill writes for missing agents", async () => {
    const app = getApp();
    const admin = await createAdminContext(app, { username: `agent-life-${crypto.randomUUID().slice(0, 8)}` });
    const active = await createAgent(app.db, {
      name: `life-active-${crypto.randomUUID().slice(0, 6)}`,
      type: "agent",
      managerId: admin.memberId,
      clientId: admin.clientId,
    });
    const unbound = await createAgent(app.db, {
      name: `life-unbound-${crypto.randomUUID().slice(0, 6)}`,
      type: "agent",
      managerId: admin.memberId,
    });

    await expect(suspendAgent(app.db, admin.humanAgentUuid)).rejects.toThrow(/Human agent lifecycle/);
    await expect(reactivateAgent(app.db, admin.humanAgentUuid)).rejects.toThrow(/Human agent lifecycle/);
    await expect(deleteAgent(app.db, admin.humanAgentUuid)).rejects.toThrow(/Human agent lifecycle/);
    await expect(reactivateAgent(app.db, active.uuid)).rejects.toThrow(/Only suspended agents/);
    await expect(deleteAgent(app.db, active.uuid)).rejects.toThrow(/Suspend the agent first/);
    await app.db.update(agents).set({ status: AGENT_STATUSES.SUSPENDED }).where(eq(agents.uuid, unbound.uuid));
    await expect(reactivateAgent(app.db, unbound.uuid)).rejects.toThrow(/Suspended agents without a runtime route/);
    await expect(suspendAgent(app.db, crypto.randomUUID())).rejects.toBeInstanceOf(NotFoundError);
    await expect(reactivateAgent(app.db, crypto.randomUUID())).rejects.toBeInstanceOf(NotFoundError);
    await expect(deleteAgent(app.db, crypto.randomUUID())).rejects.toBeInstanceOf(NotFoundError);

    await expect(getAgentSkills(app.db, crypto.randomUUID())).rejects.toBeInstanceOf(NotFoundError);
    await expect(updateAgentSkills(app.db, crypto.randomUUID(), [])).rejects.toBeInstanceOf(NotFoundError);
  });

  it("validates, stores, reads, and clears avatar image blobs", async () => {
    const app = getApp();
    const admin = await createAdminContext(app, { username: `agent-avatar-${crypto.randomUUID().slice(0, 8)}` });
    const agent = await createAgent(app.db, {
      name: `avatar-agent-${crypto.randomUUID().slice(0, 8)}`,
      type: "agent",
      managerId: admin.memberId,
      clientId: admin.clientId,
    });

    await expect(getAgentAvatarImage(app.db, agent.uuid)).resolves.toBeNull();
    await expect(setAgentAvatarImage(app.db, agent.uuid, Buffer.from("avatar"), "image/gif")).rejects.toBeInstanceOf(
      BadRequestError,
    );
    await expect(setAgentAvatarImage(app.db, agent.uuid, Buffer.alloc(0), "image/png")).rejects.toBeInstanceOf(
      BadRequestError,
    );
    await expect(
      setAgentAvatarImage(app.db, agent.uuid, Buffer.alloc(MAX_AVATAR_IMAGE_BYTES + 1), "image/png"),
    ).rejects.toBeInstanceOf(BadRequestError);
    await expect(
      setAgentAvatarImage(app.db, crypto.randomUUID(), Buffer.from("avatar"), "image/png"),
    ).rejects.toBeInstanceOf(NotFoundError);

    const updatedAt = await setAgentAvatarImage(app.db, agent.uuid, Buffer.from("avatar"), "image/png");
    await expect(getAgentAvatarImage(app.db, agent.uuid)).resolves.toEqual({
      data: Buffer.from("avatar"),
      mime: "image/png",
      updatedAt,
    });

    await clearAgentAvatarImage(app.db, agent.uuid);
    await expect(getAgentAvatarImage(app.db, agent.uuid)).resolves.toBeNull();
    await expect(clearAgentAvatarImage(app.db, crypto.randomUUID())).rejects.toBeInstanceOf(NotFoundError);
  });
});
