import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { createLogger } from "../cloud/observability/logger.js";
import type { ProviderContinuation } from "./handler.js";

const REGISTRY_VERSION = 1;

type PersistedEntry = {
  claudeSessionId: string;
  lastActivity: string; // ISO 8601
  status: "active" | "suspended" | "evicted";
  continuation?: ProviderContinuation;
};

type RegistryData = {
  version: number;
  entries: Record<string, PersistedEntry>;
  /**
   * Optional per-chat opaque Reset nonces. Absent on legacy v1 files — those
   * load with an empty nonce map while preserving every existing mapping.
   * Tombstones outlive mapping deletion: a durable inbox row can still arrive
   * after Reset, and the nonce keeps reconstructible fresh-start identities
   * from reopening the discarded provider artifact.
   */
  freshStartNonces?: Record<string, string>;
};

export type RegistryEntry = {
  claudeSessionId: string;
  lastActivity: number;
  status: string;
  continuation?: ProviderContinuation;
};

export type RegistrySnapshot = {
  entries: Map<string, RegistryEntry>;
  freshStartNonces: Map<string, string>;
};

function parseProviderContinuation(value: unknown): ProviderContinuation | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const candidate = value as Record<string, unknown>;
  if (
    candidate.kind !== "provider_continuation" ||
    typeof candidate.provider !== "string" ||
    typeof candidate.sessionId !== "string" ||
    typeof candidate.messageId !== "string" ||
    candidate.provider.length === 0 ||
    candidate.sessionId.length === 0 ||
    candidate.messageId.length === 0
  ) {
    return undefined;
  }
  return {
    kind: "provider_continuation",
    provider: candidate.provider as ProviderContinuation["provider"],
    sessionId: candidate.sessionId,
    messageId: candidate.messageId,
  };
}

/**
 * SessionRegistry — persists `chatId → claudeSessionId` mappings to disk,
 * plus optional per-chat Reset fresh-start nonces.
 *
 * Write strategy: debounced write-then-rename for atomicity. Every write
 * carries the current authoritative mapping set AND the full nonce map so a
 * stale debounced snapshot cannot erase a Reset tombstone or resurrect a
 * deleted mapping.
 *
 * On load, all entries start as `suspended`.
 */
export class SessionRegistry {
  private readonly filePath: string;
  private readonly logger = createLogger("session-registry");
  private writeTimer: ReturnType<typeof setTimeout> | null = null;
  private pendingEntries: Map<string, RegistryEntry> | null = null;
  /** Authoritative in-memory Reset nonces; always written with every flush. */
  private freshStartNonces = new Map<string, string>();
  /**
   * Nonces rotated for an in-flight Reset whose durable flush has not yet
   * succeeded. Retained across flushOrThrow failures so a genuine retry
   * reuses the same nonce instead of rotating unpredictably.
   */
  private pendingResetRotations = new Map<string, string>();

  constructor(filePath: string) {
    this.filePath = filePath;
  }

  /**
   * Load mappings from disk. Preserves the historical public return shape
   * (`Map<chatId, entry>`). Also hydrates the authoritative in-memory Reset
   * nonce map as a side effect so subsequent get/rotate/flush see durable
   * tombstones; callers that need the nonce map should use `loadSnapshot()`.
   */
  load(): Map<string, RegistryEntry> {
    return this.loadSnapshot().entries;
  }

  /**
   * Load the full registry snapshot (mappings + Reset fresh-start nonces).
   * Both this and `load()` populate the in-memory nonce map from disk.
   */
  loadSnapshot(): RegistrySnapshot {
    const entries = new Map<string, RegistryEntry>();
    const freshStartNonces = new Map<string, string>();

    try {
      const raw = readFileSync(this.filePath, "utf-8");
      const data = JSON.parse(raw) as RegistryData;

      if (data.version !== REGISTRY_VERSION) {
        // Version mismatch — discard and start fresh
        this.freshStartNonces = freshStartNonces;
        this.pendingResetRotations.clear();
        return { entries, freshStartNonces };
      }

      for (const [chatId, entry] of Object.entries(data.entries ?? {})) {
        const continuation = parseProviderContinuation(entry.continuation);
        entries.set(chatId, {
          claudeSessionId: entry.claudeSessionId,
          lastActivity: new Date(entry.lastActivity).getTime(),
          status: entry.status,
          ...(continuation ? { continuation } : {}),
        });
      }
      if (data.freshStartNonces && typeof data.freshStartNonces === "object") {
        for (const [chatId, nonce] of Object.entries(data.freshStartNonces)) {
          if (typeof nonce === "string" && nonce.length > 0) {
            freshStartNonces.set(chatId, nonce);
          }
        }
      }
    } catch {
      // File doesn't exist or is corrupted — start fresh
    }

    this.freshStartNonces = new Map(freshStartNonces);
    this.pendingResetRotations.clear();
    return { entries, freshStartNonces };
  }

