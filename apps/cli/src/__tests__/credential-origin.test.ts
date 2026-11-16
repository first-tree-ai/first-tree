import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  assertBoundCredentialOrigin,
  CredentialOriginMismatchError,
  canonicalOrigin,
} from "../core/credential-origin.js";

/**
 * SEC-023: the target URL and the persisted credential are resolved
 * independently, so `--server` / `FIRST_TREE_SERVER_URL` used to send the token
 * saved for one origin to whatever URL the override named.
 *
 * The origin is attached where the token is obtained and carried by the value.
 * These cases are written against that pair on purpose: the guarantee must not
 * depend on the current contents of `credentials.json`, nor on any process-wide
 * table that could forget it.
 */
const PROD_TOKEN = [
  Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url"),
  Buffer.from(JSON.stringify({ sub: "prod-user", exp: Math.floor(Date.now() / 1000) + 3600 })).toString("base64url"),
  "prod-signature",
].join(".");

const OTHER_TOKEN = [
  Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url"),
  Buffer.from(JSON.stringify({ sub: "prod-user", exp: Math.floor(Date.now() / 1000) + 7200 })).toString("base64url"),
  "rotated-signature",
].join(".");

let home: string;
const originalHome = process.env.FIRST_TREE_HOME;
const originalUrl = process.env.FIRST_TREE_SERVER_URL;

function writeStored(serverUrl: string, accessToken: string): void {
  writeFileSync(
    join(home, "config", "credentials.json"),
    JSON.stringify({ accessToken, refreshToken: `${accessToken}-refresh`, serverUrl }),
    { mode: 0o600 },
  );
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "ft-credential-origin-"));
  mkdirSync(join(home, "config"), { recursive: true });
  writeStored("https://prod.example", PROD_TOKEN);
  process.env.FIRST_TREE_HOME = home;
});

/** Restoring an unset variable by assigning `undefined` stores the string "undefined". */
function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

afterEach(() => {
  vi.unstubAllGlobals();
  restoreEnv("FIRST_TREE_HOME", originalHome);
  restoreEnv("FIRST_TREE_SERVER_URL", originalUrl);
  rmSync(home, { recursive: true, force: true });
});

describe("canonicalOrigin", () => {
  it("normalises case and default ports so equivalent spellings compare equal", () => {
    expect(canonicalOrigin("https://Prod.Example/x?y=1")).toBe("https://prod.example");
    expect(canonicalOrigin("https://prod.example:443")).toBe("https://prod.example");
    expect(canonicalOrigin("http://127.0.0.1:80")).toBe("http://127.0.0.1");
    expect(canonicalOrigin("http://127.0.0.1:8000/p")).toBe("http://127.0.0.1:8000");
    expect(canonicalOrigin("not a url")).toBeNull();
  });
});

describe("bound credential", () => {
  it("keeps the issuing origin when the store is rewritten for another server", async () => {
    const { ensureFreshBoundAccessToken } = await import("../core/bootstrap.js");
    const credential = await ensureFreshBoundAccessToken();
    expect(credential.token).toBe(PROD_TOKEN);

    // A refresh, or a re-login in another terminal, rewrites the store. The
    // credential in hand still belongs to production.
    writeStored("https://staging.example", OTHER_TOKEN);

    expect(() => assertBoundCredentialOrigin("https://staging.example", credential)).toThrow(
      CredentialOriginMismatchError,
    );
    expect(() => assertBoundCredentialOrigin("https://prod.example", credential)).not.toThrow();
  });

  it("is not weakened by any amount of later load activity", async () => {
    const { ensureFreshBoundAccessToken } = await import("../core/bootstrap.js");
    const held = await ensureFreshBoundAccessToken();

    // 32 more credentials from another origin, more than any in-process table
    // would have retained. The held pair must be unaffected: there is nothing to
    // evict, because the origin travels with the value.
    for (let index = 0; index < 32; index += 1) {
      writeStored(`https://staging-${index}.example`, OTHER_TOKEN);
      await ensureFreshBoundAccessToken();
    }
    writeStored("https://staging.example", OTHER_TOKEN);

    expect(() => assertBoundCredentialOrigin("https://staging.example", held)).toThrow(CredentialOriginMismatchError);
  });

  it("allows the rotated credential for its own origin", async () => {
    const { ensureFreshBoundAccessToken } = await import("../core/bootstrap.js");
    writeStored("https://staging.example", OTHER_TOKEN);
    const credential = await ensureFreshBoundAccessToken();

    expect(() => assertBoundCredentialOrigin("https://staging.example", credential)).not.toThrow();
  });
});

