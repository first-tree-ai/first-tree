import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  closeSync,
  constants,
  type Dirent,
  fchmodSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  opendirSync,
  openSync,
  readSync,
  renameSync,
  type Stats,
  unlinkSync,
  writeSync,
} from "node:fs";
import { userInfo } from "node:os";
import { basename, dirname, isAbsolute, join, normalize, parse, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import type { ChannelName } from "@first-tree/shared/channel";
import { channelConfig } from "./channel.js";
import { sleepSync } from "./supervisor/shared.js";

const LEGACY_LABEL_SOURCE = String.raw`com\.first-tree\.github-scan\.runner\.[A-Za-z0-9._-]+\.default`;
const LEGACY_LABEL_RE = new RegExp(`^${LEGACY_LABEL_SOURCE}$`);
const LEGACY_PLIST_RE = new RegExp(`^(${LEGACY_LABEL_SOURCE})\\.plist$`);
const MARKER_NAME = ".legacy-launchd-retirement-v1.json";

const MAX_DIRECTORY_ENTRIES = 256;
const MAX_CANDIDATES_PER_RUN = 4;
const MAX_PLIST_BYTES = 64 * 1024;
const MAX_MARKER_BYTES = 16 * 1024;
const MAX_DIAGNOSTICS = 16;
const MAX_DETAIL_CHARS = 160;
// NAME_MAX (255) minus the six-byte ".plist" suffix. This is also the
// largest exact legacy label that can be represented by the canonical file.
const MAX_LEGACY_LABEL_CHARS = 249;
const RETRY_DELAY_MS = 5 * 60 * 1000;
const MAX_MARKER_FUTURE_MS = 10 * 60 * 1000;
const BOOTOUT_TIMEOUT_MS = 15_000;
const VERIFY_TIMEOUT_MS = 10_000;
const PRINT_TIMEOUT_MS = 2_000;
const POLL_INTERVAL_MS = 200;

export type LegacyGithubScanLaunchdRetirementStatus = "not-applicable" | "absent" | "complete" | "partial" | "deferred";

export type LegacyGithubScanLaunchdRetirementStage =
  | "eligibility"
  | "path"
  | "inventory"
  | "marker-read"
  | "marker-remove"
  | "marker-write"
  | "candidate-read"
  | "bootout"
  | "verify"
  | "unlink"
  | "internal";

export type LegacyGithubScanLaunchdRetirementReason =
  | "invalid-home"
  | "filesystem-error"
  | "unsafe-ancestor"
  | "ancestor-changed"
  | "inventory-overflow"
  | "inventory-error"
  | "unsafe-marker"
  | "marker-unreadable"
  | "marker-race"
  | "marker-remove-failed"
  | "marker-write-failed"
  | "marker-rename-failed"
  | "marker-verify-failed"
  | "no-follow-unavailable"
  | "unsafe-candidate"
  | "candidate-unreadable"
  | "candidate-oversize"
  | "candidate-changed"
  | "invalid-plist-label"
  | "spawn-error"
  | "spawn-signal"
  | "empty-nonzero"
  | "exit-nonzero"
  | "verification-timeout"
  | "unlink-failed"
  | "candidate-cap"
  | "unexpected";

/**
 * Diagnostics intentionally contain no arbitrary path or plist data. Labels
 * have already passed the exact legacy-label grammar; free-form process text
 * is control-stripped and capped before it reaches this object.
 */
export type LegacyGithubScanLaunchdRetirementDiagnostic = Readonly<{
  stage: LegacyGithubScanLaunchdRetirementStage;
  reason: LegacyGithubScanLaunchdRetirementReason;
  label?: string;
  code?: string;
  status?: number;
  signal?: string;
  detail?: string;
}>;

export type LegacyGithubScanLaunchdRetirementResult = Readonly<{
  status: LegacyGithubScanLaunchdRetirementStatus;
  retired: number;
  diagnostics: readonly LegacyGithubScanLaunchdRetirementDiagnostic[];
  /** Unix epoch milliseconds. Present only after the retry marker is durable. */
  retryAt?: number;
}>;

type LaunchctlResult = Readonly<{
  error?: unknown;
  status: number | null;
  signal: string | null;
  stdout?: string | null;
  stderr?: string | null;
}>;

type SyncDirectory = {
  readSync(): Dirent | null;
  closeSync(): void;
};

export type LegacyGithubScanRetirementFileSystem = Readonly<{
  lstat(path: string): Stats;
  open(path: string, flags: number, mode?: number): number;
  fstat(fd: number): Stats;
  read(fd: number, buffer: Buffer, offset: number, length: number, position: number | null): number;
  write(fd: number, buffer: Buffer, offset: number, length: number, position: number | null): number;
  close(fd: number): void;
  unlink(path: string): void;
  rename(from: string, to: string): void;
  openDirectory(path: string): SyncDirectory;
  fchmod(fd: number, mode: number): void;
  fsync(fd: number): void;
}>;

export type LegacyGithubScanLaunchdRetirementOptions = Readonly<{
  platform: NodeJS.Platform;
  channel: ChannelName;
  effectiveHome: string;
  effectiveUid: number;
  spawnLaunchctl(args: readonly string[], timeoutMs: number): LaunchctlResult;
  parsePlistLabel?: (plist: string) => string | null;
  now?: () => number;
  monotonicNow?: () => number;
  sleep?: (ms: number) => void;
  randomToken?: () => string;
  noFollowFlag?: number;
  fileSystem?: Partial<LegacyGithubScanRetirementFileSystem>;
}>;

const nodeFileSystem: LegacyGithubScanRetirementFileSystem = {
  lstat: lstatSync,
  open: openSync,
  fstat: fstatSync,
  read: readSync,
  write: writeSync,
  close: closeSync,
  unlink: unlinkSync,
  rename: renameSync,
  openDirectory: opendirSync,
  fchmod: fchmodSync,
  fsync: fsyncSync,
};

type DirectoryIdentity = Readonly<{ path: string; dev: number; ino: number }>;
type FileIdentity = Readonly<{
  dev: number;
  ino: number;
  size: number;
  mtimeMs: number;
  ctimeMs: number;
}>;

type MarkerValue = Readonly<{
  version: 1;
  retryAt: number;
  resumeAfter?: string;
  diagnostics: readonly LegacyGithubScanLaunchdRetirementDiagnostic[];
}>;

type MarkerInspection =
  | Readonly<{ kind: "missing" }>
  | Readonly<{ kind: "valid"; value: MarkerValue; identity: FileIdentity }>
  | Readonly<{ kind: "recoverable-corrupt"; identity: FileIdentity }>
  | Readonly<{ kind: "error"; diagnostic: LegacyGithubScanLaunchdRetirementDiagnostic }>;

type InventoryResult =
  | Readonly<{ kind: "complete"; candidates: readonly Candidate[] }>
  | Readonly<{ kind: "overflow" }>
  | Readonly<{ kind: "error"; diagnostic: LegacyGithubScanLaunchdRetirementDiagnostic }>;

type Candidate = Readonly<{ label: string; filename: string; path: string }>;

type OpenCandidate = Readonly<{ fd: number; identity: FileIdentity; plist: string }>;

type Runtime = Readonly<{
  fs: LegacyGithubScanRetirementFileSystem;
  noFollowFlag: number;
  spawnLaunchctl: LegacyGithubScanLaunchdRetirementOptions["spawnLaunchctl"];
  parsePlistLabel: NonNullable<LegacyGithubScanLaunchdRetirementOptions["parsePlistLabel"]>;
  now: () => number;
  monotonicNow: () => number;
  sleep: (ms: number) => void;
  randomToken: () => string;
  uid: number;
}>;

function result(
  status: LegacyGithubScanLaunchdRetirementStatus,
  retired = 0,
  diagnostics: readonly LegacyGithubScanLaunchdRetirementDiagnostic[] = [],
  retryAt?: number,
): LegacyGithubScanLaunchdRetirementResult {
  return {
    status,
    retired,
    diagnostics: diagnostics.slice(0, MAX_DIAGNOSTICS),
    ...(retryAt === undefined ? {} : { retryAt }),
  };
}

function isLegacyLabel(value: string): boolean {
  return value.length <= MAX_LEGACY_LABEL_CHARS && LEGACY_LABEL_RE.test(value);
}

function errorCode(error: unknown): string | undefined {
  if (!error || typeof error !== "object" || !("code" in error)) return undefined;
  const value = String((error as { code: unknown }).code);
  return /^[A-Za-z0-9_-]{1,32}$/.test(value) ? value : undefined;
}

function isErrorCode(error: unknown, code: string): boolean {
  return errorCode(error) === code;
}

function sanitizeDetail(value: unknown): string | undefined {
  const withoutControls = [...String(value ?? "")]
    .map((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f) ? " " : character;
    })
    .join("");
  const sanitized = withoutControls.replace(/\s+/g, " ").trim().slice(0, MAX_DETAIL_CHARS);
  return sanitized || undefined;
}

