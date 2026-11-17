import { ensureFreshBoundAccessToken } from "./bootstrap.js";
import { assertBoundCredentialOrigin, type BoundCredential } from "./credential-origin.js";

/**
 * Credential pair for a destination the caller already knows (SEC-023).
 *
 * A command that issues several requests to one server binds once and carries
 * the pair: the origin travels with the value, so a refresh or a re-login in
 * another terminal between two of those requests cannot silently retarget the
 * token. Callers that only need the header value use `accessTokenForOrigin`;
 * one-shot exchanges (login codes) keep their own path and are deliberately not
 * covered by this check.
 */
export async function credentialForOrigin(
  serverUrl: string,
  options?: Parameters<typeof ensureFreshBoundAccessToken>[0],
): Promise<BoundCredential> {
  const credential = await ensureFreshBoundAccessToken(options);
  assertBoundCredentialOrigin(serverUrl, credential);
  return credential;
}

/**
 * Access token for a specific server, refusing to hand out one that belongs to
 * a different origin (SEC-023).
 *
 * `cliFetch` guards its own requests, but an SDK instance fetches for itself:
 * the call sites that build one know their server URL, so they bind the token
 * here instead. The check is a pure function of the credential pair, so the
 * origin cannot be lost by a later load, refresh or re-login (SEC-023).
 */
export async function accessTokenForOrigin(
  serverUrl: string,
  options?: Parameters<typeof ensureFreshBoundAccessToken>[0],
): Promise<string> {
  return (await credentialForOrigin(serverUrl, options)).token;
}
