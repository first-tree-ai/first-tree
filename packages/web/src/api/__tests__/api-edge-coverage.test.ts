// @vitest-environment happy-dom

import { ATTACHMENT_FILENAME_HEADER, ATTACHMENT_MIME_HEADER } from "@first-tree/shared";
import { beforeEach, describe, expect, it, vi } from "vitest";

const apiMock = vi.hoisted(() => ({
  get: vi.fn(),
  post: vi.fn(),
}));

const rawMock = vi.hoisted(() => vi.fn());
const analyticsMock = vi.hoisted(() => ({ trackEvent: vi.fn() }));

vi.mock("../../analytics.js", () => analyticsMock);

vi.mock("../client.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../client.js")>();
  return {
    ...actual,
    api: apiMock,
    apiFetchRaw: rawMock,
    withOrg: (path: string) => `/orgs/current${path}`,
  };
});

beforeEach(() => {
  vi.resetModules();
  apiMock.get.mockReset();
  apiMock.post.mockReset();
  rawMock.mockReset();
  analyticsMock.trackEvent.mockReset();
  apiMock.get.mockResolvedValue({});
  apiMock.post.mockResolvedValue({});
});

describe("attachment API helpers", () => {
  it("uploads image bytes with encoded filename and parses the response", async () => {
    rawMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          id: "11111111-1111-4111-8111-111111111111",
          mimeType: "image/png",
          filename: "avatar 你好.png",
          sizeBytes: 3,
          uploadedBy: "agent-human",
          createdAt: "2026-01-01T00:00:00.000Z",
        }),
        {
          headers: { "Content-Type": "application/json" },
        },
      ),
    );
    const { uploadImageAttachment } = await import("../attachments.js");

    await expect(uploadImageAttachment(new File(["abc"], "avatar 你好.png", { type: "image/png" }))).resolves.toEqual({
      id: "11111111-1111-4111-8111-111111111111",
      mimeType: "image/png",
      filename: "avatar 你好.png",
      sizeBytes: 3,
      uploadedBy: "agent-human",
      createdAt: "2026-01-01T00:00:00.000Z",
    });

    const [path, init] = rawMock.mock.calls[0] ?? [];
    expect(path).toBe("/orgs/current/attachments");
    expect(init).toMatchObject({
      method: "POST",
      headers: {
        "Content-Type": "application/octet-stream",
        [ATTACHMENT_MIME_HEADER]: "image/png",
        [ATTACHMENT_FILENAME_HEADER]: "avatar%20%E4%BD%A0%E5%A5%BD.png",
      },
    });
    await expect(new Response(init.body).text()).resolves.toBe("abc");
  });

  it("rejects overlong attachment filenames before upload transport", async () => {
    const { uploadAttachment } = await import("../attachments.js");
    await expect(uploadAttachment(new Blob(["x"]), ";".repeat(256))).rejects.toThrow(
      "Attachment filename exceeds maximum length",
    );
    expect(rawMock).not.toHaveBeenCalled();
  });

  it("downloads attachment bytes as base64, text, and a browser save", async () => {
    rawMock
      .mockResolvedValueOnce(new Response(new Blob(["hello"], { type: "text/plain" })))
      .mockResolvedValueOnce(new Response("plain text", { headers: { "Content-Type": "text/markdown" } }))
      .mockResolvedValueOnce(new Response("download", { headers: { "Content-Type": "text/plain" } }));
    const createObjectURL = vi.fn(() => "blob:first-tree");
    const revokeObjectURL = vi.fn();
    Object.defineProperty(URL, "createObjectURL", { configurable: true, value: createObjectURL });
    Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: revokeObjectURL });
    const clicked: string[] = [];
    const originalClick = HTMLAnchorElement.prototype.click;
    HTMLAnchorElement.prototype.click = function click() {
      clicked.push(`${this.href}|${this.download}`);
    };
    const { downloadAttachment, fetchAttachmentBase64, fetchAttachmentText } = await import("../attachments.js");

    try {
      await expect(fetchAttachmentBase64("img/id")).resolves.toEqual({
        base64: "aGVsbG8=",
        mimeType: "text/plain",
      });
      await expect(fetchAttachmentText("doc/id")).resolves.toEqual({
        text: "plain text",
        mimeType: "text/markdown",
        sizeBytes: 10,
      });
      await expect(downloadAttachment("file/id", "report.md")).resolves.toBeUndefined();
    } finally {
      HTMLAnchorElement.prototype.click = originalClick;
    }

    expect(rawMock).toHaveBeenNthCalledWith(1, "/attachments/img%2Fid");
    expect(rawMock).toHaveBeenNthCalledWith(2, "/attachments/doc%2Fid");
    expect(rawMock).toHaveBeenNthCalledWith(3, "/attachments/file%2Fid");
    expect(clicked).toEqual(["blob:first-tree|report.md"]);
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:first-tree");
  });

  it("computes SHA-256 through Web Crypto and reports missing subtle crypto", async () => {
    const { sha256Hex } = await import("../attachments.js");

    await expect(sha256Hex("abc")).resolves.toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");

    const originalCrypto = globalThis.crypto;
    Object.defineProperty(globalThis, "crypto", { configurable: true, value: {} });
    try {
      await expect(sha256Hex("abc")).rejects.toThrow("Web Crypto subtle digest is unavailable");
    } finally {
      Object.defineProperty(globalThis, "crypto", { configurable: true, value: originalCrypto });
    }
  });
});

