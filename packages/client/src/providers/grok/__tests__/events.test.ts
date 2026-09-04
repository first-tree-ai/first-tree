import { describe, expect, it } from "vitest";
import {
  GROK_UNKNOWN_TOOL_NAME,
  mergeGrokToolInfo,
  normalizeGrokSessionUpdate,
  normalizeGrokXaiNotification,
  parseGrokModelChangedEcho,
  parseGrokModelState,
} from "../events.js";
import { grokShellCommandIsReadOnly, grokToolIsReadOnly } from "../index.js";

/**
 * Pure normalization coverage for the Grok ACP wire shapes (locked against
 * real Grok 0.2.117 traffic): standard session/update payloads, the x.ai
 * extension channels, the `_meta["x.ai/tool"]` read-only ladder, and the
 * initialize `_meta.modelState` catalog parsing.
 */

const SEARCH_REPLACE_TOOL_CALL = {
  sessionId: "sess-1",
  update: {
    sessionUpdate: "tool_call",
    toolCallId: "tc-1",
    title: "search_replace",
    rawInput: { path: "notes.md", old_str: "a", new_str: "b" },
    _meta: {
      "x.ai/tool": {
        version: 1,
        name: "search_replace",
        kind: "edit",
        namespace: "grok_build",
        label: "Edit",
        read_only: false,
      },
    },
  },
};

