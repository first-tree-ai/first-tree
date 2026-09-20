import { createHmac, generateKeyPairSync, randomUUID } from "node:crypto";
import type { GithubAppInstallationPermissions } from "@first-tree/shared";
import { and, eq, sql } from "drizzle-orm";
import { afterEach, describe, expect, it, vi } from "vitest";
import { agentChatSessions } from "../db/schema/agent-chat-sessions.js";
import { agents } from "../db/schema/agents.js";
import { chatMembership } from "../db/schema/chat-membership.js";
import { chatUserState } from "../db/schema/chat-user-state.js";
import { chats } from "../db/schema/chats.js";
import { githubAppInstallations } from "../db/schema/github-app-installations.js";
import { githubEntityChatMappings } from "../db/schema/github-entity-chat-mappings.js";
import { inboxEntries } from "../db/schema/inbox-entries.js";
import { members } from "../db/schema/members.js";
import { messages } from "../db/schema/messages.js";
import { users } from "../db/schema/users.js";
import { createChat } from "../services/chat/conversation.js";
import * as eventDedupService from "../services/event-dedup.js";
import * as githubAudienceService from "../services/scm/github/audience.js";
import * as githubEntityStateService from "../services/scm/github/entity-state.js";
import { putOrgSetting } from "../services/settings/organization.js";
import { putTeamAgentAssignment } from "../services/team-agent-settings.js";
import { uuidv7 } from "../uuid.js";
import { createTestAdmin, seedClient, seedHealthyAgentRuntime, useTestApp } from "./helpers.js";

const APP_WEBHOOK_SECRET = "test-app-webhook-secret";
const { privateKey: TEST_APP_PRIVATE_KEY_PEM } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
});

function signBody(secret: string, body: string): string {
  return `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
}

type App = ReturnType<ReturnType<typeof useTestApp>>;

async function postWebhook(
  app: App,
  eventType: string,
  payload: object,
  opts: { secret?: string; deliveryId?: string; skipDelivery?: boolean; skipSignature?: boolean } = {},
) {
  const body = JSON.stringify(payload);
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "x-github-event": eventType,
  };
  if (!opts.skipDelivery) headers["x-github-delivery"] = opts.deliveryId ?? randomUUID();
  if (!opts.skipSignature) {
    headers["x-hub-signature-256"] = signBody(opts.secret ?? APP_WEBHOOK_SECRET, body);
  }
  return app.inject({
    method: "POST",
    url: "/api/v1/webhooks/github-app",
    headers,
    payload: body,
  });
}

async function postRawWebhook(
  app: App,
  eventType: string | null,
  body: string,
  opts: { secret?: string; deliveryId?: string; skipDelivery?: boolean; skipSignature?: boolean } = {},
) {
  const headers: Record<string, string> = {
    "content-type": "application/json",
  };
  if (!opts.skipDelivery) headers["x-github-delivery"] = opts.deliveryId ?? randomUUID();
  if (eventType !== null) headers["x-github-event"] = eventType;
  if (!opts.skipSignature) {
    headers["x-hub-signature-256"] = signBody(opts.secret ?? APP_WEBHOOK_SECRET, body);
  }
  return app.inject({
    method: "POST",
    url: "/api/v1/webhooks/github-app",
    headers,
    payload: body,
  });
}

async function seedAgent(
  app: App,
  opts: { orgId: string; memberId: string; name: string; type?: "agent" | "human"; delegateMention?: string | null },
): Promise<string> {
  const uuid = randomUUID();
  const managerId = opts.type === "human" ? randomUUID() : opts.memberId;
  if (opts.type === "human") {
    const userId = randomUUID();
    await app.db.transaction(async (tx) => {
      await tx.insert(users).values({
        id: userId,
        username: `user-${uuid}`,
        passwordHash: "test",
        displayName: opts.name,
      });
      await tx.insert(agents).values({
        uuid,
        name: opts.name,
        organizationId: opts.orgId,
        type: "human",
        displayName: opts.name,
        inboxId: `inbox_${uuid}`,
        managerId,
        delegateMention: opts.delegateMention ?? null,
        visibility: "organization",
      });
      await tx.insert(members).values({
        id: managerId,
        userId,
        organizationId: opts.orgId,
        agentId: uuid,
        role: "member",
      });
    });
    return uuid;
  }
  await app.db.insert(agents).values({
    uuid,
    name: opts.name,
    organizationId: opts.orgId,
    type: "agent",
    displayName: opts.name,
    inboxId: `inbox_${uuid}`,
    managerId,
    delegateMention: opts.delegateMention ?? null,
    visibility: "organization",
  });
  return uuid;
}

async function seedInstallation(
  app: App,
  opts: {
    installationId: number;
    orgId: string | null;
    suspended?: boolean;
    permissions?: GithubAppInstallationPermissions;
  },
): Promise<void> {
  await app.db.insert(githubAppInstallations).values({
    id: uuidv7(),
    installationId: opts.installationId,
    accountType: "Organization",
    accountLogin: "owner",
    accountGithubId: 1000 + opts.installationId,
    hubOrganizationId: opts.orgId,
    permissions: opts.permissions ?? { contents: "read", pull_requests: "write", issues: "write" },
    events: ["pull_request", "issues"],
    suspendedAt: opts.suspended ? new Date(Date.now() - 1_000) : null,
  });
}

async function configureContextReviewer(app: App, admin: Awaited<ReturnType<typeof createTestAdmin>>) {
  const reviewer = await seedAgent(app, {
    orgId: admin.organizationId,
    memberId: admin.memberId,
    name: `context-reviewer-${randomUUID().slice(0, 6)}`,
  });
  const clientId = await seedClient(app, admin.userId, admin.organizationId);
  await app.db.update(agents).set({ clientId, runtimeProvider: "claude-code" }).where(eq(agents.uuid, reviewer));
  await seedHealthyAgentRuntime(app, {
    agentUuid: reviewer,
    clientId,
  });
  await app.db
    .update(githubAppInstallations)
    .set({ events: ["pull_request", "issue_comment", "pull_request_review_comment", "issues"] })
    .where(eq(githubAppInstallations.hubOrganizationId, admin.organizationId));
  await putOrgSetting(
    app.db,
    admin.organizationId,
    "context_tree",
    { repo: "https://github.com/owner/context-tree.git", branch: "main" },
    { updatedBy: admin.userId },
  );
  await putOrgSetting(
    app.db,
    admin.organizationId,
    "context_tree_features",
    { contextReviewer: { enabled: true, agentUuid: reviewer } },
    { updatedBy: admin.userId, memberId: admin.memberId },
  );
  return reviewer;
}

async function configureTeamAgent(app: App, admin: Awaited<ReturnType<typeof createTestAdmin>>) {
  const teamAgent = await seedAgent(app, {
    orgId: admin.organizationId,
    memberId: admin.memberId,
    name: `team-agent-${randomUUID().slice(0, 6)}`,
  });
  const clientId = await seedClient(app, admin.userId, admin.organizationId);
  await app.db.update(agents).set({ clientId, runtimeProvider: "claude-code" }).where(eq(agents.uuid, teamAgent));
  await seedHealthyAgentRuntime(app, {
    agentUuid: teamAgent,
    clientId,
  });
  await putTeamAgentAssignment(app.db, admin.organizationId, teamAgent, {
    updatedBy: admin.userId,
    appSlug: "test-app-slug",
  });
  return teamAgent;
}

function contextPullRequestPayload(installationId: number, repoFullName = "owner/context-tree") {
  return {
    action: "opened",
    pull_request: {
      number: 42,
      title: "Improve context review guidance",
      html_url: `https://github.com/${repoFullName}/pull/42`,
      body: "",
      base: { ref: "main" },
      head: { ref: "context-reviewer", sha: "a".repeat(40) },
      draft: false,
      user: { login: "context-writer", type: "User" },
    },
    repository: { full_name: repoFullName },
    sender: { login: "context-writer", type: "User" },
    installation: { id: installationId },
  };
}

function contextIssueCommentPayload(installationId: number, repoFullName = "owner/context-tree") {
  return {
    action: "created",
    issue: {
      number: 42,
      title: "Improve context review guidance",
      html_url: `https://github.com/${repoFullName}/issues/42`,
      user: { login: "context-writer", type: "User" },
      pull_request: { html_url: `https://github.com/${repoFullName}/pull/42` },
    },
    comment: {
      body: "Please take another pass.",
      html_url: `https://github.com/${repoFullName}/pull/42#issuecomment-2`,
      user: { login: "context-commenter" },
    },
    repository: { full_name: repoFullName },
    sender: { login: "context-commenter", type: "User" },
    installation: { id: installationId },
  };
}

