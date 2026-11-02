import { createHash } from "node:crypto";
import type { Dirent } from "node:fs";
import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync, rmSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join, resolve as resolvePath } from "node:path";
import { defaultDataDir } from "@first-tree/shared/config";
import { getCliBinding } from "./cli-binding.js";
import { CONTEXT_TREE_SHIM_MARKER } from "./external-context-tree.js";

/**
 * Cleanup of what First Tree installed while it bundled the 0.1 Context Tree CLI.
 *
 * 0.1 Skills went into the account-level Skill directories and the shim sat
 * next to the channel's CLI binary. Both must go once 1.x is in use: Claude
 * Code would load the 0.1 Skills beside the workspace copies, with instructions
 * the 1.x CLI rejects. This runs from `login` and, because the daemon's
 * auto-update upgrades a machine without a login, once per process at the
 * first external-mode session start.
 */

/**
 * Account-level Skill directories First Tree 0.x wrote with the 0.1 CLI's
 * `install`. 1.x installs into each workspace instead, so these only ever
 * shrink: owned, unedited copies are removed on the next login.
 */
const LEGACY_HOST_SKILL_DIRS = [join(".claude", "skills"), join(".codex", "skills")] as const;

const LEGACY_OWNED_SKILLS_FILENAME = "context-tree-owned-skills.json";

/**
 * Content digests of the Skill payload of the only CLI release First Tree ever
 * bundled before 1.x (0.1.12), computed with {@link skillTreeDigest} over the
 * published package's `skills/`. The legacy ownership record holds paths only,
 * so a matching digest is what proves an owned copy is still unedited.
 */
const LEGACY_PACKAGED_SKILL_DIGESTS: Readonly<Record<string, string>> = {
  "context-tree-cleanup": "3a161c292a806ed433275edade89fa65c4cf5a2c07cdab8f7acd698b49b5ffd0",
  "context-tree-connect": "20f90351d8035f7cbb7fed286fe7e29061c85673ad0a0a383da03a1da7e25c02",
  "context-tree-create": "b006259fb5dbcb5ceeae7508a0c79777459f558b52d7f12a3e36570fa166732e",
  "context-tree-publish": "a88688d4403ef3582bb619b04d359e611f5d3bbdcb982a2852987ce244c11664",
  "context-tree-read": "b3f910e2c360d7dcc7369119e773a80c6274f08db4f894c1d1547e5895bf774c",
  "context-tree-schedule-cleanup": "e93bed959edf08977b50837b5ca7209850859044a6b11de27412c34f524197f7",
  "context-tree-setup": "7abce1d2f33a8d2cc8f72ca783344970fb7f141fdf47873b5f5a645d83fba839",
  "context-tree-write": "91e46636c04a3f2c2c1cf48b00922ddeb4b003a116a72716c0b38ad0a6f236fe",
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
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

/** Paths the legacy ownership record proves First Tree created. */
function readLegacyOwnedSkillPaths(): Set<string> {
  try {
    const value: unknown = JSON.parse(readFileSync(join(defaultDataDir(), LEGACY_OWNED_SKILLS_FILENAME), "utf8"));
    if (!isRecord(value) || value.schemaVersion !== 1 || !Array.isArray(value.paths)) return new Set();
    return new Set(value.paths.filter((path): path is string => typeof path === "string"));
  } catch {
    // Missing or unreadable provenance never authorizes deletion.
    return new Set();
  }
}

/**
 * Remove the account-level Skills an earlier First Tree installed.
 *
 * Left in place they would shadow or duplicate the workspace copies with 0.1
 * instructions the 1.x CLI rejects. Only a directory the legacy record lists
 * AND whose bytes still match the 0.1.12 payload is removed; anything else
 * under a known name is preserved and reported.
 */
export function retireLegacyAccountSkills(): { removed: string[]; preserved: string[] } {
  const removed: string[] = [];
  const preserved: string[] = [];
  let home: string;
  try {
    home = realpathSync(homedir());
  } catch {
    return { removed, preserved };
  }
  const owned = readLegacyOwnedSkillPaths();
  for (const relative of LEGACY_HOST_SKILL_DIRS) {
    const skillsRoot = join(home, relative);
    let entries: Dirent[];
    try {
      // Never delete through a host directory redirected after installation.
      if (realpathSync(skillsRoot) !== skillsRoot) continue;
      entries = readdirSync(skillsRoot, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const legacyDigest = LEGACY_PACKAGED_SKILL_DIGESTS[entry.name];
      if (legacyDigest === undefined) continue;
      const target = join(skillsRoot, entry.name);
      if (!owned.has(target) || skillTreeDigest(target) !== legacyDigest) {
        preserved.push(target);
        continue;
      }
      try {
        rmSync(target, { recursive: true, force: true });
        removed.push(target);
      } catch {
        preserved.push(target);
      }
    }
  }
  if (preserved.length === 0) {
    try {
      unlinkSync(join(defaultDataDir(), LEGACY_OWNED_SKILLS_FILENAME));
    } catch {
      // No record, or already gone.
    }
  }
  return { removed, preserved };
}

/**
 * Remove the shim earlier releases wrote next to this channel's CLI.
 *
 * It pointed at the 0.1 CLI and, sharing a directory with a global install,
 * could hand the Agent the wrong release. Only a file carrying the marker is
 * ours; a user's own global `context-tree` is never touched.
 */
export function removeLegacyChannelShim(): void {
  let binName: string;
  try {
    binName = getCliBinding().binName;
  } catch {
    return;
  }
  const candidates = process.platform === "win32" ? [`${binName}.cmd`, `${binName}.exe`, binName] : [binName];
  for (const dir of (process.env.PATH ?? "").split(delimiter).filter((part) => part.length > 0)) {
    if (!candidates.some((candidate) => existsSync(join(dir, candidate)))) continue;
    const shimPath = join(resolvePath(dir), process.platform === "win32" ? "context-tree.cmd" : "context-tree");
    try {
      if (readFileSync(shimPath, "utf8").includes(CONTEXT_TREE_SHIM_MARKER)) unlinkSync(shimPath);
    } catch {
      // Already gone, or not ours to read.
    }
    return;
  }
}

let legacyRetired = false;

/** {@link retireLegacyAccountSkills} and {@link removeLegacyChannelShim}, once per process. */
export function retireLegacyContextTreeInstallOnce(log: (message: string) => void): void {
  if (legacyRetired) return;
  legacyRetired = true;
  removeLegacyChannelShim();
  const { removed, preserved } = retireLegacyAccountSkills();
  if (removed.length > 0) log(`Context Tree: removed ${removed.length} legacy account-level Skill(s)`);
  if (preserved.length > 0) {
    log(`Context Tree: left hand-installed or edited account-level Skills in place: ${preserved.join(", ")}`);
  }
}
