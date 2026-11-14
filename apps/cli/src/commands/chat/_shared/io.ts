import { readFile, stat } from "node:fs/promises";
import { fail } from "../../../cli/output.js";
import { channelConfig } from "../../../core/channel.js";
import { print } from "../../../core/output.js";
import { MAX_STDIN_BYTES, readStdin } from "../../_shared/stdin.js";

// Stdin buffering moved to `commands/_shared/stdin.ts` when `agent config
// set-env` started reading secrets from a pipe (SEC-052). Re-exported so the
// chat commands and their tests keep importing it from here.
export { MAX_STDIN_BYTES, readStdin } from "../../_shared/stdin.js";

/**
 * Resolve an outbound body from a `--message-file <path>` spec. `-` reads
 * stdin (the clig.dev convention); any other value is a filesystem path read
 * verbatim. Routing the body through a file or stdin — never an inline shell
 * argument — is the one robust fix for shell mangling: backticks (command
 * substitution), double quotes (early argument termination), apostrophes, and
 * newlines all reach the server byte-for-byte because the shell never
 * word-parses the file's contents. Unlike an inline body, a file body is NOT
 * run through `looksLikeEscapedNewlineBody`: a file can legitimately contain a
 * literal `\n`, and its real newlines already survive intact. Returns null
 * only when `-` is given but stdin is a TTY (nothing piped); the caller
 * surfaces its own "no body" error.
 */
export async function readMessageBody(spec: string): Promise<string | null> {
  if (spec === "-") return readStdin();

  // Each fs call maps its own rejection to a clean `fail()` (exit 2) via
  // `.catch`. fail() calls process.exit, so the `.catch` arms below never let a
  // raw fs error escape to `handleSdkError` (which would mislabel it
  // UNKNOWN_ERROR, exit 1). stat() fast-fails missing/non-file/oversize BEFORE
  // reading; readFile() still has its own arm because the file can become
  // unreadable or vanish between stat and read (EACCES, TOCTOU race).
  const info = await stat(spec).catch(() => null);
  if (info === null) {
    return fail("MESSAGE_FILE_NOT_FOUND", `--message-file path does not exist or is not readable: ${spec}`, 2);
  }
  if (!info.isFile()) {
    return fail("MESSAGE_FILE_NOT_FILE", `--message-file is not a regular file: ${spec}`, 2);
  }
  if (info.size > MAX_STDIN_BYTES) {
    return fail("MESSAGE_FILE_TOO_LARGE", `--message-file exceeds the ${MAX_STDIN_BYTES}-byte limit: ${spec}`, 2);
  }
  const buf = await readFile(spec).catch((err: unknown) => {
    const detail = err instanceof Error ? err.message : String(err);
    return fail("MESSAGE_FILE_UNREADABLE", `--message-file could not be read: ${detail}`, 2);
  });
  return buf.toString("utf-8");
}

/**
 * Detect an inline message body whose newlines arrived as the two-character
 * escape sequence `\n` instead of real newlines. POSIX shells do not expand
 * `\n` inside single or double quotes, so a one-line
 * `chat send <name> "line1\n\n**line2**"` stores a literal backslash-n body
 * that the web UI renders as one long unformatted line — the markdown
 * structure never starts at a line beginning. Models that compose one-line
 * shell commands hit this shape often (and self-imitate it for the rest of
 * the session), so `chat send` rejects it with a how-to-fix hint instead of
 * persisting a broken row.
 *
 * Deliberately narrow, to keep prose that *mentions* the token sendable:
 * - at least two escaped `\n` occurrences (a multi-line intent), and
 * - zero real newlines (any real newline proves the formatting arrived
 *   intact — e.g. ANSI-C `$'...\n...'` quoting expands before we see it).
 * Bodies piped via stdin are never checked: stdin/heredoc is both the fix
 * and the escape hatch for intentionally sending literal `\n` text.
 */
export function looksLikeEscapedNewlineBody(body: string): boolean {
  if (body.includes("\n")) return false;
  const escapes = body.match(/\\n/g);
  return (escapes?.length ?? 0) >= 2;
}

