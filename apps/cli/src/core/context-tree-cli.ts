import type { ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import type { Dirent } from "node:fs";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { delimiter, dirname, join, resolve as resolvePath } from "node:path";
import { getChildProcessRegistry, getCliBinding } from "@first-tree/client";
import { defaultDataDir, readContextTreeRepositorySetting } from "@first-tree/shared/config";

/**
 * The external Context Tree CLI. It ships the `context-tree-*` Skill family and
 * a command surface for resolving, connecting, reading, and writing Context
 * Trees, including GitHub-hosted ones. Text-default commands such as `connect`
 * and `list` need `--json`; plumbing commands such as `install` and `uninstall`
 * are always JSON. This wrapper parses only JSON responses.
 *
 * It is a normal dependency of this package rather than a global install, so the
 * version is pinned to the CLI release and no network access is needed at run
 * time. We never import it as a module — we resolve its bin and spawn it, so the
 * bundler never pulls it into `dist/`.
 */
const CONTEXT_TREE_PACKAGE = "@first-tree-ai/context-tree";

/** `connect` clones a Git repository, so allow for a slow network. */
const CONTEXT_TREE_TIMEOUT_MS = 3 * 60 * 1000;

/** Agent homes live below `<dataDir>/workspaces/<agentName>`; see AgentSlot. */
const WORKSPACES_DIRNAME = "workspaces";

export type ContextTreeCliInvocation = { command: string; args: string[] };

export type ContextTreeCliResult =
  | { ok: true; payload: unknown }
  // `reasonCode` is the external CLI's own `error.code` (`NO_CONNECTION`,
  // `DIRTY_TREE`, …) when it produced a structured envelope, and absent when the
  // failure happened before or outside one.
  | { ok: false; reason: string; reasonCode?: string };

export type ContextTreeConnectFailure = {
  workspace: string;
  reason: string;
  reasonCode?: string;
};

export type ContextTreeSetupReport = {
  /**
   * `skipped` means the CLI is unavailable, so nothing was written and the
   * caller carries on. `removed` means external mode is off and owned cleanup
   * completed, including an already-clean inspection.
   */
  status: "skipped" | "installed" | "failed" | "removed";
  reason?: string;
  /** Host Skill directories the packaged Skills were written to. */
  installedHosts: string[];
  /** Workspaces connected to the configured repository. */
  connectedWorkspaces: string[];
  /** Per-workspace connect failures; one failure never aborts the rest. */
  failures: ContextTreeConnectFailure[];
  /**
   * Where the `context-tree` shim was written, or null when it could not be.
   * The Skills invoke `context-tree` by name, so without this the Agent cannot
   * run them at all; `doctor` surfaces the path.
   */
  shimPath?: string | null;
  /** Skill directories removed when external mode was switched back off. */
  removedSkillPaths?: string[];
  /**
   * `context-tree-*` Skill directories left in place because they were not
   * recorded as First Tree-created and unmodified — a hand-installed or edited Skill a
   * login must never delete.
   */
  preservedSkillPaths?: string[];
};

/**
 * Marker identifying a shim this CLI wrote.
 *
 * It is what distinguishes our shim from a `context-tree` binary the user
 * installed globally themselves, so neither the writer nor the remover ever
 * touches the latter.
 */
const SHIM_MARKER = "first-tree-managed context-tree shim";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/**
 * Locate the packaged `context-tree` bin.
 *
 * Invoked as `process.execPath <bin>` rather than through the bin shim: the same
 * defence `resolveNpmInvocation` applies for npm, which avoids the Windows
 * `.cmd` EINVAL problem. Returns `null` when the dependency is absent — the
 * portable build prunes deps — so callers report a skip, not a failure.
 */
export function resolveContextTreeCli(): ContextTreeCliInvocation | null {
  try {
    const require = createRequire(import.meta.url);
    const manifestPath = require.resolve(`${CONTEXT_TREE_PACKAGE}/package.json`);
    const binPath = join(dirname(manifestPath), "dist", "cli", "index.mjs");
    if (!existsSync(binPath)) return null;
    return { command: process.execPath, args: [binPath] };
  } catch {
    return null;
  }
}

/**
 * Run one `context-tree` subcommand and parse its result.
 *
 * Text-default commands must be invoked with `--json`; install and uninstall
 * always print JSON. Success payloads are command-specific and do NOT carry an
 * `ok` field, so exit code is the only reliable verdict; a non-zero JSON-mode
 * failure prints `{ok:false,error:{code,message}}`, whose code becomes
 * `reasonCode`.
 */
export async function runContextTreeCommand(args: string[]): Promise<ContextTreeCliResult> {
  const cli = resolveContextTreeCli();
  if (!cli) {
    return {
      ok: false,
      reason: `${CONTEXT_TREE_PACKAGE} is not installed beside this CLI.`,
      reasonCode: "context_tree_cli_missing",
    };
  }

  return new Promise((resolvePromise) => {
    let child: ChildProcess;
    try {
      ({ child } = getChildProcessRegistry().spawn(cli.command, [...cli.args, ...args], {
        category: "other",
        label: `context-tree ${args.join(" ")}`,
        timeoutMs: CONTEXT_TREE_TIMEOUT_MS,
        stdio: ["ignore", "pipe", "pipe"],
      }));
    } catch (err) {
      resolvePromise(spawnFailure(err));
      return;
    }

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let timedOut = false;
    child.stdout?.on("data", (chunk: Buffer) => stdoutChunks.push(chunk));
    child.stderr?.on("data", (chunk: Buffer) => stderrChunks.push(chunk));

    child.on("error", (err) => resolvePromise(spawnFailure(err)));

    child.on("exit", (code, signal) => {
      const stdout = Buffer.concat(stdoutChunks).toString("utf8").trim();
      if (code === 0) {
        const payload = parseJsonLine(stdout);
        if (payload === undefined) {
          resolvePromise({
            ok: false,
            reason: "context-tree returned no parseable JSON result.",
            reasonCode: "context_tree_bad_payload",
          });
          return;
        }
        resolvePromise({ ok: true, payload });
        return;
      }
      if (code === null && signal) timedOut = true;
      const envelope = parseJsonLine(stdout);
      const envelopeError = isRecord(envelope) && isRecord(envelope.error) ? envelope.error : undefined;
      const envelopeCode = typeof envelopeError?.code === "string" ? envelopeError.code : undefined;
      const envelopeMessage = typeof envelopeError?.message === "string" ? envelopeError.message : undefined;
      const stderr = Buffer.concat(stderrChunks).toString("utf8").trim();
      const reason =
        envelopeMessage ??
        `context-tree ${
          timedOut ? `killed by signal ${signal} (timeout)` : `exited with code ${code}`
        }${stderr ? `: ${stderr.split("\n").slice(-3).join(" | ")}` : ""}`;
      resolvePromise({
        ok: false,
        reason,
        reasonCode: envelopeCode ?? (timedOut ? "context_tree_timeout" : undefined),
      });
    });
  });
}

function spawnFailure(err: unknown): ContextTreeCliResult {
  return { ok: false, reason: err instanceof Error ? err.message : String(err) };
}

function parseJsonLine(stdout: string): unknown {
  if (stdout.length === 0) return undefined;
  // Take the last non-empty line: the payload is one line, but a stray warning
  // ahead of it should not defeat parsing.
  const lines = stdout.split("\n").filter((line) => line.trim().length > 0);
  const last = lines[lines.length - 1];
  if (last === undefined) return undefined;
  try {
    return JSON.parse(last);
  } catch {
    return undefined;
  }
}

/** Existing agent homes, so a connect never pre-creates a workspace. */
function existingWorkspacePaths(): string[] {
  const workspacesRoot = join(defaultDataDir(), WORKSPACES_DIRNAME);
  if (!existsSync(workspacesRoot)) return [];
  let names: string[];
  try {
    names = readdirSync(workspacesRoot);
  } catch {
    return [];
  }
  return names
    .filter((name) => !name.startsWith("."))
    .map((name) => join(workspacesRoot, name))
    .filter((path) => {
      try {
        return statSync(path).isDirectory();
      } catch {
        return false;
      }
    });
}

function installedHostsFrom(payload: unknown): string[] {
  if (!isRecord(payload) || !Array.isArray(payload.installed)) return [];
  return payload.installed
    .map((entry) => (isRecord(entry) && typeof entry.host === "string" ? entry.host : null))
    .filter((host): host is string => host !== null);
}

/**
 * The directory holding this channel's CLI executable, found on `PATH`.
 *
 * That directory is what the Agent's `PATH` is built from — either inherited or
 * prepended as `FIRST_TREE_CLI_BIN_DIR` (`agent-io.ts`) — so it is the one place
 * a `context-tree` shim is guaranteed to be visible from inside a session.
 */
function channelCliBinDir(): string | null {
  let binName: string;
  try {
    binName = getCliBinding().binName;
  } catch {
    return null;
  }
  const candidates = process.platform === "win32" ? [`${binName}.cmd`, `${binName}.exe`, binName] : [binName];
  for (const dir of (process.env.PATH ?? "").split(delimiter).filter((part) => part.length > 0)) {
    for (const candidate of candidates) {
      if (existsSync(join(dir, candidate))) return resolvePath(dir);
    }
  }
  return null;
}

/**
 * Put `context-tree` on the Agent's `PATH`.
 *
 * Every installed Skill starts by running `context-tree …`, but npm links only a
 * top-level package's bin — never a transitive dependency's — so the packaged
 * dependency is reachable by module resolution and by nothing else. Without this
 * shim the Skills are installed and unrunnable.
 *
 * Absolute paths are baked in deliberately: the shim must work even though the
 * Agent's `PATH` is a controlled list that need not contain `node`. `login`
 * rewrites it every time, so a Node version bump heals itself.
 */
function writeContextTreeShim(): { path: string } | { reason: string } {
  const cli = resolveContextTreeCli();
  if (!cli) return { reason: `${CONTEXT_TREE_PACKAGE} is not installed beside this CLI` };
  const binDir = channelCliBinDir();
  if (!binDir) return { reason: "could not locate this CLI's bin directory on PATH" };

  const target = cli.args[0];
  if (target === undefined) return { reason: "could not resolve the context-tree entry point" };

  const shimPath = join(binDir, process.platform === "win32" ? "context-tree.cmd" : "context-tree");

  // Never clobber a `context-tree` the user installed themselves — a global
  // `npm i -g @first-tree-ai/context-tree` lands its own bin in exactly this
  // directory, and that one already satisfies the Skills. Only a shim carrying
  // our marker is rewritten, which keeps repeated logins idempotent and lets a
  // Node version bump heal itself.
  if (existsSync(shimPath)) {
    let existing = "";
    try {
      existing = readFileSync(shimPath, "utf8");
    } catch {
      // Unreadable (a dangling symlink, most likely) — treat it as not ours.
    }
    if (!existing.includes(SHIM_MARKER)) return { path: shimPath };
  }

  try {
    if (process.platform === "win32") {
      writeFileSync(shimPath, `@echo off\r\nrem ${SHIM_MARKER}\r\n"${process.execPath}" "${target}" %*\r\n`, "utf8");
      return { path: shimPath };
    }
    writeFileSync(shimPath, `#!/bin/sh\n# ${SHIM_MARKER}\nexec "${process.execPath}" "${target}" "$@"\n`, "utf8");
    chmodSync(shimPath, 0o755);
    return { path: shimPath };
  } catch (err) {
    // A root-owned prefix is the common case. Report the remedy rather than
    // failing the login; external mode is degraded, not the whole CLI.
    const detail = err instanceof Error ? err.message : String(err);
    return {
      reason: `could not write a context-tree shim into ${binDir} (${detail}) — run \`npm i -g ${CONTEXT_TREE_PACKAGE}\``,
    };
  }
}

/**
 * Host names to their home-relative Skill directories (mirrors the external
 * CLI's host table). Since `@first-tree-ai/context-tree` 0.1.16 the Codex host
 * installs into `~/.agents/skills`; `~/.codex/skills` is only its config probe.
 */
const HOST_SKILL_DIRS = [
  ["claude", join(".claude", "skills")],
  ["codex", join(".agents", "skills")],
] as const;

/**
 * Destinations an earlier bundled CLI installed into. They are scanned only to
 * retire copies First Tree recorded as its own, so an upgraded Codex does not
 * load a stale second `context-tree-*` family next to the current one.
 */
const LEGACY_HOST_SKILL_DIRS = [["codex", join(".codex", "skills")]] as const;

const OWNED_SKILLS_FILENAME = "context-tree-owned-skills.json";
const OWNED_SKILLS_SCHEMA_VERSION = 2;

/**
 * Content digests of the Skill payload shipped by every earlier bundled CLI
 * release (only 0.1.12). A version-1 ownership record holds paths without
 * digests, so these are what let an unedited copy installed by that release be
 * replaced or removed after an upgrade instead of being mistaken for an edit.
 * Computed with `skillTreeDigest` over the published package's `skills/`.
 */
const LEGACY_PACKAGED_SKILL_DIGESTS: Readonly<Record<string, readonly string[]>> = {
  "context-tree-cleanup": ["3a161c292a806ed433275edade89fa65c4cf5a2c07cdab8f7acd698b49b5ffd0"],
  "context-tree-connect": ["20f90351d8035f7cbb7fed286fe7e29061c85673ad0a0a383da03a1da7e25c02"],
  "context-tree-create": ["b006259fb5dbcb5ceeae7508a0c79777459f558b52d7f12a3e36570fa166732e"],
  "context-tree-publish": ["a88688d4403ef3582bb619b04d359e611f5d3bbdcb982a2852987ce244c11664"],
  "context-tree-read": ["b3f910e2c360d7dcc7369119e773a80c6274f08db4f894c1d1547e5895bf774c"],
  "context-tree-schedule-cleanup": ["e93bed959edf08977b50837b5ca7209850859044a6b11de27412c34f524197f7"],
  "context-tree-setup": ["7abce1d2f33a8d2cc8f72ca783344970fb7f141fdf47873b5f5a645d83fba839"],
  "context-tree-write": ["91e46636c04a3f2c2c1cf48b00922ddeb4b003a116a72716c0b38ad0a6f236fe"],
};

/**
 * The packaged Skill payload the bundled CLI ships (`<pkg>/skills`), or null
 * when the dependency is absent. Both the dependency's postinstall and our
 * `context-tree install` write exactly these bytes, so a matching digest checks
 * for edits; a separate installation record establishes ownership.
 */
function packagedSkillsRoot(): string | null {
  const entry = resolveContextTreeCli()?.args[0];
  if (entry === undefined) return null;
  // …/dist/cli/index.mjs -> …/skills
  const root = join(dirname(entry), "..", "..", "skills");
  return existsSync(root) ? root : null;
}

/**
 * Paths First Tree created, each with the digest recorded when it last wrote
 * that path. Version-1 records carry no digest (`null`).
 */
type OwnedSkills = Map<string, string | null>;

/** Only this versioned record proves that First Tree created a Skill directory. */
function readOwnedSkills(): OwnedSkills {
  const owned: OwnedSkills = new Map();
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(join(defaultDataDir(), OWNED_SKILLS_FILENAME), "utf8"));
  } catch {
    // Missing or unreadable provenance never authorizes deletion.
    return owned;
  }
  if (!isRecord(value)) return owned;
  if (value.schemaVersion === 1 && Array.isArray(value.paths)) {
    for (const path of value.paths) if (typeof path === "string") owned.set(path, null);
    return owned;
  }
  if (value.schemaVersion === OWNED_SKILLS_SCHEMA_VERSION && Array.isArray(value.skills)) {
    for (const skill of value.skills) {
      if (!isRecord(skill) || typeof skill.path !== "string") continue;
      owned.set(skill.path, typeof skill.digest === "string" ? skill.digest : null);
    }
  }
  return owned;
}

