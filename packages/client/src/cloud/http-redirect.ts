import { AGENT_RUNTIME_SESSION_HEADER, AGENT_SELECTOR_HEADER } from "@first-tree/shared";

/**
 * Credentialed redirect following for the Cloud SDK (SEC-058).
 *
 * Node's `fetch` drops the standard `Authorization` header on a cross-origin
 * redirect, but keeps **custom** headers — and the SDK puts real authority in
 * two of them (`x-agent-id`, `x-agent-runtime-session`). Following a redirect
 * to another origin therefore handed a runtime-session token to that origin.
 *
 * `redirect: "manual"` makes the hop visible, so a cross-origin `Location` can
 * be refused instead of silently obeyed. Same-origin redirects still work.
 */

/** Hops followed before giving up; an API redirect chain longer than this is a bug. */
const MAX_REDIRECTS = 3;

const REDIRECT_STATUSES: ReadonlySet<number> = new Set([301, 302, 303, 307, 308]);

/** Headers that carry First Tree authority; named in the refusal message. */
const SENSITIVE_HEADERS = ["authorization", AGENT_SELECTOR_HEADER, AGENT_RUNTIME_SESSION_HEADER] as const;

/** Which First Tree credential headers the caller actually set. */
function credentialHeaders(init: RequestInit): string[] {
  const headers = new Headers(init.headers);
  return SENSITIVE_HEADERS.filter((name) => headers.has(name));
}

export class CrossOriginRedirectError extends Error {
  constructor(
    readonly from: string,
    readonly to: string,
    readonly headers: readonly string[],
  ) {
    super(
      `Refusing to follow a redirect from ${from} to ${to}: it would resend First Tree credentials ` +
        `(${headers.join(", ")}) to another origin. Point the client at the final URL instead.`,
    );
    this.name = "CrossOriginRedirectError";
  }
}

/**
 * `fetch` that follows same-origin redirects only.
 *
 * A caller that already passes `redirect: "manual"` handles redirects itself
 * (the context-tree write path treats a 3xx as a hard error so a PUT is never
 * replayed to a new location); that call is passed through untouched. No caller
 * can opt back into Node's automatic cross-origin following, because that is
 * exactly the leak this wrapper exists to prevent.
 */
export async function fetchSameOrigin(input: string, init: RequestInit): Promise<Response> {
  if (init.redirect === "manual") return fetch(input, init);
  let url = input;
  let current: RequestInit = init;
  for (let hop = 0; ; hop += 1) {
    const response = await fetch(url, { ...current, redirect: "manual" });
    if (!REDIRECT_STATUSES.has(response.status)) return response;
    const location = response.headers.get("location");
    if (!location) return response;

    const next = new URL(location, url);
    if (next.origin !== new URL(url).origin) {
      // Release the socket before unwinding.
      await response.body?.cancel().catch(() => undefined);
      throw new CrossOriginRedirectError(url, next.toString(), credentialHeaders(current));
    }
    if (hop >= MAX_REDIRECTS) {
      await response.body?.cancel().catch(() => undefined);
      throw new Error(`Refusing to follow more than ${MAX_REDIRECTS} redirects starting at ${input}`);
    }
    await response.body?.cancel().catch(() => undefined);

    // 303 always switches to GET; 301/302 do the same for non-GET in practice,
    // and replaying a JSON body across a redirect is never what the API means.
    const method = (current.method ?? "GET").toUpperCase();
    if (response.status === 303 || ((response.status === 301 || response.status === 302) && method !== "GET")) {
      const headers = new Headers(current.headers);
      headers.delete("content-type");
      headers.delete("content-length");
      current = { ...current, method: "GET", body: undefined, headers };
    }
    url = next.toString();
  }
}