describe("normalizeGrokSessionUpdate", () => {
  it("normalizes agent_message_chunk into an assistant chunk", () => {
    const normalized = normalizeGrokSessionUpdate({
      sessionId: "sess-1",
      update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Hello world" } },
    });
    expect(normalized).toEqual({ sessionId: "sess-1", event: { kind: "assistant_chunk", text: "Hello world" } });
  });

  it("normalizes agent_thought_chunk into a presence-only thought chunk", () => {
    const normalized = normalizeGrokSessionUpdate({
      sessionId: "sess-1",
      update: { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "hmm" } },
    });
    expect(normalized).toEqual({ sessionId: "sess-1", event: { kind: "thought_chunk" } });
  });

  it("ignores user_message_chunk echoes", () => {
    const normalized = normalizeGrokSessionUpdate({
      sessionId: "sess-1",
      update: { sessionUpdate: "user_message_chunk", content: { type: "text", text: "my own prompt" } },
    });
    expect(normalized).toEqual({ sessionId: "sess-1", event: { kind: "user_echo" } });
  });

  it("normalizes tool_call with authoritative x.ai/tool metadata", () => {
    const normalized = normalizeGrokSessionUpdate(SEARCH_REPLACE_TOOL_CALL);
    expect(normalized?.sessionId).toBe("sess-1");
    const event = normalized?.event;
    if (event?.kind !== "tool_started") throw new Error("expected tool_started");
    expect(event.tool.toolCallId).toBe("tc-1");
    expect(event.tool.name).toBe("search_replace");
    expect(event.tool.kind).toBe("edit");
    expect(event.tool.readOnly).toBe(false);
    expect(event.tool.command).toBeNull();
  });

  it("falls back to the raw title when x.ai/tool metadata is absent (unproven read-only)", () => {
    const normalized = normalizeGrokSessionUpdate({
      sessionId: "sess-1",
      update: { sessionUpdate: "tool_call", toolCallId: "tc-9", title: "read_file", rawInput: { path: "a.md" } },
    });
    const event = normalized?.event;
    if (event?.kind !== "tool_started") throw new Error("expected tool_started");
    expect(event.tool.name).toBe("read_file");
    expect(event.tool.readOnly).toBeNull();
  });

  it("normalizes tool_call_update completed with diff + locations into a completed tool with paths", () => {
    const normalized = normalizeGrokSessionUpdate({
      sessionId: "sess-1",
      update: {
        sessionUpdate: "tool_call_update",
        toolCallId: "tc-1",
        kind: "edit",
        title: "search_replace",
        status: "completed",
        content: [{ type: "diff", path: "notes.md", oldText: "a", newText: "b" }],
        locations: [{ path: "notes.md" }, { path: "extra.md" }],
        rawInput: { path: "notes.md" },
        rawOutput: "edited notes.md",
        _meta: { "x.ai/tool": { version: 1, name: "search_replace", kind: "edit", read_only: false } },
      },
    });
    const event = normalized?.event;
    if (event?.kind !== "tool_completed") throw new Error("expected tool_completed");
    expect(event.ok).toBe(true);
    expect(event.resultPreview).toBe("edited notes.md");
    expect(event.tool.paths).toEqual(["notes.md", "extra.md"]);
    expect(event.tool.argsSummary).toEqual({ path: "notes.md" });
  });

  it("maps a failed tool_call_update to ok=false", () => {
    const normalized = normalizeGrokSessionUpdate({
      sessionId: "sess-1",
      update: { sessionUpdate: "tool_call_update", toolCallId: "tc-2", status: "failed", rawOutput: "boom" },
    });
    const event = normalized?.event;
    if (event?.kind !== "tool_completed") throw new Error("expected tool_completed");
    expect(event.ok).toBe(false);
    expect(event.resultPreview).toBe("boom");
    expect(event.tool.name).toBe(GROK_UNKNOWN_TOOL_NAME);
  });

  it("reads ACP top-level kind when x.ai/tool metadata is absent", () => {
    const normalized = normalizeGrokSessionUpdate({
      sessionId: "sess-1",
      update: { sessionUpdate: "tool_call", toolCallId: "tc-k", kind: "execute", rawInput: { command: "cat NODE.md" } },
    });
    const event = normalized?.event;
    if (event?.kind !== "tool_started") throw new Error("expected tool_started");
    expect(event.tool.kind).toBe("execute");
    expect(event.tool.isShell).toBe(true);
    expect(event.tool.name).toBe(GROK_UNKNOWN_TOOL_NAME);
  });

  it("ignores in-progress tool_call_update statuses", () => {
    const normalized = normalizeGrokSessionUpdate({
      sessionId: "sess-1",
      update: { sessionUpdate: "tool_call_update", toolCallId: "tc-2", status: "in_progress" },
    });
    expect(normalized?.event.kind).toBe("ignored");
  });

  it("extracts the shell command for run_terminal_cmd", () => {
    const normalized = normalizeGrokSessionUpdate({
      sessionId: "sess-1",
      update: {
        sessionUpdate: "tool_call",
        toolCallId: "tc-3",
        title: "run_terminal_cmd",
        rawInput: { command: "cat context-tree/NODE.md" },
        _meta: { "x.ai/tool": { version: 1, name: "run_terminal_cmd", kind: "execute", read_only: true } },
      },
    });
    const event = normalized?.event;
    if (event?.kind !== "tool_started") throw new Error("expected tool_started");
    expect(event.tool.name).toBe("run_terminal_cmd");
    expect(event.tool.command).toBe("cat context-tree/NODE.md");
    expect(event.tool.argsSummary).toEqual({ command: "cat context-tree/NODE.md" });
  });

  it("keeps plan updates as a distinct log-only kind", () => {
    const normalized = normalizeGrokSessionUpdate({
      sessionId: "sess-1",
      update: { sessionUpdate: "plan", entries: [] },
    });
    expect(normalized?.event.kind).toBe("plan");
  });

  it("ignores available_commands_update and unknown kinds without throwing", () => {
    expect(
      normalizeGrokSessionUpdate({ sessionId: "s", update: { sessionUpdate: "available_commands_update" } })?.event
        .kind,
    ).toBe("ignored");
    expect(
      normalizeGrokSessionUpdate({ sessionId: "s", update: { sessionUpdate: "brand_new_kind" } })?.event.kind,
    ).toBe("ignored");
    expect(normalizeGrokSessionUpdate("not an object")).toBeNull();
    expect(normalizeGrokSessionUpdate({ sessionId: "s" })).toBeNull();
  });
});

