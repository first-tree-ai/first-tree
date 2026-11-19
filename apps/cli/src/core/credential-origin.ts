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
 *
 * There are exactly two ways to answer "which origin issued this token?", and
 * they are kept apart on purpose:
 *
 * - **the pair** (`BoundCredential`): the origin is attached when the token is
 *   loaded or minted, and travels with the value into the request. This is the
 *   guarantee — it does not consult `credentials.json` again, so a refresh or a
 *   re-login in another terminal cannot retroactively change what a credential
 *   in hand is bound to.
 * - **file-derived** (`assertStoredCredentialOriginForToken`): a caller that
 *   only has a string (header inspection) can check it against the store. A
 *   token the store does not contain is *intentionally* let through — that is
 *   the login code / one-shot exchange path — so this check must never be
 *   mistaken for the guarantee above.
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

/**
 * A credential together with the origin that issued it.
 *
 * The pair is created where the token is obtained (`loadCredentials` /
 * `ensureFreshBoundAccessToken`) and carried by the request, so no process-wide
 * table has to remember it — and therefore nothing can evict it while a caller
 * still holds the credential.
 */
export type BoundCredential = {
  readonly token: string;
  /** `null` when the issuing server URL was not absolute; the check then abstains. */
  readonly origin: string | null;
};

/** Attach the issuing origin to a token at the moment it is loaded or minted. */
export function bindCredential(token: string, serverUrl: string): BoundCredential {
  return { token, origin: canonicalOrigin(serverUrl) };
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
 * Fail closed before a bound token leaves the process for another origin.
 *
 * Pure function of the pair: no file read and no process-wide memory, so a
 * caller holding a credential keeps its origin for as long as it holds it. A
 * later load, refresh or re-login cannot weaken it, and there is nothing to
 * evict.
 */
export function assertBoundCredentialOrigin(requestUrl: string, credential: BoundCredential): void {
  const requestOrigin = canonicalOrigin(requestUrl);
  if (requestOrigin === null || credential.origin === null || requestOrigin === credential.origin) return;
  throw new CredentialOriginMismatchError(credential.origin, requestOrigin);
}

/**
 * Fail closed for a token that is only known by its string, using the store as
 * the source of truth for its origin.
 *
 * Used by transports that inspect an `Authorization` header they did not build
 * (see `cliFetch`). A token the store does not contain is let through on
 * purpose: that is the login code / freshly exchanged token path, which is
 * explicit here rather than a silent fallback. Because this check depends on the
 * current file, it is best-effort — callers that can bind at load time use
 * `assertBoundCredentialOrigin` instead.
 */
export function assertStoredCredentialOriginForToken(requestUrl: string, token: string): void {
  const requestOrigin = canonicalOrigin(requestUrl);
  if (requestOrigin === null) return;

  const stored = readStoredCredential();
  if (!stored || stored.origin === null || !stored.tokens.includes(token)) return;
  if (requestOrigin === stored.origin) return;
  throw new CredentialOriginMismatchError(stored.origin, requestOrigin);
}
