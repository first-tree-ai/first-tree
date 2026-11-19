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
    delete process.env.HTTP_PROXY;
    delete process.env.http_proxy;
    delete process.env.NO_PROXY;
    delete process.env.no_proxy;
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

/**
 * `https-proxy-agent` tunnels whatever it is handed and never reads `NO_PROXY`,
 * so an excluded destination would still be proxied. The exclusion has to be
 * applied before the agent is constructed.
 */
describe("resolveWebSocketProxyAgent NO_PROXY", () => {
  const originalEnv = { ...process.env };
  const WSS = "wss://cloud.first-tree.ai/api/v1/agent/ws/client";

  beforeEach(() => {
    delete process.env.NO_PROXY;
    delete process.env.no_proxy;
    process.env.NODE_USE_ENV_PROXY = "1";
    process.env.HTTPS_PROXY = "http://127.0.0.1:7897";
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("takes the direct route for an excluded host", () => {
    process.env.NO_PROXY = "cloud.first-tree.ai";

    expect(resolveWebSocketProxyAgent(WSS)).toBeUndefined();
  });

  it("still proxies an ordinary secure destination while NO_PROXY is set", () => {
    process.env.NO_PROXY = "internal.example.com";

    expect(resolveWebSocketProxyAgent(WSS)).toBeDefined();
  });

  it("matches subdomains for a dotted or wildcard suffix", () => {
    process.env.NO_PROXY = ".first-tree.ai";
    expect(resolveWebSocketProxyAgent(WSS)).toBeUndefined();

    process.env.NO_PROXY = "*.first-tree.ai";
    expect(resolveWebSocketProxyAgent(WSS)).toBeUndefined();
  });

  it("does not match a host that merely ends with the excluded name", () => {
    process.env.NO_PROXY = "first-tree.ai";

    // `cloud.first-tree.ai` is a subdomain (excluded); `evil-first-tree.ai` is a
    // different registrable name and must still be proxied (see next case).
    expect(resolveWebSocketProxyAgent("wss://evil-first-tree.ai/api/v1/agent/ws/client")).toBeDefined();
  });

  it("honours `*` as 'proxy nothing'", () => {
    process.env.NO_PROXY = "*";

    expect(resolveWebSocketProxyAgent(WSS)).toBeUndefined();
  });

  it("applies an entry's port only to that port", () => {
    process.env.NO_PROXY = "cloud.first-tree.ai:8443";
    expect(resolveWebSocketProxyAgent(WSS)).toBeDefined();

    process.env.NO_PROXY = "cloud.first-tree.ai:443";
    expect(resolveWebSocketProxyAgent(WSS)).toBeUndefined();
  });

  it("matches bracketed IPv6 literals exactly", () => {
    process.env.NO_PROXY = "[::1]";
    expect(resolveWebSocketProxyAgent("wss://[::1]/api/v1/agent/ws/client")).toBeUndefined();
    expect(resolveWebSocketProxyAgent(WSS)).toBeDefined();
  });

  it("accepts the lowercase no_proxy spelling", () => {
    process.env.no_proxy = "cloud.first-tree.ai";

    expect(resolveWebSocketProxyAgent(WSS)).toBeUndefined();
  });

  it("ignores blank entries", () => {
    process.env.NO_PROXY = " , ,";

    expect(resolveWebSocketProxyAgent(WSS)).toBeDefined();
  });

  it("accepts a whitespace-separated bypass list, like fetch does", () => {
    process.env.NO_PROXY = "internal.example.com\tother.example.com cloud.first-tree.ai";

    expect(resolveWebSocketProxyAgent(WSS)).toBeUndefined();
  });
});

/**
 * Node's fetch (undici's `EnvHttpProxyAgent`) reads lowercase first and only
 * then the uppercase spelling. If the daemon disagreed, one destination could
 * be proxied for HTTP and sent direct for the socket while both read the same
 * environment.
 */
describe("resolveWebSocketProxyAgent environment precedence", () => {
  const originalEnv = { ...process.env };
  const WSS = "wss://cloud.first-tree.ai/api/v1/agent/ws/client";
  const proxyOf = (agent: ReturnType<typeof resolveWebSocketProxyAgent>): string | undefined =>
    agent ? agent.proxy.href : undefined;

  beforeEach(() => {
    delete process.env.no_proxy;
    delete process.env.NO_PROXY;
    delete process.env.https_proxy;
    delete process.env.HTTP_PROXY;
    delete process.env.http_proxy;
    delete process.env.HTTPS_PROXY;
    process.env.NODE_USE_ENV_PROXY = "1";
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("prefers the lowercase proxy variable when both are set", () => {
    process.env.https_proxy = "http://lower.example:8080";
    process.env.HTTPS_PROXY = "http://upper.example:8080";

    expect(proxyOf(resolveWebSocketProxyAgent(WSS))).toBe("http://lower.example:8080/");
  });

  it("falls back to the uppercase proxy variable", () => {
    process.env.HTTPS_PROXY = "http://upper.example:8080";

    expect(proxyOf(resolveWebSocketProxyAgent(WSS))).toBe("http://upper.example:8080/");
  });

  it("falls back to the plain HTTP proxy for a TLS upgrade", () => {
    // undici's HTTPS agent falls back to the HTTP agent, so a host that only
    // exports HTTP_PROXY still proxies HTTPS.
    process.env.HTTP_PROXY = "http://only-http.example:3128";

    expect(proxyOf(resolveWebSocketProxyAgent(WSS))).toBe("http://only-http.example:3128/");
  });

  it("prefers an https_proxy over a plain HTTP proxy", () => {
    process.env.https_proxy = "http://tls.example:8080";
    process.env.HTTP_PROXY = "http://only-http.example:3128";

    expect(proxyOf(resolveWebSocketProxyAgent(WSS))).toBe("http://tls.example:8080/");
  });

  it("prefers the lowercase bypass variable when both are set", () => {
    process.env.https_proxy = "http://lower.example:8080";
    process.env.no_proxy = "cloud.first-tree.ai";
    process.env.NO_PROXY = "internal.example.com";

    expect(resolveWebSocketProxyAgent(WSS)).toBeUndefined();
  });
});
