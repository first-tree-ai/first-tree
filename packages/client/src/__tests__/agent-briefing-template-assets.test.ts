import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");

describe("agent briefing template assets", () => {
  it("copy script materializes the briefing template and canonical Context assets", () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "first-tree-template-assets-"));
    try {
      const relativePackageDir = relative(repoRoot, tempRoot);

      execFileSync("node", ["scripts/copy-client-runtime-templates.mjs", relativePackageDir], {
        cwd: repoRoot,
        stdio: "pipe",
      });

      const copiedTemplate = join(tempRoot, "dist", "templates", "agent-briefing.ejs");
      const copiedPolicy = join(tempRoot, "dist", "runtime-assets", "context-tree-policy.md");
      const copiedWriteRouting = join(tempRoot, "dist", "runtime-assets", "context-tree-write-routing.md");
      expect(existsSync(copiedTemplate)).toBe(true);
      expect(existsSync(copiedPolicy)).toBe(true);
      expect(existsSync(copiedWriteRouting)).toBe(true);

      const copiedSource = readFileSync(copiedTemplate, "utf8");
      const sourceTemplate = readFileSync(
        join(repoRoot, "packages", "client", "src", "runtime", "templates", "agent-briefing.ejs"),
        "utf8",
      );
      const sourcePolicy = readFileSync(
        join(repoRoot, "packages", "client", "src", "runtime", "assets", "context-tree-policy.md"),
        "utf8",
      );
      const sourceWriteRouting = readFileSync(
        join(repoRoot, "packages", "client", "src", "runtime", "assets", "context-tree-write-routing.md"),
        "utf8",
      );

      expect(copiedSource).toBe(sourceTemplate);
      expect(readFileSync(copiedPolicy, "utf8")).toBe(sourcePolicy);
      expect(readFileSync(copiedWriteRouting, "utf8")).toBe(sourceWriteRouting);
      expect(copiedSource).toContain("# Working in First Tree (First Tree Managed)");
      expect(copiedSource).toContain("## GitLab Working Posture");
      expect(copiedSource).toContain("## GitLab Entity Attention");
      expect(copiedSource).toContain("gitlab follow <url>");
      expect(copiedSource).toContain("inbound-only and may return pending or active");
      expect(copiedSource).not.toContain("first-tree-gitlab");
      expect(copiedSource).not.toContain("glab mr subscribe <iid-or-branch>");
      expect(copiedSource).not.toContain("ordinary GitLab review");
      expect(copiedSource).toContain("GitHub publishes the App verdict");
      expect(copiedSource).toContain("GitLab uses the Reviewer's local");
      expect(copiedSource).not.toContain("## Context Tree Policy");
      expect(readFileSync(copiedPolicy, "utf8")).toContain("## Context Tree Policy");
      expect(copiedSource).toContain("# Skills (First Tree Managed)");
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("ships a DeepSeek cordis template the harness can actually boot", () => {
    const cordis = readFileSync(
      join(repoRoot, "packages", "client", "src", "providers", "deepseek-harness", "cordis.yml"),
      "utf8",
    );
    // `toolBash` accepts `false` or an options object; `true` fails schema validation
    // and kills the harness at boot with a ValidationError.
    expect(cordis).not.toMatch(/^\s+toolBash:\s*true\s*$/m);
    // `dsh-bash-local` injects the `subprocess` service. With no provider mounted the
    // entry never activates and boot fails with "1 entry did not activate".
    expect(cordis).toMatch(/name:\s*'@deepseek-ai\/dsh-subprocess'/);
  });
});
