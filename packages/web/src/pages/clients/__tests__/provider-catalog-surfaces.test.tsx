// @vitest-environment happy-dom

import {
  DISABLED_RUNTIME_PROVIDERS,
  enabledOkRuntimeProviders,
  pickPreferredRuntimeProvider,
  RUNTIME_PROVIDER_IDS,
  type RuntimeProvider,
  runtimeProviderLabel as sharedRuntimeProviderLabel,
} from "@first-tree/shared";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import {
  asRuntimeProvider,
  buildInstallCommand,
  PROVIDER_LABEL,
  PROVIDER_ORDER,
  providerInstallHint,
  runtimeProviderLabel,
} from "../cards/shared/providers.js";
import { RuntimeInstallBox } from "../cards/shared/runtime-install-box.js";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const IN_PRODUCT_SETUP_CASES = [
  ["claude-code", "claude auth login"],
  ["claude-code-tui", "claude auth login"],
  ["codex", "codex login"],
  ["cursor", "cursor-agent login"],
  ["grok", "grok login"],
] as const satisfies readonly (readonly [RuntimeProvider, string])[];

const HOST_SETUP_CASES = [
  ["amp", "amp login"],
  ["antigravity", "agy"],
  ["deepseek-harness", "export DEEPSEEK_API_KEY=<your DeepSeek API key>"],
  ["kimi-code", "kimi # then run /login"],
  ["opencode", "opencode auth login"],
  ["pi", "pi # then run /login"],
] as const satisfies readonly (readonly [RuntimeProvider, string])[];

let root: Root | null = null;
let container: HTMLElement | null = null;

async function render(element: React.ReactElement): Promise<HTMLElement> {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(element);
  });
  if (!container) throw new Error("container missing");
  return container;
}

afterEach(async () => {
  if (root) {
    await act(async () => {
      root?.unmount();
    });
  }
  container?.remove();
  root = null;
  container = null;
});

