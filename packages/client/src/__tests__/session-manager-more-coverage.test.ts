import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type AgentRuntimeConfig,
  encodeProviderRetryEventMessage,
  type InboxEntryWithMessage,
  type SessionEvent,
  type SessionState,
} from "@first-tree/shared";
import type pino from "pino";
import { describe, expect, it, vi } from "vitest";
import type { FirstTreeHubSDK } from "../cloud/sdk.js";
import type { AgentConfigCache } from "../runtime/agent-config-cache.js";
import { findAttachmentFile } from "../runtime/attachment-store.js";
import type { ContextTreeBinding } from "../runtime/bootstrap.js";
import type {
  AgentHandler,
  DeliveryToken,
  HandlerConfig,
  HandlerFactory,
  SessionContext,
  SessionMessage,
} from "../runtime/handler.js";
import { findImagePath } from "../runtime/image-store.js";
import { InboxDeliveryCoordinator } from "../runtime/inbox-delivery-coordinator.js";
import type { SubprocessProbe } from "../runtime/process-tree-probe.js";
import { SessionRuntime, type SessionRuntimeShutdownOptions } from "../runtime/session-runtime.js";
import { recordingLogger, silentLogger } from "./_logger-helpers.js";
import { mockEntry } from "./test-helpers.js";

function mockSdk(overrides: Record<string, unknown> = {}): FirstTreeHubSDK {
  return {
    register: vi.fn(),
    sendMessage: vi.fn().mockResolvedValue({ id: "msg-reply" }),
    postRuntimeNotice: vi.fn().mockResolvedValue({ id: "runtime-notice" }),
    sendToAgent: vi.fn().mockResolvedValue({ id: "msg-dm" }),
    getChatDetail: vi.fn().mockResolvedValue({ organizationId: "org-1" }),
    ...overrides,
  } as unknown as FirstTreeHubSDK;
}

function mockRuntimeConfig(): AgentRuntimeConfig {
  return {
    agentId: "agent-1",
    version: 1,
    updatedAt: "2026-01-01T00:00:00.000Z",
    updatedBy: "tester",
    payload: {
      kind: "claude-code",
      prompt: { append: "" },
      model: "",
      mcpServers: [],
      env: [],
      gitRepos: [],
      resourceSkills: [],
      reasoningEffort: "",
    },
  };
}

function mockAckEntry(): (entryId: number) => Promise<void> {
  return vi.fn<(entryId: number) => Promise<void>>().mockResolvedValue(undefined);
}

