import {
  AGENT_RUNTIME_SESSION_HEADER,
  AGENT_SELECTOR_HEADER,
  ATTACHMENT_FILENAME_HEADER,
  ATTACHMENT_MIME_HEADER,
} from "@first-tree/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { applyClientLoggerConfig } from "../cloud/observability/logger.js";
import { FirstTreeHubSDK, SdkError } from "../cloud/sdk.js";

const SERVER_URL = "https://first-tree.example";
type TestHeaders = Record<string, string>;

const githubEntity = {
  entityType: "pull_request",
  entityKey: "agent-team-foundation/first-tree#42",
  boundVia: "agent_declared",
  htmlUrl: "https://github.com/agent-team-foundation/first-tree/pull/42",
  title: "Add SDK tests",
  state: "open",
  number: 42,
};

const gitlabEntity = {
  entityType: "pull_request",
  entityUrl: "https://gitlab.example/acme/api/-/merge_requests/42",
  projectPath: "acme/api",
  entityIid: 42,
  title: null,
  state: null,
  status: "pending",
  boundVia: "agent_declared",
};

function jsonResponse(data: unknown, status = 200, headers: TestHeaders = {}): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json",
      ...headers,
    },
  });
}

function textResponse(body: string, status = 200, headers: TestHeaders = {}): Response {
  return new Response(body, {
    status,
    headers: {
      "content-type": "text/plain",
      ...headers,
    },
  });
}

function binaryResponse(bytes: Uint8Array, headers: TestHeaders = {}): Response {
  return new Response(bytes, { status: 200, headers });
}

function mockFetch(...responses: Response[]): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn();
  for (const response of responses) {
    fetchMock.mockResolvedValueOnce(response);
  }
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function makeSdk(overrides: Partial<ConstructorParameters<typeof FirstTreeHubSDK>[0]> = {}): FirstTreeHubSDK {
  return new FirstTreeHubSDK({
    serverUrl: `${SERVER_URL}///`,
    agentId: "agent-1",
    runtimeSessionToken: "runtime-session-1",
    userAgent: "first-tree-test",
    getAccessToken: () => "access-token",
    ...overrides,
  });
}

function requestInit(fetchMock: ReturnType<typeof vi.fn>, index: number): RequestInit {
  const init = fetchMock.mock.calls[index]?.[1] as RequestInit | undefined;
  if (!init) throw new Error(`missing fetch init at call ${index}`);
  return init;
}

async function flush<T>(promise: Promise<T>, maxFlushes = 50): Promise<T> {
  let settled = false;
  let result: T | undefined;
  let error: unknown;
  promise.then(
    (value) => {
      result = value;
      settled = true;
    },
    (err) => {
      error = err;
      settled = true;
    },
  );

  for (let i = 0; i < maxFlushes && !settled; i++) {
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(1000);
  }
  if (!settled) throw new Error("flush did not settle within maxFlushes");
  if (error !== undefined) throw error;
  return result as T;
}

