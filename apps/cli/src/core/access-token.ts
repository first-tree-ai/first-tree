import { ensureFreshBoundAccessToken } from "./bootstrap.js";
import { assertBoundCredentialOrigin } from "./credential-origin.js";

/**
 * Access token for a specific server, refusing to hand out one that belongs to
 * a different origin (SEC-023).
 *
 * \`cliFetch\` guards its own requests, but an SDK instance fetches for itself:
 * the call sites that build one know their server URL, so they bind the token
 * here instead. The check is a pure function of the credential pair, so the
 * origin cannot be lost by a later load, refresh or re-login (SEC-023).
 */
export async function accessTokenForOrigin(
  serverUrl: string,
  options?: Parameters<typeof ensureFreshBoundAccessToken>[0],
): Promise<string> {
  const credential = await ensureFreshBoundAccessToken(options);
  assertBoundCredentialOrigin(serverUrl, credential);
  return credential.token;
}