function writeOwnedSkills(owned: OwnedSkills): void {
  mkdirSync(defaultDataDir(), { recursive: true });
  const skills = [...owned].map(([path, digest]) => (digest === null ? { path } : { path, digest }));
  writeFileSync(
    join(defaultDataDir(), OWNED_SKILLS_FILENAME),
    JSON.stringify({ schemaVersion: OWNED_SKILLS_SCHEMA_VERSION, skills }),
  );
}

/**
 * A content digest of one Skill directory: its shape, names and bytes, in a
 * stable order. Returns null for anything that is not a plain tree of regular
 * files and directories — a linked-in Skill is never one we own.
 */
export function skillTreeDigest(root: string): string | null {
  const hash = createHash("sha256");
  const visit = (directory: string, prefix: string): boolean => {
    let entries: Dirent[];
    try {
      entries = readdirSync(directory, { withFileTypes: true });
    } catch {
      return false;
    }
    entries.sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
    for (const entry of entries) {
      const relative = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
      if (entry.isSymbolicLink()) return false;
      if (entry.isDirectory()) {
        hash.update(`d\0${relative}\0`);
        if (!visit(join(directory, entry.name), relative)) return false;
      } else if (entry.isFile()) {
        const bytes = readFileSync(join(directory, entry.name));
        hash.update(`f\0${relative}\0${bytes.length}\0`);
        hash.update(bytes);
      } else {
        return false;
      }
    }
    return true;
  };
  try {
    const entry = lstatSync(root, { throwIfNoEntry: false });
    if (entry === undefined || entry.isSymbolicLink() || !entry.isDirectory()) return null;
    return visit(root, "") ? hash.digest("hex") : null;
  } catch {
    return null;
  }
}

