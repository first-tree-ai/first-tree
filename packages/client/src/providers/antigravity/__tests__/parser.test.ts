import { describe, expect, it } from "vitest";
import { AntigravityStreamParser, parseAntigravityStreamLine } from "../parser.js";

describe("Antigravity stream-json parser", () => {
  it("parses the documented init, response, tool, usage, and result events", () => {
    const parser = new AntigravityStreamParser();
    const events = [
      ...parser.push(
        [
          JSON.stringify({
            event: "init",
            conversation_id: "conversation-1",
            init: { permission_mode: "always-proceed" },
          }),
          JSON.stringify({
            event: "step_update",
            step_update: {
              conversation_id: "conversation-1",
              step_index: 2,
              state: "ACTIVE",
              step_type: "agent_response",
              text_delta: "working",
            },
          }),
          JSON.stringify({
            event: "step_update",
            step_update: {
              conversation_id: "conversation-1",
              step_index: 3,
              state: "DONE",
              step_type: "tool",
              tool_name: "run_command",
              tool_call_id: "call-1",
              tool_info: { parameters: { CommandLine: "echo hi" }, output: "hi\n" },
              usage: { input_tokens: 12, cache_read_tokens: 4, output_tokens: 2 },
            },
          }),
          JSON.stringify({
            event: "result",
            result: {
              conversation_id: "conversation-1",
              status: "SUCCESS",
              response: "working\n",
              usage: { input_tokens: 20, cache_read_tokens: 8, output_tokens: 5 },
            },
          }),
        ].join("\n"),
      ),
      ...parser.flush(),
    ];

    expect(events).toEqual([
      { kind: "init", sessionId: "conversation-1" },
      { kind: "init", sessionId: "conversation-1" },
      { kind: "assistant_delta", text: "working" },
      { kind: "init", sessionId: "conversation-1" },
      {
        kind: "usage",
        usage: { inputTokens: 12, cachedInputTokens: 4, outputTokens: 2 },
      },
      {
        kind: "tool",
        toolUseId: "call-1",
        name: "run_command",
        status: "ok",
        args: { CommandLine: "echo hi" },
        resultPreview: "hi\n",
      },
      {
        kind: "result",
        isError: false,
        text: "working\n",
        sessionId: "conversation-1",
        usage: { inputTokens: 20, cachedInputTokens: 8, outputTokens: 5 },
      },
    ]);
  });

  it("reassembles split lines and flushes an unterminated tail", () => {
    const parser = new AntigravityStreamParser();
    const line = `${JSON.stringify({ event: "step_update", step_update: { conversation_id: "c", step_type: "agent_response", text_delta: "hi" } })}\n`;
    const midpoint = Math.floor(line.length / 2);
    expect(parser.push(line.slice(0, midpoint))).toEqual([]);
    expect(parser.push(line.slice(midpoint))).toMatchObject([
      { kind: "init", sessionId: "c" },
      { kind: "assistant_delta", text: "hi" },
    ]);
    parser.push(JSON.stringify({ event: "result", result: { conversation_id: "c", status: "SUCCESS", response: "" } }));
    expect(parser.flush()).toMatchObject([{ kind: "result", isError: false, sessionId: "c" }]);
  });

  it("turns non-success results and unknown lines into explicit diagnostics", () => {
    expect(
      parseAntigravityStreamLine(
        JSON.stringify({
          event: "result",
          result: { conversation_id: "c", status: "AUTHENTICATION_REQUIRED", error: "authentication required" },
        }),
      ),
    ).toEqual([
      { kind: "result", isError: true, text: "", sessionId: "c", usage: null },
      { kind: "error", message: "authentication required" },
    ]);
    expect(parseAntigravityStreamLine("not-json")).toMatchObject([{ kind: "unknown" }]);
    expect(parseAntigravityStreamLine(JSON.stringify({ event: "future_event" }))).toMatchObject([{ kind: "unknown" }]);
  });
});
