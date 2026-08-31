import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import {
  type BuildAgentBriefingOptions,
  buildAgentBriefing,
  FIRST_TREE_FAMILY_SKILL_NAMES,
  readCanonicalContextTreePolicy,
  readCanonicalContextTreeWriteRouting,
  resolveAgentBriefingTemplatePath,
  resolveCanonicalContextTreePolicyPath,
  resolveCanonicalContextTreeWriteRoutingPath,
} from "../runtime/agent-briefing.js";
import type { PredeclaredSourceRepo } from "../runtime/bootstrap.js";
import { setCliBinding } from "../runtime/cli-binding.js";
import type { AgentIdentity } from "../runtime/handler.js";

beforeAll(() => {
  setCliBinding({ binName: "first-tree", packageName: "first-tree" });
});

const AGENT_HOME = "/var/lib/agent-hub/workspaces/test-agent";

function makeIdentity(overrides?: Partial<AgentIdentity>): AgentIdentity {
  return {
    agentId: "test-agent",
    inboxId: "inbox-test-agent",
    displayName: "Test Agent",
    type: "agent",
    visibility: "organization",
    delegateMention: null,
    metadata: {},
    ...overrides,
  };
}

function makeOpts(overrides?: Partial<BuildAgentBriefingOptions>): BuildAgentBriefingOptions {
  return {
    identity: makeIdentity(),
    payload: null,
    workspacePath: AGENT_HOME,
    sourceRepos: [],
    contextTreePath: null,
    ...overrides,
  };
}

function topLevelSection(briefing: string, heading: string): string {
  const marker = `\n${heading}\n`;
  const start = briefing.indexOf(marker);
  expect(start, `missing section ${heading}`).toBeGreaterThanOrEqual(0);
  const contentStart = start + 1;
  const searchStart = contentStart + heading.length + 1;
  const knownHeadings = [
    "# Identity",
    "# Team Prompt (team-shared — read-only for agents)",
    "# Agent Prompt (this agent only — editable)",
    "# Agent Prompt Overrides (this agent only — managed via resource bindings)",
    "# Agent Prompt (legacy merged — may include team-shared content)",
    "# Working in First Tree (First Tree Managed)",
    "# Context Tree (First Tree Managed)",
    "# Skills (First Tree Managed)",
  ];
  const nextStarts = knownHeadings
    .map((candidate) => briefing.indexOf(`\n${candidate}\n`, searchStart))
    .filter((candidateStart) => candidateStart >= 0);
  if (nextStarts.length === 0) return briefing.slice(contentStart);
  return briefing.slice(contentStart, Math.min(...nextStarts));
}

function lineCount(text: string): number {
  return text.split(/\r?\n/u).length;
}

describe("buildAgentBriefing — generated skeleton", () => {
  it("renders through the checked-in EJS template and ends with a newline", () => {
    const templatePath = resolveAgentBriefingTemplatePath();

    expect(templatePath).toBe(
      resolve(dirname(fileURLToPath(import.meta.url)), "..", "runtime", "templates", "agent-briefing.ejs"),
    );

    const briefing = buildAgentBriefing(makeOpts());
    expect(briefing).toContain("# Identity\n\nYou are Test Agent, an autonomous agent.");
    expect(briefing.endsWith("\n")).toBe(true);
    expect(briefing.endsWith("\n\n")).toBe(false);
  });

  it("keeps managed prose in EJS and the core Context Tree policy in its canonical source", () => {
    const templatePath = resolveAgentBriefingTemplatePath();
    const templateSource = readFileSync(templatePath, "utf8");
    const runtimeSource = readFileSync(resolve(dirname(templatePath), "..", "agent-briefing.ts"), "utf8");
    const policySource = readFileSync(resolveCanonicalContextTreePolicyPath(), "utf8");

    for (const marker of [
      "You are running inside **First Tree**",
      "Blocking questions never ride inside plain `chat send`",
      "## GitLab Working Posture",
      "# Skills (First Tree Managed)",
    ]) {
      expect(templateSource).toContain(marker);
      expect(runtimeSource).not.toContain(marker);
    }
    expect(policySource).toContain("The Context Tree is durable context");
    expect(templateSource).not.toContain("The Context Tree is durable context");
    expect(templateSource).toContain("<%- contextTreePolicy %>");
    expect(runtimeSource).not.toContain("The Context Tree is durable context");

    expect(runtimeSource).not.toContain("requiredReadingBlock");
    expect(runtimeSource).not.toContain("function generatedBannerSection(");
    expect(runtimeSource).not.toContain("function workingInFirstTreeSection(");
    expect(runtimeSource).not.toContain("function contextTreeSection(");
    expect(runtimeSource.match(/getCliBinding\(\)/gu)).toHaveLength(1);
  });

  it("embeds the canonical Context Tree policy byte-for-byte in the managed briefing", () => {
    const canonical = readCanonicalContextTreePolicy();
    const briefing = buildAgentBriefing(makeOpts());

    expect(briefing).toContain(canonical);
    expect(briefing.split(canonical)).toHaveLength(2);
  });

  it("keeps managed Skills dependent on the generated briefing instead of an external Plugin reference", () => {
    const repoRoot = resolve(import.meta.dirname, "../../../..");
    for (const skillName of ["first-tree-read", "first-tree-write"]) {
      const skill = readFileSync(join(repoRoot, "skills", skillName, "SKILL.md"), "utf8");
      expect(skill).toContain("generated Context Tree Policy");
      expect(skill).not.toContain("references/context-tree-policy.md");
      expect(skill).not.toContain("../_shared/context-tree-policy.md");
    }
  });

  it("keeps top-level section order stable and excludes per-chat Current Chat Context", () => {
    const briefing = buildAgentBriefing(makeOpts({ contextTreePath: "/tree" }));
    const expectedOrder = [
      "# Identity",
      "# Working in First Tree (First Tree Managed)",
      "# Context Tree (First Tree Managed)",
      "# Skills (First Tree Managed)",
    ];

    let last = -1;
    for (const heading of expectedOrder) {
      const idx = briefing.indexOf(`\n${heading}\n`, Math.max(last, 0));
      expect(idx, `${heading} missing or out of order`).toBeGreaterThan(last);
      last = idx;
    }

    expect(briefing).not.toContain("## Current Chat Context");
    expect(briefing).not.toContain("Chat ID:");
    expect(briefing).not.toContain("Participants:");
  });

  it("opens with generated provenance and prompt edit boundaries", () => {
    const briefing = buildAgentBriefing(makeOpts());
    expect(briefing.startsWith("<!--")).toBe(true);
    expect(briefing).toContain("first-tree:generated");
    expect(briefing).toContain("NEVER copy this file");
    expect(briefing).toContain("first-tree agent config prompt show <agent> --raw");
    expect(briefing).toContain("first-tree agent config prompt set <agent> -f <file>");
    expect(briefing).toContain("Every other section is First Tree Managed");
  });

  it("keeps First Tree Managed sections within a compact briefing budget", () => {
    const sourceRepos: PredeclaredSourceRepo[] = [
      { absolutePath: `${AGENT_HOME}/source-repos/first-tree`, url: "https://github.com/example/first-tree" },
    ];
    const promptLines = Array.from({ length: 90 }, (_, index) => `Prompt line ${index + 1}`).join("\n");
    const payload = {
      kind: "claude-code" as const,
      model: "",
      prompt: { append: promptLines },
      mcpServers: [],
      env: [],
      gitRepos: [],
      resourceSkills: [],
      reasoningEffort: "" as const,
    };
    const briefing = buildAgentBriefing(
      makeOpts({
        payload,
        sourceRepos,
        contextTreePath: "/var/lib/context-trees/example",
        contextTreeRepoUrl: "https://github.com/example/context",
        contextTreeBranch: "main",
      }),
    );

    // Raised from 220 when "Chat Topic & Description" became the single
    // normative Summary authoring contract (shape, exclusions, update timing)
    // instead of a one-line "background + plan + progress" definition, and
    // again from 236 when the always-present generic Capability Degradation
    // baseline joined the section, and again from 246 when the CLI surface was
    // regrouped — `## CLI Overview` first, then Agent Identity & Config,
    // Communication, Task Management, Scheduled Jobs — and Task Management
    // gained the `chat create` wake rule (a human `--to` recipient wakes
    // nobody, so a task chat addressed to the user stalls until the user pings
    // back). The duplicated Workspace Collaboration matrix is gone. Every
    // other consumer — CLI help, docs, SDK/schema comments — points here, so
    // the budget buys prose the agent actually needs on every turn.
    expect(lineCount(topLevelSection(briefing, "# Working in First Tree (First Tree Managed)"))).toBeLessThanOrEqual(
      278,
    );
    expect(briefing).not.toContain("# Required Reading (First Tree Managed)");
    // Raised from 210 when the declared-identity guard bullet joined the bound
    // Tree Location block.
    expect(lineCount(topLevelSection(briefing, "# Context Tree (First Tree Managed)"))).toBeLessThanOrEqual(214);
    expect(lineCount(topLevelSection(briefing, "# Skills (First Tree Managed)"))).toBeLessThanOrEqual(20);
    // Tracks the same +16 and +10 the Summary authoring contract and the
    // Capability Degradation baseline add above, +4 for the identity guard, and
    // +28 for the regrouped CLI sections and the `chat create` wake rule.
    expect(lineCount(briefing)).toBeLessThanOrEqual(640);
  });

  it("renders identity from visibility", () => {
    const privateBriefing = buildAgentBriefing(
      makeOpts({ identity: makeIdentity({ visibility: "private", displayName: "Aly" }) }),
    );
    expect(privateBriefing).toContain("# Identity\n\nYou are Aly, a personal assistant agent.");

    const orgBriefing = buildAgentBriefing(
      makeOpts({ identity: makeIdentity({ visibility: "organization", displayName: "Aly" }) }),
    );
    expect(orgBriefing).toContain("# Identity\n\nYou are Aly, an autonomous agent.");
  });
});

