import { accessSync, constants, existsSync, lstatSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { channelConfig } from "./channel.js";

export type PortableInstallContext = {
  /** Stable `<prefix>/current` symlink. Never realpath this value. */
  root: string;
  prefix: string;
  /** Authoritative directory containing the channel shims. */
  binDir: string;
  /** Stable outer channel shim used by services and managed refresh. */
  cliPath: string;
  /** Stable bundled-Node directory used in supervisor PATH. */
  nodeBinDir: string;
};

function shellSingleQuote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

/** Render the stable outer shim contract shared by installer and self-update. */
export function portableShimContents(root: string, binDir: string): string {
  return `#!/bin/sh
set -eu
root=${shellSingleQuote(root)}
bin_dir=${shellSingleQuote(binDir)}
export FIRST_TREE_INSTALL_MODE=portable
export FIRST_TREE_PORTABLE_ROOT="$root"
export FIRST_TREE_PORTABLE_BIN_DIR="$bin_dir"
exec "$root/node/bin/node" "$root/app/cli/index.mjs" "$@"
`;
}

function portableRepairError(detail: string): Error {
  return new Error(
    `${detail} Rerun the ${channelConfig.channel} portable installer to repair the stable shim and service unit.`,
  );
}

function assertExecutable(path: string): void {
  if (!existsSync(path)) throw portableRepairError(`Portable CLI shim does not exist: ${path}.`);
  try {
    accessSync(path, constants.R_OK | constants.X_OK);
  } catch {
    throw portableRepairError(`Portable CLI shim is not readable and executable: ${path}.`);
  }
}

function isLegacyDefaultShimForRoot(path: string, root: string): boolean {
  let body: string;
  try {
    body = readFileSync(path, "utf8");
  } catch {
    return false;
  }
  const escapedRoot = root.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  return (
    body.includes(`root="${escapedRoot}"`) &&
    body.includes("export FIRST_TREE_INSTALL_MODE=portable") &&
    body.includes('export FIRST_TREE_PORTABLE_ROOT="$root"') &&
    body.includes('exec "$root/node/bin/node" "$root/app/cli/index.mjs" "$@"')
  );
}

/**
 * True when existing shim content already targets this stable root, in any shape
 * this repo has ever written: the current single-quoted form with an explicit bin
 * directory, or the pre-bin-dir double-quoted form. Ownership is a property of
 * the target, not of the shape, so an old install stays upgradable.
 */
function shimTargetsRoot(body: string, root: string): boolean {
  const escapedRoot = root.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  const namesRoot = body.includes(`root=${shellSingleQuote(root)}`) || body.includes(`root="${escapedRoot}"`);
  return namesRoot && body.includes("FIRST_TREE_INSTALL_MODE=portable") && body.includes("FIRST_TREE_PORTABLE_ROOT");
}

/**
 * Guard one shim path before it is written.
 *
 * The bin directory is user-supplied and the alias (`ft`) is a generic name that
 * another tool may already own. Replacing that file would delete an executable
 * this install does not manage (SEC-057), so anything that is not already one of
 * our shims for `root` is refused with the two ways out spelled out.
 */
export function assertReplaceableShimSlot(path: string, root: string, binDir: string): void {
  try {
    lstatSync(path);
  } catch {
    // Nothing at the path: safe to create.
    return;
  }

  let body: string | null = null;
  try {
    body = readFileSync(path, "utf8");
  } catch {
    body = null;
  }
  if (body !== null && (body === portableShimContents(root, binDir) || shimTargetsRoot(body, root))) return;

  throw new Error(
    `Refusing to overwrite ${path}: it exists but is not a First Tree portable shim for ${root}. ` +
      "Move it aside, or point FIRST_TREE_PORTABLE_BIN_DIR at another directory, then rerun the installer.",
  );
}

function assertShimIdentity(path: string, root: string, binDir: string, allowLegacyDefault: boolean): void {
  assertExecutable(path);
  let body: string;
  try {
    body = readFileSync(path, "utf8");
  } catch {
    throw portableRepairError(`Cannot read portable CLI shim: ${path}.`);
  }
  if (body === portableShimContents(root, binDir)) return;
  if (allowLegacyDefault && isLegacyDefaultShimForRoot(path, root)) return;
  throw portableRepairError(
    `Portable CLI shim ${path} does not identify the same portable root and channel as ${root}.`,
  );
}

/**
 * Resolve authoritative portable installation identity without consulting PATH.
 *
 * Old shims did not export a bin directory. For those, only the documented
 * default `~/.local/bin` is accepted, and only when its channel shim can be
 * verified against the same stable `current` root. Custom legacy installs are
 * deliberately ambiguous and must be repaired by rerunning the installer.
 */
export function resolvePortableInstallContext(): PortableInstallContext | null {
  const mode = process.env.FIRST_TREE_INSTALL_MODE?.trim();
  const rootSignal = process.env.FIRST_TREE_PORTABLE_ROOT?.trim();
  if (mode !== "portable" && !rootSignal) return null;

  if (!rootSignal) {
    throw portableRepairError("FIRST_TREE_INSTALL_MODE=portable is missing FIRST_TREE_PORTABLE_ROOT.");
  }
  if (!isAbsolute(rootSignal)) {
    throw portableRepairError(`FIRST_TREE_PORTABLE_ROOT must be absolute, got ${JSON.stringify(rootSignal)}.`);
  }
  const root = resolve(rootSignal);
  if (basename(root) !== "current") {
    throw portableRepairError(`FIRST_TREE_PORTABLE_ROOT must name the stable current symlink, got ${root}.`);
  }
  const prefix = dirname(root);
  if (prefix === root) {
    throw portableRepairError(`Cannot derive a portable install prefix from ${root}.`);
  }

  const binSignal = process.env.FIRST_TREE_PORTABLE_BIN_DIR?.trim();
  const defaultBinDir = join(homedir(), ".local", "bin");
  const binDir = binSignal || defaultBinDir;
  if (!isAbsolute(binDir)) {
    throw portableRepairError(`FIRST_TREE_PORTABLE_BIN_DIR must be absolute, got ${JSON.stringify(binDir)}.`);
  }
  const normalizedBinDir = resolve(binDir);
  const cliPath = join(normalizedBinDir, channelConfig.binName);
  assertShimIdentity(cliPath, root, normalizedBinDir, !binSignal && normalizedBinDir === resolve(defaultBinDir));

  return {
    root,
    prefix,
    binDir: normalizedBinDir,
    cliPath,
    nodeBinDir: join(root, "node", "bin"),
  };
}

export function hasPortableInstallSignal(): boolean {
  return (
    process.env.FIRST_TREE_INSTALL_MODE?.trim() === "portable" || Boolean(process.env.FIRST_TREE_PORTABLE_ROOT?.trim())
  );
}
