import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { and, eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { connectCodes } from "../db/schema/connect-codes.js";
import { members } from "../db/schema/members.js";
import { users } from "../db/schema/users.js";
import { createTestAdmin, createTestApp, useTestApp } from "./helpers.js";
import { DEFAULT_ORG_ID } from "./setup.js";

const execFileAsync = promisify(execFile);
async function writeExecutable(path: string, contents: string): Promise<void> {
  await writeFile(path, contents);
  await chmod(path, 0o755);
}

async function executePortableBootstrap(bootstrapCommand: string): Promise<string[]> {
  const root = await mkdtemp(join(tmpdir(), "first-tree-connect-bootstrap-"));
  try {
    const homeDirectory = join(root, "home");
    const localBinDirectory = join(homeDirectory, ".local", "bin");
    const fakeBinDirectory = join(root, "fake-bin");
    const eventLog = join(root, "events.log");
    const fakeInstaller = join(root, "installer.sh");
    await Promise.all([
      mkdir(localBinDirectory, { recursive: true }),
      mkdir(fakeBinDirectory, { recursive: true }),
      writeFile(eventLog, ""),
    ]);
    await writeExecutable(
      fakeInstaller,
      `#!/bin/sh
printf '%s\n' 'installer-start' >> "$EVENT_LOG"
cat > "$HOME/.local/bin/first-tree" <<'SHIM'
#!/bin/sh
printf '%s\n' "installed-login:$*" >> "$EVENT_LOG"
SHIM
chmod 755 "$HOME/.local/bin/first-tree"
printf '%s\n' 'installer-success' >> "$EVENT_LOG"
`,
    );
    await writeExecutable(
      join(fakeBinDirectory, "curl"),
      `#!/bin/sh
cat "$FAKE_INSTALLER"
`,
    );

    await execFileAsync("/bin/sh", ["-c", bootstrapCommand], {
      env: {
        ...process.env,
        EVENT_LOG: eventLog,
        FAKE_INSTALLER: fakeInstaller,
        HOME: homeDirectory,
        PATH: `${fakeBinDirectory}:${process.env.PATH ?? "/usr/bin:/bin"}`,
      },
      timeout: 10_000,
    });

    return (await readFile(eventLog, "utf8")).trim().split("\n").filter(Boolean);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function hashConnectCode(code: string): string {
  return createHash("sha256").update(code).digest("hex");
}

function expectShortConnectCode(token: string): string {
  expect(token).toMatch(/^[A-Za-z0-9_-]{20,}$/);
  expect(token).not.toContain(".");
  expect(token).not.toContain("/");
  return token;
}

describe("POST /me/connect-tokens bootstrap command", () => {
  describe("prod default", () => {
    const getApp = useTestApp({ channel: "prod" });

    it("returns the exact production shell bootstrap", async () => {
      const app = getApp();
      const admin = await createTestAdmin(app);
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/me/connect-tokens",
        headers: {
          authorization: `Bearer ${admin.accessToken}`,
          host: "cloud.first-tree.ai",
          "x-forwarded-proto": "https",
        },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json<{
        token: string;
        command: string;
        bootstrapCommand: string;
        installerUrl: string | null;
        binName: string;
      }>();
      expect(body.binName).toBe("first-tree");
      expect(body.installerUrl).toBe("https://download.first-tree.ai/releases/prod/install.sh");
      expectShortConnectCode(body.token);
      expect(body.command).toBe(`first-tree login ${body.token}`);
      expect(body.bootstrapCommand).toBe(
        `curl -fsSL --proto '=https' --proto-redir '=https' https://download.first-tree.ai/releases/prod/install.sh | sh\n` +
          `~/.local/bin/first-tree login ${body.token}`,
      );
      expect(body).not.toHaveProperty("npmSpec");
      expect(body).not.toHaveProperty("installMethod");
    });

    it("executes the installer pipeline and invokes the installed CLI", async () => {
      const app = getApp();
      const admin = await createTestAdmin(app);
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/me/connect-tokens",
        headers: {
          authorization: `Bearer ${admin.accessToken}`,
          host: "cloud.first-tree.ai",
          "x-forwarded-proto": "https",
        },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json<{ bootstrapCommand: string; token: string }>();

      const events = await executePortableBootstrap(body.bootstrapCommand);

      expect(events).toEqual(["installer-start", "installer-success", `installed-login:login ${body.token}`]);
    });

    it("adds an explicit server URL for non-default deployment hosts", async () => {
      const app = getApp();
      const admin = await createTestAdmin(app);
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/me/connect-tokens",
        headers: {
          authorization: `Bearer ${admin.accessToken}`,
          host: "selfhost.example.test",
          "x-forwarded-proto": "https",
        },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json<{ token: string; command: string; bootstrapCommand: string }>();
      expectShortConnectCode(body.token);
      expect(body.command).toBe(`FIRST_TREE_SERVER_URL='https://selfhost.example.test' first-tree login ${body.token}`);
      expect(body.bootstrapCommand).toBe(
        `curl -fsSL --proto '=https' --proto-redir '=https' https://download.first-tree.ai/releases/prod/install.sh | sh\n` +
          `FIRST_TREE_SERVER_URL='https://selfhost.example.test' ~/.local/bin/first-tree login ${body.token}`,
      );
    });

    it("falls back to trimming the raw server URL when configured publicUrl is not parseable", async () => {
      const app = getApp();
      const admin = await createTestAdmin(app);
      const originalPublicUrl = app.config.server.publicUrl;
      app.config.server.publicUrl = "first-tree.internal///";
      try {
        const res = await app.inject({
          method: "POST",
          url: "/api/v1/me/connect-tokens",
          headers: { authorization: `Bearer ${admin.accessToken}` },
        });
        expect(res.statusCode).toBe(200);
        const body = res.json<{ token: string; command: string; bootstrapCommand: string }>();
        expectShortConnectCode(body.token);
        expect(body.command).toBe(`FIRST_TREE_SERVER_URL='first-tree.internal' first-tree login ${body.token}`);
        expect(body.bootstrapCommand).toBe(
          `curl -fsSL --proto '=https' --proto-redir '=https' https://download.first-tree.ai/releases/prod/install.sh | sh\n` +
            `FIRST_TREE_SERVER_URL='first-tree.internal' ~/.local/bin/first-tree login ${body.token}`,
        );
      } finally {
        app.config.server.publicUrl = originalPublicUrl;
      }
    });

    it("quotes shell metacharacters in a non-default server URL", async () => {
      const app = getApp();
      const admin = await createTestAdmin(app);
      const originalPublicUrl = app.config.server.publicUrl;
      app.config.server.publicUrl = "self'host;$(id)///";
      try {
        const res = await app.inject({
          method: "POST",
          url: "/api/v1/me/connect-tokens",
          headers: { authorization: `Bearer ${admin.accessToken}` },
        });
        expect(res.statusCode).toBe(200);
        const body = res.json<{ token: string; command: string; bootstrapCommand: string }>();
        expectShortConnectCode(body.token);
        expect(body.command).toBe(`FIRST_TREE_SERVER_URL='self'\\''host;$(id)' first-tree login ${body.token}`);
        expect(body.bootstrapCommand).toBe(
          `curl -fsSL --proto '=https' --proto-redir '=https' https://download.first-tree.ai/releases/prod/install.sh | sh\n` +
            `FIRST_TREE_SERVER_URL='self'\\''host;$(id)' ~/.local/bin/first-tree login ${body.token}`,
        );
      } finally {
        app.config.server.publicUrl = originalPublicUrl;
      }
    });
  });

  describe("staging default", () => {
    const getApp = useTestApp({ channel: "staging" });

    it("returns the exact staging shell bootstrap", async () => {
      const app = getApp();
      const admin = await createTestAdmin(app);
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/me/connect-tokens",
        headers: {
          authorization: `Bearer ${admin.accessToken}`,
          host: "dev.cloud.first-tree.ai",
          "x-forwarded-proto": "https",
        },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json<{
        token: string;
        command: string;
        bootstrapCommand: string;
        installerUrl: string | null;
        binName: string;
      }>();
      expectShortConnectCode(body.token);
      expect(body.binName).toBe("first-tree-staging");
      expect(body.installerUrl).toBe("https://download.first-tree.ai/releases/staging/install.sh");
      expect(body.command).toBe(`first-tree-staging login ${body.token}`);
      expect(body.bootstrapCommand).toBe(
        `curl -fsSL --proto '=https' --proto-redir '=https' https://download.first-tree.ai/releases/staging/install.sh | sh\n` +
          `~/.local/bin/first-tree-staging login ${body.token}`,
      );
    });
  });

  describe("custom portable mirror", () => {
    const getApp = useTestApp({
      channel: "prod",
      connectBootstrap: {
        portableDownloadBaseUrl: "https://downloads.example.test/releases",
      },
    });

    it("passes the mirror base to the piped installer and keeps the installer URL token-free", async () => {
      const app = getApp();
      const admin = await createTestAdmin(app);
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/me/connect-tokens",
        headers: {
          authorization: `Bearer ${admin.accessToken}`,
          host: "cloud.first-tree.ai",
          "x-forwarded-proto": "https",
        },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json<{
        token: string;
        command: string;
        bootstrapCommand: string;
        installerUrl: string | null;
        binName: string;
      }>();
      expectShortConnectCode(body.token);
      expect(body.installerUrl).toBe("https://downloads.example.test/releases/prod/install.sh");
      expect(body.bootstrapCommand).toBe(
        `curl -fsSL --proto '=https' --proto-redir '=https' 'https://downloads.example.test/releases/prod/install.sh' | ` +
          `FIRST_TREE_PORTABLE_DOWNLOAD_BASE_URL='https://downloads.example.test/releases' ` +
          `sh\n~/.local/bin/first-tree login ${body.token}`,
      );
      expect(body.installerUrl).not.toContain(body.token);
    });

    it("quotes shell metacharacters in a valid mirror URL", async () => {
      const app = getApp();
      const admin = await createTestAdmin(app);
      const originalPortableDownloadBaseUrl = app.config.connectBootstrap.portableDownloadBaseUrl;
      app.config.connectBootstrap.portableDownloadBaseUrl = "https://downloads.example.test/releases/$(id)";
      try {
        const res = await app.inject({
          method: "POST",
          url: "/api/v1/me/connect-tokens",
          headers: {
            authorization: `Bearer ${admin.accessToken}`,
            host: "cloud.first-tree.ai",
            "x-forwarded-proto": "https",
          },
        });
        expect(res.statusCode).toBe(200);
        const body = res.json<{ token: string; bootstrapCommand: string; installerUrl: string }>();
        expectShortConnectCode(body.token);
        expect(body.installerUrl).toBe("https://downloads.example.test/releases/$(id)/prod/install.sh");
        expect(body.bootstrapCommand).toBe(
          `curl -fsSL --proto '=https' --proto-redir '=https' 'https://downloads.example.test/releases/$(id)/prod/install.sh' | ` +
            `FIRST_TREE_PORTABLE_DOWNLOAD_BASE_URL='https://downloads.example.test/releases/$(id)' ` +
            `sh\n~/.local/bin/first-tree login ${body.token}`,
        );
      } finally {
        app.config.connectBootstrap.portableDownloadBaseUrl = originalPortableDownloadBaseUrl;
      }
    });
  });

  describe("dev source", () => {
    const getApp = useTestApp({
      channel: "dev",
      connectBootstrap: {
        portableDownloadBaseUrl: "https://downloads.example.test/releases",
      },
    });

    it("keeps dev source-only", async () => {
      const app = getApp();
      const admin = await createTestAdmin(app);
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/me/connect-tokens",
        headers: {
          authorization: `Bearer ${admin.accessToken}`,
          host: "127.0.0.1:8000",
          "x-forwarded-proto": "http",
        },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json<{
        token: string;
        command: string;
        bootstrapCommand: string;
        installerUrl: string | null;
      }>();
      expect(body.installerUrl).toBeNull();
      expectShortConnectCode(body.token);
      expect(body.bootstrapCommand).toBe(`first-tree-dev login ${body.token}`);
      expect(body).not.toHaveProperty("npmSpec");
      expect(body).not.toHaveProperty("installMethod");
    });
  });

  describe("exchange", () => {
    const getApp = useTestApp();

    it("exchanges a short connect code once", async () => {
      const app = getApp();
      const admin = await createTestAdmin(app);
      const minted = await app.inject({
        method: "POST",
        url: "/api/v1/me/connect-tokens",
        headers: { authorization: `Bearer ${admin.accessToken}` },
      });
      const body = minted.json<{ token: string }>();
      expectShortConnectCode(body.token);

      const first = await app.inject({
        method: "POST",
        url: "/api/v1/auth/connect-token",
        payload: { token: body.token },
      });
      expect(first.statusCode).toBe(200);
      expect(first.json<{ accessToken: string; refreshToken: string }>()).toMatchObject({
        accessToken: expect.any(String),
        refreshToken: expect.any(String),
      });

      const second = await app.inject({
        method: "POST",
        url: "/api/v1/auth/connect-token",
        payload: { token: body.token },
      });
      expect(second.statusCode).toBe(401);
      expect(second.json<{ error: string }>().error).toMatch(/Invalid or expired/);
    });

    it("stores only a hash of the short connect code", async () => {
      const app = getApp();
      const admin = await createTestAdmin(app);
      const minted = await app.inject({
        method: "POST",
        url: "/api/v1/me/connect-tokens",
        headers: { authorization: `Bearer ${admin.accessToken}` },
      });
      const body = minted.json<{ token: string }>();
      const code = expectShortConnectCode(body.token);
      const [row] = await app.db
        .select()
        .from(connectCodes)
        .where(eq(connectCodes.codeHash, hashConnectCode(code)));

      expect(row?.codeHash).toBe(hashConnectCode(code));
      expect(row?.codeHash).not.toBe(code);
      expect(row).not.toHaveProperty("code");
    });

    it("allows exactly one concurrent exchange for a short connect code", async () => {
      const app = getApp();
      const admin = await createTestAdmin(app);
      const minted = await app.inject({
        method: "POST",
        url: "/api/v1/me/connect-tokens",
        headers: { authorization: `Bearer ${admin.accessToken}` },
      });
      const body = minted.json<{ token: string }>();

      const results = await Promise.all(
        Array.from({ length: 4 }, () =>
          app.inject({
            method: "POST",
            url: "/api/v1/auth/connect-token",
            payload: { token: body.token },
          }),
        ),
      );

      expect(results.filter((res) => res.statusCode === 200)).toHaveLength(1);
      expect(results.filter((res) => res.statusCode === 401)).toHaveLength(3);
    });

    it("exchanges a short connect code after an app restart", async () => {
      const app = getApp();
      const admin = await createTestAdmin(app);
      const minted = await app.inject({
        method: "POST",
        url: "/api/v1/me/connect-tokens",
        headers: { authorization: `Bearer ${admin.accessToken}` },
      });
      const body = minted.json<{ token: string }>();
      const restarted = await createTestApp();
      try {
        const res = await restarted.inject({
          method: "POST",
          url: "/api/v1/auth/connect-token",
          payload: { token: body.token },
        });

        expect(res.statusCode).toBe(200);
        expect(res.json<{ accessToken: string; refreshToken: string }>()).toMatchObject({
          accessToken: expect.any(String),
          refreshToken: expect.any(String),
        });
      } finally {
        await restarted.close();
      }
    });

    it("rejects a short connect URL even when it wraps a valid code", async () => {
      const app = getApp();
      const admin = await createTestAdmin(app);
      const minted = await app.inject({
        method: "POST",
        url: "/api/v1/me/connect-tokens",
        headers: { authorization: `Bearer ${admin.accessToken}` },
      });
      const body = minted.json<{ token: string }>();
      const code = expectShortConnectCode(body.token);
      const [row] = await app.db
        .select()
        .from(connectCodes)
        .where(eq(connectCodes.codeHash, hashConnectCode(code)));
      if (!row) throw new Error("expected connect code row");

      const res = await app.inject({
        method: "POST",
        url: "/api/v1/auth/connect-token",
        payload: { token: `${row.issuer}/connect/${code}` },
      });

      expect(res.statusCode).toBe(401);
      expect(res.json<{ error: string }>().error).toMatch(/Invalid or expired/);
    });

    it("rejects expired short connect codes", async () => {
      const app = getApp();
      const admin = await createTestAdmin(app);
      const minted = await app.inject({
        method: "POST",
        url: "/api/v1/me/connect-tokens",
        headers: { authorization: `Bearer ${admin.accessToken}` },
      });
      const body = minted.json<{ token: string }>();
      const code = expectShortConnectCode(body.token);
      await app.db
        .update(connectCodes)
        .set({ expiresAt: new Date(Date.now() - 1000) })
        .where(eq(connectCodes.codeHash, hashConnectCode(code)));

      const res = await app.inject({
        method: "POST",
        url: "/api/v1/auth/connect-token",
        payload: { token: body.token },
      });
      expect(res.statusCode).toBe(401);
      expect(res.json<{ error: string }>().error).toMatch(/Invalid or expired/);
    });

    it("rejects a short connect code when the user was suspended after mint", async () => {
      const app = getApp();
      const admin = await createTestAdmin(app);
      const minted = await app.inject({
        method: "POST",
        url: "/api/v1/me/connect-tokens",
        headers: { authorization: `Bearer ${admin.accessToken}` },
      });
      const body = minted.json<{ token: string }>();
      await app.db.update(users).set({ status: "suspended" }).where(eq(users.id, admin.userId));

      const res = await app.inject({
        method: "POST",
        url: "/api/v1/auth/connect-token",
        payload: { token: body.token },
      });

      expect(res.statusCode).toBe(401);
      expect(res.json<{ error: string }>().error).toMatch(/suspended/);
    });

    it("stops a short connect code exchange at repair when all memberships were removed after mint", async () => {
      const app = getApp();
      const admin = await createTestAdmin(app);
      const minted = await app.inject({
        method: "POST",
        url: "/api/v1/me/connect-tokens",
        headers: { authorization: `Bearer ${admin.accessToken}` },
      });
      const body = minted.json<{ token: string }>();
      await app.db.update(members).set({ status: "removed" }).where(eq(members.userId, admin.userId));

      const res = await app.inject({
        method: "POST",
        url: "/api/v1/auth/connect-token",
        payload: { token: body.token },
      });

      expect(res.statusCode).toBe(401);
      expect(res.json()).toMatchObject({ code: "membership-repair-required" });
      const activeMemberships = await app.db
        .select({ id: members.id })
        .from(members)
        .where(and(eq(members.userId, admin.userId), eq(members.status, "active")));
      expect(activeMemberships).toHaveLength(0);
    });

    it("does not repair a short connect code exchange in invitation-only mode", async () => {
      const app = await createTestApp({ allowedOrganizationId: DEFAULT_ORG_ID });
      try {
        const admin = await createTestAdmin(app);
        const minted = await app.inject({
          method: "POST",
          url: "/api/v1/me/connect-tokens",
          headers: { authorization: `Bearer ${admin.accessToken}` },
        });
        const body = minted.json<{ token: string }>();
        await app.db.update(members).set({ status: "removed" }).where(eq(members.userId, admin.userId));

        const res = await app.inject({
          method: "POST",
          url: "/api/v1/auth/connect-token",
          payload: { token: body.token },
        });

        expect(res.statusCode).toBe(401);
        expect(res.json()).toMatchObject({ code: "invite-required" });
        const activeMemberships = await app.db
          .select({ id: members.id })
          .from(members)
          .where(and(eq(members.userId, admin.userId), eq(members.status, "active")));
        expect(activeMemberships).toEqual([]);
      } finally {
        await app.close();
      }
    });
  });
});
