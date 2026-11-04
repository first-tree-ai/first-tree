import { describe, expect, it } from "vitest";
import { cursorResumeStuckRecoveryMessage, isCursorResumeStuckError } from "../resume-stuck.js";

const STUCK =
  "RetriableError: Agent turn stopped after repeated resume attempts made no progress\nError: command failed unexpectedly.";

describe("isCursorResumeStuckError", () => {
  it("matches the Cursor CLI resume-exhausted phrasing", () => {
    expect(isCursorResumeStuckError(STUCK)).toBe(true);
    expect(isCursorResumeStuckError(new Error(STUCK))).toBe(true);
    expect(isCursorResumeStuckError({ message: STUCK })).toBe(true);
    expect(isCursorResumeStuckError("Repeated Resume Attempts Made No Progress")).toBe(true);
  });

  it("does not match generic command failures or other providers' resume errors", () => {
    expect(isCursorResumeStuckError("Error: command failed unexpectedly.")).toBe(false);
    expect(isCursorResumeStuckError("thread/resume failed: no rollout found for thread id abc")).toBe(false);
  });
});

describe("cursorResumeStuckRecoveryMessage", () => {
  it("names the stale session and optional replacement", () => {
    expect(cursorResumeStuckRecoveryMessage(null)).toBe(
      "cursor resume made no progress; starting a fresh Cursor session",
    );
    expect(cursorResumeStuckRecoveryMessage("sess-old", "sess-new")).toBe(
      "cursor resume made no progress for session sess-old; starting a fresh Cursor session; replacement session sess-new",
    );
  });
});
