import {
  AMP_INSTALL_COMMAND,
  asRuntimeProvider,
  CURSOR_INSTALL_COMMAND,
  enabledRuntimeProviders,
  GROK_INSTALL_COMMAND,
  RUNTIME_PROVIDER_CATALOG,
  RUNTIME_PROVIDER_IDS,
  RUNTIME_PROVIDER_LABELS,
  type RuntimeProvider,
  recordByRuntimeProvider,
  runtimeProviderComputerSetupCommand,
  runtimeProviderInstallCommand,
  runtimeProviderInteractiveLoginCue,
  runtimeProviderLabel,
  runtimeProviderLoginCommand,
  runtimeProviderPreferredCredentialProse,
  runtimeProviderShowsHostLoginOnSetup,
} from "@first-tree/shared";

/**
 * Web presentation helpers over the shared runtime-provider catalog.
 *
 * Labels, display order, npm/script install commands, and login commands are
 * owned by `@first-tree/shared`. This module only adds OS-specific presentation
 * (tmux package manager, device phrases, missing-state hints).
 */

export { asRuntimeProvider, CURSOR_INSTALL_COMMAND, GROK_INSTALL_COMMAND, runtimeProviderLabel };

/**
 * Display order for runtime sections — enabled providers only, derived from the
 * shared catalog. Temporarily-disabled providers are filtered out so they are
 * never offered across Ready / Offline / Setup-incomplete / Auth-expired cards.
 */
export const PROVIDER_ORDER: RuntimeProvider[] = enabledRuntimeProviders();

/** Friendly labels for every known provider (including disabled). */
export const PROVIDER_LABEL: Record<RuntimeProvider, string> = { ...RUNTIME_PROVIDER_LABELS };

/** `npm install -g` package spec per runtime, or null for script-only installs. */
export const PROVIDER_NPM_PACKAGE: Readonly<Record<RuntimeProvider, string | null>> = recordByRuntimeProvider(
  RUNTIME_PROVIDER_IDS.map((id) => {
    const install = RUNTIME_PROVIDER_CATALOG[id].install;
    return [id, install.kind === "npm" ? install.package : null] as const;
  }),
);

/** Per-runtime login command shown after install. */
export const PROVIDER_LOGIN_COMMAND: Readonly<Record<RuntimeProvider, string>> = recordByRuntimeProvider(
  RUNTIME_PROVIDER_IDS.map((id) => [id, runtimeProviderLoginCommand(id)] as const),
);

/**
 * The single install command line for a provider: the `npm install -g` spec
 * when one exists, otherwise the provider's official installer script.
 */
export function providerInstallCommand(provider: RuntimeProvider): string {
  return runtimeProviderInstallCommand(provider);
}

/**
 * One-liner install + login command for an empty Setup-incomplete card.
 * Joined with `\n` so the CommandPanel-style pre block renders both
 * lines. The Setup-incomplete card body wraps this in a per-provider
 * box with a copy button per box.
 */
export function buildInstallCommand(provider: RuntimeProvider, os?: string | null): string {
  if (provider === "claude-code-tui") {
    // The tmux-driven runtime additionally needs tmux (>= 3.0). tmux is not an
    // npm package, so emit the command for the host's actual package manager
    // (keyed off the client's reported OS). Unknown OS → a non-command note
    // rather than a guessed package manager.
    const tmuxCmd = tmuxInstallCommand(os);
    return runtimeProviderComputerSetupCommand(provider, [
      tmuxCmd ?? "# install tmux (>= 3.0) with your OS package manager",
    ]);
  }
  if (provider === "deepseek-harness") {
    // loginSteps stays the copy-pasteable host export; preferredCredential
    // prose is a comment so the command block remains executable.
    const preferred = runtimeProviderPreferredCredentialProse(provider);
    return runtimeProviderComputerSetupCommand(provider, preferred ? [`# preferred: ${preferred}`] : []);
  }
  return runtimeProviderComputerSetupCommand(provider);
}

/**
 * OS-specific command to install tmux (>= 3.0), keyed off the client's reported
 * OS (`darwin` / `linux` / `win32`). tmux is not an npm package, so the right
 * command depends on the host package manager. Windows has no native tmux — it
 * runs inside WSL, so the command targets the WSL distro.
 */
export function tmuxInstallCommand(os: string | null | undefined): string | null {
  switch (os) {
    case "darwin":
      return "brew install tmux";
    case "linux":
      // apt covers Debian/Ubuntu; other distros swap the package manager
      // (dnf / pacman / …), but apt is the common default.
      return "sudo apt install tmux";
    case "win32":
    case "windows":
      // No native Windows tmux — it runs inside WSL.
      return "wsl sudo apt install tmux";
    default:
      // Unknown / unreported OS — don't assume a package manager. A real client
      // always reports `process.platform`; this only guards legacy/unknown rows,
      // where callers fall back to naming the requirement without a command.
      return null;
  }
}