/** Digest of each packaged `context-tree-*` Skill, keyed by directory name. */
function packagedSkillDigests(packagedRoot: string): Map<string, string> {
  const digests = new Map<string, string>();
  for (const entry of readdirSync(packagedRoot, { withFileTypes: true })) {
    if (!entry.isDirectory() || !entry.name.startsWith("context-tree-")) continue;
    const digest = skillTreeDigest(join(packagedRoot, entry.name));
    if (digest !== null) digests.set(entry.name, digest);
  }
  return digests;
}

/**
 * True when `target` is a Skill First Tree recorded as its own AND still holds
 * bytes First Tree wrote: the digest recorded at install time, the current
 * packaged payload, or the payload of an earlier bundled release.
 */
function isOwnedPristineSkill(
  target: string,
  name: string,
  owned: OwnedSkills,
  packagedDigests: ReadonlyMap<string, string>,
): boolean {
  if (!owned.has(target)) return false;
  const digest = skillTreeDigest(target);
  if (digest === null) return false;
  return (
    digest === owned.get(target) ||
    digest === packagedDigests.get(name) ||
    (LEGACY_PACKAGED_SKILL_DIGESTS[name]?.includes(digest) ?? false)
  );
}

/** Names First Tree may ever have installed: the current payload plus earlier releases. */
function knownSkillNames(packagedDigests: ReadonlyMap<string, string>): Set<string> {
  return new Set([...packagedDigests.keys(), ...Object.keys(LEGACY_PACKAGED_SKILL_DIGESTS)]);
}

