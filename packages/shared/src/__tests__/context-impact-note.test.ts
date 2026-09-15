import { describe, expect, it } from "vitest";
import { contextTreeSourceHref } from "../context-source-link.js";
import {
  contextDecisionFromImpactNote,
  parseContextImpactNotes,
  parseExactContextSourceLink,
} from "../schemas/context-impact-note.js";

const COMMIT = "0123456789abcdef0123456789abcdef01234567";
const REPO = "https://github.com/example/context-tree";
const NODE = "system/cloud/team/tenancy-and-identity.md";

function githubSource(nodePath = NODE, label = "Organization isolation"): string {
  return `[${label}](${REPO}/blob/${COMMIT}/${nodePath})`;
}

function englishNote(options: { summary?: string; sources?: string } = {}): string {
  const summary = options.summary ?? "The organization-isolation rule ruled out a global shared index.";
  const sources = options.sources ?? `Context Tree source: ${githubSource()}`;
  return [
    "The per-org index it is.",
    "",
    "> How Context Tree affected this work\\",
    `> **Options narrowed:** ${summary}\\`,
    `> ${sources}`,
  ].join("\n");
}

function chineseNote(): string {
  return [
    "改用 per-org 索引。",
    "",
    "> Context Tree 如何影响本次工作\\",
    "> **收窄可选范围**：组织隔离规则否掉了全局共享索引。\\",
    `> Context Tree 来源：${githubSource()}`,
  ].join("\n");
}

describe("parseExactContextSourceLink", () => {
  it("rebuilds repository, commit, and node path from a GitHub blob URL", () => {
    expect(parseExactContextSourceLink(`${REPO}/blob/${COMMIT}/${NODE}`)).toEqual({
      commit: COMMIT,
      nodePath: NODE,
      repoUrl: REPO,
      repositoryIdentity: "github.com/example/context-tree",
    });
  });

  it("skips GitLab's `-` infix so a subgroup path resolves to the repository", () => {
    const link = parseExactContextSourceLink(
      `https://gitlab.example.com/group/sub/tree/-/blob/${COMMIT}/operations/release/safety-gates.md`,
    );
    expect(link?.repoUrl).toBe("https://gitlab.example.com/group/sub/tree");
    expect(link?.nodePath).toBe("operations/release/safety-gates.md");
  });

  it("decodes percent-encoded path segments", () => {
    const link = parseExactContextSourceLink(`${REPO}/blob/${COMMIT}/domains/pricing%20policy.md`);
    expect(link?.nodePath).toBe("domains/pricing policy.md");
  });

  it("rejects a mutable branch link", () => {
    expect(parseExactContextSourceLink(`${REPO}/blob/main/${NODE}`)).toBeNull();
  });

  it("rejects credential-bearing, query, and fragment URLs", () => {
    expect(parseExactContextSourceLink(`https://user:pw@github.com/example/t/blob/${COMMIT}/a.md`)).toBeNull();
    expect(parseExactContextSourceLink(`${REPO}/blob/${COMMIT}/${NODE}?plain=1`)).toBeNull();
    expect(parseExactContextSourceLink(`${REPO}/blob/${COMMIT}/${NODE}#L4`)).toBeNull();
  });

  it("rejects a non-https transport", () => {
    expect(parseExactContextSourceLink(`http://github.com/example/t/blob/${COMMIT}/a.md`)).toBeNull();
  });

  // `new URL` accepts these; `decodeURIComponent` throws on them. This parser
  // runs inside the synchronous send preflight, so a throw here would be a 500.
  it("returns null instead of throwing on a malformed percent escape", () => {
    for (const bad of ["%E0%A4%A", "%", "%zz", "a%2"]) {
      expect(() => parseExactContextSourceLink(`${REPO}/blob/${COMMIT}/${bad}`)).not.toThrow();
      expect(parseExactContextSourceLink(`${REPO}/blob/${COMMIT}/${bad}`)).toBeNull();
    }
  });
});

