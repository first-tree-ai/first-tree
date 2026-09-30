import { readdirSync } from "node:fs";
import { join } from "node:path";
import { type ReadLink, resolveOutsideProtectedRootsOnThisHost } from "./protected-paths.js";

/** Injectable directory listing so tests need no real version-manager install. */
export type ReadDirNames = (path: string) => string[];

/**
 * Curated, stable install directories where a globally-installed `claude` /
 * `codex` binary commonly lands but the daemon's frozen service PATH does not
 * include. Searched (cheaply, no spawn) after the daemon PATH and the
 * login-shell PATH, so capability detection still finds the binary even when the
 * login-shell probe is unavailable.
 *
 * Covers node-version-manager shims, global-npm prefixes, and the pnpm / bun
 * global bins. macOS-only Homebrew / pnpm dirs are gated on `darwin`. Returns
 * absolute dir paths (binary name is appended by the caller, per provider).
 */
export function wellKnownBinDirs(home: string): string[] {
  const isMac = process.platform === "darwin";
  const dirs = [
    join(home, ".local", "bin"), // official native installer default
    join(home, ".claude", "local"), // `claude migrate-installer` target
    join(home, ".volta", "bin"), // volta
    join(home, ".asdf", "shims"), // asdf
    join(home, ".local", "share", "mise", "shims"), // mise
    join(home, ".npm-global", "bin"), // custom npm global prefix
    join(home, ".local", "share", "pnpm"), // pnpm global (linux/xdg)
    ...(isMac ? [join(home, "Library", "pnpm")] : []), // pnpm global (macOS)
    join(home, ".bun", "bin"), // bun global
    ...(isMac ? ["/opt/homebrew/bin"] : []), // Apple-silicon Homebrew
    "/usr/local/bin", // Intel Homebrew / common manual installs
  ];
  return dirs;
}

/**
 * What the login shell reported about the version manager it had active.
 * `nvmBin` names the selected version outright; `fnmDir` names only the root it
 * was selected from, leaving the version still to be determined.
 */
export type ActiveVersionManager = { fnmDir?: string; nvmBin?: string };

/** Injectable seams so tests need neither a real install nor a real filesystem. */
export type VersionManagerDirDeps = {
  active?: ActiveVersionManager;
  readDir?: ReadDirNames;
  readLink?: ReadLink;
  env?: NodeJS.ProcessEnv;
};

/**
 * The `bin` dir to fall back to when a version manager's per-session `$PATH`
 * entry is gone, or nothing when the selected version cannot be established.
 *
 * The dir such a shell puts on `$PATH` (`fnm_multishells/<pid>_<ts>/bin`) is a
 * symlink that disappears with the shell, so it cannot be searched afterwards.
 * The binary itself lives in a stable version dir that does not move — the
 * problem is knowing WHICH one the shell had selected.
 *
 * The answer must never be a guess. Resolving a version the user did not select
 * silently swaps the executable and its context, which is worse than reporting
 * the provider as not found, so the decision is made across the complete state
 * rather than per root:
 *
 *   - The login shell reported exactly one manager. Only that is used.
 *     `$NVM_BIN` names the selected version outright and is authoritative,
 *     replacing any nvm enumeration. `$FNM_DIR` names only the active root, so
 *     that root — and no other — is consulted, and it answers only if it holds
 *     exactly one version. Default roots are not scanned at all: if we know
 *     which manager is active and it cannot answer, an unrelated installation
 *     is not a better answer.
 *   - The login shell reported BOTH managers. Which one was active was decided
 *     by the live `$PATH` order, which is exactly what is no longer available,
 *     so neither answers.
 *   - The login shell reported nothing. The default roots are scanned and the
 *     result is used only when there is exactly ONE safe candidate in total.
 *     Two single-version roots are just as ambiguous as one two-version root.
 *
 * It is a FALLBACK, not a preference: callers search it only after the
 * login-shell dirs, so a live selection always wins.
 *
 * Every root is vetted with {@link resolveOutsideProtectedRootsOnThisHost}
 * before it is listed, and every candidate before it is returned. Nothing is
 * trusted for being spelled like a version manager: `$FNM_DIR` is
 * user-controlled, and `~/.nvm`, a fnm data dir, or a single version entry can
 * each be a symlink — or sit under one — pointing into a protected folder.
 */