type RetireResult = {
  /** Owned, unedited copies that were deleted (and dropped from `owned`). */
  removed: string[];
  /** Known Skill names left in place: unowned, edited, or unremovable. */
  preserved: string[];
  /** Other `context-tree-*` directories, never ours to judge. */
  foreign: string[];
};

/**
 * Delete the `context-tree-*` Skills in one Skill directory that First Tree
 * owns and has not seen edited. Mutates `owned` for what it removes.
 */
function retireOwnedSkills(
  skillsRoot: string,
  isKnownName: (name: string) => boolean,
  owned: OwnedSkills,
  packagedDigests: ReadonlyMap<string, string>,
): RetireResult {
  const result: RetireResult = { removed: [], preserved: [], foreign: [] };
  let entries: Dirent[];
  try {
    // Never delete through a host directory redirected after installation.
    if (realpathSync(skillsRoot) !== skillsRoot) return result;
    entries = readdirSync(skillsRoot, { withFileTypes: true });
  } catch {
    return result; // No Skill directory here — nothing to clean up.
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith("context-tree-")) continue;
    const target = join(skillsRoot, entry.name);
    if (!isKnownName(entry.name)) {
      result.foreign.push(target);
      continue;
    }
    if (!isOwnedPristineSkill(target, entry.name, owned, packagedDigests)) {
      result.preserved.push(target);
      continue;
    }
    try {
      rmSync(target, { recursive: true, force: true });
      owned.delete(target);
      result.removed.push(target);
    } catch {
      // Unremovable (permission, in use) — keep it and report, don't pretend.
      result.preserved.push(target);
    }
  }
  return result;
}

