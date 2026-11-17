import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { describe, expect, it, vi } from "vitest";
import { protectOAuthStateNonce } from "../api/auth/oauth-cookie.js";
import { authIdentities } from "../db/schema/auth-identities.js";
import { invitationRedemptions } from "../db/schema/invitations.js";
import { members } from "../db/schema/members.js";
import { organizations } from "../db/schema/organizations.js";
import { users } from "../db/schema/users.js";
import * as githubAppInstallations from "../services/scm/github/app-installations.js";
import { deactivateMembership, MEMBER_STATUSES, MEMBERSHIP_RECOVERY_POLICIES } from "../services/team/membership.js";
import { createTestAdmin, useTestApp } from "./helpers.js";

function oauthStateCookie(app: FastifyInstance, nonce: string): string {
  return `oauth_state_nonce=${encodeURIComponent(protectOAuthStateNonce(nonce, app.config.secrets.encryptionKey))}`;
}

function stubGithubAppOauth(opts: {
  tokenStatus?: number;
  githubId?: number;
  login?: string;
  email?: string | null;
}): () => void {
  const original = globalThis.fetch;
  type FetchInput = Parameters<typeof globalThis.fetch>[0];
  type FetchInit = Parameters<typeof globalThis.fetch>[1];
  globalThis.fetch = (async (input: FetchInput, init?: FetchInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    if (url === "https://github.com/login/oauth/access_token") {
      const status = opts.tokenStatus ?? 200;
      if (status !== 200) {
        return new Response(JSON.stringify({ error: "bad_verification_code" }), {
          status,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(
        JSON.stringify({
          access_token: "gho_test_access",
          expires_in: 28_800,
          refresh_token: "ghr_test_refresh",
          refresh_token_expires_in: 15_811_200,
          scope: "",
          token_type: "bearer",
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    if (url === "https://api.github.com/user") {
      const login = opts.login ?? `callback-${randomUUID().slice(0, 8)}`;
      return new Response(
        JSON.stringify({
          id: opts.githubId ?? 77_000_001,
          login,
          name: login,
          email: opts.email ?? `${login}@example.com`,
          avatar_url: null,
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    return original(input, init);
  }) as typeof fetch;
  return () => {
    globalThis.fetch = original;
  };
}

/**
 * End-to-end tests for the public GitHub-OAuth onboarding surface.
 * Uses `/auth/github/dev-callback` to skip the github.com round-trip —
 * the dev callback is identical to the live one once the GitHub profile
 * has been resolved.
 */
describe("GitHub OAuth onboarding flow", () => {
  const getApp = useTestApp();

  it("start signs a state cookie and redirects to the GitHub App authorize URL", async () => {
    const app = getApp();

    const res = await app.inject({
      method: "GET",
      url: `/api/v1/auth/github/start?next=${encodeURIComponent("/settings/integrations/github")}`,
    });

    expect(res.statusCode).toBe(302);
    expect(res.headers["set-cookie"]).toContain("oauth_state_nonce=");
    const location = res.headers.location ?? "";
    const authorizeUrl = new URL(location);
    expect(`${authorizeUrl.origin}${authorizeUrl.pathname}`).toBe("https://github.com/login/oauth/authorize");
    expect(authorizeUrl.searchParams.get("client_id")).toBe("test-app-client-id");
    expect(authorizeUrl.searchParams.get("redirect_uri")).toContain("/api/v1/auth/github/callback");
    expect(authorizeUrl.searchParams.get("state")).toBeTruthy();
  });

  it("does not fail the callback when the state cookie has a malformed escape", async () => {
    // The cookie is attacker-controlled and decoded before the state is
    // verified. A `URIError` here would turn a public endpoint into a 500.
    const app = getApp();
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/auth/github/callback?code=abc&state=def",
      headers: { cookie: "oauth_state_nonce=%E0%A4%A" },
    });

    expect(res.statusCode).not.toBe(500);
    expect([400, 302]).toContain(res.statusCode);
  });

  it("dev-callback creates user + auth_identity + personal team for first sign-in", async () => {
    const app = getApp();
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/auth/github/dev-callback?githubId=42&login=octocat&displayName=Octo+Cat",
    });

    expect(res.statusCode).toBe(302);
    const location = res.headers.location ?? "";
    expect(location).toContain("/auth/github/complete#");
    expect(location).toContain("access=");
    expect(location).toContain("refresh=");
    // First-time signup lands on dashboard; the onboarding modal layers on top.
    const fragment = location.split("#")[1] ?? "";
    const params = new URLSearchParams(fragment);
    expect(params.get("next")).toBe("/");
    expect(params.get("joinPath")).toBe("solo");
    expect(params.get("accountCreated")).toBe("1");

    // Auth identity is recorded.
    const ids = await app.db.select().from(authIdentities).where(eq(authIdentities.identifier, "42"));
    expect(ids).toHaveLength(1);
    expect(ids[0]?.provider).toBe("github");

    // Default team was minted — slug is the GitHub login (no `-personal` suffix).
    const orgs = await app.db.select().from(organizations).where(eq(organizations.name, "octocat"));
    expect(orgs).toHaveLength(1);
    const orgRow = orgs[0];
    if (!orgRow) throw new Error("expected default org row");
    // Default team display name is `${displayName}'s team` — collective-space
    // reading per first-tree-context:agent-hub/onboarding.md (was §5.5 in source design); user can rename
    // in onboarding Step 1.
    expect(orgRow.displayName).toBe("Octo Cat's team");

    // The callback carries the resolved org back so the web selects it
    // (overriding any stale localStorage org) — here the freshly-minted team.
    expect(params.get("org")).toBe(orgRow.id);
    // A fresh solo signup is a deliberate destination — pinned so the SPA
    // activates the just-minted org rather than a stale last-used selection.
    expect(params.get("orgPinned")).toBe("1");

    // The new user is its admin.
    const memberRows = await app.db.select().from(members).where(eq(members.organizationId, orgRow.id));
    expect(memberRows).toHaveLength(1);
    expect(memberRows[0]?.role).toBe("admin");
    expect(memberRows[0]?.status).toBe("active");
  });

  it("preserves quickstart campaign next for first-time solo signup", async () => {
    const app = getApp();
    const next = `/quickstart?campaign=production-scan&repo=${encodeURIComponent("https://github.com/acme/backend")}`;
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/auth/github/dev-callback?githubId=43&login=quickstarter&next=${encodeURIComponent(next)}`,
    });

    expect(res.statusCode).toBe(302);
    const fragment = res.headers.location?.split("#")[1] ?? "";
    const params = new URLSearchParams(fragment);
    expect(params.get("next")).toBe(next);
    expect(params.get("joinPath")).toBe("solo");
  });

  it("dev-callback persists DEV_GITHUB_PAT as the stored GitHub access token", async () => {
    const app = getApp();
    const original = process.env.DEV_GITHUB_PAT;
    process.env.DEV_GITHUB_PAT = "ghp_devpat123";
    try {
      const res = await app.inject({
        method: "GET",
        url: "/api/v1/auth/github/dev-callback?githubId=45&login=patuser",
      });
      expect(res.statusCode).toBe(302);

      const [identity] = await app.db
        .select({ userId: authIdentities.userId, metadata: authIdentities.metadata })
        .from(authIdentities)
        .where(eq(authIdentities.identifier, "45"));
      expect(identity?.metadata).toMatchObject({ login: "patuser" });
      const { getStoredGithubAccessToken } = await import("../services/auth/identity.js");
      await expect(
        getStoredGithubAccessToken(app.db, identity?.userId ?? "", app.config.secrets.encryptionKey),
      ).resolves.toBe("ghp_devpat123");
    } finally {
      if (original === undefined) {
        delete process.env.DEV_GITHUB_PAT;
      } else {
        process.env.DEV_GITHUB_PAT = original;
      }
    }
  });

  it("continues dev sign-in when installation stub upsert and direct bind fail", async () => {
    const app = getApp();
    const upsert = vi
      .spyOn(githubAppInstallations, "upsertInstallationFromMetadata")
      .mockRejectedValueOnce(new Error("stub failed"));
    const bind = vi.spyOn(githubAppInstallations, "bindInstallationToOrg");
    try {
      const res = await app.inject({
        method: "GET",
        url: "/api/v1/auth/github/dev-callback?githubId=46&login=stubfail&installationId=987654",
      });

      expect(res.statusCode).toBe(302);
      expect(res.headers.location).toContain("/auth/github/complete#");
      expect(res.headers.location).toContain("access=");
      expect(upsert).toHaveBeenCalledTimes(1);
      expect(bind).toHaveBeenCalledTimes(1);
    } finally {
      upsert.mockRestore();
      bind.mockRestore();
    }
  });

  it("returns JSON 404 for invalid invite tokens on dev-callback", async () => {
    const app = getApp();

    const res = await app.inject({
      method: "GET",
      url: `/api/v1/auth/github/dev-callback?githubId=47&login=missinginvite&next=${encodeURIComponent("/invite/not-real")}`,
    });

    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: "Invitation not found or no longer valid", code: "invite-invalid" });
  });

  it("still sends first-time solo signup with ordinary protected next to onboarding entry", async () => {
    const app = getApp();
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/auth/github/dev-callback?githubId=44&login=settingsnext&next=${encodeURIComponent("/settings/integrations/github")}`,
    });

    expect(res.statusCode).toBe(302);
    const fragment = res.headers.location?.split("#")[1] ?? "";
    const params = new URLSearchParams(fragment);
    expect(params.get("next")).toBe("/");
    expect(params.get("joinPath")).toBe("solo");
  });

  it("second sign-in for same github id reuses the user", async () => {
    const app = getApp();
    const first = await app.inject({
      method: "GET",
      url: "/api/v1/auth/github/dev-callback?githubId=99&login=alice",
    });
    const firstParams = new URLSearchParams(first.headers.location?.split("#")[1] ?? "");
    expect(firstParams.get("accountCreated")).toBe("1");
    const second = await app.inject({
      method: "GET",
      url: "/api/v1/auth/github/dev-callback?githubId=99&login=alice",
    });
    const secondParams = new URLSearchParams(second.headers.location?.split("#")[1] ?? "");
    expect(secondParams.get("accountCreated")).toBe("0");
    const ids = await app.db.select().from(authIdentities).where(eq(authIdentities.identifier, "99"));
    expect(ids).toHaveLength(1);
  });

  it("disambiguates default team slug on collision", async () => {
    const app = getApp();
    await app.inject({
      method: "GET",
      url: "/api/v1/auth/github/dev-callback?githubId=1&login=duplicate",
    });
    await app.inject({
      method: "GET",
      url: "/api/v1/auth/github/dev-callback?githubId=2&login=duplicate",
    });
    const orgs = await app.db.select().from(organizations);
    // First sign-in claims `duplicate`; second gets `duplicate-XXXX` (4-char hex).
    const claims = orgs.filter((o) => o.name === "duplicate" || /^duplicate-[a-f0-9]{4}$/.test(o.name));
    expect(claims.length).toBeGreaterThanOrEqual(2);
  });

  it("rejects /dev-callback in production", async () => {
    const app = getApp();
    const original = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";
    try {
      const res = await app.inject({
        method: "GET",
        url: "/api/v1/auth/github/dev-callback?githubId=7&login=prod",
      });
      expect(res.statusCode).toBe(404);
    } finally {
      process.env.NODE_ENV = original;
    }
  });

  it("rejects /dev-callback when FIRST_TREE_DEV_CALLBACK_ENABLED is unset (codex P1-9)", async () => {
    // Models a misconfigured non-prod deploy where the operator just
    // happens not to have NODE_ENV=production set (typo, fresh staging
    // box, self-host first boot, etc.). The route used to be reachable
    // in this state; after the hardening, it 404s unless explicitly
    // opted-in via the env var.
    const app = getApp();
    const original = process.env.FIRST_TREE_DEV_CALLBACK_ENABLED;
    delete process.env.FIRST_TREE_DEV_CALLBACK_ENABLED;
    try {
      const res = await app.inject({
        method: "GET",
        url: "/api/v1/auth/github/dev-callback?githubId=8&login=oops",
      });
      expect(res.statusCode).toBe(404);
    } finally {
      if (original !== undefined) process.env.FIRST_TREE_DEV_CALLBACK_ENABLED = original;
    }
  });

  it("rejects /dev-callback when FIRST_TREE_DEV_CALLBACK_ENABLED is set to something other than '1' / 'true'", async () => {
    const app = getApp();
    const original = process.env.FIRST_TREE_DEV_CALLBACK_ENABLED;
    // Truthy-looking but not in the allow-list (e.g. operator wrote "yes").
    process.env.FIRST_TREE_DEV_CALLBACK_ENABLED = "yes";
    try {
      const res = await app.inject({
        method: "GET",
        url: "/api/v1/auth/github/dev-callback?githubId=9&login=yes",
      });
      expect(res.statusCode).toBe(404);
    } finally {
      if (original !== undefined) {
        process.env.FIRST_TREE_DEV_CALLBACK_ENABLED = original;
      } else {
        delete process.env.FIRST_TREE_DEV_CALLBACK_ENABLED;
      }
    }
  });

  it("partial unique index forbids a single user from holding two github identities", async () => {
    const app = getApp();
    // Sign in once to create a user + bind githubId=700.
    await app.inject({
      method: "GET",
      url: "/api/v1/auth/github/dev-callback?githubId=700&login=alphaone",
    });
    const [first] = await app.db
      .select({ userId: authIdentities.userId })
      .from(authIdentities)
      .where(eq(authIdentities.identifier, "700"));
    const userId = first?.userId;
    expect(userId).toBeDefined();
    if (!userId) throw new Error("seed identity missing");

    // Direct INSERT bypassing the service layer — verifies the storage-layer
    // guarantee that one user cannot hold two github identities, regardless
    // of whether any application-layer flow ever attempts it.
    const { authIdentities: ai } = await import("../db/schema/auth-identities.js");
    const { uuidv7 } = await import("../uuid.js");
    await expect(
      app.db.insert(ai).values({
        id: uuidv7(),
        userId,
        provider: "github",
        identifier: "701",
        email: null,
        verifiedAt: new Date(),
        metadata: { login: "alphaone-shadow" },
      }),
    ).rejects.toThrow();
  });

  it("issues tokens that authenticate /me", async () => {
    const app = getApp();
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/auth/github/dev-callback?githubId=11&login=bob&displayName=Bob",
    });
    const fragment = res.headers.location?.split("#")[1] ?? "";
    const params = new URLSearchParams(fragment);
    const access = params.get("access");
    expect(access).toBeTruthy();

    const me = await app.inject({
      method: "GET",
      url: "/api/v1/me",
      headers: { authorization: `Bearer ${access}` },
    });
    expect(me.statusCode).toBe(200);
    const body = me.json<{
      memberships: Array<{ role: string; organizationId: string }>;
      defaultOrganizationId: string | null;
      onboarding: { step: string };
    }>();
    // Solo signup auto-provisions one org with admin role.
    expect(body.memberships).toHaveLength(1);
    expect(body.memberships[0]?.role).toBe("admin");
    expect(body.defaultOrganizationId).toBe(body.memberships[0]?.organizationId);
    expect(body.onboarding.step).toBe("connect");
  });
});

describe("GitHub OAuth invite-only single-org entry gate", () => {
  const allowedOrganizationId = "org-entry-gate-allowed";
  const blockedOrganizationId = "org-entry-gate-blocked";
  const getApp = useTestApp({ allowedOrganizationId });

  async function ensureOrg(app: ReturnType<typeof getApp>, id: string, name: string): Promise<void> {
    const [existing] = await app.db
      .select({ id: organizations.id })
      .from(organizations)
      .where(eq(organizations.id, id));
    if (existing) return;
    await app.db.insert(organizations).values({ id, name, displayName: name });
  }

  async function rotateInviteForOrg(app: ReturnType<typeof getApp>, organizationId: string) {
    const admin = await createTestAdmin(app, { username: `gate-admin-${randomUUID().slice(0, 8)}` });
    const { rotateInvitation } = await import("../services/team/invitation.js");
    return rotateInvitation(app.db, organizationId, admin.userId);
  }

  async function findGithubUserId(app: ReturnType<typeof getApp>, githubId: string): Promise<string> {
    const [identity] = await app.db
      .select({ userId: authIdentities.userId })
      .from(authIdentities)
      .where(eq(authIdentities.identifier, githubId));
    if (!identity) throw new Error(`expected github identity ${githubId}`);
    return identity.userId;
  }

  it("allows invite redemption for the configured organization", async () => {
    const app = getApp();
    await ensureOrg(app, allowedOrganizationId, "allowed-entry-gate");
    const invite = await rotateInviteForOrg(app, allowedOrganizationId);

    const res = await app.inject({
      method: "GET",
      url: `/api/v1/auth/github/dev-callback?githubId=1201&login=allowedinvite&next=/invite/${invite.token}`,
    });

    expect(res.statusCode).toBe(302);
    const fragment = res.headers.location?.split("#")[1] ?? "";
    const params = new URLSearchParams(fragment);
    expect(params.get("joinPath")).toBe("invite");
    expect(params.get("next")).toBe("/");
    // The invited org is carried back in the fragment so the web makes it the
    // active selection instead of dropping the invitee into a stale org.
    expect(params.get("org")).toBe(allowedOrganizationId);
    // An invite redemption is a deliberate destination — pinned.
    expect(params.get("orgPinned")).toBe("1");

    const userId = await findGithubUserId(app, "1201");
    const memberRows = await app.db.select().from(members).where(eq(members.userId, userId));
    expect(memberRows).toHaveLength(1);
    expect(memberRows[0]?.organizationId).toBe(allowedOrganizationId);

    const redemptions = await app.db
      .select()
      .from(invitationRedemptions)
      .where(eq(invitationRedemptions.invitationId, invite.id));
    expect(redemptions).toHaveLength(1);
  });

  it("rejects invite redemption for other organizations before membership or redemption side effects", async () => {
    const app = getApp();
    await ensureOrg(app, allowedOrganizationId, "allowed-entry-gate");
    await ensureOrg(app, blockedOrganizationId, "blocked-entry-gate");
    const invite = await rotateInviteForOrg(app, blockedOrganizationId);

    const res = await app.inject({
      method: "GET",
      url: `/api/v1/auth/github/dev-callback?githubId=1202&login=blockedinvite&next=/invite/${invite.token}`,
    });

    expect(res.statusCode).toBe(403);
    const userId = await findGithubUserId(app, "1202");
    const memberRows = await app.db.select().from(members).where(eq(members.userId, userId));
    expect(memberRows).toHaveLength(0);
    const redemptions = await app.db
      .select()
      .from(invitationRedemptions)
      .where(eq(invitationRedemptions.invitationId, invite.id));
    expect(redemptions).toHaveLength(0);
  });

  it("rejects new users without invite and does not create a personal team", async () => {
    const app = getApp();

    const res = await app.inject({
      method: "GET",
      url: "/api/v1/auth/github/dev-callback?githubId=1203&login=blockedsolo",
    });

    expect(res.statusCode).toBe(403);
    const userId = await findGithubUserId(app, "1203");
    const memberRows = await app.db.select().from(members).where(eq(members.userId, userId));
    expect(memberRows).toHaveLength(0);
    const orgRows = await app.db.select().from(organizations).where(eq(organizations.name, "blockedsolo"));
    expect(orgRows).toHaveLength(0);
  });

  it("allows existing members to return without an invite", async () => {
    const app = getApp();
    await ensureOrg(app, allowedOrganizationId, "allowed-entry-gate");
    const invite = await rotateInviteForOrg(app, allowedOrganizationId);
    await app.inject({
      method: "GET",
      url: `/api/v1/auth/github/dev-callback?githubId=1204&login=returninggate&next=/invite/${invite.token}`,
    });

    const res = await app.inject({
      method: "GET",
      url: "/api/v1/auth/github/dev-callback?githubId=1204&login=returninggate",
    });

    expect(res.statusCode).toBe(302);
    const fragment = res.headers.location?.split("#")[1] ?? "";
    const params = new URLSearchParams(fragment);
    expect(params.get("joinPath")).toBe("returning");
    // A plain returning sign-in is NOT pinned: the SPA keeps the user's
    // own last-used org selection rather than activating the callback org.
    expect(params.get("orgPinned")).toBeNull();
  });

  it("returns an explicit inactive-account boundary instead of minting a suspended OAuth session", async () => {
    const app = getApp();
    await ensureOrg(app, allowedOrganizationId, "allowed-entry-gate");
    const invite = await rotateInviteForOrg(app, allowedOrganizationId);
    await app.inject({
      method: "GET",
      url: `/api/v1/auth/github/dev-callback?githubId=1205&login=suspendedgate&next=/invite/${invite.token}`,
    });
    const userId = await findGithubUserId(app, "1205");
    const [identityBeforeSuspendedSignIn] = await app.db
      .select()
      .from(authIdentities)
      .where(eq(authIdentities.userId, userId));
    await app.db.update(users).set({ status: "suspended" }).where(eq(users.id, userId));

    const response = await app.inject({
      method: "GET",
      url: `/api/v1/auth/github/dev-callback?githubId=1205&login=suspendedgate-after&email=after@example.com&next=/invite/${invite.token}`,
    });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ code: "account-inactive" });
    expect(response.headers.location).toBeUndefined();
    const [identityAfterSuspendedSignIn] = await app.db
      .select()
      .from(authIdentities)
      .where(eq(authIdentities.userId, userId));
    expect(identityAfterSuspendedSignIn).toEqual(identityBeforeSuspendedSignIn);
  });

  it("returns the shared admin-restore boundary for a removed OAuth invite without redeeming it again", async () => {
    const app = getApp();
    await ensureOrg(app, allowedOrganizationId, "allowed-entry-gate");
    const invite = await rotateInviteForOrg(app, allowedOrganizationId);
    await app.inject({
      method: "GET",
      url: `/api/v1/auth/github/dev-callback?githubId=1206&login=removedgate&next=/invite/${invite.token}`,
    });
    const userId = await findGithubUserId(app, "1206");
    const [stableMember] = await app.db.select().from(members).where(eq(members.userId, userId));
    if (!stableMember) throw new Error("Expected invited membership");
    await deactivateMembership(
      app.db,
      stableMember.id,
      MEMBER_STATUSES.REMOVED,
      MEMBERSHIP_RECOVERY_POLICIES.INVITATION_REQUIRED,
    );

    const response = await app.inject({
      method: "GET",
      url: `/api/v1/auth/github/dev-callback?githubId=1206&login=removedgate&next=/invite/${invite.token}`,
    });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ code: "membership-restore-required" });
    expect(
      await app.db.select().from(invitationRedemptions).where(eq(invitationRedemptions.invitationId, invite.id)),
    ).toHaveLength(1);
  });
});

