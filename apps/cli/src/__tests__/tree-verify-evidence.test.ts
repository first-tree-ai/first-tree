import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";
import { EVIDENCE_RELATIVE_DIR } from "../commands/tree/evidence.js";
import { verifyTreeRoot } from "../commands/tree/verify.js";

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "ft-tree-evidence-"));
  tempDirs.push(dir);
  return dir;
}

function write(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

function node(title: string): string {
  return `---\ntitle: ${title}\nowners: [alice]\n---\n# ${title}\n`;
}

function makeValidTree(): string {
  const root = makeTempDir();
  write(join(root, "NODE.md"), node("Root"));
  write(join(root, "system", "NODE.md"), node("System"));
  write(join(root, "system", "log-police.md"), node("Log Police"));
  write(join(root, "members", "NODE.md"), node("Members"));
  write(
    join(root, "members", "alice", "NODE.md"),
    "---\ntitle: Alice\nowners: [alice]\ntype: human\nrole: Engineer\ndomains: [system]\n---\n# Alice\n",
  );
  return root;
}

function evidenceRecord(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "system/log-police/local-lock-reset",
    node: "system/log-police.md",
    kind: "failure",
    claim: "When the local lock cannot be acquired, the counter is reset to 0.",
    sources: [{ repo: "repo-a", path: "src/Lock.java", line: 33, quote: "counter.set(0);" }],
    validAt: new Date().toISOString().slice(0, 10),
    confidence: "verified",
    supersedes: [],
    contradicts: [],
    dependsOn: [],
    ...overrides,
  };
}

function writeEvidence(
  root: string,
  records: Array<Record<string, unknown>>,
  file = "system/log-police.jsonl",
): string {
  const relativePath = join(EVIDENCE_RELATIVE_DIR, file);
  write(join(root, relativePath), `${records.map((record) => JSON.stringify(record)).join("\n")}\n`);
  return relativePath.replace(/\\/gu, "/");
}