/** The external CLI's error code for an unreadable `~/.context-tree/connections.json`. */
const CORRUPT_CONNECTION_CODE = "CORRUPT_CONNECTION";

/**
 * `@first-tree-ai/context-tree` 0.1.16 reads only its version-2 connection
 * store and refuses the version-1 file earlier releases wrote, with no
 * migration. The file is global and may hold connections First Tree did not
 * make, so it is reported and never rewritten here.
 */
export const CONNECTION_STORE_REMEDY =
  "~/.context-tree/connections.json is unreadable (likely written by context-tree before 0.1.16); move it aside, then run login again";

/**
 * Probe whether the external CLI can read its connection store.
 *
 * `resolve` loads the whole store before filtering by project, so any project
 * path exercises it; `NO_CONNECTION` for that path is the healthy answer.
 */
export async function probeContextTreeConnectionStore(): Promise<{ ok: true } | { ok: false; reason: string }> {
  const result = await runContextTreeCommand(["resolve", "--project-path", homedir(), "--json"]);
  if (result.ok || result.reasonCode !== CORRUPT_CONNECTION_CODE) return { ok: true };
  return { ok: false, reason: CONNECTION_STORE_REMEDY };
}

/**
 * Undo external mode once the key is unset.
 *
 * Only directories recorded as newly created by First Tree and still matching
 * the packaged payload are removed. Independent official installs and legacy
 * copies without provenance are preserved, even when their bytes are identical.
 *
 * Connections, managed trees, pointers, and the user's global `context-tree`
 * binary are deliberately left alone.
 */
