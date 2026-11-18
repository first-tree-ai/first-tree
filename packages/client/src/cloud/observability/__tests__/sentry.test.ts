import type { Event } from "@sentry/node";
import { describe, expect, it } from "vitest";
import { resolveClientSentryConfig, sanitizeClientSentryEvent } from "../sentry.js";

describe("resolveClientSentryConfig", () => {
  it("defaults to enabled when a client DSN is configured", () => {
    const config = resolveClientSentryConfig({
      FIRST_TREE_CLIENT_SENTRY_DSN: "https://public@example.ingest.sentry.io/1",
      FIRST_TREE_GIT_SHA: "abc123",
    });

    expect(config.enabled).toBe(true);
    expect(config.release).toBe("first-tree-client@abc123");
    expect(config.gitSha).toBe("abc123");
  });

  it("honors the explicit client disable switch", () => {
    const config = resolveClientSentryConfig({
      FIRST_TREE_CLIENT_SENTRY_DSN: "https://public@example.ingest.sentry.io/1",
      FIRST_TREE_CLIENT_SENTRY_ENABLED: "off",
      FIRST_TREE_GIT_SHA: "abc123",
    });

    expect(config.enabled).toBe(false);
  });

  it("uses the release-baked DSN when operator env does not override it", () => {
    const config = resolveClientSentryConfig(
      {
        FIRST_TREE_GIT_SHA: "abc123",
      },
      { defaultDsn: "https://public@example.ingest.sentry.io/2" },
    );

    expect(config.enabled).toBe(true);
    expect(config.dsn).toBe("https://public@example.ingest.sentry.io/2");
  });
});

