/**
 * Text that arrives from the server (message bodies, agent display names) is
 * written to a human's terminal by the interactive surfaces. Terminals interpret
 * C0/C1 control bytes: ANSI colors, cursor movement, window-title OSC, clipboard
 * OSC 52, BEL. A chat participant can therefore forge or erase what the operator
 * sees, and clipboard-capable terminals will happily act on it (SEC-050).
 *
 * We strip the control bytes rather than trying to consume whole sequences: the
 * visible remnant (`[31m`, `]0;title`) is obviously not ours, keeps the message
 * readable, and cannot be mistaken for the CLI's own styling.
 *
 * Newline and tab survive (multi-line messages stay readable). CR is normalised
 * away, because a bare CR returns the cursor to column 0 and lets the sender
 * overwrite the line that was already printed.
 *
 * Structured (`--json`) output must NOT use this: machine consumers need the
 * exact bytes.
 */
// biome-ignore lint/suspicious/noControlCharactersInRegex: stripping control bytes is the whole point
const UNSAFE_TERMINAL_BYTES = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/gu;

export function sanitizeTerminalText(text: string): string {
  return text.replace(/\r\n?/gu, "\n").replace(UNSAFE_TERMINAL_BYTES, "");
}