describe("FirstTreeHubSDK comprehensive wrappers", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    applyClientLoggerConfig({ level: "silent", format: "json", destination: process.stderr, explicit: false });
  });

  it("normalizes config and attaches scoped auth headers", async () => {
    const fetchMock = mockFetch(jsonResponse({ accessToken: "outbox-token", expiresIn: 60 }));
    const sdk = makeSdk();

    expect(sdk.serverUrl).toBe(SERVER_URL);
    expect(sdk.agentId).toBe("agent-1");
    expect(sdk.runtimeSessionToken).toBe("runtime-session-1");

    await expect(sdk.createAgentOutboxToken("chat/with space")).resolves.toEqual({
      accessToken: "outbox-token",
      expiresIn: 60,
    });

    expect(fetchMock).toHaveBeenCalledWith(
      `${SERVER_URL}/api/v1/agent/chats/chat%2Fwith%20space/outbox-token`,
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          Authorization: "Bearer access-token",
          [AGENT_SELECTOR_HEADER]: "agent-1",
          [AGENT_RUNTIME_SESSION_HEADER]: "runtime-session-1",
          "User-Agent": "first-tree-test",
        }),
      }),
    );
    expect(requestInit(fetchMock, 0).headers).not.toMatchObject({ "Content-Type": "application/json" });
  });

  it("resolves the runtime session token for each request", async () => {
    const fetchMock = mockFetch(
      jsonResponse({ accessToken: "outbox-token-1", expiresIn: 60 }),
      jsonResponse({ accessToken: "outbox-token-2", expiresIn: 60 }),
    );
    let runtimeSessionToken = "runtime-session-1";
    const sdk = makeSdk({ runtimeSessionToken: () => runtimeSessionToken });

    await expect(sdk.createAgentOutboxToken("chat-1")).resolves.toMatchObject({ accessToken: "outbox-token-1" });
    runtimeSessionToken = "runtime-session-2";
    await expect(sdk.createAgentOutboxToken("chat-2")).resolves.toMatchObject({ accessToken: "outbox-token-2" });

    expect(requestInit(fetchMock, 0).headers).toMatchObject({
      [AGENT_RUNTIME_SESSION_HEADER]: "runtime-session-1",
    });
    expect(requestInit(fetchMock, 1).headers).toMatchObject({
      [AGENT_RUNTIME_SESSION_HEADER]: "runtime-session-2",
    });
  });

  it("builds chat and GitHub entity wrapper paths, bodies, and queries", async () => {
    const fetchMock = mockFetch(
      jsonResponse({ chatIds: ["chat-1", "chat-2"] }),
      jsonResponse({ status: "created", entity: githubEntity }, 201),
      jsonResponse({ removed: 1 }),
      jsonResponse({ items: [githubEntity] }),
      jsonResponse({ chatId: "chat/with space", engagementStatus: "archived" }),
      jsonResponse({ id: "chat-1", topic: "New topic", description: null }),
    );
    const sdk = makeSdk();

    await expect(sdk.listActiveRuntimeChatIds()).resolves.toEqual({ chatIds: ["chat-1", "chat-2"] });
    await expect(sdk.followGithubEntity("chat-1", { entity: "owner/repo#42", rebind: true })).resolves.toEqual({
      ok: true,
      result: { status: "created", entity: githubEntity },
    });
    await expect(sdk.unfollowGithubEntity("chat-1", "owner/repo#42 & label")).resolves.toEqual({ removed: 1 });
    await expect(sdk.listChatGithubEntities("chat-1")).resolves.toEqual({ items: [githubEntity] });
    await expect(sdk.archiveChat("chat/with space")).resolves.toEqual({
      chatId: "chat/with space",
      engagementStatus: "archived",
    });
    await expect(sdk.updateChat("chat-1", { topic: "New topic", description: null })).resolves.toMatchObject({
      id: "chat-1",
      topic: "New topic",
    });

    expect(fetchMock.mock.calls.map((call) => call[0])).toEqual([
      `${SERVER_URL}/api/v1/agent/chats/active-runtime-ids`,
      `${SERVER_URL}/api/v1/agent/chats/chat-1/github-entities`,
      `${SERVER_URL}/api/v1/agent/chats/chat-1/github-entities?entity=owner%2Frepo%2342%20%26%20label`,
      `${SERVER_URL}/api/v1/agent/chats/chat-1/github-entities`,
      `${SERVER_URL}/api/v1/agent/chats/chat%2Fwith%20space/archive`,
      `${SERVER_URL}/api/v1/agent/chats/chat-1`,
    ]);
    expect(requestInit(fetchMock, 1)).toMatchObject({
      method: "POST",
      body: JSON.stringify({ entity: "owner/repo#42", rebind: true }),
    });
    expect(requestInit(fetchMock, 2)).toMatchObject({ method: "DELETE" });
    expect(requestInit(fetchMock, 4)).toMatchObject({ method: "POST" });
    expect(requestInit(fetchMock, 5)).toMatchObject({
      method: "PATCH",
      body: JSON.stringify({ topic: "New topic", description: null }),
    });
  });

  it("builds typed GitLab entity follow, list, and URL-unfollow requests", async () => {
    const fetchMock = mockFetch(
      jsonResponse({ status: "created", entity: gitlabEntity }, 201),
      jsonResponse({ items: [gitlabEntity] }),
      jsonResponse({ removed: 1 }),
    );
    const sdk = makeSdk();

    await expect(sdk.followGitlabEntity("chat-1", { entityUrl: gitlabEntity.entityUrl })).resolves.toEqual({
      status: "created",
      entity: gitlabEntity,
    });
    await expect(sdk.listChatGitlabEntities("chat-1")).resolves.toEqual({ items: [gitlabEntity] });
    await expect(sdk.unfollowGitlabEntity("chat-1", gitlabEntity.entityUrl)).resolves.toEqual({ removed: 1 });

    expect(fetchMock.mock.calls.map((call) => call[0])).toEqual([
      `${SERVER_URL}/api/v1/agent/chats/chat-1/gitlab-entities`,
      `${SERVER_URL}/api/v1/agent/chats/chat-1/gitlab-entities`,
      `${SERVER_URL}/api/v1/agent/chats/chat-1/gitlab-entities?entity=${encodeURIComponent(gitlabEntity.entityUrl)}`,
    ]);
    expect(requestInit(fetchMock, 0)).toMatchObject({
      method: "POST",
      body: JSON.stringify({ entityUrl: gitlabEntity.entityUrl }),
    });
    expect(requestInit(fetchMock, 2)).toMatchObject({ method: "DELETE" });
  });

  it("builds document wrapper paths, queries, and JSON bodies", async () => {
    const fetchMock = mockFetch(
      jsonResponse({ id: "doc-1", slug: "runbook", version: 1, createdDocument: true, createdVersion: true }),
      jsonResponse({ items: [{ id: "doc-1", slug: "runbook" }], nextCursor: "next-doc" }),
      jsonResponse({ id: "doc-1", slug: "runbook", version: { number: 3, content: "# Runbook" } }),
      jsonResponse({ id: "doc-1", status: "approved" }),
      jsonResponse({ items: [{ id: "comment-1", body: "Question" }], nextCursor: null }),
      jsonResponse({ id: "comment-1", body: "Looks good", status: "open" }),
      jsonResponse({ id: "comment-2", parentId: "comment-1", body: "Reply", status: "open" }),
      jsonResponse({ id: "comment-1", status: "resolved" }),
    );
    const sdk = makeSdk();

    await expect(
      sdk.publishDoc({
        slug: "runbook",
        title: "Runbook",
        project: null,
        content: "# Runbook",
        note: "Initial version",
        status: "draft",
        ifChanged: true,
      }),
    ).resolves.toMatchObject({ id: "doc-1", createdDocument: true });
    await expect(
      sdk.listDocs({
        slug: "runbook",
        project: "Core Docs",
        status: "in_review",
        limit: 25,
        cursor: "after value",
      }),
    ).resolves.toMatchObject({ nextCursor: "next-doc" });
    await expect(sdk.getDoc("doc / 1", { version: 3 })).resolves.toMatchObject({ id: "doc-1" });
    await expect(sdk.setDocStatus("doc / 1", "approved")).resolves.toMatchObject({ status: "approved" });
    await expect(sdk.listDocComments("doc / 1", { status: "open", versionNumber: 2 })).resolves.toMatchObject({
      nextCursor: null,
    });
    await expect(
      sdk.createDocComment("doc / 1", {
        body: "Looks good",
        versionNumber: 2,
        anchor: { exact: "Runbook", prefix: "# ", suffix: "\n" },
      }),
    ).resolves.toMatchObject({ id: "comment-1" });
    await expect(sdk.replyDocComment("comment / 1", "Reply")).resolves.toMatchObject({ parentId: "comment-1" });
    await expect(sdk.setDocCommentStatus("comment / 1", "resolved")).resolves.toMatchObject({ status: "resolved" });

    expect(fetchMock.mock.calls.map((call) => call[0])).toEqual([
      `${SERVER_URL}/api/v1/agent/documents`,
      `${SERVER_URL}/api/v1/agent/documents?slug=runbook&project=Core+Docs&status=in_review&limit=25&cursor=after+value`,
      `${SERVER_URL}/api/v1/agent/documents/doc%20%2F%201?version=3`,
      `${SERVER_URL}/api/v1/agent/documents/doc%20%2F%201`,
      `${SERVER_URL}/api/v1/agent/documents/doc%20%2F%201/comments?status=open&versionNumber=2`,
      `${SERVER_URL}/api/v1/agent/documents/doc%20%2F%201/comments`,
      `${SERVER_URL}/api/v1/agent/document-comments/comment%20%2F%201/replies`,
      `${SERVER_URL}/api/v1/agent/document-comments/comment%20%2F%201`,
    ]);
    expect(requestInit(fetchMock, 0)).toMatchObject({
      method: "POST",
      body: JSON.stringify({
        slug: "runbook",
        title: "Runbook",
        project: null,
        content: "# Runbook",
        note: "Initial version",
        status: "draft",
        ifChanged: true,
      }),
    });
    expect(requestInit(fetchMock, 3)).toMatchObject({
      method: "PATCH",
      body: JSON.stringify({ status: "approved" }),
    });
    expect(requestInit(fetchMock, 5)).toMatchObject({
      method: "POST",
      body: JSON.stringify({
        body: "Looks good",
        versionNumber: 2,
        anchor: { exact: "Runbook", prefix: "# ", suffix: "\n" },
      }),
    });
    expect(requestInit(fetchMock, 6)).toMatchObject({
      method: "POST",
      body: JSON.stringify({ body: "Reply" }),
    });
    expect(requestInit(fetchMock, 7)).toMatchObject({
      method: "PATCH",
      body: JSON.stringify({ status: "resolved" }),
    });
  });

  it("does not retry non-idempotent document writes on uncertain failures", async () => {
    const sdk = makeSdk();

    let fetchMock = mockFetch(textResponse("publish failed", 500), jsonResponse({ unreached: true }));
    await expect(sdk.publishDoc({ slug: "runbook", content: "# Runbook", ifChanged: false })).rejects.toMatchObject({
      statusCode: 500,
      message: "publish failed",
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    vi.unstubAllGlobals();
    fetchMock = mockFetch(textResponse("comment failed", 500), jsonResponse({ unreached: true }));
    await expect(sdk.createDocComment("doc-1", { body: "Question" })).rejects.toMatchObject({
      statusCode: 500,
      message: "comment failed",
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    vi.unstubAllGlobals();
    fetchMock = mockFetch(textResponse("reply failed", 500), jsonResponse({ unreached: true }));
    await expect(sdk.replyDocComment("comment-1", "Reply")).rejects.toMatchObject({
      statusCode: 500,
      message: "reply failed",
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("parses only structured follow conflicts and preserves other 409 errors", async () => {
    let fetchMock = mockFetch(
      jsonResponse(
        {
          error: "ENTITY_FOLLOWED_ELSEWHERE",
          message: "Already followed",
          conflict: { chatId: "chat-existing", topic: null },
        },
        409,
      ),
    );
    await expect(makeSdk().followGithubEntity("chat-1", { entity: "owner/repo#42" })).resolves.toEqual({
      ok: false,
      conflict: {
        error: "ENTITY_FOLLOWED_ELSEWHERE",
        message: "Already followed",
        conflict: { chatId: "chat-existing", topic: null },
      },
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    vi.unstubAllGlobals();
    fetchMock = mockFetch(textResponse("<html>conflict</html>", 409));
    await expect(makeSdk().followGithubEntity("chat-1", { entity: "owner/repo#42" })).rejects.toMatchObject({
      statusCode: 409,
      message: "<html>conflict</html>",
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    vi.unstubAllGlobals();
    fetchMock = mockFetch(jsonResponse({ error: "ENTITY_FOLLOWED_ELSEWHERE" }, 409));
    await expect(makeSdk().followGithubEntity("chat-1", { entity: "owner/repo#42" })).rejects.toMatchObject({
      statusCode: 409,
      message: "ENTITY_FOLLOWED_ELSEWHERE",
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    vi.unstubAllGlobals();
    fetchMock = mockFetch(jsonResponse({ error: "GitHub follow authority changed; retry" }, 409));
    await expect(makeSdk().followGithubEntity("chat-1", { entity: "owner/repo#42" })).rejects.toMatchObject({
      statusCode: 409,
      message: "GitHub follow authority changed; retry",
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    vi.unstubAllGlobals();
    fetchMock = mockFetch(jsonResponse({ error: "missing installation" }, 422));
    await expect(makeSdk().followGithubEntity("chat-1", { entity: "owner/repo#42" })).rejects.toMatchObject({
      statusCode: 422,
      message: "missing installation",
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("uploads and downloads attachments with metadata headers and filename fallbacks", async () => {
    const uploadBody = {
      id: "123e4567-e89b-12d3-a456-426614174000",
      mimeType: "image/png",
      filename: "screen shot.png",
      sizeBytes: 3,
      uploadedBy: "agent-1",
      createdAt: "2026-07-09T00:00:00.000Z",
    };
    const bytes = new Uint8Array([1, 2, 3]);
    const fetchMock = mockFetch(
      jsonResponse(uploadBody),
      binaryResponse(bytes, {
        "content-type": "image/png",
        "content-disposition": 'attachment; filename="screen%20shot.png"',
      }),
      binaryResponse(new Uint8Array([4])),
      binaryResponse(new Uint8Array([5]), {
        "content-disposition": 'attachment; filename="bad%ZZname.txt"',
      }),
    );
    const sdk = makeSdk();

    await expect(
      sdk.uploadAttachment({
        orgId: "org / 1",
        bytes,
        mimeType: "image/png",
        filename: "screen shot.png",
      }),
    ).resolves.toEqual(uploadBody);
    const downloaded = await sdk.fetchAttachment({ id: "att / 1" });
    expect(downloaded).toMatchObject({
      mimeType: "image/png",
      filename: "screen shot.png",
      size: 3,
    });
    expect(Buffer.compare(downloaded.bytes, Buffer.from([1, 2, 3]))).toBe(0);
    await expect(sdk.fetchAttachment({ id: "att-2" })).resolves.toMatchObject({
      mimeType: "application/octet-stream",
      filename: "blob",
      size: 1,
    });
    await expect(sdk.fetchAttachment({ id: "att-3" })).resolves.toMatchObject({
      filename: "bad%ZZname.txt",
      size: 1,
    });

    expect(fetchMock.mock.calls.map((call) => call[0])).toEqual([
      `${SERVER_URL}/api/v1/orgs/org%20%2F%201/attachments`,
      `${SERVER_URL}/api/v1/attachments/att%20%2F%201`,
      `${SERVER_URL}/api/v1/attachments/att-2`,
      `${SERVER_URL}/api/v1/attachments/att-3`,
    ]);
    expect(requestInit(fetchMock, 0)).toMatchObject({
      method: "POST",
      body: bytes,
      headers: expect.objectContaining({
        "Content-Type": "application/octet-stream",
        [ATTACHMENT_MIME_HEADER]: "image/png",
        [ATTACHMENT_FILENAME_HEADER]: "screen%20shot.png",
      }),
    });
  });

  it("rejects invalid upload metadata and maps attachment download errors", async () => {
    let fetchMock = mockFetch(jsonResponse({ id: "not-a-uuid" }));

    await expect(
      makeSdk().uploadAttachment({
        orgId: "org-1",
        bytes: new Uint8Array([1]),
        mimeType: "text/plain",
        filename: "note.txt",
      }),
    ).rejects.toThrow();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    vi.unstubAllGlobals();
    fetchMock = mockFetch(jsonResponse({ error: "attachment missing" }, 404));
    await expect(makeSdk().fetchAttachment({ id: "att-missing" })).rejects.toMatchObject({
      statusCode: 404,
      message: "attachment missing",
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("rejects overlong attachment filenames before upload transport", async () => {
    const fetchMock = mockFetch();
    await expect(
      makeSdk().uploadAttachment({
        orgId: "org-1",
        bytes: new Uint8Array([1]),
        mimeType: "text/plain",
        filename: ";".repeat(256),
      }),
    ).rejects.toThrow("Attachment filename exceeds maximum length");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("parses SDK errors, Retry-After dates, invalid Retry-After values, and invalid success JSON", async () => {
    vi.useFakeTimers({ now: new Date("2026-07-09T00:00:00.000Z") });

    mockFetch(
      jsonResponse({ error: "slow down" }, 429, { "retry-after": "Thu, 09 Jul 2026 00:00:10 GMT" }),
      textResponse("not json", 200, { "content-type": "application/json" }),
      jsonResponse({ error: "bad retry" }, 429, { "retry-after": "not a date" }),
    );
    const sdk = makeSdk();

    await expect(sdk.listChats()).rejects.toMatchObject({
      statusCode: 429,
      message: "slow down",
      retryAfter: "Thu, 09 Jul 2026 00:00:10 GMT",
      retryAfterMs: 10_000,
    });
    await expect(sdk.listChats()).rejects.toBeInstanceOf(SyntaxError);

    try {
      await sdk.listChats();
      throw new Error("expected listChats to reject");
    } catch (err) {
      expect(err).toBeInstanceOf(SdkError);
      if (!(err instanceof SdkError)) throw err;
      expect(err.retryAfter).toBe("not a date");
      expect(err.retryAfterMs).toBeUndefined();
    }
  });

  it("retries retryable HTTP and nested network failures but skips deterministic network errors", async () => {
    vi.useFakeTimers();
    applyClientLoggerConfig({ level: "silent", format: "json", destination: process.stderr, explicit: false });

    let fetchMock = vi
      .fn()
      .mockResolvedValueOnce(textResponse("busy-1", 503))
      .mockResolvedValueOnce(textResponse("busy-2", 503))
      .mockResolvedValueOnce(textResponse("busy-3", 503));
    vi.stubGlobal("fetch", fetchMock);
    await expect(flush(makeSdk().listChats())).rejects.toMatchObject({
      statusCode: 503,
      message: "busy-3",
    });
    expect(fetchMock).toHaveBeenCalledTimes(3);

    vi.unstubAllGlobals();
    const cause = Object.assign(new Error("temporary DNS failure"), { code: "EAI_AGAIN" });
    const nested = new Error("outer network wrapper", { cause });
    fetchMock = vi
      .fn()
      .mockRejectedValueOnce(nested)
      .mockResolvedValueOnce(jsonResponse({ items: [], nextCursor: null }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(flush(makeSdk().listChats())).resolves.toEqual({ items: [], nextCursor: null });
    expect(fetchMock).toHaveBeenCalledTimes(2);

    vi.unstubAllGlobals();
    const deterministic = Object.assign(new Error("host not found"), { code: "ENOTFOUND" });
    fetchMock = vi.fn().mockRejectedValueOnce(deterministic);
    vi.stubGlobal("fetch", fetchMock);
    await expect(makeSdk().listChats()).rejects.toBe(deterministic);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("uses startup timeout overrides and default request timeouts", async () => {
    const timeoutSpy = vi.spyOn(AbortSignal, "timeout").mockImplementation(() => new AbortController().signal);
    mockFetch(
      jsonResponse({ agentId: "agent-1", version: 1, payload: {} }),
      jsonResponse({ items: [], nextCursor: null }),
    );
    const sdk = makeSdk();

    await expect(sdk.fetchAgentConfig()).resolves.toMatchObject({ agentId: "agent-1" });
    await expect(sdk.listChats()).resolves.toEqual({ items: [], nextCursor: null });

    expect(timeoutSpy).toHaveBeenNthCalledWith(1, 5_000);
    expect(timeoutSpy).toHaveBeenNthCalledWith(2, 15_000);
  });

  it("checks anonymous health without requiring auth or user-agent headers", async () => {
    const fetchMock = mockFetch(new Response(null, { status: 204 }));
    const sdk = makeSdk({
      userAgent: undefined,
      getAccessToken: () => {
        throw new Error("health should not request auth");
      },
    });

    await expect(sdk.isHubReachable(25)).resolves.toBe(true);

    expect(fetchMock).toHaveBeenCalledWith(
      `${SERVER_URL}/api/v1/health`,
      expect.objectContaining({
        headers: {},
      }),
    );
  });
});
