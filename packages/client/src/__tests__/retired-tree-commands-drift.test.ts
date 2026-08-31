// Drift guard for the `first-tree tree` namespace deletion (2026-06).
//
// PR #848 retired everything under `first-tree tree` except `verify`; the
// narrow hierarchy browser later returned as `tree tree`, followed by the
// explicit-Team BYO task snapshot activator as `tree read`, then the clean
// source-backed authoring preflight as `tree write`, and the trusted App
// outcome publisher as `tree review`.
// Agents pick up CLI instructions from two places at session start:
//
//   1. The runtime briefing emitted by `buildAgentBriefing()` —
//      materialised at `<workspace>/AGENTS.md` (and `<workspace>/CLAUDE.md`
//      as a symlink to it). The `## CLI Overview` section here tells the
//      agent which subcommands exist; advertising a retired command
//      causes the agent to burn a turn on `unknown command`.
//
//   2. The shipped First Tree skill payloads under `skills/<name>/` —
//      copied into `<workspace>/.agents/skills/` by the inline installer
//      on every session start. Bash code blocks and inline backticks in
//      these markdown files are commands the agent is told to run.
//
// This test fails fast on either path if anyone adds a `first-tree tree
// <retired>` reference back. Documentation prose that describes the
// deletion (e.g. "the tree status CLI was retired in
// 2026-06") is allowed; only ACTIVE instructions to run the command
// are caught. The discrimination is structural: we only flag matches
// inside fenced ```bash code blocks (where they would be copy-pasted
// or executed) and not in surrounding prose.
//
// To extend: add to `RETIRED_TREE_SUBCOMMANDS` below. To allow a NEW
// `tree` subcommand that someday returns, remove it from the list AND
// register the subcommand in `apps/cli/src/commands/tree/index.ts`.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { buildAgentBriefing } from "../runtime/agent-briefing.js";

const repoRoot = (() => {
  // packages/client/src/__tests__/<this file>  →  walk up to repo root.
  let dir = dirname(fileURLToPath(import.meta.url));
  while (dir !== "/") {
    if (
      readdirSync(dir, { withFileTypes: true }).some((entry) => entry.isFile() && entry.name === "pnpm-workspace.yaml")
    ) {
      return dir;
    }
    dir = dirname(dir);
  }
  throw new Error("Could not locate repo root from drift-guard test");
})();

const SHIPPED_SKILLS = [
  "first-tree-welcome",
  "first-tree-write",
  "first-tree-read",
  "first-tree-seed",
  "first-tree-file-bug",
  "context-tree-review",
  "context-tree-audit",
  "first-tree-qa",
];

const RETIRED_TREE_SUBCOMMANDS = [
  "status",
  // `init` is intentionally NOT retired: PR #848 deleted the original, but it
  // was reintroduced in 2026-07 (#1379) in a different shape as the agent-gh
  // Context Tree creation command and is registered in
  // `apps/cli/src/commands/tree/index.ts`. Shipped skills (first-tree-seed
  // Step 0) legitimately instruct `first-tree tree init`, so per the
  // un-retirement procedure documented above it must stay OFF this list.
  "migrate",
  "migrate-to-w1",
  "upgrade",
  "codeowners",
  "claude-hook",
  "inject",
  "automation",
  "skill",
  // Pre-W1 / pre-PR-844 names that should also stay gone.
  "integrate",
  "bind",
  "bootstrap",
  "publish",
  "inspect",
] as const;

function listMarkdownFiles(root: string): string[] {
  const out: string[] = [];
  function walk(dir: string): void {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.isFile() && (entry.name.endsWith(".md") || entry.name.endsWith(".txt"))) {
        out.push(full);
      }
    }
  }
  walk(root);
  return out;
}

type BashCodeBlock = {
  file: string;
  line: number;
  content: string;
};