describe("mergeGrokToolInfo — ACP tool_call_update patch semantics", () => {
  function started(over: Record<string, unknown> = {}) {
    const normalized = normalizeGrokSessionUpdate({
      sessionId: "s",
      update: {
        sessionUpdate: "tool_call",
        toolCallId: "tc-1",
        title: "read_file",
        rawInput: { path: "NODE.md" },
        _meta: { "x.ai/tool": { name: "read_file", kind: "read", read_only: true, input: { path: "NODE.md" } } },
        ...over,
      },
    });
    if (normalized?.event.kind !== "tool_started") throw new Error("expected tool_started");
    return normalized.event.tool;
  }

  it("keeps the start name when a completed update omits title and x.ai/tool meta", () => {
    const completed = normalizeGrokSessionUpdate({
      sessionId: "s",
      update: { sessionUpdate: "tool_call_update", toolCallId: "tc-1", status: "completed", rawOutput: "ok" },
    });
    if (completed?.event.kind !== "tool_completed") throw new Error("expected tool_completed");
    expect(completed.event.tool.name).toBe(GROK_UNKNOWN_TOOL_NAME);
    const merged = mergeGrokToolInfo(started(), completed.event.tool);
    expect(merged.name).toBe("read_file");
    expect(merged.kind).toBe("read");
    expect(merged.readOnly).toBe(true);
    expect(merged.paths).toEqual(["NODE.md"]);
    expect(merged.argsSummary).toEqual({ path: "NODE.md" });
  });

  it("lets a concrete incoming name replace the previous one", () => {
    const incoming = normalizeGrokSessionUpdate({
      sessionId: "s",
      update: { sessionUpdate: "tool_call_update", toolCallId: "tc-1", title: "read_file_v2", status: "completed" },
    });
    if (incoming?.event.kind !== "tool_completed") throw new Error("expected tool_completed");
    expect(mergeGrokToolInfo(started(), incoming.event.tool).name).toBe("read_file_v2");
  });

  it("leaves grok:unknown when this toolCallId has never had a name", () => {
    const completed = normalizeGrokSessionUpdate({
      sessionId: "s",
      update: { sessionUpdate: "tool_call_update", toolCallId: "tc-orphan", status: "failed", rawOutput: "boom" },
    });
    if (completed?.event.kind !== "tool_completed") throw new Error("expected tool_completed");
    expect(mergeGrokToolInfo(undefined, completed.event.tool).name).toBe(GROK_UNKNOWN_TOOL_NAME);
  });
});

describe("normalizeGrokXaiNotification", () => {
  const TURN_COMPLETED = {
    sessionId: "sess-1",
    update: {
      sessionUpdate: "turn_completed",
      prompt_id: "prompt-1",
      stop_reason: "end_turn",
      usage: {
        inputTokens: 42,
        outputTokens: 7,
        totalTokens: 49,
        cachedReadTokens: 10,
        cacheCreationTokens: 0,
        reasoningTokens: 3,
        modelCalls: 1,
        apiDurationMs: 1200,
        costUsdTicks: 55,
      },
    },
  };

  it("maps turn_completed usage with camelCase fields and log-only cost", () => {
    const normalized = normalizeGrokXaiNotification(TURN_COMPLETED);
    expect(normalized?.sessionId).toBe("sess-1");
    const event = normalized?.event;
    if (event?.kind !== "turn_completed") throw new Error("expected turn_completed");
    expect(event.completed.promptId).toBe("prompt-1");
    expect(event.completed.stopReason).toBe("end_turn");
    expect(event.completed.usage).toEqual({ inputTokens: 42, outputTokens: 7, cachedReadTokens: 10 });
    expect(event.completed.costUsdTicks).toBe(55);
    expect(event.completed.modelCalls).toBe(1);
    expect(event.completed.apiDurationMs).toBe(1200);
  });

  it("tolerates a turn_completed without usage", () => {
    const normalized = normalizeGrokXaiNotification({
      sessionId: "sess-1",
      update: { sessionUpdate: "turn_completed", prompt_id: "p", stop_reason: "cancelled" },
    });
    const event = normalized?.event;
    if (event?.kind !== "turn_completed") throw new Error("expected turn_completed");
    expect(event.completed.usage).toBeNull();
  });

  it.each([
    "response_completed",
    "model_changed",
    "tool_call_delta_chunk",
    "pending_interaction",
    "interaction_resolved",
    "retry_state",
    "session_summary_generated",
  ])("ignores the %s extension kind (no double counting, log-only)", (sessionUpdate) => {
    const normalized = normalizeGrokXaiNotification({
      sessionId: "sess-1",
      update: { sessionUpdate, usage: { input_tokens: 999, output_tokens: 999 } },
    });
    expect(normalized?.event.kind).toBe("ignored");
    if (normalized?.event.kind !== "ignored") throw new Error("unreachable");
    expect(normalized.event.note).toContain(sessionUpdate);
  });

  it("returns null for malformed envelopes", () => {
    expect(normalizeGrokXaiNotification(null)).toBeNull();
    expect(normalizeGrokXaiNotification({ update: "nope" })).toBeNull();
  });
});

