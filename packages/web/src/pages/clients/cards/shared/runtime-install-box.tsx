import type { CapabilityEntry, RuntimeProvider } from "@first-tree/shared";
import { runtimeProviderShowsHostLoginOnSetup } from "@first-tree/shared";
import type { ReactNode } from "react";
import { InlineCommand } from "./inline-command.js";
import {
  buildInstallCommand,
  PROVIDER_LABEL,
  PROVIDER_LOGIN_COMMAND,
  providerInstallCommand,
  zcodeLoginCommand,
} from "./providers.js";

type RuntimeInstallBoxProps = {
  provider: RuntimeProvider;
  /**
   * Current capability state for this provider, or null if the client
   * has never reported any. Drives the command + headline:
   *   - null / missing → "install + login" two-liner
   *   - error → "reinstall — last probe error: ..." + install command
   *   - ok → no install box rendered (caller suppresses)
   */
  entry: CapabilityEntry | null;
  /** Computer hostname for the diagnostic copy. */
  hostname: string;
  /** Host OS (`darwin` / `linux` / `win32`) — keys the tmux install command. */
  os?: string | null;
  /** Connected Computer's channel-aware CLI binary name (for ZCode's `zcode login` driver). */
  binName?: string | null;
};

/**
 * One install-box per runtime on a Setup-incomplete card.
 *
 * Mockup §"Variant B-2" shows two boxes side-by-side (Claude Code +
 * Codex). The box's job is to give the operator one copy-pasteable
 * command and the smallest possible operator-side narration. Distinct
 * from the `ProviderRow` chips in the Ready card's CapabilityMatrix —
 * that's a state-only summary line; this is an actionable surface.
 */
export function RuntimeInstallBox({ provider, entry, hostname, os, binName }: RuntimeInstallBoxProps) {
  const label = PROVIDER_LABEL[provider];
  const { headline, command } = installBoxView(entry, provider, hostname, os, binName);

  // No outer raised-bg / border / radius — the inner `InlineCommand`'s
  // sunken pre-block is the only chrome that earns its weight (commands
  // are a single visual unit the operator scans + copies). Wrapping
  // again would nest a box inside a box inside the page, which fights
  // the Settings tab's "flat hairline-only" vocabulary.
  //
  // Boxes have equal *outer* height via the parent CSS Grid
  // (`align-items: stretch` is the default). Inside, content flows
  // naturally from the top — label, headline, command. A shorter
  // headline simply leaves whitespace at the bottom of its box. No
  // forced bottom-align of the command block: when two boxes have
  // unequal headline heights, baseline-aligning the Copy buttons
  // makes the headlines themselves visually misaligned, which is the
  // worse trade.
  return (
    <div className="flex flex-col" style={{ gap: "var(--sp-1_5)" }}>
      <div className="text-body font-medium" style={{ color: "var(--fg)" }}>
        {label}
      </div>
      <p className="text-caption" style={{ margin: 0, color: "var(--fg-3)" }}>
        {renderHeadlineWithCode(headline)}
      </p>
      {command !== null && <InlineCommand command={command} ariaLabel={`${label} setup command`} />}
    </div>
  );
}

/**
 * Render a headline string with `inline-code` segments wrapped in `<code>`.
 * The view-model emits literal backticks (e.g. "Run `claude auth login` on
 * host") for the diagnostic copy; without this helper the user sees raw
 * backticks rendered as text.
 */
function renderHeadlineWithCode(text: string): ReactNode {
  const parts = text.split(/`([^`]+)`/);
  return parts.map((part, idx) =>
    idx % 2 === 1 ? (
      // biome-ignore lint/suspicious/noArrayIndexKey: text is static; index identifies the segment.
      <code key={idx} className="mono text-label" style={{ color: "var(--fg-2)" }}>
        {part}
      </code>
    ) : (
      // biome-ignore lint/suspicious/noArrayIndexKey: text is static; index identifies the segment.
      <span key={idx}>{part}</span>
    ),
  );
}

/**
 * Pure helper — returns `{headline, command}` for a given capability
 * entry. Extracted for testability so the install-box's per-state
 * branching is unit-tested without DOM. `command` is null when the
 * platform makes installation impossible (grok on Windows): the caller
 * renders the status headline only, never an install command.
 */
export function installBoxView(
  entry: CapabilityEntry | null,
  provider: RuntimeProvider,
  hostname: string,
  os?: string | null,
  binName?: string | null,
): { headline: string; command: string | null } {
  // Grok Build is macOS/Linux-only in V1. The probe reports this as state
  // `error` on win32; rendering the generic probe-error branch would print
  // the official install command in a loop for a runtime First Tree does
  // not support on this platform. Fail closed with a status instead.
  if (provider === "grok" && (os === "win32" || os === "windows")) {
    return {
      headline: `${PROVIDER_LABEL[provider]} is not supported on Windows in V1 (macOS/Linux only). Nothing to install on ${hostname}.`,
      command: null,
    };
  }
  if (!entry || entry.state === "missing") {
    // `claude-code-tui` needs the `claude` CLI AND tmux (>= 3.0); name the tmux
    // requirement explicitly so the box isn't read as a CLI-only install (the
    // command from `buildInstallCommand` carries the matching OS tmux line).
    // In-product OAuth providers stay install-only on computer/setup surfaces;
    // host-local providers may include their login cue.
    const label = PROVIDER_LABEL[provider];
    let headline: string;
    if (provider === "claude-code-tui") {
      headline = `Install ${label} (the \`claude\` CLI + tmux >= 3.0) on ${hostname}.`;
    } else if (provider === "zcode") {
      headline = `Install ${label} and run \`${zcodeLoginCommand(binName)}\` on ${hostname}.`;
    } else if (runtimeProviderShowsHostLoginOnSetup(provider)) {
      headline = `Install ${label} and run \`${PROVIDER_LOGIN_COMMAND[provider]}\` on ${hostname}.`;
    } else {
      headline = `Install ${label} on ${hostname}.`;
    }
    return { headline, command: buildInstallCommand(provider, os, binName) };
  }
  if (entry.state === "error") {
    return {
      headline: `${PROVIDER_LABEL[provider]} probe failed: ${entry.error ?? "unknown error"}. Reinstall on ${hostname}:`,
      command: providerInstallCommand(provider),
    };
  }
  // `ok` should not reach here — the Setup-incomplete card filters such
  // entries out. Provide a defensive fallback that's still actionable.
  return {
    headline: `${PROVIDER_LABEL[provider]} is configured. To reinstall, run on ${hostname}:`,
    command: buildInstallCommand(provider, os, binName),
  };
}