export async function removeContextTreeSkills(): Promise<ContextTreeSetupReport> {
  const base: ContextTreeSetupReport = {
    status: "skipped",
    installedHosts: [],
    connectedWorkspaces: [],
    failures: [],
  };

  const packagedRoot = packagedSkillsRoot();
  if (packagedRoot === null) {
    return { ...base, reason: `${CONTEXT_TREE_PACKAGE} is not installed beside this CLI` };
  }

  let home: string;
  let packagedDigests: Map<string, string>;
  try {
    home = realpathSync(homedir());
    packagedDigests = packagedSkillDigests(packagedRoot);
  } catch {
    return { ...base, status: "failed", reason: "could not resolve the user home directory" };
  }
  const knownNames = knownSkillNames(packagedDigests);

  const owned = readOwnedSkills();
  const removedSkillPaths: string[] = [];
  const preservedSkillPaths: string[] = [];
  for (const [, relative] of [...HOST_SKILL_DIRS, ...LEGACY_HOST_SKILL_DIRS]) {
    const skillsRoot = join(home, relative);
    const result = retireOwnedSkills(skillsRoot, (name) => knownNames.has(name), owned, packagedDigests);
    removedSkillPaths.push(...result.removed);
    // Every remaining prefixed directory is reported, owned by us or not.
    preservedSkillPaths.push(...result.preserved, ...result.foreign);
  }

  const binDir = channelCliBinDir();
  if (binDir !== null) {
    const binName = process.platform === "win32" ? "context-tree.cmd" : "context-tree";
    const shimPath = join(binDir, binName);
    try {
      if (readFileSync(shimPath, "utf8").includes(SHIM_MARKER)) unlinkSync(shimPath);
    } catch {
      // Already gone, or not ours to read.
    }
  }

  try {
    unlinkSync(join(defaultDataDir(), OWNED_SKILLS_FILENAME));
  } catch {
    // No ownership record may exist; preserved copies are no longer owned.
  }

  return {
    ...base,
    status: "removed",
    reason: "context_tree.repository is not set",
    removedSkillPaths,
    preservedSkillPaths,
  };
}

