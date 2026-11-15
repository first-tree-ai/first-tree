import { describe, expect, it } from "vitest";
import { sanitizeTerminalText } from "../core/terminal-safety.js";

/**
 * SEC-050 (#1654): interactive surfaces print server-provided text straight to a
 * terminal, so control bytes from a chat participant can forge output, rewrite
 * the line, set the window title, or reach clipboard-capable terminals.
 */
describe("sanitizeTerminalText", () => {
  it("strips ANSI colour and cursor sequences but keeps the visible remnant", () => {
    expect(sanitizeTerminalText("\u001b[31mred\u001b[0m")).toBe("[31mred[0m");
    expect(sanitizeTerminalText("\u001b[2J\u001b[H wiped")).toBe("[2J[H wiped");
  });

  it("strips OSC title and clipboard writes", () => {
    // OSC 0 (title) and OSC 52 (clipboard) are the two that escape the screen.
    expect(sanitizeTerminalText("\u001b]0;pwned\u0007title")).toBe("]0;pwnedtitle");
    expect(sanitizeTerminalText("\u001b]52;c;base64data\u0007")).toBe("]52;c;base64data");
  });

  it("drops a bare carriage return so a sender cannot overwrite the printed line", () => {
    expect(sanitizeTerminalText("safe\rFORGED")).toBe("safe\nFORGED");
    expect(sanitizeTerminalText("safe\r\nFORGED")).toBe("safe\nFORGED");
  });

  it("keeps newlines, tabs, and ordinary unicode", () => {
    expect(sanitizeTerminalText("line one\nline two\ttabbed")).toBe("line one\nline two\ttabbed");
    expect(sanitizeTerminalText("中文 emoji 🚀 — ok")).toBe("中文 emoji 🚀 — ok");
  });

  it("strips C1 controls and DEL", () => {
    expect(sanitizeTerminalText("a\u009bb\u007fc")).toBe("abc");
  });

  it("leaves an already-clean message untouched", () => {
    const clean = "Build finished: 42 tests passed.";
    expect(sanitizeTerminalText(clean)).toBe(clean);
  });
});