function safeSignal(value: unknown): string | undefined {
  const signal = String(value ?? "");
  return /^[A-Z0-9]{1,16}$/.test(signal) ? signal : undefined;
}

function addDiagnostic(
  diagnostics: LegacyGithubScanLaunchdRetirementDiagnostic[],
  diagnostic: LegacyGithubScanLaunchdRetirementDiagnostic,
): void {
  if (diagnostics.length < MAX_DIAGNOSTICS) diagnostics.push(diagnostic);
}

function fsDiagnostic(
  stage: LegacyGithubScanLaunchdRetirementStage,
  reason: LegacyGithubScanLaunchdRetirementReason,
  error: unknown,
  label?: string,
): LegacyGithubScanLaunchdRetirementDiagnostic {
  const code = errorCode(error);
  return { stage, reason, ...(label ? { label } : {}), ...(code ? { code } : {}) };
}

function identityOf(stat: Stats): FileIdentity {
  return {
    dev: stat.dev,
    ino: stat.ino,
    size: stat.size,
    mtimeMs: stat.mtimeMs,
    ctimeMs: stat.ctimeMs,
  };
}

function sameFileIdentity(stat: Stats, identity: FileIdentity): boolean {
  return (
    stat.isFile() &&
    !stat.isSymbolicLink() &&
    stat.dev === identity.dev &&
    stat.ino === identity.ino &&
    stat.size === identity.size &&
    stat.mtimeMs === identity.mtimeMs &&
    stat.ctimeMs === identity.ctimeMs
  );
}

function sameObjectIdentity(stat: Stats, identity: FileIdentity): boolean {
  return stat.isFile() && !stat.isSymbolicLink() && stat.dev === identity.dev && stat.ino === identity.ino;
}

function inspectDirectoryChain(
  paths: readonly string[],
  fs: LegacyGithubScanRetirementFileSystem,
):
  | Readonly<{ kind: "ok"; identities: readonly DirectoryIdentity[] }>
  | Readonly<{ kind: "absent" }>
  | Readonly<{ kind: "error"; diagnostic: LegacyGithubScanLaunchdRetirementDiagnostic }> {
  const identities: DirectoryIdentity[] = [];
  for (const path of paths) {
    let stat: Stats;
    try {
      stat = fs.lstat(path);
    } catch (error) {
      if (isErrorCode(error, "ENOENT")) return { kind: "absent" };
      return { kind: "error", diagnostic: fsDiagnostic("path", "filesystem-error", error) };
    }
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      return { kind: "error", diagnostic: { stage: "path", reason: "unsafe-ancestor" } };
    }
    identities.push({ path, dev: stat.dev, ino: stat.ino });
  }
  return { kind: "ok", identities };
}

