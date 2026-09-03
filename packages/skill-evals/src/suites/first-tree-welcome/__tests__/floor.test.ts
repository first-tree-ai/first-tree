import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { SkillEvalCase } from "../../../core/case-schema.js";
import { FIRST_TREE_WELCOME_SUITE } from "../cases.js";

// These tests run in `pnpm test` / CI (unlike the model-gated eval:* commands),
// so they are where the welcome matrix's structural invariants are actually
// locked: no orphan implemented action, exactly one catch-all, and unambiguous
// first-match-wins (unique state tuples). They guard against the drift class
// that produced #1341 → #1344.

const validateFloor = FIRST_TREE_WELCOME_SUITE.validateFloor;
if (!validateFloor) {
  throw new Error("first-tree-welcome suite must define validateFloor");
}
const cases = FIRST_TREE_WELCOME_SUITE.cases;
const skillMarkdown = readFileSync(join(process.cwd(), "../../skills/first-tree-welcome/SKILL.md"), "utf8");

function hasTag(evalCase: SkillEvalCase, tag: string): boolean {
  const tags = (evalCase as { tags?: readonly string[] }).tags;
  return Array.isArray(tags) && tags.includes(tag);
}

describe("first-tree-welcome floor invariants", () => {
  it("accepts the shipped matrix with no errors", () => {
    expect(validateFloor(cases)).toEqual([]);
  });

  it("implements periodic coverage for every concrete non-catch-all matrix row", () => {
    const periodicCases = cases.filter((evalCase) => evalCase.tier === "periodic");

    expect(periodicCases).toHaveLength(14);
    expect(periodicCases.every((evalCase) => evalCase.status === "implemented")).toBe(true);
    expect(periodicCases.some((evalCase) => hasTag(evalCase, "catch-all"))).toBe(false);
  });

  it("flags an implemented row whose action has no casePassed branch (orphan)", () => {
    // Deliberately break one implemented row's action; `expected` is the schema's
    // generic `unknown`, so a plain override is type-safe here.
    const broken = cases.map(
      (evalCase): SkillEvalCase =>
        evalCase.tier === "gate" && evalCase.status === "implemented"
          ? { ...evalCase, expected: { ...(evalCase.expected as Record<string, unknown>), action: "made_up_action" } }
          : evalCase,
    );
    expect(validateFloor(broken).some((error) => error.includes("orphan"))).toBe(true);
  });

  it("flags an implemented periodic row whose action has no casePassed branch (orphan)", () => {
    const broken = cases.map(
      (evalCase): SkillEvalCase =>
        evalCase.tier === "periodic" && evalCase.status === "implemented"
          ? { ...evalCase, expected: { ...(evalCase.expected as Record<string, unknown>), action: "made_up_action" } }
          : evalCase,
    );
    expect(validateFloor(broken).some((error) => error.includes("orphan"))).toBe(true);
  });

  it("flags an implemented row whose forbidden action has no detector branch (orphan)", () => {
    const broken = cases.map(
      (evalCase): SkillEvalCase =>
        evalCase.tier === "periodic" && evalCase.status === "implemented"
          ? {
              ...evalCase,
              forbidden: { ...(evalCase.forbidden as Record<string, unknown>), actions: ["made-up-risk"] },
            }
          : evalCase,
    );
    expect(validateFloor(broken).some((error) => error.includes("forbidden action"))).toBe(true);
  });

  it("flags two non-catch-all rows that claim the same state tuple", () => {
    const sample = cases.find((evalCase) => evalCase.tier === "gate" && !hasTag(evalCase, "catch-all"));
    if (!sample) throw new Error("expected at least one non-catch-all gate row");
    // A second row with the same fixture tuple makes first-match-wins ambiguous.
    const duplicate: SkillEvalCase = { ...sample, id: `${sample.id}-dup` };
    expect(validateFloor([...cases, duplicate]).some((error) => error.includes("overlapping state tuple"))).toBe(true);
  });

  it("requires exactly one explicit catch-all row", () => {
    const withoutCatchAll = cases.filter((evalCase) => !hasTag(evalCase, "catch-all"));
    expect(validateFloor(withoutCatchAll).some((error) => error.includes("catch-all"))).toBe(true);
  });

  it("requires the catch-all row to be the last gate row", () => {
    const sample = cases.find((evalCase) => evalCase.tier === "gate" && !hasTag(evalCase, "catch-all"));
    if (!sample) throw new Error("expected at least one non-catch-all gate row");
    // A specific (non-catch-all) row placed AFTER the catch-all would be
    // unreachable under first-match-wins. Give it a unique tuple so only the
    // "must be last" invariant fires, not the uniqueness one.
    const trailing: SkillEvalCase = {
      ...sample,
      id: `${sample.id}-trailing`,
      fixture: {
        ...(sample.fixture as Record<string, unknown>),
        role: "invitee",
        chatScenario: "tree-setup",
        repoState: "local-readable",
        treeState: "empty",
      },
    };
    expect(validateFloor([...cases, trailing]).some((error) => error.includes("must be last"))).toBe(true);
  });

  it("keeps onboarding attribution and no-project first reply guidance aligned with the product flow", () => {
    const description = skillMarkdown.match(/^description:\s*(.*)$/m)?.[1] ?? "";

    expect(description).not.toContain("local project folder path");
    expect(skillMarkdown).toContain("Treat the opening message as the user's onboarding request.");
    expect(skillMarkdown).toContain('`first-tree chat ask <human> "<goal-first ask>"`');
    expect(skillMarkdown).toContain("What's the first outcome you'd like from me?");
    expect(skillMarkdown).toContain("open by asking for a repo, path, or URL");
    expect(skillMarkdown).toContain("the only opening move is the goal-first ask");
    expect(skillMarkdown).toContain("accept a plain directory on");
    expect(skillMarkdown).toContain("`gh auth login` or `glab auth login`");
    expect(skillMarkdown).not.toContain("First Tree sent it");
  });

  it("keeps the post-orientation guidance on one in-chat microtask loop", () => {
    const boundedRead = skillMarkdown.indexOf("### Bounded project read");
    const receipt = skillMarkdown.indexOf("### Two-sentence project receipt");
    const choice = skillMarkdown.indexOf("### One microtask choice");
    const result = skillMarkdown.indexOf("### First result in this chat");
    const bridge = skillMarkdown.indexOf("### One relevant bridge");

    expect(boundedRead).toBeGreaterThan(-1);
    expect(receipt).toBeGreaterThan(boundedRead);
    expect(choice).toBeGreaterThan(receipt);
    expect(result).toBeGreaterThan(choice);
    expect(bridge).toBeGreaterThan(result);
    expect(skillMarkdown).toContain("**1–2 single-select microtasks**");
    expect(skillMarkdown).toContain("At least one option is read-only");
    expect(skillMarkdown).toContain('`first-tree chat update --description "<brief working status>"`');
    expect(skillMarkdown).toContain("put both receipt sentences at the start of the ask");
    expect(skillMarkdown).toContain("free-text task");
    expect(skillMarkdown).toContain("`first-tree chat send <human>`");
    expect(skillMarkdown).toContain("Do the first selected microtask in this chat");
    expect(skillMarkdown).toContain("Do not use `chat create` for the first selection");
    expect(skillMarkdown).toContain("tracked `first-tree chat ask <human>` body");
    expect(skillMarkdown).toContain("do not repeat\nrepository discovery or use a recursive scan");
    expect(skillMarkdown).toContain("Do not show time ranges");
    expect(skillMarkdown).toMatch(
      /Do not include Context Tree, GitHub App,\s+or repository setup in the first choice/u,
    );
    const exampleChoices = skillMarkdown
      .match(/Example shape:\s+```text[\s\S]*?Choose one:\n([\s\S]*?)\n\nOr type a different microtask\./u)?.[1]
      ?.split("\n")
      .filter((line) => line.startsWith("- "));
    expect(exampleChoices).toHaveLength(2);
    const exampleReceipt = skillMarkdown
      .match(/Example shape:\s+```text\n([\s\S]*?)\n\nChoose one:/u)?.[1]
      ?.match(/[.!?](?=\s|$)/gu);
    expect(exampleReceipt).toHaveLength(2);
    expect(skillMarkdown).not.toContain("### L2 — Longer value work");
    expect(skillMarkdown).not.toContain("first choices as a multi-select ask");
  });

  it("keeps forge access split between plain git reads and narrowly blocked forge operations", () => {
    expect(skillMarkdown).toContain("Try the filesystem and plain `git` first for reading code");
    expect(skillMarkdown).toContain("only for actual forge/API actions");
    expect(skillMarkdown).toMatch(/A GitHub URL alone is never a reason to ask\s+for GitHub App installation/u);
    expect(skillMarkdown).toContain("A repo access failure blocks only repo-dependent work");
    expect(skillMarkdown).toMatch(/explain that exact gap and give the single narrowest\s+recovery/u);
    expect(skillMarkdown).toContain("If First Tree says no repo is connected, that alone prompts nothing");
  });

  it("never turns a missing capability into proactive probing or setup talk", () => {
    // Host-CLI probing is scoped to tasks that genuinely need repo/forge
    // capability; a plain greeting or repo-free task triggers no probe.
    expect(skillMarkdown).toMatch(
      /current task genuinely needs the repo or forge\s+capability, first try to resolve it yourself/u,
    );
    expect(skillMarkdown).toMatch(/A plain greeting\s+or a repo-free task gets no host-CLI probe at all/u);
    // The admin handoff is mentioned only when the concrete result genuinely
    // depends on an admin-only capability; never proactively in a generic chat.
    expect(skillMarkdown).toMatch(
      /owns\/finishes\s+team setup only when the current concrete result genuinely\s+depends on an admin-only capability/u,
    );
    expect(skillMarkdown).toMatch(/generic no-repo\/no-Tree first chat says\s+nothing about setup or admins/u);
  });

  it("keeps later fan-out separate from the first microtask", () => {
    expect(skillMarkdown).toContain("Only after the user explicitly asks for multiple larger tasks");
    expect(skillMarkdown).toMatch(/The first microtask never fans out/iu);
    expect(skillMarkdown).toContain("`chat update --description`");
    expect(skillMarkdown).toContain("ordinary completion message");
    expect(skillMarkdown).toMatch(/Do not present later fan-out as the\s+first menu/u);
  });

  it("keeps GitLab MR attention provider-native and independent of the GitHub App", () => {
    expect(skillMarkdown).toContain("`first-tree gitlab follow <url>`");
    expect(skillMarkdown).toContain("returned pending or active attention state");
    expect(skillMarkdown).toContain("only a pending declaration waits");
    expect(skillMarkdown).toContain("preserve its returned pending or\nactive state");
    expect(skillMarkdown).toMatch(/A follow failure does not\s+invalidate the MR/u);
    expect(skillMarkdown).toMatch(/report\s+only the First Tree chat attention gap/u);
    expect(skillMarkdown).toContain(
      "do not call\n`first-tree github follow`, send the user to **Settings → Getting Started** for GitHub App",
    );
    expect(skillMarkdown).toContain("Never substitute `first-tree github follow`");
    expect(skillMarkdown).not.toContain("A GitLab MR has no documented equivalent here");
  });

  it("keeps the post-result bridge singular, goal-tied, and free of any proactive tree offer", () => {
    expect(skillMarkdown).toContain("A first-result diff does not authorize a PR/MR");
    // The proactive "build the Context Tree after value" offer is gone: a result
    // — even one exposing a lasting cross-module decision — never earns a tree
    // bridge, while an explicit user request still routes to the tree chat.
    expect(skillMarkdown).toContain("never offer a Context Tree build or a separate tree chat from a result");
    expect(skillMarkdown).toContain("Never offer to build the Context Tree from a result");
    expect(skillMarkdown).toContain("A missing or empty tree is background state, not a bridge");
    expect(skillMarkdown).not.toContain("After value lands");
    expect(skillMarkdown).not.toContain("the qualified tree bridge");
    expect(skillMarkdown).toContain("the user explicitly asks to build\nthe team's Context Tree");
    expect(skillMarkdown).toMatch(/persist current decisions as\s+shared team context/u);
    // Explicit Tree requests route by tree state, not unconditionally to Seed:
    // persist/write on a populated tree is a source-backed first-tree-write.
    expect(skillMarkdown).toContain("read the Context Tree → `first-tree-read`");
    expect(skillMarkdown).toContain("first-tree-write` behind its\n  source gate");
    expect(skillMarkdown).toContain("never Seed, which refuses non-empty trees");
    expect(skillMarkdown).toContain("Do not inspect or surface Automatic Review");
    expect(skillMarkdown).toContain(
      "does not automatically\n  register the session project as a durable Team repository",
    );
    expect(skillMarkdown).not.toContain("first-tree org context-tree review-config --json");
    expect(skillMarkdown).not.toContain("Settings -> GitHub");
  });

  it("keeps the skill's example trigger phrases in sync with the real onboarding bootstraps", () => {
    // Skill activation now rests entirely on the visible message matching the
    // skill description (no hidden directive — see the onboarding kickoff
    // contract). The skill hard-codes the product's kickoff openers as its
    // activation examples, so bind them to the real copy: a reword in
    // bootstrap-prose.ts must not silently drift the skill's trigger examples
    // and weaken selection.
    const bootstrapProse = readFileSync(
      join(process.cwd(), "../web/src/pages/workspace/center/onboarding/bootstrap-prose.ts"),
      "utf8",
    );
    const sharedOpeners = [
      "welcome aboard",
      "Please help me get started with First Tree",
      "Please help me get settled into this team on First Tree",
    ];
    for (const opener of sharedOpeners) {
      expect(skillMarkdown, `skill should reference the real kickoff opener: "${opener}"`).toContain(opener);
      expect(bootstrapProse, `bootstrap-prose.ts should still ship the kickoff opener: "${opener}"`).toContain(opener);
    }
  });

  it("keeps the OpenAI/Codex routing metadata description in sync with SKILL.md", () => {
    // `skills/<name>/agents/openai.yaml` is a second shipped routing surface:
    // the composer/runtime read it to select the skill on the OpenAI/Codex side.
    // Since activation is description-driven (no hidden directive), a stale
    // description here can still follow the retired explicit-name trigger and
    // miss the repo-scan exclusion even when SKILL.md is correct. Bind the two
    // so a copy reword cannot drift one surface without the other.
    const openaiYaml = readFileSync(join(process.cwd(), "../../skills/first-tree-welcome/agents/openai.yaml"), "utf8");
    const skillDescription = skillMarkdown.match(/^description:\s*(.*)$/m)?.[1] ?? "";
    const yamlDescription = openaiYaml.match(/^description:\s*(.*)$/m)?.[1] ?? "";

    expect(skillDescription, "SKILL.md must declare a description").not.toBe("");
    expect(yamlDescription, "openai.yaml description must match SKILL.md description").toBe(skillDescription);
    expect(skillDescription).toContain("PR/MR reviews");
    expect(yamlDescription).toContain("PR/MR reviews");
    expect(skillDescription).not.toContain("PR reviews");
    expect(yamlDescription).not.toContain("PR reviews");
    // Guard the specific retired trigger the drift-guard exists to catch.
    expect(yamlDescription).not.toContain("explicitly names first-tree-welcome");
    expect(yamlDescription).toContain("repo scans");
  });

  it("hardens every agent-briefing welcome skill-map row with the scan / tree-setup exclusion", () => {
    // agent-briefing.ejs ships FOUR `first-tree-welcome` "Load when" rows (the
    // remote, Local, external, and no-safe-source briefing variants) — routing
    // hints the agent reads. If any omits the scan / tree-setup exclusion it can
    // misroute a scan-first chat into the welcome launcher. Bind all four so none
    // drifts back to an un-hardened hint.
    const briefingTemplate = readFileSync(
      join(process.cwd(), "../client/src/runtime/templates/agent-briefing.ejs"),
      "utf8",
    );
    const welcomeRows = briefingTemplate.match(/^\|[ \t]*`first-tree-welcome`[ \t]*\|[^\n]*$/gm) ?? [];
    expect(welcomeRows, "template must contain remote, Local, external, and no-safe-source welcome rows").toHaveLength(
      4,
    );
    for (const row of welcomeRows) {
      expect(row, "every welcome row must carry the scan/tree-setup exclusion").toContain(
        "not a repo scan or tree setup chat",
      );
    }
    // The retired un-hardened hints must be gone.
    expect(briefingTemplate).not.toContain("onboarding welcome / intro / value-first first chat");
    expect(briefingTemplate).not.toContain("onboarding system messages ask for welcome");
  });

  it("keeps the Context Tree launcher brief user-visible and leaves implementation to seed", () => {
    expect(skillMarkdown).toContain("Build our team's\n  Context Tree from the connected code");
    expect(skillMarkdown).toMatch(/load `first-tree-seed` from\s+the task itself/u);
    expect(skillMarkdown).toMatch(/this launcher does none of\s+that/u);
    expect(skillMarkdown).toContain("Open the Structure PR/MR first");
    expect(skillMarkdown).toContain("preserve any existing Reviewer");
    expect(skillMarkdown).toMatch(/use this same\s+Agent as the default/u);
    expect(skillMarkdown).toMatch(/do not open its PR\/MR until a selected Reviewer is\s+enabled/u);
    expect(skillMarkdown).not.toContain("working Code Owner mapping");
    expect(skillMarkdown).not.toContain("GitHub governance setup");
    expect(skillMarkdown).not.toContain("default-branch rules");
    expect(skillMarkdown).not.toContain("required_approving_review_count");
    expect(skillMarkdown).not.toContain("dismiss_stale_reviews_on_push");
    expect(skillMarkdown).not.toContain("require_last_push_approval");
    expect(skillMarkdown).not.toContain("required_review_thread_resolution");
  });

  it("keeps production-scan fix fan-out aligned with the scan's 3-5 blocker contract", () => {
    expect(skillMarkdown).toContain("up to 5 eligible blockers");
    expect(skillMarkdown).toMatch(/Production-scan normally\s+reports 3-5 blockers/);
    expect(skillMarkdown).toContain("Do not split one blocker into implementation-step chats");
    expect(skillMarkdown).toContain("verify the finding still applies");
    expect(skillMarkdown).toContain("covered by existing code or an already-open PR");
    expect(skillMarkdown).not.toContain("top ~4");
  });

  it("does not depend on production-scan confidence fields that ps-1 reports do not emit", () => {
    expect(skillMarkdown).toContain("Eligible means the finding has concrete evidence");
    expect(skillMarkdown).toContain("needs product, architecture, or security-design judgment");
    expect(skillMarkdown).not.toContain("highest-leverage AND `confirmed`");
    expect(skillMarkdown).not.toContain("low-`confidence` findings");
    expect(skillMarkdown).not.toContain("triaged the confirmed safe blockers");
  });
});
