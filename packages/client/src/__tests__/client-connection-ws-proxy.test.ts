import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveWebSocketProxyAgent } from "../runtime/client-connection.js";

/**
 * Regression: `ws` opens its own socket and ignores `HTTP(S)_PROXY`, so the
 * daemon's WebSocket stayed direct while `fetch` went through the proxy via
 * `NODE_USE_ENV_PROXY`. On networks where direct egress to the server is
 * blocked, HTTP worked while the socket reconnect-looped forever.
 *
 * The upgrade request now gets an explicit proxy agent under the same opt-in
 * switch the built-in fetch honours, so one setting covers both egress paths.
 */
describe("resolveWebSocketProxyAgent", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    delete process.env.NODE_USE_ENV_PROXY;
    delete process.env.HTTPS_PROXY;
    delete process.env.https_proxy;
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("returns an agent for a wss url when the env opt-in is on", () => {
    process.env.NODE_USE_ENV_PROXY = "1";
    process.env.HTTPS_PROXY = "http://127.0.0.1:7897";

    expect(resolveWebSocketProxyAgent("wss://cloud.first-tree.ai/api/v1/agent/ws/client")).toBeDefined();
  });

  it("accepts the lowercase https_proxy spelling", () => {
    process.env.NODE_USE_ENV_PROXY = "1";
    process.env.https_proxy = "http://127.0.0.1:7897";

    expect(resolveWebSocketProxyAgent("wss://cloud.first-tree.ai/api/v1/agent/ws/client")).toBeDefined();
  });

  it("stays direct when the env opt-in is off, even if HTTPS_PROXY is set", () => {
    process.env.HTTPS_PROXY = "http://127.0.0.1:7897";

    expect(resolveWebSocketProxyAgent("wss://cloud.first-tree.ai/api/v1/agent/ws/client")).toBeUndefined();
  });

  it("stays direct when no proxy url is configured", () => {
    process.env.NODE_USE_ENV_PROXY = "1";

    expect(resolveWebSocketProxyAgent("wss://cloud.first-tree.ai/api/v1/agent/ws/client")).toBeUndefined();
  });

  it("does not proxy a plain ws url — only TLS upgrades use HTTPS_PROXY", () => {
    process.env.NODE_USE_ENV_PROXY = "1";
    process.env.HTTPS_PROXY = "http://127.0.0.1:7897";

    expect(resolveWebSocketProxyAgent("ws://127.0.0.1:8080/api/v1/agent/ws/client")).toBeUndefined();
  });
});