function revalidateDirectories(
  identities: readonly DirectoryIdentity[],
  fs: LegacyGithubScanRetirementFileSystem,
  stage: LegacyGithubScanLaunchdRetirementStage,
  label?: string,
): LegacyGithubScanLaunchdRetirementDiagnostic | null {
  for (const identity of identities) {
    let stat: Stats;
    try {
      stat = fs.lstat(identity.path);
    } catch (error) {
      return fsDiagnostic(stage, "ancestor-changed", error, label);
    }
    if (stat.isSymbolicLink() || !stat.isDirectory() || stat.dev !== identity.dev || stat.ino !== identity.ino) {
      return { stage, reason: "ancestor-changed", ...(label ? { label } : {}) };
    }
  }
  return null;
}

function readBoundedFile(
  fd: number,
  expectedSize: number,
  maxBytes: number,
  fs: LegacyGithubScanRetirementFileSystem,
): Buffer | null {
  if (!Number.isSafeInteger(expectedSize) || expectedSize < 0 || expectedSize > maxBytes) return null;
  const buffer = Buffer.alloc(expectedSize + 1);
  let offset = 0;
  while (offset < buffer.length) {
    const read = fs.read(fd, buffer, offset, buffer.length - offset, offset);
    if (read === 0) break;
    offset += read;
  }
  if (offset !== expectedSize) return null;
  return buffer.subarray(0, offset);
}

function decodeUtf8(buffer: Buffer): string | null {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(buffer);
  } catch {
    return null;
  }
}

function inspectMarker(
  markerPath: string,
  runnerIdentities: readonly DirectoryIdentity[],
  runtime: Runtime,
): MarkerInspection {
  let pathStat: Stats;
  try {
    pathStat = runtime.fs.lstat(markerPath);
  } catch (error) {
    if (isErrorCode(error, "ENOENT")) return { kind: "missing" };
    return { kind: "error", diagnostic: fsDiagnostic("marker-read", "marker-unreadable", error) };
  }

  if (pathStat.isSymbolicLink() || !pathStat.isFile()) {
    return { kind: "error", diagnostic: { stage: "marker-read", reason: "unsafe-marker" } };
  }
  const identity = identityOf(pathStat);
  if (pathStat.size > MAX_MARKER_BYTES || (pathStat.mode & 0o7777) !== 0o600) {
    return { kind: "recoverable-corrupt", identity };
  }
  if (runtime.noFollowFlag === 0) {
    return { kind: "error", diagnostic: { stage: "marker-read", reason: "no-follow-unavailable" } };
  }

  let fd: number | null = null;
  try {
    fd = runtime.fs.open(markerPath, constants.O_RDONLY | runtime.noFollowFlag);
    const opened = runtime.fs.fstat(fd);
    if (!sameFileIdentity(opened, identity)) {
      return { kind: "error", diagnostic: { stage: "marker-read", reason: "marker-race" } };
    }
    const contents = readBoundedFile(fd, opened.size, MAX_MARKER_BYTES, runtime.fs);
    const afterRead = runtime.fs.fstat(fd);
    const changed = !sameFileIdentity(afterRead, identity);
    const ancestorError = revalidateDirectories(runnerIdentities, runtime.fs, "marker-read");
    if (ancestorError || changed) {
      return { kind: "error", diagnostic: ancestorError ?? { stage: "marker-read", reason: "marker-race" } };
    }
    if (!contents) return { kind: "recoverable-corrupt", identity };
    const text = decodeUtf8(contents);
    const value = text ? parseMarker(text, runtime.now()) : null;
    return value ? { kind: "valid", value, identity } : { kind: "recoverable-corrupt", identity };
  } catch (error) {
    return { kind: "error", diagnostic: fsDiagnostic("marker-read", "marker-unreadable", error) };
  } finally {
    if (fd !== null) {
      try {
        runtime.fs.close(fd);
      } catch {
        // The read result is already fail-closed; a close error has no safe
        // recovery action and must not make us unlink an unverified marker.
      }
    }
  }
}

function isDiagnostic(value: unknown): value is LegacyGithubScanLaunchdRetirementDiagnostic {
  if (!value || typeof value !== "object") return false;
  const row = value as Record<string, unknown>;
  const allowedKeys = new Set(["stage", "reason", "label", "code", "status", "signal", "detail"]);
  if (Object.keys(row).some((key) => !allowedKeys.has(key))) return false;
  const stages: readonly string[] = [
    "eligibility",
    "path",
    "inventory",
    "marker-read",
    "marker-remove",
    "marker-write",
    "candidate-read",
    "bootout",
    "verify",
    "unlink",
    "internal",
  ];
  const reasons: readonly string[] = [
    "invalid-home",
    "filesystem-error",
    "unsafe-ancestor",
    "ancestor-changed",
    "inventory-overflow",
    "inventory-error",
    "unsafe-marker",
    "marker-unreadable",
    "marker-race",
    "marker-remove-failed",
    "marker-write-failed",
    "marker-rename-failed",
    "marker-verify-failed",
    "no-follow-unavailable",
    "unsafe-candidate",
    "candidate-unreadable",
    "candidate-oversize",
    "candidate-changed",
    "invalid-plist-label",
    "spawn-error",
    "spawn-signal",
    "empty-nonzero",
    "exit-nonzero",
    "verification-timeout",
    "unlink-failed",
    "candidate-cap",
    "unexpected",
  ];
  if (typeof row.stage !== "string" || !stages.includes(row.stage)) return false;
  if (typeof row.reason !== "string" || !reasons.includes(row.reason)) return false;
  if (row.label !== undefined && (typeof row.label !== "string" || !isLegacyLabel(row.label))) return false;
  if (row.code !== undefined && (typeof row.code !== "string" || !/^[A-Za-z0-9_-]{1,32}$/.test(row.code))) return false;
  if (row.status !== undefined && (!Number.isSafeInteger(row.status) || (row.status as number) < 0)) return false;
  if (row.signal !== undefined && (typeof row.signal !== "string" || !/^[A-Z0-9]{1,16}$/.test(row.signal)))
    return false;
  if (
    row.detail !== undefined &&
    (typeof row.detail !== "string" ||
      row.detail.length > MAX_DETAIL_CHARS ||
      sanitizeDetail(row.detail) !== row.detail)
  ) {
    return false;
  }
  return true;
}