describe("GitHub API wrappers", () => {
  it("handles GitHub App 404 as empty state and rethrows other failures", async () => {
    const { ApiError } = await import("../client.js");
    const { getGithubAppInstallation } = await import("../github-app.js");

    apiMock.get.mockRejectedValueOnce(new ApiError(404, "missing")).mockRejectedValueOnce(new ApiError(500, "bad"));

    await expect(getGithubAppInstallation("org/id")).resolves.toBeNull();
    await expect(getGithubAppInstallation("org/id")).rejects.toMatchObject({ status: 500 });
  });

  it("formats GitHub App and GitHub repo endpoints", async () => {
    apiMock.get
      .mockResolvedValueOnce({ exists: true })
      .mockResolvedValueOnce({ installUrl: "https://github.com/apps/first-tree/installations/new" })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ repos: [{ fullName: "bestony/web" }] })
      .mockResolvedValueOnce({ repos: [{ fullName: "bestony/server" }] });
    const githubApp = await import("../github-app.js");
    const github = await import("../github.js");

    await expect(githubApp.getGithubAppInstallationExists("org/id")).resolves.toBe(true);
    await expect(githubApp.getGithubAppInstallUrl("org/id", "/onboarding?step=code")).resolves.toContain(
      "github.com/apps",
    );
    await expect(githubApp.getGithubAppConnectPanel("org/id")).resolves.toEqual({ rows: [] });
    await githubApp.connectGithubAppInstallation("org/id", 42);
    await githubApp.disconnectGithubAppInstallation("org/id");
    await expect(github.listGithubRepos()).resolves.toEqual([{ fullName: "bestony/web" }]);
    await expect(github.listOrgGithubRepos("org/id")).resolves.toEqual([{ fullName: "bestony/server" }]);

    expect(apiMock.get).toHaveBeenCalledWith("/orgs/org/id/github-app-installation/exists");
    expect(apiMock.get).toHaveBeenCalledWith(
      "/orgs/org/id/github-app-installation/install-url?next=%2Fonboarding%3Fstep%3Dcode",
    );
    expect(apiMock.get).toHaveBeenCalledWith("/orgs/org/id/github-app-installation/connect-panel");
    expect(apiMock.post).toHaveBeenCalledWith("/orgs/org/id/github-app-installation/connect", { installationId: 42 });
    expect(apiMock.post).toHaveBeenCalledWith("/orgs/org/id/github-app-installation/disconnect", {});
    expect(apiMock.get).toHaveBeenCalledWith("/me/github/repos");
    expect(apiMock.get).toHaveBeenCalledWith("/orgs/org/id/github-app-installation/repositories");
  });
});