describe("GitHub account-link return path", () => {
  const getApp = useTestApp();

  it("returns a completed capability link to its signed internal destination", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app, { username: `link-return-${randomUUID().slice(0, 8)}` });
    const { signOAuthState } = await import("../services/auth/oauth/state.js");
    const { token, nonce } = await signOAuthState(app.config.secrets.jwtSecret, "/settings/integrations/github", {
      intent: "link",
      provider: "github",
      userId: admin.userId,
    });
    const restore = stubGithubAppOauth({ githubId: 77_200_001, login: "linked-for-install" });
    try {
      const res = await app.inject({
        method: "GET",
        url: `/api/v1/auth/github/callback?code=ok-code&state=${token}`,
        headers: { cookie: oauthStateCookie(app, nonce) },
      });

      expect(res.statusCode).toBe(302);
      expect(res.headers.location).toBe("/settings/integrations/github?connection=github-linked");
    } finally {
      restore();
    }
  });

  it("returns an identity conflict to GitHub Settings without replacing the existing session", async () => {
    const app = getApp();
    const target = await createTestAdmin(app, { username: `link-target-${randomUUID().slice(0, 8)}` });
    const owner = await createTestAdmin(app, { username: `link-owner-${randomUUID().slice(0, 8)}` });
    const githubId = 77_200_002;
    await app.db.insert(authIdentities).values({
      id: randomUUID(),
      userId: owner.userId,
      provider: "github",
      identifier: String(githubId),
      metadata: { accountName: "already-linked" },
    });
    const { signOAuthState } = await import("../services/auth/oauth/state.js");
    const { token, nonce } = await signOAuthState(app.config.secrets.jwtSecret, "/settings/integrations/github", {
      intent: "link",
      provider: "github",
      userId: target.userId,
    });
    const restore = stubGithubAppOauth({ githubId, login: "already-linked" });
    try {
      const res = await app.inject({
        method: "GET",
        url: `/api/v1/auth/github/callback?code=ok-code&state=${token}`,
        headers: { cookie: oauthStateCookie(app, nonce) },
      });

      expect(res.statusCode).toBe(302);
      expect(res.headers.location).toBe("/settings/integrations/github?error=identity-conflict");
      expect(res.headers.location).not.toContain("access=");
      const targetIdentities = await app.db
        .select({ provider: authIdentities.provider })
        .from(authIdentities)
        .where(eq(authIdentities.userId, target.userId));
      expect(targetIdentities.some((identity) => identity.provider === "github")).toBe(false);
    } finally {
      restore();
    }
  });

  it("rejects a link callback after the signed-state account is suspended", async () => {
    const app = getApp();
    const target = await createTestAdmin(app, { username: `link-suspended-${randomUUID().slice(0, 8)}` });
    const { signOAuthState } = await import("../services/auth/oauth/state.js");
    const { token, nonce } = await signOAuthState(app.config.secrets.jwtSecret, "/settings/integrations/github", {
      intent: "link",
      provider: "github",
      userId: target.userId,
    });
    await app.db.update(users).set({ status: "suspended" }).where(eq(users.id, target.userId));
    const restore = stubGithubAppOauth({ githubId: 77_200_003, login: "suspended-link" });
    try {
      const res = await app.inject({
        method: "GET",
        url: `/api/v1/auth/github/callback?code=ok-code&state=${token}`,
        headers: { cookie: oauthStateCookie(app, nonce) },
      });

      expect(res.statusCode).toBe(302);
      expect(res.headers.location).toBe("/settings/integrations/github?error=account-inactive");
      await expect(
        app.db.select().from(authIdentities).where(eq(authIdentities.userId, target.userId)),
      ).resolves.toEqual([]);
    } finally {
      restore();
    }
  });

  it("rejects an unlink callback after the signed-state account is suspended", async () => {
    const app = getApp();
    const target = await createTestAdmin(app, { username: `unlink-suspended-${randomUUID().slice(0, 8)}` });
    const identityId = randomUUID();
    const githubId = 77_200_004;
    await app.db.insert(authIdentities).values({
      id: identityId,
      userId: target.userId,
      provider: "github",
      identifier: String(githubId),
      metadata: { accountName: "suspended-unlink" },
    });
    const { signOAuthState } = await import("../services/auth/oauth/state.js");
    const { token, nonce } = await signOAuthState(app.config.secrets.jwtSecret, "/settings/account", {
      intent: "unlink",
      provider: "github",
      userId: target.userId,
      targetIdentityId: identityId,
    });
    await app.db.update(users).set({ status: "suspended" }).where(eq(users.id, target.userId));
    const restore = stubGithubAppOauth({ githubId, login: "suspended-unlink" });
    try {
      const res = await app.inject({
        method: "GET",
        url: `/api/v1/auth/github/callback?code=ok-code&state=${token}`,
        headers: { cookie: oauthStateCookie(app, nonce) },
      });

      expect(res.statusCode).toBe(302);
      expect(res.headers.location).toBe("/settings/account?error=account-inactive");
      await expect(
        app.db.select({ id: authIdentities.id }).from(authIdentities).where(eq(authIdentities.id, identityId)),
      ).resolves.toEqual([{ id: identityId }]);
    } finally {
      restore();
    }
  });

  it("keeps a canceled account link side-effect free and preserves a retry route", async () => {
    const app = getApp();
    const target = await createTestAdmin(app, { username: `link-cancel-${randomUUID().slice(0, 8)}` });
    const { signOAuthState } = await import("../services/auth/oauth/state.js");
    const { token, nonce } = await signOAuthState(app.config.secrets.jwtSecret, "/settings/integrations/github", {
      intent: "link",
      provider: "github",
      userId: target.userId,
    });

    const res = await app.inject({
      method: "GET",
      url: `/api/v1/auth/github/callback?error=access_denied&state=${token}`,
      headers: { cookie: oauthStateCookie(app, nonce) },
    });

    expect(res.statusCode).toBe(302);
    const fragment = new URLSearchParams(res.headers.location?.split("#")[1] ?? "");
    expect(fragment.get("error")).toBe("provider-denied");
    expect(fragment.get("next")).toBe("/settings/integrations/github");
    expect(fragment.get("callbackIntent")).toBe("link");
    expect(fragment.get("access")).toBeNull();
    expect(res.headers["set-cookie"]).toContain("Max-Age=0");
    const targetIdentities = await app.db
      .select({ provider: authIdentities.provider })
      .from(authIdentities)
      .where(eq(authIdentities.userId, target.userId));
    expect(targetIdentities.some((identity) => identity.provider === "github")).toBe(false);
  });
});

