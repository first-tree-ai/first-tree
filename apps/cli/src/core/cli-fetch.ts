import { assertStoredCredentialOriginForToken } from "./credential-origin.js";
import { CLI_USER_AGENT } from "./version.js";

/**
 * Drop-in `fetch` wrapper that stamps `User-Agent: first-tree-cli/<version> (<platform> <arch>)`
 * on every request.
 *
 * Issue #246: every CLI-originated HTTP request must carry a stable
 * `User-Agent` so trace backends can group failures (401 / 429 / 5xx) by
 * install. Plain `globalThis.fetch` defaults to `User-Agent: node`, which
 * collapses every install into a single bucket. Centralising the header
 * here means new direct-fetch sites pick the right UA up automatically —
 * no need to remember at each call site.
 *
 * SDK-routed requests stamp UA via {@link FirstTreeHubSDK} (see
 * `packages/client/src/cloud/sdk.ts`). This helper is for the
 * direct-`fetch` paths the SDK doesn't cover (auth bootstrap,
 * doctor probes, raw admin calls).
 *
 * Header precedence: caller-provided `User-Agent` in `init.headers` wins,
 * so callers can override (e.g. tests injecting a deterministic UA).
 */
export async function cliFetch(input: string | URL, init?: RequestInit): Promise<Response> {
  const merged = mergeHeaders(init?.headers as HeadersInput | undefined);
  // SEC-023: the target URL and the persisted credential are resolved
  // separately, so an override (`--server`, `FIRST_TREE_SERVER_URL`, config)
  // used to ship the token saved for another origin. This is the *file-derived*
  // check: it can only classify a token the store still contains, and a token
  // it does not know (a login code, a one-shot exchange token) is passed
  // through by design. Callers that hold the credential itself bind it with
  // `accessTokenForOrigin`, which carries the issuing origin with the value and
  // does not depend on the file or on any process-wide memory.
  const token = bearerToken(merged);
  if (token) assertStoredCredentialOriginForToken(String(input), token);
  return fetch(input, { ...init, headers: merged });
}

/** `Bearer <token>` from an Authorization header, if the caller set one. */
function bearerToken(headers: Record<string, string>): string | null {
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() !== "authorization") continue;
    const match = /^\s*Bearer\s+(\S+)\s*$/iu.exec(value);
    if (match?.[1]) return match[1];
  }
  return null;
}

type HeadersInput = Headers | Record<string, string> | [string, string][];

function mergeHeaders(provided: HeadersInput | undefined): Record<string, string> {
  // Headers can arrive as Headers, plain object, or [k,v][]. Normalise to a
  // plain object so we can detect "caller already set User-Agent" without
  // mutating the caller's reference.
  const out: Record<string, string> = {};
  if (provided) {
    if (provided instanceof Headers) {
      provided.forEach((v, k) => {
        out[k] = v;
      });
    } else if (Array.isArray(provided)) {
      for (const [k, v] of provided) out[k] = v;
    } else {
      Object.assign(out, provided as Record<string, string>);
    }
  }
  const hasUA = Object.keys(out).some((k) => k.toLowerCase() === "user-agent");
  if (!hasUA) out["User-Agent"] = CLI_USER_AGENT;
  return out;
}
