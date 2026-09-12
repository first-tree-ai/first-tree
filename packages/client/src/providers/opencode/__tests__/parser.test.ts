import { describe, expect, it } from "vitest";
import { OpenCodeStreamParser, parseOpenCodeStreamLine } from "../parser.js";

describe("OpenCode JSONL parser", () => {
  it("normalizes session, text, tool, usage, and terminal events", () => {
    const lines = [
      JSON.stringify({ type: "step_start", sessionID: "ses_1", part: { sessionID: "ses_1" } }),
      JSON.stringify({ type: "reasoning", sessionID: "ses_1", part: { text: "private chain" } }),
      JSON.stringify({ type: "text", sessionID: "ses_1", part: { text: "hello" } }),
      JSON.stringify({
        type: "tool_use",
        sessionID: "ses_1",
        part: { id: "tool_1", tool: "bash", state: { status: "completed", input: { command: "pwd" }, output: "/w" } },
      }),
      JSON.stringify({
        type: "step_finish",
        sessionID: "ses_1",
        part: { reason: "stop", tokens: { input: 10, cache: { read: 3 }, output: 4 } },
      }),
    ];
    const parser = new OpenCodeStreamParser();
    const events = parser.push(`${lines.join("\n")}\n`);
    expect(events).toContainEqual({ kind: "text", text: "hello" });
    expect(events).toContainEqual({
      kind: "tool",
      toolUseId: "tool_1",
      name: "bash",
      status: "ok",
      args: { command: "pwd" },
      resultPreview: "/w",
    });
    expect(events).toContainEqual({
      kind: "usage",
      usage: { inputTokens: 10, cachedInputTokens: 3, outputTokens: 4 },
    });
    expect(events).toContainEqual({ kind: "terminal", reason: "stop" });
    expect(events).toContainEqual({ kind: "reasoning" });
  });

  it("does not treat tool-calls as terminal", () => {
    expect(
      parseOpenCodeStreamLine(JSON.stringify({ type: "step_finish", part: { reason: "tool-calls" } })),
    ).not.toContainEqual(expect.objectContaining({ kind: "terminal" }));
  });

  it("classifies malformed, unknown, and malformed-known lines as protocol violations", () => {
    expect(parseOpenCodeStreamLine("not-json")[0]).toMatchObject({ kind: "unknown" });
    expect(parseOpenCodeStreamLine(JSON.stringify({ type: "future", sessionID: "ses_1" }))).toContainEqual(
      expect.objectContaining({ kind: "unknown" }),
    );
  });

  it("skips explicitly empty text events stored by tool-only steps", () => {
    const events = parseOpenCodeStreamLine(JSON.stringify({ type: "text", sessionID: "ses_1", part: { text: "" } }));
    expect(events).toContainEqual({ kind: "session", sessionId: "ses_1" });
    expect(events).not.toContainEqual(expect.objectContaining({ kind: "unknown" }));
    expect(events).not.toContainEqual(expect.objectContaining({ kind: "text" }));
  });

  it("keeps malformed text fields as protocol violations", () => {
    for (const part of [{}, { text: 123 }]) {
      expect(parseOpenCodeStreamLine(JSON.stringify({ type: "text", sessionID: "ses_1", part }))).toContainEqual({
        kind: "unknown",
        note: "text event missing text",
      });
    }
  });

  it("uses the row-level text fallback only when the part has no text field", () => {
    expect(
      parseOpenCodeStreamLine(JSON.stringify({ type: "text", sessionID: "ses_1", text: "legacy" })),
    ).toContainEqual({ kind: "text", text: "legacy" });
    expect(
      parseOpenCodeStreamLine(JSON.stringify({ type: "text", sessionID: "ses_1", text: "legacy", part: {} })),
    ).toContainEqual({ kind: "text", text: "legacy" });
    expect(
      parseOpenCodeStreamLine(JSON.stringify({ type: "text", sessionID: "ses_1", text: "legacy", part: { text: "" } })),
    ).not.toContainEqual(expect.objectContaining({ kind: "text" }));
  });
});
