import { afterEach, describe, expect, it, vi } from "vitest";
import { applyLoggerConfig, createLogger, setErrorSink } from "../logger.js";

type SinkCall = { message: string; err: unknown; context: Record<string, unknown> };

function installSpySink(): { calls: SinkCall[]; restore: () => void } {
  const calls: SinkCall[] = [];
  setErrorSink((message, err, context) => {
    calls.push({ message, err, context });
  });
  return { calls, restore: () => setErrorSink(null) };
}

describe("logger ErrorSink bridging", () => {
  // Silence stderr writes from the logger during tests.
  // `vi.spyOn` on overloaded signatures (process.stderr.write) resists typing;
  // the spy is only used to restore the mock so `unknown` is fine.
  let writeSpy: { mockRestore(): void } | undefined;

  afterEach(() => {
    writeSpy?.mockRestore();
    // Reset log config back to permissive defaults so other tests are unaffected.
    applyLoggerConfig({ level: "trace", format: "json", bridgeToSpanLevel: "error" });
    setErrorSink(null);
  });

  function silenceStderr() {
    writeSpy = vi.spyOn(process.stderr, "write").mockImplementation((() => true) as never);
  }

  it("forwards error-level logs to the registered sink", () => {
    silenceStderr();
    applyLoggerConfig({ level: "trace", format: "json", bridgeToSpanLevel: "error" });
    const { calls, restore } = installSpySink();

    const log = createLogger("TestModule");
    log.error({ err: new Error("boom"), userId: "u1" }, "something exploded");

    expect(calls).toHaveLength(1);
    expect(calls[0]?.message).toBe("something exploded");
    expect(calls[0]?.err).toMatchObject({ message: "boom" });
    expect(calls[0]?.context.userId).toBe("u1");
    expect(calls[0]?.context.module).toBe("TestModule");

    restore();
  });

  it("forwards fatal-level logs to the sink", () => {
    silenceStderr();
    applyLoggerConfig({ level: "trace", format: "json", bridgeToSpanLevel: "error" });
    const { calls, restore } = installSpySink();

    createLogger("M").fatal("dying");

    expect(calls).toHaveLength(1);
    expect(calls[0]?.message).toBe("dying");
    restore();
  });

  it("does NOT forward warn-level logs when bridgeToSpanLevel=error", () => {
    silenceStderr();
    applyLoggerConfig({ level: "trace", format: "json", bridgeToSpanLevel: "error" });
    const { calls, restore } = installSpySink();

    createLogger("M").warn("non-fatal");

    expect(calls).toHaveLength(0);
    restore();
  });

  it("DOES forward warn-level logs when bridgeToSpanLevel=warn", () => {
    silenceStderr();
    applyLoggerConfig({ level: "trace", format: "json", bridgeToSpanLevel: "warn" });
    const { calls, restore } = installSpySink();

    createLogger("M").warn("heads up");

    expect(calls).toHaveLength(1);
    expect(calls[0]?.message).toBe("heads up");
    restore();
  });

  it("does NOT forward any level when bridgeToSpanLevel=off", () => {
    silenceStderr();
    applyLoggerConfig({ level: "trace", format: "json", bridgeToSpanLevel: "off" });
    const { calls, restore } = installSpySink();

    const log = createLogger("M");
    log.error("boom1");
    log.fatal("boom2");

    expect(calls).toHaveLength(0);
    restore();
  });

  it("does nothing when no sink is registered", () => {
    silenceStderr();
    applyLoggerConfig({ level: "trace", format: "json", bridgeToSpanLevel: "error" });
    setErrorSink(null);

    // Should not throw when no sink is installed.
    expect(() => createLogger("M").error("no-sink-registered")).not.toThrow();
  });

  it("swallows sink exceptions without breaking the logging path", () => {
    silenceStderr();
    applyLoggerConfig({ level: "trace", format: "json", bridgeToSpanLevel: "error" });
    setErrorSink(() => {
      throw new Error("sink blew up");
    });

    expect(() => createLogger("M").error("boom")).not.toThrow();
    setErrorSink(null);
  });

  it("truncates overlong string values before handing them to the sink", () => {
    silenceStderr();
    applyLoggerConfig({ level: "trace", format: "json", bridgeToSpanLevel: "error" });
    const { calls, restore } = installSpySink();

    // 5000-char string — well above MAX_STRING_LEN (2048)
    const huge = "x".repeat(5000);
    createLogger("M").error({ payload: huge }, "big error");

    expect(calls).toHaveLength(1);
    const forwarded = calls[0]?.context.payload;
    expect(typeof forwarded).toBe("string");
    // Truncation marker must be appended; length is capped at MAX_STRING_LEN + marker
    expect(forwarded).toMatch(/\.\.\.\[truncated \d+ chars\]$/);
    expect((forwarded as string).length).toBeLessThan(huge.length);
    restore();
  });

  it("JSON-stringifies and truncates oversized object values", () => {
    silenceStderr();
    applyLoggerConfig({ level: "trace", format: "json", bridgeToSpanLevel: "error" });
    const { calls, restore } = installSpySink();

    // Object whose JSON will exceed MAX_JSON_LEN (8192) so the per-field
    // truncation is exercised, while the whole log record stays comfortably
    // below the output layer's 64 KiB whole-record cap — above that cap the
    // record is intentionally replaced before parsing/bridging (covered by
    // the shared logger-output-bounds tests, not by this one).
    const big = { items: Array.from({ length: 200 }, (_, i) => ({ id: i, data: "x".repeat(50) })) };
    const fieldJson = JSON.stringify(big);
    expect(fieldJson.length).toBeGreaterThan(8192);
    // >2x safety margin: the full record adds only ~200 bytes of envelope.
    expect(fieldJson.length).toBeLessThan(32 * 1024);
    createLogger("M").error({ state: big }, "bulky state");

    expect(calls).toHaveLength(1);
    const forwarded = calls[0]?.context.state;
    expect(typeof forwarded).toBe("string");
    expect(forwarded).toMatch(/\.\.\.\[truncated \d+ chars\]$/);
    restore();
  });

  it("stringifies circular values when JSON serialization fails", () => {
    silenceStderr();
    applyLoggerConfig({ level: "trace", format: "json", bridgeToSpanLevel: "error" });
    const { calls, restore } = installSpySink();
    const circular: Record<string, unknown> = {};
    circular.self = circular;

    createLogger("M").error({ circular }, "circular state");

    expect(calls[0]?.context.circular).toContain("[Circular]");
    restore();
  });
});

