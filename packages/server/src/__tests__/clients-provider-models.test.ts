import crypto from "node:crypto";
import { eq } from "drizzle-orm";
import { describe, expect, it, vi } from "vitest";
import type { WebSocket } from "ws";
import { clients } from "../db/schema/clients.js";
import * as clientService from "../services/runtime/client.js";
import {
  cancelClientReply,
  removeClientConnection,
  resolveClientReply,
  setClientConnection,
  waitForClientReply,
} from "../services/runtime/connection-manager.js";
import {
  countModelCatalogRpcKeys,
  MODEL_CATALOG_RPC_MAX_ENTRIES,
  readModelCatalogRpcResult,
  storeModelCatalogRpcResult,
} from "../services/runtime/rpc/provider-models.js";
import { createAdminContext, useTestApp } from "./helpers.js";

function sampleCatalog(
  provider: "cursor" | "kimi-code" = "cursor",
  id = "auto",
): {
  provider: "cursor" | "kimi-code";
  models: Array<{ id: string; label: string; isDefault?: boolean }>;
  defaultModelId: string;
  fetchedAt: string;
  source: "provider-cli" | "provider-config";
  error: null;
} {
  return {
    provider,
    models: [{ id, label: id, isDefault: true }],
    defaultModelId: id,
    fetchedAt: new Date().toISOString(),
    source: provider === "cursor" ? "provider-cli" : "provider-config",
    error: null,
  };
}

/**
 * `GET /api/v1/clients/:clientId/providers/:provider/models` asks the connected
 * daemon for a host-local model catalog and waits for the correlated reply.
 */
