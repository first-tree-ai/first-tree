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
 * curl flags that make the installer download obey the same transport policy.
 *
 * `-fsSL` follows redirects by default, so an https URL can still land on a
 * plaintext one. `--proto` pins the scheme of the requested URL and
 * `--proto-redir` pins every redirect hop: https starts may only stay on https,
 * while a loopback http start (local development) may still upgrade to https.
 */
export function curlInstallerProtocolFlags(installerUrl: string): string {
  const isHttps = installerUrl.startsWith("https:");
  return isHttps ? "--proto '=https' --proto-redir '=https'" : "--proto '=http,https' --proto-redir '=http,https'";
}

/**
 * Wire/response shape for a bootstrap installer URL. The server also enforces
 * this on its own download base URL, so a client never has to render a
 * plaintext `curl | sh` command; the refinement here keeps older or mirrored
 * deployments from slipping one through anyway.
 */
export const trustedInstallerUrlSchema = z.string().url().refine(isTrustedInstallerUrl, {
  message: installerUrlMessage,
});