/**
 * Install the external Context Tree Skills and link the configured tree.
 *
 * Gated on `context_tree.repository`: First Tree does not install external
 * Skills on an unconfigured machine. Independently installed Skills remain the
 * operator's responsibility. A configured machine has the overlapping
 * `first-tree-{read,write,seed}` projection stood down by the Client (see
 * `ContextSource` kind `external`).
 *
 * Best-effort throughout: a failure is reported, never thrown — it runs inside
 * `login`, which must succeed even when the tree cannot be reached.
 */
export async function ensureContextTreeSkills(): Promise<ContextTreeSetupReport> {
  const base: ContextTreeSetupReport = {
    status: "skipped",
    installedHosts: [],
    connectedWorkspaces: [],
    failures: [],
  };

  const setting = readContextTreeRepositorySetting();
  if (!setting.repository) {
    // Revert only our recorded installations; dependency installs have no home side effects.
    const removal = await removeContextTreeSkills();
    if (setting.raw !== null) {
      return {
        ...removal,
        status: "failed",
        reason: `context_tree.repository value ${JSON.stringify(setting.raw)} is unusable; external mode is off`,
      };
    }
    return removal;
  }
  const repository = setting.repository;
  if (!resolveContextTreeCli()) {
    return { ...base, reason: `${CONTEXT_TREE_PACKAGE} is not installed beside this CLI` };
  }

  const owned = readOwnedSkills();
  const installHosts: string[] = [];
  const preservedSkillPaths: string[] = [];
  const installFailures: ContextTreeConnectFailure[] = [];
  let home: string;
  let packagedDigests: Map<string, string>;
  try {
    const packagedRoot = packagedSkillsRoot();
    if (packagedRoot === null) return { ...base, status: "failed", reason: "Packaged Skills are missing" };
    home = realpathSync(homedir());
    packagedDigests = packagedSkillDigests(packagedRoot);
    for (const [host, relative] of HOST_SKILL_DIRS) {
      const protectedPaths: string[] = [];
      for (const name of packagedDigests.keys()) {
        const target = join(home, relative, name);
        const existing = lstatSync(target, { throwIfNoEntry: false });
        if (existing === undefined) continue;
        // An owned copy written by this or an earlier bundled release may be
        // replaced; anything else is the operator's and blocks the host.
        if (!existing.isDirectory() || !isOwnedPristineSkill(target, name, owned, packagedDigests)) {
          protectedPaths.push(target);
        }
      }
      // The upstream installer replaces every packaged-name destination for a
      // host. Do not invoke it when any of those destinations is protected.
      if (protectedPaths.length > 0) {
        preservedSkillPaths.push(...protectedPaths);
        installFailures.push({
          workspace: host,
          reason: `${host} Skill installation skipped: unowned or edited Skills preserved at ${protectedPaths.join(", ")}`,
        });
      } else {
        installHosts.push(host);
      }
    }
  } catch (error) {
    return { ...base, status: "failed", reason: String(error) };
  }

  const installedHosts: string[] = [];
  for (const host of installHosts) {
    const install = await runContextTreeCommand(["install", "--host", host]);
    if (!install.ok) installFailures.push({ workspace: host, reason: install.reason });
    else installedHosts.push(...installedHostsFrom(install.payload));
  }

  try {
    // Every packaged destination of an installed host was absent or owned
    // before the install, so the bytes now there are First Tree's.
    for (const [host, relative] of HOST_SKILL_DIRS) {
      if (!installedHosts.includes(host)) continue;
      for (const name of packagedDigests.keys()) {
        const target = join(home, relative, name);
        const digest = skillTreeDigest(target);
        if (digest !== null) owned.set(target, digest);
      }
    }
    // Retire copies an earlier bundled release wrote to a destination the host
    // no longer reads from, so the host does not load two Skill families.
    const knownNames = knownSkillNames(packagedDigests);
    for (const [host, relative] of LEGACY_HOST_SKILL_DIRS) {
      if (!installedHosts.includes(host)) continue;
      const result = retireOwnedSkills(join(home, relative), (name) => knownNames.has(name), owned, packagedDigests);
      if (result.preserved.length > 0) {
        preservedSkillPaths.push(...result.preserved);
        installFailures.push({
          workspace: host,
          reason: `${host} legacy Skills preserved at ${result.preserved.join(", ")}; remove them to avoid duplicate context-tree-* Skills`,
        });
      }
    }
    writeOwnedSkills(owned);
  } catch (error) {
    return { ...base, status: "failed", reason: `Could not record Skill ownership: ${String(error)}` };
  }

  const shim = writeContextTreeShim();
  const shimPath = "path" in shim ? shim.path : null;

  const report: ContextTreeSetupReport = {
    status: "installed",
    installedHosts,
    preservedSkillPaths,
    connectedWorkspaces: [],
    failures: installFailures,
    shimPath,
  };
  // The Skills are useless without the shim, so a failure to write it is
  // surfaced beside the connect failures rather than swallowed.
  if ("reason" in shim) {
    report.failures.push({ workspace: "context-tree shim", reason: shim.reason });
  }

  // `connect` clones before it touches the store, so probe the store first
  // instead of cloning once per workspace only to fail on the same file.
  const store = await probeContextTreeConnectionStore();
  if (!store.ok) {
    report.failures.push({
      workspace: "context-tree connections",
      reason: store.reason,
      reasonCode: CORRUPT_CONNECTION_CODE,
    });
    return report;
  }

  for (const workspace of existingWorkspacePaths()) {
    const connect = await runContextTreeCommand(["connect", repository, "--project-path", workspace, "--json"]);
    if (connect.ok) {
      report.connectedWorkspaces.push(workspace);
      continue;
    }
    if (connect.reasonCode === CORRUPT_CONNECTION_CODE) {
      // The store is global, so every further workspace would fail the same
      // way. Report it once, with the remedy, and never rewrite the file.
      report.failures.push({
        workspace: "context-tree connections",
        reason: CONNECTION_STORE_REMEDY,
        reasonCode: connect.reasonCode,
      });
      break;
    }
    report.failures.push({ workspace, reason: connect.reason, reasonCode: connect.reasonCode });
  }

  return report;
}