describe("read-only replay-safety ladder", () => {
  const tool = (over: Record<string, unknown>) => ({
    toolCallId: "t",
    name: "tool",
    kind: null,
    isShell: false,
    readOnly: null,
    command: null,
    paths: [],
    argsSummary: {},
    ...over,
  });

  it("read_only === true on a non-shell tool is proven read-only", () => {
    expect(grokToolIsReadOnly(tool({ name: "read_file", readOnly: true }))).toBe(true);
  });

  it("read_only false or absent is NEVER proven read-only", () => {
    expect(grokToolIsReadOnly(tool({ readOnly: false }))).toBe(false);
    expect(grokToolIsReadOnly(tool({}))).toBe(false);
  });

  it("a shell tool needs read_only AND a supported read classification", () => {
    expect(
      grokToolIsReadOnly(tool({ name: "run_terminal_cmd", isShell: true, readOnly: true, command: "cat NODE.md" })),
    ).toBe(true);
    expect(
      grokToolIsReadOnly(tool({ name: "run_terminal_cmd", isShell: true, readOnly: true, command: "rm -rf x" })),
    ).toBe(false);
    expect(
      grokToolIsReadOnly(tool({ name: "run_terminal_cmd", isShell: true, readOnly: false, command: "cat NODE.md" })),
    ).toBe(false);
    expect(grokShellCommandIsReadOnly("git status")).toBe(false);
    expect(grokShellCommandIsReadOnly(null)).toBe(false);
  });

  it("a shell tool with a MISSING command fails closed (unsafe) even with read_only true", () => {
    expect(grokToolIsReadOnly(tool({ name: "run_terminal_cmd", isShell: true, readOnly: true, command: null }))).toBe(
      false,
    );
  });

  it("shell detection keys on kind execute even under a different name", () => {
    expect(
      grokToolIsReadOnly(
        tool({ name: "shell_custom", kind: "execute", isShell: true, readOnly: true, command: "cat x" }),
      ),
    ).toBe(true);
    expect(grokToolIsReadOnly(tool({ name: "shell_custom", kind: "execute", isShell: true, readOnly: true }))).toBe(
      false,
    );
  });

  it("reads the command from _meta x.ai/tool input when rawInput lacks it", () => {
    const normalized = normalizeGrokSessionUpdate({
      sessionId: "s",
      update: {
        sessionUpdate: "tool_call",
        toolCallId: "tc-meta",
        title: "run_terminal_cmd",
        rawInput: {},
        _meta: {
          "x.ai/tool": {
            version: 1,
            name: "run_terminal_cmd",
            kind: "execute",
            read_only: true,
            input: { command: "cat NODE.md" },
          },
        },
      },
    });
    const event = normalized?.event;
    if (event?.kind !== "tool_started") throw new Error("expected tool_started");
    expect(event.tool.command).toBe("cat NODE.md");
    expect(event.tool.isShell).toBe(true);
    expect(grokToolIsReadOnly(event.tool)).toBe(true);
  });

  it("marks run_terminal_cmd and kind execute as shell in normalized events", () => {
    const byName = normalizeGrokSessionUpdate({
      sessionId: "s",
      update: { sessionUpdate: "tool_call", toolCallId: "t1", title: "run_terminal_cmd", rawInput: {} },
    });
    if (byName?.event.kind !== "tool_started") throw new Error("expected tool_started");
    expect(byName.event.tool.isShell).toBe(true);
    const byKind = normalizeGrokSessionUpdate({
      sessionId: "s",
      update: {
        sessionUpdate: "tool_call",
        toolCallId: "t2",
        title: "something_else",
        _meta: { "x.ai/tool": { kind: "execute", read_only: true } },
      },
    });
    if (byKind?.event.kind !== "tool_started") throw new Error("expected tool_started");
    expect(byKind.event.tool.isShell).toBe(true);
    expect(grokToolIsReadOnly(byKind.event.tool)).toBe(false);
  });
});

