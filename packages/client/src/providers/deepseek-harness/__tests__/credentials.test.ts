import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveDeepseekApiKeyForLaunch } from "../credentials.js";

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
      writeFileSync(join(home, ".dsh", ".credentials.yaml"), credentialsYaml);
    }
    return home;
  }

  it("prefers the launch-environment key over the credentials file", () => {
    const home = makeHome("refs:\n  DEEPSEEK_API_KEY: file-key\n");
    expect(resolveDeepseekApiKeyForLaunch({ env: { DEEPSEEK_API_KEY: "env-key" }, home })).toBe("env-key");
  });

  it("falls back to the DSH credentials file when the environment has no key", () => {
    const home = makeHome("refs:\n  DEEPSEEK_API_KEY: sk-file-key\n");
    expect(resolveDeepseekApiKeyForLaunch({ env: {}, home })).toBe("sk-file-key");
  });

  it("returns null when neither source has a non-empty key", () => {
    const home = makeHome(null);
    expect(resolveDeepseekApiKeyForLaunch({ env: {}, home })).toBeNull();
  });

  it("treats an empty ambient key as absent and falls back to the file", () => {
    const home = makeHome("refs:\n  DEEPSEEK_API_KEY: sk-file-key\n");
    expect(resolveDeepseekApiKeyForLaunch({ env: { DEEPSEEK_API_KEY: "" }, home })).toBe("sk-file-key");
  });

  it("treats a blank stored ref as absent", () => {
    const home = makeHome('refs:\n  DEEPSEEK_API_KEY: ""\n');
    expect(resolveDeepseekApiKeyForLaunch({ env: {}, home })).toBeNull();
  });

  it("treats a malformed credentials file as absent", () => {
    const home = makeHome("refs: [unclosed\n  DEEPSEEK_API_KEY: {{{\n");
    expect(resolveDeepseekApiKeyForLaunch({ env: {}, home })).toBeNull();
  });

  it("ignores non-string ref values", () => {
    const home = makeHome("refs:\n  DEEPSEEK_API_KEY: 12345\n");
    expect(resolveDeepseekApiKeyForLaunch({ env: {}, home })).toBeNull();
  });
});