function parseMarker(text: string, now: number): MarkerValue | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const row = parsed as Record<string, unknown>;
  const allowedKeys = new Set(["version", "retryAt", "resumeAfter", "diagnostics"]);
  if (Object.keys(row).some((key) => !allowedKeys.has(key))) return null;
  if (row.version !== 1) return null;
  if (!Number.isSafeInteger(row.retryAt) || (row.retryAt as number) < 0) return null;
  if ((row.retryAt as number) > now + MAX_MARKER_FUTURE_MS) return null;
  if (row.resumeAfter !== undefined && (typeof row.resumeAfter !== "string" || !isLegacyLabel(row.resumeAfter))) {
    return null;
  }
  if (!Array.isArray(row.diagnostics) || row.diagnostics.length > MAX_DIAGNOSTICS) return null;
  if (!row.diagnostics.every(isDiagnostic)) return null;
  return {
    version: 1,
    retryAt: row.retryAt as number,
    ...(typeof row.resumeAfter === "string" ? { resumeAfter: row.resumeAfter } : {}),
    diagnostics: row.diagnostics,
  };
}

function inventoryCandidates(
  launchdPath: string,
  launchdIdentities: readonly DirectoryIdentity[],
  runtime: Runtime,
): InventoryResult {
  let directory: SyncDirectory | null = null;
  try {
    directory = runtime.fs.openDirectory(launchdPath);
    const candidates: Candidate[] = [];
    let entries = 0;
    for (;;) {
      const entry = directory.readSync();
      if (!entry) break;
      entries += 1;
      if (entries > MAX_DIRECTORY_ENTRIES) return { kind: "overflow" };
      const match = LEGACY_PLIST_RE.exec(entry.name);
      if (match && isLegacyLabel(match[1])) {
        candidates.push({ label: match[1], filename: entry.name, path: join(launchdPath, entry.name) });
      }
    }
    const changed = revalidateDirectories(launchdIdentities, runtime.fs, "inventory");
    if (changed) return { kind: "error", diagnostic: changed };
    candidates.sort((a, b) => (a.label < b.label ? -1 : a.label > b.label ? 1 : 0));
    return { kind: "complete", candidates };
  } catch (error) {
    return { kind: "error", diagnostic: fsDiagnostic("inventory", "inventory-error", error) };
  } finally {
    if (directory) {
      try {
        directory.closeSync();
      } catch {
        // Enumeration already stopped. Revalidation above prevents mutation
        // after a detected directory replacement.
      }
    }
  }
}

function removeMarker(
  markerPath: string,
  inspection: Exclude<MarkerInspection, { kind: "missing" } | { kind: "error" }>,
  runnerIdentities: readonly DirectoryIdentity[],
  runtime: Runtime,
): LegacyGithubScanLaunchdRetirementDiagnostic | null {
  const ancestorError = revalidateDirectories(runnerIdentities, runtime.fs, "marker-remove");
  if (ancestorError) return ancestorError;
  try {
    const stat = runtime.fs.lstat(markerPath);
    if (!sameFileIdentity(stat, inspection.identity)) {
      return { stage: "marker-remove", reason: "marker-race" };
    }
    runtime.fs.unlink(markerPath);
    return null;
  } catch (error) {
    if (isErrorCode(error, "ENOENT")) {
      const changed = revalidateDirectories(runnerIdentities, runtime.fs, "marker-remove");
      if (changed) return changed;
      try {
        runtime.fs.lstat(markerPath);
      } catch (afterError) {
        if (isErrorCode(afterError, "ENOENT")) return null;
        return fsDiagnostic("marker-remove", "marker-remove-failed", afterError);
      }
    }
    return fsDiagnostic("marker-remove", "marker-remove-failed", error);
  }
}

function orderedBatch(candidates: readonly Candidate[], resumeAfter: string | undefined): readonly Candidate[] {
  if (candidates.length === 0) return [];
  let start = 0;
  if (resumeAfter) {
    const next = candidates.findIndex((candidate) => candidate.label > resumeAfter);
    start = next === -1 ? 0 : next;
  }
  const rotated = [...candidates.slice(start), ...candidates.slice(0, start)];
  return rotated.slice(0, MAX_CANDIDATES_PER_RUN);
}

function hasStrictLegacyPlistEnvelope(plist: string): boolean {
  const trimmed = plist.trim();
  const header =
    /^<\?xml version="1\.0" encoding="UTF-8"\?>\s*<!DOCTYPE plist PUBLIC "-\/\/Apple\/\/DTD PLIST 1\.0\/\/EN" "https?:\/\/www\.apple\.com\/DTDs\/PropertyList-1\.0\.dtd">\s*<plist version="1\.0">/;
  if (!header.test(trimmed) || !trimmed.endsWith("</plist>")) return false;
  if ((trimmed.match(/<plist\b/g) ?? []).length !== 1) return false;
  if ((trimmed.match(/<\/plist>/g) ?? []).length !== 1) return false;
  return (trimmed.match(/<key>\s*Label\s*<\/key>/g) ?? []).length === 1;
}

function parsePlistLabelWithPlutil(plist: string): string | null {
  const parsed = spawnSync("/usr/bin/plutil", ["-extract", "Label", "raw", "-o", "-", "-"], {
    encoding: "utf8",
    input: plist,
    timeout: PRINT_TIMEOUT_MS,
    stdio: ["pipe", "pipe", "pipe"],
  });
  if (parsed.error) throw parsed.error;
  if (parsed.signal) {
    throw Object.assign(new Error("plutil terminated by signal"), { code: "EINTR" });
  }
  if (parsed.status !== 0) return null;
  const output = String(parsed.stdout ?? "");
  // Darwin's `plutil -extract ... raw` appends one LF transport byte. Strip
  // only that byte: whitespace before it (including a semantic CR) is part
  // of the plist string value and must not become a different identity.
  const label = output.endsWith("\n") ? output.slice(0, -1) : output;
  return isLegacyLabel(label) ? label : null;
}

