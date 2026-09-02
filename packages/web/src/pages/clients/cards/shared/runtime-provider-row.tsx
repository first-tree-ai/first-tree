import type { CapabilityEntry, RuntimeProvider } from "@first-tree/shared";
import { RuntimeInstallBox } from "./runtime-install-box.js";
import { RuntimeStateLine } from "./runtime-state-line.js";

/**
 * One provider's row in a card's vertical Runtimes list. Detection is
 * install-only, so a row carries no in-product "Connect"/login affordance —
 * auth moves to an in-chat entry point. The row renders either the state line
 * or the install box.
 *
 * Per state:
 *   - missing / error / never-reported, when `showInstallBox` → the
 *     copy-pasteable install box ONLY (its own labelled header replaces the
 *     status line, which would just repeat the same install instruction).
 *   - ok, or any state without an install box → status line only.
 *
 * `entry` may be null (a provider the daemon never reported) — only meaningful
 * with `showInstallBox`, where it renders the "install + login" box. Ready
 * passes only reported entries.
 */
export function RuntimeProviderRow({
  provider,
  entry,
  os,
  hostname,
  binName,
  showInstallBox = false,
}: {
  provider: RuntimeProvider;
  entry: CapabilityEntry | null;
  os?: string | null;
  /** Host label for the install box copy; only consulted when `showInstallBox`. */
  hostname?: string;
  /** Connected Computer's channel-aware CLI binary name; only consulted when `showInstallBox`. */
  binName?: string | null;
  showInstallBox?: boolean;
}) {
  const needsInstall = showInstallBox && (entry == null || entry.state === "missing" || entry.state === "error");
  return (
    <div className="flex flex-col" style={{ gap: "var(--sp-1_5)" }}>
      {entry != null && !needsInstall && <RuntimeStateLine provider={provider} entry={entry} os={os} />}
      {needsInstall && hostname != null && (
        <RuntimeInstallBox provider={provider} entry={entry} hostname={hostname} os={os} binName={binName} />
      )}
    </div>
  );
}