describe("OAuth callback rejects malformed state", () => {
  const getApp = useTestApp();

  // The /callback route is a full-page browser navigation, so state
  // rejections redirect to the SPA's friendly error surface (the most
  // common trigger is a user spending >10min on GitHub's repo picker,
  // expiring the 10-minute state JWT) instead of stranding the browser
  // on a raw JSON 401.
  function expectStateRejectedRedirect(res: { statusCode: number; headers: { location?: string } }) {
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toContain("/auth/github/complete#");
    expect(res.headers.location).toContain("error=state-expired");
    expect(res.headers.location).not.toContain("access=");
  }

  it("redirects to the SPA error surface when state JWT is gibberish", async () => {
    const app = getApp();
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/auth/github/callback?code=abc&state=not-a-jwt",
    });
    expectStateRejectedRedirect(res);
  });

  it("redirects to the SPA error surface when state cookie is absent", async () => {
    const app = getApp();
    // Sign a real state token but omit the cookie — should fail nonce check.
    const { signOAuthState } = await import("../services/auth/oauth/state.js");
    const { token } = await signOAuthState(app.config.secrets.jwtSecret, "/welcome");
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/auth/github/callback?code=abc&state=${token}`,
    });
    expectStateRejectedRedirect(res);
  });

  it("redirects to the SPA error surface when cookie nonce mismatches", async () => {
    const app = getApp();
    const { signOAuthState } = await import("../services/auth/oauth/state.js");
    const { token } = await signOAuthState(app.config.secrets.jwtSecret, "/welcome");
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/auth/github/callback?code=abc&state=${token}`,
      headers: { cookie: "oauth_state_nonce=wrong" },
    });
    expectStateRejectedRedirect(res);
  });

  it("redirects to the SPA error surface when GitHub code exchange fails", async () => {
    const app = getApp();
    const { signOAuthState } = await import("../services/auth/oauth/state.js");
    const { token, nonce } = await signOAuthState(app.config.secrets.jwtSecret, "/onboarding/connected");
    const restore = stubGithubAppOauth({ tokenStatus: 500 });
    try {
      const res = await app.inject({
        method: "GET",
        url: `/api/v1/auth/github/callback?code=bad-code&state=${token}`,
        headers: { cookie: oauthStateCookie(app, nonce) },
      });

      expect(res.statusCode).toBe(302);
      const location = res.headers.location ?? "";
      expect(location).toContain("/auth/github/complete#");
      expect(location).toContain("error=github-exchange-failed");
      expect(location).toContain("next=%2Fonboarding");
      expect(location).not.toContain("access=");
    } finally {
      restore();
    }
  });

  it("closes a denied GitHub sign-in with a fixed failure reason", async () => {
    const app = getApp();
    const { signOAuthState } = await import("../services/auth/oauth/state.js");
    const { token, nonce } = await signOAuthState(app.config.secrets.jwtSecret, "/welcome", {
      intent: "sign-in",
      provider: "github",
    });
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/auth/github/callback?error=access_denied&state=${token}`,
      headers: { cookie: oauthStateCookie(app, nonce) },
    });

    expect(res.statusCode).toBe(302);
    const params = new URLSearchParams(res.headers.location?.split("#")[1] ?? "");
    expect(params.get("error")).toBe("provider-denied");
    expect(params.get("callbackIntent")).toBe("sign-in");
    expect(params.get("next")).toBe("/welcome");
    expect(params.get("access")).toBeNull();
  });

  it("carries committed account creation through bootstrap failure and reuses it on retry", async () => {
    const app = getApp();
    const { signOAuthState } = await import("../services/auth/oauth/state.js");
    const { token, nonce } = await signOAuthState(app.config.secrets.jwtSecret, "/invite/missing-token", {
      intent: "sign-in",
      provider: "github",
    });
    const restore = stubGithubAppOauth({ githubId: 77_123_001, login: "missinginvite" });
    try {
      const first = await app.inject({
        method: "GET",
        url: `/api/v1/auth/github/callback?code=ok-code&state=${token}`,
        headers: { cookie: oauthStateCookie(app, nonce) },
      });

      expect(first.statusCode).toBe(302);
      const firstParams = new URLSearchParams(first.headers.location?.split("#")[1] ?? "");
      expect(firstParams.get("error")).toBe("invite-invalid");
      expect(firstParams.get("accountCreated")).toBe("1");
      expect(firstParams.get("callbackIntent")).toBe("sign-in");
      expect(firstParams.get("access")).toBeNull();

      const retryState = await signOAuthState(app.config.secrets.jwtSecret, "/", {
        intent: "sign-in",
        provider: "github",
      });
      const retry = await app.inject({
        method: "GET",
        url: `/api/v1/auth/github/callback?code=retry-code&state=${retryState.token}`,
        headers: { cookie: oauthStateCookie(app, retryState.nonce) },
      });
      expect(retry.statusCode).toBe(302);
      const retryParams = new URLSearchParams(retry.headers.location?.split("#")[1] ?? "");
      expect(retryParams.get("accountCreated")).toBe("0");
      expect(retryParams.get("joinPath")).toBe("solo");
      expect(retryParams.get("access")).toBeTruthy();

      const identities = await app.db.select().from(authIdentities).where(eq(authIdentities.identifier, "77123001"));
      expect(identities).toHaveLength(1);
    } finally {
      restore();
    }
  });

  it("dev-callback ignores open-redirect bypasses in `next`", async () => {
    const app = getApp();
    // `next=//evil.com` should be sanitized; first-time signup lands on `/`.
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/auth/github/dev-callback?githubId=55&login=evilnext&next=//evil.com",
    });
    expect(res.statusCode).toBe(302);
    const fragment = res.headers.location?.split("#")[1] ?? "";
    const params = new URLSearchParams(fragment);
    expect(params.get("next")).toBe("/");
  });

  it("dev-callback stubs github_app_installations + binds to the new personal team when installationId is supplied", async () => {
    const app = getApp();
    const installationId = 8_810_001;
    const res = await app.inject({
      method: "GET",
      url:
        "/api/v1/auth/github/dev-callback?githubId=909&login=devappuser&displayName=Dev+App+User" +
        `&installationId=${installationId}&installationAccountType=User&installationAccountLogin=devappuser&installationAccountGithubId=909`,
    });
    expect(res.statusCode).toBe(302);

    const { findInstallationByGithubId } = await import("../services/scm/github/app-installations.js");
    const row = await findInstallationByGithubId(app.db, installationId);
    expect(row).not.toBeNull();
    expect(row?.accountLogin).toBe("devappuser");
    expect(row?.accountType).toBe("User");
    // hub_organization_id is the freshly-minted personal team for the new
    // GitHub user — assert the binding by checking it's non-null. Verifying
    // the exact id would duplicate createPersonalTeam's slug derivation that
    // the earlier dev-callback test already pins down.
    expect(row?.hubOrganizationId).not.toBeNull();
    // App-declared permissions mirror D0b — the dev stub looks like a real
    // install for downstream QA.
    expect(row?.permissions).toMatchObject({
      administration: "write",
      contents: "write",
      workflows: "write",
      members: "read",
    });
  });

  it("dev-callback without installationId leaves github_app_installations untouched (legacy OAuth-only dev flow)", async () => {
    const app = getApp();
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/auth/github/dev-callback?githubId=910&login=plainuser",
    });
    expect(res.statusCode).toBe(302);

    const { githubAppInstallations } = await import("../db/schema/github-app-installations.js");
    const rows = await app.db.select().from(githubAppInstallations);
    // No installation rows attributable to this synthetic GitHub id.
    const own = rows.filter((r) => r.accountGithubId === 910);
    expect(own).toHaveLength(0);
  });
});