function extractBashBlocks(file: string): BashCodeBlock[] {
  const text = readFileSync(file, "utf-8");
  const lines = text.split("\n");
  const blocks: BashCodeBlock[] = [];
  let inside = false;
  let startLine = 0;
  let buffer: string[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? "";
    if (!inside) {
      // Match ```bash / ```sh / ```shell, optionally with extra info string.
      if (/^\s*```(?:bash|sh|shell)\b/u.test(line)) {
        inside = true;
        startLine = i + 1;
        buffer = [];
      }
    } else {
      if (/^\s*```\s*$/u.test(line)) {
        blocks.push({ file, line: startLine + 1, content: buffer.join("\n") });
        inside = false;
        buffer = [];
      } else {
        buffer.push(line);
      }
    }
  }
  return blocks;
}

function findRetiredHitsInBash(file: string): Array<{ subcommand: string; line: number; snippet: string }> {
  const hits: Array<{ subcommand: string; line: number; snippet: string }> = [];
  for (const block of extractBashBlocks(file)) {
    const blockLines = block.content.split("\n");
    for (let i = 0; i < blockLines.length; i += 1) {
      const ln = blockLines[i] ?? "";
      // Strip leading shell prompt + indentation.
      const stripped = ln.replace(/^\s*\$?\s*/u, "");
      for (const sub of RETIRED_TREE_SUBCOMMANDS) {
        // Match `first-tree tree <sub>` or `ft tree <sub>` at a word boundary,
        // followed by whitespace / end-of-line / common flag chars.
        const re = new RegExp(`\\b(?:first-tree|ft)\\s+tree\\s+${sub}(?:\\b|[\\s$])`, "u");
        if (re.test(stripped)) {
          hits.push({ subcommand: sub, line: block.line + i, snippet: stripped });
        }
      }
    }
  }
  return hits;
}

/**
 * Skill metadata files (composer UI prompts, agent default prompts) live
 * under `skills/<name>/agents/*.yaml` and `skills/<name>/agents/*.yml`.
 * They are NOT bash blocks but they tell composer / runtime what to
 * route an agent at. PR #848 review (baixiaohang R2) caught a stale
 * routing line in a retired skill's `agents/openai.yaml` that
 * the markdown-only scan missed — this list of retired skill names is
 * the drift-guard contract for those files.
 */
const RETIRED_SKILL_NAMES = [
  "first-tree",
  "first-tree-context",
  "first-tree-sync",
  "first-tree-github",
  "first-tree-gitlab",
  "first-tree-guide",
  "first-tree-onboarding",
  "first-tree-kickoff",
  "first-tree-github-scan",
  "first-tree-cloud",
] as const;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function listAgentMetadataFiles(skillsRoot: string): string[] {
  const out: string[] = [];
  function walk(dir: string): void {
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of names) {
      const full = join(dir, name);
      let stat: ReturnType<typeof statSync>;
      try {
        stat = statSync(full);
      } catch {
        continue;
      }
      if (stat.isDirectory()) {
        walk(full);
      } else if (stat.isFile() && (name.endsWith(".yaml") || name.endsWith(".yml"))) {
        out.push(full);
      }
    }
  }
  // Only scan `agents/` subtrees — that's the composer-facing metadata
  // surface. Other YAML in the repo (CI workflows, vitest configs) isn't
  // about skill routing.
  for (const name of SHIPPED_SKILLS) {
    walk(join(skillsRoot, name, "agents"));
  }
  return out;
}