describe("GET /clients/:clientId/providers/:provider/models", () => {
  const getApp = useTestApp();

  async function markClientOnInstance(app: ReturnType<typeof getApp>, clientId: string, instanceId: string) {
    await app.db.update(clients).set({ status: "connected", instanceId }).where(eq(clients.id, clientId));
  }

  it("forwards provider-models:list and returns the daemon catalog", async () => {
    const app = getApp();
    const admin = await createAdminContext(app, { username: `pm-${crypto.randomUUID().slice(0, 6)}` });
    await markClientOnInstance(app, admin.clientId, app.config.instanceId);
    const ws = { readyState: 1, send: vi.fn(), close: vi.fn() };
    setClientConnection(admin.clientId, ws as unknown as WebSocket);
    try {
      const pending = app.inject({
        method: "GET",
        url: `/api/v1/clients/${admin.clientId}/providers/cursor/models`,
        headers: { authorization: `Bearer ${admin.accessToken}` },
      });

      await vi.waitFor(() => {
        expect(ws.send).toHaveBeenCalled();
      });
      const frame = JSON.parse(String(ws.send.mock.calls[0]?.[0]));
      expect(frame).toMatchObject({ type: "provider-models:list", provider: "cursor" });
      expect(typeof frame.ref).toBe("string");

      const catalog = {
        provider: "cursor" as const,
        models: [{ id: "auto", label: "Auto", isDefault: true }],
        defaultModelId: "auto",
        fetchedAt: new Date().toISOString(),
        source: "provider-cli" as const,
        error: null,
      };
      expect(resolveClientReply(admin.clientId, frame.ref, catalog)).toBe(true);

      const res = await pending;
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject(catalog);
    } finally {
      removeClientConnection(admin.clientId, ws as unknown as WebSocket);
    }
  });

  it("forwards provider-models:list for grok and returns the daemon catalog", async () => {
    const app = getApp();
    const admin = await createAdminContext(app, { username: `pm-${crypto.randomUUID().slice(0, 6)}` });
    await markClientOnInstance(app, admin.clientId, app.config.instanceId);
    const ws = { readyState: 1, send: vi.fn(), close: vi.fn() };
    setClientConnection(admin.clientId, ws as unknown as WebSocket);
    try {
      const pending = app.inject({
        method: "GET",
        url: `/api/v1/clients/${admin.clientId}/providers/grok/models`,
        headers: { authorization: `Bearer ${admin.accessToken}` },
      });

      await vi.waitFor(() => {
        expect(ws.send).toHaveBeenCalled();
      });
      const frame = JSON.parse(String(ws.send.mock.calls[0]?.[0]));
      expect(frame).toMatchObject({ type: "provider-models:list", provider: "grok" });

      const catalog = {
        provider: "grok" as const,
        models: [{ id: "grok-code-fast-1", label: "grok-code-fast-1", isDefault: true }],
        defaultModelId: "grok-code-fast-1",
        fetchedAt: new Date().toISOString(),
        source: "provider-cli" as const,
        error: null,
      };
      expect(resolveClientReply(admin.clientId, frame.ref, catalog)).toBe(true);

      const res = await pending;
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject(catalog);
    } finally {
      removeClientConnection(admin.clientId, ws as unknown as WebSocket);
    }
  });

  it("returns 502 when the daemon is not connected", async () => {
    const app = getApp();
    const admin = await createAdminContext(app, { username: `pm-${crypto.randomUUID().slice(0, 6)}` });
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/clients/${admin.clientId}/providers/kimi-code/models`,
      headers: { authorization: `Bearer ${admin.accessToken}` },
    });
    expect(res.statusCode).toBe(502);
  });

  it("fans the reverse command to the DB-authoritative instance when remote", async () => {
    const app = getApp();
    const admin = await createAdminContext(app, { username: `pm-${crypto.randomUUID().slice(0, 6)}` });
    await markClientOnInstance(app, admin.clientId, "replica-other");

    const notifyCommand = vi.spyOn(app.notifier, "notifyDaemonClientCommand").mockResolvedValue();

    const pending = app.inject({
      method: "GET",
      url: `/api/v1/clients/${admin.clientId}/providers/cursor/models`,
      headers: { authorization: `Bearer ${admin.accessToken}` },
    });

    await vi.waitFor(() => {
      expect(notifyCommand).toHaveBeenCalled();
    });
    const command = notifyCommand.mock.calls[0]?.[0];
    expect(command).toMatchObject({
      type: "provider-models:list",
      clientId: admin.clientId,
      provider: "cursor",
      targetInstanceId: "replica-other",
    });
    expect(typeof command?.ref).toBe("string");
    const ref = command?.ref;
    if (!ref) throw new Error("expected notifyDaemonClientCommand ref");

    const catalog = {
      provider: "cursor" as const,
      models: [{ id: "auto", label: "Auto", isDefault: true }],
      defaultModelId: "auto",
      fetchedAt: new Date().toISOString(),
      source: "provider-cli" as const,
      error: null,
    };
    await storeModelCatalogRpcResult(app.db, admin.clientId, ref, catalog, "replica-other");
    expect(await readModelCatalogRpcResult(app.db, admin.clientId, ref)).toMatchObject(catalog);
    expect(resolveClientReply(admin.clientId, ref, catalog)).toBe(true);

    const res = await pending;
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject(catalog);
    notifyCommand.mockRestore();
  });

  it("does not deliver on a stale local socket after instance takeover", async () => {
    const app = getApp();
    const admin = await createAdminContext(app, { username: `pm-${crypto.randomUUID().slice(0, 6)}` });
    // DB says another replica owns the connection, but this process still has a socket.
    await markClientOnInstance(app, admin.clientId, "replica-other");
    const staleWs = { readyState: 1, send: vi.fn(), close: vi.fn() };
    setClientConnection(admin.clientId, staleWs as unknown as WebSocket);

    const notifyCommand = vi.spyOn(app.notifier, "notifyDaemonClientCommand").mockResolvedValue();
    try {
      const pending = app.inject({
        method: "GET",
        url: `/api/v1/clients/${admin.clientId}/providers/cursor/models`,
        headers: { authorization: `Bearer ${admin.accessToken}` },
      });

      await vi.waitFor(() => {
        expect(notifyCommand).toHaveBeenCalled();
      });
      expect(staleWs.send).not.toHaveBeenCalled();
      expect(notifyCommand.mock.calls[0]?.[0]).toMatchObject({
        targetInstanceId: "replica-other",
        clientId: admin.clientId,
      });

      const ref = notifyCommand.mock.calls[0]?.[0]?.ref;
      if (!ref) throw new Error("expected ref");
      const catalog = {
        provider: "cursor" as const,
        models: [{ id: "auto", label: "Auto" }],
        defaultModelId: "auto",
        fetchedAt: new Date().toISOString(),
        source: "provider-cli" as const,
        error: null,
      };
      expect(resolveClientReply(admin.clientId, ref, catalog)).toBe(true);
      const res = await pending;
      expect(res.statusCode).toBe(200);
    } finally {
      notifyCommand.mockRestore();
      removeClientConnection(admin.clientId, staleWs as unknown as WebSocket);
    }
  });

  it("resolves a remote waiter from metadata after a result wake", async () => {
    const app = getApp();
    const admin = await createAdminContext(app, { username: `pm-${crypto.randomUUID().slice(0, 6)}` });
    await markClientOnInstance(app, admin.clientId, app.config.instanceId);
    const ref = crypto.randomUUID();
    const catalog = sampleCatalog("kimi-code", "gemini-3-pro-preview");

    const replyPromise = waitForClientReply(admin.clientId, ref);
    expect(await storeModelCatalogRpcResult(app.db, admin.clientId, ref, catalog, app.config.instanceId)).toBe(true);
    await app.notifier.notifyDaemonClientCommandResult({ clientId: admin.clientId, ref });

    await expect(replyPromise).resolves.toMatchObject(catalog);
  });

  it("returns a stored catalog when the result wake is lost", async () => {
    const app = getApp();
    const admin = await createAdminContext(app, { username: `pm-${crypto.randomUUID().slice(0, 6)}` });
    await markClientOnInstance(app, admin.clientId, app.config.instanceId);

    const ws = { readyState: 1, send: vi.fn(), close: vi.fn() };
    setClientConnection(admin.clientId, ws as unknown as WebSocket);
    try {
      const pending = app.inject({
        method: "GET",
        url: `/api/v1/clients/${admin.clientId}/providers/cursor/models`,
        headers: { authorization: `Bearer ${admin.accessToken}` },
      });

      await vi.waitFor(() => {
        expect(ws.send).toHaveBeenCalled();
      });
      const frame = JSON.parse(String(ws.send.mock.calls[0]?.[0]));
      const catalog = sampleCatalog("cursor", "auto");
      // Durable store arrives, but no resolveClientReply / result NOTIFY (lost wake).
      expect(await storeModelCatalogRpcResult(app.db, admin.clientId, frame.ref, catalog, app.config.instanceId)).toBe(
        true,
      );
      // Expire the waiter only after the write commits so the fallback is
      // deterministic even when the full suite puts the database under load.
      cancelClientReply(admin.clientId, frame.ref, new Error("Timed out waiting for the computer to reply"));

      const res = await pending;
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject(catalog);
    } finally {
      removeClientConnection(admin.clientId, ws as unknown as WebSocket);
    }
  });

  it("stores concurrent refs without clobbering sibling metadata", async () => {
    const app = getApp();
    const admin = await createAdminContext(app, { username: `pm-${crypto.randomUUID().slice(0, 6)}` });
    await markClientOnInstance(app, admin.clientId, app.config.instanceId);

    const detectedAt = new Date().toISOString();
    await clientService.updateClientCapabilities(app.db, admin.clientId, {
      cursor: { state: "ok", available: true, detectedAt, sdkVersion: "1.0.0" },
    });

    const ref1 = crypto.randomUUID();
    const ref2 = crypto.randomUUID();
    const cat1 = sampleCatalog("cursor", "auto");
    const cat2 = sampleCatalog("kimi-code", "k3");

    const [ok1, ok2] = await Promise.all([
      storeModelCatalogRpcResult(app.db, admin.clientId, ref1, cat1, app.config.instanceId),
      storeModelCatalogRpcResult(app.db, admin.clientId, ref2, cat2, app.config.instanceId),
    ]);
    expect(ok1).toBe(true);
    expect(ok2).toBe(true);

    expect(await readModelCatalogRpcResult(app.db, admin.clientId, ref1)).toMatchObject(cat1);
    expect(await readModelCatalogRpcResult(app.db, admin.clientId, ref2)).toMatchObject(cat2);

    await clientService.updateClientCapabilities(app.db, admin.clientId, {
      cursor: { state: "ok", available: true, detectedAt, sdkVersion: "1.0.1" },
      "kimi-code": { state: "ok", available: true, detectedAt },
    });

    expect(await readModelCatalogRpcResult(app.db, admin.clientId, ref1)).toMatchObject(cat1);
    expect(await readModelCatalogRpcResult(app.db, admin.clientId, ref2)).toMatchObject(cat2);

    const row = await clientService.getClient(app.db, admin.clientId);
    expect(clientService.extractCapabilities(row?.metadata)).toMatchObject({
      cursor: { available: true, sdkVersion: "1.0.1" },
      "kimi-code": { available: true },
    });
  });

  it("refuses durable write when instance ownership moved (takeover TOCTOU)", async () => {
    const app = getApp();
    const admin = await createAdminContext(app, { username: `pm-${crypto.randomUUID().slice(0, 6)}` });
    await markClientOnInstance(app, admin.clientId, "replica-a");
    const ref = crypto.randomUUID();
    const catalog = sampleCatalog();

    expect(await storeModelCatalogRpcResult(app.db, admin.clientId, ref, catalog, "replica-a")).toBe(true);
    expect(await readModelCatalogRpcResult(app.db, admin.clientId, ref)).toMatchObject(catalog);

    // Ownership moves to another replica before the old owner would persist.
    await markClientOnInstance(app, admin.clientId, "replica-b");
    const orphanRef = crypto.randomUUID();
    expect(await storeModelCatalogRpcResult(app.db, admin.clientId, orphanRef, catalog, "replica-a")).toBe(false);
    expect(await readModelCatalogRpcResult(app.db, admin.clientId, orphanRef)).toBeNull();
    // Prior authoritative write remains.
    expect(await readModelCatalogRpcResult(app.db, admin.clientId, ref)).toMatchObject(catalog);
  });

  it("physically bounds stored rendezvous refs under sequential writes", async () => {
    const app = getApp();
    const admin = await createAdminContext(app, { username: `pm-${crypto.randomUUID().slice(0, 6)}` });
    await markClientOnInstance(app, admin.clientId, app.config.instanceId);

    const refs: string[] = [];
    for (let i = 0; i < MODEL_CATALOG_RPC_MAX_ENTRIES + 8; i++) {
      const ref = crypto.randomUUID();
      refs.push(ref);
      expect(
        await storeModelCatalogRpcResult(
          app.db,
          admin.clientId,
          ref,
          sampleCatalog("cursor", `m-${i}`),
          app.config.instanceId,
        ),
      ).toBe(true);
    }

    const keyCount = await countModelCatalogRpcKeys(app.db, admin.clientId);
    expect(keyCount).toBeLessThanOrEqual(MODEL_CATALOG_RPC_MAX_ENTRIES);
    expect(keyCount).toBeGreaterThan(0);

    // Oldest sequential refs should have been pruned out of durable storage.
    const oldest = refs.slice(0, 8);
    for (const ref of oldest) {
      expect(await readModelCatalogRpcResult(app.db, admin.clientId, ref)).toBeNull();
    }
    // Newest ref must still be readable.
    const newest = refs[refs.length - 1];
    if (!newest) throw new Error("expected newest ref");
    expect(await readModelCatalogRpcResult(app.db, admin.clientId, newest)).toMatchObject({
      models: [{ id: `m-${MODEL_CATALOG_RPC_MAX_ENTRIES + 7}` }],
    });
  });
});