afterEach(() => {
  vi.restoreAllMocks();
  process.exitCode = undefined;
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

describe("tree verify --evidence", () => {
  it("skips evidence validation by default even when evidence is broken", () => {
    const root = makeValidTree();
    writeEvidence(root, [evidenceRecord({ id: "" })]);

    const summary = verifyTreeRoot(root);

    expect(summary.checks.evidence).toBeUndefined();
    expect(summary.ok).toBe(true);
  });

  it("passes an empty evidence tree unchanged", () => {
    const root = makeValidTree();
    mkdirSync(join(root, EVIDENCE_RELATIVE_DIR), { recursive: true });

    const summary = verifyTreeRoot(root, { evidence: true });

    expect(summary.checks.evidence).toMatchObject({ ok: true, files: 0, records: 0, warnings: [] });
    expect(summary.ok).toBe(true);
  });

  it("accepts valid verified records", () => {
    const root = makeValidTree();
    writeEvidence(root, [evidenceRecord()]);
    write(join(root, EVIDENCE_RELATIVE_DIR, "sources.json"), JSON.stringify({ "repo-a": { path: "../repo-a" } }));

    const summary = verifyTreeRoot(root, { evidence: true });

    expect(summary.checks.evidence).toMatchObject({ ok: true, files: 1, records: 1, warnings: [] });
    expect(summary.ok).toBe(true);
  });

  it("fails a verified record without a line-and-quote source", () => {
    const root = makeValidTree();
    writeEvidence(root, [evidenceRecord({ sources: [{ repo: "repo-a", path: "src/Lock.java" }] })]);

    const findings = verifyTreeRoot(root, { evidence: true }).findings;

    expect(findings).toContainEqual(
      expect.objectContaining({ code: "TREE_EVIDENCE_QUOTE_MISSING", target: "system/log-police/local-lock-reset" }),
    );
  });

  it("fails records outside the closed kind set", () => {
    const root = makeValidTree();
    writeEvidence(root, [evidenceRecord({ kind: "runbook" })]);

    const findings = verifyTreeRoot(root, { evidence: true }).findings;

    expect(findings).toContainEqual(expect.objectContaining({ code: "TREE_EVIDENCE_RECORD_INVALID" }));
  });

  it("fails invalid JSON lines", () => {
    const root = makeValidTree();
    write(join(root, EVIDENCE_RELATIVE_DIR, "broken.jsonl"), "{not json}\n");

    const findings = verifyTreeRoot(root, { evidence: true }).findings;

    expect(findings).toContainEqual(
      expect.objectContaining({ code: "TREE_EVIDENCE_FILE_PARSE", path: "raw-context/evidence/broken.jsonl:1" }),
    );
  });

  it("fails duplicate claim ids across files", () => {
    const root = makeValidTree();
    writeEvidence(root, [evidenceRecord()], "a/log-police.jsonl");
    writeEvidence(root, [evidenceRecord()], "b/log-police.jsonl");

    const findings = verifyTreeRoot(root, { evidence: true }).findings;

    expect(findings).toContainEqual(
      expect.objectContaining({ code: "TREE_EVIDENCE_DUPLICATE_ID", target: "system/log-police/local-lock-reset" }),
    );
  });

  it("fails evidence anchored to a missing node", () => {
    const root = makeValidTree();
    writeEvidence(root, [evidenceRecord({ node: "system/missing.md" })]);

    const findings = verifyTreeRoot(root, { evidence: true }).findings;

    expect(findings).toContainEqual(
      expect.objectContaining({ code: "TREE_EVIDENCE_NODE_MISSING", target: "system/log-police/local-lock-reset" }),
    );
  });

  it("fails dangling supersedes, contradicts, and dependsOn references", () => {
    const root = makeValidTree();
    writeEvidence(root, [evidenceRecord({ dependsOn: ["system/log-police/never-written"] })]);

    const findings = verifyTreeRoot(root, { evidence: true }).findings;

    expect(findings).toContainEqual(
      expect.objectContaining({
        code: "TREE_EVIDENCE_DANGLING_REFERENCE",
        message: "evidence reference does not match any claim id: system/log-police/never-written",
      }),
    );
  });

  it("fails unresolved contradiction pairs once, even when declared from both sides", () => {
    const root = makeValidTree();
    writeEvidence(root, [
      evidenceRecord({ id: "system/log-police/a", contradicts: ["system/log-police/b"] }),
      evidenceRecord({ id: "system/log-police/b", contradicts: ["system/log-police/a"] }),
    ]);

    const findings = verifyTreeRoot(root, { evidence: true }).findings;

    expect(findings.filter((finding) => finding.code === "TREE_EVIDENCE_CONTRADICTION")).toHaveLength(1);
  });

  it("warns on stale validAt but still passes", () => {
    const root = makeValidTree();
    writeEvidence(root, [evidenceRecord({ validAt: "2020-01-01" })]);

    const summary = verifyTreeRoot(root, { evidence: true });

    expect(summary.checks.evidence?.ok).toBe(true);
    expect(summary.checks.evidence?.warnings.some((warning) => warning.includes("older than 90 days"))).toBe(true);
  });

  it("warns when sources.json is missing and when a repo is undeclared", () => {
    const root = makeValidTree();
    writeEvidence(root, [evidenceRecord()]);

    const withoutSources = verifyTreeRoot(root, { evidence: true });
    expect(withoutSources.checks.evidence?.ok).toBe(true);
    expect(withoutSources.checks.evidence?.warnings.some((warning) => warning.includes("sources.json not found"))).toBe(
      true,
    );

    write(join(root, EVIDENCE_RELATIVE_DIR, "sources.json"), JSON.stringify({ "repo-b": { path: "../repo-b" } }));
    const withSources = verifyTreeRoot(root, { evidence: true });
    expect(withSources.checks.evidence?.warnings.some((warning) => warning.includes("repo-a"))).toBe(true);
  });

  it("passes silently for undeclared repos once sources.json covers them", () => {
    const root = makeValidTree();
    writeEvidence(root, [evidenceRecord()]);
    write(join(root, EVIDENCE_RELATIVE_DIR, "sources.json"), JSON.stringify({ "repo-a": { path: "../repo-a" } }));

    const summary = verifyTreeRoot(root, { evidence: true });

    expect(summary.checks.evidence).toMatchObject({ ok: true, warnings: [] });
  });

  it("fails malformed sources.json", () => {
    const root = makeValidTree();
    writeEvidence(root, [evidenceRecord()]);
    write(join(root, EVIDENCE_RELATIVE_DIR, "sources.json"), "[]");

    const findings = verifyTreeRoot(root, { evidence: true }).findings;

    expect(findings).toContainEqual(
      expect.objectContaining({ code: "TREE_EVIDENCE_SOURCES_INVALID", path: "raw-context/evidence/sources.json" }),
    );
  });
});
