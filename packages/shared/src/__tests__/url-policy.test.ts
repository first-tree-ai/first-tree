import { describe, expect, it } from "vitest";
import { isTrustedInstallerUrl, trustedInstallerUrlSchema } from "../url-policy.js";

/**
 * SEC-025 (#1631): the portable installer URL is rendered into a
 * `curl -fsSL … | sh` command, so a plaintext URL hands arbitrary code
 * execution to anyone on the network path. Only https — plus loopback http for
 * local testing — may reach that string.
 */
describe("isTrustedInstallerUrl", () => {
  it("accepts https anywhere", () => {
    expect(isTrustedInstallerUrl("https://download.first-tree.ai/releases/prod/install.sh")).toBe(true);
    expect(isTrustedInstallerUrl("https://mirror.internal:8443/releases/prod/install.sh")).toBe(true);
  });

  it("accepts http only on loopback hosts", () => {
    expect(isTrustedInstallerUrl("http://127.0.0.1:8000/releases/prod/install.sh")).toBe(true);
    expect(isTrustedInstallerUrl("http://localhost:8000/releases/prod/install.sh")).toBe(true);
    expect(isTrustedInstallerUrl("http://[::1]:8000/releases/prod/install.sh")).toBe(true);
  });

  it("rejects plaintext hosts, other schemes, and junk", () => {
    expect(isTrustedInstallerUrl("http://downloads.example.test/releases/prod/install.sh")).toBe(false);
    expect(isTrustedInstallerUrl("http://10.0.0.5/releases/prod/install.sh")).toBe(false);
    expect(isTrustedInstallerUrl("ftp://downloads.example.test/install.sh")).toBe(false);
    expect(isTrustedInstallerUrl("not a url")).toBe(false);
  });

  it("keeps the wire schema honest about the same rule", () => {
    expect(trustedInstallerUrlSchema.parse("https://downloads.example.test/prod/install.sh")).toBe(
      "https://downloads.example.test/prod/install.sh",
    );
    expect(() => trustedInstallerUrlSchema.parse("http://downloads.example.test/prod/install.sh")).toThrow(/https/iu);
  });
});
