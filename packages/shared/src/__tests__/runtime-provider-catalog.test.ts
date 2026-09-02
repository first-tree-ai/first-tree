import { describe, expect, it } from "vitest";
import {
  AMP_INSTALL_COMMAND,
  asRuntimeProvider,
  capabilityEntrySchema,
  DEEPSEEK_INSTALL_NPM_PACKAGE,
  DISABLED_RUNTIME_PROVIDERS,
  enabledOkRuntimeProviders,
  enabledRuntimeProviders,
  isRuntimeProviderEnabled,
  KIMI_NPM_PACKAGE,
  OPENCODE_MINIMUM_VERSION,
  OPENCODE_NPM_PACKAGE,
  orderRuntimeProvidersByPreference,
  PREFERRED_RUNTIME_PROVIDER,
  pickPreferredRuntimeProvider,
  RUNTIME_PROVIDER_CATALOG,
  RUNTIME_PROVIDER_DISPLAY_ORDER,
  RUNTIME_PROVIDER_IDS,
  RUNTIME_PROVIDER_LABELS,
  RUNTIME_PROVIDER_PREFERRED_ORDER,
  RUNTIME_PROVIDERS,
  runtimeAuthProviderSchema,
  runtimeProviderAuthOwnerLabel,
  runtimeProviderChatAuthLoginPhrase,
  runtimeProviderComputerSetupCommand,
  runtimeProviderInProductAuthTarget,
  runtimeProviderInstallCommand,
  runtimeProviderInteractiveLoginCue,
  runtimeProviderLabel,
  runtimeProviderLoginCommand,
  runtimeProviderLoginSteps,
  runtimeProviderPreferredCredential,
  runtimeProviderPreferredCredentialProse,
  runtimeProviderSchema,
  runtimeProviderShowsHostLoginOnSetup,
} from "../index.js";

