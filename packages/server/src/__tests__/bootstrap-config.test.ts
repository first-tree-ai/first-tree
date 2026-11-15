import { CONNECT_BOOTSTRAP_CODE_PLACEHOLDER } from "@first-tree/shared";
import { describe, expect, it } from "vitest";
import { createTestApp, useTestApp } from "./helpers.js";

describe("GET /bootstrap/config", () => {
  const getApp = useTestApp();

  it("returns the public server command version, release channel, and disabled growth flag by default", async () => {
    const app = getApp();

    const res = await app.inject({
      method: "GET",
      url: "/api/v1/bootstrap/config",
      headers: { host: "127.0.0.1:8000", "x-forwarded-proto": "http" },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      allowedOrg: null,
      serverCommandVersion: "test.version",
      // Surfaced so the web can gate channel-scoped UI (e.g. the staging-only
      // "hide agent final text" toggle). Test app defaults to the dev channel.
      channel: "dev",
      connectBootstrapCommandTemplate: {
        command:
          "curl -fsSL --proto '=https' --proto-redir '=https' https://download.first-tree.ai/releases/staging/install.sh | sh\n" +
          `FIRST_TREE_SERVER_URL='http://127.0.0.1:8000' ~/.local/bin/first-tree-staging login ${CONNECT_BOOTSTRAP_CODE_PLACEHOLDER}`,
        codePlaceholder: CONNECT_BOOTSTRAP_CODE_PLACEHOLDER,
      },
      growthLandingPagesEnabled: false,
      authProviders: { google: false, github: true },
    });
  });
});

describe("GET /bootstrap/config — non-dev channel", () => {
  const getApp = useTestApp({ channel: "staging" });

  it("reports the channel and server-authored staging connect template", async () => {
    const res = await getApp().inject({
      method: "GET",
      url: "/api/v1/bootstrap/config",
      headers: { host: "dev.cloud.first-tree.ai", "x-forwarded-proto": "https" },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      channel: "staging",
      connectBootstrapCommandTemplate: {
        command:
          "curl -fsSL --proto '=https' --proto-redir '=https' https://download.first-tree.ai/releases/staging/install.sh | sh\n" +
          `~/.local/bin/first-tree-staging login ${CONNECT_BOOTSTRAP_CODE_PLACEHOLDER}`,
        codePlaceholder: CONNECT_BOOTSTRAP_CODE_PLACEHOLDER,
      },
    });
  });

  it("carries deployment mirror and public URL overrides into the preview template", async () => {
    const app = await createTestApp({
      channel: "staging",
      connectBootstrap: { portableDownloadBaseUrl: "https://downloads.example.test/releases/$(id)////" },
    });
    try {
      const res = await app.inject({
        method: "GET",
        url: "/api/v1/bootstrap/config",
        headers: { host: "staging.example.test", "x-forwarded-proto": "https" },
      });
      expect(res.json().connectBootstrapCommandTemplate.command).toBe(
        "curl -fsSL --proto '=https' --proto-redir '=https' 'https://downloads.example.test/releases/$(id)/staging/install.sh' | " +
          "FIRST_TREE_PORTABLE_DOWNLOAD_BASE_URL='https://downloads.example.test/releases/$(id)////' sh\n" +
          `FIRST_TREE_SERVER_URL='https://staging.example.test' ~/.local/bin/first-tree-staging login ${CONNECT_BOOTSTRAP_CODE_PLACEHOLDER}`,
      );
    } finally {
      await app.close();
    }
  });
});

describe("GET /bootstrap/config — growth landing flag", () => {
  const getApp = useTestApp({ channel: "prod", growthLandingPagesEnabled: true });

  it("reports the feature flag independently from release channel", async () => {
    const res = await getApp().inject({ method: "GET", url: "/api/v1/bootstrap/config" });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      channel: "prod",
      growthLandingPagesEnabled: true,
      connectBootstrapCommandTemplate: null,
    });
  });
});

describe("GET /bootstrap/config — authentication provider availability", () => {
  it("reports a Google-only deployment", async () => {
    const app = await createTestApp({ googleOAuth: true, githubOAuth: false });
    try {
      const res = await app.inject({ method: "GET", url: "/api/v1/bootstrap/config" });
      expect(res.json().authProviders).toEqual({ google: true, github: false, oidc: false });
    } finally {
      await app.close();
    }
  });

  it("reports a GitHub-only deployment", async () => {
    const app = await createTestApp({ githubOAuth: true });
    try {
      const res = await app.inject({ method: "GET", url: "/api/v1/bootstrap/config" });
      expect(res.json().authProviders).toEqual({ google: false, github: true, oidc: false });
    } finally {
      await app.close();
    }
  });
});
