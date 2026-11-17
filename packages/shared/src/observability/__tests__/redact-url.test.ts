import { describe, expect, it } from "vitest";
import { redactUrl } from "../redact-url.js";

describe("redactUrl", () => {
  it("returns the URL unchanged when there is no query string", () => {
    expect(redactUrl("/api/v1/me")).toBe("/api/v1/me");
    expect(redactUrl("/")).toBe("/");
  });

  it("redacts the GitLab URL bearer path segment", () => {
    expect(redactUrl("/api/v1/webhooks/gitlab/secret-bearer")).toBe("/api/v1/webhooks/gitlab/***");
    expect(redactUrl("https://first-tree.test/api/v1/webhooks/gitlab/secret-bearer?x=1")).toBe(
      "https://first-tree.test/api/v1/webhooks/gitlab/***?x=1",
    );
    expect(redactUrl("/api/v1/webhooks/gitlab/secret-bearer/extra")).toBe("/api/v1/webhooks/gitlab/***/extra");
  });

  it("redacts the invitation capability token in the path", () => {
    expect(redactUrl("/api/v1/invitations/inv_2b7c1f9e/preview")).toBe("/api/v1/invitations/***/preview");
    expect(redactUrl("https://first-tree.test/api/v1/invitations/inv_2b7c1f9e/preview?x=1")).toBe(
      "https://first-tree.test/api/v1/invitations/***/preview?x=1",
    );
    // Ids that only look like a capability stay readable.
    expect(redactUrl("/api/v1/invitations")).toBe("/api/v1/invitations");
  });

  it("redacts the OAuth callback code and state", () => {
    expect(redactUrl("/api/v1/auth/github/callback?code=abc123&state=xyz789")).toBe(
      "/api/v1/auth/github/callback?code=***&state=***",
    );
    expect(redactUrl("/api/v1/auth/github/callback?error=access_denied&state=xyz789")).toBe(
      "/api/v1/auth/github/callback?error=access_denied&state=***",
    );
  });

  it("matches percent-encoded query keys, the way the router decodes them", () => {
    // Fastify hands the route the decoded name, so `%74oken` is `token` there.
    expect(redactUrl("/api/v1/me?%74oken=abc123")).toBe("/api/v1/me?%74oken=***");
    expect(redactUrl("/api/v1/auth/github/callback?%63ode=abc&state=xyz")).toBe(
      "/api/v1/auth/github/callback?%63ode=***&state=***",
    );
    // The key keeps its original spelling; only the value is replaced.
    expect(redactUrl("/api/v1/me?access%5Ftoken=abc")).toBe("/api/v1/me?access%5Ftoken=***");
  });

  it("classifies equivalent path spellings the way the router does", () => {
    // Fastify matches on the decoded path, so a percent-encoded segment reaches
    // the same handler. Classification has to use that identity or the filter
    // is bypassable; emission still keeps the original spelling.
    expect(redactUrl("/api/v1/%61uth/github/callback?code=abc&state=xyz")).toBe(
      "/api/v1/%61uth/github/callback?code=***&state=***",
    );
    expect(redactUrl("/api/v1/%69nvitations/inv_2b7c1f9e/preview")).toBe("/api/v1/%69nvitations/***/preview");
    expect(redactUrl("/api/v1/webhooks/%67itlab/secret-bearer")).toBe("/api/v1/webhooks/%67itlab/***");
    // A capability path behind an encoded prefix still hides its token.
    expect(redactUrl("/%61pi/v1/invitations/inv_2b7c1f9e/preview")).toBe("/%61pi/v1/invitations/***/preview");
  });

  it("gives a sensitive route the same redaction however it is spelled", () => {
    const cases: ReadonlyArray<readonly [string, string]> = [
      ["/api/v1/auth/github/callback?state=s1", "/api/v1/auth/github/callback?state=***"],
      ["/%61pi/v1/auth/github/callback?state=s1", "/%61pi/v1/auth/github/callback?state=***"],
      ["/api/v1/%61uth/github/callback?state=s1", "/api/v1/%61uth/github/callback?state=***"],
      ["/api/v1/invitations/inv_1/preview", "/api/v1/invitations/***/preview"],
      ["/api/v1/%69nvitations/inv_1/preview", "/api/v1/%69nvitations/***/preview"],
      ["/api/v1/webhooks/gitlab/bearer_1", "/api/v1/webhooks/gitlab/***"],
      ["/api/v1/webhooks/%67itlab/bearer_1", "/api/v1/webhooks/%67itlab/***"],
    ];
    for (const [input, expected] of cases) {
      expect(redactUrl(input)).toBe(expected);
    }
  });

  it("does not mask a capability route that names no token", () => {
    expect(redactUrl("/api/v1/invitations/")).toBe("/api/v1/invitations/");
    expect(redactUrl("/api/v1/webhooks/gitlab")).toBe("/api/v1/webhooks/gitlab");
  });

  it("leaves malformed escapes alone instead of rewriting the URL", () => {
    expect(redactUrl("/api/v1/me?%E0%A4%A=x&safe=1")).toBe("/api/v1/me?%E0%A4%A=x&safe=1");
    expect(redactUrl("/api/v1/me?%zz=1")).toBe("/api/v1/me?%zz=1");
  });

  it("does not decode values or unrelated bytes", () => {
    // A percent-encoded *value* must survive verbatim: the scrubber only ever
    // touches values whose key is sensitive.
    expect(redactUrl("/api/v1/x?a=%74oken&token=1")).toBe("/api/v1/x?a=%74oken&token=***");
  });

  it("leaves code/state readable outside auth routes", () => {
    // `state` is an ordinary session filter and `code` an ordinary error field;
    // masking them everywhere would cost diagnostics for no confidentiality.
    expect(redactUrl("/api/v1/agents/agent_1/sessions?state=active")).toBe(
      "/api/v1/agents/agent_1/sessions?state=active",
    );
    expect(redactUrl("/api/v1/runs?code=ENOENT")).toBe("/api/v1/runs?code=ENOENT");
  });

  it("leaves the admin invitations route readable", () => {
    // Only the public preview path is a capability link; the org-scoped admin
    // route is an id lookup and stays useful in logs.
    expect(redactUrl("/api/v1/orgs/org_1/invitations/inv_2b7c1f9e")).toBe(
      "/api/v1/orgs/org_1/invitations/inv_2b7c1f9e",
    );
    expect(redactUrl("/api/v1/invitations/inv_2b7c1f9e/preview")).toBe("/api/v1/invitations/***/preview");
  });

  it("returns the URL unchanged when the query string is empty", () => {
    // Path ends with `?` but no params — keep the trailing `?` to preserve
    // the original shape, since we only redact values, never structure.
    expect(redactUrl("/foo?")).toBe("/foo?");
  });

  it("redacts `token` value", () => {
    expect(redactUrl("/api/v1/ws/admin?token=eyJabc.def.ghi")).toBe("/api/v1/ws/admin?token=***");
  });

  it("redacts other sensitive keys", () => {
    expect(redactUrl("/x?access_token=a")).toBe("/x?access_token=***");
    expect(redactUrl("/x?accessToken=a")).toBe("/x?accessToken=***");
    expect(redactUrl("/x?refresh_token=a")).toBe("/x?refresh_token=***");
    expect(redactUrl("/x?refreshToken=a")).toBe("/x?refreshToken=***");
    expect(redactUrl("/x?jwt=a")).toBe("/x?jwt=***");
    expect(redactUrl("/x?password=a")).toBe("/x?password=***");
    expect(redactUrl("/x?secret=a")).toBe("/x?secret=***");
    expect(redactUrl("/x?api_key=a")).toBe("/x?api_key=***");
    expect(redactUrl("/x?apiKey=a")).toBe("/x?apiKey=***");
    expect(redactUrl("/x?credentials=a")).toBe("/x?credentials=***");
    expect(redactUrl("/x?authorization=Bearer+a")).toBe("/x?authorization=***");
  });

  it("preserves non-sensitive params verbatim", () => {
    expect(redactUrl("/api/v1/admin/agents?organizationId=019dfb4a-3ba3-7bb9&page=2&limit=50")).toBe(
      "/api/v1/admin/agents?organizationId=019dfb4a-3ba3-7bb9&page=2&limit=50",
    );
  });

  it("redacts only the sensitive param when mixed with safe ones", () => {
    expect(redactUrl("/api/v1/ws/admin?token=eyJabc&organizationId=019dfb")).toBe(
      "/api/v1/ws/admin?token=***&organizationId=019dfb",
    );
    expect(redactUrl("/x?a=1&token=eyJ&b=2")).toBe("/x?a=1&token=***&b=2");
  });

  it("does not match keys that merely contain a sensitive substring", () => {
    // Case-sensitive set membership: `userToken` is not in the redact set, so
    // it passes through. (Pair this with `LOG_REDACT_PATHS` for object-level
    // coverage on similar names.)
    expect(redactUrl("/x?userToken=keep")).toBe("/x?userToken=keep");
    expect(redactUrl("/x?TOKEN=keep")).toBe("/x?TOKEN=keep");
  });

  it("handles params with no value (key-only fragments)", () => {
    expect(redactUrl("/x?flag&token=secret")).toBe("/x?flag&token=***");
  });

  it("handles values containing `=` (e.g. base64 padding) safely", () => {
    // Split on the first `=` only, so `==` padding inside a token value stays
    // intact in the (unredacted) safe params and the token itself becomes ***.
    expect(redactUrl("/x?token=abc==&id=xyz==")).toBe("/x?token=***&id=xyz==");
  });

  it("does not parse the value content — long uuid-shaped values pass through", () => {
    expect(redactUrl("/x?organizationId=eyJlooks-like-jwt-but-is-not")).toBe(
      "/x?organizationId=eyJlooks-like-jwt-but-is-not",
    );
  });
});