describe("logger output format", () => {
  // `vi.spyOn` on overloaded signatures (process.stderr.write) resists typing;
  // the spy is only used to restore the mock so `unknown` is fine.
  let writeSpy: { mockRestore(): void } | undefined;

  afterEach(() => {
    writeSpy?.mockRestore();
    applyLoggerConfig({ level: "trace", format: "json", bridgeToSpanLevel: "error" });
  });

  it("emits NDJSON when format=json", () => {
    const chunks: string[] = [];
    // process.stderr.write has multiple overloads; the cast keeps the mock simple.
    writeSpy = vi.spyOn(process.stderr, "write").mockImplementation(((chunk: string | Uint8Array) => {
      chunks.push(typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk));
      return true;
    }) as never);
    applyLoggerConfig({ level: "trace", format: "json", bridgeToSpanLevel: "off" });

    createLogger("M").info({ k: "v" }, "hello");

    const combined = chunks.join("");
    // json format writes raw NDJSON from pino; should parse back.
    const parsed = JSON.parse(combined.trim());
    expect(parsed.module).toBe("M");
    expect(parsed.msg).toBe("hello");
    expect(parsed.k).toBe("v");
  });

  it("serializes request objects with redacted query parameters", () => {
    const chunks: string[] = [];
    writeSpy = vi.spyOn(process.stderr, "write").mockImplementation(((chunk: string | Uint8Array) => {
      chunks.push(typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk));
      return true;
    }) as never);
    applyLoggerConfig({ level: "trace", format: "json", bridgeToSpanLevel: "off" });

    createLogger("M").info(
      {
        req: {
          method: "GET",
          url: "/api/v1/orgs?token=secret&safe=1",
          headers: { "accept-version": "2026-01-01" },
          host: "cloud.first-tree.ai",
          ip: "127.0.0.1",
          socket: { remotePort: 443 },
        },
      },
      "incoming request",
    );

    const parsed = JSON.parse(chunks.join("").trim());
    expect(parsed.req).toMatchObject({
      method: "GET",
      version: "2026-01-01",
      host: "cloud.first-tree.ai",
      remoteAddress: "127.0.0.1",
      remotePort: 443,
    });
    expect(parsed.req.url).toContain("token=***");
    expect(parsed.req.url).toContain("safe=1");
  });

  it("emits human-readable pretty output when format=pretty", () => {
    const chunks: string[] = [];
    // process.stderr.write has multiple overloads; the cast keeps the mock simple.
    writeSpy = vi.spyOn(process.stderr, "write").mockImplementation(((chunk: string | Uint8Array) => {
      chunks.push(typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk));
      return true;
    }) as never);
    applyLoggerConfig({ level: "trace", format: "pretty", bridgeToSpanLevel: "off" });

    createLogger("M").info("hello");

    const combined = chunks.join("");
    expect(combined).toContain("INFO");
    expect(combined).toContain("[M]");
    expect(combined).toContain("hello");
  });
});
