import { decryptValue, encryptValue, isEncryptedValue } from "../../services/crypto.js";

/**
 * Manual cookie helpers — we don't pull in `@fastify/cookie` because the
 * SaaS onboarding flow needs exactly one cookie (the OAuth state nonce).
 * Parser tolerates the standard `name=value; name2=value2` format.
 */

export function parseCookieHeader(header: string | string[] | undefined, name: string): string | null {
  if (!header) return null;
  const raw = Array.isArray(header) ? header.join("; ") : header;
  for (const entry of raw.split(/;\s*/)) {
    const eq = entry.indexOf("=");
    if (eq < 0) continue;
    const key = entry.slice(0, eq).trim();
    if (key === name) {
      // A malformed escape (`%E0%A4%A`) makes `decodeURIComponent` throw, and
      // the cookie is attacker-controlled: treat it as a missing cookie so a
      // hostile header cannot turn the unauthenticated callback into a 500.
      try {
        return decodeURIComponent(entry.slice(eq + 1));
      } catch {
        return null;
      }
    }
  }
  return null;
}

export function protectOAuthStateNonce(nonce: string, encryptionKey: string): string {
  return encryptValue(nonce, encryptionKey);
}

export function readOAuthStateNonce(
  header: string | string[] | undefined,
  name: string,
  encryptionKey: string,
): string | null {
  const value = parseCookieHeader(header, name);
  if (!value || !isEncryptedValue(value)) return null;
  try {
    return decryptValue(value, encryptionKey);
  } catch {
    return null;
  }
}

export function buildCookie(opts: {
  name: string;
  value: string;
  /** seconds; <=0 deletes via Max-Age=0 + epoch Expires */
  maxAge: number;
  secure: boolean;
  sameSite?: "Lax" | "Strict" | "None";
}): string {
  const sameSite = opts.sameSite ?? "Lax";
  const parts = [
    `${opts.name}=${encodeURIComponent(opts.value)}`,
    "Path=/",
    "HttpOnly",
    `SameSite=${sameSite}`,
    `Max-Age=${opts.maxAge}`,
  ];
  if (opts.secure) parts.push("Secure");
  if (opts.maxAge <= 0) {
    parts.push("Expires=Thu, 01 Jan 1970 00:00:00 GMT");
  }
  return parts.join("; ");
}
