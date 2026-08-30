/**
 * Channel-aware CLI binding for runtime code that needs to talk about
 * (or shell out to) the CLI by name.
 *
 * `packages/client` ships as a single bundle reused across prod / staging /
 * dev builds, while the CLI binary's name (`first-tree`, `first-tree-staging`,
 * `first-tree-dev`) is fixed at build time via `apps/cli/src/build-info.ts`.
 * To keep runtime code channel-correct without dragging `apps/cli` build-info
 * into this package, the entrypoint (`apps/cli/src/cli/index.ts`) calls
 * {@link setCliBinding} with the resolved channel identity before any
 * runtime / handler code runs. Bootstrap and similar helpers then read the
 * binding via {@link getCliBinding}.
 *
 * Same pattern as `apps/cli/src/core/channel-env.ts`: set once at startup,
 * read lazily at the call site, no module-load ordering footgun.
 */

export type CliBinding = {
  /**
   * Binary name on PATH for this channel — `first-tree` (prod),
   * `first-tree-staging` (staging), `first-tree-dev` (dev).
   * Interpolated into the agent-facing AGENTS.md briefing (the
   * `# Working in First Tree` intro, `## First Tree CLI` section, and every
   * `${bin} chat …` example) and used as the `command` argv[0] for any
   * sub-process shelling out to the CLI.
   */
  binName: string;
  /**
   * Published npm package name — `first-tree` / `first-tree-staging`.
   * `null` for the dev channel: dev binaries are not published, so any
   * `npx <pkg>@latest` fallback must be skipped.
   */
  packageName: string | null;
};

let currentBinding: CliBinding | null = null;

/**
 * Install the channel-resolved CLI identity into the runtime. Called once
 * by the CLI entrypoint after `channelConfig` is loaded. Idempotent —
 * subsequent calls overwrite, which lets tests stub a binding without
 * reloading the module.
 */
export function setCliBinding(binding: CliBinding): void {
  currentBinding = { ...binding };
}

/**
 * Read the active CLI binding. Throws when the entrypoint forgot to call
 * {@link setCliBinding} — running runtime code without a binding would
 * silently produce wrong CLI command names in agent prompts, so we fail
 * loud instead. Tests that exercise runtime code MUST call
 * `setCliBinding(...)` in setup.
 */
export function getCliBinding(): CliBinding {
  if (!currentBinding) {
    throw new Error(
      "CLI binding not initialised — apps/cli entrypoint must call setCliBinding() before runtime code runs (or tests must stub it in setup).",
    );
  }
  return currentBinding;
}

/**
 * Test-only escape hatch: clear the binding so a subsequent test can
 * assert the "not initialised" failure path without leaking state across
 * test files. Not exported from the package index.
 */
export function resetCliBindingForTest(): void {
  currentBinding = null;
}