describe("buildAgentBriefing — prompt provenance sections", () => {
  const basePayload = {
    kind: "claude-code" as const,
    model: "",
    prompt: { append: "" },
    mcpServers: [],
    env: [],
    gitRepos: [],
    resourceSkills: [],
    reasoningEffort: "" as const,
  };

  it("renders legacy append only as the legacy fallback, with self-contained provenance", () => {
    expect(buildAgentBriefing(makeOpts({ payload: null }))).not.toContain("legacy merged");

    const payload = { ...basePayload, prompt: { append: "Follow the local plan." } };
    const briefing = buildAgentBriefing(makeOpts({ payload }));
    expect(briefing).toContain("# Agent Prompt (legacy merged — may include team-shared content)");
    expect(briefing).toContain("Follow the local plan.");
    expect(briefing).not.toContain("## Agent-Specific Prompt");
    expect(briefing).not.toContain("# Agent Prompt (this agent only — editable)");

    // The fallback section itself names its source and both edit entry
    // points, so the file stays self-contained without the structured trio.
    expect(briefing).toContain("served as one merged blob");
    expect(briefing).toContain("first-tree agent config prompt show test-agent --raw");
    expect(briefing).toContain("first-tree agent config prompt set test-agent");
    expect(briefing).toContain("Do NOT copy any of this\nmerged section into your per-agent prompt.");

    // The merged blob can also embed binding-managed agent prompt overrides,
    // which `prompt set` cannot edit — both the banner and the Source
    // paragraph must name that class and its Cloud-managed edit path.
    expect(briefing.match(/binding-managed agent prompt overrides/g)).toHaveLength(2);
    expect(briefing).toMatch(/binding-managed agent prompt overrides[\s\S]{0,160}?Org Settings →\s+Resources/);
    expect(briefing).toMatch(/binding-managed agent prompt overrides\s+\(NOT editable with `prompt set`/);

    // The banner documents the heading that actually renders on this path —
    // the legacy merged entry replaces the structured three-heading map.
    expect(briefing).toContain("# Agent Prompt (legacy merged) → this agent's prompt configuration");
    expect(briefing).toContain("NEVER copy the merged section back into prompt set");
    expect(briefing).not.toContain("# Team Prompt   → team prompt resources");
    expect(briefing).not.toContain("# Agent Prompt Overrides → agent-specific resource bindings");
    expect(briefing).toContain("Every other section is First Tree Managed");
  });

  it("separates team prompt, editable agent prompt, and non-editable overrides", () => {
    const payload = {
      ...basePayload,
      prompt: {
        append: "legacy blob must be ignored",
        sections: [
          { scope: "team" as const, name: "Review Rules", body: "Always review twice.", editable: false },
          { scope: "agent" as const, name: "", body: "Prefer terse replies.", editable: true },
          { scope: "agent" as const, name: "Tone guide", body: "Override body.", editable: false },
        ],
      },
    };

    const briefing = buildAgentBriefing(makeOpts({ payload }));
    expect(briefing).toContain("# Team Prompt (team-shared — read-only for agents)");
    expect(briefing).toContain("## Review Rules\n\nAlways review twice.");
    expect(briefing).toMatch(/do NOT copy any of this into\nyour per-agent prompt/);
    expect(briefing).toContain("# Agent Prompt (this agent only — editable)");
    expect(briefing).toContain("Prefer terse replies.");
    expect(briefing).toContain("first-tree agent config prompt show test-agent --raw");
    expect(briefing).toContain("first-tree agent config prompt set test-agent");
    expect(briefing).toContain("# Agent Prompt Overrides (this agent only — managed via resource bindings)");
    expect(briefing).toContain("## Tone guide\n\nOverride body.");
    expect(briefing).toMatch(/NOT editable with `prompt set`/);
    expect(briefing).not.toContain("## Agent-Specific Prompt");
    expect(briefing).not.toContain("legacy merged");
  });

  it("renders identity, prompt, and path values without HTML escaping", () => {
    const workspacePath = "/tmp/<team>&/it's-`safe`";
    const sourcePath = `${workspacePath}/source-repos/<repo>&'`;
    const contextTreePath = `${workspacePath}/context-tree/<tree>&'`;
    const payload = {
      ...basePayload,
      prompt: {
        append: "legacy ignored",
        sections: [
          {
            scope: "team" as const,
            name: "Rules <raw> & O'Brien `ops`",
            body: "Keep <prompt> & O'Brien `literal`.",
            editable: false,
          },
          {
            scope: "agent" as const,
            name: "",
            body: "Agent body <raw> & 'quoted' `ticks`.",
            editable: true,
          },
        ],
      },
    };
    const briefing = buildAgentBriefing(
      makeOpts({
        identity: makeIdentity({ displayName: "A<ly & O'Brien `ops`" }),
        payload,
        workspacePath,
        sourceRepos: [
          {
            absolutePath: sourcePath,
            url: "ssh://git@example.com/group/<repo>&'`tick`.git",
          },
        ],
        contextTreePath,
        contextTreeRepoUrl: "ssh://git@example.com/context/<tree>&'`tick`.git",
        contextTreeBranch: "feature/<raw>&'`tick`",
      }),
    );

    expect(briefing).toContain("You are A<ly & O'Brien `ops`, an autonomous agent.");
    expect(briefing).toContain("## Rules <raw> & O'Brien `ops`");
    expect(briefing).toContain("Keep <prompt> & O'Brien `literal`.");
    expect(briefing).toContain("Agent body <raw> & 'quoted' `ticks`.");
    expect(briefing).toContain(`Your fixed working directory is \`${workspacePath}\`.`);
    expect(briefing).toContain(`- \`${sourcePath}\``);
    expect(briefing).toContain(contextTreePath);
    expect(briefing).toContain("it'\\''s-`safe`");
    expect(briefing).toContain("feature/<raw>&'\\''`tick`");
    expect(briefing).not.toMatch(/&(?:amp|lt|gt|#39|#96);/u);
  });
});

describe("buildAgentBriefing — Context Tree policy and skill routing", () => {
  it("emits the structured Context Tree policy baseline in generated briefing", () => {
    const briefing = buildAgentBriefing(makeOpts({ contextTreePath: "/tree" }));
    const tree = topLevelSection(briefing, "# Context Tree (First Tree Managed)");

    expect(tree).toContain("## Context Tree Policy");
    expect(tree).toContain("### Source-System Boundary");
    expect(tree).toContain("### Content Classes And Authority");
    expect(tree).toContain("**Normal content**");
    expect(tree).toContain("**Archive/supporting content**");
    expect(tree).toContain("**Member content**");
    expect(tree).toContain("### Code vs Tree Drift Authority");
    expect(tree).toContain("code is the ground truth");
    expect(tree).toContain("`decisionLocksCode: true` reverses that default");
    expect(tree).toContain("### The Double Test");
    expect(tree).toContain("### Content Model: What / Why / Who");
    expect(tree).toContain("### Add vs Edit");
    expect(tree).toContain("### Node Shape");
    expect(tree).toContain("`lastReviewed` records an actual\nowner review");
    expect(tree).toContain("update it only through that review/audit workflow");
    expect(tree).toContain("never during\na source-backed write");
    expect(tree).toContain('Use `owners: ["*"]` only when a human explicitly opens');
    expect(tree).toContain("ownership to everyone");
    expect(tree).toContain("Metadata supports scanning, routing, and responsibility");
    expect(tree).toContain("### Write / Verify / PR/MR Discipline");
    expect(briefing).not.toMatch(/you MUST\s+load \*\*`first-tree-write`\*\*/);
    expect(briefing).toContain("`first-tree-read`");
    expect(briefing).toContain("`first-tree-seed`");
    expect(briefing).not.toContain(`${AGENT_HOME}/.agents/skills/first-tree/SKILL.md`);
    expect(briefing).not.toContain(`${AGENT_HOME}/.agents/skills/first-tree-context/SKILL.md`);
  });

  it("emits the policy baseline and tree-less degradation guidance", () => {
    const briefing = buildAgentBriefing(makeOpts({ contextTreePath: null }));
    expect(briefing).not.toContain("# Required Reading");
    const tree = topLevelSection(briefing, "# Context Tree (First Tree Managed)");
    expect(tree).toContain("## Context Tree Policy");
    expect(tree).toContain("This briefing was generated without a bound tree — a supported state, not a gap to fix");
    expect(tree).toContain("no prompt to bind or create a tree");
    expect(tree).toContain(
      "Re-check the workspace binding only if the user says a tree was created or bound this session",
    );
    expect(tree).toMatch(/ordinary tasks\s+do not route into `first-tree-read`/);
    expect(tree).toMatch(/ordinary work\s+never routes into a Tree write/);
    expect(tree).not.toContain("surface that gap");
    expect(tree).not.toContain("surface the missing binding/setup gap");
    expect(tree).not.toContain("before any tree read/write, re-check the workspace binding");
  });

  it("lists every installed First Tree skill in the family map", () => {
    const familyMap = topLevelSection(
      buildAgentBriefing(makeOpts({ contextTreePath: "/tree" })),
      "# Skills (First Tree Managed)",
    );
    expect(familyMap).toContain("The generated Context Tree Policy is always present");
    expect(familyMap).toMatch(/\|\s*`first-tree-read`\s*\| read relevant Context Tree files before acting/);
    expect(familyMap).toMatch(/\|\s*`first-tree-write`\s*\| reflect a concrete source artifact/);
    expect(familyMap).toMatch(/\|\s*`context-tree-review`\s*\| a trusted provider-scoped Context Reviewer run/);
    expect(familyMap).toMatch(/\|\s*`context-tree-audit`\s*\| a human explicitly asks to audit/);

    const treelessFamily = topLevelSection(
      buildAgentBriefing(makeOpts({ contextTreePath: null })),
      "# Skills (First Tree Managed)",
    );
    expect(treelessFamily).toContain("first-tree-welcome");
    expect(treelessFamily).toContain("never an external-channel or `type=integration` message such as Feishu");
    expect(treelessFamily).toContain("first-tree-seed");
    expect(treelessFamily).toContain("first-tree-file-bug");
    expect(treelessFamily).not.toContain("first-tree-gitlab");
    expect(treelessFamily).toContain("first-tree-qa");
    expect(treelessFamily).toMatch(
      /\|\s*`first-tree-read`\s*\| read relevant Context Tree files only for an explicit Tree read request/,
    );
    expect(treelessFamily).toMatch(/\|\s*`first-tree-write`\s*\| reflect a concrete source artifact/);
    expect(treelessFamily).toMatch(/ordinary code, repo,\s+and error signals never route into them/);
    expect(treelessFamily).toMatch(/\|\s*`context-tree-review`\s*\| a trusted provider-scoped Context Reviewer run/);
    expect(treelessFamily).toMatch(/\|\s*`context-tree-audit`\s*\| a human explicitly asks to audit/);
    expect(treelessFamily).toMatch(/without a binding, the audit fails closed/);
    expect(treelessFamily).toContain("These skills install in every workspace");
    expect(treelessFamily).not.toContain("# Required Reading");
  });
});

describe("buildAgentBriefing — Working in First Tree hard rules", () => {
  it("anchors console/outbox and chat send/ask/update behavior", () => {
    const briefing = buildAgentBriefing(makeOpts());

    expect(briefing).toMatch(/the "user" your underlying agent addresses is the First\s+Tree runtime/);
    expect(briefing).toMatch(/visible live reasoning\/activity trace/);
    expect(briefing).toContain("This is your **console**");
    expect(briefing).toContain("Teammates are reached through the **outbox**");
    expect(briefing).toContain("first-tree chat send");
    expect(briefing).toContain("first-tree chat ask");
    expect(briefing).toContain("first-tree chat update --description");
    expect(briefing).toMatch(/Human message: finish with one/);
    expect(briefing).toMatch(/Agent handoff: `first-tree chat send <agent>`/);
    expect(briefing).toMatch(/Do not send\s+courtesy acknowledgements to agents/);
    expect(briefing).toContain("-F <file>");
    expect(briefing).toContain("-F -");
    expect(briefing).toContain("--description -");
    expect(briefing).toContain("never `JSON.stringify`");
  });

  it("interpolates the working directory and worktree paths", () => {
    const briefing = buildAgentBriefing(
      makeOpts({
        sourceRepos: [
          { absolutePath: `${AGENT_HOME}/source-repos/example`, url: "https://github.com/example/example" },
        ],
      }),
    );
    expect(briefing).toContain(`Your fixed working directory is \`${AGENT_HOME}\`.`);
    expect(briefing).toContain("persistent state");
    expect(briefing).toContain("## Worktrees");
    expect(briefing).toContain("No worktrees are pre-created");
    expect(briefing).toContain(`${AGENT_HOME}/worktrees/<name>-read`);
    expect(briefing).toContain(`${AGENT_HOME}/worktrees/<task-name>`);
    expect(briefing).toContain("worktree remove");
    expect(briefing).not.toContain("<agent-home>/worktrees/");
  });

  it("renders source repos with bare-clone fail-closed protocol and compact legacy gates", () => {
    const sourceRepos: PredeclaredSourceRepo[] = [
      {
        absolutePath: `${AGENT_HOME}/source-repos/api`,
        url: "git@github.com:example/api.git",
        ref: "main",
        branch: "session/test-agent",
      },
      {
        absolutePath: `${AGENT_HOME}/source-repos/web`,
        url: "git@github.com:example/web.git",
      },
    ];
    const briefing = buildAgentBriefing(makeOpts({ sourceRepos }));

    expect(briefing).toContain("## Source Repositories (agent-managed, bare)");
    expect(briefing).toContain(`\`${AGENT_HOME}/source-repos/api\``);
    expect(briefing).toContain("url=git@github.com:example/api.git");
    expect(briefing).toContain("ref=main");
    expect(briefing).toContain("branch=session/test-agent");
    expect(briefing).toContain(`\`${AGENT_HOME}/source-repos/web\``);
    expect(briefing).not.toContain(`\`${AGENT_HOME}/api\``);
    expect(briefing).not.toContain(`\`${AGENT_HOME}/worktrees/api\``);

    expect(briefing).toMatch(/\*\*You manage these clones yourself\*\*/);
    expect(briefing).toContain("git clone --bare <url> <path>");
    expect(briefing).toContain("git -C <path> config remote.origin.fetch '+refs/heads/*:refs/remotes/origin/*'");
    expect(briefing).toContain("git -C <path> remote get-url origin");
    expect(briefing).toMatch(/compare it canonically/);
    expect(briefing).toMatch(/https\/http\/ssh\/git\/scp transport/);
    expect(briefing).toMatch(/If it does\s+\*\*not\*\* match, stop/);
    expect(briefing).toContain("git -C <path> fetch origin");
    expect(briefing).toContain("Credential failures are reportable");

    expect(briefing).toContain("Legacy non-bare workspace checkout");
    expect(briefing).toContain(".first-tree/workspace.json");
    expect(briefing).toContain("reserved workspace dirs");
    expect(briefing).toContain("status --porcelain");
    expect(briefing).toContain("merge-base --is-ancestor");
    expect(briefing).toContain("branch --no-merged origin/<default>");
    expect(briefing).toContain("stash list");
    expect(briefing).toContain('mv -- "$legacy" "$legacy.retired.$(date +%Y%m%d%H%M%S)"');
    expect(briefing).not.toContain("assert_legacy_target() {");
    expect(briefing).not.toContain("rm -rf <legacy>");
  });

  it("omits the Source Repositories and Worktrees blocks when no repos are declared", () => {
    const briefing = buildAgentBriefing(makeOpts({ sourceRepos: [] }));
    expect(briefing).not.toContain("## Source Repositories");
    expect(briefing).not.toContain("## Worktrees");
    expect(briefing).not.toContain("git clone --bare");
    expect(briefing).not.toContain("No worktrees are pre-created");
  });

  it("stays coherent with no source repos, no Context Tree, and no prompt content", () => {
    const briefing = buildAgentBriefing(makeOpts({ payload: null, sourceRepos: [], contextTreePath: null }));

    // Capability-dependent scaffolding is omitted entirely, not degraded to a
    // setup prompt.
    expect(briefing).not.toContain("## Source Repositories");
    expect(briefing).not.toContain("## Worktrees");
    expect(briefing).not.toContain("git clone --bare");
    expect(briefing).not.toContain("declared for this agent");

    // The generic capability-degradation baseline still renders and states the
    // no-source continuation rules without any setup steering.
    const baseline = briefing.slice(
      briefing.indexOf("## Capability Degradation"),
      briefing.indexOf("## Working Directory"),
    );
    expect(baseline).toContain("removes only the operations that depend on that capability");
    expect(baseline).toMatch(/pasted content\s+and attachments, and locally available inputs/);
    expect(baseline).toMatch(/a plain directory,\s+pasted content, an attachment, or a repository URL/);

    // No proactive bind/create/install pushes: the missing tree is a supported
    // state, and guidance appears only for capability-dependent requests.
    expect(briefing).not.toContain("surface that gap");
    expect(briefing).not.toContain("surface the missing binding/setup gap");
    expect(briefing).not.toMatch(/ask (?:the user|a human) to (?:bind|create|install)/i);
    const tree = topLevelSection(briefing, "# Context Tree (First Tree Managed)");
    expect(tree).toContain("a supported state, not a gap to fix");
    expect(tree).toMatch(/[Oo]nly when the user explicitly asks/);

    // Still a coherent briefing.
    expect(briefing).toContain("# Identity\n\nYou are Test Agent, an autonomous agent.");
    expect(briefing).toContain("# Working in First Tree (First Tree Managed)");
    expect(briefing).toContain("# Context Tree (First Tree Managed)");
    expect(briefing).toContain("## Context Tree Policy");
    expect(briefing).toContain("# Skills (First Tree Managed)");
    expect(briefing.endsWith("\n")).toBe(true);
  });

  it("pins the generic capability-degradation baseline with or without a bound tree", () => {
    const emptyPayload = {
      kind: "claude-code" as const,
      model: "",
      prompt: { append: "" },
      mcpServers: [],
      env: [],
      gitRepos: [],
      resourceSkills: [],
      reasoningEffort: "" as const,
    };

    // (a) fully capability-less session and (b) tree bound but no source repos:
    // the same generic baseline renders in both, independent of Tree state.
    for (const contextTreePath of [null, "/tree"]) {
      const briefing = buildAgentBriefing(makeOpts({ payload: emptyPayload, sourceRepos: [], contextTreePath }));
      const baseline = briefing.slice(
        briefing.indexOf("## Capability Degradation"),
        briefing.indexOf("## Working Directory"),
      );

      // Positive: the generic rules name every capability and the continuation
      // and minimal-input rules.
      expect(baseline).toMatch(
        /Context Tree, readable source repository, local forge CLI \(`gh`\/`glab`\), or Team\s+binding\/provider\/resources/,
      );
      expect(baseline).toContain("removes only the operations that depend on that capability");
      expect(baseline).toMatch(/the user's messages, chat context, pasted content\s+and attachments/);
      expect(baseline).toContain("locally available inputs");
      expect(baseline).toMatch(/a plain directory,\s+pasted content, an attachment, or a repository URL/);
      expect(baseline).toMatch(/never requiring the user to create, bind, or\s+connect a git repository/);

      // Negative: the baseline itself never steers toward bind/create/connect/
      // install or repo setup as a precondition.
      expect(baseline).not.toMatch(/ask (?:the user|a human) to (?:bind|create|connect|install)/i);
      expect(baseline).not.toContain("connect a repository");
      expect(baseline).not.toMatch(/\binstall\b/iu);
      expect(baseline).not.toMatch(/set up a (?:git )?(?:repo|repository|tree)/iu);
    }
  });

  it("keeps the Communication matrix markers and rich-body safety rules", () => {
    const briefing = buildAgentBriefing(makeOpts());
    const communication = briefing.slice(briefing.indexOf("## Communication"));

    expect(communication).toMatch(/business action changes the workspace\s+or outside world/);
    expect(communication).toContain("Replying to a human is required, not optional");
    expect(communication).toContain("never to a\nfresh human-directed message");
    expect(communication).toContain("Blocking questions never ride inside plain `chat send`");
    expect(communication).toContain("route by dependency, not importance");
    expect(communication).toContain("chat update --description -");
    expect(communication).toContain("Do not send courtesy acknowledgements");
    expect(communication).toMatch(/group chats reject no-recipient/i);
    expect(communication).toContain("chat create --to <name>");
    expect(communication).toContain("@EOF");
    expect(communication).toContain("Issue #389");
    expect(communication).toMatch(/Use\s+`-f markdown`/);
    expect(communication).toMatch(/`-F` supplies only\s+the body/);
    expect(communication).toContain("chat send --help");
    expect(communication).toContain("never borrow a human Web/browser session");
  });

  it("states the chat create wake rule in Task Management", () => {
    const briefing = buildAgentBriefing(makeOpts());
    const task = briefing.slice(briefing.indexOf("## Task Management"), briefing.indexOf("## Scheduled Jobs"));

    // The wake rule is the whole reason a spawned task chat starts working:
    // only self-address wakes the creator, and a human recipient wakes nobody.
    expect(task).toContain("`chat create` wakes exactly its `--to` recipients");
    expect(task).toContain("--to <your own agent name>");
    expect(task).toContain("Self-address is the\n  only form that wakes you");
    expect(task).toContain("`--to <human>` alone — nobody starts working");
    expect(task).toContain("`--with <name>` adds context\nparticipants who are not woken");
    expect(task).toContain("chat invite");
    expect(task).toContain("do not poll solely because that agent has not replied");
    expect(task).toContain("cannot attach files");
  });

  it("uses one channel-resolved binary name across prompt, chat, GitHub, and tree commands", () => {
    setCliBinding({ binName: "first-tree-staging", packageName: "first-tree-staging" });
    try {
      const briefing = buildAgentBriefing(
        makeOpts({
          contextTreePath: "/tree",
          payload: {
            kind: "claude-code",
            model: "",
            prompt: {
              append: "",
              sections: [{ scope: "agent", name: "", body: "Channel prompt.", editable: true }],
            },
            mcpServers: [],
            env: [],
            gitRepos: [],
            resourceSkills: [],
            reasoningEffort: "",
          },
        }),
      );
      expect(briefing).toContain("first-tree-staging agent config prompt show <agent> --raw");
      expect(briefing).toContain("first-tree-staging agent config prompt show test-agent --raw");
      expect(briefing).toContain("first-tree-staging chat send");
      expect(briefing).toContain("first-tree-staging github follow <url>");
      expect(briefing).toContain("first-tree-staging tree verify");
      expect(briefing).toContain("first-tree-staging tree tree --help");
      expect(briefing).not.toMatch(/\bfirst-tree (?:agent|chat|github|tree)\b/u);
    } finally {
      setCliBinding({ binName: "first-tree", packageName: "first-tree" });
    }
  });
});

describe("buildAgentBriefing — asking humans, GitHub, and CLI overview", () => {
  it("keeps chat ask dependency routing and self-sufficient body requirements", () => {
    const briefing = buildAgentBriefing(makeOpts());
    const asking = briefing.slice(briefing.indexOf("## Asking Humans"));

    expect(asking).toContain("raises a tracked open question");
    expect(asking).toContain("The routing test is **dependency, not importance**");
    expect(asking).toContain("genuinely the user's to make");
    expect(asking).toContain("Do NOT manufacture");
    expect(asking).toContain("can I continue?");
    expect(asking).toContain("can cite them");
    expect(asking).toContain("Ask volume should fall");
    expect(asking).toContain("body IS the ask");
    expect(asking).toContain("decision-self-sufficient");
    expect(asking).toContain("Why this question exists");
    expect(asking).toContain("Recent context");
    expect(asking).toContain("**The question**");
    expect(asking).toContain("required content dimensions, not mandatory headings");
    expect(asking).toContain("more specific agent/task/workflow template");
    expect(asking).toContain("preserve that template");
    expect(asking).not.toContain("include exactly these sections");
    expect(asking).toContain("--options");
    expect(asking).toContain("--multi-select");
    expect(asking).toContain("human resolves");
    expect(asking).not.toContain("--answer");
    expect(asking).not.toContain("--question");
    expect(asking).not.toContain("--close");
  });

  it("keeps Scheduled jobs briefing contract compact and fail-closed", () => {
    const briefing = buildAgentBriefing(makeOpts());
    const scheduled = briefing.slice(
      briefing.indexOf("## Scheduled Jobs"),
      briefing.indexOf("## GitHub Working Posture"),
    );

    expect(scheduled).toContain("cron` only");
    expect(scheduled).toContain("never provider-native schedulers");
    expect(scheduled).toContain("Managing human's explicit instruction for that create/update/pause/resume/delete");
    expect(scheduled).toContain("no re-`chat ask`");
    expect(scheduled).toContain("fail closed");
    expect(scheduled).toContain("cron preview");
    expect(scheduled).toContain("chat ask` managing human");
    expect(scheduled).toContain("applied/not-applied");
    expect(scheduled).toContain("cron list");
    expect(scheduled).toContain("Pause blocks future accepts only");
    expect(scheduled).toContain("accepted/delivered/running continue");
    expect(scheduled).toContain("acceptedWorkPreserved");
    expect(scheduled).toContain("FIRST_TREE_CHAT_ID");
    expect(scheduled).not.toContain("Current-Chat human instruction");
    expect(scheduled).not.toContain("CronCreate");
  });

  it("keeps GitHub posture and follow-after-create rules inline", () => {
    const briefing = buildAgentBriefing(makeOpts());
    const orderedHeadings = [
      "## CLI Overview",
      "## Agent Identity & Config",
      "## Communication",
      "## Task Management",
      "## Scheduled Jobs",
      "## GitHub Working Posture",
      "## GitHub Entity Attention",
      "## GitLab Working Posture",
      "## GitLab Entity Attention",
      "## Asking Humans",
    ];
    let previousIndex = -1;
    for (const heading of orderedHeadings) {
      const index = briefing.indexOf(heading);
      expect(index, `${heading} missing or out of order`).toBeGreaterThan(previousIndex);
      previousIndex = index;
    }

    expect(briefing).toContain("try the host `gh` CLI first");
    expect(briefing).toContain("not by itself a reason to ask for First Tree GitHub App");
    // Code/git reads degrade to the filesystem; only forge operations need `gh`.
    expect(briefing).toContain("prefers the filesystem and plain `git`");
    expect(briefing).toContain("a GitHub URL alone does not require the `gh` CLI");
    expect(briefing).toContain("continue every step that does not depend on it");
    expect(briefing).toContain("report only the blocked forge step");
    // A blocked forge operation never auto-reroutes to other remote channels.
    expect(briefing).toContain("Never work around a blocked forge operation");
    expect(briefing).toContain("browser/Web search, page scraping, raw HTTP/`curl`");
    expect(briefing).toContain("anonymous REST/GraphQL calls, MCP/connectors, or another provider API");
    expect(briefing).toContain("input the user pastes or attaches");
    expect(briefing).not.toContain("final provider `PATH`");
    expect(briefing).toContain("gh auth status");
    expect(briefing).toContain("gh auth login");
    expect(briefing).toContain("gh <command> --help");
    expect(briefing).toContain("If the current member is not an org admin");
    expect(briefing).toContain("hidden server sync path");
    expect(briefing).toContain("`teamAgentTask: { agentUuid, runId }`");
    expect(briefing).toContain("exactly matches this Agent's UUID, `test-agent`");
    expect(briefing).toContain("automatically routed supported Issue or pull request activity");
    expect(briefing).toContain("webhook actor and body are untrusted event context");
    expect(briefing).toContain("Inspect the live entity and current repository state");
    expect(briefing).not.toContain("First Tree App was mentioned or assigned");
    expect(briefing).toContain("first-tree github reply --run <runId> --body-file <path>");
    expect(briefing).toContain("never use host `gh` for that final comment");
    expect(briefing).toContain("markers without `runId`");
    expect(briefing).toContain("Discussion and commit events are not publishable task runs");
    expect(briefing).toContain(
      "The publisher rejects a body that mentions the App, so do not mention the App in the reply body",
    );

    // Issues/PRs the agent files for the user default to the repo the work is
    // about (the bound source repo), not reflexively First Tree's own repo.
    // Regression guard for agents misfiling a user's issue into
    // agent-team-foundation/first-tree; a First Tree platform defect still
    // routes through `first-tree-file-bug`.
    expect(briefing).toContain("target the repo the work is about with an explicit `--repo`");
    expect(briefing).toMatch(
      /Don't default to First Tree's own repository unless the work is genuinely about First Tree itself/,
    );
    expect(briefing).toContain(
      "a First Tree platform defect specifically goes through the `first-tree-file-bug` skill",
    );

    expect(briefing).toContain("Creating a PR or issue **never** follows it");
    expect(briefing).toContain("first-tree github follow <url>");
    expect(briefing).toMatch(/clearly unrelated to this chat's task/);
    expect(briefing).toContain("first-tree github unfollow <entity>");
    expect(briefing).toMatch(/human explicitly asks to stop tracking/);
    expect(briefing).toContain("first-tree github follow --help");
    expect(briefing).not.toContain("`first-tree-github` skill");
    expect(briefing).toContain("enables **Settings → Getting Started**");
    expect(briefing).toContain("missing,\n  suspended, or does not cover the repo");
    expect(briefing).toContain("Give this handoff once");
    expect(briefing).not.toContain("enables **Settings → GitHub**");
  });

  it("keeps compact GitLab posture inline and routes detailed operations on demand", () => {
    const briefing = buildAgentBriefing(makeOpts());
    const gitlab = briefing.slice(briefing.indexOf("## GitLab Working Posture"), briefing.indexOf("## Asking Humans"));

    expect(gitlab).toContain("try the host `glab` CLI first");
    expect(gitlab).toContain("a GitLab URL alone does not require the `glab` CLI");
    expect(gitlab).toContain("continue every step that does not depend on it");
    expect(gitlab).toContain("report only the blocked forge step");
    // Symmetric with GitHub: no fallback to other remote channels.
    expect(gitlab).toContain("Never work around a blocked forge operation");
    expect(gitlab).toContain("anonymous REST/GraphQL calls, MCP/connectors, or another provider API");
    expect(gitlab).toContain("input the user pastes or attaches");
    expect(gitlab).toContain("merge requests, issues, pipelines/jobs, repository metadata, comments");
    expect(gitlab).toContain("ordinary merge request / issue creation");
    expect(gitlab).toContain("GitLab.com");
    expect(gitlab).toContain("GitLab Dedicated");
    expect(gitlab).toContain("GitLab Self-Managed");
    expect(gitlab).toContain("infers the host from the current repository remote");
    expect(gitlab).not.toContain("final provider `PATH`");
    expect(gitlab).toContain("missing, unauthenticated, points at the wrong host, or lacks access");
    expect(gitlab).toContain("install GitLab CLI");
    expect(gitlab).toContain("fix auth/access/project permissions");
    expect(gitlab).toContain("use a local clone");
    expect(gitlab).toContain("glab <command> --help");
    expect(gitlab).not.toContain("glab auth status");
    expect(gitlab).not.toContain("--hostname <host>");
    expect(gitlab).not.toContain("glab auth login");
    expect(gitlab).toContain("Never expose a token");
    expect(gitlab).toContain("command output, logs, or shell history");
    expect(gitlab).toContain("only notifications for the current authenticated account");
    expect(gitlab).toContain("do not bind GitLab events to a First Tree chat");
    expect(gitlab).toContain("do not require the First Tree GitHub App");

    expect(gitlab).toContain("Default: follow what you create");
    expect(gitlab).toContain("first-tree gitlab follow <url>");
    expect(gitlab).toContain("inbound-only and may return pending or active");
    expect(gitlab).toContain("while an already active line stays active");
    expect(gitlab).toContain("without calling GitLab");
    expect(gitlab).toContain("gitlab follow <url> --rebind");
    expect(gitlab).toContain("does not invalidate an entity that was already created");
    expect(gitlab).toContain("only when the human explicitly asks for personal-account notifications");
    expect(gitlab).toContain("only when the human explicitly asks this chat");
    expect(gitlab).toContain("never automatically when an Issue closes");
    expect(gitlab).toContain("an MR merges, or the task finishes");
    expect(gitlab).toContain("first-tree gitlab unfollow <url>");
    expect(gitlab).toContain("removes every automatic or manual binding");
    expect(gitlab).toContain("may create a new route");
    expect(gitlab).toContain("first-tree gitlab following");
    expect(gitlab).not.toContain("first-tree-gitlab");

    expect(gitlab).not.toContain("install the First Tree GitHub App");
    expect(gitlab).not.toMatch(/`glab (?:issue|mr) (?:subscribe|unsubscribe) [^`]+`/u);
    expect(gitlab).not.toContain("-R <group/project>");
  });

  it("always renders compact host posture without session-scoped CLI availability", () => {
    const briefing = buildAgentBriefing(makeOpts());

    expect(briefing).toContain("## GitHub Working Posture");
    expect(briefing).toContain("## GitHub Entity Attention");
    expect(briefing).toContain("## GitLab Working Posture");
    expect(briefing).toContain("## GitLab Entity Attention");
    expect(briefing).not.toContain("detected `gh`");
    expect(briefing).not.toContain("did not detect `gh`");
    expect(briefing).not.toContain("detected `glab`");
    expect(briefing).not.toContain("did not detect `glab`");
    expect(briefing).not.toContain("final provider `PATH`");
    expect(briefing).toContain("## Asking Humans");
  });

  it("keeps chat metadata rules compact but actionable", () => {
    const briefing = buildAgentBriefing(makeOpts());
    const chatTopic = briefing.slice(briefing.indexOf("## Chat Topic & Description"));

    expect(chatTopic).toContain('provider-injected "Current Chat Context"');
    expect(chatTopic).toContain("short (<= 30 chars)");
    expect(chatTopic).toContain("调研 chat rename 方案");
    expect(chatTopic).toContain("本周 ship 计划");
    expect(chatTopic).toContain("chat update --topic");
    expect(chatTopic).toContain("chat update --description");
    expect(chatTopic).toContain("deprecated alias");
    expect(chatTopic).toContain("a 403 means\nstop, not retry");
    expect(chatTopic).toContain("leave it stable");
    expect(chatTopic).toContain("Markdown is supported");
    expect(chatTopic).toMatch(/`first-tree chat ask <human>`/);
    expect(chatTopic).toContain("chat list");
    expect(chatTopic).toContain("chat history <chat>");
    expect(chatTopic).toContain("GitHub-sourced topics");
    expect(chatTopic).not.toContain("bottom of this briefing");
  });

  it("states the Summary authoring contract instead of a background/plan/progress status report", () => {
    const briefing = buildAgentBriefing(makeOpts());
    const chatTopic = briefing.slice(briefing.indexOf("## Chat Topic & Description"));

    // The description is a current-state brief, not a running status report.
    expect(chatTopic).toMatch(/current-state brief/);
    expect(chatTopic).not.toContain("background + plan + progress");
    expect(chatTopic).not.toContain("status report");

    // Shape: rewritten from blank, standalone first line, bounded length.
    // Wrapped prose, so every phrase assertion tolerates a newline.
    expect(chatTopic).toContain("Rewrite it in place");
    expect(chatTopic).toMatch(/from\s+blank every time \(history is the log\);\s+never append/);
    // The standalone first line is a physical-line rule: the desktop collapsed
    // bar previews `descriptionFirstLine()`. (Mobile's Current state card is
    // separate — short values render in full, long ones clamp to four lines.)
    expect(chatTopic).toMatch(/first line stands\s+alone/);
    expect(chatTopic).toMatch(/on\s+its own physical line/);
    expect(chatTopic).toMatch(/collapsed chat bar previews only it/);
    expect(chatTopic).toMatch(/2–4\s+short sentences/);
    expect(chatTopic).toMatch(/1500 characters is a hard\s+ceiling,\s+not a\s+target/);

    // In-flight / blocked / terminal each keep exactly one thing.
    expect(chatTopic).toMatch(/single most recent next\s+step/);
    expect(chatTopic).toMatch(/what it waits on/);
    expect(chatTopic).toMatch(/at most one deliverable/);

    // Exclusions, including the process metadata that would otherwise churn
    // the conversation list through the real-work activity signal.
    expect(chatTopic).toMatch(/stage-by-stage\s+history/);
    expect(chatTopic).toMatch(/commit SHAs,\s+test counts,\s+reviewers,\s+sub-agents,\s+CI jobs/);

    // Update timing, with the terminal rewrite called out as mandatory.
    expect(chatTopic).toMatch(/enters an external wait/);
    expect(chatTopic).toMatch(/terminal update is mandatory/);
    expect(chatTopic).toMatch(/before sending the closing reply/);
    expect(chatTopic).toMatch(/wording\s+polish,\s+and turns with no substantive change earn no update/);
  });

  it("lists only registered CLI namespaces and tree subcommands", () => {
    const briefing = buildAgentBriefing(makeOpts());
    const overview = briefing.slice(
      briefing.indexOf("## CLI Overview"),
      briefing.indexOf("## Agent Identity & Config"),
    );

    expect(overview).toContain("first-tree chat …");
    expect(overview).toContain("first-tree agent …");
    expect(overview).toContain("first-tree daemon …");
    expect(overview).toContain("first-tree github …");
    expect(overview).toContain("first-tree gitlab …");
    expect(overview).toContain("first-tree tree verify");
    expect(overview).toContain("first-tree tree tree");
    expect(overview).toContain("first-tree tree read");
    expect(overview).toContain("first-tree tree write");
    expect(overview).toContain("first-tree tree review");
    expect(overview).not.toContain("github scan");
    expect(overview).not.toContain("first-tree tree …");

    for (const retired of [
      "status",
      "init",
      "migrate",
      "upgrade",
      "codeowners",
      "claude-hook",
      "inject",
      "automation",
      "skill",
      "publish",
    ]) {
      const re = new RegExp(`\\b(?:first-tree|ft)\\s+tree\\s+${retired}\\b`, "u");
      expect(overview, `CLI Overview must not advertise retired tree ${retired}`).not.toMatch(re);
    }
  });
});

describe("buildAgentBriefing — Context Tree", () => {
  it("keeps read/write triggers, root files, verify, and PR ordering", () => {
    const treePath = "/var/lib/context-trees/example";
    const briefing = buildAgentBriefing(makeOpts({ contextTreePath: treePath }));
    const tree = topLevelSection(briefing, "# Context Tree (First Tree Managed)");

    expect(tree).toContain("## Core Model");
    expect(tree).toContain("decisions,\nconstraints, ownership, and cross-domain relationships");
    expect(tree).toContain("## Context Tree Policy");
    const writeRouting = readCanonicalContextTreeWriteRouting();
    expect(tree).toContain(writeRouting);
    expect(tree.split(writeRouting)).toHaveLength(2);
    expect(writeRouting).toContain("for example, a\nPR/MR, forge Issue");
    expect(writeRouting).toContain("meeting or decision note");
    expect(writeRouting).toContain("commit discussion or\nreview thread");
    expect(writeRouting).not.toContain("source repo change you just completed");
    expect(writeRouting).not.toContain("Audit finding");
    expect(writeRouting).not.toContain("context-tree-audit");
    expect(resolveCanonicalContextTreeWriteRoutingPath()).toBe(
      resolve(dirname(fileURLToPath(import.meta.url)), "..", "runtime", "assets", "context-tree-write-routing.md"),
    );
    expect(tree).toContain("load `first-tree-write`");
    expect(tree).toContain("load `first-tree-read`");
    expect(tree).toContain("Load `context-tree-review` for trusted Context");
    expect(tree).toContain("Reviewer runs and explicit GitHub Context Tree PR or GitLab MR reviews");
    expect(tree).toContain("Load `context-tree-audit` exclusively for");
    expect(tree).toContain("audits");
    expect(tree).toContain("**Normal content**");
    expect(tree).toContain("**Archive/supporting content**");
    expect(tree).toContain("**Member content**");
    expect(tree).toContain("Default to normal content as current truth");

    expect(tree).toContain("repo/path/feature/domain/owner/source signal");
    expect(tree).toContain("code, CLI, review, repo,\npath, bug, and error tasks");
    expect(tree).toContain("GitHub publishes the App verdict");
    expect(tree).toContain("GitLab uses the Reviewer's local");
    expect(tree).toContain("exact-SHA merge and never");
    expect(tree).toContain("uses the GitHub App publisher");
    expect(tree).not.toContain("ordinary GitLab review");
    expect(tree).toContain("first-tree tree tree --help");
    expect(tree).toContain("tree tree` selectors");
    expect(tree).toContain("root `NODE.md`");
    expect(tree).toMatch(/If the root also contains an\s+`AGENTS\.md`, read it too/);
    expect(tree).toContain("the tree wins");

    expect(tree).toContain("concrete source artifact (for example, a");
    expect(tree).toMatch(/standing route makes the required\s+Tree\s+node files part\s+of the task/);
    expect(tree).toMatch(/Implementation-only changes skip the Tree\s+write/);
    expect(tree).toContain("Without a concrete source artifact");
    expect(tree).toContain("first-tree tree verify");
    expect(tree).toContain("create and cross-link both");
    expect(tree).toContain("keep the\nTree change draft");
    expect(tree).toContain("merge source first");
    expect(tree).toContain("merged source truth");
    expect(tree).not.toContain("need not merge first");
    expect(tree).not.toContain("`first-tree-context`");
    expect(tree).not.toContain("`first-tree-sync`");

    expect(tree).toContain(treePath);
  });

  it("treats a missing tree binding as a supported state with a scoped Seed exception", () => {
    const briefing = buildAgentBriefing(makeOpts({ contextTreePath: null }));
    const cli = briefing.slice(briefing.indexOf("## CLI Overview"), briefing.indexOf("## Agent Identity & Config"));
    const tree = topLevelSection(briefing, "# Context Tree (First Tree Managed)");
    expect(cli).toContain("run its `tree init` path directly");
    expect(cli).toContain("do not pre-confirm admin or ask who will bind");
    expect(cli).toContain("only if the command actually fails");
    expect(cli).not.toContain("confirmed org admin");
    expect(tree).toContain("At briefing generation time this agent had no Context Tree bound");
    expect(tree).toContain("a supported\nstate, not a gap to fix");
    expect(tree).toMatch(/Ordinary tasks continue without any prompt to bind or\s+create one/);
    expect(tree).toContain(
      "Re-check the binding only if the user says a tree was created or\nbound during this session",
    );
    expect(tree).toMatch(/[Oo]nly when the current request explicitly needs a\s+Tree read\/write\/audit result/);
    expect(tree).toMatch(/state only that\s+this specific Tree operation cannot be completed because no Tree is bound/);
    expect(tree).toMatch(/without bind\/create guidance and without pointing the user at setup\s+surfaces/);
    expect(tree).not.toContain("operator action");
    expect(tree).not.toContain("web console");
    expect(tree).toContain("build / set up the Context Tree");
    expect(tree).toMatch(/without\s+pre-confirming admin/);
    expect(tree).toContain('asking "who runs the bind?"');
    expect(tree).toMatch(/validates\s+admin\/auth and fails closed/);
    expect(tree).toMatch(/only after an actual\s+command failure/);
    expect(tree).not.toContain("surface that gap");
    expect(tree).not.toContain("surface the missing binding/setup gap");
    expect(tree).not.toContain("confirmed org admin");
    expect(tree).not.toContain("first-tree-onboarding");
  });

  it("projects lockless Local Context playbooks without Git clone or Seed/Reviewer/Audit routes", () => {
    const briefing = buildAgentBriefing(
      makeOpts({
        contextTreePath: `${AGENT_HOME}/local-context`,
        contextSourceKind: "local",
      }),
    );
    const tree = topLevelSection(briefing, "# Context Tree (First Tree Managed)");
    const skills = topLevelSection(briefing, "# Skills (First Tree Managed)");
    expect(tree).toContain("tree local resolve --ensure --intent read");
    expect(tree).toContain("tree local resolve --ensure --intent write");
    expect(tree).toContain("edit the live Tree directly");
    expect(tree).not.toContain("git clone");
    expect(tree).not.toContain("git -C");
    expect(skills).toContain("`first-tree-read`");
    expect(skills).toContain("`first-tree-write`");
    expect(skills).not.toContain("`first-tree-seed`");
    expect(skills).not.toContain("`context-tree-review`");
    expect(skills).not.toContain("`context-tree-audit`");
  });

  it("shell-quotes interpolated tree clone command values", () => {
    const briefing = buildAgentBriefing(
      makeOpts({
        contextTreePath: "/var/lib/context trees/example",
        contextTreeRepoUrl: "https://example.com/release/$VERSION.git",
        contextTreeBranch: "feature with space",
      }),
    );
    const treeLocation = briefing.slice(briefing.indexOf("## Tree Location"));

    expect(treeLocation).toContain(
      "git clone --branch 'feature with space' --single-branch 'https://example.com/release/$VERSION.git' '/var/lib/context trees/example'",
    );
    expect(treeLocation).toContain("rm '/var/lib/context trees/example'");
    expect(treeLocation).toContain("git -C '/var/lib/context trees/example' pull --ff-only");
    expect(treeLocation).toContain("git -C '/var/lib/context trees/example' worktree add");

    const singleQuote = buildAgentBriefing(
      makeOpts({
        contextTreePath: "/tmp/it's-fine",
        contextTreeRepoUrl: "https://example.com/x.git",
        contextTreeBranch: "main",
      }),
    );
    expect(singleQuote.slice(singleQuote.indexOf("## Tree Location"))).toContain("'/tmp/it'\\''s-fine'");
  });
});

describe("buildAgentBriefing — Skills", () => {
  it("lists only shipped First Tree family skills", () => {
    const testFileDir = dirname(fileURLToPath(import.meta.url));
    const repoRoot = resolve(testFileDir, "..", "..", "..", "..");
    const skillsDir = join(repoRoot, "skills");
    const shippedSkills = readdirSync(skillsDir).filter((name) => {
      const skillMd = join(skillsDir, name, "SKILL.md");
      try {
        return statSync(skillMd).isFile();
      } catch {
        return false;
      }
    });

    expect(new Set(shippedSkills)).toEqual(new Set(FIRST_TREE_FAMILY_SKILL_NAMES));

    const skillMap = topLevelSection(
      buildAgentBriefing(makeOpts({ contextTreePath: "/tree" })),
      "# Skills (First Tree Managed)",
    );
    for (const name of shippedSkills) {
      expect(skillMap).toContain(`\`${name}\``);
    }
    expect(skillMap).not.toContain("`first-tree-github-scan`");
    expect(skillMap).not.toContain("`attention`");
    expect(skillMap).not.toContain("`github-scan`");
  });

  it("locks first-tree-file-bug routing scope across every shipped surface", () => {
    // Regression guard for the incident where a generic "file an issue" for
    // work in the user's own/bound repo was misrouted to First Tree's public
    // tracker (agent-team-foundation/first-tree). first-tree-file-bug is
    // deliberately excluded from live skill-evals (UNEVALUATED_SHIPPED_SKILLS
    // in @first-tree/skill-evals), which documents that its trigger boundary is
    // covered by unit/drift tests here instead. Every routing surface the model
    // sees must keep BOTH the positive "First Tree platform defect" scope AND
    // the negative "not the user's own/bound repo" exclusion, so a future
    // broadening of any one surface fails loudly instead of silently restoring
    // the misroute.
    const testFileDir = dirname(fileURLToPath(import.meta.url));
    const skillDir = resolve(testFileDir, "..", "..", "..", "..", "skills", "first-tree-file-bug");

    // Surface 1 — SKILL.md frontmatter description (primary progressive disclosure).
    const descLine = readFileSync(join(skillDir, "SKILL.md"), "utf-8")
      .split("\n")
      .find((line) => line.startsWith("description:"));
    expect(descLine, "SKILL.md must have a frontmatter description").toBeDefined();
    expect(descLine).toMatch(/defect in First Tree itself/i);
    expect(descLine).toMatch(/GitLab integration/i);
    expect(descLine).toMatch(/not for filing an issue into the user's own or bound source repo/i);

    // Surface 2 — Codex metadata (independent routing surface for the codex provider).
    const openaiYaml = readFileSync(join(skillDir, "agents", "openai.yaml"), "utf-8");
    expect(openaiYaml).toMatch(/ONLY for a defect in First Tree itself/i);
    expect(openaiYaml).toMatch(/not for filing an issue into the user's own or bound repo/i);
    expect(openaiYaml).toMatch(/not into the user's repo/i);

    // Surface 3 — both generated family-map rows (tree-bound and tree-less).
    for (const contextTreePath of ["/tree", null]) {
      const row = buildAgentBriefing(makeOpts({ contextTreePath }))
        .split("\n")
        .find((line) => line.startsWith("| `first-tree-file-bug`"));
      expect(row, `file-bug family-map row missing for contextTreePath=${contextTreePath}`).toBeDefined();
      expect(row).toMatch(/bug in First Tree itself/i);
      expect(row).toMatch(/GitHub or GitLab integration/i);
      expect(row).toMatch(/First Tree's own repo \(not the user's own\/bound repo\)/i);
    }
  });

  it("routes GitHub and GitLab tree reviews through provider-aware Context Reviewer semantics", () => {
    for (const contextTreePath of ["/tree", null]) {
      const briefing = buildAgentBriefing(makeOpts({ contextTreePath }));
      const reviewRow = briefing.split("\n").find((line) => line.startsWith("| `context-tree-review`"));
      const seedRow = briefing.split("\n").find((line) => line.startsWith("| `first-tree-seed`"));

      expect(reviewRow, `context-tree-review row missing for contextTreePath=${contextTreePath}`).toBeDefined();
      expect(reviewRow).toContain("GitHub Context Tree PR or GitLab MR");
      expect(reviewRow).toContain("GitHub publishes an App verdict");
      expect(reviewRow).toContain("GitLab uses Reviewer-local notes, repair, push, and exact-SHA merge");
      expect(reviewRow).toContain("without the GitHub publisher");
      expect(reviewRow).not.toContain("ordinary GitLab review");
      expect(seedRow, `first-tree-seed row missing for contextTreePath=${contextTreePath}`).toContain(
        "GitHub or GitLab URL",
      );
    }
  });

  it("nests Team Skills before First Tree Family when resource skills exist", () => {
    const payload = {
      kind: "claude-code" as const,
      model: "",
      prompt: { append: "" },
      mcpServers: [],
      env: [],
      gitRepos: [],
      resourceSkills: [
        {
          resourceId: "res-1",
          name: "internal-playbook",
          description: "Team-internal playbook",
          metadata: {},
          body: "# Playbook",
        },
      ],
      reasoningEffort: "" as const,
    };
    const briefing = buildAgentBriefing(
      makeOpts({
        payload,
        contextTreePath: "/tree",
        teamSkills: [{ name: "internal-playbook", description: "Team-internal playbook" }],
      }),
    );
    const skills = topLevelSection(briefing, "# Skills (First Tree Managed)");

    expect(skills).toContain("## Team Skills");
    expect(skills).toContain("internal-playbook: Team-internal playbook");
    expect(skills).not.toContain("Path:");
    expect(skills).toContain("## First Tree Family");
    expect(skills.indexOf("## Team Skills")).toBeLessThan(skills.indexOf("## First Tree Family"));
  });
});