function openCandidate(
  candidate: Candidate,
  launchdIdentities: readonly DirectoryIdentity[],
  runtime: Runtime,
): OpenCandidate | LegacyGithubScanLaunchdRetirementDiagnostic {
  const ancestorError = revalidateDirectories(launchdIdentities, runtime.fs, "candidate-read", candidate.label);
  if (ancestorError) return ancestorError;
  if (runtime.noFollowFlag === 0) {
    return { stage: "candidate-read", reason: "no-follow-unavailable", label: candidate.label };
  }

  let pathStat: Stats;
  try {
    pathStat = runtime.fs.lstat(candidate.path);
  } catch (error) {
    return fsDiagnostic(
      "candidate-read",
      isErrorCode(error, "ENOENT") ? "candidate-changed" : "candidate-unreadable",
      error,
      candidate.label,
    );
  }
  if (pathStat.isSymbolicLink() || !pathStat.isFile()) {
    return { stage: "candidate-read", reason: "unsafe-candidate", label: candidate.label };
  }
  if (pathStat.size > MAX_PLIST_BYTES) {
    return { stage: "candidate-read", reason: "candidate-oversize", label: candidate.label };
  }
  const identity = identityOf(pathStat);

  let fd: number | null = null;
  try {
    fd = runtime.fs.open(candidate.path, constants.O_RDONLY | runtime.noFollowFlag);
    const opened = runtime.fs.fstat(fd);
    if (!sameFileIdentity(opened, identity)) {
      runtime.fs.close(fd);
      return { stage: "candidate-read", reason: "candidate-changed", label: candidate.label };
    }
    const contents = readBoundedFile(fd, opened.size, MAX_PLIST_BYTES, runtime.fs);
    const afterRead = runtime.fs.fstat(fd);
    if (!contents || !sameFileIdentity(afterRead, identity)) {
      runtime.fs.close(fd);
      return { stage: "candidate-read", reason: "candidate-changed", label: candidate.label };
    }
    const plist = decodeUtf8(contents);
    if (plist === null) {
      runtime.fs.close(fd);
      return { stage: "candidate-read", reason: "invalid-plist-label", label: candidate.label };
    }
    return { fd, identity, plist };
  } catch (error) {
    if (fd !== null) {
      try {
        runtime.fs.close(fd);
      } catch {
        // Preserve the primary failure below.
      }
    }
    return fsDiagnostic(
      "candidate-read",
      isErrorCode(error, "ENOENT") ? "candidate-changed" : "candidate-unreadable",
      error,
      candidate.label,
    );
  }
}

function revalidateCandidate(
  candidate: Candidate,
  opened: OpenCandidate,
  launchdIdentities: readonly DirectoryIdentity[],
  runtime: Runtime,
  stage: "bootout" | "unlink",
): LegacyGithubScanLaunchdRetirementDiagnostic | "candidate-gone" | null {
  const ancestorError = revalidateDirectories(launchdIdentities, runtime.fs, stage, candidate.label);
  if (ancestorError) return ancestorError;
  let openedStat: Stats;
  try {
    openedStat = runtime.fs.fstat(opened.fd);
  } catch (error) {
    return fsDiagnostic(stage, "candidate-changed", error, candidate.label);
  }
  let pathStat: Stats;
  try {
    pathStat = runtime.fs.lstat(candidate.path);
  } catch (error) {
    if (isErrorCode(error, "ENOENT")) return "candidate-gone";
    return fsDiagnostic(stage, "candidate-changed", error, candidate.label);
  }
  if (!sameFileIdentity(openedStat, opened.identity) || !sameFileIdentity(pathStat, opened.identity)) {
    return { stage, reason: "candidate-changed", label: candidate.label };
  }
  return null;
}

function bootoutAbsence(stderr: string | null | undefined): boolean {
  const lines = String(stderr ?? "")
    .trim()
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines[0] !== "Boot-out failed: 3: No such process") return false;
  return (
    lines.length === 1 ||
    (lines.length === 2 && lines[1] === "Try running `launchctl bootout` as root for richer errors.")
  );
}

function printAbsence(stderr: string | null | undefined, label: string, uid: number): boolean {
  const expected = `Could not find service "${label}" in domain for user gui: ${uid}`;
  const lines = String(stderr ?? "")
    .trim()
    .split(/\r?\n/)
    .map((line) => line.trim());
  return (
    (lines.length === 1 && lines[0] === expected) ||
    (lines.length === 2 && lines[0] === "Bad request." && lines[1] === expected)
  );
}

function processFailure(
  stage: "bootout" | "verify",
  label: string,
  launchctlResult: LaunchctlResult,
): LegacyGithubScanLaunchdRetirementDiagnostic | null {
  if (launchctlResult.error) {
    return fsDiagnostic(stage, "spawn-error", launchctlResult.error, label);
  }
  if (launchctlResult.signal) {
    const signal = safeSignal(launchctlResult.signal);
    return { stage, reason: "spawn-signal", label, ...(signal ? { signal } : {}) };
  }
  if (launchctlResult.status === 0) return null;
  const detail = sanitizeDetail(launchctlResult.stderr);
  return {
    stage,
    reason: detail ? "exit-nonzero" : "empty-nonzero",
    label,
    ...(typeof launchctlResult.status === "number" ? { status: launchctlResult.status } : {}),
    ...(detail ? { detail } : {}),
  };
}