/** One line for the CLI to print after login. */
export function formatContextTreeSetupReport(report: ContextTreeSetupReport): string {
  if (report.status === "skipped") return `Context Tree Skills skipped — ${report.reason ?? "unavailable"}`;
  if (report.status === "failed") return `Context Tree Skills not installed — ${report.reason ?? "unknown error"}`;
  if (report.status === "removed") {
    const count = report.removedSkillPaths?.length ?? 0;
    const preserved = report.preservedSkillPaths?.length ?? 0;
    const preservedNote =
      preserved > 0 ? `; preserved ${preserved} hand-installed Skill${preserved === 1 ? "" : "s"}` : "";
    return `Context Tree Skills removed (${count} skill${count === 1 ? "" : "s"})${preservedNote} — external mode is off`;
  }
  const hosts = report.installedHosts.length > 0 ? report.installedHosts.join(", ") : "no host";
  const connected = `${report.connectedWorkspaces.length} workspace${
    report.connectedWorkspaces.length === 1 ? "" : "s"
  }`;
  return `Context Tree Skills installed (${hosts}); linked ${connected}${formatFailures(report.failures)}`;
}

/**
 * Name the first failure rather than only counting them. The likeliest failure
 * by far is a private tree with no Git credential helper, and a bare count
 * leaves the user with nothing to act on.
 */
function formatFailures(failures: readonly ContextTreeConnectFailure[]): string {
  const first = failures[0];
  if (first === undefined) return "";
  const more = failures.length > 1 ? ` (+${failures.length - 1} more)` : "";
  return `, ${failures.length} failed: ${truncate(first.reason, 160)}${more}`;
}

function truncate(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}