// The builder (context-source-link) and this parser are two ends of the same
// contract: a link the builder emits for a connected instance must read back
// as the exact repository, commit, and node path it was built from — on both
// GitLab route generations — and a short SHA must be refused by both ends.
describe("contextTreeSourceHref / parseExactContextSourceLink round trips", () => {
  const GITLAB_ORIGIN = "https://gitlab.example.com";
  const GITLAB_REPO = `${GITLAB_ORIGIN}/group/sub/context-tree`;

  it("round-trips a legacy /blob/ link built for a pre-12.7 GitLab", () => {
    const href = contextTreeSourceHref(
      { repoUrl: GITLAB_REPO, commit: COMMIT, nodePath: "domains/pricing policy/roadmap.md" },
      GITLAB_ORIGIN,
      "11.11.3",
    );
    expect(href).toBe(`${GITLAB_REPO}/blob/${COMMIT}/domains/pricing%20policy/roadmap.md`);
    expect(parseExactContextSourceLink(href ?? "")).toEqual({
      commit: COMMIT,
      nodePath: "domains/pricing policy/roadmap.md",
      repoUrl: GITLAB_REPO,
      repositoryIdentity: "gitlab.example.com/group/sub/context-tree",
    });
  });

  it("round-trips a scoped /-/blob/ link built for a current GitLab", () => {
    const href = contextTreeSourceHref(
      { repoUrl: GITLAB_REPO, commit: COMMIT, nodePath: NODE },
      GITLAB_ORIGIN,
      "17.11.2-ee",
    );
    expect(href).toBe(`${GITLAB_REPO}/-/blob/${COMMIT}/${NODE}`);
    expect(parseExactContextSourceLink(href ?? "")).toEqual({
      commit: COMMIT,
      nodePath: NODE,
      repoUrl: GITLAB_REPO,
      repositoryIdentity: "gitlab.example.com/group/sub/context-tree",
    });
  });

  it("rejects a short SHA at both ends of the contract", () => {
    const short = "83c3939e90b";
    for (const version of ["11.11.3", "17.11.2"]) {
      expect(
        contextTreeSourceHref({ repoUrl: GITLAB_REPO, commit: short, nodePath: NODE }, GITLAB_ORIGIN, version),
      ).toBeNull();
    }
    expect(parseExactContextSourceLink(`${GITLAB_REPO}/blob/${short}/${NODE}`)).toBeNull();
    expect(parseExactContextSourceLink(`${GITLAB_REPO}/-/blob/${short}/${NODE}`)).toBeNull();
  });
});

describe("parseContextImpactNotes", () => {
  it("reads the current English scaffold", () => {
    const [note] = parseContextImpactNotes(englishNote());
    expect(note).toBeDefined();
    expect(note?.language).toBe("en");
    expect(note?.effectLabel).toBe("Options narrowed");
    expect(note?.summary).toBe("The organization-isolation rule ruled out a global shared index.");
    expect(note?.sources).toEqual([{ label: "Organization isolation", url: `${REPO}/blob/${COMMIT}/${NODE}` }]);
    expect(note?.atEnd).toBe(true);
    expect(note?.blankLineBefore).toBe(true);
    expect(note?.logicalLinesOk).toBe(true);
    expect(note?.sourceScaffoldingOk).toBe(true);
    expect(note?.exactLinksOk).toBe(true);
    expect(note?.legacyScaffold).toBe(false);
  });

  it("reads the Chinese scaffold with its full-width colon outside the bold span", () => {
    const [note] = parseContextImpactNotes(chineseNote());
    expect(note?.language).toBe("zh");
    expect(note?.effectLabel).toBe("收窄可选范围");
    expect(note?.summary).toBe("组织隔离规则否掉了全局共享索引。");
    expect(note?.sourceScaffoldingOk).toBe(true);
  });

  it("accepts two sources joined by the fixed separator", () => {
    const sources = `Context Tree sources: ${githubSource()} · ${githubSource("operations/release/safety-gates.md", "Release gates")}`;
    const [note] = parseContextImpactNotes(englishNote({ sources }));
    expect(note?.sources.map((source) => source.label)).toEqual(["Organization isolation", "Release gates"]);
    expect(note?.sourceScaffoldingOk).toBe(true);
  });

  it("flags the singular/plural source label mismatch", () => {
    const sources = `Context Tree source: ${githubSource()} · ${githubSource("a.md", "Second")}`;
    const [note] = parseContextImpactNotes(englishNote({ sources }));
    expect(note?.sources).toHaveLength(2);
    expect(note?.sourceScaffoldingOk).toBe(false);
  });

  it("reports the superseded bold-title scaffold as legacy", () => {
    const body = [
      "> **Context Tree impact · Options narrowed**\\",
      "> **Options narrowed:** The rule ruled out a global shared index.\\",
      `> Context Tree source: ${githubSource()}`,
    ].join("\n");
    const [note] = parseContextImpactNotes(body);
    expect(note?.legacyScaffold).toBe(true);
    expect(note?.effectLabel).toBe("Options narrowed");
  });

  it("ignores ordinary prose that merely quotes the tree", () => {
    const body = ["> The tenancy node says organizations stay isolated.", "", "So we keep per-org indexes."].join("\n");
    expect(parseContextImpactNotes(body)).toEqual([]);
  });

  it("reports a note that is not last as not at the end", () => {
    const [note] = parseContextImpactNotes(`${englishNote()}\n\nOne more thing.`);
    expect(note?.atEnd).toBe(false);
  });

  it("reports a fourth blockquote line as a logical-line failure", () => {
    const [note] = parseContextImpactNotes(`${englishNote()}\n> Extra commentary.`);
    expect(note?.logicalLinesOk).toBe(false);
  });

  it("finds every note when an agent wrote more than one", () => {
    expect(parseContextImpactNotes(`${englishNote()}\n\n${englishNote()}`)).toHaveLength(2);
  });
});