/**
 * Friendly "this Mac / this Linux machine / this Windows PC" phrase
 * derived from the client's reported OS. Lets recovery copy address
 * the user's actual hardware instead of the generic "computer".
 *
 * Maps the kernel-side strings the SDK reports (`darwin`, `linux`,
 * `win32`). Unknown / null falls back to "computer" — never breaks the
 * sentence shape.
 */
export function osDeviceName(os: string | null | undefined): string {
  switch (os) {
    case "darwin":
      return "Mac";
    case "linux":
      return "Linux machine";
    case "win32":
    case "windows":
      return "Windows PC";
    default:
      return "computer";
  }
}

/**
 * Hint for `state="missing"`. Distinct from `entry === null` ("not
 * reported") — that case is suppressed in the Ready card entirely, so
 * the hint only shows when the SDK explicitly probed and confirmed the
 * runtime is not installed.
 *
 * `error` is the probe's verbatim resolve-stage reason. For
 * `claude-code-tui` the runtime needs BOTH the `claude` CLI and tmux
 * (>= 3.0), and the probe reports exactly which is missing ("tmux not
 * found" / "`claude` not found …"). Passing it lets the hint name only the
 * piece that is actually absent, so a machine that already has Claude Code
 * and only lacks tmux is told to install tmux — not to reinstall the CLI
 * it already has. When `error` is absent we fall back to naming both.
 */
export function providerInstallHint(
  provider: RuntimeProvider,
  os: string | null | undefined,
  error?: string | null,
): string {
  const device = osDeviceName(os);
  const installCmd = runtimeProviderInstallCommand(provider);
  const loginCmd = runtimeProviderLoginCommand(provider);
  const loginCue = runtimeProviderInteractiveLoginCue(provider);

  switch (provider) {
    case "claude-code":
      return `Run \`${installCmd}\` on this ${device}.`;
    case "claude-code-tui": {
      // The probe joins per-requirement reasons (claude + tmux) into one string;
      // match on each so we can tailor the hint to what's genuinely missing. The
      // tmux command is keyed to the host OS (brew / apt / WSL).
      const claudeMissing = error == null || /claude/i.test(error);
      const tmuxMissing = error == null || /tmux/i.test(error);
      // OS-keyed tmux command (brew / apt / WSL), or null for an unknown OS — then
      // name the requirement without assuming a package manager.
      const tmuxCmd = tmuxInstallCommand(os);
      if (tmuxMissing && !claudeMissing) {
        return tmuxCmd
          ? `Run \`${tmuxCmd}\` on this ${device} (tmux >= 3.0).`
          : `Install tmux (>= 3.0) on this ${device} with your package manager.`;
      }
      if (claudeMissing && !tmuxMissing) {
        return `Run \`${installCmd}\` on this ${device}.`;
      }
      return tmuxCmd
        ? `Run \`${installCmd}\` and \`${tmuxCmd}\` (tmux >= 3.0) on this ${device}.`
        : `Run \`${installCmd}\`, then install tmux (>= 3.0) with your package manager, on this ${device}.`;
    }
    case "amp":
      return `Run \`${AMP_INSTALL_COMMAND}\` on this ${device} (official Amp installer), then complete provider-owned setup with \`${loginCmd}\`.`;
    case "deepseek-harness": {
      const preferred =
        runtimeProviderPreferredCredentialProse(provider) ??
        `set \`DEEPSEEK_API_KEY\` on the agent's Runtime → Environment variables and Mark as sensitive`;
      return (
        `Install the bundled DeepSeek Harness packages with \`${installCmd}\` on this ${device}, ` +
        `then ${preferred} (or export it in the host shell that runs First Tree).`
      );
    }
    case "cursor":
      return `Run \`${CURSOR_INSTALL_COMMAND}\` on this ${device} (official Cursor installer).`;
    case "grok":
      return `Run \`${GROK_INSTALL_COMMAND}\` on this ${device} (official Grok Build installer).`;
    case "antigravity":
      return `Run \`${installCmd}\` on this ${device} (official Google Antigravity installer), then complete provider-owned setup with \`${loginCmd}\`.`;
    case "kimi-code":
      return `Install the official Kimi CLI with \`${installCmd}\` on this ${device}, ${loginCue}. First Tree still executes through its bundled Kimi SDK.`;
    case "opencode":
      return `Run \`${installCmd}\` on this ${device}, then complete provider-owned setup with \`${loginCmd}\`.`;
    case "pi":
      return `Run \`${installCmd}\` on this ${device}, then ${loginCue}.`;
    case "codex":
      // In-product browser-OAuth — computer row stays install-only.
      return `Run \`${installCmd}\` on this ${device}.`;
    default: {
      const _exhaustive: never = provider;
      const cmd = runtimeProviderInstallCommand(_exhaustive);
      if (!runtimeProviderShowsHostLoginOnSetup(_exhaustive)) {
        return `Run \`${cmd}\` on this ${device}.`;
      }
      return `Run \`${cmd}\` on this ${device}, then ${runtimeProviderInteractiveLoginCue(_exhaustive)}.`;
    }
  }
}