describe("retired tree subcommand drift guard", () => {
  it("no shipped skill bash block tells an agent to run a retired `tree` subcommand", () => {
    const skillsRoot = join(repoRoot, "skills");
    const failures: Array<{ file: string; subcommand: string; line: number; snippet: string }> = [];
    for (const name of SHIPPED_SKILLS) {
      const skillDir = join(skillsRoot, name);
      try {
        if (!statSync(skillDir).isDirectory()) continue;
      } catch {
        continue;
      }
      for (const md of listMarkdownFiles(skillDir)) {
        for (const hit of findRetiredHitsInBash(md)) {
          failures.push({ file: relative(repoRoot, md), ...hit });
        }
      }
    }
    if (failures.length > 0) {
      const detail = failures
        .map((f) => `  ${f.file}:${f.line}: \`first-tree tree ${f.subcommand}\` — ${f.snippet}`)
        .join("\n");
      throw new Error(
        `Retired tree subcommand resurfaced in shipped skill bash blocks (will 404 with "unknown command"):\n${detail}\n\nReplace with the supported alternative (workspace.json read / human handoff / tree verify / tree tree) or update the test if a subcommand is intentionally being un-retired.`,
      );
    }
  });

  it("buildAgentBriefing command surface lists only registered tree subcommands — no retired commands", () => {
    // Reuse a tiny stub of `BuildAgentBriefingOptions`. The command surface
    // section doesn't depend on identity / payload / sourceRepos / tree
    // path, so a minimal stub renders the same output.
    const briefing = buildAgentBriefing({
      identity: {
        agentId: "drift-guard",
        inboxId: "drift-guard-inbox",
        displayName: "Drift Guard",
        type: "agent",
        visibility: "organization",
        delegateMention: null,
        metadata: {},
      },
      payload: null,
      workspacePath: "/tmp/drift-guard",
      sourceRepos: [],
      contextTreePath: null,
    });

    const overviewStart = briefing.indexOf("## CLI Overview");
    expect(overviewStart, "CLI Overview section must be present").toBeGreaterThanOrEqual(0);
    // CLI Overview ends at the next section heading; scope the check to
    // just that section so unrelated documentation prose in later
    // sections doesn't false-positive. Renaming that next heading widens the
    // slice to the rest of the briefing rather than narrowing it — noisy, not
    // silent, so the drift guard still fails closed.
    const overviewEnd = briefing.indexOf("\n## Agent Identity & Config", overviewStart);
    const overview = briefing.slice(overviewStart, overviewEnd === -1 ? undefined : overviewEnd);

    expect(overview).toContain("tree verify");
    expect(overview).toContain("tree tree");
    expect(overview).toContain("tree read");
    expect(overview).toContain("tree write");
    expect(overview).toContain("tree review");
    for (const sub of RETIRED_TREE_SUBCOMMANDS) {
      // Word-boundary regex (not `.toContain`) so prose like
      // "workspace ↔ tree binding" doesn't false-positive on `tree bind`.
      const re = new RegExp(`\\b(?:first-tree|ft)\\s+tree\\s+${sub}\\b`, "u");
      expect(overview, `CLI Overview must not advertise retired \`tree ${sub}\``).not.toMatch(re);
    }
  });

  it("no shipped skill agent metadata YAML routes to a retired skill", () => {
    // Composer reads `skills/<name>/agents/*.yaml` to render the
    // composer UI's "Resources" pickers and to seed the default agent
    // prompt. Any reference to a retired skill name (e.g. the previous
    // `first-tree-onboarding` payload) routes users at something that
    // is no longer on disk; PR #848 review (baixiaohang R2) flagged
    // exactly this class of drift in retired skill metadata. The
    // repo-root markdown / bash drift guard above missed it because the
    // file is YAML, not markdown.
    const skillsRoot = join(repoRoot, "skills");
    const failures: Array<{ file: string; skill: string; line: number; snippet: string }> = [];
    for (const yamlPath of listAgentMetadataFiles(skillsRoot)) {
      const lines = readFileSync(yamlPath, "utf-8").split("\n");
      for (let i = 0; i < lines.length; i += 1) {
        const line = lines[i] ?? "";
        for (const skill of RETIRED_SKILL_NAMES) {
          // Treat hyphen as part of the token boundary so retired
          // `first-tree` does not false-positive on current
          // `first-tree-write`.
          const re = new RegExp(`(^|[^A-Za-z0-9-])${escapeRegExp(skill)}($|[^A-Za-z0-9-])`, "u");
          if (re.test(line)) {
            failures.push({ file: relative(repoRoot, yamlPath), skill, line: i + 1, snippet: line.trim() });
          }
        }
      }
    }
    if (failures.length > 0) {
      const detail = failures.map((f) => `  ${f.file}:${f.line}: \`${f.skill}\` — ${f.snippet}`).join("\n");
      throw new Error(
        `Retired skill name resurfaced in shipped agent-metadata YAML (composer will route at a skill that is not on disk):\n${detail}\n\nRewrite to use a surviving skill (\`first-tree-write\`, \`first-tree-read\`, \`first-tree-seed\`) or to the operator-handoff phrasing, or extend RETIRED_SKILL_NAMES if a skill is intentionally being un-retired.`,
      );
    }
  });
});