/**
 * Detect an inline body that is the residue of a collapsed heredoc — the value
 * the shell actually handed the CLI is a bare heredoc delimiter (the reported
 * `@EOF` screenshot) rather than the intended markdown. The shell mangled the
 * body before the CLI ran, so this is the one inline malformation that survives
 * as a recognisable shape we can fail loudly on.
 *
 * Deliberately whole-body and narrow, to keep prose that merely *mentions* a
 * delimiter sendable:
 * - the ENTIRE trimmed body is a lone, optionally `@`-prefixed common heredoc
 *   terminator (`@EOF`, `EOF`, `EOT`, `HEREDOC`), or
 * - the ENTIRE trimmed body is a lone heredoc *opener* line that leaked
 *   verbatim (`<<EOF`, `<<-'END'`).
 * A larger message that contains `<<EOF` / `@EOF` as one token among others is
 * left alone — and any such rich body should go through `-F`/stdin, which is
 * never checked.
 */
export function looksLikeHeredocResidueBody(body: string): boolean {
  const trimmed = body.trim();
  if (trimmed.length === 0) return false;
  if (/^@?(?:EOF|EOT|HEREDOC)$/i.test(trimmed)) return true;
  if (/^<<-?\s*['"]?[A-Za-z_]\w*['"]?$/.test(trimmed)) return true;
  return false;
}

/**
 * Detect an inline body that was `JSON.stringify`-wrapped (Issue #389): the
 * shell passed a value wrapped in outer double quotes whose newlines are the
 * two-character `\n` escape — e.g. `"@x line1\nline2"`. The UI renders the
 * literal quotes and `\n` tokens instead of markdown.
 *
 * `looksLikeEscapedNewlineBody` already rejects the ≥2-escape shape; this
 * catches the single-escape wrapper it misses. Whole-body and inline-only: a
 * body that legitimately quotes a phrase but carries no `\n` escape is left
 * alone (and a rich body belongs on `-F`/stdin, which is never checked).
 */
export function looksLikeJsonWrappedBody(body: string): boolean {
  const trimmed = body.trim();
  if (trimmed.length < 4) return false;
  if (!(trimmed.startsWith('"') && trimmed.endsWith('"'))) return false;
  if (trimmed.includes("\n")) return false;
  return /\\n/.test(trimmed);
}

/**
 * Guard an inline `chat send` / `chat ask` body against the two shell-residue
 * shapes the CLI can still recognise after the shell has already mangled the
 * argument: a collapsed-heredoc delimiter (`@EOF`) and a `JSON.stringify`
 * wrapper. Mirrors {@link guardInlineDescription} — prints a copyable retry to
 * stderr, then `fail()`s (exit 2). Only ever called for an inline `[message]`;
 * `-F`/stdin bodies reach the server verbatim and are never checked.
 */
export function guardInlineShellResidue(body: string, opts: { command: "send" | "ask" }): void {
  const bin = channelConfig.binName;
  const cmd = `chat ${opts.command}`;
  if (looksLikeHeredocResidueBody(body)) {
    print.line(
      `${cmd}: the message body is a bare heredoc delimiter (\`${body.trim()}\`) — a heredoc that collapsed in the ` +
        "shell, so the intended markdown never reached the argument. Send the real body via stdin or a file:\n\n" +
        `  cat <<'EOF' | ${bin} ${cmd} <name> -f markdown\n` +
        "  your real message\n" +
        "  EOF\n\n" +
        `(or: ${bin} ${cmd} <name> -f markdown -F <file>)\n\n`,
    );
    fail(
      "HEREDOC_RESIDUE",
      `Inline message body is a bare heredoc delimiter (\`${body.trim()}\`) — the heredoc collapsed before the CLI ` +
        "ran, so the intended body was lost. Resend the real body via stdin/heredoc or --message-file (copyable " +
        "form printed above).",
      2,
    );
  }
  if (looksLikeJsonWrappedBody(body)) {
    print.line(
      `${cmd}: the message body looks JSON-stringified — wrapped in outer quotes with \\n escapes — so the UI would ` +
        "render literal quotes and `\\n` text instead of markdown. Pass the raw string via stdin or a file:\n\n" +
        `  cat <<'EOF' | ${bin} ${cmd} <name> -f markdown\n` +
        "  first line\n" +
        "\n" +
        "  **second** line\n" +
        "  EOF\n\n",
    );
    fail(
      "JSON_WRAPPED_BODY",
      "Inline message body looks JSON-stringified (outer quotes + \\n escapes) — pass the raw markdown string via " +
        "stdin/heredoc or --message-file instead (copyable form printed above).",
      2,
    );
  }
}

/**
 * Guard an inline `--description` (chat update / create) exactly the way
 * `chat send` guards a message body. A chat description is authored markdown,
 * surfaced verbatim in the chat sidebar and in every agent's prompt. When its
 * newlines arrive as literal `\n` escapes — a one-line
 * `chat update --description "line1\n\nline2"` whose shell quotes never expand
 * `\n` — the stored value differs from the intended markdown structure and
 * renders as one long line with visible `\n` tokens. The correction belongs
 * before the write, not in UI rendering, so reject the malformed value here
 * with a copyable fix instead of persisting it.
 *
 * `supportsStdin` selects the escape hatch the hint offers: `chat update` has
 * no message body, so it can take the description from stdin via
 * `--description -`; `chat create` already consumes stdin for its initial
 * message, so it points to ANSI-C `$'...\n...'` quoting instead. Detection is
 * shared with the send-body guard (`looksLikeEscapedNewlineBody`): narrow by
 * design, so prose that merely mentions `\n` once stays writable.
 */
export function guardInlineDescription(value: string, opts: { supportsStdin: boolean }): void {
  if (!looksLikeEscapedNewlineBody(value)) return;
  const bin = channelConfig.binName;
  // The copyable retry form goes through `print.line` — plain multi-line
  // stderr text (silenced in --json mode). The fail envelope below stays a
  // single-line JSON object per the Print-layer contract; embedding the
  // heredoc example there would itself arrive `\n`-escaped, the exact bug.
  if (opts.supportsStdin) {
    print.line(
      "chat update: --description arrived with literal \\n escapes — shell quotes do not expand \\n, " +
        "so it would render as one long unformatted line in the chat sidebar. Resend with real newlines " +
        "via stdin:\n\n" +
        `  cat <<'EOF' | ${bin} chat update --description -\n` +
        "  first line\n" +
        "\n" +
        "  **second** line\n" +
        "  EOF\n\n" +
        "(or pass an ANSI-C quoted string: --description $'first line\\n\\n**second** line'. " +
        "stdin is not checked — pipe the body if literal \\n text is intentional.)\n\n",
    );
  } else {
    print.line(
      "chat create: --description arrived with literal \\n escapes — shell quotes do not expand \\n, " +
        "so it would render as one long unformatted line in the chat sidebar. Pass real newlines via an " +
        "ANSI-C quoted string instead:\n\n" +
        "  --description $'first line\\n\\n**second** line'\n\n",
    );
  }
  fail(
    "ESCAPED_NEWLINES",
    'Inline --description contains literal "\\n" escapes and no real newlines — it would render as one ' +
      "long unformatted line in the chat sidebar. " +
      (opts.supportsStdin
        ? "Resend the description via stdin (`--description -`) with real newlines, or use an ANSI-C $'...' " +
          "string (copyable forms printed above)."
        : "Use an ANSI-C $'...\\n...' string with real newlines (copyable form printed above)."),
    2,
  );
}

export function parseLimit(value: string, max: number): number {
  const limit = Number.parseInt(value, 10);
  if (Number.isNaN(limit) || limit < 1 || limit > max) {
    fail("INVALID_LIMIT", `Limit must be between 1 and ${max}.`, 2);
  }
  return limit;
}