function waitForExactLabelAbsent(label: string, runtime: Runtime): LegacyGithubScanLaunchdRetirementDiagnostic | null {
  const target = `gui/${runtime.uid}/${label}`;
  const deadline = runtime.monotonicNow() + VERIFY_TIMEOUT_MS;
  for (;;) {
    const remaining = Math.max(1, deadline - runtime.monotonicNow());
    const printTimeout = Math.max(1, Math.ceil(Math.min(PRINT_TIMEOUT_MS, remaining)));
    const checked = runtime.spawnLaunchctl(["print", target], printTimeout);
    if (checked.error || checked.signal) return processFailure("verify", label, checked);
    if (checked.status !== 0) {
      if (typeof checked.status === "number" && printAbsence(checked.stderr, label, runtime.uid)) return null;
      return processFailure("verify", label, checked);
    }
    if (runtime.monotonicNow() >= deadline) {
      return { stage: "verify", reason: "verification-timeout", label };
    }
    runtime.sleep(Math.max(1, Math.ceil(Math.min(POLL_INTERVAL_MS, deadline - runtime.monotonicNow()))));
  }
}

function retireCandidate(
  candidate: Candidate,
  launchdIdentities: readonly DirectoryIdentity[],
  runtime: Runtime,
): { retired: boolean; diagnostic?: LegacyGithubScanLaunchdRetirementDiagnostic } {
  const opened = openCandidate(candidate, launchdIdentities, runtime);
  if (!("fd" in opened)) return { retired: false, diagnostic: opened };

  try {
    if (!hasStrictLegacyPlistEnvelope(opened.plist)) {
      return {
        retired: false,
        diagnostic: { stage: "candidate-read", reason: "invalid-plist-label", label: candidate.label },
      };
    }
    let embeddedLabel: string | null;
    try {
      embeddedLabel = runtime.parsePlistLabel(opened.plist);
    } catch (error) {
      return {
        retired: false,
        diagnostic: fsDiagnostic("candidate-read", "candidate-unreadable", error, candidate.label),
      };
    }
    if (embeddedLabel !== candidate.label) {
      return {
        retired: false,
        diagnostic: { stage: "candidate-read", reason: "invalid-plist-label", label: candidate.label },
      };
    }

    const beforeBootout = revalidateCandidate(candidate, opened, launchdIdentities, runtime, "bootout");
    if (beforeBootout === "candidate-gone") {
      return {
        retired: false,
        diagnostic: { stage: "bootout", reason: "candidate-changed", label: candidate.label, code: "ENOENT" },
      };
    }
    if (beforeBootout) return { retired: false, diagnostic: beforeBootout };

    const target = `gui/${runtime.uid}/${candidate.label}`;
    const bootout = runtime.spawnLaunchctl(["bootout", target], BOOTOUT_TIMEOUT_MS);
    const bootoutFailure = processFailure("bootout", candidate.label, bootout);
    if (
      bootoutFailure &&
      !(!bootout.error && !bootout.signal && bootout.status === 3 && bootoutAbsence(bootout.stderr))
    ) {
      return { retired: false, diagnostic: bootoutFailure };
    }

    const verifyFailure = waitForExactLabelAbsent(candidate.label, runtime);
    if (verifyFailure) return { retired: false, diagnostic: verifyFailure };

    const beforeUnlink = revalidateCandidate(candidate, opened, launchdIdentities, runtime, "unlink");
    // Only disappearance of the exact candidate name is benign after verified
    // label eviction. An ancestor or held-fd error with ENOENT stays partial.
    if (beforeUnlink === "candidate-gone") return { retired: true };
    if (beforeUnlink) return { retired: false, diagnostic: beforeUnlink };
    try {
      // Node does not expose unlinkat(2). Holding the O_NOFOLLOW fd and
      // comparing both its identity and every fixed ancestor immediately
      // before this exact unlink closes detectable swaps; a same-effective-
      // user substitution in the final syscall window remains an OS-level
      // residual race and is not represented as impossible here.
      runtime.fs.unlink(candidate.path);
      return { retired: true };
    } catch (error) {
      if (isErrorCode(error, "ENOENT")) {
        const afterUnlinkError = revalidateCandidate(candidate, opened, launchdIdentities, runtime, "unlink");
        if (afterUnlinkError === "candidate-gone") return { retired: true };
        if (afterUnlinkError) return { retired: false, diagnostic: afterUnlinkError };
      }
      return { retired: false, diagnostic: fsDiagnostic("unlink", "unlink-failed", error, candidate.label) };
    }
  } finally {
    try {
      runtime.fs.close(opened.fd);
    } catch {
      // No mutation follows this close, so there is no unsafe recovery step.
    }
  }
}

function cleanupExactTemp(
  tempPath: string,
  identity: FileIdentity | null,
  created: boolean,
  runnerIdentities: readonly DirectoryIdentity[],
  runtime: Runtime,
): void {
  // If the initial fstat failed, leave the exact O_EXCL temp fail-closed: a
  // path-only unlink cannot prove that the object behind the name is ours.
  if (!created || !identity) return;
  if (revalidateDirectories(runnerIdentities, runtime.fs, "marker-write")) return;
  try {
    const stat = runtime.fs.lstat(tempPath);
    if (sameObjectIdentity(stat, identity)) runtime.fs.unlink(tempPath);
  } catch {
    // Best-effort cleanup of the one exact random temp path only.
  }
}

