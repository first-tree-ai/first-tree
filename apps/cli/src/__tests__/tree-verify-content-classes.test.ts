import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { Command } from "commander";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveLocalTreeTarget } from "../commands/tree/context-links.js";
import { registerTreeCommands } from "../commands/tree/index.js";
import { renderContextTree } from "../commands/tree/tree.js";
import { VERIFY_USAGE, verifyCommand, verifyTreeRoot } from "../commands/tree/verify.js";
import type { CommandContext } from "../commands/types.js";

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "ft-tree-content-classes-"));
  tempDirs.push(dir);
  return dir;
}

function write(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

function node(title: string, body = "", extra = ""): string {
  return `---\ntitle: ${title}\nowners: [alice]\n${extra}---\n# ${title}\n${body}\n`;
}

function memberNode(overrides = ""): string {
  return `---\ntitle: Alice\nowners: [alice]\ntype: human\nrole: Engineer\ndomains: [system]\n${overrides}---\n# Alice\n`;
}

function makeValidTree(): string {
  const root = makeTempDir();
  write(join(root, "NODE.md"), node("Root"));
  write(join(root, "members", "NODE.md"), node("Members"));
  write(join(root, "members", "alice", "NODE.md"), memberNode());
  return root;
}

afterEach(() => {
  vi.restoreAllMocks();
  process.exitCode = undefined;
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

describe("tree verify strict content policy", () => {
  it("accepts structured block-array owners for the root and normal leaves", () => {
    const root = makeValidTree();
    write(join(root, "NODE.md"), "---\ntitle: Root\nowners:\n  - alice\n  - bob\n---\n# Root\n");
    write(join(root, "system", "NODE.md"), node("System"));
    write(join(root, "system", "leaf.md"), "---\ntitle: Leaf\nowners:\n  - alice\n---\n# Leaf\n");

    const summary = verifyTreeRoot(root);

    expect(summary).toMatchObject({ findings: [], ok: true });
    expect(renderContextTree(root)).toContain("system/leaf.md [Leaf]");
  });

  it("validates in-tree root and leaf Markdown symlinks", (ctx) => {
    const root = makeValidTree();
    rmSync(join(root, "NODE.md"));
    write(join(root, "root-source.md"), node("Root"));
    write(join(root, "system", "leaf-source.md"), node("Leaf"));
    try {
      symlinkSync("root-source.md", join(root, "NODE.md"));
      symlinkSync("leaf-source.md", join(root, "system", "leaf.md"));
    } catch {
      ctx.skip("Symlink creation is not supported in this environment.");
    }

    expect(verifyTreeRoot(root)).toMatchObject({ findings: [], ok: true });
  });

  it("rejects normal Markdown symlinks that escape the tree root", (ctx) => {
    const root = makeValidTree();
    const outside = makeTempDir();
    write(join(outside, "outside.md"), node("Outside"));
    try {
      symlinkSync(join(outside, "outside.md"), join(root, "escaped.md"));
    } catch {
      ctx.skip("Symlink creation is not supported in this environment.");
    }

    expect(verifyTreeRoot(root).findings).toContainEqual(
      expect.objectContaining({ code: "TREE_MARKDOWN_FILE_PATH_ESCAPE", path: "escaped.md" }),
    );
  });

  it("rejects dangling Markdown symlinks before content-class skips", (ctx) => {
    const root = makeValidTree();
    write(join(root, "raw-context", "placeholder.md"), "archive\n");
    try {
      symlinkSync("missing.md", join(root, "dangling.md"));
      symlinkSync("missing.md", join(root, "raw-context", "dangling.md"));
      symlinkSync("missing.md", join(root, "AGENTS.md"));
      symlinkSync("missing.md", join(root, "WHITEPAPER.md"));
    } catch {
      ctx.skip("Symlink creation is not supported in this environment.");
    }

    const findings = verifyTreeRoot(root).findings;

    expect(findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "TREE_MARKDOWN_FILE_SYMLINK_BROKEN", path: "dangling.md" }),
        expect.objectContaining({
          code: "TREE_MARKDOWN_FILE_SYMLINK_BROKEN",
          path: "raw-context/dangling.md",
        }),
        expect.objectContaining({ code: "TREE_MARKDOWN_FILE_SYMLINK_BROKEN", path: "AGENTS.md" }),
      ]),
    );
    expect(findings.some((finding) => finding.path === "WHITEPAPER.md")).toBe(false);
  });

  it("reports a dangling root NODE.md symlink precisely", (ctx) => {
    const root = makeValidTree();
    rmSync(join(root, "NODE.md"));
    try {
      symlinkSync("missing.md", join(root, "NODE.md"));
    } catch {
      ctx.skip("Symlink creation is not supported in this environment.");
    }

    const summary = verifyTreeRoot(root);

    expect(summary.findings).toContainEqual(
      expect.objectContaining({ code: "TREE_MARKDOWN_FILE_SYMLINK_BROKEN", path: "NODE.md" }),
    );
    expect(summary.checks.rootNodeFrontmatter.errors).toEqual(["Root NODE.md symlink target cannot be resolved."]);
  });

  it("rejects Markdown symlinks to non-regular targets", (ctx) => {
    if (process.platform === "win32") {
      ctx.skip("FIFO fixtures are not portable to Windows.");
    }

    const root = makeValidTree();
    const fifoPath = join(root, "special-target");
    try {
      execFileSync("mkfifo", [fifoPath]);
      symlinkSync("special-target", join(root, "special.md"));
    } catch {
      ctx.skip("FIFO or symlink creation is not supported in this environment.");
    }

    expect(verifyTreeRoot(root).findings).toContainEqual(
      expect.objectContaining({ code: "TREE_MARKDOWN_FILE_SYMLINK_UNSUPPORTED", path: "special.md" }),
    );
  });

  it("keeps the legacy root check failed when NODE.md targets a directory", (ctx) => {
    const root = makeValidTree();
    rmSync(join(root, "NODE.md"));
    write(join(root, "system", "NODE.md"), node("System"));
    try {
      symlinkSync("system", join(root, "NODE.md"), "dir");
    } catch {
      ctx.skip("Directory symlink creation is not supported in this environment.");
    }

    const summary = verifyTreeRoot(root);

    expect(summary.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "TREE_DIRECTORY_SYMLINK_UNSUPPORTED", path: "NODE.md" }),
        expect.objectContaining({ code: "TREE_FRONTMATTER_MISSING", path: "NODE.md" }),
      ]),
    );
    expect(summary.checks.rootNodeFrontmatter).toEqual({
      errors: ["Root NODE.md is missing frontmatter."],
      ok: false,
    });
  });

  it("rejects escaping archive and repo-infra Markdown symlinks before class skips", (ctx) => {
    const root = makeValidTree();
    const outside = makeTempDir();
    write(join(outside, "outside.md"), node("Outside"));
    write(join(root, "raw-context", "placeholder.md"), "archive\n");
    write(join(root, "system", "NODE.md"), node("System"));
    try {
      symlinkSync(join(outside, "outside.md"), join(root, "raw-context", "escaped.md"));
      symlinkSync(join(outside, "outside.md"), join(root, "AGENTS.md"));
      symlinkSync(join(outside, "outside.md"), join(root, "system", "WHITEPAPER.md"));
      symlinkSync(join(outside, "outside.md"), join(root, "WHITEPAPER.md"));
    } catch {
      ctx.skip("Symlink creation is not supported in this environment.");
    }

    const findings = verifyTreeRoot(root).findings;

    expect(findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "TREE_MARKDOWN_FILE_PATH_ESCAPE", path: "raw-context/escaped.md" }),
        expect.objectContaining({ code: "TREE_MARKDOWN_FILE_PATH_ESCAPE", path: "AGENTS.md" }),
        expect.objectContaining({ code: "TREE_MARKDOWN_FILE_PATH_ESCAPE", path: "system/WHITEPAPER.md" }),
      ]),
    );
    expect(findings.some((finding) => finding.path === "WHITEPAPER.md")).toBe(false);
  });

  it("rejects Markdown symlink aliases across content-class boundaries", (ctx) => {
    const root = makeValidTree();
    write(join(root, "raw-context", "proposal.md"), "archive\n");
    write(join(root, "system", "links.md"), node("Links", "[archive](../alias.md)\n", "soft_links: [/alias.md]\n"));
    try {
      symlinkSync("raw-context/proposal.md", join(root, "alias.md"));
    } catch {
      ctx.skip("Symlink creation is not supported in this environment.");
    }

    expect(verifyTreeRoot(root).findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "TREE_MARKDOWN_FILE_CONTENT_CLASS_MISMATCH",
          path: "alias.md",
          target: "raw-context/proposal.md",
        }),
        expect.objectContaining({ code: "TREE_SOFT_LINK_ARCHIVE_DEPENDENCY", target: "/alias.md" }),
        expect.objectContaining({ code: "TREE_MARKDOWN_LINK_ARCHIVE_DEPENDENCY", target: "../alias.md" }),
      ]),
    );
  });

  it("rejects in-tree and escaping directory symlinks explicitly", (ctx) => {
    const root = makeValidTree();
    const outside = makeTempDir();
    write(join(root, "system", "NODE.md"), node("System"));
    write(join(outside, "NODE.md"), node("Outside"));
    try {
      symlinkSync("system", join(root, "system-alias"), "dir");
      symlinkSync("system", join(root, "WHITEPAPER.md"), "dir");
      symlinkSync(outside, join(root, "outside-alias"), "dir");
    } catch {
      ctx.skip("Symlink creation is not supported in this environment.");
    }

    expect(verifyTreeRoot(root).findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "TREE_DIRECTORY_SYMLINK_UNSUPPORTED",
          path: "system-alias",
        }),
        expect.objectContaining({
          code: "TREE_DIRECTORY_SYMLINK_PATH_ESCAPE",
          path: "outside-alias",
        }),
        expect.objectContaining({
          code: "TREE_DIRECTORY_SYMLINK_UNSUPPORTED",
          path: "WHITEPAPER.md",
        }),
      ]),
    );
  });

  it("rejects repo-infra Markdown symlinks to directories before class skips", (ctx) => {
    const root = makeValidTree();
    const outside = makeTempDir();
    write(join(root, "system", "NODE.md"), node("System"));
    write(join(outside, "NODE.md"), node("Outside"));
    try {
      symlinkSync("system", join(root, "AGENTS.md"), "dir");
      symlinkSync(outside, join(root, "CLAUDE.md"), "dir");
    } catch {
      ctx.skip("Directory symlink creation is not supported in this environment.");
    }

    expect(verifyTreeRoot(root).findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "TREE_DIRECTORY_SYMLINK_UNSUPPORTED",
          path: "AGENTS.md",
        }),
        expect.objectContaining({
          code: "TREE_DIRECTORY_SYMLINK_PATH_ESCAPE",
          path: "CLAUDE.md",
        }),
      ]),
    );
  });

  it("reports invalid managed paths before source and tree identity preflight", (ctx) => {
    const outside = makeTempDir();
    write(
      join(outside, "source.md"),
      "<!-- BEGIN FIRST-TREE-SOURCE-INTEGRATION -->\nFIRST-TREE-BINDING-MODE: standalone-source\nFIRST-TREE-TREE-REPO-SLUG: acme/context\n<!-- END FIRST-TREE-SOURCE-INTEGRATION -->\n",
    );

    const escapingRoot = makeValidTree();
    try {
      symlinkSync(join(outside, "source.md"), join(escapingRoot, "AGENTS.md"));
    } catch {
      ctx.skip("Symlink creation is not supported in this environment.");
    }
    expect(verifyTreeRoot(escapingRoot).findings).toContainEqual(
      expect.objectContaining({ code: "TREE_MARKDOWN_FILE_PATH_ESCAPE", path: "AGENTS.md" }),
    );

    const mixedRoot = makeValidTree();
    write(join(mixedRoot, "system", "NODE.md"), node("System"));
    write(
      join(mixedRoot, "CLAUDE.md"),
      "<!-- BEGIN FIRST-TREE-SOURCE-INTEGRATION -->\nFIRST-TREE-BINDING-MODE: standalone-source\nFIRST-TREE-TREE-REPO-SLUG: acme/context\n<!-- END FIRST-TREE-SOURCE-INTEGRATION -->\n",
    );
    try {
      symlinkSync("system", join(mixedRoot, "AGENTS.md"), "dir");
    } catch {
      ctx.skip("Directory symlink creation is not supported in this environment.");
    }
    expect(verifyTreeRoot(mixedRoot).findings).toContainEqual(
      expect.objectContaining({ code: "TREE_DIRECTORY_SYMLINK_UNSUPPORTED", path: "AGENTS.md" }),
    );
  });

  it("reports member directory symlinks once without following them", (ctx) => {
    const root = makeValidTree();
    const outside = makeTempDir();
    write(join(outside, "NODE.md"), "# invalid external member\n");
    try {
      symlinkSync("..", join(root, "members", "alice", "loop"), "dir");
      symlinkSync(outside, join(root, "members", "alice", "outside"), "dir");
    } catch {
      ctx.skip("Symlink creation is not supported in this environment.");
    }

    const findings = verifyTreeRoot(root).findings;

    expect(findings.filter((finding) => finding.path === "members/alice/loop")).toEqual([
      expect.objectContaining({ code: "TREE_DIRECTORY_SYMLINK_UNSUPPORTED" }),
    ]);
    expect(findings.filter((finding) => finding.path === "members/alice/outside")).toEqual([
      expect.objectContaining({ code: "TREE_DIRECTORY_SYMLINK_PATH_ESCAPE" }),
    ]);
    expect(findings.some((finding) => finding.path.includes("loop/loop"))).toBe(false);
    expect(findings.some((finding) => finding.path.includes("outside/NODE.md"))).toBe(false);
  });

  it.each([
    ["---\nowners: [alice]\n---\n# Missing\n", "TREE_TITLE_MISSING"],
    ["---\ntitle: []\nowners: [alice]\n---\n# Invalid\n", "TREE_TITLE_INVALID"],
    ["---\ntitle: Missing owners\n---\n# Missing\n", "TREE_OWNERS_MISSING"],
    ["---\ntitle: Empty owners\nowners: []\n---\n# Empty\n", "TREE_OWNERS_INVALID"],
    ["---\ntitle: Bad description\nowners: [alice]\ndescription: []\n---\n# Bad\n", "TREE_DESCRIPTION_INVALID"],
    ["---\ntitle: Bad links\nowners: [alice]\nsoft_links: []\n---\n# Bad\n", "TREE_SOFT_LINKS_INVALID"],
  ])("rejects invalid structured normal metadata", (content, code) => {
    const root = makeValidTree();
    write(join(root, "invalid.md"), content);

    expect(verifyTreeRoot(root)).toMatchObject({ ok: false });
    expect(verifyTreeRoot(root).findings).toContainEqual(expect.objectContaining({ code, path: "invalid.md" }));
  });

  it("allows an omitted description but rejects malformed normal YAML", () => {
    const root = makeValidTree();
    write(join(root, "valid.md"), node("No description"));
    write(join(root, "invalid.md"), "---\ntitle: Invalid\nowners: [*]\n---\n# Invalid\n");

    const summary = verifyTreeRoot(root);

    expect(summary.findings).toContainEqual(
      expect.objectContaining({ code: "TREE_FRONTMATTER_PARSE", path: "invalid.md" }),
    );
    expect(summary.findings.some((finding) => finding.path === "valid.md")).toBe(false);
  });

  it("skips archive/supporting and repo-infra Markdown", () => {
    const root = makeValidTree();
    write(join(root, "raw-context", "proposal.md"), "no frontmatter\n[broken](missing.md)\n");
    write(join(root, ".github", "notes.md"), "not frontmatter\n");
    write(join(root, "AGENTS.md"), "runtime guidance\n");

    const summary = verifyTreeRoot(root);

    expect(summary.ok).toBe(true);
    expect(summary.scannedByContentClass).toMatchObject({
      normal: 1,
      "archive-supporting": 1,
      member: 2,
      "repo-infra": 1,
    });
  });

  it("rejects broken, escaping, and archive-dependent soft_links", () => {
    const root = makeValidTree();
    write(join(root, "raw-context", "proposal.md"), "archive\n");
    write(
      join(root, "system", "links.md"),
      node("Links", "", "soft_links:\n  - /missing.md\n  - ../../outside.md\n  - /raw-context/proposal.md\n"),
    );

    expect(verifyTreeRoot(root).findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "TREE_SOFT_LINK_BROKEN", target: "/missing.md" }),
        expect.objectContaining({ code: "TREE_SOFT_LINK_PATH_ESCAPE", target: "../../outside.md" }),
        expect.objectContaining({
          code: "TREE_SOFT_LINK_ARCHIVE_DEPENDENCY",
          target: "/raw-context/proposal.md",
        }),
      ]),
    );
  });

  it("checks tree-local Markdown authority but ignores ordinary missing targets", () => {
    const root = makeValidTree();
    write(join(root, "raw-context", "proposal.md"), "archive\n");
    write(join(root, "raw-context", "reference.md"), "archive\n");
    write(
      join(root, "system", "links.md"),
      node(
        "Links",
        "[archive](../raw-context/proposal.md)\n[archive-ref][proposal]\n\n[proposal]: ../raw-context/reference.md\n\n[escape](../../outside.md)\n[missing](missing.md)\n",
      ),
    );

    const findings = verifyTreeRoot(root).findings;

    expect(findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "TREE_MARKDOWN_LINK_ARCHIVE_DEPENDENCY" }),
        expect.objectContaining({
          code: "TREE_MARKDOWN_LINK_ARCHIVE_DEPENDENCY",
          target: "../raw-context/reference.md",
        }),
        expect.objectContaining({ code: "TREE_MARKDOWN_LINK_PATH_ESCAPE" }),
      ]),
    );
    expect(findings.some((finding) => finding.target === "missing.md")).toBe(false);
  });

  it("treats Windows drive and UNC absolute paths as escaping tree-local targets", () => {
    const root = makeValidTree();
    write(join(root, "system", "links.md"), node("Links", "[drive](C:/outside.md)\n[root-relative](\\outside.md)\n"));

    expect(verifyTreeRoot(root).findings).toEqual(
      expect.arrayContaining(
        ["C:/outside.md", "\\outside.md"].map((target) =>
          expect.objectContaining({ code: "TREE_MARKDOWN_LINK_PATH_ESCAPE", target }),
        ),
      ),
    );
    for (const target of ["C:/outside.md", "C:\\outside.md", "\\outside.md", "\\\\server\\share\\outside.md"]) {
      expect(
        resolveLocalTreeTarget({ sourcePath: "system/links.md", target, treeRoot: root, softLink: false }),
      ).toMatchObject({ escaped: true, exists: false });
    }
    expect(
      resolveLocalTreeTarget({
        sourcePath: "system/links.md",
        target: "https://example.com",
        treeRoot: root,
        softLink: false,
      }),
    ).toBeNull();
  });

  it("allows prose, external links, anchors, and member-to-archive links", () => {
    const root = makeValidTree();
    write(join(root, "raw-context", "proposal.md"), "archive\n");
    write(
      join(root, "system", "policy.md"),
      node(
        "Policy",
        "raw-context/ is supporting material; use `raw-context/` only when needed. [site](https://example.com) [mail](mailto:a@example.com) [here](#policy) [future](missing.md)",
      ),
    );
    write(join(root, "members", "alice", "notes.md"), node("Notes", "", "soft_links: [/raw-context/proposal.md]\n"));

    expect(verifyTreeRoot(root)).toMatchObject({ findings: [], ok: true });
  });

  it("keeps malformed optional frontmatter in personal member Markdown relaxed", () => {
    const root = makeValidTree();
    write(join(root, "members", "alice", "notes.md"), "---\nowners: [*]\n---\n# Personal notes\n");

    expect(verifyTreeRoot(root)).toMatchObject({ findings: [], ok: true });
  });

  it("preserves the member identity contract", () => {
    const root = makeValidTree();
    write(join(root, "members", "NODE.md"), "---\ntitle: Members\nowners: []\n---\n# Members\n");
    write(
      join(root, "members", "alice", "NODE.md"),
      "---\ntitle: Alice\nowners: [alice]\ntype: human\ndomains: [system]\n---\n# Alice\n",
    );

    const summary = verifyTreeRoot(root);

    expect(summary.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "TREE_OWNERS_INVALID", path: "members/NODE.md" }),
        expect.objectContaining({ code: "TREE_MEMBER_ROLE_INVALID", path: "members/alice/NODE.md" }),
      ]),
    );
  });

  it("keeps JSON fields additive with stable findings", () => {
    const root = makeValidTree();
    write(join(root, "invalid.md"), "---\ntitle: Invalid\nowners: []\n---\n# Invalid\n");
    const command = new Command("verify");
    command.setOptionValue("treePath", root);
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

    verifyCommand.action({
      command,
      options: { debug: false, json: true, quiet: false },
    } satisfies CommandContext);

    const payload = JSON.parse(String(log.mock.calls[0]?.[0])) as Record<string, unknown>;
    expect(payload).toHaveProperty("checks.nodes.ok", false);
    expect(payload).toHaveProperty("checks.nodes.errors.0");
    expect(payload).toHaveProperty("checks.progress.uncheckedItems");
    expect(payload).toHaveProperty("findings.0.code", "TREE_OWNERS_INVALID");
    expect(payload).not.toHaveProperty("findings.0.severity");
    expect(payload).toHaveProperty("scannedByContentClass.normal");
    expect(process.exitCode).toBe(1);
  });

  it("preserves legacy check error strings while adding structured findings", () => {
    const root = makeValidTree();
    write(join(root, "invalid.md"), "---\nfoo: bar\n---\n# Invalid\n");
    write(
      join(root, "members", "alice", "NODE.md"),
      "---\ntitle: Alice\nowners: [alice]\ntype: human\ndomains: [system]\n---\n# Alice\n",
    );

    const summary = verifyTreeRoot(root);

    expect(summary.checks.nodes.errors).toEqual(
      expect.arrayContaining([
        "invalid.md: missing 'title' field in frontmatter",
        "invalid.md: missing 'owners' field in frontmatter",
      ]),
    );
    expect(summary.checks.members.errors).toContain("members/alice/NODE.md: missing or empty 'role' field");
    expect(summary.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "TREE_TITLE_MISSING", path: "invalid.md" }),
        expect.objectContaining({ code: "TREE_MEMBER_ROLE_INVALID", path: "members/alice/NODE.md" }),
      ]),
    );
  });

  it("prints stable finding codes in the human failure output", () => {
    const root = makeValidTree();
    write(join(root, "invalid.md"), "---\ntitle: Invalid\nowners: []\n---\n# Invalid\n");
    const command = new Command("verify");
    command.setOptionValue("treePath", root);
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

    verifyCommand.action({
      command,
      options: { debug: false, json: false, quiet: false },
    } satisfies CommandContext);

    const output = log.mock.calls.map((call) => String(call[0] ?? "")).join("\n");
    expect(output).toContain("[TREE_OWNERS_INVALID]");
    expect(output).toContain("Some checks failed.");
  });

  it("keeps verify as the only validation command and exposes no strict mode", () => {
    const program = new Command();
    registerTreeCommands(program);
    const tree = program.commands.find((command) => command.name() === "tree");
    const verify = tree?.commands.find((command) => command.name() === "verify");

    expect(tree?.commands.map((command) => command.name())).toEqual([
      "verify",
      "tree",
      "local",
      "read",
      "source-link",
      "io",
      "write",
      "review",
      "seed",
      "init",
    ]);
    expect(tree?.commands.some((command) => command.name() === "validate")).toBe(false);
    expect(verify?.options.some((option) => option.long === "--strict")).toBe(false);
    expect(VERIFY_USAGE).not.toContain("strict");
    expect(VERIFY_USAGE).not.toContain("validationPolicyVersion");
  });
});
