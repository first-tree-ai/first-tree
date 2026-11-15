import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CredentialOriginMismatchError, canonicalOrigin } from "../core/credential-origin.js";

/**
 * SEC-023: the target URL and the persisted credential are resolved
 * independently, so `--server` / `FIRST_TREE_SERVER_URL` used to send the token
 * saved for one origin to whatever URL the override named.
 */
const PROD_TOKEN = [
  Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url"),
  Buffer.from(JSON.stringify({ sub: "prod-user", exp: Math.floor(Date.now() / 1000) + 3600 })).toString("base64url"),
  "prod-signature",
].join(".");

let home: string;
const originalHome = process.env.FIRST_TREE_HOME;
const originalUrl = process.env.FIRST_TREE_SERVER_URL;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "ft-credential-origin-"));
  mkdirSync(join(home, "config"), { recursive: true });
  writeFileSync(
    join(home, "config", "credentials.json"),
    JSON.stringify({ accessToken: PROD_TOKEN, refreshToken: "prod-refresh", serverUrl: "https://prod.example" }),
    { mode: 0o600 },
  );
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
    // credential, so it may go anywhere.
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
