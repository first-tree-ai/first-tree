import { Writable } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { createLoggerOutputStream, LOG_OUTPUT_MAX_QUEUED_BYTES, LOG_OUTPUT_MAX_RECORD_BYTES } from "../logger-core.js";

/** Next macrotask — lets stream internals settle between writes. */
function tick(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

async function drain(dest: Writable): Promise<void> {
  for (let i = 0; i < 20 && dest.writableLength > 0; i++) await tick();
}

function collect(): { dest: Writable; received: string[]; read: () => string } {
  const received: string[] = [];
  const dest = new Writable({
    write(chunk, _, callback) {
      received.push(chunk.toString());
      callback();
    },
  });
  return { dest, received, read: () => received.join("") };
}

/**
 * A sink whose gate starts closed: `_write` never calls back while closed, so
 * every accepted chunk piles up in the stream's internal buffer and
 * `writableLength` reflects exactly what the logger pushed in. Opening the
 * gate releases the held callbacks and lets the buffer drain.
 */
function gatedSink(): { dest: Writable; received: string[]; open: () => void } {
  const received: string[] = [];
  const held: Array<() => void> = [];
  let open = false;
  const dest = new Writable({
    highWaterMark: 16 * 1024,
    write(chunk, _enc, cb) {
      received.push(chunk.toString());
      if (open) {
        cb();
      } else {
        held.push(cb);
      }
    },
  });
  return {
    dest,
    received,
    open: () => {
      open = true;
      for (const cb of held.splice(0)) cb();
    },
  };
}

/** A pino-style NDJSON line padded with ASCII to exactly `targetBytes`. */
function lineOf(targetBytes: number, msg = "x"): string {
  const base = `${JSON.stringify({ level: 30, time: "t", msg: "" })}\n`;
  const line = `${JSON.stringify({ level: 30, time: "t", msg: msg.repeat(Math.max(0, targetBytes - Buffer.byteLength(base))) })}\n`;
  return line;
}

function jsonLine(msg: string): string {
  return `${JSON.stringify({ level: 30, time: "t", msg })}\n`;
}

describe("logger output bounds", () => {
  it("exposes a 64 KiB record cap and a 256 KiB queued-destination cap", () => {
    expect(LOG_OUTPUT_MAX_RECORD_BYTES).toBe(64 * 1024);
    expect(LOG_OUTPUT_MAX_QUEUED_BYTES).toBe(256 * 1024);
  });

  it("keeps a stalled destination within a strict byte bound across thousands of writes", async () => {
    const gate = gatedSink();
    const stream = createLoggerOutputStream({
      getFormat: () => "json",
      getDestination: () => gate.dest,
    });
    const line = lineOf(1057);
    const lineBytes = Buffer.byteLength(line);

    for (let i = 0; i < 8192; i++) stream.write(line);
    await tick();
    await tick();

    // Strict bound with exact byte accounting: the largest multiple of the
    // record size that fits the cap — never the ~8.6 MiB the unbounded writer
    // queued, and no undocumented one-record overshoot.
    expect(gate.dest.writableLength).toBe(Math.floor(LOG_OUTPUT_MAX_QUEUED_BYTES / lineBytes) * lineBytes);
    expect(gate.dest.writableLength).toBeLessThanOrEqual(LOG_OUTPUT_MAX_QUEUED_BYTES);
    // The wrapper must not become the unbounded buffer either: it acknowledges
    // every record (dropping on pressure) instead of holding a queue pino
    // would never drain.
    expect(stream.writableLength).toBe(0);
  });

  it("replaces an oversized Unicode record with a bounded summary and never parses or forwards the original", () => {
    const { dest, received } = collect();
    const bridged: Array<Record<string, unknown>> = [];
    const stream = createLoggerOutputStream({
      getFormat: () => "json",
      getDestination: () => dest,
      onJsonEntry: (entry) => bridged.push(entry),
    });

    // "界" is 3 bytes in UTF-8: 30_000 chars ≈ 90_000 bytes — over the byte
    // cap while the character count alone would look under it.
    const huge = "界".repeat(30_000);
    const line = `${JSON.stringify({ level: 30, time: "t", msg: huge })}\n`;
    expect(Buffer.byteLength(line)).toBeGreaterThan(LOG_OUTPUT_MAX_RECORD_BYTES);

    stream.write(line);

    const out = received.join("");
    expect(out).not.toContain(huge);
    expect(out).toContain('"level":40');
    expect(out).toContain("recordBytes");
    for (const chunk of received) {
      expect(Buffer.byteLength(chunk)).toBeLessThan(1024);
    }
    // The oversized original must not be JSON.parsed, pretty-rendered, or
    // trace-bridged — each of those would allocate a second huge copy.
    expect(bridged).toEqual([]);
  });

  it("forwards a record at exactly the byte cap and replaces one a single byte over it", () => {
    const { dest, read } = collect();
    const bridged: Array<Record<string, unknown>> = [];
    const stream = createLoggerOutputStream({
      getFormat: () => "json",
      getDestination: () => dest,
      onJsonEntry: (entry) => bridged.push(entry),
    });

    const atCap = lineOf(LOG_OUTPUT_MAX_RECORD_BYTES, "y");
    expect(Buffer.byteLength(atCap)).toBe(LOG_OUTPUT_MAX_RECORD_BYTES);
    stream.write(atCap);
    expect(read()).toBe(atCap);
    expect(bridged).toHaveLength(1);

    const overCap = lineOf(LOG_OUTPUT_MAX_RECORD_BYTES + 1, "z");
    expect(Buffer.byteLength(overCap)).toBe(LOG_OUTPUT_MAX_RECORD_BYTES + 1);
    stream.write(overCap);
    const out = read().slice(atCap.length);
    expect(out).not.toContain("z".repeat(1000));
    expect(out).toContain('"level":40');
    expect(out).toContain("recordBytes");
    expect(bridged).toHaveLength(1);
  });

  it("emits one bounded drop-accounting warning on recovery, then resumes ordinary records", async () => {
    const gate = gatedSink();
    const stream = createLoggerOutputStream({
      getFormat: () => "json",
      getDestination: () => gate.dest,
    });
    const line = lineOf(1057);
    const lineBytes = Buffer.byteLength(line);

    // Fill the stalled destination to the cap so subsequent writes drop.
    const toFill = Math.ceil(LOG_OUTPUT_MAX_QUEUED_BYTES / lineBytes) + 6;
    for (let i = 0; i < toFill; i++) stream.write(line);
    await tick();
    const droppedWrites = 50;
    for (let i = 0; i < droppedWrites; i++) stream.write(line);
    await tick();

    gate.open();
    await drain(gate.dest);
    const beforeRecovery = gate.received.length;

    stream.write(jsonLine("after-recovery"));
    await tick();

    const recoveryOut = gate.received.slice(beforeRecovery).join("");
    // Exactly one structured, bounded warning carrying the drop count …
    expect(recoveryOut.match(/"level":40/g)).toHaveLength(1);
    const dropped = Number(recoveryOut.match(/"droppedRecords":(\d+)/)?.[1]);
    expect(dropped).toBeGreaterThanOrEqual(droppedWrites);
    // … and ordinary records flow again.
    expect(recoveryOut).toContain('"msg":"after-recovery"');

    // No repeated warning once the drop count has been reported.
    stream.write(jsonLine("steady-again"));
    await tick();
    const steadyOut = gate.received.slice(beforeRecovery).join("");
    expect(steadyOut.match(/"level":40/g)).toHaveLength(1);
    expect(steadyOut).toContain('"msg":"steady-again"');
  });

  it("keeps the drop counter when the recovery notice itself cannot be admitted", async () => {
    const gate = gatedSink();
    const stream = createLoggerOutputStream({
      getFormat: () => "json",
      getDestination: () => gate.dest,
    });
    const line = lineOf(1057);
    const lineBytes = Buffer.byteLength(line);

    // Fill to the exact cap; every further payload — notice or record —
    // exceeds the remaining few bytes and must be refused.
    for (let i = 0; i < 300; i++) stream.write(line);
    await tick();
    const queued = Math.floor(LOG_OUTPUT_MAX_QUEUED_BYTES / lineBytes) * lineBytes;
    expect(gate.dest.writableLength).toBe(queued);
    const droppedSoFar = 300 - queued / lineBytes;

    // This record cannot be admitted; its recovery notice cannot be admitted
    // either. The earlier drops must survive the failed notice attempt.
    stream.write(line);
    await tick();
    expect(gate.received.some((chunk) => chunk.includes('"level":40'))).toBe(false);

    gate.open();
    await drain(gate.dest);
    const beforeRecovery = gate.received.length;
    stream.write(jsonLine("recovered"));
    await tick();

    const recoveryOut = gate.received.slice(beforeRecovery).join("");
    expect(recoveryOut.match(/"level":40/g)).toHaveLength(1);
    // droppedSoFar pressure drops + the one record whose notice was refused.
    expect(recoveryOut).toContain(`"droppedRecords":${droppedSoFar + 1}`);
    expect(recoveryOut).toContain('"msg":"recovered"');
  });

  it("drops records for a destroyed destination without requeueing, and reports on the next healthy destination", async () => {
    const a = collect();
    let current: Writable = a.dest;
    const stream = createLoggerOutputStream({
      getFormat: () => "json",
      getDestination: () => current,
    });
    stream.write(jsonLine("one"));
    expect(a.read()).toContain('"msg":"one"');

    const dead = collect();
    dead.dest.destroy();
    current = dead.dest;
    for (let i = 0; i < 100; i++) {
      stream.write(jsonLine(`lost-${i}`));
    }
    await tick();

    // Nothing written to the dead destination, nothing buffered anywhere, and
    // exactly one bounded error guard — no per-record listeners.
    expect(dead.read()).toBe("");
    expect(stream.writableLength).toBe(0);
    expect(dead.dest.listenerCount("drain")).toBe(0);
    expect(dead.dest.listenerCount("error")).toBe(1);

    const b = collect();
    current = b.dest;
    stream.write(jsonLine("back"));
    await tick();

    const out = b.read();
    expect(out).toContain('"level":40');
    expect(out).toContain('"droppedRecords":100');
    expect(out).toContain('"msg":"back"');

    // Switching back to the dead destination must not attach another listener.
    current = dead.dest;
    stream.write(jsonLine("again"));
    expect(dead.dest.listenerCount("error")).toBe(1);
  });

  it("survives real asynchronous destination failures (autoDestroy) without crashing or growing listeners", async () => {
    const received: string[] = [];
    let armed = false;
    const failing = new Writable({
      write(chunk, _enc, cb) {
        if (armed) {
          // A real asynchronous failure: write callback with an error, which
          // makes the stream emit 'error' and autoDestroy.
          cb(new Error("sink exploded"));
          return;
        }
        received.push(chunk.toString());
        cb();
      },
    });
    let current: Writable = failing;
    const stream = createLoggerOutputStream({
      getFormat: () => "json",
      getDestination: () => current,
    });

    stream.write(jsonLine("one"));
    expect(received.join("")).toContain('"msg":"one"');
    // The wrapper attached exactly one bounded error guard; the wrapper
    // itself stays listener-free.
    expect(failing.listenerCount("error")).toBe(1);
    expect(stream.listenerCount("error")).toBe(0);

    armed = true;
    stream.write(jsonLine("lost-async"));
    await tick();
    await tick();
    // The 'error' event was swallowed by the guard — an unhandled one would
    // fail this run as an uncaught exception — and autoDestroy tore the sink
    // down so later writes drop cleanly.
    expect(failing.destroyed).toBe(true);

    for (let i = 0; i < 10; i++) stream.write(jsonLine(`post-${i}`));
    await tick();
    expect(failing.listenerCount("error")).toBe(1);

    const healthy = collect();
    current = healthy.dest;
    stream.write(jsonLine("back"));
    await tick();
    const out = healthy.read();
    expect(out.match(/"level":40/g)).toHaveLength(1);
    // One async error event plus ten refused writes.
    expect(out).toContain('"droppedRecords":11');
    expect(out).toContain('"msg":"back"');
  });

  it("stops admitting to an errored-but-not-destroyed destination (autoDestroy: false)", async () => {
    let armed = false;
    const dest = new Writable({
      autoDestroy: false,
      write(_chunk, _enc, cb) {
        cb(armed ? new Error("permanent failure") : null);
      },
    });
    let current: Writable = dest;
    const stream = createLoggerOutputStream({
      getFormat: () => "json",
      getDestination: () => current,
    });

    stream.write(jsonLine("one"));
    armed = true;
    stream.write(jsonLine("two"));
    await tick();
    await tick();

    // Errored but intentionally not destroyed. Later records must be dropped
    // without another write: an errored autoDestroy:false sink would
    // otherwise keep accepting writes that never complete, so its queue must
    // stay at zero and no further 'error' events may fire.
    expect(dest.destroyed).toBe(false);
    expect(dest.errored).toBeInstanceOf(Error);

    for (let i = 0; i < 5; i++) stream.write(jsonLine(`x-${i}`));
    await tick();
    expect(dest.writableLength).toBe(0);
    expect(dest.listenerCount("error")).toBe(1);

    const healthy = collect();
    current = healthy.dest;
    stream.write(jsonLine("back"));
    await tick();
    const out = healthy.read();
    // One async error event plus five refused writes.
    expect(out).toContain('"droppedRecords":6');
    expect(out).toContain('"msg":"back"');
  });

  it("refuses a destination that already errored before the wrapper first observed it", async () => {
    const dest = new Writable({
      autoDestroy: false,
      write(_chunk, _enc, cb) {
        cb(new Error("synthetic"));
      },
    });
    // Test-side listener: this failure happens before the wrapper exists.
    dest.on("error", () => {});
    dest.write("trigger");
    await tick();
    await tick();
    expect(dest.errored?.message).toBe("synthetic");
    expect(dest.destroyed).toBe(false);

    let current: Writable = dest;
    const bridged: Array<Record<string, unknown>> = [];
    const stream = createLoggerOutputStream({
      getFormat: () => "json",
      getDestination: () => current,
      onJsonEntry: (entry) => bridged.push(entry),
    });
    for (let i = 0; i < 3; i++) stream.write(jsonLine(`lost-${i}`));
    await tick();

    // No write reaches the pre-errored sink: its queue must not grow (an
    // errored autoDestroy:false sink would otherwise buffer writes that never
    // complete), the records are not bridged, and exactly one bounded guard
    // listener was added on top of the test-side one.
    expect(dest.writableLength).toBe(0);
    expect(bridged).toEqual([]);
    expect(dest.listenerCount("error")).toBe(2);

    const healthy = collect();
    current = healthy.dest;
    stream.write(jsonLine("back"));
    await tick();
    const out = healthy.read();
    expect(out).toContain('"droppedRecords":3');
    expect(out).toContain('"msg":"back"');
  });

  it("skips decoding, formatting, parsing, and bridging in pretty mode for a known-dead destination", async () => {
    const a = collect();
    let current: Writable = a.dest;
    const bridged: Array<Record<string, unknown>> = [];
    const stream = createLoggerOutputStream({
      getFormat: () => "pretty",
      getDestination: () => current,
      onJsonEntry: (entry) => bridged.push(entry),
    });
    stream.write(jsonLine("alive"));
    expect(a.read()).toContain("alive");
    expect(bridged).toHaveLength(1);

    const dead = collect();
    dead.dest.destroy();
    current = dead.dest;
    const parseSpy = vi.spyOn(JSON, "parse");
    try {
      for (let i = 0; i < 20; i++) stream.write(jsonLine(`lost-${i}`));
      // The known-dead destination is rejected before the original record is
      // decoded, pretty-formatted, or parsed — repeated failure logs must not
      // repeatedly pay that cost for known-discarded records.
      expect(parseSpy).not.toHaveBeenCalled();
    } finally {
      parseSpy.mockRestore();
    }
    await tick();
    expect(dead.read()).toBe("");
    expect(bridged).toHaveLength(1);

    const b = collect();
    current = b.dest;
    stream.write(jsonLine("back"));
    await tick();
    const out = b.read();
    // Pretty rendering of the recovery notice, with the exact drop count.
    expect(out).toContain("droppedRecords=20");
    expect(out).toContain("back");
  });

  it("does not parse or bridge a record whose destination write failed synchronously", async () => {
    const { dest, read } = collect();
    const bridged: Array<Record<string, unknown>> = [];
    const stream = createLoggerOutputStream({
      getFormat: () => "json",
      getDestination: () => dest,
      onJsonEntry: (entry) => bridged.push(entry),
    });
    const spy = vi.spyOn(dest, "write").mockImplementationOnce((() => {
      throw new Error("sync boom");
    }) as never);

    stream.write(jsonLine("discarded"));
    await tick();
    expect(spy).toHaveBeenCalledTimes(1);
    // The discarded record is neither written nor trace-bridged.
    expect(read()).not.toContain("discarded");
    expect(bridged).toEqual([]);

    stream.write(jsonLine("later"));
    await tick();
    // … but it is accounted honestly once the destination accepts writes.
    expect(read()).toContain('"droppedRecords":1');
    expect(read()).toContain('"msg":"later"');
    expect(bridged).toEqual([{ level: 30, time: "t", msg: "later" }]);
  });

  it("acknowledges and accounts records when the format getter throws, with no unsafe fallback write", async () => {
    const { dest, read } = collect();
    let explode = true;
    const stream = createLoggerOutputStream({
      getFormat: () => {
        if (explode) throw new Error("format exploded");
        return "json";
      },
      getDestination: () => dest,
    });

    await new Promise<void>((resolve) => stream.write(jsonLine("boom"), () => resolve()));
    // Acknowledged without crashing and without requeueing the raw record
    // through a catch fallback.
    expect(read()).toBe("");

    explode = false;
    stream.write(jsonLine("back"));
    await tick();
    expect(read()).toContain('"droppedRecords":1');
    expect(read()).toContain('"msg":"back"');
  });

  it("acknowledges records when the destination getter throws, without touching a destination", async () => {
    const stream = createLoggerOutputStream({
      getFormat: () => "json",
      getDestination: (): Writable => {
        throw new Error("getter exploded");
      },
    });

    await new Promise<void>((resolve) => stream.write(jsonLine("boom"), () => resolve()));
    expect(stream.writableLength).toBe(0);
  });

  it("renders a bounded drop notice through the pretty formatter on recovery", async () => {
    const gate = gatedSink();
    const stream = createLoggerOutputStream({
      getFormat: () => "pretty",
      getDestination: () => gate.dest,
    });
    const line = lineOf(1057);
    const toFill = Math.ceil(LOG_OUTPUT_MAX_QUEUED_BYTES / Buffer.byteLength(line)) + 10;
    for (let i = 0; i < toFill; i++) stream.write(line);
    await tick();

    gate.open();
    await drain(gate.dest);
    const beforeRecovery = gate.received.length;
    stream.write(jsonLine("pretty-back"));
    await tick();

    const recoveryChunks = gate.received.slice(beforeRecovery);
    const recoveryOut = recoveryChunks.join("");
    expect(recoveryOut).toContain("WARN");
    expect(recoveryOut).toContain("dropped");
    expect(recoveryOut).toContain("pretty-back");
    // The notice stays bounded even in pretty mode.
    const warnChunk = recoveryChunks.find((chunk) => chunk.includes("WARN"));
    expect(warnChunk).toBeDefined();
    expect(Buffer.byteLength(warnChunk ?? "")).toBeLessThan(1024);
  });
});
