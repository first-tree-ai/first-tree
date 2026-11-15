import { readFileSync } from "node:fs";
import { join } from "node:path";
import { defaultConfigDir } from "@first-tree/shared/config";
import { channelConfig } from "./channel.js";

/**
 * Origin binding for the persisted credential (SEC-023).
 *
 * `credentials.json` records the server the token was issued for, but every
 * command resolves its target URL independently (`--server`,
 * `FIRST_TREE_SERVER_URL`, config). Nothing compared the two, so pointing the
 * CLI at another origin sent the token minted for production to it.
 */

/**
 * Scheme + host + port, normalised by `URL` (lowercased host, default port
 * dropped), or `null` when the value is not an absolute URL.
 */
export function canonicalOrigin(value: string): string | null {
  try {
    const url = new URL(value);
    return url.origin === "null" ? null : url.origin;
  } catch {
    return null;
  }
}

/** Stored credential, read once per check: `accessToken`/`refreshToken` + origin. */
function readStoredCredential(): { tokens: readonly string[]; origin: string | null } | null {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(join(defaultConfigDir(), "credentials.json"), "utf-8"));
  } catch {
    // Missing or unreadable credentials: nothing to bind. Callers surface the
    // usual "run login" error.
    return null;
  }
  if (!raw || typeof raw !== "object") return null;
  const record = raw as { accessToken?: unknown; refreshToken?: unknown; serverUrl?: unknown };
  const tokens = [record.accessToken, record.refreshToken].filter(
    (token): token is string => typeof token === "string" && token.length > 0,
  );
  const origin = typeof record.serverUrl === "string" ? canonicalOrigin(record.serverUrl) : null;
  return { tokens, origin };
}

export class CredentialOriginMismatchError extends Error {
  constructor(
    readonly credentialOrigin: string,
    readonly requestOrigin: string,
  ) {
    super(
      `Refusing to send saved credentials to ${requestOrigin}: they were issued for ${credentialOrigin}.\n` +
        `  If ${requestOrigin} is the server you meant to use, sign in to it (this replaces the saved credential):\n` +
        `    ${channelConfig.binName} logout && ${channelConfig.binName} login <code from ${requestOrigin}>\n` +
        `  Otherwise drop the override (--server / FIRST_TREE_SERVER_URL) so this command uses ${credentialOrigin}.`,
    );
    this.name = "CredentialOriginMismatchError";
  }
}

/**
 * Fail closed before a stored token leaves the process for another origin.
 *
 * Only a token that matches the credential store is checked, so a caller that is
 * deliberately sending something else (a one-shot login code, a freshly
 * exchanged token that is not persisted yet) is unaffected.
 */
export function assertCredentialOriginForToken(requestUrl: string, token: string): void {
  const stored = readStoredCredential();
  if (!stored || stored.origin === null || !stored.tokens.includes(token)) return;
  const requestOrigin = canonicalOrigin(requestUrl);
  if (requestOrigin === null || requestOrigin === stored.origin) return;
  throw new CredentialOriginMismatchError(stored.origin, requestOrigin);
}