export function versionManagerBinDirs(home: string, deps: VersionManagerDirDeps = {}): string[] {
  const readDir = deps.readDir ?? readdirSync;
  const readLink = deps.readLink;
  const env = deps.env ?? process.env;
  const active = deps.active ?? {};

  const safe = (path: string): string | null => resolveOutsideProtectedRootsOnThisHost(path, readLink);

  /**
   * The single installed version under `root`, or nothing when the root is
   * unsafe, absent, empty, or holds more than one. Listing happens only after
   * the root itself is known to be safe.
   */
  const soleVersionUnder = (root: string, layout: (versionsRoot: string, version: string) => string): string[] => {
    const vetted = safe(root);
    if (vetted === null) return [];
    let entries: string[];
    try {
      entries = readDir(vetted);
    } catch {
      // No such version manager on this host, or the root is unreadable.
      return [];
    }
    const [only] = entries;
    if (entries.length !== 1 || only === undefined) return [];
    return [layout(vetted, only)];
  };

  const nvmLayout = (versionsRoot: string, version: string): string => join(versionsRoot, version, "bin");
  const fnmLayout = (versionsRoot: string, version: string): string =>
    join(versionsRoot, version, "installation", "bin");

  if (active.nvmBin !== undefined || active.fnmDir !== undefined) {
    // Two managers reported: which one was actually active was decided by the
    // live `$PATH` order, and once that entry is gone the variables alone do
    // not say. Both can be set when both init scripts ran, or when one survived
    // a later PATH change. Answering with either is a guess, so answer neither.
    if (active.nvmBin !== undefined && active.fnmDir !== undefined) return [];
    const fromActive =
      active.nvmBin !== undefined
        ? [active.nvmBin]
        : soleVersionUnder(join(active.fnmDir ?? "", "node-versions"), fnmLayout);
    const vettedActive = fromActive.map(safe).filter((dir): dir is string => dir !== null);
    return vettedActive.length === 1 ? vettedActive : [];
  }

  // fnm's data dir varies by installer: XDG default, Homebrew on macOS, and the
  // pre-XDG layout. `$FNM_DIR` from the daemon's own environment is included for
  // a host that exports it outside the login shell.
  const defaultRoots: Array<[string, (versionsRoot: string, version: string) => string]> = [
    [join(home, ".nvm", "versions", "node"), nvmLayout],
    ...[
      env.FNM_DIR,
      join(home, ".local", "share", "fnm"),
      join(home, "Library", "Application Support", "fnm"),
      join(home, ".fnm"),
    ]
      .filter((root): root is string => typeof root === "string" && root.length > 0)
      .map((root): [string, (versionsRoot: string, version: string) => string] => [
        join(root, "node-versions"),
        fnmLayout,
      ]),
  ];

  const seen = new Set<string>();
  const candidates = defaultRoots.flatMap(([root, layout]) => {
    if (seen.has(root)) return [];
    seen.add(root);
    return soleVersionUnder(root, layout);
  });

  const vetted = candidates.map(safe).filter((dir): dir is string => dir !== null);
  // Globally ambiguous: two roots each holding one version say no more about the
  // user's selection than one root holding two.
  return vetted.length === 1 ? vetted : [];
}

/**
 * macOS desktop-app resource directories that can carry the Codex CLI.
 *
 * Codex originally shipped as `/Applications/Codex.app`, then moved into the
 * ChatGPT desktop app. Keep the current name first and retain the standalone
 * app as a compatibility fallback. Per-user app installs use the same order.
 */
export function codexDesktopAppBinDirs(home: string, platform: NodeJS.Platform = process.platform): string[] {
  if (platform !== "darwin") return [];

  return [
    join("/Applications", "ChatGPT.app", "Contents", "Resources"),
    join(home, "Applications", "ChatGPT.app", "Contents", "Resources"),
    // Newer ChatGPT releases embed Codex in a nested app bundle.
    join("/Applications", "ChatGPT.app", "Contents", "Resources", "codex-cli", "CodexCLI.app", "Contents", "MacOS"),
    join(
      home,
      "Applications",
      "ChatGPT.app",
      "Contents",
      "Resources",
      "codex-cli",
      "CodexCLI.app",
      "Contents",
      "MacOS",
    ),
    join("/Applications", "Codex.app", "Contents", "Resources"),
    join(home, "Applications", "Codex.app", "Contents", "Resources"),
  ];
}
