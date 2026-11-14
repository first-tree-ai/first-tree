import { z } from "zod";

/**
 * Hosts that may legitimately serve the portable installer over plain HTTP.
 *
 * The installer is piped straight into a shell, so a plaintext URL means anyone
 * on the path can replace the code that runs (SEC-025). Loopback stays allowed
 * because local testing and single-machine self-hosting never cross a network.
 */
const LOOPBACK_HOSTNAMES = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

/**
 * True when a download/installer URL is safe to hand to an operator as a
 * `curl … | sh` command: https anywhere, http only on loopback.
 */
export function isTrustedInstallerUrl(value: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return false;
  }
  if (parsed.protocol === "https:") return true;
  if (parsed.protocol !== "http:") return false;
  return LOOPBACK_HOSTNAMES.has(parsed.hostname);
}

export const installerUrlMessage =
  "must use https:// (plain http is only accepted for loopback hosts such as http://127.0.0.1)";

/**
 * Wire/response shape for a bootstrap installer URL. The server also enforces
 * this on its own download base URL, so a client never has to render a
 * plaintext `curl | sh` command; the refinement here keeps older or mirrored
 * deployments from slipping one through anyway.
 */
export const trustedInstallerUrlSchema = z.string().url().refine(isTrustedInstallerUrl, {
  message: installerUrlMessage,
});