function persistMarker(
  markerPath: string,
  runnerIdentities: readonly DirectoryIdentity[],
  resumeAfter: string | undefined,
  diagnostics: readonly LegacyGithubScanLaunchdRetirementDiagnostic[],
  runtime: Runtime,
): { retryAt?: number; diagnostic?: LegacyGithubScanLaunchdRetirementDiagnostic } {
  if (runtime.noFollowFlag === 0) {
    return { diagnostic: { stage: "marker-write", reason: "no-follow-unavailable" } };
  }
  const retryAt = runtime.now() + RETRY_DELAY_MS;
  const value: MarkerValue = {
    version: 1,
    retryAt,
    ...(resumeAfter ? { resumeAfter } : {}),
    diagnostics: diagnostics.slice(0, MAX_DIAGNOSTICS),
  };
  const bytes = Buffer.from(`${JSON.stringify(value)}\n`, "utf8");
  if (bytes.length > MAX_MARKER_BYTES) {
    return { diagnostic: { stage: "marker-write", reason: "marker-write-failed" } };
  }

  const ancestorError = revalidateDirectories(runnerIdentities, runtime.fs, "marker-write");
  if (ancestorError) return { diagnostic: ancestorError };
  try {
    runtime.fs.lstat(markerPath);
    return { diagnostic: { stage: "marker-write", reason: "marker-race" } };
  } catch (error) {
    if (!isErrorCode(error, "ENOENT")) {
      return { diagnostic: fsDiagnostic("marker-write", "marker-write-failed", error) };
    }
  }

  let token: string;
  try {
    token = runtime.randomToken();
  } catch (error) {
    return { diagnostic: fsDiagnostic("marker-write", "marker-write-failed", error) };
  }
  if (!/^[A-Za-z0-9_-]{8,64}$/.test(token)) {
    return { diagnostic: { stage: "marker-write", reason: "marker-write-failed" } };
  }
  const tempPath = join(dirname(markerPath), `.${basename(markerPath)}.${token}.tmp`);
  let fd: number | null = null;
  let tempIdentity: FileIdentity | null = null;
  let tempCreated = false;
  try {
    fd = runtime.fs.open(
      tempPath,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | runtime.noFollowFlag,
      0o600,
    );
    tempCreated = true;
    const createdStat = runtime.fs.fstat(fd);
    if (!createdStat.isFile() || createdStat.isSymbolicLink()) {
      return { diagnostic: { stage: "marker-write", reason: "marker-verify-failed" } };
    }
    tempIdentity = identityOf(createdStat);
    runtime.fs.fchmod(fd, 0o600);
    let offset = 0;
    while (offset < bytes.length) {
      const written = runtime.fs.write(fd, bytes, offset, bytes.length - offset, offset);
      if (written <= 0) throw Object.assign(new Error("short marker write"), { code: "EIO" });
      offset += written;
    }
    runtime.fs.fsync(fd);
    const tempStat = runtime.fs.fstat(fd);
    if (!sameObjectIdentity(tempStat, tempIdentity) || (tempStat.mode & 0o7777) !== 0o600) {
      return { diagnostic: { stage: "marker-write", reason: "marker-verify-failed" } };
    }
    runtime.fs.close(fd);
    fd = null;

    const changed = revalidateDirectories(runnerIdentities, runtime.fs, "marker-write");
    if (changed) return { diagnostic: changed };
    try {
      runtime.fs.lstat(markerPath);
      return { diagnostic: { stage: "marker-write", reason: "marker-race" } };
    } catch (error) {
      if (!isErrorCode(error, "ENOENT")) {
        return { diagnostic: fsDiagnostic("marker-write", "marker-write-failed", error) };
      }
    }

    runtime.fs.rename(tempPath, markerPath);
    tempCreated = false;
    const finalStat = runtime.fs.lstat(markerPath);
    // rename(2) may update ctime; object identity and exact mode are the
    // stable post-rename assertions here.
    if (!sameObjectIdentity(finalStat, tempIdentity) || (finalStat.mode & 0o7777) !== 0o600) {
      return { diagnostic: { stage: "marker-write", reason: "marker-verify-failed" } };
    }
    tempIdentity = null;
    return { retryAt };
  } catch (error) {
    return {
      diagnostic: fsDiagnostic(
        "marker-write",
        errorCode(error) === "EXDEV" ? "marker-rename-failed" : "marker-write-failed",
        error,
      ),
    };
  } finally {
    if (fd !== null) {
      try {
        runtime.fs.close(fd);
      } catch {
        // Preserve the marker operation result.
      }
    }
    cleanupExactTemp(tempPath, tempIdentity, tempCreated, runnerIdentities, runtime);
  }
}