describe("sanitizeClientSentryEvent", () => {
  it("redacts tokens, local paths, request bodies, and user context", () => {
    const home = process.env.HOME ?? "";
    const rawEvent: Event = {
      user: { id: "user_123", email: "person@example.com" },
      request: {
        url: `file://${home}/workspace/project?token=secret#hash`,
        headers: { authorization: "Bearer secret", accept: "application/json" },
        cookies: { session: "secret" },
        query_string: "token=secret",
        data: { prompt: "do not send" },
      },
      extra: {
        workspacePath: `${home}/workspace/project`,
        bearer: "Bearer secret-token",
        nested: { refreshToken: "secret", output: "model text", status: "safe metadata" },
      },
      breadcrumbs: [{ message: "stdout: secret output" }],
      transaction: `${home}/workspace/project/src/index.ts`,
    };
    const event = sanitizeClientSentryEvent(rawEvent, {
      enabled: true,
      dsn: "https://public@example.ingest.sentry.io/1",
      environment: "production",
      release: "first-tree-client@abc123",
      gitSha: "abc123",
      sampleRate: 0.05,
    });

    expect(event.user).toBeUndefined();
    expect(event.request?.url).not.toContain(home);
    expect(event.request?.url).not.toContain("token=");
    expect(event.request?.url).not.toContain("#hash");
    expect(event.request?.headers).toEqual({
      authorization: "[REDACTED]",
      accept: "application/json",
    });
    expect(event.request?.cookies).toBeUndefined();
    expect(event.request?.data).toBeUndefined();
    expect(event.extra?.workspacePath).toBe("[LOCAL_PATH]/workspace/project");
    expect(event.extra?.bearer).toBe("Bearer [REDACTED]");
    expect(event.extra?.nested).toEqual({
      refreshToken: "[REDACTED]",
      output: "[REDACTED]",
      status: "safe metadata",
    });
    expect(event.breadcrumbs).toBeUndefined();
    expect(event.transaction).toBe("[LOCAL_PATH]/workspace/project/src/index.ts");
    expect(event.tags).toMatchObject({
      "first_tree.surface": "client",
      "first_tree.git_sha": "abc123",
    });
  });

  it("strips URL userinfo and vendor tokens from every event field", () => {
    // SEC-033: the previous URL sanitizer dropped only query/fragment and the
    // string redactor only knew Bearer plus a few `key=value` names, so a
    // PAT-bearing remote or an SDK error carried live credentials to Sentry.
    // Assembled at runtime: the file must not itself contain token-shaped
    // literals, or GitHub push protection refuses the branch.
    const secrets = {
      urlUser: `ghp_${"U".repeat(32)}`,
      urlPass: "hunter2",
      github: `ghp_${"A".repeat(30)}`,
      githubPat: `github_pat_${"1".repeat(10)}_${"b".repeat(20)}`,
      aws: `AKIA${"IOSFODNN7EXAMPLE"}`,
      openai: `sk-proj-${"c".repeat(30)}`,
      anthropic: `sk-ant-api03-${"d".repeat(30)}`,
      slack: ["xoxb", "1".repeat(12), "e".repeat(16)].join("-"),
    };
    const rawEvent: Event = {
      // Top-level free-form fields: `captureMessage` text and a caller-supplied
      // tag value reach Sentry through the same event object as `extra`.
      message: `agent failed: ${secrets.githubPat} at https://x:${secrets.slack}@host/p`,
      tags: { flow: `retry with ${secrets.aws}` },
      request: {
        url: `https://deploy:${secrets.urlUser}@git.example.test/repo.git?token=abc`,
        headers: { authorization: `Basic ${secrets.urlPass}` },
      },
      extra: {
        clone: `git clone https://${secrets.urlPass}:${secrets.urlUser}@git.example.test/repo.git`,
        keys: [secrets.github, secrets.githubPat, secrets.aws, secrets.openai, secrets.anthropic, secrets.slack],
        note: "workspace prepared",
      },
      exception: {
        values: [
          {
            type: "Error",
            value: `request failed with ${secrets.githubPat} and ${secrets.aws} at https://x:${secrets.slack}@host/p`,
          },
        ],
      },
      transaction: `GET /agents/${secrets.openai}`,
    };

    const event = sanitizeClientSentryEvent(rawEvent, {
      enabled: true,
      dsn: "https://public@example.ingest.sentry.io/1",
      environment: "production",
      release: "first-tree-client@abc123",
      gitSha: "abc123",
      sampleRate: 0.05,
    });

    const serialized = JSON.stringify(event);
    for (const [name, secret] of Object.entries(secrets)) {
      expect(serialized, `${name} must not reach Sentry`).not.toContain(secret);
    }
    // Redaction, not deletion: the event still explains what happened.
    expect(event.extra?.note).toBe("workspace prepared");
    expect(event.message).toContain("agent failed:");
    expect(event.tags?.flow).toContain("retry with");
    // The keys this sanitizer adds itself are not scrubbed away.
    expect(event.tags?.["first_tree.surface"]).toBe("client");
    expect(event.exception?.values?.[0]?.value).toContain("request failed with");
    expect(event.exception?.values?.[0]?.value).toContain("[REDACTED");
  });

  it("redacts FIRST_TREE_HOME runtime paths outside the OS home and cwd", () => {
    const previousHome = process.env.FIRST_TREE_HOME;
    process.env.FIRST_TREE_HOME = "/mnt/ft";
    try {
      const rawEvent: Event = {
        extra: {
          workspacePath: "/mnt/ft/data/workspaces/acme/repo",
          sessionPath: "/mnt/ft/data/sessions/acme.json",
        },
        exception: {
          values: [
            {
              type: "Error",
              value: "failed opening /mnt/ft/data/workspaces/acme/repo/package.json",
            },
          ],
        },
        transaction: "/mnt/ft/data/workspaces/acme/repo/src/index.ts",
      };
      const event = sanitizeClientSentryEvent(rawEvent, {
        enabled: true,
        dsn: "https://public@example.ingest.sentry.io/1",
        environment: "production",
        release: "first-tree-client@abc123",
        gitSha: "abc123",
        sampleRate: 0.05,
      });

      expect(event.extra?.workspacePath).toBe("[LOCAL_PATH]/data/workspaces/acme/repo");
      expect(event.extra?.sessionPath).toBe("[LOCAL_PATH]/data/sessions/acme.json");
      expect(event.exception?.values?.[0]?.value).toBe(
        "failed opening [LOCAL_PATH]/data/workspaces/acme/repo/package.json",
      );
      expect(event.transaction).toBe("[LOCAL_PATH]/data/workspaces/acme/repo/src/index.ts");
    } finally {
      if (previousHome === undefined) {
        delete process.env.FIRST_TREE_HOME;
      } else {
        process.env.FIRST_TREE_HOME = previousHome;
      }
    }
  });

  it("strips URL suffixes from fallback URL parsing without regular expression backtracking", () => {
    const rawEvent: Event = {
      request: {
        url: `${"#".repeat(10_000)}?token=secret`,
      },
    };
    const event = sanitizeClientSentryEvent(rawEvent, {
      enabled: true,
      dsn: "https://public@example.ingest.sentry.io/1",
      environment: "production",
      release: "first-tree-client@abc123",
      gitSha: "abc123",
      sampleRate: 0.05,
    });

    expect(event.request?.url).toBe("");
  });
});