describe("parseGrokModelChangedEcho", () => {
  it("locks the real snake_case wire shape from _x.ai/session_notification", () => {
    // Captured live on Grok 0.2.117 after session/set_model.
    const echo = parseGrokModelChangedEcho({
      sessionId: "019fb8a6-80ad-75b1-a1eb-7f56e5767868",
      update: { sessionUpdate: "model_changed", model_id: "grok-4.5", reasoning_effort: "low" },
    });
    expect(echo).toEqual({ modelId: "grok-4.5", reasoningEffort: "low" });
  });

  it("returns a null effort when the echo omits reasoning_effort (ignored override)", () => {
    const echo = parseGrokModelChangedEcho({
      sessionId: "s",
      update: { sessionUpdate: "model_changed", model_id: "grok-4.5" },
    });
    expect(echo).toEqual({ modelId: "grok-4.5", reasoningEffort: null });
  });

  it("returns null for non-model_changed payloads", () => {
    expect(parseGrokModelChangedEcho({ sessionId: "s", update: { sessionUpdate: "turn_completed" } })).toBeNull();
    expect(parseGrokModelChangedEcho(null)).toBeNull();
    expect(parseGrokModelChangedEcho({ sessionId: "s", update: { sessionUpdate: "model_changed" } })).toEqual({
      modelId: null,
      reasoningEffort: null,
    });
  });
});

describe("parseGrokModelState", () => {
  it("parses availableModels and marks the current model as default", () => {
    const parsed = parseGrokModelState({
      protocolVersion: 1,
      _meta: {
        defaultAuthMethodId: "cached_token",
        agentVersion: "0.2.117",
        modelState: {
          currentModelId: "grok-4",
          availableModels: [
            {
              modelId: "grok-4",
              name: "Grok 4",
              description: "flagship",
              _meta: {
                supportsReasoningEffort: true,
                reasoningEffort: "medium",
                reasoningEfforts: ["low", "medium", "high"],
              },
            },
            { modelId: "grok-3-mini", name: "Grok 3 Mini", description: "" },
          ],
        },
      },
    });
    expect(parsed.defaultModelId).toBe("grok-4");
    expect(parsed.models).toEqual([
      { id: "grok-4", label: "Grok 4", isDefault: true, hint: "default" },
      { id: "grok-3-mini", label: "Grok 3 Mini" },
    ]);
  });

  it("degrades to an empty catalog when modelState is absent or malformed", () => {
    expect(parseGrokModelState({})).toEqual({ models: [], defaultModelId: null });
    expect(parseGrokModelState(null)).toEqual({ models: [], defaultModelId: null });
    expect(parseGrokModelState({ _meta: { modelState: { availableModels: [{ name: "no id" }] } } })).toEqual({
      models: [],
      defaultModelId: null,
    });
  });
});
