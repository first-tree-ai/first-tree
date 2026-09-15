import { createServer } from "node:http";
import { WS_AUTH_FRAME_TIMEOUT_MS } from "@first-tree/shared";
import { expect, it } from "vitest";
import { WebSocketServer } from "ws";
import { ClientConnection } from "../runtime/client-connection.js";

it("keeps the socket unopened through a real token delay beyond the server auth deadline", async () => {
  const server = createServer();
  const sockets = new WebSocketServer({ server, path: "/api/v1/agent/ws/client" });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing loopback address");
  let socketCount = 0;
  let authTimeouts = 0;
  const frames: string[] = [];
  sockets.on("connection", (socket) => {
    socketCount++;
    const deadline = setTimeout(() => {
      authTimeouts++;
      socket.send(JSON.stringify({ type: "auth:retryable", code: "auth_timeout", message: "auth frame timeout" }));
      socket.close(1013, "auth frame timeout");
    }, WS_AUTH_FRAME_TIMEOUT_MS);
    socket.on("close", () => clearTimeout(deadline));
    socket.on("message", (data) => {
      const frame: unknown = JSON.parse(data.toString());
      if (!frame || typeof frame !== "object" || !("type" in frame) || typeof frame.type !== "string") return;
      frames.push(frame.type);
      if (frame.type === "auth") {
        clearTimeout(deadline);
        socket.send(JSON.stringify({ type: "auth:ok" }));
      }
      if (frame.type === "client:register") socket.send(JSON.stringify({ type: "client:registered" }));
    });
  });
  let resolveToken: (token: string) => void = () => {};
  const token = new Promise<string>((resolve) => {
    resolveToken = resolve;
  });
  let notifyStarted: () => void = () => {};
  const started = new Promise<void>((resolve) => {
    notifyStarted = resolve;
  });
  let requestedValidity: number | undefined;
  const connection = new ClientConnection({
    serverUrl: `http://127.0.0.1:${address.port}`,
    clientId: "issue-2390-independent-acceptance",
    getAccessToken: (options) => {
      requestedValidity = options?.minValidityMs;
      notifyStarted();
      return token;
    },
  });
  connection.on("error", () => {});
  const connected = connection.connect();
  const settled = connected.catch(() => {});
  try {
    await started;
    await new Promise<void>((resolve) => setTimeout(resolve, WS_AUTH_FRAME_TIMEOUT_MS + 1_000));
    expect(socketCount, "a token request must not open a socket").toBe(0);
    expect(authTimeouts).toBe(0);
    expect(requestedValidity).toBeGreaterThan(60_000);
    resolveToken("independent-loopback-token");
    await connected;
    expect(connection.isConnected).toBe(true);
    expect(socketCount).toBe(1);
    expect(frames).toEqual(["auth", "client:register"]);
    expect(authTimeouts).toBe(0);
  } finally {
    await connection.disconnect();
    await settled;
    for (const socket of sockets.clients) socket.terminate();
    await new Promise<void>((resolve) => sockets.close(() => resolve()));
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}, 15_000);