function contextReviewerGithubFetch(liveHead = "a".repeat(40)) {
  return vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url.includes("/access_tokens") && init?.method === "POST") {
      return new Response(
        JSON.stringify({
          token: "installation-token",
          expires_at: "2030-01-01T00:00:00.000Z",
          permissions: { metadata: "read", pull_requests: "write" },
          repository_selection: "selected",
        }),
        { status: 201, headers: { "content-type": "application/json" } },
      );
    }
    if (url.endsWith("/repos/owner/context-tree/pulls/42")) {
      return new Response(
        JSON.stringify({
          number: 42,
          state: "open",
          draft: false,
          merged: false,
          head: { sha: liveHead },
          html_url: "https://github.com/owner/context-tree/pull/42",
          body: null,
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    return new Response("not found", { status: 404 });
  });
}

describe("POST /webhooks/github-app", () => {
  const getApp = useTestApp({ githubAppPrivateKeyPem: TEST_APP_PRIVATE_KEY_PEM });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns 401 on a bad HMAC signature", async () => {
    const app = getApp();
    const res = await postWebhook(app, "ping", { zen: "x" }, { secret: "wrong-secret" });
    expect(res.statusCode).toBe(401);
  });

  it("returns 401 when the signature header is missing", async () => {
    const app = getApp();
    const res = await postWebhook(app, "ping", { zen: "x" }, { skipSignature: true });
    expect(res.statusCode).toBe(401);
  });

  it("returns 200 fast-path on a ping event", async () => {
    const app = getApp();
    const res = await postWebhook(app, "ping", { zen: "Anything added dilutes everything else." });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true, event: "ping" });
  });

  it("rejects malformed raw JSON and requests missing the GitHub event header", async () => {
    const app = getApp();

    const malformed = await postRawWebhook(app, "ping", "{");
    expect(malformed.statusCode).toBe(400);
    expect(malformed.json<{ error: string }>().error).toBe("Invalid JSON payload");

    const missingEvent = await postRawWebhook(app, null, JSON.stringify({ zen: "x" }));
    expect(missingEvent.statusCode).toBe(400);
    expect(missingEvent.json<{ error: string }>().error).toBe("Missing x-github-event header");
  });

  it("rejects non-buffer webhook bodies before signature parsing", async () => {
    const app = getApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/webhooks/github-app",
      headers: {
        "content-type": "text/plain",
        "x-github-event": "ping",
        "x-hub-signature-256": "sha256=ignored",
      },
      payload: "plain text",
    });

    expect(res.statusCode).toBe(400);
    expect(res.json<{ error: string }>().error).toBe("Expected raw body buffer");
  });

  it("installation.created → records the row unbound with the installer (direct install: no requester)", async () => {
    const app = getApp();
    const installationId = 100001;
    const payload = {
      action: "created",
      installation: {
        id: installationId,
        account: { id: 555, login: "octolabs", type: "Organization" },
        permissions: { contents: "read" },
        events: ["pull_request"],
        suspended_at: null,
      },
      // `sender` is the GitHub-authenticated installer — persisted as the
      // trusted `installer_github_id`.
      sender: { id: 777, login: "octo-admin", type: "User" },
    };
    const res = await postWebhook(app, "installation", payload);
    expect(res.statusCode).toBe(200);
    // Record-only: the row is created with its identity anchors, never bound.
    expect(res.json().lifecycle).toBe("created:recorded");

    const [row] = await app.db
      .select()
      .from(githubAppInstallations)
      .where(eq(githubAppInstallations.installationId, installationId))
      .limit(1);
    expect(row).toBeTruthy();
    expect(row?.accountLogin).toBe("octolabs");
    expect(row?.installerGithubId).toBe(777);
    expect(row?.requesterGithubId).toBeNull();
    expect(row?.hubOrganizationId).toBeNull();
  });

  it("installation.created accepts missing events arrays and installation unknown actions are no-ops", async () => {
    const app = getApp();
    const installationId = 100013;
    const created = await postWebhook(app, "installation", {
      action: "created",
      installation: {
        id: installationId,
        account: { id: 4245, login: "acme4", type: "Organization" },
        permissions: { contents: "read" },
        events: "pull_request",
        suspended_at: null,
      },
      sender: { id: 90213, login: "owner", type: "User" },
    });
    expect(created.statusCode).toBe(200);
    expect(created.json().lifecycle).toBe("created:recorded");

    const [row] = await app.db
      .select({ events: githubAppInstallations.events })
      .from(githubAppInstallations)
      .where(eq(githubAppInstallations.installationId, installationId))
      .limit(1);
    expect(row?.events).toEqual([]);

    const unknown = await postWebhook(app, "installation", {
      action: "unknown_action",
      installation: { id: installationId, account: { id: 4245, login: "acme4", type: "Organization" } },
    });
    expect(unknown.statusCode).toBe(200);
    expect(unknown.json().lifecycle).toBe("ignored:unknown-action");
  });

  it("installation lifecycle rejects malformed metadata defensively", async () => {
    const app = getApp();

    const notObject = await postRawWebhook(app, "installation", "null");
    expect(notObject.statusCode).toBe(200);
    expect(notObject.json().lifecycle).toBe("ignored:malformed");

    const repos = await postWebhook(app, "installation_repositories", {
      action: "added",
      installation: { id: 100099 },
    });
    expect(repos.statusCode).toBe(200);
    expect(repos.json().lifecycle).toBe("noop");

    const missingInstallation = await postWebhook(app, "installation", { action: "created" });
    expect(missingInstallation.statusCode).toBe(200);
    expect(missingInstallation.json().lifecycle).toBe("ignored:malformed");

    const invalidMetadataCases = [
      { id: Number.NaN, account: { id: 1, login: "x", type: "Organization" } },
      { id: 100101 },
      { id: 100102, account: { id: "1", login: "x", type: "Organization" } },
      { id: 100103, account: { id: 1, login: "x", type: "Bot" } },
    ];
    for (const installation of invalidMetadataCases) {
      const res = await postWebhook(app, "installation", { action: "created", installation });
      expect(res.statusCode).toBe(200);
      expect(res.json().lifecycle).toBe("ignored:malformed");
    }

    const invalidPermissions = await postWebhook(app, "installation", {
      action: "created",
      installation: {
        id: 100104,
        account: { id: 1, login: "fallback-permissions", type: "Organization" },
        permissions: { contents: 123 },
        events: ["pull_request", 42, "issues"],
        suspended_at: "2026-05-13T00:00:00Z",
      },
      sender: { id: "not-a-number" },
      requester: null,
    });
    expect(invalidPermissions.statusCode).toBe(200);
    expect(invalidPermissions.json().lifecycle).toBe("created:recorded");
    const [row] = await app.db
      .select()
      .from(githubAppInstallations)
      .where(eq(githubAppInstallations.installationId, 100104))
      .limit(1);
    expect(row).toMatchObject({
      permissions: {},
      events: ["pull_request", "issues"],
      installerGithubId: null,
      requesterGithubId: null,
    });
    expect(row?.suspendedAt).toBeTruthy();
  });

  it("installation.created via the approval flow records BOTH the requester and the approving installer", async () => {
    const app = getApp();
    const installationId = 100010;
    const res = await postWebhook(app, "installation", {
      action: "created",
      installation: {
        id: installationId,
        account: { id: 4242, login: "acme-inc", type: "Organization" },
        permissions: { contents: "read" },
        events: ["pull_request"],
        suspended_at: null,
      },
      // Approval flow: `sender` is the approving org OWNER, while the
      // top-level `requester` is the member who asked for the install —
      // the identity the connect panel must be able to match.
      sender: { id: 90210, login: "acme-owner", type: "User" },
      requester: { id: 111, login: "acme-member", type: "User" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().lifecycle).toBe("created:recorded");

    const [row] = await app.db
      .select()
      .from(githubAppInstallations)
      .where(eq(githubAppInstallations.installationId, installationId))
      .limit(1);
    expect(row?.installerGithubId).toBe(90210);
    expect(row?.requesterGithubId).toBe(111);
    expect(row?.hubOrganizationId).toBeNull();
  });

  it("installation.created NEVER binds — even when the installer is a known team admin", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app);
    const installationId = 100011;
    // The installer's GitHub id belonging to a First Tree admin changes
    // nothing at webhook time: the webhook cannot know which team the
    // installation should connect to, so it records and stops. Binding is
    // the admin's explicit connect-panel action.
    const res = await postWebhook(app, "installation", {
      action: "created",
      installation: {
        id: installationId,
        account: { id: 4243, login: "acme2", type: "Organization" },
        permissions: { contents: "read" },
        events: ["pull_request"],
        suspended_at: null,
      },
      sender: { id: 90211, login: admin.username, type: "User" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().lifecycle).toBe("created:recorded");

    const [row] = await app.db
      .select()
      .from(githubAppInstallations)
      .where(eq(githubAppInstallations.installationId, installationId))
      .limit(1);
    expect(row?.hubOrganizationId).toBeNull();
  });

  it("new_permissions_accepted preserves the recorded requester + installer (COALESCE, different sender)", async () => {
    const app = getApp();
    const installationId = 100012;
    const base = {
      id: installationId,
      account: { id: 4244, login: "acme3", type: "Organization" },
      permissions: { contents: "read" },
      events: ["pull_request"],
      suspended_at: null,
    };
    await postWebhook(app, "installation", {
      action: "created",
      installation: base,
      sender: { id: 90212, login: "owner", type: "User" },
      requester: { id: 112, login: "member", type: "User" },
    });
    // A different admin accepts new permissions later — the original
    // identity anchors must survive the metadata refresh.
    const res = await postWebhook(app, "installation", {
      action: "new_permissions_accepted",
      installation: { ...base, permissions: { contents: "write" } },
      sender: { id: 99999, login: "another-admin", type: "User" },
    });
    expect(res.statusCode).toBe(200);

    const [row] = await app.db
      .select()
      .from(githubAppInstallations)
      .where(eq(githubAppInstallations.installationId, installationId))
      .limit(1);
    expect(row?.permissions).toEqual({ contents: "write" });
    expect(row?.installerGithubId).toBe(90212);
    expect(row?.requesterGithubId).toBe(112);
  });

  it("installation.deleted → removes the row", async () => {
    const app = getApp();
    const installationId = 100002;
    await seedInstallation(app, { installationId, orgId: null });

    const res = await postWebhook(app, "installation", {
      action: "deleted",
      installation: { id: installationId, account: { id: 999, login: "x", type: "User" } },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().lifecycle).toBe("deleted");
    const rows = await app.db
      .select()
      .from(githubAppInstallations)
      .where(eq(githubAppInstallations.installationId, installationId));
    expect(rows).toHaveLength(0);
  });

  it("installation.suspend → sets suspended_at", async () => {
    const app = getApp();
    const installationId = 100003;
    await seedInstallation(app, { installationId, orgId: null });

    const res = await postWebhook(app, "installation", {
      action: "suspend",
      installation: {
        id: installationId,
        account: { id: 1, login: "x", type: "User" },
        suspended_at: "2026-05-13T00:00:00Z",
      },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().lifecycle).toBe("suspended");

    const [row] = await app.db
      .select({ suspendedAt: githubAppInstallations.suspendedAt })
      .from(githubAppInstallations)
      .where(eq(githubAppInstallations.installationId, installationId))
      .limit(1);
    expect(row?.suspendedAt).toBeTruthy();
  });

  it("installation.unsuspend clears suspended_at", async () => {
    const app = getApp();
    const installationId = 100014;
    await seedInstallation(app, { installationId, orgId: null, suspended: true });

    const res = await postWebhook(app, "installation", {
      action: "unsuspend",
      installation: {
        id: installationId,
        account: { id: 1, login: "x", type: "User" },
      },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().lifecycle).toBe("unsuspended");

    const [row] = await app.db
      .select({ suspendedAt: githubAppInstallations.suspendedAt })
      .from(githubAppInstallations)
      .where(eq(githubAppInstallations.installationId, installationId))
      .limit(1);
    expect(row?.suspendedAt).toBeNull();
  });

  it("returns ignored:no installation context when payload lacks an installation block", async () => {
    const app = getApp();
    const res = await postWebhook(app, "issues", {
      action: "opened",
      issue: { number: 1, title: "x" },
      repository: { full_name: "owner/repo" },
      sender: { login: "anyone", type: "User" },
      // no installation field
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().ignored).toBe("no installation context");
  });

  it("returns ignored:installation not seen when installation_id is unknown", async () => {
    const app = getApp();
    const res = await postWebhook(app, "issues", {
      action: "opened",
      issue: { number: 1, title: "x", html_url: "https://github.com/owner/repo/issues/1", body: "" },
      repository: { full_name: "owner/repo" },
      sender: { login: "anyone", type: "User" },
      installation: { id: 9_999_999 },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().ignored).toBe("installation not seen");
  });

  it("returns ignored:installation not bound for an unbound installation", async () => {
    const app = getApp();
    const installationId = 100010;
    await seedInstallation(app, { installationId, orgId: null });
    const res = await postWebhook(app, "issues", {
      action: "opened",
      issue: { number: 1, title: "x", html_url: "https://github.com/owner/repo/issues/1", body: "" },
      repository: { full_name: "owner/repo" },
      sender: { login: "anyone", type: "User" },
      installation: { id: installationId },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().ignored).toBe("installation not bound");
  });

  it("returns ignored:suspended for a suspended installation", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app);
    const installationId = 100011;
    await seedInstallation(app, { installationId, orgId: admin.organizationId, suspended: true });
    const res = await postWebhook(app, "issues", {
      action: "opened",
      issue: { number: 1, title: "x", html_url: "https://github.com/owner/repo/issues/1", body: "" },
      repository: { full_name: "owner/repo" },
      sender: { login: "anyone", type: "User" },
      installation: { id: installationId },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().ignored).toBe("suspended");
  });

  it("returns handled=false for unsupported repository events after state seed resolution no-ops", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app);
    const installationId = 100015;
    await seedInstallation(app, { installationId, orgId: admin.organizationId });

    const res = await postWebhook(app, "star", {
      action: "created",
      repository: { full_name: "owner/repo" },
      sender: { login: "stargazer", type: "User" },
      installation: { id: installationId },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: true, event: "star", handled: false });
  });

  it("handles repository events without a delivery header", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app);
    const installationId = 100018;
    await seedInstallation(app, { installationId, orgId: admin.organizationId });

    const res = await postWebhook(
      app,
      "star",
      {
        action: "created",
        repository: { full_name: "owner/repo" },
        sender: { login: "stargazer", type: "User" },
        installation: { id: installationId },
      },
      { skipDelivery: true },
    );

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: true, event: "star", handled: false });
  });

  it("does not claim a supported event when x-github-delivery is absent", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app);
    const installationId = 100023;
    await seedInstallation(app, { installationId, orgId: admin.organizationId });
    const claimSpy = vi.spyOn(eventDedupService, "claimEvent");
    const payload = {
      action: "opened",
      issue: {
        number: 923,
        title: "No delivery id",
        html_url: "https://github.com/owner/repo/issues/923",
        body: "",
        assignees: [],
      },
      repository: { full_name: "owner/repo" },
      sender: { login: "external", type: "User" },
      installation: { id: installationId },
    };

    try {
      const first = await postWebhook(app, "issues", payload, { skipDelivery: true });
      const second = await postWebhook(app, "issues", payload, { skipDelivery: true });

      expect(first.statusCode).toBe(200);
      expect(first.json()).toMatchObject({ event: "issues", audience: 0 });
      expect(second.statusCode).toBe(200);
      expect(second.json()).toMatchObject({ event: "issues", audience: 0 });
      expect(claimSpy).not.toHaveBeenCalled();
    } finally {
      claimSpy.mockRestore();
    }
  });

  it("derives PR state seeds from issue comment payload fallbacks", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app);
    const installationId = 100019;
    await seedInstallation(app, { installationId, orgId: admin.organizationId });

    const closedMerged = await postWebhook(app, "issue_comment", {
      action: "edited",
      issue: {
        number: 77,
        title: "PR issue comment",
        html_url: "https://github.com/owner/repo/issues/77",
        state: "closed",
        pull_request: { html_url: "https://github.com/owner/repo/pull/77", merged_at: "2026-01-01T00:00:00Z" },
      },
      repository: { full_name: "owner/repo" },
      sender: { login: "commenter", type: "User" },
      installation: { id: installationId },
    });
    expect(closedMerged.statusCode).toBe(200);
    expect(closedMerged.json()).toMatchObject({ handled: false });

    const draftOpen = await postWebhook(app, "issue_comment", {
      action: "edited",
      issue: {
        number: 78,
        title: "Draft PR issue comment",
        html_url: "https://github.com/owner/repo/issues/78",
        draft: true,
        pull_request: { html_url: "https://github.com/owner/repo/pull/78" },
      },
      repository: { full_name: "owner/repo" },
      sender: { login: "commenter", type: "User" },
      installation: { id: installationId },
    });
    expect(draftOpen.statusCode).toBe(200);
    expect(draftOpen.json()).toMatchObject({ handled: false });
  });

  it("tolerates malformed entity state seed payloads", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app);
    const installationId = 100022;
    await seedInstallation(app, { installationId, orgId: admin.organizationId });

    const malformedReviewComment = await postWebhook(app, "pull_request_review_comment", {
      action: "dismissed",
      pull_request: null,
      repository: { full_name: "owner/repo" },
      sender: { login: "reviewer", type: "User" },
      installation: { id: installationId },
    });
    expect(malformedReviewComment.statusCode).toBe(200);
    expect(malformedReviewComment.json()).toMatchObject({ handled: false });

    const malformedClosedPr = await postWebhook(app, "pull_request", {
      action: "closed",
      pull_request: null,
      repository: { full_name: "owner/repo" },
      sender: { login: "closer", type: "User" },
      installation: { id: installationId },
    });
    expect(malformedClosedPr.statusCode).toBe(200);
    expect(malformedClosedPr.json()).toMatchObject({ handled: false });

    const malformedIssue = await postWebhook(app, "issues", {
      action: "closed",
      issue: null,
      repository: { full_name: "owner/repo" },
      sender: { login: "closer", type: "User" },
      installation: { id: installationId },
    });
    expect(malformedIssue.statusCode).toBe(200);
    expect(malformedIssue.json()).toMatchObject({ handled: false });
  });

  it("continues delivery when entity state sync fails", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app);
    const installationId = 100016;
    await seedInstallation(app, { installationId, orgId: admin.organizationId });
    const stateSpy = vi
      .spyOn(githubEntityStateService, "setEntityState")
      .mockRejectedValueOnce(new Error("state sync down"));

    try {
      const res = await postWebhook(app, "issues", {
        action: "closed",
        issue: {
          number: 912,
          title: "Closed issue",
          html_url: "https://github.com/owner/repo/issues/912",
          body: "",
          state: "closed",
        },
        repository: { full_name: "owner/repo" },
        sender: { login: "closer", type: "User" },
        installation: { id: installationId },
      });

      expect(res.statusCode).toBe(200);
      expect(stateSpy).toHaveBeenCalled();
    } finally {
      stateSpy.mockRestore();
    }
  });

  it("unclaims a delivery when downstream handling fails and logs unclaim failures", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app);
    const installationId = 100017;
    const deliveryId = randomUUID();
    await seedInstallation(app, { installationId, orgId: admin.organizationId });
    const audienceSpy = vi
      .spyOn(githubAudienceService, "resolveGithubAudience")
      .mockRejectedValueOnce(new Error("audience down"));
    const unclaimSpy = vi.spyOn(eventDedupService, "unclaimEvent").mockRejectedValueOnce(new Error("unclaim down"));

    try {
      const res = await postWebhook(
        app,
        "issues",
        {
          action: "opened",
          issue: {
            number: 913,
            title: "Issue",
            html_url: "https://github.com/owner/repo/issues/913",
            body: "",
          },
          repository: { full_name: "owner/repo" },
          sender: { login: "author", type: "User" },
          installation: { id: installationId },
        },
        { deliveryId },
      );

      expect(res.statusCode).toBe(500);
      expect(audienceSpy).toHaveBeenCalled();
      expect(unclaimSpy).toHaveBeenCalledWith(app.db, deliveryId, "github");
    } finally {
      audienceSpy.mockRestore();
      unclaimSpy.mockRestore();
    }
  });

  it("Bug 1 — pull_request.synchronize delivers to subscribed chat (was silenced before)", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app);
    const installationId = 100020;
    await seedInstallation(app, { installationId, orgId: admin.organizationId });

    const delegate = await seedAgent(app, {
      orgId: admin.organizationId,
      memberId: admin.memberId,
      name: `dlg-${randomUUID().slice(0, 6)}`,
    });
    const human = await seedAgent(app, {
      orgId: admin.organizationId,
      memberId: admin.memberId,
      name: `human-${randomUUID().slice(0, 6)}`,
      delegateMention: delegate,
      type: "human",
    });
    const chatId = `chat_${randomUUID()}`;
    await app.db.insert(chats).values({ id: chatId, organizationId: admin.organizationId, type: "direct" });
    await app.db.insert(githubEntityChatMappings).values({
      organizationId: admin.organizationId,
      humanAgentId: human,
      delegateAgentId: delegate,
      entityType: "pull_request",
      entityKey: "owner/repo#700",
      chatId,
      boundVia: "direct",
    });

    const res = await postWebhook(app, "pull_request", {
      action: "synchronize",
      pull_request: {
        number: 700,
        title: "Refactor inbox",
        html_url: "https://github.com/owner/repo/pull/700",
        body: "",
      },
      repository: { full_name: "owner/repo" },
      sender: { login: "external-author", type: "User" },
      installation: { id: installationId },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().delivered).toBe(1);
    const sent = await app.db.select().from(messages).where(eq(messages.chatId, chatId));
    expect(sent).toHaveLength(1);
  });

  it("Bug 3 — issue_comment on a PR routes to the existing PR chat, not a new Issue chat", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app);
    const installationId = 100021;
    await seedInstallation(app, { installationId, orgId: admin.organizationId });

    const delegate = await seedAgent(app, {
      orgId: admin.organizationId,
      memberId: admin.memberId,
      name: `dlg-${randomUUID().slice(0, 6)}`,
    });
    const human = await seedAgent(app, {
      orgId: admin.organizationId,
      memberId: admin.memberId,
      name: `human-${randomUUID().slice(0, 6)}`,
      delegateMention: delegate,
      type: "human",
    });
    const prChatId = `chat_${randomUUID()}`;
    await app.db.insert(chats).values({ id: prChatId, organizationId: admin.organizationId, type: "direct" });
    await app.db.insert(githubEntityChatMappings).values({
      organizationId: admin.organizationId,
      humanAgentId: human,
      delegateAgentId: delegate,
      entityType: "pull_request",
      entityKey: "owner/repo#316",
      chatId: prChatId,
      boundVia: "direct",
    });

    const res = await postWebhook(app, "issue_comment", {
      action: "created",
      issue: {
        number: 316,
        title: "Improve onboarding",
        html_url: "https://github.com/owner/repo/issues/316",
        pull_request: { html_url: "https://github.com/owner/repo/pull/316" },
      },
      comment: { body: "ack", html_url: "https://github.com/owner/repo/pull/316#issuecomment-1" },
      repository: { full_name: "owner/repo" },
      sender: { login: "external-commenter", type: "User" },
      installation: { id: installationId },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().delivered).toBe(1);

    // No new chat with metadata.entityType="issue" should have been created.
    const sentToPRChat = await app.db.select().from(messages).where(eq(messages.chatId, prChatId));
    expect(sentToPRChat).toHaveLength(1);
    const issueMappings = await app.db
      .select()
      .from(githubEntityChatMappings)
      .where(eq(githubEntityChatMappings.entityType, "issue"));
    expect(issueMappings).toEqual([]);
  });

  it("pull_request.closed (merged=true) → syncs entity_state to 'merged' without delivering a message", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app);
    const installationId = 100030;
    await seedInstallation(app, { installationId, orgId: admin.organizationId });

    const delegate = await seedAgent(app, {
      orgId: admin.organizationId,
      memberId: admin.memberId,
      name: `dlg-${randomUUID().slice(0, 6)}`,
    });
    const human = await seedAgent(app, {
      orgId: admin.organizationId,
      memberId: admin.memberId,
      name: `human-${randomUUID().slice(0, 6)}`,
      delegateMention: delegate,
      type: "human",
    });
    const chatId = `chat_${randomUUID()}`;
    await app.db.insert(chats).values({ id: chatId, organizationId: admin.organizationId, type: "direct" });
    await app.db.insert(githubEntityChatMappings).values({
      organizationId: admin.organizationId,
      humanAgentId: human,
      delegateAgentId: delegate,
      entityType: "pull_request",
      entityKey: "owner/repo#820",
      chatId,
      boundVia: "direct",
    });

    const res = await postWebhook(app, "pull_request", {
      action: "closed",
      pull_request: {
        number: 820,
        title: "Implement archive on merge",
        html_url: "https://github.com/owner/repo/pull/820",
        body: "",
        merged: true,
      },
      repository: { full_name: "owner/repo" },
      sender: { login: "merger", type: "User" },
      installation: { id: installationId },
    });

    expect(res.statusCode).toBe(200);
    // normalize still drops pull_request.closed → no audience/deliver run.
    expect(res.json().handled).toBe(false);

    // Merge no longer flips engagement on the spot — the chat-archive
    // sweeper does that after the idle window. The webhook's job is just
    // to persist the upstream PR state.
    const stateRows = await app.db
      .select()
      .from(chatUserState)
      .where(and(eq(chatUserState.chatId, chatId), eq(chatUserState.agentId, human)));
    expect(stateRows).toHaveLength(0);

    const [mappingRow] = await app.db
      .select({
        entityState: githubEntityChatMappings.entityState,
        entityStateUpdatedAt: githubEntityChatMappings.entityStateUpdatedAt,
      })
      .from(githubEntityChatMappings)
      .where(and(eq(githubEntityChatMappings.chatId, chatId), eq(githubEntityChatMappings.entityKey, "owner/repo#820")))
      .limit(1);
    expect(mappingRow?.entityState).toBe("merged");
    expect(mappingRow?.entityStateUpdatedAt).not.toBeNull();

    const sent = await app.db.select().from(messages).where(eq(messages.chatId, chatId));
    expect(sent).toHaveLength(0);
  });

  it("pull_request.reopened → flips entity_state back to 'open'", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app);
    const installationId = 100032;
    await seedInstallation(app, { installationId, orgId: admin.organizationId });

    const delegate = await seedAgent(app, {
      orgId: admin.organizationId,
      memberId: admin.memberId,
      name: `dlg-${randomUUID().slice(0, 6)}`,
    });
    const human = await seedAgent(app, {
      orgId: admin.organizationId,
      memberId: admin.memberId,
      name: `human-${randomUUID().slice(0, 6)}`,
      delegateMention: delegate,
      type: "human",
    });
    const chatId = `chat_${randomUUID()}`;
    await app.db.insert(chats).values({ id: chatId, organizationId: admin.organizationId, type: "direct" });
    // Mapping was previously settled (merged) — reopened must un-settle it.
    await app.db.insert(githubEntityChatMappings).values({
      organizationId: admin.organizationId,
      humanAgentId: human,
      delegateAgentId: delegate,
      entityType: "pull_request",
      entityKey: "owner/repo#822",
      chatId,
      boundVia: "direct",
      entityState: "merged",
    });

    const res = await postWebhook(app, "pull_request", {
      action: "reopened",
      pull_request: {
        number: 822,
        title: "Reopened PR",
        html_url: "https://github.com/owner/repo/pull/822",
        body: "",
        merged: false,
      },
      repository: { full_name: "owner/repo" },
      sender: { login: "reopener", type: "User" },
      installation: { id: installationId },
    });

    expect(res.statusCode).toBe(200);

    const [mappingRow] = await app.db
      .select({ entityState: githubEntityChatMappings.entityState })
      .from(githubEntityChatMappings)
      .where(and(eq(githubEntityChatMappings.chatId, chatId), eq(githubEntityChatMappings.entityKey, "owner/repo#822")))
      .limit(1);
    expect(mappingRow?.entityState).toBe("open");
  });

  it("late opened webhooks do not overwrite newer persisted entity_state", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app);
    const installationId = 100036;
    await seedInstallation(app, { installationId, orgId: admin.organizationId });

    const delegate = await seedAgent(app, {
      orgId: admin.organizationId,
      memberId: admin.memberId,
      name: `dlg-${randomUUID().slice(0, 6)}`,
    });
    const human = await seedAgent(app, {
      orgId: admin.organizationId,
      memberId: admin.memberId,
      name: `human-${randomUUID().slice(0, 6)}`,
      delegateMention: delegate,
      type: "human",
    });
    const chatId = `chat_${randomUUID()}`;
    await app.db.insert(chats).values({ id: chatId, organizationId: admin.organizationId, type: "direct" });
    await app.db.insert(githubEntityChatMappings).values([
      {
        organizationId: admin.organizationId,
        humanAgentId: human,
        delegateAgentId: delegate,
        entityType: "pull_request",
        entityKey: "owner/repo#825",
        chatId,
        boundVia: "direct",
        entityState: "draft",
      },
      {
        organizationId: admin.organizationId,
        humanAgentId: human,
        delegateAgentId: delegate,
        entityType: "pull_request",
        entityKey: "owner/repo#826",
        chatId,
        boundVia: "direct",
        entityState: "merged",
      },
      {
        organizationId: admin.organizationId,
        humanAgentId: human,
        delegateAgentId: delegate,
        entityType: "issue",
        entityKey: "owner/repo#827",
        chatId,
        boundVia: "direct",
        entityState: "closed",
      },
    ]);

    for (const number of [825, 826]) {
      const res = await postWebhook(app, "pull_request", {
        action: "opened",
        pull_request: {
          number,
          title: "Late opened",
          html_url: `https://github.com/owner/repo/pull/${number}`,
          body: "",
          state: "open",
          draft: false,
          merged: false,
        },
        repository: { full_name: "owner/repo" },
        sender: { login: "author", type: "User" },
        installation: { id: installationId },
      });
      expect(res.statusCode).toBe(200);
    }

    const issueRes = await postWebhook(app, "issues", {
      action: "opened",
      issue: {
        number: 827,
        title: "Late issue opened",
        html_url: "https://github.com/owner/repo/issues/827",
        body: "",
        state: "open",
      },
      repository: { full_name: "owner/repo" },
      sender: { login: "author", type: "User" },
      installation: { id: installationId },
    });
    expect(issueRes.statusCode).toBe(200);

    const rows = await app.db
      .select({ entityKey: githubEntityChatMappings.entityKey, entityState: githubEntityChatMappings.entityState })
      .from(githubEntityChatMappings)
      .where(eq(githubEntityChatMappings.chatId, chatId));
    const stateByKey = new Map(rows.map((row) => [row.entityKey, row.entityState]));
    expect(stateByKey.get("owner/repo#825")).toBe("draft");
    expect(stateByKey.get("owner/repo#826")).toBe("merged");
    expect(stateByKey.get("owner/repo#827")).toBe("closed");
  });

  it("pull_request.converted_to_draft → syncs entity_state to 'draft'", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app);
    const installationId = 100034;
    await seedInstallation(app, { installationId, orgId: admin.organizationId });

    const delegate = await seedAgent(app, {
      orgId: admin.organizationId,
      memberId: admin.memberId,
      name: `dlg-${randomUUID().slice(0, 6)}`,
    });
    const human = await seedAgent(app, {
      orgId: admin.organizationId,
      memberId: admin.memberId,
      name: `human-${randomUUID().slice(0, 6)}`,
      delegateMention: delegate,
      type: "human",
    });
    const chatId = `chat_${randomUUID()}`;
    await app.db.insert(chats).values({ id: chatId, organizationId: admin.organizationId, type: "direct" });
    await app.db.insert(githubEntityChatMappings).values({
      organizationId: admin.organizationId,
      humanAgentId: human,
      delegateAgentId: delegate,
      entityType: "pull_request",
      entityKey: "owner/repo#823",
      chatId,
      boundVia: "direct",
      entityState: "open",
    });

    const res = await postWebhook(app, "pull_request", {
      action: "converted_to_draft",
      pull_request: {
        number: 823,
        title: "Draft again",
        html_url: "https://github.com/owner/repo/pull/823",
        body: "",
        draft: true,
      },
      repository: { full_name: "owner/repo" },
      sender: { login: "author", type: "User" },
      installation: { id: installationId },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().handled).toBe(false);

    const [mappingRow] = await app.db
      .select({ entityState: githubEntityChatMappings.entityState })
      .from(githubEntityChatMappings)
      .where(and(eq(githubEntityChatMappings.chatId, chatId), eq(githubEntityChatMappings.entityKey, "owner/repo#823")))
      .limit(1);
    expect(mappingRow?.entityState).toBe("draft");
  });

  it("pull_request.ready_for_review → syncs entity_state to 'open' even when normalize drops the event", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app);
    const installationId = 100035;
    await seedInstallation(app, { installationId, orgId: admin.organizationId });

    const delegate = await seedAgent(app, {
      orgId: admin.organizationId,
      memberId: admin.memberId,
      name: `dlg-${randomUUID().slice(0, 6)}`,
    });
    const human = await seedAgent(app, {
      orgId: admin.organizationId,
      memberId: admin.memberId,
      name: `human-${randomUUID().slice(0, 6)}`,
      delegateMention: delegate,
      type: "human",
    });
    const chatId = `chat_${randomUUID()}`;
    await app.db.insert(chats).values({ id: chatId, organizationId: admin.organizationId, type: "direct" });
    await app.db.insert(githubEntityChatMappings).values({
      organizationId: admin.organizationId,
      humanAgentId: human,
      delegateAgentId: delegate,
      entityType: "pull_request",
      entityKey: "owner/repo#824",
      chatId,
      boundVia: "direct",
      entityState: "draft",
    });

    const res = await postWebhook(app, "pull_request", {
      action: "ready_for_review",
      pull_request: {
        number: 824,
        title: "Ready",
        html_url: "https://github.com/owner/repo/pull/824",
        body: "",
        draft: false,
        requested_reviewers: [],
      },
      repository: { full_name: "owner/repo" },
      sender: { login: "author", type: "User" },
      installation: { id: installationId },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().handled).toBe(false);

    const [mappingRow] = await app.db
      .select({ entityState: githubEntityChatMappings.entityState })
      .from(githubEntityChatMappings)
      .where(and(eq(githubEntityChatMappings.chatId, chatId), eq(githubEntityChatMappings.entityKey, "owner/repo#824")))
      .limit(1);
    expect(mappingRow?.entityState).toBe("open");
  });

  it("pull_request.review_requested seeds a new draft PR mapping from the payload state", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app);
    const installationId = 100037;
    await seedInstallation(app, { installationId, orgId: admin.organizationId });

    const delegate = await seedAgent(app, {
      orgId: admin.organizationId,
      memberId: admin.memberId,
      name: `dlg-${randomUUID().slice(0, 6)}`,
    });
    const humanName = `reviewer-${randomUUID().slice(0, 6)}`;
    const human = await seedAgent(app, {
      orgId: admin.organizationId,
      memberId: admin.memberId,
      name: humanName,
      delegateMention: delegate,
      type: "human",
    });
    const res = await postWebhook(app, "pull_request", {
      action: "review_requested",
      pull_request: {
        number: 828,
        title: "Draft review",
        html_url: "https://github.com/owner/repo/pull/828",
        body: "",
        state: "open",
        draft: true,
        merged: false,
      },
      requested_reviewer: { login: humanName, type: "User" },
      repository: { full_name: "owner/repo" },
      sender: { login: "author", type: "User" },
      installation: { id: installationId },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ delivered: 1, newChats: 1, failed: 0 });

    const [mappingRow] = await app.db
      .select({
        humanAgentId: githubEntityChatMappings.humanAgentId,
        entityState: githubEntityChatMappings.entityState,
      })
      .from(githubEntityChatMappings)
      .where(eq(githubEntityChatMappings.entityKey, "owner/repo#828"))
      .limit(1);
    expect(mappingRow).toMatchObject({ humanAgentId: human, entityState: "draft" });
  });

  it("issue_comment.created seeds a new closed issue mapping from the issue payload state", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app);
    const installationId = 100038;
    await seedInstallation(app, { installationId, orgId: admin.organizationId });

    const delegate = await seedAgent(app, {
      orgId: admin.organizationId,
      memberId: admin.memberId,
      name: `dlg-${randomUUID().slice(0, 6)}`,
    });
    const humanName = `issue-${randomUUID().slice(0, 6)}`;
    const human = await seedAgent(app, {
      orgId: admin.organizationId,
      memberId: admin.memberId,
      name: humanName,
      delegateMention: delegate,
      type: "human",
    });

    const res = await postWebhook(app, "issue_comment", {
      action: "created",
      issue: {
        number: 829,
        title: "Closed issue",
        html_url: "https://github.com/owner/repo/issues/829",
        body: "",
        state: "closed",
      },
      comment: {
        body: `@${humanName} please verify`,
        html_url: "https://github.com/owner/repo/issues/829#issuecomment-1",
      },
      repository: { full_name: "owner/repo" },
      sender: { login: "author", type: "User" },
      installation: { id: installationId },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ delivered: 1, newChats: 1, failed: 0 });

    const [mappingRow] = await app.db
      .select({
        humanAgentId: githubEntityChatMappings.humanAgentId,
        entityType: githubEntityChatMappings.entityType,
        entityState: githubEntityChatMappings.entityState,
      })
      .from(githubEntityChatMappings)
      .where(eq(githubEntityChatMappings.entityKey, "owner/repo#829"))
      .limit(1);
    expect(mappingRow).toMatchObject({ humanAgentId: human, entityType: "issue", entityState: "closed" });
  });

  it("routes commit_comment mentions through attention, card, and notifying inbox delivery", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app);
    const installationId = 100048;
    await seedInstallation(app, { installationId, orgId: admin.organizationId });

    const delegate = await seedAgent(app, {
      orgId: admin.organizationId,
      memberId: admin.memberId,
      name: `commit-dlg-${randomUUID().slice(0, 6)}`,
    });
    const humanName = `commit-human-${randomUUID().slice(0, 6)}`;
    const human = await seedAgent(app, {
      orgId: admin.organizationId,
      memberId: admin.memberId,
      name: humanName,
      delegateMention: delegate,
      type: "human",
    });
    const legacyChat = await createChat(app.db, human, {
      type: "group",
      participantIds: [delegate],
    });
    await app.db.insert(githubEntityChatMappings).values({
      organizationId: admin.organizationId,
      humanAgentId: human,
      delegateAgentId: delegate,
      entityType: "commit",
      entityKey: "owner/repo@abc1234",
      chatId: legacyChat.id,
      boundVia: "agent_declared",
    });

    const res = await postWebhook(app, "commit_comment", {
      action: "created",
      comment: {
        body: `@${humanName} please inspect this commit`,
        commit_id: "abc1234",
        html_url: "https://github.com/owner/repo/commit/abc1234#commitcomment-1",
        author_association: "MEMBER",
      },
      repository: { full_name: "owner/repo" },
      sender: { login: "external-author", type: "User" },
      installation: { id: installationId },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ delivered: 1, newChats: 1, failed: 0 });

    const [mapping] = await app.db
      .select({
        humanAgentId: githubEntityChatMappings.humanAgentId,
        delegateAgentId: githubEntityChatMappings.delegateAgentId,
        entityType: githubEntityChatMappings.entityType,
        entityKey: githubEntityChatMappings.entityKey,
        boundVia: githubEntityChatMappings.boundVia,
        chatId: githubEntityChatMappings.chatId,
      })
      .from(githubEntityChatMappings)
      .where(eq(githubEntityChatMappings.entityKey, "owner/repo@abc1234"))
      .limit(1);
    expect(mapping).toMatchObject({
      humanAgentId: human,
      delegateAgentId: delegate,
      entityType: "commit",
      entityKey: "owner/repo@abc1234",
      boundVia: "direct",
    });
    expect(mapping?.chatId).not.toBe(legacyChat.id);

    const [message] = await app.db.select().from(messages).limit(1);
    expect(message?.content).toMatchObject({
      type: "github_event",
      event: "commit_comment",
      kind: "commit_commented",
      reason: "mentioned",
      entity: { type: "commit", key: "owner/repo@abc1234" },
    });
    expect(message?.metadata).toMatchObject({
      event: "commit_comment",
      entityType: "commit",
      entityKey: "owner/repo@abc1234",
      mentions: [delegate],
    });
    expect(message?.chatId).toBe(mapping?.chatId);

    const [entry] = await app.db
      .select({ notify: inboxEntries.notify })
      .from(inboxEntries)
      .where(and(eq(inboxEntries.messageId, message?.id ?? ""), eq(inboxEntries.inboxId, `inbox_${delegate}`)))
      .limit(1);
    expect(entry?.notify).toBe(true);
  });

  it("issue_comment.created on a PR seeds a new closed PR mapping from the issue payload state", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app);
    const installationId = 100040;
    await seedInstallation(app, { installationId, orgId: admin.organizationId });

    const delegate = await seedAgent(app, {
      orgId: admin.organizationId,
      memberId: admin.memberId,
      name: `dlg-${randomUUID().slice(0, 6)}`,
    });
    const humanName = `pr-issue-${randomUUID().slice(0, 6)}`;
    const human = await seedAgent(app, {
      orgId: admin.organizationId,
      memberId: admin.memberId,
      name: humanName,
      delegateMention: delegate,
      type: "human",
    });

    const res = await postWebhook(app, "issue_comment", {
      action: "created",
      issue: {
        number: 831,
        title: "Closed PR thread",
        html_url: "https://github.com/owner/repo/pull/831",
        body: "",
        state: "closed",
        pull_request: { html_url: "https://github.com/owner/repo/pull/831", merged_at: null },
      },
      comment: {
        body: `@${humanName} please verify`,
        html_url: "https://github.com/owner/repo/pull/831#issuecomment-1",
      },
      repository: { full_name: "owner/repo" },
      sender: { login: "author", type: "User" },
      installation: { id: installationId },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ delivered: 1, newChats: 1, failed: 0 });

    const [mappingRow] = await app.db
      .select({
        humanAgentId: githubEntityChatMappings.humanAgentId,
        entityType: githubEntityChatMappings.entityType,
        entityState: githubEntityChatMappings.entityState,
      })
      .from(githubEntityChatMappings)
      .where(eq(githubEntityChatMappings.entityKey, "owner/repo#831"))
      .limit(1);
    expect(mappingRow).toMatchObject({ humanAgentId: human, entityType: "pull_request", entityState: "closed" });
  });

  it("pull_request_review_comment.created seeds a new draft PR mapping from the PR payload state", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app);
    const installationId = 100039;
    await seedInstallation(app, { installationId, orgId: admin.organizationId });

    const delegate = await seedAgent(app, {
      orgId: admin.organizationId,
      memberId: admin.memberId,
      name: `dlg-${randomUUID().slice(0, 6)}`,
    });
    const humanName = `pr-${randomUUID().slice(0, 6)}`;
    const human = await seedAgent(app, {
      orgId: admin.organizationId,
      memberId: admin.memberId,
      name: humanName,
      delegateMention: delegate,
      type: "human",
    });

    const res = await postWebhook(app, "pull_request_review_comment", {
      action: "created",
      pull_request: {
        number: 830,
        title: "Draft PR review comment",
        html_url: "https://github.com/owner/repo/pull/830",
        body: "",
        state: "open",
        draft: true,
        merged: false,
      },
      comment: {
        body: `@${humanName} please review`,
        html_url: "https://github.com/owner/repo/pull/830#discussion_r1",
      },
      repository: { full_name: "owner/repo" },
      sender: { login: "author", type: "User" },
      installation: { id: installationId },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ delivered: 1, newChats: 1, failed: 0 });

    const [mappingRow] = await app.db
      .select({
        humanAgentId: githubEntityChatMappings.humanAgentId,
        entityType: githubEntityChatMappings.entityType,
        entityState: githubEntityChatMappings.entityState,
      })
      .from(githubEntityChatMappings)
      .where(eq(githubEntityChatMappings.entityKey, "owner/repo#830"))
      .limit(1);
    expect(mappingRow).toMatchObject({ humanAgentId: human, entityType: "pull_request", entityState: "draft" });
  });

  it("issues.closed → syncs entity_state to 'closed' on the issue mapping", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app);
    const installationId = 100033;
    await seedInstallation(app, { installationId, orgId: admin.organizationId });

    const delegate = await seedAgent(app, {
      orgId: admin.organizationId,
      memberId: admin.memberId,
      name: `dlg-${randomUUID().slice(0, 6)}`,
    });
    const human = await seedAgent(app, {
      orgId: admin.organizationId,
      memberId: admin.memberId,
      name: `human-${randomUUID().slice(0, 6)}`,
      delegateMention: delegate,
      type: "human",
    });
    const chatId = `chat_${randomUUID()}`;
    await app.db.insert(chats).values({ id: chatId, organizationId: admin.organizationId, type: "direct" });
    await app.db.insert(githubEntityChatMappings).values({
      organizationId: admin.organizationId,
      humanAgentId: human,
      delegateAgentId: delegate,
      entityType: "issue",
      entityKey: "owner/repo#900",
      chatId,
      boundVia: "direct",
    });

    const res = await postWebhook(app, "issues", {
      action: "closed",
      issue: {
        number: 900,
        title: "Stale issue",
        html_url: "https://github.com/owner/repo/issues/900",
        body: "",
      },
      repository: { full_name: "owner/repo" },
      sender: { login: "closer", type: "User" },
      installation: { id: installationId },
    });

    expect(res.statusCode).toBe(200);

    const [mappingRow] = await app.db
      .select({ entityState: githubEntityChatMappings.entityState })
      .from(githubEntityChatMappings)
      .where(and(eq(githubEntityChatMappings.chatId, chatId), eq(githubEntityChatMappings.entityKey, "owner/repo#900")))
      .limit(1);
    expect(mappingRow?.entityState).toBe("closed");
  });

  it("pull_request.closed without merge → entity_state 'closed' and no engagement flip", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app);
    const installationId = 100031;
    await seedInstallation(app, { installationId, orgId: admin.organizationId });

    const delegate = await seedAgent(app, {
      orgId: admin.organizationId,
      memberId: admin.memberId,
      name: `dlg-${randomUUID().slice(0, 6)}`,
    });
    const human = await seedAgent(app, {
      orgId: admin.organizationId,
      memberId: admin.memberId,
      name: `human-${randomUUID().slice(0, 6)}`,
      delegateMention: delegate,
      type: "human",
    });
    const chatId = `chat_${randomUUID()}`;
    await app.db.insert(chats).values({ id: chatId, organizationId: admin.organizationId, type: "direct" });
    await app.db.insert(githubEntityChatMappings).values({
      organizationId: admin.organizationId,
      humanAgentId: human,
      delegateAgentId: delegate,
      entityType: "pull_request",
      entityKey: "owner/repo#821",
      chatId,
      boundVia: "direct",
    });

    const res = await postWebhook(app, "pull_request", {
      action: "closed",
      pull_request: {
        number: 821,
        title: "Abandoned PR",
        html_url: "https://github.com/owner/repo/pull/821",
        body: "",
        merged: false,
      },
      repository: { full_name: "owner/repo" },
      sender: { login: "closer", type: "User" },
      installation: { id: installationId },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().handled).toBe(false);

    const stateRows = await app.db
      .select()
      .from(chatUserState)
      .where(and(eq(chatUserState.chatId, chatId), eq(chatUserState.agentId, human)));
    expect(stateRows).toHaveLength(0);

    const [mappingRow] = await app.db
      .select({ entityState: githubEntityChatMappings.entityState })
      .from(githubEntityChatMappings)
      .where(and(eq(githubEntityChatMappings.chatId, chatId), eq(githubEntityChatMappings.entityKey, "owner/repo#821")))
      .limit(1);
    expect(mappingRow?.entityState).toBe("closed");
  });

  // M1 (#507): audience-empty must distinguish "no involves at all" from
  // "had involves but resolved to zero agents" — the latter usually means
  // a mentioned GitHub login has no `delegateMention`-configured agent in
  // this org, which is a potential mis-configuration worth surfacing.
  it("audience empty with no involves returns reason=audience_empty_no_involves", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app);
    const installationId = 100030;
    await seedInstallation(app, { installationId, orgId: admin.organizationId });

    const res = await postWebhook(app, "issues", {
      action: "opened",
      issue: {
        number: 10,
        title: "no involves",
        html_url: "https://github.com/owner/repo/issues/10",
        body: "",
        assignees: [],
      },
      repository: { full_name: "owner/repo" },
      sender: { login: "external", type: "User" },
      installation: { id: installationId },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: true, audience: 0, reason: "audience_empty_no_involves" });
  });

  it("audience empty with involves returns reason=audience_empty_with_involves", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app);
    const installationId = 100031;
    await seedInstallation(app, { installationId, orgId: admin.organizationId });

    // Assignee whose GitHub login has no matching agent in this org →
    // involves resolves to an empty audience (mis-config signal).
    const res = await postWebhook(app, "issues", {
      action: "opened",
      issue: {
        number: 11,
        title: "with involves but unknown login",
        html_url: "https://github.com/owner/repo/issues/11",
        body: "",
        assignees: [{ login: "nobody-here", type: "User" }],
      },
      repository: { full_name: "owner/repo" },
      sender: { login: "external", type: "User" },
      installation: { id: installationId },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: true, audience: 0, reason: "audience_empty_with_involves" });
  });

  it.each([
    {
      label: "Issue first comment",
      eventType: "issue_comment",
      entityType: "issue",
      number: 12,
      kind: "commented",
      payload: {
        action: "created",
        issue: {
          number: 12,
          title: "Automatic Issue handling",
          html_url: "https://github.com/owner/repo/issues/12",
          body: "Please investigate this issue.",
          assignees: [],
          author_association: "CONTRIBUTOR",
        },
        comment: {
          body: "Please investigate this issue.",
          html_url: "https://github.com/owner/repo/issues/12#issuecomment-12",
          user: { login: "external-contributor", type: "User" },
          author_association: "CONTRIBUTOR",
        },
      },
    },
    {
      label: "pull request",
      eventType: "pull_request",
      entityType: "pull_request",
      number: 13,
      kind: "opened",
      payload: {
        action: "opened",
        pull_request: {
          number: 13,
          title: "Automatic pull request handling",
          html_url: "https://github.com/owner/repo/pull/13",
          body: "Please inspect this pull request.",
          assignees: [],
          author_association: "NONE",
          draft: false,
        },
      },
    },
  ] as const)("automatically delegates $label activity without an App mention or assignment", async (scenario) => {
    const app = getApp();
    const admin = await createTestAdmin(app);
    const installationId = scenario.entityType === "issue" ? 100032 : 100033;
    await seedInstallation(app, { installationId, orgId: admin.organizationId });
    const teamAgent = await configureTeamAgent(app, admin);

    const payload = {
      ...scenario.payload,
      repository: { full_name: "owner/repo" },
      sender: { login: "external-contributor", type: "User" },
      installation: { id: installationId },
    };
    const res = await postWebhook(app, scenario.eventType, payload);

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: true, delivered: 1, newChats: 1, failed: 0 });

    const [mapping] = await app.db.select().from(githubEntityChatMappings).limit(1);
    expect(mapping).toMatchObject({
      humanAgentId: admin.humanAgentUuid,
      delegateAgentId: teamAgent,
      entityType: scenario.entityType,
      boundVia: "direct",
    });

    const [message] = await app.db
      .select()
      .from(messages)
      .where(eq(messages.chatId, mapping?.chatId ?? ""))
      .limit(1);
    expect(message?.content).toMatchObject({
      type: "github_event",
      reason: "subscribed",
      kind: scenario.kind,
      teamAgentTask: { agentUuid: teamAgent, runId: expect.any(String) },
    });
    expect(message?.content).not.toHaveProperty("mentionedUser");
    expect(message?.metadata).toMatchObject({
      mentions: [teamAgent],
      teamAgentTask: { agentUuid: teamAgent, runId: expect.any(String) },
      githubTaskRun: true,
      githubTaskRunId: expect.any(String),
      githubTaskAgentUuid: teamAgent,
      githubTaskManagerHumanAgentId: admin.humanAgentUuid,
      githubTaskRepository: "owner/repo",
      githubTaskEntityType: scenario.entityType,
      githubTaskEntityNumber: scenario.number,
      githubTaskReplySubmission: { state: "pending" },
    });
    expect(message?.metadata).not.toHaveProperty("mentionedUser");
    expect(message?.metadata.githubTaskRunId).toBe(
      (message?.content as { teamAgentTask?: { runId?: string } }).teamAgentTask?.runId,
    );

    const [entry] = await app.db
      .select({ notify: inboxEntries.notify })
      .from(inboxEntries)
      .where(and(eq(inboxEntries.messageId, message?.id ?? ""), eq(inboxEntries.inboxId, `inbox_${teamAgent}`)))
      .limit(1);
    expect(entry?.notify).toBe(true);

    const repeated = await postWebhook(app, scenario.eventType, payload);
    expect(repeated.statusCode).toBe(200);
    expect(repeated.json()).toMatchObject({ ok: true, delivered: 1, newChats: 0, failed: 0 });
    const mappingRows = await app.db.select().from(githubEntityChatMappings);
    expect(mappingRows).toHaveLength(1);
    const messageRows = await app.db
      .select()
      .from(messages)
      .where(eq(messages.chatId, mapping?.chatId ?? ""));
    expect(messageRows).toHaveLength(2);
    expect(
      messageRows.every(
        (row) =>
          typeof row.metadata.teamAgentTask === "object" &&
          row.metadata.teamAgentTask !== null &&
          "agentUuid" in row.metadata.teamAgentTask &&
          row.metadata.teamAgentTask.agentUuid === teamAgent,
      ),
    ).toBe(true);
  });

  it.each([
    false,
    true,
  ])("retries predictive activation without duplicating Issue cards or inbox entries (concurrent assigned: %s)", async (concurrentAssigned) => {
    const app = getApp();
    const admin = await createTestAdmin(app);
    const installationId = 100060;
    await seedInstallation(app, { installationId, orgId: admin.organizationId });
    const delegate = await seedAgent(app, {
      orgId: admin.organizationId,
      memberId: admin.memberId,
      name: `retry-dlg-${randomUUID().slice(0, 6)}`,
    });
    const assigneeName = `retry-human-${randomUUID().slice(0, 6)}`;
    await seedAgent(app, {
      orgId: admin.organizationId,
      memberId: admin.memberId,
      name: assigneeName,
      delegateMention: delegate,
      type: "human",
    });
    const payload = {
      issue: {
        number: 46,
        title: "Concurrent Issue activation",
        html_url: "https://github.com/owner/repo/issues/46",
        body: "body",
        assignees: [{ login: assigneeName, type: "User" }],
        author_association: "NONE",
      },
      assignee: { login: assigneeName, type: "User" },
      repository: { full_name: "owner/repo" },
      sender: { login: "external-contributor", type: "User" },
      installation: { id: installationId },
    };
    const deliveries = (concurrentAssigned ? ["opened", "assigned"] : ["opened"]).map((action) => ({
      action,
      deliveryId: randomUUID(),
    }));

    try {
      // A sequence survives transaction rollback. Fail the first presence
      // write after the session INSERT, then allow a fresh transaction to
      // complete. The real lock inversion is covered by session-state tests.
      await app.db.execute(sql`CREATE SEQUENCE test_webhook_session_retry`);
      await app.db.execute(sql`
          CREATE FUNCTION test_webhook_session_retry() RETURNS trigger LANGUAGE plpgsql AS $$
          BEGIN
            IF nextval('test_webhook_session_retry') = 1 THEN
              RAISE EXCEPTION 'injected session deadlock' USING ERRCODE = '40P01';
            END IF;
            RETURN NEW;
          END $$
        `);
      await app.db.execute(sql`
          CREATE TRIGGER test_webhook_session_retry BEFORE INSERT ON agent_presence
          FOR EACH ROW EXECUTE FUNCTION test_webhook_session_retry()
        `);

      const responses = await Promise.all(
        deliveries.map(({ action, deliveryId }) => postWebhook(app, "issues", { ...payload, action }, { deliveryId })),
      );
      for (const response of responses) {
        expect(response.statusCode).toBe(200);
        expect(response.json()).toMatchObject({ ok: true, delivered: 1, failed: 0 });
      }
      const mappings = await app.db.select().from(githubEntityChatMappings);
      expect(mappings).toHaveLength(1);
      const mapping = mappings[0];
      if (!mapping) throw new Error("Expected the Issue attention line");
      expect(mapping).toMatchObject({ delegateAgentId: delegate, entityKey: "owner/repo#46" });
      const sessions = await app.db.select().from(agentChatSessions).where(eq(agentChatSessions.agentId, delegate));
      expect(sessions).toHaveLength(1);
      expect(sessions[0]).toMatchObject({ chatId: mapping.chatId, state: "active", runtimeState: "idle" });
      const attempts = await app.db.execute<{ last_value: string }>(
        sql`SELECT last_value FROM test_webhook_session_retry`,
      );
      expect(Number(attempts[0]?.last_value)).toBeGreaterThanOrEqual(2);

      // Redelivering each webhook must remain idempotent after the internal
      // retry. Only the session transaction may repeat, never message send.
      for (const { action, deliveryId } of deliveries) {
        const repeated = await postWebhook(app, "issues", { ...payload, action }, { deliveryId });
        expect(repeated.statusCode).toBe(200);
      }
      const cards = await app.db.select().from(messages).where(eq(messages.chatId, mapping.chatId));
      expect(cards).toHaveLength(deliveries.length);
      const inbox = await app.db
        .select()
        .from(inboxEntries)
        .where(and(eq(inboxEntries.chatId, mapping.chatId), eq(inboxEntries.inboxId, `inbox_${delegate}`)));
      expect(inbox).toHaveLength(deliveries.length);
      expect(new Set(inbox.map((entry) => entry.messageId)).size).toBe(deliveries.length);
      expect(inbox.every((entry) => entry.notify)).toBe(true);
    } finally {
      await app.db.execute(sql`DROP TRIGGER IF EXISTS test_webhook_session_retry ON agent_presence`);
      await app.db.execute(sql`DROP FUNCTION IF EXISTS test_webhook_session_retry()`);
      await app.db.execute(sql`DROP SEQUENCE IF EXISTS test_webhook_session_retry`);
    }
  });

  it("does not create a Task Agent chat on issues.opened, but still creates an assignee line", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app);
    const installationId = 100050;
    await seedInstallation(app, { installationId, orgId: admin.organizationId });
    const teamAgent = await configureTeamAgent(app, admin);
    const assigneeDelegate = await seedAgent(app, {
      orgId: admin.organizationId,
      memberId: admin.memberId,
      name: `assignee-dlg-${randomUUID().slice(0, 6)}`,
    });
    const assigneeName = `assignee-${randomUUID().slice(0, 6)}`;
    await seedAgent(app, {
      orgId: admin.organizationId,
      memberId: admin.memberId,
      name: assigneeName,
      delegateMention: assigneeDelegate,
      type: "human",
    });

    const opened = await postWebhook(app, "issues", {
      action: "opened",
      issue: {
        number: 40,
        title: "Deferred owner activation",
        html_url: "https://github.com/owner/repo/issues/40",
        body: "body",
        assignees: [{ login: assigneeName, type: "User" }],
        author_association: "NONE",
      },
      repository: { full_name: "owner/repo" },
      sender: { login: "external-contributor", type: "User" },
      installation: { id: installationId },
    });
    expect(opened.statusCode).toBe(200);
    expect(opened.json()).toMatchObject({ ok: true, delivered: 1, newChats: 1, failed: 0 });
    expect(opened.json()).not.toHaveProperty("appTaskBlocker");

    const mappingsAfterOpen = await app.db.select().from(githubEntityChatMappings);
    expect(mappingsAfterOpen).toHaveLength(1);
    expect(mappingsAfterOpen[0]).toMatchObject({
      delegateAgentId: assigneeDelegate,
      entityType: "issue",
      entityKey: "owner/repo#40",
    });
    expect(mappingsAfterOpen.some((row) => row.delegateAgentId === teamAgent)).toBe(false);
    const openedMessages = await app.db.select().from(messages);
    expect(openedMessages).toHaveLength(1);
    expect(openedMessages[0]?.metadata).not.toHaveProperty("teamAgentTask");

    const firstComment = await postWebhook(app, "issue_comment", {
      action: "created",
      issue: {
        number: 40,
        title: "Deferred owner activation",
        html_url: "https://github.com/owner/repo/issues/40",
        author_association: "NONE",
      },
      comment: {
        body: "First qualifying comment",
        html_url: "https://github.com/owner/repo/issues/40#issuecomment-40",
        user: { login: "external-contributor", type: "User" },
        author_association: "NONE",
      },
      repository: { full_name: "owner/repo" },
      sender: { login: "external-contributor", type: "User" },
      installation: { id: installationId },
    });
    expect(firstComment.statusCode).toBe(200);
    expect(firstComment.json()).toMatchObject({ ok: true, failed: 0 });
    expect(firstComment.json().delivered).toBeGreaterThanOrEqual(1);

    const mappingsAfterComment = await app.db.select().from(githubEntityChatMappings);
    expect(mappingsAfterComment.some((row) => row.delegateAgentId === teamAgent)).toBe(true);
    expect(mappingsAfterComment.some((row) => row.delegateAgentId === assigneeDelegate)).toBe(true);
    const taskChatId = mappingsAfterComment.find((row) => row.delegateAgentId === teamAgent)?.chatId ?? "";
    const taskMessages = await app.db.select().from(messages).where(eq(messages.chatId, taskChatId));
    expect(
      taskMessages.some(
        (row) =>
          typeof row.metadata.teamAgentTask === "object" &&
          row.metadata.teamAgentTask !== null &&
          "agentUuid" in row.metadata.teamAgentTask &&
          row.metadata.teamAgentTask.agentUuid === teamAgent,
      ),
    ).toBe(true);
  });

  it("still creates a Context Reviewer provider task on issues.opened in the bound Context Tree repo", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app);
    const installationId = 100051;
    await seedInstallation(app, { installationId, orgId: admin.organizationId });
    await configureTeamAgent(app, admin);
    const reviewer = await configureContextReviewer(app, admin);

    const response = await postWebhook(app, "issues", {
      action: "opened",
      issue: {
        number: 77,
        title: "Context Tree Issue stays automatic",
        html_url: "https://github.com/owner/context-tree/issues/77",
        body: "Please review",
        assignees: [],
        author_association: "NONE",
      },
      repository: { full_name: "owner/context-tree" },
      sender: { login: "external-contributor", type: "User" },
      installation: { id: installationId },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ ok: true, delivered: 1, newChats: 1, failed: 0 });
    const [mapping] = await app.db.select().from(githubEntityChatMappings).limit(1);
    expect(mapping).toMatchObject({
      humanAgentId: admin.humanAgentUuid,
      delegateAgentId: reviewer,
      entityType: "issue",
      entityKey: "owner/context-tree#77",
    });
    const [message] = await app.db
      .select()
      .from(messages)
      .where(eq(messages.chatId, mapping?.chatId ?? ""))
      .limit(1);
    expect(message?.content).toMatchObject({
      type: "github_event",
      reason: "subscribed",
      kind: "opened",
      teamAgentTask: { agentUuid: reviewer, runId: expect.any(String) },
    });
    expect(message?.metadata).toMatchObject({
      mentions: [reviewer],
      teamAgentTask: { agentUuid: reviewer, runId: expect.any(String) },
      githubTaskRun: true,
      githubTaskAgentUuid: reviewer,
    });
    const [entry] = await app.db
      .select({ notify: inboxEntries.notify })
      .from(inboxEntries)
      .where(and(eq(inboxEntries.messageId, message?.id ?? ""), eq(inboxEntries.inboxId, `inbox_${reviewer}`)))
      .limit(1);
    expect(entry?.notify).toBe(true);
  });

  it("returns a stable permission blocker and creates no task run after an installation permission downgrade", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app);
    const installationId = 100036;
    await seedInstallation(app, { installationId, orgId: admin.organizationId });
    await configureTeamAgent(app, admin);
    await app.db
      .update(githubAppInstallations)
      .set({ permissions: { metadata: "read", issues: "read", pull_requests: "write" } })
      .where(eq(githubAppInstallations.installationId, installationId));

    const response = await postWebhook(app, "issue_comment", {
      action: "created",
      issue: {
        number: 16,
        title: "Permission downgraded",
        html_url: "https://github.com/owner/repo/issues/16",
        author_association: "CONTRIBUTOR",
      },
      comment: {
        body: "Please investigate",
        html_url: "https://github.com/owner/repo/issues/16#issuecomment-16",
        user: { login: "authorized-member", type: "User" },
        author_association: "CONTRIBUTOR",
      },
      repository: { full_name: "owner/repo" },
      sender: { login: "authorized-member", type: "User" },
      installation: { id: installationId },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      audience: 0,
      appTaskBlocker: "GITHUB_TASK_REPLY_APP_PERMISSION_REQUIRED",
    });
    expect(await app.db.select().from(messages)).toHaveLength(0);
    expect(await app.db.select().from(githubEntityChatMappings)).toHaveLength(0);
  });

  it.each([
    {
      label: "Discussion",
      eventType: "discussion",
      payload: (installationId: number) => ({
        action: "created",
        discussion: {
          number: 17,
          title: "Unsupported discussion task",
          html_url: "https://github.com/owner/repo/discussions/17",
          body: "Please investigate",
          author_association: "MEMBER",
        },
        repository: { full_name: "owner/repo" },
        sender: { login: "authorized-member", type: "User" },
        installation: { id: installationId },
      }),
    },
    {
      label: "Commit",
      eventType: "commit_comment",
      payload: (installationId: number) => ({
        action: "created",
        comment: {
          body: "Please investigate",
          commit_id: "abc1234",
          html_url: "https://github.com/owner/repo/commit/abc1234#commitcomment-1",
          author_association: "MEMBER",
        },
        repository: { full_name: "owner/repo" },
        sender: { login: "authorized-member", type: "User" },
        installation: { id: installationId },
      }),
    },
  ])("does not create a task run for normalized $label activity", async (scenario) => {
    const app = getApp();
    const admin = await createTestAdmin(app);
    const installationId = scenario.eventType === "discussion" ? 100037 : 100038;
    await seedInstallation(app, { installationId, orgId: admin.organizationId });
    await configureTeamAgent(app, admin);

    const response = await postWebhook(app, scenario.eventType, scenario.payload(installationId));

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ audience: 0 });
    expect(response.json()).not.toHaveProperty("appTaskBlocker");
    expect(await app.db.select().from(messages)).toHaveLength(0);
    expect(await app.db.select().from(githubEntityChatMappings)).toHaveLength(0);
  });

  it("does not turn an App-authored terminal comment webhook into another task run", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app);
    const installationId = 100039;
    await seedInstallation(app, { installationId, orgId: admin.organizationId });
    const teamAgent = await configureTeamAgent(app, admin);
    const chat = await createChat(app.db, admin.humanAgentUuid, {
      type: "group",
      participantIds: [teamAgent],
    });
    await app.db.insert(githubEntityChatMappings).values({
      organizationId: admin.organizationId,
      humanAgentId: admin.humanAgentUuid,
      delegateAgentId: teamAgent,
      entityType: "issue",
      entityKey: "owner/repo#18",
      chatId: chat.id,
      boundVia: "agent_declared",
    });

    const response = await postWebhook(app, "issue_comment", {
      action: "created",
      issue: {
        number: 18,
        title: "Completed App task",
        html_url: "https://github.com/owner/repo/issues/18",
        author_association: "NONE",
      },
      comment: {
        body: "Completed.\n\n<!-- first-tree-github-task-reply-run:01900000-0000-7000-8000-000000000018 -->",
        html_url: "https://github.com/owner/repo/issues/18#issuecomment-18",
        user: { login: "test-app-slug[bot]", type: "Bot" },
        author_association: "NONE",
      },
      repository: { full_name: "owner/repo" },
      sender: { login: "test-app-slug[bot]", type: "Bot" },
      installation: { id: installationId },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ delivered: 1 });
    expect(response.json()).not.toHaveProperty("appTaskBlocker");
    const delivered = await app.db.select().from(messages).where(eq(messages.chatId, chat.id));
    expect(delivered).toHaveLength(1);
    expect(delivered[0]?.metadata).toMatchObject({ mentions: [teamAgent] });
    expect(delivered[0]?.metadata).not.toHaveProperty("teamAgentTask");
    expect(delivered[0]?.metadata).not.toHaveProperty("githubTaskRun");
    expect(delivered[0]?.content).not.toHaveProperty("teamAgentTask");
    expect(await app.db.select().from(githubEntityChatMappings)).toHaveLength(1);
  });

  it("treats configured App-bot activity without a valid task marker as an ordinary automatic event", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app);
    const installationId = 100040;
    await seedInstallation(app, { installationId, orgId: admin.organizationId });
    const teamAgent = await configureTeamAgent(app, admin);

    const response = await postWebhook(app, "issue_comment", {
      action: "created",
      issue: {
        number: 19,
        title: "App activity without a terminal marker",
        html_url: "https://github.com/owner/repo/issues/19",
        author_association: "NONE",
      },
      comment: {
        body: "An App-authored update with no First Tree task marker.",
        html_url: "https://github.com/owner/repo/issues/19#issuecomment-19",
        user: { login: "test-app-slug[bot]", type: "Bot" },
        author_association: "NONE",
      },
      repository: { full_name: "owner/repo" },
      sender: { login: "test-app-slug[bot]", type: "Bot" },
      installation: { id: installationId },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ delivered: 1, newChats: 1, failed: 0 });
    const [message] = await app.db.select().from(messages).limit(1);
    expect(message?.content).toMatchObject({
      type: "github_event",
      reason: "subscribed",
      teamAgentTask: { agentUuid: teamAgent, runId: expect.any(String) },
    });
    expect(message?.metadata).toMatchObject({
      mentions: [teamAgent],
      githubTaskRun: true,
      githubTaskAgentUuid: teamAgent,
    });
  });

  it("suppresses an App-authored task reply from trusted Context Review while preserving a same-Agent generic subscription", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app);
    const installationId = 100044;
    await seedInstallation(app, { installationId, orgId: admin.organizationId });
    const reviewer = await configureContextReviewer(app, admin);
    const subscribedChat = await createChat(app.db, admin.humanAgentUuid, {
      type: "group",
      participantIds: [reviewer],
    });
    await app.db.insert(githubEntityChatMappings).values({
      organizationId: admin.organizationId,
      humanAgentId: admin.humanAgentUuid,
      delegateAgentId: reviewer,
      entityType: "pull_request",
      entityKey: "owner/context-tree#42",
      chatId: subscribedChat.id,
      boundVia: "human_declared",
    });

    const basePayload = contextIssueCommentPayload(installationId);
    const response = await postWebhook(app, "issue_comment", {
      ...basePayload,
      comment: {
        ...basePayload.comment,
        body: "Completed.\n\n<!-- first-tree-github-task-reply-run:01900000-0000-7000-8000-000000000042 -->",
        user: { login: "TEST-APP-SLUG[BOT]", type: "Bot" },
      },
      sender: { login: "test-app-slug[bot]", type: "Bot" },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      delivered: 1,
      contextReviewer: { handled: false, reason: "github_task_reply_self_output" },
    });
    const chatRows = await app.db.select().from(chats);
    expect(chatRows).toHaveLength(1);
    expect(chatRows[0]?.id).toBe(subscribedChat.id);

    const messageRows = await app.db.select().from(messages);
    expect(messageRows).toHaveLength(1);
    expect(messageRows[0]?.chatId).toBe(subscribedChat.id);
    expect(messageRows[0]?.metadata).toMatchObject({
      event: "issue_comment",
      action: "created",
      mentions: [reviewer],
    });
    expect(messageRows[0]?.metadata).not.toHaveProperty("contextReviewRunId");
    expect(messageRows[0]?.metadata).not.toHaveProperty("contextTreeReviewer");
    expect(messageRows[0]?.metadata).not.toHaveProperty("teamAgentTask");
    expect(messageRows[0]?.metadata).not.toHaveProperty("githubTaskRun");
    expect(messageRows[0]?.content).not.toHaveProperty("teamAgentTask");

    const notified = await app.db
      .select({ inboxId: inboxEntries.inboxId, notify: inboxEntries.notify })
      .from(inboxEntries)
      .where(eq(inboxEntries.messageId, messageRows[0]?.id ?? ""));
    expect(notified).toEqual(
      expect.arrayContaining([expect.objectContaining({ inboxId: `inbox_${reviewer}`, notify: true })]),
    );
  });

  it.each([
    {
      label: "the configured App login with a human author type",
      login: "test-app-slug[bot]",
      type: "User",
    },
    {
      label: "a different bot login",
      login: "other-app[bot]",
      type: "Bot",
    },
  ])("does not suppress trusted Context Review when a task reply marker comes from $label", async ({ login, type }) => {
    const app = getApp();
    const admin = await createTestAdmin(app);
    const installationId = type === "User" ? 100045 : 100046;
    await seedInstallation(app, { installationId, orgId: admin.organizationId });
    const reviewer = await configureContextReviewer(app, admin);
    vi.stubGlobal("fetch", contextReviewerGithubFetch());

    const basePayload = contextIssueCommentPayload(installationId);
    const response = await postWebhook(app, "issue_comment", {
      ...basePayload,
      comment: {
        ...basePayload.comment,
        body: "Injected marker.\n\n<!-- first-tree-github-task-reply-run:01900000-0000-7000-8000-000000000043 -->",
        user: { login, type },
      },
      sender: { login, type },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      delivered: 1,
      contextReviewer: { handled: true, reused: false },
    });
    const messageRows = await app.db.select().from(messages);
    expect(messageRows).toHaveLength(2);
    const reviewMessage = messageRows.find((message) => message.metadata.contextTreeReviewer === true);
    const taskMessage = messageRows.find((message) => message.metadata.githubTaskRun === true);
    expect(reviewMessage?.metadata).toMatchObject({
      contextTreeReviewer: true,
      mentions: [reviewer],
    });
    expect(reviewMessage?.metadata.contextReviewRunId).toEqual(expect.any(String));
    expect(reviewMessage?.metadata).not.toHaveProperty("teamAgentTask");
    expect(reviewMessage?.metadata).not.toHaveProperty("githubTaskRun");
    expect(taskMessage?.metadata).toMatchObject({
      teamAgentTask: { agentUuid: reviewer, runId: expect.any(String) },
      githubTaskRun: true,
      githubTaskAgentUuid: reviewer,
      mentions: [reviewer],
    });
    expect(taskMessage?.metadata).not.toHaveProperty("contextTreeReviewer");
    expect(taskMessage?.metadata).not.toHaveProperty("contextReviewRunId");
    expect(taskMessage?.content).toMatchObject({ reason: "subscribed" });
    expect(taskMessage?.content).not.toHaveProperty("mentionedUser");
    expect(taskMessage?.chatId).not.toBe(reviewMessage?.chatId);

    const [reviewerNotification] = await app.db
      .select({ notify: inboxEntries.notify })
      .from(inboxEntries)
      .where(and(eq(inboxEntries.messageId, reviewMessage?.id ?? ""), eq(inboxEntries.inboxId, `inbox_${reviewer}`)))
      .limit(1);
    expect(reviewerNotification?.notify).toBe(true);
  });

  it("reuses an existing human mapping, adds the GitHub Task Agent, and preserves the surviving followed wake", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app);
    const installationId = 100034;
    await seedInstallation(app, { installationId, orgId: admin.organizationId });
    const teamAgent = await configureTeamAgent(app, admin);
    const otherDelegate = await seedAgent(app, {
      orgId: admin.organizationId,
      memberId: admin.memberId,
      name: `other-delegate-${randomUUID().slice(0, 6)}`,
    });
    const chat = await createChat(app.db, admin.humanAgentUuid, {
      type: "group",
      participantIds: [otherDelegate],
    });
    await app.db.insert(githubEntityChatMappings).values({
      organizationId: admin.organizationId,
      humanAgentId: admin.humanAgentUuid,
      delegateAgentId: otherDelegate,
      entityType: "issue",
      entityKey: "owner/repo#14",
      chatId: chat.id,
      boundVia: "human_declared",
    });

    const response = await postWebhook(app, "issue_comment", {
      action: "created",
      issue: {
        number: 14,
        title: "Existing mapping",
        html_url: "https://github.com/owner/repo/issues/14",
        author_association: "NONE",
      },
      comment: {
        body: "Activating comment",
        html_url: "https://github.com/owner/repo/issues/14#issuecomment-14",
        user: { login: "external", type: "User" },
        author_association: "NONE",
      },
      repository: { full_name: "owner/repo" },
      sender: { login: "external", type: "User" },
      installation: { id: installationId },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ delivered: 1, newChats: 0, failed: 0 });
    const mappings = await app.db
      .select()
      .from(githubEntityChatMappings)
      .where(eq(githubEntityChatMappings.chatId, chat.id));
    expect(mappings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ delegateAgentId: otherDelegate }),
        expect.objectContaining({ delegateAgentId: teamAgent, boundVia: "human_fallback" }),
      ]),
    );
    const [membership] = await app.db
      .select()
      .from(chatMembership)
      .where(and(eq(chatMembership.chatId, chat.id), eq(chatMembership.agentId, teamAgent)))
      .limit(1);
    expect(membership).toMatchObject({ accessMode: "speaker" });
    const [message] = await app.db.select().from(messages).where(eq(messages.chatId, chat.id)).limit(1);
    expect(message?.metadata).toMatchObject({
      teamAgentTask: { agentUuid: teamAgent },
    });
    expect(message?.content).toMatchObject({ reason: "subscribed", kind: "commented" });
    expect(message?.content).not.toHaveProperty("mentionedUser");
    expect(message?.metadata).not.toHaveProperty("mentionedUser");
    expect(message?.metadata.mentions).toEqual(expect.arrayContaining([teamAgent, otherDelegate]));
    expect(message?.metadata.mentions).toHaveLength(2);
    const notified = await app.db
      .select({ inboxId: inboxEntries.inboxId, notify: inboxEntries.notify })
      .from(inboxEntries)
      .where(eq(inboxEntries.messageId, message?.id ?? ""));
    expect(notified).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ inboxId: `inbox_${teamAgent}`, notify: true }),
        expect.objectContaining({ inboxId: `inbox_${otherDelegate}`, notify: true }),
      ]),
    );
  });

  it("unions an App task wake with an independent subscription in the same chat", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app);
    const installationId = 100035;
    await seedInstallation(app, { installationId, orgId: admin.organizationId });
    const teamAgent = await configureTeamAgent(app, admin);
    const [managerHuman] = await app.db
      .select({ name: agents.name })
      .from(agents)
      .where(eq(agents.uuid, admin.humanAgentUuid))
      .limit(1);
    if (!managerHuman?.name) throw new Error("GitHub Task Agent manager human is missing a GitHub-compatible name");

    const historicalDelegate = await seedAgent(app, {
      orgId: admin.organizationId,
      memberId: admin.memberId,
      name: `historical-delegate-${randomUUID().slice(0, 6)}`,
    });
    const subscribedDelegate = await seedAgent(app, {
      orgId: admin.organizationId,
      memberId: admin.memberId,
      name: `subscribed-delegate-${randomUUID().slice(0, 6)}`,
    });
    const subscribedHuman = await seedAgent(app, {
      orgId: admin.organizationId,
      memberId: admin.memberId,
      name: `subscribed-human-${randomUUID().slice(0, 6)}`,
      delegateMention: subscribedDelegate,
      type: "human",
    });
    const chat = await createChat(app.db, admin.humanAgentUuid, {
      type: "group",
      participantIds: [historicalDelegate, subscribedHuman, subscribedDelegate],
    });
    await app.db.insert(githubEntityChatMappings).values([
      {
        organizationId: admin.organizationId,
        humanAgentId: admin.humanAgentUuid,
        delegateAgentId: historicalDelegate,
        entityType: "issue",
        entityKey: "owner/repo#15",
        chatId: chat.id,
        boundVia: "human_declared",
      },
      {
        organizationId: admin.organizationId,
        humanAgentId: subscribedHuman,
        delegateAgentId: subscribedDelegate,
        entityType: "issue",
        entityKey: "owner/repo#15",
        chatId: chat.id,
        boundVia: "agent_declared",
      },
    ]);

    const response = await postWebhook(app, "issue_comment", {
      action: "created",
      issue: {
        number: 15,
        title: "Mixed App task and subscription",
        html_url: "https://github.com/owner/repo/issues/15",
        author_association: "NONE",
      },
      comment: {
        body: "Activating comment",
        html_url: "https://github.com/owner/repo/issues/15#issuecomment-15",
        user: { login: managerHuman.name, type: "User" },
        author_association: "NONE",
      },
      repository: { full_name: "owner/repo" },
      // Prune only the manager's historical line. The automatic task remains
      // eligible, as does the other human's explicit subscription.
      sender: { login: managerHuman.name, type: "User" },
      installation: { id: installationId },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ delivered: 1, newChats: 0, failed: 0 });
    const messageRows = await app.db.select().from(messages).where(eq(messages.chatId, chat.id));
    expect(messageRows).toHaveLength(1);
    const [message] = messageRows;
    expect(message?.metadata).toMatchObject({
      teamAgentTask: { agentUuid: teamAgent },
    });
    expect(message?.content).toMatchObject({ reason: "subscribed", kind: "commented" });
    expect(message?.content).not.toHaveProperty("mentionedUser");
    expect(message?.metadata.mentions).toEqual(expect.arrayContaining([teamAgent, subscribedDelegate]));
    expect(message?.metadata.mentions).toHaveLength(2);
    expect(message?.metadata.mentions).not.toContain(historicalDelegate);

    const notified = await app.db
      .select({ inboxId: inboxEntries.inboxId, notify: inboxEntries.notify })
      .from(inboxEntries)
      .where(eq(inboxEntries.messageId, message?.id ?? ""));
    expect(notified).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ inboxId: `inbox_${teamAgent}`, notify: true }),
        expect.objectContaining({ inboxId: `inbox_${subscribedDelegate}`, notify: true }),
      ]),
    );
    expect(notified).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ inboxId: `inbox_${historicalDelegate}`, notify: true })]),
    );
  });

  it("pull_request.opened on the bound context repo keeps generic task and trusted review capabilities separate", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app);
    const installationId = 100041;
    await seedInstallation(app, { installationId, orgId: admin.organizationId });
    const reviewer = await configureContextReviewer(app, admin);
    vi.stubGlobal("fetch", contextReviewerGithubFetch());

    const res = await postWebhook(app, "pull_request", contextPullRequestPayload(installationId));

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      ok: true,
      event: "pull_request",
      delivered: 1,
      newChats: 1,
      contextReviewer: { handled: true, reused: false },
    });

    const chatRows = await app.db.select().from(chats);
    expect(chatRows).toHaveLength(2);
    const reviewChat = chatRows.find((chat) => chat.metadata.contextTreeReviewer === true);
    const taskChat = chatRows.find((chat) => chat.metadata.contextTreeReviewer !== true);
    expect(reviewChat?.metadata).toMatchObject({
      source: "github",
      entityType: "pull_request",
      entityKey: "owner/context-tree#42",
      contextTreeReviewer: true,
      reviewerAgentUuid: reviewer,
    });
    expect(taskChat?.metadata).not.toHaveProperty("contextTreeReviewer");

    const messageRows = await app.db.select().from(messages);
    expect(messageRows).toHaveLength(2);
    const reviewMessage = messageRows.find((message) => message.metadata.contextTreeReviewer === true);
    const taskMessage = messageRows.find((message) => message.metadata.githubTaskRun === true);
    expect(reviewMessage?.content).toContain("Load the installed `context-tree-review` skill");
    expect(reviewMessage?.content).not.toContain("gh pr review");
    expect(reviewMessage?.content).not.toContain("Context changes requested");
    expect(reviewMessage?.content).toContain("Draft status from webhook: ready for review");
    expect(reviewMessage?.metadata).toMatchObject({
      source: "github",
      event: "pull_request",
      action: "opened",
      triggerEvent: "pull_request.opened",
      contextTreeReviewer: true,
      pullRequestDraft: false,
      mentions: [reviewer],
    });
    expect(reviewMessage?.metadata.contextReviewRunId).toEqual(expect.any(String));
    expect(reviewMessage?.metadata).not.toHaveProperty("teamAgentTask");
    expect(reviewMessage?.metadata).not.toHaveProperty("githubTaskRun");
    expect(taskMessage?.content).toMatchObject({
      type: "github_event",
      reason: "subscribed",
      kind: "opened",
      teamAgentTask: { agentUuid: reviewer, runId: expect.any(String) },
    });
    expect(taskMessage?.content).not.toHaveProperty("mentionedUser");
    expect(taskMessage?.metadata).toMatchObject({
      githubTaskRun: true,
      githubTaskAgentUuid: reviewer,
      mentions: [reviewer],
    });
    expect(taskMessage?.metadata).not.toHaveProperty("contextTreeReviewer");
    expect(taskMessage?.metadata).not.toHaveProperty("contextReviewRunId");
    expect(taskMessage?.chatId).toBe(taskChat?.id);
    expect(reviewMessage?.chatId).toBe(reviewChat?.id);
    expect(taskMessage?.chatId).not.toBe(reviewMessage?.chatId);
  });

  it("follow-up activity on a bound context PR wakes the existing Context Reviewer chat", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app);
    const installationId = 100043;
    await seedInstallation(app, { installationId, orgId: admin.organizationId });
    const reviewer = await configureContextReviewer(app, admin);
    vi.stubGlobal("fetch", contextReviewerGithubFetch());

    const opened = await postWebhook(app, "pull_request", contextPullRequestPayload(installationId));
    expect(opened.statusCode).toBe(200);
    expect(opened.json()).toMatchObject({ contextReviewer: { handled: true, reused: false } });

    const liveHead = "b".repeat(40);
    vi.stubGlobal("fetch", contextReviewerGithubFetch(liveHead));
    const followUp = await postWebhook(app, "issue_comment", contextIssueCommentPayload(installationId));

    expect(followUp.statusCode).toBe(200);
    expect(followUp.json()).toMatchObject({
      ok: true,
      event: "issue_comment",
      delivered: 1,
      contextReviewer: { handled: true, reused: true },
    });

    const chatRows = await app.db.select().from(chats);
    expect(chatRows).toHaveLength(2);
    const reviewChat = chatRows.find((chat) => chat.metadata.contextTreeReviewer === true);
    const taskChat = chatRows.find((chat) => chat.metadata.contextTreeReviewer !== true);

    const messageRows = await app.db.select().from(messages);
    expect(messageRows).toHaveLength(4);
    const followUpMessage = messageRows.find(
      (message) => message.metadata.triggerEvent === "issue_comment.created" && message.metadata.contextTreeReviewer,
    );
    expect(followUpMessage?.content).toContain("Trigger event: issue_comment.created");
    expect(followUpMessage?.content).toContain("Comment author: context-commenter");
    expect(followUpMessage?.content).toContain(
      "Comment URL: https://github.com/owner/context-tree/pull/42#issuecomment-2",
    );
    expect(followUpMessage?.content).toContain("Load the installed `context-tree-review` skill");
    expect(followUpMessage?.metadata).toMatchObject({
      source: "github",
      event: "issue_comment",
      action: "created",
      triggerEvent: "issue_comment.created",
      entityType: "pull_request",
      entityKey: "owner/context-tree#42",
      contextTreeReviewer: true,
      commentAuthorLogin: "context-commenter",
      commentUrl: "https://github.com/owner/context-tree/pull/42#issuecomment-2",
      mentions: [reviewer],
    });
    expect(followUpMessage?.chatId).toBe(reviewChat?.id);
    expect(followUpMessage?.metadata).not.toHaveProperty("teamAgentTask");
    const genericFollowUp = messageRows.find(
      (message) => message.metadata.event === "issue_comment" && message.metadata.githubTaskRun === true,
    );
    expect(genericFollowUp?.chatId).toBe(taskChat?.id);
    expect(genericFollowUp?.metadata).toMatchObject({
      teamAgentTask: { agentUuid: reviewer, runId: expect.any(String) },
      githubTaskAgentUuid: reviewer,
      mentions: [reviewer],
    });
    expect(genericFollowUp?.metadata).not.toHaveProperty("contextReviewRunId");

    const [entry] = await app.db
      .select({ notify: inboxEntries.notify })
      .from(inboxEntries)
      .where(and(eq(inboxEntries.messageId, followUpMessage?.id ?? ""), eq(inboxEntries.inboxId, `inbox_${reviewer}`)))
      .limit(1);
    expect(entry?.notify).toBe(true);
  });

  it("pull_request.ready_for_review on a bound context PR wakes the existing Context Reviewer chat", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app);
    const installationId = 100044;
    await seedInstallation(app, { installationId, orgId: admin.organizationId });
    const reviewer = await configureContextReviewer(app, admin);
    vi.stubGlobal("fetch", contextReviewerGithubFetch());

    const draftOpenedPayload = contextPullRequestPayload(installationId);
    draftOpenedPayload.pull_request.draft = true;
    const opened = await postWebhook(app, "pull_request", draftOpenedPayload);
    expect(opened.statusCode).toBe(200);
    expect(opened.json()).toMatchObject({ contextReviewer: { handled: true, reused: false } });

    const readyPayload = contextPullRequestPayload(installationId);
    readyPayload.action = "ready_for_review";
    readyPayload.pull_request.draft = false;
    const ready = await postWebhook(app, "pull_request", readyPayload);

    expect(ready.statusCode).toBe(200);
    expect(ready.json()).toMatchObject({
      ok: true,
      event: "pull_request",
      handled: false,
      contextReviewer: { handled: true, reused: true },
    });

    const chatRows = await app.db.select().from(chats);
    expect(chatRows).toHaveLength(2);
    const reviewChat = chatRows.find((chat) => chat.metadata.contextTreeReviewer === true);
    const taskChat = chatRows.find((chat) => chat.metadata.contextTreeReviewer !== true);
    const messageRows = await app.db
      .select()
      .from(messages)
      .where(eq(messages.chatId, reviewChat?.id ?? ""));
    expect(messageRows).toHaveLength(2);
    const followUpMessage = messageRows.find(
      (message) => message.metadata.triggerEvent === "pull_request.ready_for_review",
    );
    expect(followUpMessage?.content).toContain("Trigger event: pull_request.ready_for_review");
    expect(followUpMessage?.content).toContain("Draft status from webhook: ready for review");
    expect(followUpMessage?.content).toContain("Load the installed `context-tree-review` skill");
    expect(followUpMessage?.content).not.toContain("gh pr review");
    expect(followUpMessage?.metadata).toMatchObject({
      source: "github",
      event: "pull_request",
      action: "ready_for_review",
      triggerEvent: "pull_request.ready_for_review",
      entityType: "pull_request",
      entityKey: "owner/context-tree#42",
      contextTreeReviewer: true,
      pullRequestDraft: false,
      mentions: [reviewer],
    });
    const taskMessageRows = await app.db
      .select()
      .from(messages)
      .where(eq(messages.chatId, taskChat?.id ?? ""));
    expect(taskMessageRows).toHaveLength(1);
    expect(taskMessageRows[0]?.metadata).toMatchObject({
      githubTaskRun: true,
      teamAgentTask: { agentUuid: reviewer, runId: expect.any(String) },
    });
    expect(taskMessageRows[0]?.metadata).not.toHaveProperty("contextReviewRunId");
  });

  it("pull_request.opened on an ordinary code repo does not trigger Context Reviewer", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app);
    const installationId = 100042;
    await seedInstallation(app, { installationId, orgId: admin.organizationId });
    await configureContextReviewer(app, admin);
    vi.stubGlobal("fetch", contextReviewerGithubFetch());

    const res = await postWebhook(app, "pull_request", contextPullRequestPayload(installationId, "owner/code"));

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      ok: true,
      event: "pull_request",
      audience: 0,
      contextReviewer: { handled: false, reason: "repo_mismatch" },
    });
    const chatRows = await app.db.select({ id: chats.id }).from(chats);
    expect(chatRows).toHaveLength(0);
  });

  it("duplicate delivery (same x-github-delivery) is deduped on the second call", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app);
    const installationId = 100022;
    await seedInstallation(app, { installationId, orgId: admin.organizationId });
    const deliveryId = randomUUID();

    const payload = {
      action: "opened",
      issue: {
        number: 5,
        title: "x",
        html_url: "https://github.com/owner/repo/issues/5",
        body: "",
        assignees: [],
      },
      repository: { full_name: "owner/repo" },
      sender: { login: "external", type: "User" },
      installation: { id: installationId },
    };

    const first = await postWebhook(app, "issues", payload, { deliveryId });
    expect(first.statusCode).toBe(200);
    const second = await postWebhook(app, "issues", payload, { deliveryId });
    expect(second.statusCode).toBe(200);
    expect(second.json().deduped).toBe(true);
  });

  it("duplicate context reviewer delivery is deduped and does not send another task", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app);
    const installationId = 100043;
    await seedInstallation(app, { installationId, orgId: admin.organizationId });
    await configureContextReviewer(app, admin);
    vi.stubGlobal("fetch", contextReviewerGithubFetch());
    const deliveryId = randomUUID();
    const payload = contextPullRequestPayload(installationId);

    const first = await postWebhook(app, "pull_request", payload, { deliveryId });
    const second = await postWebhook(app, "pull_request", payload, { deliveryId });

    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
    expect(second.json().deduped).toBe(true);
    const messageRows = await app.db.select().from(messages);
    expect(messageRows).toHaveLength(2);
    expect(messageRows.filter((message) => message.metadata.contextTreeReviewer === true)).toHaveLength(1);
    expect(messageRows.filter((message) => message.metadata.githubTaskRun === true)).toHaveLength(1);
  });
});