function createMockHandler(overrides: Partial<AgentHandler> = {}): AgentHandler {
  return {
    start: vi
      .fn()
      .mockResolvedValue({ sessionId: "session-id-mock", route: { kind: "owned" as const, mode: "queued" as const } }),
    resume: vi
      .fn()
      .mockResolvedValue({ sessionId: "session-id-mock", route: { kind: "owned" as const, mode: "queued" as const } }),
    inject: vi.fn().mockReturnValue({ kind: "owned", mode: "queued" }),
    suspend: vi.fn().mockResolvedValue(undefined),
    shutdown: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

function createSessionRuntime(opts: {
  sdk?: FirstTreeHubSDK;
  handler?: AgentHandler;
  handlerConfig?: HandlerConfig;
  handlerFactory?: HandlerFactory;
  resolveContextTreeBinding?: () => Promise<ContextTreeBinding | null>;
  ackEntry?: (entryId: number) => Promise<void>;
  recoverChat?: (chatId: string) => Promise<void>;
  agentConfigCache?: AgentConfigCache;
  log?: pino.Logger;
  registryPath?: string;
  onStateChange?: (chatId: string, state: SessionState) => void;
  onSessionEvent?: (chatId: string, event: SessionEvent) => void;
  subprocessProbe?: SubprocessProbe;
}) {
  const handler = opts.handler ?? createMockHandler();
  return new SessionRuntime({
    session: {
      idle_timeout: 300,
      max_sessions: 10,
      working_grace_seconds: 3600,
      reconcile_interval_seconds: 300,
    },
    concurrency: 5,
    subprocessProbe: opts.subprocessProbe,
    handlerFactory: opts.handlerFactory ?? (() => handler),
    handlerConfig: opts.handlerConfig ?? { workspaceRoot: "/tmp/test", runtimeProvider: "codex" },
    resolveContextTreeBinding: opts.resolveContextTreeBinding ?? (async () => null),
    agentIdentity: {
      agentId: "agent-1",
      inboxId: "inbox-agent-1",
      displayName: "Agent",
      type: "agent",
      visibility: "organization",
      delegateMention: null,
      metadata: {},
    },
    sdk: opts.sdk ?? mockSdk(),
    log: opts.log ?? silentLogger(),
    registryPath: opts.registryPath,
    ackEntry: opts.ackEntry ?? mockAckEntry(),
    recoverChat: opts.recoverChat,
    agentConfigCache: opts.agentConfigCache,
    onStateChange: opts.onStateChange,
    onSessionEvent: opts.onSessionEvent,
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toSessionMessage(entry: InboxEntryWithMessage): SessionMessage {
  return {
    inboxEntryId: entry.id,
    id: entry.message.id,
    chatId: entry.chatId ?? entry.message.chatId,
    senderId: entry.message.senderId,
    format: entry.message.format,
    content:
      typeof entry.message.content === "string"
        ? entry.message.content
        : isRecord(entry.message.content)
          ? entry.message.content
          : {},
    metadata: entry.message.metadata,
    createdAt: entry.message.createdAt,
    precedingMessages: entry.message.precedingMessages ?? [],
  };
}

function malformedProviderRetryEvent(): SessionEvent {
  return {
    kind: "error",
    payload: {
      source: "runtime",
      message: "provider.retry: {not valid json",
    },
  };
}

describe("InboxDeliveryCoordinator additional delivery coverage", () => {
  it("returns recovering while recovery debt is outstanding and ignores completions without entry ids", async () => {
    const { logger, records } = recordingLogger();
    const coordinator = new InboxDeliveryCoordinator({
      ackEntry: mockAckEntry(),
      onWorkChanged: vi.fn(),
      log: logger,
    });
    const entry = mockEntry({ id: 10, chatId: "chat-recovery-required", messageId: "msg-recovery-required" });
    const next = mockEntry({ id: 11, chatId: "chat-recovery-required", messageId: "msg-recovery-next" });
    const message = toSessionMessage(entry);

    expect(coordinator.receive(entry).kind).toBe("deliver");
    coordinator.retryTurn("chat-recovery-required", message, "provider_retry");

    await vi.waitFor(() => expect(coordinator.snapshot("chat-recovery-required").recoveryDebt).toBe("required"));
    expect(coordinator.receive(next)).toEqual({ kind: "recovering" });

    await coordinator.finishTurn(
      "chat-recovery-required",
      { ...message, inboxEntryId: undefined },
      {
        status: "success",
        terminal: true,
      },
    );
    expect(
      records.some(
        (record) =>
          typeof record.msg === "string" &&
          record.msg.includes("turn completion ignored because no inboxEntryId was provided"),
      ),
    ).toBe(true);
  });

  it("deduplicates in-flight message redelivery and reports settled versus lost ownership", async () => {
    const ackEntry = mockAckEntry();
    const coordinator = new InboxDeliveryCoordinator({
      ackEntry,
      onWorkChanged: vi.fn(),
      log: silentLogger(),
    });
    const first = mockEntry({ id: 20, chatId: "chat-dedup", messageId: "msg-same" });
    const duplicateMessage = mockEntry({ id: 21, chatId: "chat-dedup", messageId: "msg-same" });
    const message = toSessionMessage(first);

    const decision = coordinator.receive(first);
    expect(decision.kind).toBe("deliver");
    expect(coordinator.receive(duplicateMessage)).toEqual({ kind: "duplicate-in-flight" });
    expect(coordinator.markOwned({ chatId: "chat-dedup", entryId: 999, messageId: "missing" })).toBe("lost");

    await coordinator.finishTurn("chat-dedup", message, { status: "success", terminal: true });

    expect(ackEntry).toHaveBeenCalledWith(20);
    expect(coordinator.markOwned({ chatId: "chat-dedup", entryId: 20, messageId: "msg-same" })).toBe("settled");
  });

  it("blocks ACK-through when a completion skips a non-terminal prefix", async () => {
    const { logger, records } = recordingLogger();
    const ackEntry = mockAckEntry();
    const coordinator = new InboxDeliveryCoordinator({
      ackEntry,
      onWorkChanged: vi.fn(),
      log: logger,
    });
    const first = mockEntry({ id: 30, chatId: "chat-prefix-gap", messageId: "msg-prefix-first" });
    const second = mockEntry({ id: 31, chatId: "chat-prefix-gap", messageId: "msg-prefix-second" });

    expect(coordinator.receive(first).kind).toBe("deliver");
    expect(coordinator.receive(second).kind).toBe("deliver");
    await coordinator.finishTurn("chat-prefix-gap", toSessionMessage(second), { status: "success", terminal: true });

    expect(ackEntry).not.toHaveBeenCalled();
    expect(coordinator.snapshot("chat-prefix-gap")).toMatchObject({
      entries: [
        { entryId: 30, messageId: "msg-prefix-first", phase: "open" },
        { entryId: 31, messageId: "msg-prefix-second", phase: "terminal" },
      ],
      recoveryDebt: "required",
    });
    expect(
      records.some(
        (record) =>
          typeof record.msg === "string" &&
          record.msg.includes("ACK-through blocked because delivery prefix has non-terminal entries"),
      ),
    ).toBe(true);
  });

  it("logs untracked ACK-through attempts without mutating the active ledger", async () => {
    const { logger, records } = recordingLogger();
    const ackEntry = mockAckEntry();
    const coordinator = new InboxDeliveryCoordinator({
      ackEntry,
      onWorkChanged: vi.fn(),
      log: logger,
    });
    const entry = mockEntry({ id: 40, chatId: "chat-untracked-ack", messageId: "msg-present" });
    const untrackedMessage: SessionMessage = {
      ...toSessionMessage(entry),
      id: "msg-missing",
      inboxEntryId: 999,
    };

    expect(coordinator.receive(entry).kind).toBe("deliver");
    await coordinator.finishTurn("chat-untracked-ack", untrackedMessage, { status: "success", terminal: true });

    expect(ackEntry).not.toHaveBeenCalled();
    expect(coordinator.snapshot("chat-untracked-ack").entries).toEqual([
      { entryId: 40, messageId: "msg-present", phase: "open" },
    ]);
    expect(
      records.some(
        (record) =>
          typeof record.msg === "string" && record.msg.includes("attempt completion ignored for untracked inbox entry"),
      ),
    ).toBe(true);
  });

  it("acks terminal prefixes before suspending or terminating non-terminal tails", async () => {
    const ackEntry = vi
      .fn<(entryId: number) => Promise<void>>()
      .mockRejectedValueOnce(new Error("hold terminal entry"))
      .mockResolvedValue(undefined);
    const recoverChat = vi.fn<(chatId: string) => Promise<void>>().mockResolvedValue(undefined);
    const coordinator = new InboxDeliveryCoordinator({
      ackEntry,
      recoverChat,
      onWorkChanged: vi.fn(),
      log: silentLogger(),
    });
    const first = mockEntry({ id: 50, chatId: "chat-terminal-prefix", messageId: "msg-terminal" });
    const second = mockEntry({ id: 51, chatId: "chat-terminal-prefix", messageId: "msg-tail" });

    expect(coordinator.receive(first).kind).toBe("deliver");
    await coordinator.finishTurn("chat-terminal-prefix", toSessionMessage(first), {
      status: "success",
      terminal: true,
    });
    await vi.waitFor(() => expect(recoverChat).toHaveBeenCalledWith("chat-terminal-prefix"));
    expect(coordinator.snapshot("chat-terminal-prefix").entries).toEqual([
      { entryId: 50, messageId: "msg-terminal", phase: "terminal" },
    ]);

    expect(coordinator.receive(second).kind).toBe("deliver");
    await coordinator.prepareSuspend("chat-terminal-prefix", "operator_suspend");

    expect(ackEntry).toHaveBeenNthCalledWith(2, 50);
    expect(recoverChat).toHaveBeenCalledTimes(2);
    expect(coordinator.snapshot("chat-terminal-prefix")).toMatchObject({ entries: [], recoveryDebt: "none" });

    expect(coordinator.takeRecoveryActivationReady("chat-terminal-prefix")).toBe(true);
    expect(coordinator.receive(second).kind).toBe("deliver");
    await coordinator.drainForTerminate("chat-terminal-prefix");
    expect(recoverChat).toHaveBeenCalledTimes(3);
    expect(coordinator.snapshot("chat-terminal-prefix").recoveryDebt).toBe("none");
  });

  it("retains terminal ledger entries after ACK failure and re-ACKs terminal redelivery", async () => {
    const { logger, records } = recordingLogger();
    const ackEntry = vi
      .fn<(entryId: number) => Promise<void>>()
      .mockRejectedValueOnce(new Error("ack socket closed"))
      .mockResolvedValue(undefined);
    const recoverChat = vi.fn<(chatId: string) => Promise<void>>().mockResolvedValue(undefined);
    const coordinator = new InboxDeliveryCoordinator({
      ackEntry,
      recoverChat,
      onWorkChanged: vi.fn(),
      log: logger,
    });
    const entry = mockEntry({ id: 100, chatId: "chat-ack-fail", messageId: "msg-ack-fail" });
    const message = toSessionMessage(entry);

    expect(coordinator.receive(entry)).toEqual({
      kind: "deliver",
      work: { chatId: "chat-ack-fail", entryId: 100, messageId: "msg-ack-fail" },
    });
    await coordinator.finishTurn("chat-ack-fail", message, { status: "success", terminal: true });

    await vi.waitFor(() => expect(recoverChat).toHaveBeenCalledWith("chat-ack-fail"));
    expect(ackEntry).toHaveBeenCalledTimes(1);
    expect(coordinator.snapshot("chat-ack-fail").entries).toEqual([
      { entryId: 100, messageId: "msg-ack-fail", phase: "terminal" },
    ]);
    expect(records.some((record) => typeof record.msg === "string" && record.msg.includes("ACK-through failed"))).toBe(
      true,
    );

    expect(coordinator.receive(entry)).toEqual({ kind: "duplicate-in-flight" });
    await vi.waitFor(() => expect(ackEntry).toHaveBeenCalledTimes(2));
    expect(ackEntry).toHaveBeenNthCalledWith(2, 100);
    expect(coordinator.snapshot("chat-ack-fail").entries).toEqual([]);
  });

  it("releases terminal ledger when recover proves unackedOutstanding is 0", async () => {
    const ackEntry = vi.fn<(entryId: number) => Promise<void>>().mockRejectedValue(new Error("ack confirm lost"));
    const recoverChat = vi
      .fn<(chatId: string) => Promise<{ unackedOutstanding: number }>>()
      .mockResolvedValue({ unackedOutstanding: 0 });
    const onDeliveriesCommitted = vi.fn();
    const coordinator = new InboxDeliveryCoordinator({
      ackEntry,
      recoverChat,
      onWorkChanged: vi.fn(),
      onDeliveriesCommitted,
      log: silentLogger(),
    });
    const entry = mockEntry({ id: 110, chatId: "chat-ack-committed", messageId: "msg-ack-committed" });
    const message = toSessionMessage(entry);

    expect(coordinator.receive(entry).kind).toBe("deliver");
    await coordinator.finishTurn("chat-ack-committed", message, { status: "success", terminal: true });

    await vi.waitFor(() => expect(recoverChat).toHaveBeenCalledWith("chat-ack-committed"));
    await vi.waitFor(() => expect(coordinator.snapshot("chat-ack-committed").entries).toEqual([]));
    expect(coordinator.snapshot("chat-ack-committed").recoveryDebt).toBe("none");
    expect(coordinator.hasRecoveryDebt("chat-ack-committed")).toBe(false);
    expect(coordinator.takeRecoveryActivationReady("chat-ack-committed")).toBe(false);
    expect(onDeliveriesCommitted).toHaveBeenCalledWith("chat-ack-committed", ["msg-ack-committed"]);
    expect(coordinator.markOwned({ chatId: "chat-ack-committed", entryId: 110, messageId: "msg-ack-committed" })).toBe(
      "settled",
    );
    expect(coordinator.receive(entry)).toEqual({ kind: "duplicate-in-flight" });
    expect(ackEntry).toHaveBeenCalledTimes(1);
  });

  it.each([
    { name: "unackedOutstanding is 1", result: { unackedOutstanding: 1 } },
    { name: "old servers omit unackedOutstanding", result: undefined },
  ])("retains terminal ledger when recovery $name and re-ACKs redelivery", async ({ result }) => {
    const ackEntry = vi
      .fn<(entryId: number) => Promise<void>>()
      .mockRejectedValueOnce(new Error("ack confirm lost"))
      .mockResolvedValue(undefined);
    const recoverChat = vi.fn<(chatId: string) => Promise<unknown>>().mockResolvedValue(result);
    const onDeliveriesCommitted = vi.fn();
    const coordinator = new InboxDeliveryCoordinator({
      ackEntry,
      recoverChat,
      onWorkChanged: vi.fn(),
      onDeliveriesCommitted,
      log: silentLogger(),
    });
    const entry = mockEntry({ id: 111, chatId: "chat-ack-unsettled", messageId: "msg-ack-unsettled" });

    expect(coordinator.receive(entry).kind).toBe("deliver");
    await coordinator.finishTurn("chat-ack-unsettled", toSessionMessage(entry), { status: "success", terminal: true });

    await vi.waitFor(() => expect(recoverChat).toHaveBeenCalledWith("chat-ack-unsettled"));
    expect(coordinator.snapshot("chat-ack-unsettled").entries).toEqual([
      { entryId: 111, messageId: "msg-ack-unsettled", phase: "terminal" },
    ]);
    expect(onDeliveriesCommitted).not.toHaveBeenCalled();

    expect(coordinator.receive(entry)).toEqual({ kind: "duplicate-in-flight" });
    await vi.waitFor(() => expect(ackEntry).toHaveBeenCalledTimes(2));
    expect(ackEntry).toHaveBeenNthCalledWith(2, 111);
    expect(coordinator.snapshot("chat-ack-unsettled").entries).toEqual([]);
    expect(onDeliveriesCommitted).toHaveBeenCalledWith("chat-ack-unsettled", ["msg-ack-unsettled"]);
  });

  it("retries ACK settlement on rebind after recover fails because the socket is closing", async () => {
    const ackEntry = vi.fn<(entryId: number) => Promise<void>>().mockRejectedValue(new Error("inbox ack timeout"));
    const recoverChat = vi
      .fn<(chatId: string) => Promise<unknown>>()
      .mockRejectedValueOnce(new Error("inbox:recover unavailable; socket not bound"))
      .mockResolvedValueOnce({ unackedOutstanding: 0 });
    const onDeliveriesCommitted = vi.fn();
    const coordinator = new InboxDeliveryCoordinator({
      ackEntry,
      recoverChat,
      onWorkChanged: vi.fn(),
      onDeliveriesCommitted,
      log: silentLogger(),
    });
    const entry = mockEntry({ id: 120, chatId: "chat-ack-rebind-zero", messageId: "msg-ack-rebind-zero" });

    expect(coordinator.receive(entry).kind).toBe("deliver");
    await coordinator.finishTurn("chat-ack-rebind-zero", toSessionMessage(entry), {
      status: "success",
      terminal: true,
    });

    await vi.waitFor(() => expect(recoverChat).toHaveBeenCalledTimes(1));
    expect(coordinator.snapshot("chat-ack-rebind-zero")).toMatchObject({
      entries: [{ entryId: 120, messageId: "msg-ack-rebind-zero", phase: "terminal" }],
      recoveryDebt: "required",
      needsAckSettlementReconcile: true,
    });
    expect(coordinator.takeRecoveryActivationReady("chat-ack-rebind-zero")).toBe(false);
    expect(onDeliveriesCommitted).not.toHaveBeenCalled();

    await coordinator.reconcileAckSettlementAfterBind();

    expect(recoverChat).toHaveBeenCalledTimes(2);
    expect(coordinator.snapshot("chat-ack-rebind-zero")).toMatchObject({
      entries: [],
      recoveryDebt: "none",
      needsAckSettlementReconcile: false,
    });
    expect(coordinator.hasRecoveryDebt("chat-ack-rebind-zero")).toBe(false);
    expect(coordinator.takeRecoveryActivationReady("chat-ack-rebind-zero")).toBe(false);
    expect(onDeliveriesCommitted).toHaveBeenCalledWith("chat-ack-rebind-zero", ["msg-ack-rebind-zero"]);
    expect(coordinator.receive(entry)).toEqual({ kind: "duplicate-in-flight" });
    expect(ackEntry).toHaveBeenCalledTimes(1);
  });

  it.each([
    { name: "unackedOutstanding is 1", result: { unackedOutstanding: 1 } },
    { name: "old servers omit unackedOutstanding", result: undefined },
  ])("keeps terminal after rebind recovery $name and re-ACKs redelivery", async ({ result }) => {
    const ackEntry = vi
      .fn<(entryId: number) => Promise<void>>()
      .mockRejectedValueOnce(new Error("inbox ack timeout"))
      .mockResolvedValue(undefined);
    const recoverChat = vi
      .fn<(chatId: string) => Promise<unknown>>()
      .mockRejectedValueOnce(new Error("inbox:recover unavailable; socket not bound"))
      .mockResolvedValueOnce(result);
    const onDeliveriesCommitted = vi.fn();
    const coordinator = new InboxDeliveryCoordinator({
      ackEntry,
      recoverChat,
      onWorkChanged: vi.fn(),
      onDeliveriesCommitted,
      log: silentLogger(),
    });
    const entry = mockEntry({ id: 121, chatId: "chat-ack-rebind-unsettled", messageId: "msg-ack-rebind-unsettled" });

    expect(coordinator.receive(entry).kind).toBe("deliver");
    await coordinator.finishTurn("chat-ack-rebind-unsettled", toSessionMessage(entry), {
      status: "success",
      terminal: true,
    });

    await vi.waitFor(() => expect(recoverChat).toHaveBeenCalledTimes(1));
    expect(coordinator.snapshot("chat-ack-rebind-unsettled").needsAckSettlementReconcile).toBe(true);

    await coordinator.reconcileAckSettlementAfterBind();

    expect(recoverChat).toHaveBeenCalledTimes(2);
    expect(coordinator.snapshot("chat-ack-rebind-unsettled")).toMatchObject({
      entries: [{ entryId: 121, messageId: "msg-ack-rebind-unsettled", phase: "terminal" }],
      needsAckSettlementReconcile: false,
    });
    expect(onDeliveriesCommitted).not.toHaveBeenCalled();

    expect(coordinator.receive(entry)).toEqual({ kind: "duplicate-in-flight" });
    await vi.waitFor(() => expect(ackEntry).toHaveBeenCalledTimes(2));
    expect(ackEntry).toHaveBeenNthCalledWith(2, 121);
    expect(coordinator.snapshot("chat-ack-rebind-unsettled").entries).toEqual([]);
    expect(onDeliveriesCommitted).toHaveBeenCalledWith("chat-ack-rebind-unsettled", ["msg-ack-rebind-unsettled"]);
  });

  it("keeps a recovery redelivery burst in recovery mode until unsettled work drains", async () => {
    const ackEntry = mockAckEntry();
    const recoverChat = vi.fn<(chatId: string) => Promise<void>>().mockResolvedValue(undefined);
    const coordinator = new InboxDeliveryCoordinator({
      ackEntry,
      recoverChat,
      onWorkChanged: vi.fn(),
      log: silentLogger(),
    });
    const first = mockEntry({ id: 201, chatId: "chat-redelivery-burst", messageId: "msg-redelivery-1" });
    const second = mockEntry({ id: 202, chatId: "chat-redelivery-burst", messageId: "msg-redelivery-2" });

    expect(coordinator.receive(first).kind).toBe("deliver");
    coordinator.retryTurn("chat-redelivery-burst", toSessionMessage(first), "provider_retry");
    await vi.waitFor(() => expect(recoverChat).toHaveBeenCalledWith("chat-redelivery-burst"));

    expect(coordinator.takeRecoveryActivationReady("chat-redelivery-burst")).toBe(true);
    expect(coordinator.receive(first).kind).toBe("deliver");
    expect(coordinator.takeRecoveryActivationReady("chat-redelivery-burst")).toBe(true);
    expect(coordinator.receive(second).kind).toBe("deliver");

    await coordinator.finishTurn("chat-redelivery-burst", [toSessionMessage(first), toSessionMessage(second)], {
      status: "success",
      terminal: true,
    });

    expect(ackEntry).toHaveBeenCalledTimes(1);
    expect(ackEntry).toHaveBeenCalledWith(202);
    expect(coordinator.takeRecoveryActivationReady("chat-redelivery-burst")).toBe(false);
  });

  it("logs and ignores terminal rejection payloads without an inbox entry id", async () => {
    const { logger, records } = recordingLogger();
    const ackEntry = mockAckEntry();
    const coordinator = new InboxDeliveryCoordinator({
      ackEntry,
      onWorkChanged: vi.fn(),
      log: logger,
    });
    const entry = mockEntry({ id: 301, chatId: "chat-malformed-terminal", messageId: "msg-malformed-terminal" });
    const message = toSessionMessage(entry);
    const malformedMessage: SessionMessage = { ...message, inboxEntryId: undefined };

    expect(coordinator.receive(entry).kind).toBe("deliver");
    await coordinator.terminalRejected("chat-malformed-terminal", malformedMessage, "deterministic_failure", {
      kind: "chat_message",
      messageId: "error-message-id",
    });

    expect(ackEntry).not.toHaveBeenCalled();
    expect(coordinator.snapshot("chat-malformed-terminal").entries).toEqual([
      { entryId: 301, messageId: "msg-malformed-terminal", phase: "open" },
    ]);
    expect(
      records.some(
        (record) =>
          typeof record.msg === "string" &&
          record.msg.includes("terminal rejection ignored because no inboxEntryId was provided"),
      ),
    ).toBe(true);
  });
});

describe("SessionRuntime additional delivery token and payload coverage", () => {
  it("logs and ignores duplicate terminal outcomes from one delivery token", async () => {
    const { logger, records } = recordingLogger();
    const ackEntry = mockAckEntry();
    let capturedToken: DeliveryToken | undefined;
    let capturedMessage: SessionMessage | undefined;
    const handler = createMockHandler({
      start: vi.fn(async (message, _ctx, token) => {
        capturedMessage = message;
        capturedToken = token;
        return { sessionId: "session-id-mock", route: { kind: "owned", mode: "queued" } as const };
      }),
    });
    const sm = createSessionRuntime({ handler, ackEntry, log: logger });

    await sm.dispatch(mockEntry({ id: 401, chatId: "chat-token-duplicate", messageId: "msg-token-duplicate" }));
    if (!capturedToken || !capturedMessage) throw new Error("delivery token was not captured");

    await capturedToken.complete(capturedMessage, { status: "success", terminal: true });
    await capturedToken.terminalRejected(capturedMessage, "late_terminal_rejection", {
      kind: "chat_message",
      messageId: "late-error-message",
    });

    expect(ackEntry).toHaveBeenCalledTimes(1);
    expect(ackEntry).toHaveBeenCalledWith(401);
    expect(
      records.some(
        (record) =>
          typeof record.msg === "string" &&
          record.msg.includes("delivery token terminal outcome ignored after prior outcome") &&
          record.action === "terminalRejected",
      ),
    ).toBe(true);

    await sm.shutdown();
  });

  it("retries terminalRejected instead of ACKing when the durable runtime notice cannot be posted", async () => {
    const ackEntry = mockAckEntry();
    const recoverChat = vi.fn<(chatId: string) => Promise<void>>().mockResolvedValue(undefined);
    const postRuntimeNotice = vi.fn().mockRejectedValue(new Error("notice write failed"));
    const sdk = mockSdk({ postRuntimeNotice });
    let capturedCtx: SessionContext | undefined;
    let capturedToken: DeliveryToken | undefined;
    let capturedMessage: SessionMessage | undefined;
    const emitted: SessionEvent[] = [];
    const handler = createMockHandler({
      start: vi.fn(async (message, ctx, token) => {
        capturedMessage = message;
        capturedCtx = ctx;
        capturedToken = token;
        return { sessionId: "session-id-mock", route: { kind: "owned", mode: "queued" } as const };
      }),
    });
    const sm = createSessionRuntime({
      handler,
      ackEntry,
      recoverChat,
      sdk,
      handlerConfig: { workspaceRoot: "/tmp/test", runtimeProvider: "codex" },
      onSessionEvent: (_chatId, event) => emitted.push(event),
    });

    await sm.dispatch(mockEntry({ id: 402, chatId: "chat-terminal-notice-fail", messageId: "msg-terminal-notice" }));
    if (!capturedCtx || !capturedToken || !capturedMessage) throw new Error("delivery token was not captured");

    capturedCtx.emitEvent({
      kind: "error",
      payload: {
        source: "runtime",
        message: encodeProviderRetryEventMessage({
          event: "provider_failure_terminal",
          provider: "codex",
          scope: "provider_turn",
          category: "credential",
          reasonCode: "provider_credential_required",
          replaySafety: "provider_entered",
          userSeverity: "error",
          messagePreview: "refresh token revoked",
        }),
      },
    });
    await capturedToken.terminalRejected(capturedMessage, "deterministic_pre_provider_failure", {
      kind: "chat_message",
      messageId: "runtime-notice-error",
    });

    expect(postRuntimeNotice).toHaveBeenCalledTimes(1);
    expect(ackEntry).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(recoverChat).toHaveBeenCalledWith("chat-terminal-notice-fail"));
    expect(
      emitted.some(
        (event) =>
          event.kind === "error" &&
          event.payload.source === "runtime" &&
          event.payload.message.includes("runtime failure notice delivery failed"),
      ),
    ).toBe(true);

    await sm.shutdown();
  });

  it("ignores malformed provider retry event payloads when completing a consumed error", async () => {
    const ackEntry = mockAckEntry();
    const postRuntimeNotice = vi.fn().mockResolvedValue({ id: "runtime-notice" });
    const sdk = mockSdk({ postRuntimeNotice });
    let capturedCtx: SessionContext | undefined;
    let capturedToken: DeliveryToken | undefined;
    let capturedMessage: SessionMessage | undefined;
    const handler = createMockHandler({
      start: vi.fn(async (message, ctx, token) => {
        capturedMessage = message;
        capturedCtx = ctx;
        capturedToken = token;
        return { sessionId: "session-id-mock", route: { kind: "owned", mode: "queued" } as const };
      }),
    });
    const sm = createSessionRuntime({ handler, ackEntry, sdk });

    await sm.dispatch(mockEntry({ id: 403, chatId: "chat-malformed-provider-event", messageId: "msg-malformed" }));
    if (!capturedCtx || !capturedToken || !capturedMessage) throw new Error("delivery token was not captured");

    capturedCtx.emitEvent(malformedProviderRetryEvent());
    await capturedToken.complete(capturedMessage, {
      status: "error",
      terminal: true,
      completion: "consumed",
      reason: "provider_clean_error",
    });

    expect(postRuntimeNotice).not.toHaveBeenCalled();
    expect(ackEntry).toHaveBeenCalledTimes(1);
    expect(ackEntry).toHaveBeenCalledWith(403);

    await sm.shutdown();
  });

  it("downloads document attachment refs to the local files store before routing", async () => {
    const home = mkdtempSync(join(tmpdir(), "session-manager-attachments-"));
    vi.stubEnv("FIRST_TREE_HOME", home);
    try {
      const fetchAttachment = vi.fn().mockResolvedValue({ bytes: Buffer.from("a,b\n1,2") });
      const sdk = mockSdk({ fetchAttachment });
      let capturedMessage: SessionMessage | undefined;
      const handler = createMockHandler({
        start: vi.fn(async (message) => {
          capturedMessage = message;
          return { sessionId: "session-id-mock", route: { kind: "owned" as const, mode: "queued" as const } };
        }),
      });
      const sm = createSessionRuntime({ handler, sdk });
      const attachmentId = "11111111-1111-4111-8111-111111111111";

      await sm.dispatch(
        mockEntry({
          id: 404,
          chatId: "chat-doc-attachment",
          messageId: "msg-doc-attachment",
          metadata: {
            attachments: [
              {
                attachmentId,
                kind: "file",
                mimeType: "text/csv",
                filename: "evidence.csv",
                size: 7,
              },
            ],
          },
        }),
      );

      expect(fetchAttachment).toHaveBeenCalledWith({ id: attachmentId });
      const path = findAttachmentFile("chat-doc-attachment", attachmentId, "evidence.csv");
      expect(path).not.toBeNull();
      if (!path) throw new Error("attachment file missing");
      expect(readFileSync(path, "utf-8")).toBe("a,b\n1,2");
      expect(capturedMessage?.metadata).toMatchObject({ attachments: [{ attachmentId, filename: "evidence.csv" }] });

      await sm.shutdown();
    } finally {
      vi.unstubAllEnvs();
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("routes malformed file payloads without eager attachment fetches", async () => {
    const fetchAttachment = vi.fn().mockResolvedValue({ bytes: Buffer.from("image bytes") });
    const sdk = mockSdk({ fetchAttachment });
    let capturedMessage: SessionMessage | undefined;
    const handler = createMockHandler({
      start: vi.fn(async (message) => {
        capturedMessage = message;
        return { sessionId: "session-id-mock", route: { kind: "owned" as const, mode: "queued" as const } };
      }),
    });
    const sm = createSessionRuntime({ handler, sdk });
    const base = mockEntry({ id: 404, chatId: "chat-malformed-file", messageId: "msg-malformed-file" });
    const malformedFileEntry: InboxEntryWithMessage = {
      ...base,
      message: {
        ...base.message,
        format: "file",
        content: { attachments: [{ imageId: "image-without-mime-type" }] },
      },
    };

    await sm.dispatch(malformedFileEntry);

    expect(fetchAttachment).not.toHaveBeenCalled();
    expect(handler.start).toHaveBeenCalledTimes(1);
    expect(capturedMessage?.format).toBe("file");
    expect(capturedMessage?.content).toEqual({ attachments: [{ imageId: "image-without-mime-type" }] });

    await sm.shutdown();
  });

  it("downloads and renders request images from production-reachable preceding context", async () => {
    const home = mkdtempSync(join(tmpdir(), "session-manager-request-images-"));
    vi.stubEnv("FIRST_TREE_HOME", home);
    try {
      const fetchAttachment = vi.fn().mockResolvedValue({ bytes: Buffer.from("image bytes") });
      const sdk = mockSdk({
        fetchAttachment,
        listChatParticipants: vi.fn().mockResolvedValue([]),
      });
      let capturedMessage: SessionMessage | undefined;
      let renderedContent = "";
      const handler = createMockHandler({
        start: vi.fn(async (message, ctx) => {
          capturedMessage = message;
          renderedContent = await ctx.formatInboundContent(message);
          return { sessionId: "session-id-mock", route: { kind: "owned" as const, mode: "queued" as const } };
        }),
      });
      const sm = createSessionRuntime({ handler, sdk });
      const imageId = "11111111-1111-4111-8111-111111111111";
      const base = mockEntry({ id: 405, chatId: "chat-request-image", messageId: "msg-request-image" });
      const requestEntry: InboxEntryWithMessage = {
        ...base,
        message: {
          ...base.message,
          format: "text",
          content: "@agent-1 please review the earlier decision",
          metadata: {},
          precedingMessages: [
            {
              id: "request-for-human",
              senderId: "agent-2",
              senderKind: "member",
              senderProvider: null,
              format: "request",
              content: "Which layout should ship?",
              metadata: {
                request: {},
                attachments: [
                  {
                    attachmentId: imageId,
                    kind: "image",
                    mimeType: "image/png",
                    filename: "decision.png",
                    size: 11,
                  },
                ],
              },
              createdAt: "2026-07-24T00:00:00.000Z",
            },
          ],
        },
      };

      await sm.dispatch(requestEntry);

      expect(fetchAttachment).toHaveBeenCalledWith({ id: imageId });
      const path = findImagePath("chat-request-image", imageId, "image/png");
      expect(path).not.toBeNull();
      expect(capturedMessage?.format).toBe("text");
      expect(capturedMessage?.content).toEqual(requestEntry.message.content);
      expect(renderedContent).toContain("[Earlier in chat — context you missed]");
      expect(renderedContent).toContain("Which layout should ship?");
      expect(renderedContent).toContain("Filename: decision.png");
      expect(renderedContent).toContain(`Path: ${path}`);

      await sm.shutdown();
    } finally {
      vi.unstubAllEnvs();
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("bounds preceding request-image fetches without consuming the budget for non-request images", async () => {
    const home = mkdtempSync(join(tmpdir(), "session-manager-bounded-images-"));
    vi.stubEnv("FIRST_TREE_HOME", home);
    try {
      const fetchAttachment = vi.fn().mockResolvedValue({ bytes: Buffer.from("image bytes") });
      const sdk = mockSdk({ fetchAttachment });
      let renderedContent = "";
      const handler = createMockHandler({
        start: vi.fn(async (message, ctx) => {
          renderedContent = await ctx.formatInboundContent(message);
          return { sessionId: "session-id-mock", route: { kind: "owned" as const, mode: "queued" as const } };
        }),
      });
      const sm = createSessionRuntime({ handler, sdk });
      const base = mockEntry({ id: 408, chatId: "chat-bounded-images", messageId: "msg-bounded-images" });
      const imageIds = Array.from(
        { length: 12 },
        (_, index) => `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
      );
      const nonRequestImageId = "99999999-9999-4999-8999-999999999999";
      const entry: InboxEntryWithMessage = {
        ...base,
        message: {
          ...base.message,
          format: "text",
          content: "@agent-1 review the recent context",
          precedingMessages: [
            ...imageIds.map((attachmentId, index) => ({
              id: `preceding-${index}`,
              senderId: "agent-2",
              senderKind: "member" as const,
              senderProvider: null,
              format: "request" as const,
              content: `Decision ${index}`,
              metadata: {
                request: {},
                attachments: [
                  {
                    attachmentId,
                    kind: "image",
                    mimeType: "image/png",
                    filename: `decision-${index}.png`,
                    size: 11,
                  },
                ],
              },
              createdAt: new Date(Date.UTC(2026, 6, 24, 0, 0, index)).toISOString(),
            })),
            {
              id: "newer-non-request-image",
              senderId: "agent-2",
              senderKind: "member",
              senderProvider: null,
              format: "text",
              content: "An unrelated image",
              metadata: {
                attachments: [
                  {
                    attachmentId: nonRequestImageId,
                    kind: "image",
                    mimeType: "image/png",
                    filename: "unrelated.png",
                    size: 11,
                  },
                ],
              },
              createdAt: "2026-07-24T00:01:00.000Z",
            },
          ],
        },
      };

      await sm.dispatch(entry);

      expect(fetchAttachment).toHaveBeenCalledTimes(10);
      const fetchedIds = fetchAttachment.mock.calls.map(([arg]) => (arg as { id: string }).id);
      expect(fetchedIds).toEqual(imageIds.slice(2).reverse());
      expect(fetchedIds).not.toContain(nonRequestImageId);
      expect(renderedContent).toContain("An unrelated image");
      expect(renderedContent).not.toContain("Filename: unrelated.png");

      await sm.shutdown();
    } finally {
      vi.unstubAllEnvs();
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("does not download batch-shaped content from non-image message formats", async () => {
    const fetchAttachment = vi.fn().mockResolvedValue({ bytes: Buffer.from("image bytes") });
    const sdk = mockSdk({ fetchAttachment });
    const handler = createMockHandler();
    const sm = createSessionRuntime({ handler, sdk });
    const base = mockEntry({ id: 409, chatId: "chat-card-batch", messageId: "msg-card-batch" });
    const cardEntry: InboxEntryWithMessage = {
      ...base,
      message: {
        ...base.message,
        format: "card",
        content: {
          caption: "card payload",
          attachments: [
            {
              imageId: "11111111-1111-4111-8111-111111111111",
              mimeType: "image/png",
              filename: "not-an-image-message.png",
            },
          ],
        },
      },
    };

    await sm.dispatch(cardEntry);

    expect(fetchAttachment).not.toHaveBeenCalled();
    expect(handler.start).toHaveBeenCalledTimes(1);
    await sm.shutdown();
  });

  it("logs config refresh failures but still routes the inbox payload", async () => {
    const { logger, records } = recordingLogger();
    const agentConfigCache: AgentConfigCache = {
      get: vi.fn(),
      refreshIfNewer: vi.fn().mockRejectedValue(new Error("config service unavailable")),
      refresh: vi.fn().mockResolvedValue(mockRuntimeConfig()),
      updateSdk: vi.fn(),
      updateUrls: vi.fn(),
      allReferencedUrls: vi.fn(() => new Set<string>()),
      forget: vi.fn(),
    };
    const handler = createMockHandler();
    const sm = createSessionRuntime({ handler, agentConfigCache, log: logger });

    await sm.dispatch(mockEntry({ id: 405, chatId: "chat-config-log", messageId: "msg-config-log" }));

    expect(handler.start).toHaveBeenCalledTimes(1);
    expect(
      records.some(
        (record) =>
          typeof record.msg === "string" &&
          record.msg.includes("config version mismatch") &&
          record.chatId === "chat-config-log",
      ),
    ).toBe(true);

    await sm.shutdown();
  });
});

describe("SessionRuntime additional shutdown and finalization coverage", () => {
  it("clears pending transient retry timers during shutdown", async () => {
    vi.useFakeTimers();
    try {
      const handlerFactory = vi.fn<HandlerFactory>(() =>
        createMockHandler({
          start: vi.fn(async () => {
            throw Object.assign(new Error("upstream returned 503"), { status: 503 });
          }),
        }),
      );
      const sm = createSessionRuntime({
        handlerFactory,
        handlerConfig: { workspaceRoot: "/tmp/test", runtimeProvider: "claude-code" },
      });

      await sm.dispatch(mockEntry({ id: 501, chatId: "chat-retry-shutdown", messageId: "msg-retry-shutdown" }));
      expect(handlerFactory).toHaveBeenCalledTimes(1);

      await sm.shutdown("test-shutdown");
      await vi.advanceTimersByTimeAsync(2_000);

      expect(handlerFactory).toHaveBeenCalledTimes(1);
      expect(sm.activeCount).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("can skip suspended-state reports and flush an empty registry on destructive shutdown", async () => {
    const dir = mkdtempSync(join(tmpdir(), "session-manager-more-coverage-"));
    const registryPath = join(dir, "sessions.json");
    const onStateChange = vi.fn<(chatId: string, state: SessionState) => void>();
    const handler = createMockHandler({
      start: vi.fn(async () => ({
        sessionId: "session-to-clear",
        route: { kind: "owned" as const, mode: "queued" as const },
      })),
      shutdown: vi.fn().mockRejectedValue(new Error("provider already closed")),
    });
    const sm = createSessionRuntime({ handler, registryPath, onStateChange });
    const opts: SessionRuntimeShutdownOptions = { clearPersistedRegistry: true, reportSuspendedSessions: false };

    try {
      await sm.dispatch(mockEntry({ id: 502, chatId: "chat-clear-registry", messageId: "msg-clear-registry" }));

      await expect(sm.shutdown("runtime-switch", opts)).resolves.toBeUndefined();

      const raw = JSON.parse(readFileSync(registryPath, "utf-8")) as {
        entries: Record<string, unknown>;
      };
      expect(raw.entries).toEqual({});
      expect(onStateChange).toHaveBeenCalledWith("chat-clear-registry", "active");
      expect(onStateChange).not.toHaveBeenCalledWith("chat-clear-registry", "suspended");
      expect(handler.shutdown).toHaveBeenCalledWith("runtime-switch", { settleProviderEntered: true });
      expect(sm.totalCount).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