// A note the eval rejects must never be one the Server persists — that
// divergence is exactly what one shared parser exists to remove.
describe("contextDecisionFromImpactNote strictness", () => {
  it("refuses the superseded bold-title scaffold", () => {
    const body = [
      "Answer.",
      "",
      "> **Context Tree impact · Options narrowed**\\",
      "> **Options narrowed:** The rule ruled out a global shared index.\\",
      `> Context Tree source: ${githubSource()}`,
    ].join("\n");
    const [note] = parseContextImpactNotes(body);
    expect(note?.legacyScaffold).toBe(true);
    expect(note && contextDecisionFromImpactNote(note)).toBeNull();
  });

  it("refuses a note that is not the last thing in the body", () => {
    const [note] = parseContextImpactNotes(`${englishNote()}\n\nOne more thing.`);
    expect(note && contextDecisionFromImpactNote(note)).toBeNull();
  });

  it("refuses a note with no blank line before it", () => {
    const body = [
      "> How Context Tree affected this work\\",
      "> **Options narrowed:** The rule ruled out a global shared index.\\",
      `> Context Tree source: ${githubSource()}`,
    ].join("\n");
    const [note] = parseContextImpactNotes(body);
    expect(note && contextDecisionFromImpactNote(note)).toBeNull();
  });

  it("refuses a fourth blockquote line", () => {
    const [note] = parseContextImpactNotes(`${englishNote()}\n> Extra commentary.`);
    expect(note && contextDecisionFromImpactNote(note)).toBeNull();
  });

  it("refuses a source line whose fixed scaffolding is wrong", () => {
    const sources = `Context Tree source: ${githubSource()} · ${githubSource("a.md", "Second")}`;
    const [note] = parseContextImpactNotes(englishNote({ sources }));
    expect(note?.sourceScaffoldingOk).toBe(false);
    expect(note && contextDecisionFromImpactNote(note)).toBeNull();
  });
});

describe("contextDecisionFromImpactNote", () => {
  it("derives the receipt an English note reports", () => {
    const [note] = parseContextImpactNotes(englishNote());
    expect(note && contextDecisionFromImpactNote(note)).toEqual({
      version: 1,
      effect: "constrained",
      summary: "The organization-isolation rule ruled out a global shared index.",
      evidence: [{ repoUrl: REPO, commit: COMMIT, nodePath: NODE, heading: "Organization isolation" }],
    });
  });

  it("maps every Chinese label to the same enum as its English twin", () => {
    const [note] = parseContextImpactNotes(chineseNote());
    expect(note && contextDecisionFromImpactNote(note)?.effect).toBe("constrained");
  });

  it("refuses a note whose effect label is not one of the four", () => {
    const body = englishNote().replace("**Options narrowed:**", "**Mostly helpful:**");
    const [note] = parseContextImpactNotes(body);
    expect(note && contextDecisionFromImpactNote(note)).toBeNull();
  });

  it("refuses the whole note when any source is not an exact-commit link", () => {
    const sources = `Context Tree sources: ${githubSource()} · [Branch](${REPO}/blob/main/a.md)`;
    const [note] = parseContextImpactNotes(englishNote({ sources }));
    expect(note && contextDecisionFromImpactNote(note)).toBeNull();
  });

  it("collapses the same node cited twice into one evidence row", () => {
    const sources = `Context Tree sources: ${githubSource()} · ${githubSource(NODE, "Same node again")}`;
    const [note] = parseContextImpactNotes(englishNote({ sources }));
    expect(note && contextDecisionFromImpactNote(note)?.evidence).toHaveLength(1);
  });

  it("drops an over-long link label but keeps the citation", () => {
    const [note] = parseContextImpactNotes(
      englishNote({ sources: `Context Tree source: ${githubSource(NODE, "x".repeat(201))}` }),
    );
    const decision = note && contextDecisionFromImpactNote(note);
    expect(decision?.evidence[0]?.heading).toBeUndefined();
    expect(decision?.evidence[0]?.nodePath).toBe(NODE);
  });

  it("refuses a summary longer than the receipt contract allows", () => {
    const [note] = parseContextImpactNotes(englishNote({ summary: "x".repeat(401) }));
    expect(note && contextDecisionFromImpactNote(note)).toBeNull();
  });
});