describe("web provider surfaces derived from shared catalog", () => {
  it("offers only enabled providers and keeps disabled labels for already-bound agents", () => {
    expect(PROVIDER_ORDER).not.toContain("claude-code-tui");
    for (const disabled of DISABLED_RUNTIME_PROVIDERS) {
      expect(PROVIDER_ORDER).not.toContain(disabled);
      expect(PROVIDER_LABEL[disabled].length).toBeGreaterThan(0);
    }
    expect(PROVIDER_ORDER.length).toBe(RUNTIME_PROVIDER_IDS.length - DISABLED_RUNTIME_PROVIDERS.length);
  });

  it("preserves unknown-provider fallback labeling across shared helpers", () => {
    expect(asRuntimeProvider("future-provider")).toBeNull();
    expect(runtimeProviderLabel("future-provider")).toBe("future-provider");
    expect(sharedRuntimeProviderLabel("future-provider")).toBe("future-provider");
    expect(runtimeProviderLabel("codex")).toBe("Codex");
    expect(sharedRuntimeProviderLabel("codex")).toBe(PROVIDER_LABEL.codex);
  });

  it("picks Codex then Claude, otherwise the first Client-reported ready provider", () => {
    expect(
      pickPreferredRuntimeProvider({
        "claude-code-tui": { state: "ok" },
        codex: { state: "ok" },
      }),
    ).toBe("codex");
    expect(
      pickPreferredRuntimeProvider({
        "claude-code": { state: "ok" },
        codex: { state: "ok" },
      }),
    ).toBe("codex");
    // No explicit preference is ready, so the selected Client's order wins.
    expect(
      pickPreferredRuntimeProvider({
        "kimi-code": { state: "ok" },
        opencode: { state: "ok" },
        pi: { state: "ok" },
      }),
    ).toBe("kimi-code");
    expect(pickPreferredRuntimeProvider({ "future-provider": { state: "ok" } })).toBeNull();
  });

  it("orders NewAgentDialog-style options by preference prefix, then Client report order", () => {
    const shuffled = {
      pi: { state: "ok" as const },
      "kimi-code": { state: "ok" as const },
      grok: { state: "ok" as const },
      "claude-code": { state: "ok" as const },
    };
    expect(enabledOkRuntimeProviders(shuffled)).toEqual(["claude-code", "pi", "kimi-code", "grok"]);
  });

  it("locks install/login copy that cards and onboarding render", () => {
    expect(buildInstallCommand("pi")).toBe(
      "npm install -g --ignore-scripts @earendil-works/pi-coding-agent\npi # then run /login",
    );
    expect(buildInstallCommand("opencode")).toBe("npm install -g opencode-ai@^1.18.7\nopencode auth login");
    expect(buildInstallCommand("amp")).toBe("curl -fsSL https://ampcode.com/install.sh | bash\namp login");
    expect(providerInstallHint("amp", "linux")).toContain("ampcode.com/install.sh");
    expect(buildInstallCommand("deepseek-harness")).toContain("export DEEPSEEK_API_KEY=<your DeepSeek API key>");
    expect(buildInstallCommand("deepseek-harness")).toContain(
      "# preferred: set `DEEPSEEK_API_KEY` on the agent's Runtime → Environment variables and Mark as sensitive",
    );
    expect(providerInstallHint("deepseek-harness", "linux")).toContain("Runtime → Environment variables");
    expect(providerInstallHint("deepseek-harness", "linux")).toContain("Mark as sensitive");
    expect(providerInstallHint("deepseek-harness", "linux")).toContain("host shell");
    expect(providerInstallHint("deepseek-harness", "linux")).not.toMatch(/shell environment\.?$/);
    expect(buildInstallCommand("grok")).toBe("curl -fsSL https://x.ai/cli/install.sh | bash");
    expect(buildInstallCommand("cursor")).not.toContain("cursor-agent login");
    expect(buildInstallCommand("grok")).not.toContain("grok login");
    expect(buildInstallCommand("codex")).toBe("npm install -g @openai/codex");
    expect(buildInstallCommand("codex")).not.toContain("codex login");
    expect(buildInstallCommand("kimi-code")).toContain("kimi # then run /login");
    expect(buildInstallCommand("claude-code-tui", "darwin")).toContain("brew install tmux");
    expect(buildInstallCommand("claude-code-tui", "darwin")).not.toContain("claude auth login");
    expect(providerInstallHint("pi", "darwin")).toContain("--ignore-scripts");
    expect(providerInstallHint("pi", "darwin")).toContain("run `pi` and enter `/login`");
    expect(providerInstallHint("kimi-code", "linux")).toContain("run `kimi` and enter `/login`");
    expect(providerInstallHint("codex", "darwin")).toContain("npm install -g @openai/codex");
    expect(providerInstallHint("codex", "darwin")).not.toContain("codex login");
    expect(providerInstallHint("codex", "darwin")).not.toContain("Install the OpenAI Codex CLI");
    expect(providerInstallHint("opencode", "linux")).toContain("opencode-ai@^1.18.7");
    expect(providerInstallHint("claude-code-tui", "darwin", "tmux not found")).toContain("brew install tmux");
    expect(providerInstallHint("claude-code-tui", "darwin", "tmux not found")).not.toContain(
      "npm install -g @anthropic-ai/claude-code",
    );
  });

  for (const [provider, loginCommand] of IN_PRODUCT_SETUP_CASES) {
    it(`renders RuntimeInstallBox install-only for in-product provider ${provider}`, async () => {
      const expected = buildInstallCommand(provider, "darwin");
      const el = await render(<RuntimeInstallBox provider={provider} entry={null} hostname="devbox" os="darwin" />);
      const text = el.textContent ?? "";
      expect(text).toContain(PROVIDER_LABEL[provider]);
      expect(text).toContain(expected);
      expect(text).not.toContain(loginCommand);
      expect(el.querySelector("pre")?.textContent).toBe(expected);
    });
  }

  for (const [provider, loginCommand] of HOST_SETUP_CASES) {
    it(`renders RuntimeInstallBox with host-login guidance for provider ${provider}`, async () => {
      const expected = buildInstallCommand(provider, "darwin");
      const el = await render(<RuntimeInstallBox provider={provider} entry={null} hostname="devbox" os="darwin" />);
      const text = el.textContent ?? "";
      expect(text).toContain(PROVIDER_LABEL[provider]);
      expect(text).toContain(loginCommand);
      expect(el.querySelector("pre")?.textContent).toBe(expected);
    });
  }
});