describe("runtime provider identity + catalog completeness", () => {
  it("derives schema, named constants, and catalog from one Zod source", () => {
    expect([...runtimeProviderSchema.options]).toEqual([...RUNTIME_PROVIDER_IDS]);
    expect(Object.isFrozen(RUNTIME_PROVIDERS)).toBe(true);
    expect(Object.values(RUNTIME_PROVIDERS).sort()).toEqual([...RUNTIME_PROVIDER_IDS].sort());
    expect(Object.keys(RUNTIME_PROVIDERS).sort()).toEqual(
      [...RUNTIME_PROVIDER_IDS].map((id) => id.replace(/-/g, "_").toUpperCase()).sort(),
    );
    expect(RUNTIME_PROVIDERS.CLAUDE_CODE).toBe("claude-code");
    expect(RUNTIME_PROVIDERS.CLAUDE_CODE_TUI).toBe("claude-code-tui");
    expect(RUNTIME_PROVIDERS.CODEX).toBe("codex");
    expect(RUNTIME_PROVIDERS.KIMI_CODE).toBe("kimi-code");
    expect(Object.keys(RUNTIME_PROVIDER_CATALOG).sort()).toEqual([...RUNTIME_PROVIDER_IDS].sort());
    expect(Object.keys(RUNTIME_PROVIDER_LABELS).sort()).toEqual([...RUNTIME_PROVIDER_IDS].sort());
  });

  it("keeps display order exhaustive and creation-time preference explicit", () => {
    expect([...RUNTIME_PROVIDER_DISPLAY_ORDER].sort()).toEqual([...RUNTIME_PROVIDER_IDS].sort());
    const displayOrders = RUNTIME_PROVIDER_DISPLAY_ORDER.map((id) => RUNTIME_PROVIDER_CATALOG[id].displayOrder);
    expect(displayOrders).toEqual([...displayOrders].sort((a, b) => a - b));
    expect(new Set(displayOrders).size).toBe(displayOrders.length);
    const preferencePriorities = RUNTIME_PROVIDER_PREFERRED_ORDER.map(
      (id) => RUNTIME_PROVIDER_CATALOG[id].selectionPriority as number,
    );
    expect(preferencePriorities).toEqual([...preferencePriorities].sort((a, b) => a - b));
    expect(new Set(preferencePriorities).size).toBe(preferencePriorities.length);

    // Phase-1 display: … Grok → Antigravity → Kimi → OpenCode → Pi
    expect(RUNTIME_PROVIDER_DISPLAY_ORDER.indexOf("kimi-code")).toBeLessThan(
      RUNTIME_PROVIDER_DISPLAY_ORDER.indexOf("opencode"),
    );
    // Agent creation: Codex → Claude, then preserve the selected Client's order.
    expect(RUNTIME_PROVIDER_PREFERRED_ORDER).toEqual(["codex", "claude-code"]);
    expect(
      RUNTIME_PROVIDER_IDS.filter((provider) => RUNTIME_PROVIDER_CATALOG[provider].selectionPriority === null),
    ).toEqual([
      "amp",
      "deepseek-harness",
      "claude-code-tui",
      "cursor",
      "grok",
      "antigravity",
      "kimi-code",
      "opencode",
      "pi",
      "zcode",
    ]);
    expect(PREFERRED_RUNTIME_PROVIDER).toBe("codex");
    expect(orderRuntimeProvidersByPreference(["pi", "opencode", "claude-code", "kimi-code", "codex"])).toEqual([
      "codex",
      "claude-code",
      "pi",
      "opencode",
      "kimi-code",
    ]);
  });

  it("treats disabled providers as a subset of known IDs", () => {
    for (const disabled of DISABLED_RUNTIME_PROVIDERS) {
      expect(RUNTIME_PROVIDER_IDS).toContain(disabled);
      expect(isRuntimeProviderEnabled(disabled)).toBe(false);
    }
    expect(enabledRuntimeProviders()).toEqual(
      RUNTIME_PROVIDER_DISPLAY_ORDER.filter((id) => isRuntimeProviderEnabled(id)),
    );
    expect(enabledRuntimeProviders()).not.toContain("claude-code-tui");
    expect(enabledRuntimeProviders()).not.toContain("antigravity");
  });

  it("exposes stable install/login metadata from structured catalog fields", () => {
    for (const id of RUNTIME_PROVIDER_IDS) {
      const entry = RUNTIME_PROVIDER_CATALOG[id];
      expect(entry.id).toBe(id);
      expect(entry.label.length).toBeGreaterThan(0);
      expect(entry.label).toBe(RUNTIME_PROVIDER_LABELS[id]);
      expect(runtimeProviderLabel(id)).toBe(entry.label);
      expect(entry.loginSteps.length).toBeGreaterThan(0);
      expect(runtimeProviderLoginSteps(id)).toEqual(entry.loginSteps);
      // loginSteps feed copy-pasteable terminal blocks — keep them executable,
      // not natural-language UI guidance (that belongs on preferredCredential).
      for (const step of entry.loginSteps) {
        expect(step).not.toMatch(/Runtime\s*→|Mark as sensitive/i);
      }
      const install = runtimeProviderInstallCommand(id);
      expect(install.length).toBeGreaterThan(0);
      if (entry.install.kind === "npm") {
        expect(install).toContain(entry.install.package);
        for (const arg of entry.install.args) {
          expect(install).toContain(arg);
        }
      } else {
        if (entry.install.kind === "script") {
          expect(install).toBe(entry.install.command);
        } else {
          expect(entry.install.kind).toBe("managed-official-runtime");
          expect(install).toBe(
            `# First Tree extracts official ZCode 3.10.2 automatically on ${entry.install.platform}`,
          );
        }
      }
      if (runtimeProviderShowsHostLoginOnSetup(id)) {
        expect(entry.authRecovery).toEqual({ kind: "host" });
        expect(runtimeProviderComputerSetupCommand(id)).toBe(`${install}\n${runtimeProviderLoginCommand(id)}`);
      } else {
        expect(entry.authRecovery.kind).toBe("in-product");
        expect(runtimeProviderComputerSetupCommand(id)).toBe(install);
      }
      expect(runtimeProviderAuthOwnerLabel(id).length).toBeGreaterThan(0);
      expect(runtimeProviderChatAuthLoginPhrase(id)).toContain("`");
    }
    expect(runtimeProviderShowsHostLoginOnSetup("kimi-code")).toBe(true);
    expect(runtimeProviderShowsHostLoginOnSetup("opencode")).toBe(true);
    expect(runtimeProviderShowsHostLoginOnSetup("pi")).toBe(true);
    expect(runtimeProviderShowsHostLoginOnSetup("amp")).toBe(true);
    expect(runtimeProviderShowsHostLoginOnSetup("deepseek-harness")).toBe(true);
    expect(runtimeProviderShowsHostLoginOnSetup("zcode")).toBe(true);
    expect(runtimeProviderShowsHostLoginOnSetup("codex")).toBe(false);
    expect(runtimeProviderShowsHostLoginOnSetup("claude-code")).toBe(false);
    expect(runtimeProviderShowsHostLoginOnSetup("claude-code-tui")).toBe(false);
    expect(runtimeProviderShowsHostLoginOnSetup("cursor")).toBe(false);
    expect(runtimeProviderShowsHostLoginOnSetup("grok")).toBe(false);
    expect(runtimeProviderShowsHostLoginOnSetup("antigravity")).toBe(true);
  });

  it("keeps in-product auth targets typed and exactly aligned with the server contract", () => {
    const targets = RUNTIME_PROVIDER_IDS.map(runtimeProviderInProductAuthTarget).filter((target) => target !== null);
    expect([...new Set(targets)]).toEqual([...runtimeAuthProviderSchema.options]);
    for (const provider of runtimeAuthProviderSchema.options) {
      expect(runtimeProviderInProductAuthTarget(provider)).toBe(provider);
    }
    expect(runtimeProviderInProductAuthTarget("claude-code-tui")).toBe("claude-code");
    expect(runtimeProviderInProductAuthTarget("kimi-code")).toBeNull();
    expect(runtimeProviderInProductAuthTarget("opencode")).toBeNull();
    expect(runtimeProviderInProductAuthTarget("pi")).toBeNull();
    expect(runtimeProviderInProductAuthTarget("amp")).toBeNull();
    expect(runtimeProviderInProductAuthTarget("deepseek-harness")).toBeNull();
  });

  it("leaves the published auth-error message uncapped on the wire", () => {
    // The daemon redacts and truncates before publishing, but the cap stays on
    // the daemon: a `.max()` here would make a new server reject an older
    // daemon's snapshot mid-rollout, which is exactly the compatibility break
    // the capability map is designed to avoid.
    const parsed = capabilityEntrySchema.safeParse({
      state: "ok",
      available: true,
      detectedAt: "2026-06-22T12:00:00.000Z",
      lastAuthError: { reason: "exit-nonzero", message: "x".repeat(5_000), at: "2026-06-22T12:00:00.000Z" },
    });
    expect(parsed.success).toBe(true);
  });

  it("narrows wire strings via safeParse and leaves unknown ids unlabeled", () => {
    expect(asRuntimeProvider("codex")).toBe("codex");
    expect(asRuntimeProvider("gemini")).toBeNull();
    expect(runtimeProviderLabel("future-provider")).toBe("future-provider");
  });

  it("locks product-critical strings, OpenCode version, and preferred-runtime priority", () => {
    expect(OPENCODE_MINIMUM_VERSION).toBe("1.18.7");
    expect(OPENCODE_NPM_PACKAGE).toBe(`opencode-ai@^${OPENCODE_MINIMUM_VERSION}`);
    expect(runtimeProviderInstallCommand("pi")).toBe("npm install -g --ignore-scripts @earendil-works/pi-coding-agent");
    expect(runtimeProviderInstallCommand("opencode")).toBe(`npm install -g ${OPENCODE_NPM_PACKAGE}`);
    expect(runtimeProviderInstallCommand("cursor")).toBe("curl https://cursor.com/install -fsS | bash");
    expect(runtimeProviderInstallCommand("grok")).toBe("curl -fsSL https://x.ai/cli/install.sh | bash");
    expect(runtimeProviderInstallCommand("antigravity")).toBe(
      "curl -fsSL https://antigravity.google/cli/install.sh | bash",
    );
    expect(runtimeProviderLoginCommand("antigravity")).toBe("agy");
    expect(runtimeProviderInstallCommand("amp")).toBe(AMP_INSTALL_COMMAND);
    expect(runtimeProviderInstallCommand("deepseek-harness")).toBe(`npm install -g ${DEEPSEEK_INSTALL_NPM_PACKAGE}`);
    expect(runtimeProviderLoginCommand("deepseek-harness")).toBe("export DEEPSEEK_API_KEY=<your DeepSeek API key>");
    expect(runtimeProviderPreferredCredential("deepseek-harness")).toEqual({
      kind: "agent-runtime-env",
      envKey: "DEEPSEEK_API_KEY",
      markSensitive: true,
    });
    expect(runtimeProviderPreferredCredentialProse("deepseek-harness")).toContain("Mark as sensitive");
    expect(runtimeProviderPreferredCredentialProse("amp")).toBeNull();
    expect(runtimeProviderLoginCommand("amp")).toBe("amp login");
    expect(runtimeProviderLoginCommand("zcode")).toBe("first-tree zcode login");
    expect(KIMI_NPM_PACKAGE).toBe("@moonshot-ai/kimi-code");
    expect(RUNTIME_PROVIDER_CATALOG["kimi-code"].install).toEqual({
      kind: "npm",
      package: KIMI_NPM_PACKAGE,
      args: [],
    });
    expect(runtimeProviderLoginCommand("kimi-code")).toBe("kimi # then run /login");
    expect(runtimeProviderLoginCommand("pi")).toBe("pi # then run /login");
    expect(runtimeProviderChatAuthLoginPhrase("kimi-code")).toBe("`kimi` and then `/login`");
    expect(runtimeProviderChatAuthLoginPhrase("codex")).toBe("`codex login`");
    expect(runtimeProviderInteractiveLoginCue("kimi-code")).toBe("run `kimi` and enter `/login`");
    expect(runtimeProviderInteractiveLoginCue("pi")).toBe("run `pi` and enter `/login`");
    expect(runtimeProviderInteractiveLoginCue("codex")).toBe("run `codex login`");
    expect(runtimeProviderInteractiveLoginCue("claude-code")).toBe("run `claude auth login`");
    expect(RUNTIME_PROVIDER_CATALOG["claude-code-tui"].install).toEqual({
      kind: "npm",
      package: "@anthropic-ai/claude-code",
      args: [],
    });
    expect(isRuntimeProviderEnabled("claude-code-tui")).toBe(false);

    expect(
      pickPreferredRuntimeProvider({
        "claude-code": { state: "ok" },
        "claude-code-tui": { state: "ok" },
        codex: { state: "ok" },
      }),
    ).toBe("codex");
    expect(
      pickPreferredRuntimeProvider({
        grok: { state: "ok" },
        "kimi-code": { state: "ok" },
        opencode: { state: "ok" },
        pi: { state: "ok" },
      }),
    ).toBe("grok");
    expect(
      pickPreferredRuntimeProvider({
        "kimi-code": { state: "ok" },
        opencode: { state: "ok" },
        pi: { state: "ok" },
      }),
    ).toBe("kimi-code");
    expect(
      pickPreferredRuntimeProvider({
        "kimi-code": { state: "ok" },
        pi: { state: "ok" },
      }),
    ).toBe("kimi-code");
  });

  it("lists Codex and Claude first, then preserves reported ready-provider order", () => {
    const shuffled = {
      pi: { state: "ok" as const },
      "kimi-code": { state: "ok" as const },
      opencode: { state: "error" as const },
      grok: { state: "ok" as const },
      codex: { state: "ok" as const },
      "claude-code-tui": { state: "ok" as const },
      cursor: { state: "missing" as const },
      "claude-code": { state: "ok" as const },
    };
    expect(Object.keys(shuffled)).toEqual([
      "pi",
      "kimi-code",
      "opencode",
      "grok",
      "codex",
      "claude-code-tui",
      "cursor",
      "claude-code",
    ]);
    expect(enabledOkRuntimeProviders(shuffled)).toEqual(["codex", "claude-code", "pi", "kimi-code", "grok"]);
  });
});
