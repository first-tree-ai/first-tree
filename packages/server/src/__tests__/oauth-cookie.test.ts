import { describe, expect, it } from "vitest";
import {
  buildCookie,
  parseCookieHeader,
  protectOAuthStateNonce,
  readOAuthStateNonce,
} from "../api/auth/oauth-cookie.js";

const ENCRYPTION_KEY = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

describe("OAuth state cookie", () => {
  it("encrypts the nonce at rest and reads it back", () => {
    const nonce = "short-lived-csrf-nonce";
    const protectedNonce = protectOAuthStateNonce(nonce, ENCRYPTION_KEY);
    expect(protectedNonce).not.toContain(nonce);
    const header = buildCookie({ name: "oauth_state_nonce", value: protectedNonce, maxAge: 600, secure: true });

    expect(readOAuthStateNonce(header, "oauth_state_nonce", ENCRYPTION_KEY)).toBe(nonce);
  });

  it("rejects a plaintext nonce", () => {
    const header = "oauth_state_nonce=legacy-nonce; Path=/; HttpOnly; SameSite=Lax";
    expect(readOAuthStateNonce(header, "oauth_state_nonce", ENCRYPTION_KEY)).toBeNull();
  });

  it("treats a malformed escape as a missing cookie instead of throwing", () => {
    // `decodeURIComponent` rejects `%E0%A4%A`. The cookie is attacker-controlled
    // and decoded before the OAuth state is verified, so a throw here reaches an
    // unauthenticated handler as a URIError.
    expect(parseCookieHeader("oauth_state_nonce=%E0%A4%A", "oauth_state_nonce")).toBeNull();
    expect(readOAuthStateNonce("oauth_state_nonce=%E0%A4%A", "oauth_state_nonce", ENCRYPTION_KEY)).toBeNull();
  });

  it("rejects malformed encrypted values and parses repeated cookie headers", () => {
    expect(
      readOAuthStateNonce("oauth_state_nonce=enc%3Av1%3Anot-valid", "oauth_state_nonce", ENCRYPTION_KEY),
    ).toBeNull();
    expect(parseCookieHeader(["first=1", "target=value"], "target")).toBe("value");
  });
});