describe("Context enablement API", () => {
  it("rejects a handoff from an incompatible Server protocol", async () => {
    apiMock.get.mockResolvedValueOnce({
      organizationId: "org-1",
      teamDisplayName: "Acme",
      role: "member",
      provider: "claude-code",
      intent: "onboarding",
      command: "first-tree context enable",
      workingDirectoryInstruction: "Run this in the target checkout.",
    });
    const { getContextEnablementHandoff } = await import("../context-enablement.js");

    await expect(getContextEnablementHandoff("org-1", "claude-code", "onboarding")).rejects.toThrow();
  });
});

describe("onboarding and campaign API wrappers", () => {
  it("swallows best-effort onboarding telemetry failures and posts required kickoff calls", async () => {
    apiMock.post
      .mockRejectedValueOnce(new Error("telemetry down"))
      .mockResolvedValueOnce({ completedAt: "2026-08-14T06:00:00.000Z" })
      .mockResolvedValueOnce({ chatId: "chat-1" })
      .mockResolvedValueOnce({ chatId: "chat-2" });
    apiMock.get.mockResolvedValueOnce({ needsTreeSetup: true, hasTreeBinding: false, hasTreeSetupKickoff: true });
    const onboarding = await import("../onboarding-events.js");
    const agents = await import("../agents.js");

    await expect(
      onboarding.reportOnboardingEvent("step_failed", {
        step: "create-agent",
        path: "admin",
        reasonCode: "agent_create_failed",
        retryable: true,
        organizationId: "org-1",
        chatId: "chat-1",
      }),
    ).resolves.toBeUndefined();
    await expect(agents.completeAgentFeishuOnboarding("agent/id")).resolves.toEqual({
      completedAt: "2026-08-14T06:00:00.000Z",
    });
    await expect(
      onboarding.postOnboardingStartChat({ agentUuid: "agent-1", bootstrap: "start", complete: true }),
    ).resolves.toEqual({ chatId: "chat-1" });
    await expect(
      onboarding.postTreeSetupStartChat({ organizationId: "org/id", agentUuid: "agent-1" }),
    ).resolves.toEqual({ chatId: "chat-2" });
    await expect(onboarding.getTreeSetupStatus("org/id")).resolves.toEqual({
      needsTreeSetup: true,
      hasTreeBinding: false,
      hasTreeSetupStartChat: true,
    });

    expect(apiMock.post).toHaveBeenNthCalledWith(1, "/me/onboarding/events", {
      event: "step_failed",
      attrs: {
        step: "create-agent",
        path: "admin",
        reasonCode: "agent_create_failed",
        retryable: true,
        organizationId: "org-1",
        chatId: "chat-1",
      },
    });
    expect(analyticsMock.trackEvent).toHaveBeenCalledWith("onboarding_step_failed", {
      step: "create-agent",
      path: "admin",
      reasonCode: "agent_create_failed",
      retryable: true,
    });
    expect(apiMock.post).toHaveBeenNthCalledWith(2, "/agents/agent%2Fid/feishu-binding/onboarding-completed", {});
    expect(apiMock.post).toHaveBeenNthCalledWith(3, "/me/onboarding/kickoff", {
      agentUuid: "agent-1",
      bootstrap: "start",
      complete: true,
    });
    expect(apiMock.post).toHaveBeenNthCalledWith(4, "/orgs/org%2Fid/context-tree/setup-chat", {
      agentUuid: "agent-1",
    });
    expect(apiMock.get).toHaveBeenCalledWith("/me/onboarding/tree-setup-status?organizationId=org%2Fid");
  });

  it("validates landing campaign start responses", async () => {
    apiMock.post.mockResolvedValueOnce({
      chatId: "chat-1",
      agentUuid: "agent-1",
      campaign: "github-repo-review",
      repoCanonicalKey: "github.com/bestony/web",
    });
    const { startLandingCampaign } = await import("../landing-campaigns.js");

    await expect(
      startLandingCampaign({
        campaign: "github-repo-review",
        repoUrl: "https://github.com/bestony/web",
      }),
    ).resolves.toMatchObject({ chatId: "chat-1", agentUuid: "agent-1" });

    expect(apiMock.post).toHaveBeenCalledWith("/me/landing-campaigns/start", {
      campaign: "github-repo-review",
      repoUrl: "https://github.com/bestony/web",
    });
  });
});