describe("cliFetch credential origin binding", () => {
  it("refuses to send the stored token to a different origin", async () => {
    const { cliFetch } = await import("../core/cli-fetch.js");
    await expect(
      cliFetch("http://127.0.0.1:9/api/v1/me/managed-agents", {
        headers: { Authorization: `Bearer ${PROD_TOKEN}` },
      }),
    ).rejects.toBeInstanceOf(CredentialOriginMismatchError);
  });

  it("allows the stored token for its own origin, including an equivalent spelling", async () => {
    const sent: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL) => {
        sent.push(String(input));
        return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
      }),
    );
    const { cliFetch } = await import("../core/cli-fetch.js");
    // Uppercase host + lowercase scheme keyword: same origin, so the request is
    // attempted (the assertion the earlier version of this test never made).
    const response = await cliFetch("https://PROD.example/api/v1/me", {
      headers: { authorization: `bearer ${PROD_TOKEN}` },
    });
    expect(response.status).toBe(200);
    expect(sent).toEqual(["https://PROD.example/api/v1/me"]);
  });

  it("does not touch tokens it does not recognise", async () => {
    const sent: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL) => {
        sent.push(String(input));
        return new Response("{}", { status: 200 });
      }),
    );
    const { cliFetch } = await import("../core/cli-fetch.js");
    // A login code / admin token / one-shot exchange token is not the stored
    // credential, so it may go anywhere. This is the explicit foreign-token
    // path: a header-only transport cannot know its origin, and callers that do
    // hold the credential bind it at load time instead.
    await cliFetch("http://127.0.0.1:9/api/v1/auth/login", {
      method: "POST",
      headers: { Authorization: "Bearer some-other-token" },
    });
    expect(sent).toEqual(["http://127.0.0.1:9/api/v1/auth/login"]);
  });
});

describe("accessTokenForOrigin", () => {
  it("hands the stored token to its own origin only", async () => {
    const { accessTokenForOrigin } = await import("../core/access-token.js");
    await expect(accessTokenForOrigin("https://prod.example")).resolves.toBe(PROD_TOKEN);
    await expect(accessTokenForOrigin("http://127.0.0.1:9")).rejects.toBeInstanceOf(CredentialOriginMismatchError);
  });

  it("still refuses after the store was rewritten for another server", async () => {
    const { accessTokenForOrigin } = await import("../core/access-token.js");
    // Resolve the credential first, then rotate the store: the token the CLI is
    // holding is still production's, and the request is bound to it rather than
    // to whatever the file says now.
    const resolved = accessTokenForOrigin("https://prod.example");
    writeStored("https://staging.example", OTHER_TOKEN);
    await expect(resolved).resolves.toBe(PROD_TOKEN);
  });
});

describe("command path", () => {
  it("agent list --remote refuses to reach an override origin and sends nothing", async () => {
    const received: string[] = [];
    const server = createServer((request, response) => {
      received.push(`${request.headers.host} ${request.url}`);
      response.writeHead(200, { "content-type": "application/json" });
      response.end("[]");
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    process.env.FIRST_TREE_SERVER_URL = `http://127.0.0.1:${port}`;

    try {
      const { registerAgentCommands } = await import("../commands/agent/index.js");
      const program = new Command();
      program.exitOverride();
      program.configureOutput({ writeErr: () => undefined, writeOut: () => undefined });
      registerAgentCommands(program);

      // The command funnels the throw through `fail()`, which exits; stub the
      // exit so the failure surfaces as a rejection carrying the message.
      const exit = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
        throw new Error(`exit ${code}`);
      }) as never);
      const stderr = vi.spyOn(process.stderr, "write").mockImplementation((() => true) as never);
      try {
        await expect(program.parseAsync(["node", "test", "agent", "list", "--remote"])).rejects.toThrow("exit 1");
        const emitted = stderr.mock.calls.map((call) => String(call[0])).join("");
        expect(emitted).toContain(`Refusing to send saved credentials to http://127.0.0.1:${port}`);
        expect(emitted).toContain("issued for https://prod.example");
        // The remedy must name a real command: `login` has no `--server` flag.
        expect(emitted).toContain("login <code from");
        expect(emitted).not.toContain("login <code> --server");
      } finally {
        stderr.mockRestore();
        exit.mockRestore();
      }
      // The guard fires before the request leaves the process.
      expect(received).toEqual([]);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
