import { ensureFreshAccessToken } from "./bootstrap.js";
import { assertCredentialOriginForToken } from "./credential-origin.js";

/**
 * Access token for a specific server, refusing to hand out one that belongs to
 * a different origin (SEC-023).
 *
 * \`cliFetch\` guards its own requests, but an SDK instance fetches for itself:
 * the six call sites that build one know their server URL, so they bind the
 * token here instead. Anything that only calls \`ensureFreshAccessToken()\` keeps
 * the old behaviour and is guarded at the transport instead.
 */
export async function accessTokenForOrigin(
  serverUrl: string,
  options?: Parameters<typeof ensureFreshAccessToken>[0],
): Promise<string> {
  const token = await ensureFreshAccessToken(options);
  assertCredentialOriginForToken(serverUrl, token);
  return token;
}
