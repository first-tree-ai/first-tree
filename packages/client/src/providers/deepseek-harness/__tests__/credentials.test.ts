import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  DESKTOP_CREDENTIAL_OPT_IN_ENV,
  DSH_CREDENTIALS_FILE,
  desktopCredentialOptIn,
  resolveDeepseekApiKeyForLaunch,
  trustedDeepseekBaseUrlOverride,
} from "../credentials.js";

describe("DeepSeek launch credential fallback", () => {
  const dirs: string[] = [];

  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  function makeHome(credentialsYaml: string | null): string {
    const home = mkdtempSync(join(tmpdir(), "ft-dsh-cred-"));
    dirs.push(home);
    if (credentialsYaml !== null) {
      mkdirSync(join(home, ".dsh"), { recursive: true });
      writeFileSync(join(home, ".dsh", DSH_CREDENTIALS_FILE), credentialsYaml);
    }
    return home;
  }

  function makeAltHome(credentialsYaml: string, suffix: string): string {
    const altHome = mkdtempSync(join(tmpdir(), `ft-dsh-cred-${suffix}-`));
    dirs.push(altHome);
    writeFileSync(join(altHome, DSH_CREDENTIALS_FILE), credentialsYaml);
    return altHome;
  }

  it("prefers the launch-environment key over the credentials file", () => {
    const home = makeHome("refs:\n  DEEPSEEK_API_KEY: file-key\n");
    expect(resolveDeepseekApiKeyForLaunch({ env: { DEEPSEEK_API_KEY: "env-key" }, home, optIn: true })).toBe("env-key");
  });

  it("falls back to the DSH credentials file only when the host opt-in grants the agent", () => {
    const home = makeHome("refs:\n  DEEPSEEK_API_KEY: sk-file-key\n");
    expect(resolveDeepseekApiKeyForLaunch({ env: {}, home, optIn: true })).toBe("sk-file-key");
  });

  it("fails closed without the opt-in even when the credentials file holds a key", () => {
    const home = makeHome("refs:\n  DEEPSEEK_API_KEY: sk-file-key\n");
    expect(resolveDeepseekApiKeyForLaunch({ env: {}, home, optIn: false })).toBeNull();
  });

  it("honors an agent-scoped opt-in computed from the trusted environment", () => {
    const home = makeHome("refs:\n  DEEPSEEK_API_KEY: sk-file-key\n");
    expect(desktopCredentialOptIn({ [DESKTOP_CREDENTIAL_OPT_IN_ENV]: "agent-a, agent-b" }, "agent-a")).toBe(true);
    expect(desktopCredentialOptIn({ [DESKTOP_CREDENTIAL_OPT_IN_ENV]: "agent-a,agent-b" }, "agent-c")).toBe(false);
    expect(desktopCredentialOptIn({ [DESKTOP_CREDENTIAL_OPT_IN_ENV]: "all" }, "agent-a")).toBe(true);
    expect(desktopCredentialOptIn({ [DESKTOP_CREDENTIAL_OPT_IN_ENV]: "*" }, "agent-a")).toBe(true);
    expect(desktopCredentialOptIn({ [DESKTOP_CREDENTIAL_OPT_IN_ENV]: "" }, "agent-a")).toBe(false);
    expect(desktopCredentialOptIn({}, "agent-a")).toBe(false);
    expect(
      resolveDeepseekApiKeyForLaunch({ env: { [DESKTOP_CREDENTIAL_OPT_IN_ENV]: "agent-x" }, home, agentId: "agent-x" }),
    ).toBe("sk-file-key");
    expect(
      resolveDeepseekApiKeyForLaunch({ env: { [DESKTOP_CREDENTIAL_OPT_IN_ENV]: "agent-y" }, home, agentId: "agent-x" }),
    ).toBeNull();
  });

  it("returns null when neither source has a non-empty key", () => {
    const home = makeHome(null);
    expect(resolveDeepseekApiKeyForLaunch({ env: {}, home, optIn: true })).toBeNull();
  });

  it("treats an empty ambient key as absent and falls back to the file", () => {
    const home = makeHome("refs:\n  DEEPSEEK_API_KEY: sk-file-key\n");
    expect(resolveDeepseekApiKeyForLaunch({ env: { DEEPSEEK_API_KEY: "" }, home, optIn: true })).toBe("sk-file-key");
  });

  it("treats a blank stored ref as absent", () => {
    const home = makeHome('refs:\n  DEEPSEEK_API_KEY: ""\n');
    expect(resolveDeepseekApiKeyForLaunch({ env: {}, home, optIn: true })).toBeNull();
  });

  it("treats a malformed credentials file as absent", () => {
    const home = makeHome("refs: [unclosed\n  DEEPSEEK_API_KEY: {{{\n");
    expect(resolveDeepseekApiKeyForLaunch({ env: {}, home, optIn: true })).toBeNull();
  });

  it("ignores non-string ref values", () => {
    const home = makeHome("refs:\n  DEEPSEEK_API_KEY: 12345\n");
    expect(resolveDeepseekApiKeyForLaunch({ env: {}, home, optIn: true })).toBeNull();
  });

  it("resolves the credentials file under a nondefault DSH_HOME from the trusted layer", () => {
    const altHome = makeAltHome("refs:\n  DEEPSEEK_API_KEY: sk-alt-key\n", "alt");
    const emptyHome = mkdtempSync(join(tmpdir(), "ft-dsh-cred-empty-"));
    dirs.push(emptyHome);
    expect(resolveDeepseekApiKeyForLaunch({ env: { DSH_HOME: altHome }, home: emptyHome, optIn: true })).toBe(
      "sk-alt-key",
    );
  });

  it("expands a tilde DSH_HOME against the operator home", () => {
    const home = makeAltHome("refs:\n  DEEPSEEK_API_KEY: sk-tilde-key\n", "tilde");
    // The tmpdir path itself stands in for the operator home: DSH_HOME "~"
    // expands against `home`, so pass the tmp dir as the home.
    expect(resolveDeepseekApiKeyForLaunch({ env: { DSH_HOME: "~" }, home, optIn: true })).toBe("sk-tilde-key");
  });

  it("treats a blank DSH_HOME as unset", () => {
    const home = makeHome("refs:\n  DEEPSEEK_API_KEY: sk-default-key\n");
    expect(resolveDeepseekApiKeyForLaunch({ env: { DSH_HOME: "   " }, home, optIn: true })).toBe("sk-default-key");
  });

  it("binds a reused key to the authorized origin: a trusted DEEPSEEK_BASE_URL override survives, otherwise the caller strips an untrusted one", () => {
    expect(trustedDeepseekBaseUrlOverride({ DEEPSEEK_BASE_URL: "https://internal.gateway" })).toBe(
      "https://internal.gateway",
    );
    expect(trustedDeepseekBaseUrlOverride({})).toBeNull();
    expect(trustedDeepseekBaseUrlOverride({ DEEPSEEK_BASE_URL: "   " })).toBeNull();
  });
});
