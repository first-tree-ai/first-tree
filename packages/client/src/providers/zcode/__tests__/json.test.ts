import { describe, expect, it } from "vitest";
import { parseZcodeJsonOutput } from "../json.js";

describe("parseZcodeJsonOutput", () => {
  it("accepts exactly one complete ZCode machine result", () => {
    expect(
      parseZcodeJsonOutput(
        JSON.stringify({
          sessionId: "sess_confirmed",
          traceId: "trace",
          turnId: "turn",
          response: "done",
          usage: { inputTokens: 3, cacheReadTokens: 2, outputTokens: 1 },
          projection: { status: "idle" },
        }),
      ),
    ).toEqual({
      sessionId: "sess_confirmed",
      response: "done",
      usage: { inputTokens: 3, cachedInputTokens: 2, outputTokens: 1 },
    });
  });

  it("rejects mixed output and incomplete results, and treats an invalid usage row as absent", () => {
    expect(() => parseZcodeJsonOutput('{"sessionId":"sess_1"}\nnoise')).toThrow(
      "ZCode machine output was not exactly one JSON object",
    );
    expect(() => parseZcodeJsonOutput("[]")).toThrow("ZCode machine output was not exactly one JSON object");
    expect(() => parseZcodeJsonOutput('{"sessionId":"not-session","response":"ok"}')).toThrow(
      "ZCode machine result omitted a sess_... sessionId",
    );
    expect(() => parseZcodeJsonOutput('{"sessionId":"sess_1"}')).toThrow(
      "ZCode machine result omitted string response",
    );
    expect(
      parseZcodeJsonOutput(JSON.stringify({ sessionId: "sess_1", response: "ok", usage: { inputTokens: "many" } })),
    ).toEqual({ sessionId: "sess_1", response: "ok", usage: null });
  });
});
