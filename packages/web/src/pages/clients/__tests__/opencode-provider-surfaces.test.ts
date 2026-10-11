import { describe, expect, it } from "vitest";
import {
  buildInstallCommand,
  PROVIDER_LABEL,
  providerInstallHint,
  runtimeProviderLabel,
} from "../cards/shared/providers.js";
import { providerSupportsInProductAuth } from "../cards/shared/runtime-auth-view.js";

describe("OpenCode provider surfaces", () => {
  it("labels OpenCode and keeps auth host-local", () => {
    expect(PROVIDER_LABEL.opencode).toBe("OpenCode");
    expect(runtimeProviderLabel("opencode")).toBe("OpenCode");
    expect(providerSupportsInProductAuth("opencode")).toBe(false);
  });

  it("shows the pinned package family and provider-owned login command", () => {
    expect(buildInstallCommand("opencode")).toBe("npm install -g opencode-ai@^2\nopencode auth login");
    expect(providerInstallHint("opencode", "win32")).toContain("opencode auth login");
    expect(providerInstallHint("opencode", "win32")).toContain("Windows PC");
  });
});
