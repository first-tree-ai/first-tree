import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FirstTreeHubSDK } from "../sdk.js";

/**
 * SEC-058: Node's fetch drops `Authorization` on a cross-origin redirect but
 * keeps custom headers, so `x-agent-id` / `x-agent-runtime-session` used to
 * follow a redirect to another origin. The runtime-session token is the
 * credential that authorises agent-scoped writes, so it must not leave the
 * origin that issued it.
 */

type Received = { path: string; headers: IncomingHttpHeaders };

let target: Server;
let redirector: Server;
let targetReceived: Received[];
let targetOrigin: string;
let redirectOrigin: string;

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("no port");
  return `http://127.0.0.1:${address.port}`;
}

beforeEach(async () => {
  targetReceived = [];
  target = createServer((request, response) => {
    targetReceived.push({ path: request.url ?? "", headers: request.headers });
    response.writeHead(200, { "content-type": "application/json" });
    response.end("[]");
  });
  targetOrigin = await listen(target);
  redirector = createServer((_request, response) => {
    response.writeHead(302, { location: `${targetOrigin}/api/v1/me/pinned-agents` });
    response.end();
  });
  redirectOrigin = await listen(redirector);
});

afterEach(async () => {
  await new Promise<void>((resolve) => target.close(() => resolve()));
  await new Promise<void>((resolve) => redirector.close(() => resolve()));
});

function sdk(serverUrl: string): FirstTreeHubSDK {
  return new FirstTreeHubSDK({
    serverUrl,
    getAccessToken: async () => "user-jwt-for-origin-a",
    agentId: "agent-1",
    runtimeSessionToken: "runtime-session-secret",
    userAgent: "first-tree-test",
  });
}

describe("cross-origin redirects", () => {
  it("does not hand the runtime-session token to another origin", async () => {
    await sdk(redirectOrigin)
      .listMyAgents()
      .catch(() => undefined);
    console.error("PROBE", JSON.stringify(targetReceived));
    await expect(sdk(redirectOrigin).listMyAgents()).rejects.toThrow(/redirect/iu);

    // Two assertions in one: the credential never arrived, and the redirect
    // was not followed at all (a stripped-header follow would still show a
    // 401 here and would look like success to the caller).
    expect(targetReceived).toEqual([]);
  });

  it("replays a redirected POST as a body-less GET", async () => {
    const seen: Array<{ method?: string; hasBody: boolean; contentType?: string }> = [];
    const sameOrigin = createServer((request, response) => {
      if (request.method === "POST") {
        request.resume();
        request.on("end", () => {
          seen.push({ method: request.method, hasBody: true, contentType: request.headers["content-type"] });
          response.writeHead(303, { location: "/archive-result" });
          response.end();
        });
        return;
      }
      seen.push({ method: request.method, hasBody: false, contentType: request.headers["content-type"] });
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ chatId: "chat-1" }));
    });
    const origin = await listen(sameOrigin);
    try {
      // 303 means "your POST was processed, GET the result here".
      await sdk(origin)
        .archiveChat("chat-1")
        .catch(() => undefined);
    } finally {
      await new Promise<void>((resolve) => sameOrigin.close(() => resolve()));
    }
    expect(seen[1]).toEqual({ method: "GET", hasBody: false, contentType: undefined });
  });

  it("still follows a same-origin redirect", async () => {
    const sameOrigin = createServer((request, response) => {
      if (request.url === "/api/v1/me/pinned-agents") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify([{ agentId: "agent-1", clientId: "c1", runtimeProvider: "claude" }]));
        return;
      }
      response.writeHead(307, { location: "/api/v1/me/pinned-agents" });
      response.end();
    });
    const origin = await listen(sameOrigin);
    try {
      await expect(sdk(origin).listMyAgents()).resolves.toHaveLength(1);
    } finally {
      await new Promise<void>((resolve) => sameOrigin.close(() => resolve()));
    }
  });
});