function runRetirement(options: LegacyGithubScanLaunchdRetirementOptions): LegacyGithubScanLaunchdRetirementResult {
  if (options.platform !== "darwin" || (options.channel !== "prod" && options.channel !== "staging")) {
    return result("not-applicable");
  }
  const home = options.effectiveHome;
  if (
    !home ||
    home.includes("\0") ||
    !isAbsolute(home) ||
    normalize(home) !== home ||
    resolve(home) !== home ||
    home === parse(home).root ||
    !Number.isSafeInteger(options.effectiveUid) ||
    options.effectiveUid < 0
  ) {
    return result("partial", 0, [{ stage: "eligibility", reason: "invalid-home" }]);
  }

  const fs: LegacyGithubScanRetirementFileSystem = { ...nodeFileSystem, ...options.fileSystem };
  const runtime: Runtime = {
    fs,
    noFollowFlag: options.noFollowFlag ?? constants.O_NOFOLLOW ?? 0,
    spawnLaunchctl: options.spawnLaunchctl,
    parsePlistLabel: options.parsePlistLabel ?? parsePlistLabelWithPlutil,
    now: options.now ?? Date.now,
    monotonicNow: options.monotonicNow ?? options.now ?? (() => performance.now()),
    sleep: options.sleep ?? sleepSync,
    randomToken: options.randomToken ?? (() => randomBytes(12).toString("hex")),
    uid: options.effectiveUid,
  };

  const firstTreePath = join(home, ".first-tree");
  const githubScanPath = join(firstTreePath, "github-scan");
  const runnerPath = join(githubScanPath, "runner");
  const launchdPath = join(runnerPath, "launchd");
  const markerPath = join(runnerPath, MARKER_NAME);

  const runnerChain = inspectDirectoryChain([firstTreePath, githubScanPath, runnerPath], fs);
  if (runnerChain.kind === "absent") return result("absent");
  if (runnerChain.kind === "error") return result("partial", 0, [runnerChain.diagnostic]);

  const marker = inspectMarker(markerPath, runnerChain.identities, runtime);
  const launchdChain = inspectDirectoryChain([firstTreePath, githubScanPath, runnerPath, launchdPath], fs);
  if (launchdChain.kind === "error") {
    return result("partial", 0, [launchdChain.diagnostic, ...(marker.kind === "error" ? [marker.diagnostic] : [])]);
  }

  const inventory =
    launchdChain.kind === "absent"
      ? ({ kind: "complete", candidates: [] } as const)
      : inventoryCandidates(launchdPath, launchdChain.identities, runtime);
  if (inventory.kind === "overflow") {
    // Deliberately mutation-free: a bounded scan that did not see the whole
    // directory cannot prove absence, success, or a safe cooldown decision.
    return result("partial", 0, [{ stage: "inventory", reason: "inventory-overflow" }]);
  }
  if (inventory.kind === "error") return result("partial", 0, [inventory.diagnostic]);
  if (marker.kind === "error") return result("partial", 0, [marker.diagnostic]);

  if (inventory.candidates.length === 0) {
    if (marker.kind !== "missing") {
      const removeFailure = removeMarker(markerPath, marker, runnerChain.identities, runtime);
      if (removeFailure) return result("partial", 0, [removeFailure]);
    }
    return result("absent");
  }
  // A non-empty inventory can only have come from the verified launchd
  // directory. Keep that invariant explicit for the mutation paths below.
  if (launchdChain.kind !== "ok") return result("partial", 0, [{ stage: "inventory", reason: "inventory-error" }]);

  const now = runtime.now();
  if (marker.kind === "valid" && marker.value.retryAt > now) {
    return result("deferred", 0, marker.value.diagnostics, marker.value.retryAt);
  }
  if (marker.kind !== "missing") {
    const removeFailure = removeMarker(markerPath, marker, runnerChain.identities, runtime);
    if (removeFailure) return result("partial", 0, [removeFailure]);
  }

  const resumeAfter = marker.kind === "valid" ? marker.value.resumeAfter : undefined;
  const selected = orderedBatch(inventory.candidates, resumeAfter);
  const diagnostics: LegacyGithubScanLaunchdRetirementDiagnostic[] = [];
  let retired = 0;
  let lastVisited: string | undefined;
  for (const candidate of selected) {
    lastVisited = candidate.label;
    try {
      const outcome = retireCandidate(candidate, launchdChain.identities, runtime);
      if (outcome.retired) retired += 1;
      if (outcome.diagnostic) addDiagnostic(diagnostics, outcome.diagnostic);
    } catch (error) {
      addDiagnostic(diagnostics, fsDiagnostic("internal", "unexpected", error, candidate.label));
    }
  }

  if (inventory.candidates.length > selected.length) {
    addDiagnostic(diagnostics, { stage: "inventory", reason: "candidate-cap" });
  }

  const finalInventory = inventoryCandidates(launchdPath, launchdChain.identities, runtime);
  if (finalInventory.kind === "overflow") {
    addDiagnostic(diagnostics, { stage: "inventory", reason: "inventory-overflow" });
    return result("partial", retired, diagnostics);
  }
  if (finalInventory.kind === "error") {
    addDiagnostic(diagnostics, finalInventory.diagnostic);
    return result("partial", retired, diagnostics);
  }
  if (finalInventory.candidates.length === 0) {
    // There is nothing left for a cooldown cursor to suppress. Preserve any
    // fresh failure as an honest partial result, but do not create a stale
    // retry marker that would make the next idempotent run look deferred.
    return diagnostics.length === 0 ? result("complete", retired) : result("partial", retired, diagnostics);
  }
  if (diagnostics.length === 0) {
    addDiagnostic(diagnostics, { stage: "inventory", reason: "candidate-cap" });
  }

  const persisted = persistMarker(markerPath, runnerChain.identities, lastVisited, diagnostics, runtime);
  if (persisted.diagnostic) addDiagnostic(diagnostics, persisted.diagnostic);
  return result("partial", retired, diagnostics, persisted.retryAt);
}

/**
 * Repeatable, dependency-injected core. Production code should call the
 * no-argument once wrapper below so caller-controlled roots can never enter
 * the real cleanup boundary.
 */
export function runLegacyGithubScanLaunchdRetirement(
  options: LegacyGithubScanLaunchdRetirementOptions,
): LegacyGithubScanLaunchdRetirementResult {
  try {
    return runRetirement(options);
  } catch (error) {
    return result("partial", 0, [fsDiagnostic("internal", "unexpected", error)]);
  }
}

let productionResult: LegacyGithubScanLaunchdRetirementResult | undefined;

/**
 * Run the one-time retirement exception against the fixed effective-account
 * legacy namespace. This intentionally ignores HOME, FIRST_TREE_HOME, channel
 * homes, and the historical github-scan override variables.
 */
export function runLegacyGithubScanLaunchdRetirementOnce(): LegacyGithubScanLaunchdRetirementResult {
  if (productionResult) return productionResult;
  const channel = channelConfig.channel;
  if (process.platform !== "darwin" || (channel !== "prod" && channel !== "staging")) {
    productionResult = result("not-applicable");
    return productionResult;
  }
  try {
    const account = userInfo();
    productionResult = runLegacyGithubScanLaunchdRetirement({
      platform: process.platform,
      channel,
      effectiveHome: account.homedir,
      effectiveUid: account.uid,
      spawnLaunchctl: (args, timeoutMs) =>
        spawnSync("/bin/launchctl", [...args], {
          encoding: "utf8",
          timeout: timeoutMs,
          stdio: ["ignore", "pipe", "pipe"],
        }),
    });
  } catch (error) {
    productionResult = result("partial", 0, [fsDiagnostic("internal", "unexpected", error)]);
  }
  return productionResult;
}