  getFreshStartNonce(chatId: string): string | undefined {
    return this.freshStartNonces.get(chatId);
  }

  /**
   * Rotate the chat's fresh-start nonce for a Reset attempt. The first call
   * for an in-flight Reset mints a cryptographically random UUID; a failed
   * flush keeps that pending rotation so the genuine retry writes the same
   * nonce with the mapping deletion.
   */
  rotateFreshStartNonce(chatId: string): string {
    const pending = this.pendingResetRotations.get(chatId);
    if (pending) return pending;
    const nonce = randomUUID();
    this.pendingResetRotations.set(chatId, nonce);
    this.freshStartNonces.set(chatId, nonce);
    return nonce;
  }

  /** Clear the in-flight rotation marker after a successful Reset flush. */
  markResetNonceDurable(chatId: string): void {
    this.pendingResetRotations.delete(chatId);
  }

  /** Mark the registry as dirty; a debounced write will follow. */
  save(entries: Map<string, RegistryEntry>): void {
    this.pendingEntries = entries;
    if (!this.writeTimer) {
      this.writeTimer = setTimeout(() => {
        this.writeTimer = null;
        if (this.pendingEntries) {
          this.flush(this.pendingEntries);
          this.pendingEntries = null;
        }
      }, 1000);
    }
  }

  /** Force an immediate write (used during shutdown). */
  flush(entries: Map<string, RegistryEntry>): void {
    this.clearPendingWrite();
    try {
      this.writeToDisk(entries);
    } catch (err) {
      // Log but don't throw — registry persistence is best-effort
      this.logger.warn(`Failed to persist: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /**
   * Force an immediate write and propagate failure to the caller. Used by
   * chat-session Reset: the client apply-acks `session:terminate` only after
   * the mapping deletion (and Reset tombstone) are durable, so a failed write
   * must fail the terminate instead of being swallowed.
   */
  flushOrThrow(entries: Map<string, RegistryEntry>): void {
    this.clearPendingWrite();
    this.writeToDisk(entries);
  }

  private clearPendingWrite(): void {
    if (this.writeTimer) {
      clearTimeout(this.writeTimer);
      this.writeTimer = null;
    }
    // flush(entries) is authoritative — `entries` is the freshest known
    // mapping state. Any older debounced snapshot in pendingEntries is now
    // stale, so drop it; otherwise dispose()'s pending fallback would later
    // rewrite the stale snapshot on top of what we just persisted. Nonces
    // always come from the authoritative in-memory map at write time.
    this.pendingEntries = null;
  }

  private writeToDisk(entries: Map<string, RegistryEntry>): void {
    const freshStartNonces: Record<string, string> = {};
    for (const [chatId, nonce] of this.freshStartNonces) {
      freshStartNonces[chatId] = nonce;
    }
    const data: RegistryData = {
      version: REGISTRY_VERSION,
      entries: {},
      freshStartNonces,
    };

    for (const [chatId, entry] of entries) {
      data.entries[chatId] = {
        claudeSessionId: entry.claudeSessionId,
        lastActivity: new Date(entry.lastActivity).toISOString(),
        status: entry.status as PersistedEntry["status"],
        ...(entry.continuation ? { continuation: entry.continuation } : {}),
      };
    }

    const tmpPath = `${this.filePath}.tmp`;

    mkdirSync(dirname(this.filePath), { recursive: true });
    writeFileSync(tmpPath, JSON.stringify(data, null, 2), "utf-8");
    renameSync(tmpPath, this.filePath);
  }

  /** Flush any pending debounced write, then clean up timers. */
  dispose(): void {
    if (this.pendingEntries) {
      // flush() clears writeTimer internally — persist the last debounced
      // mapping instead of dropping it when torn down inside the 1s window.
      this.flush(this.pendingEntries);
      this.pendingEntries = null;
      return;
    }
    if (this.writeTimer) {
      clearTimeout(this.writeTimer);
      this.writeTimer = null;
    }
  }
}
