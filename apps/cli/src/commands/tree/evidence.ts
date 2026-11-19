import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { z } from "zod";

import { formatValidationFinding, type TreeValidationFinding, VALIDATION_CODES } from "./validation-finding.js";

export const EVIDENCE_RELATIVE_DIR = "raw-context/evidence";
export const EVIDENCE_SOURCES_FILE = "sources.json";

// Warn-only staleness threshold. Per-domain tightening (warn -> fail against
// the domain review cycle) is a follow-up once the stale-anchor report has a
// baseline; integrity failures below always fail closed.
const EVIDENCE_STALE_DAYS = 90;

export const EVIDENCE_KINDS = ["decision", "constraint", "default", "branch", "failure", "metric", "contract"] as const;

const evidenceSourceSchema = z.object({
  repo: z.string().min(1),
  path: z.string().min(1),
  line: z.number().int().positive().optional(),
  quote: z.string().optional(),
});

export const evidenceRecordSchema = z.object({
  id: z.string().min(1),
  node: z.string().min(1),
  kind: z.enum(EVIDENCE_KINDS),
  claim: z.string().min(1),
  sources: z.array(evidenceSourceSchema).min(1),
  validAt: z.string().regex(/^\d{4}-\d{2}-\d{2}$/u),
  confidence: z.enum(["verified", "unverified"]),
  supersedes: z.array(z.string()).default([]),
  contradicts: z.array(z.string()).default([]),
  dependsOn: z.array(z.string()).default([]),
});

export type EvidenceRecord = z.infer<typeof evidenceRecordSchema>;

export type EvidenceValidationResult = {
  errors: string[];
  files: number;
  findings: TreeValidationFinding[];
  records: number;
  warnings: string[];
};

const evidenceSourcesSchema = z.record(
  z.string(),
  z.union([
    z.string().min(1),
    z.object({ path: z.string().min(1) }).strict(),
    z.object({ url: z.string().min(1) }).strict(),
  ]),
);

type EvidenceSources = z.infer<typeof evidenceSourcesSchema>;

type IndexedRecord = {
  location: string;
  record: EvidenceRecord;
};

function readEvidenceSources(targetRoot: string, findings: TreeValidationFinding[]): EvidenceSources | undefined {
  const relativePath = `${EVIDENCE_RELATIVE_DIR}/${EVIDENCE_SOURCES_FILE}`;
  const absolutePath = join(targetRoot, EVIDENCE_RELATIVE_DIR, EVIDENCE_SOURCES_FILE);

  if (!existsSync(absolutePath)) {
    return undefined;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(absolutePath, "utf-8"));
  } catch {
    findings.push({
      code: VALIDATION_CODES.evidenceSourcesInvalid,
      message: "sources.json is not valid JSON",
      path: relativePath,
    });
    return undefined;
  }

  const result = evidenceSourcesSchema.safeParse(parsed);
  if (!result.success) {
    findings.push({
      code: VALIDATION_CODES.evidenceSourcesInvalid,
      message: `sources.json has an invalid shape: ${result.error.issues[0]?.message ?? "unknown"}`,
      path: relativePath,
    });
    return undefined;
  }

  return result.data;
}

function collectEvidenceFiles(evidenceDir: string): string[] {
  const files: string[] = [];

  function walk(directory: string): void {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((left, right) =>
      left.name.localeCompare(right.name),
    )) {
      const absolutePath = join(directory, entry.name);
      if (entry.isDirectory()) {
        walk(absolutePath);
        continue;
      }
      if (entry.isFile() && entry.name.endsWith(".jsonl")) {
        files.push(absolutePath);
      }
    }
  }

  walk(evidenceDir);
  return files;
}

function treeFileExists(targetRoot: string, relativePath: string): boolean {
  try {
    return statSync(join(targetRoot, relativePath)).isFile();
  } catch {
    return false;
  }
}

function daysSince(dateText: string, now: number): number {
  const time = Date.parse(`${dateText}T00:00:00.000Z`);
  if (Number.isNaN(time)) {
    return 0;
  }
  return Math.floor((now - time) / 86_400_000);
}

export function collectEvidenceValidationFindings(targetRoot: string): EvidenceValidationResult {
  const findings: TreeValidationFinding[] = [];
  const warnings: string[] = [];
  const evidenceDir = join(targetRoot, EVIDENCE_RELATIVE_DIR);

  if (!existsSync(evidenceDir)) {
    return { errors: [], files: 0, findings, records: 0, warnings };
  }

  const sources = readEvidenceSources(targetRoot, findings);

  const files = collectEvidenceFiles(evidenceDir);
  const indexed: IndexedRecord[] = [];
  const locationsById = new Map<string, string>();
  const contradictionPairs = new Map<string, string>();
  let records = 0;
  const now = Date.now();

  for (const absolutePath of files) {
    const relativePath = absolutePath.slice(targetRoot.length + 1).replace(/\\/gu, "/");
    const lines = readFileSync(absolutePath, "utf-8").split("\n");

    for (const [index, line] of lines.entries()) {
      const text = line.trim();
      if (text.length === 0) {
        continue;
      }
      records += 1;
      const location = `${relativePath}:${index + 1}`;

      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        findings.push({
          code: VALIDATION_CODES.evidenceFileParse,
          message: "evidence line is not valid JSON",
          path: location,
        });
        continue;
      }

      const result = evidenceRecordSchema.safeParse(parsed);
      if (!result.success) {
        findings.push({
          code: VALIDATION_CODES.evidenceRecordInvalid,
          message: `evidence record is invalid: ${result.error.issues[0]?.message ?? "unknown"}`,
          path: location,
        });
        continue;
      }

      const record = result.data;
      indexed.push({ location, record });

      const existing = locationsById.get(record.id);
      if (existing !== undefined) {
        findings.push({
          code: VALIDATION_CODES.evidenceDuplicateId,
          message: `duplicate evidence id also used at ${existing}`,
          path: location,
          target: record.id,
        });
      } else {
        locationsById.set(record.id, location);
      }

      const hasVerifiableQuote = record.sources.some(
        (source) => source.line !== undefined && (source.quote ?? "").length > 0,
      );
      if (record.confidence === "verified" && !hasVerifiableQuote) {
        findings.push({
          code: VALIDATION_CODES.evidenceQuoteMissing,
          message: "verified evidence requires at least one source with a line and a verbatim quote",
          path: location,
          target: record.id,
        });
      }

      if (!treeFileExists(targetRoot, record.node)) {
        findings.push({
          code: VALIDATION_CODES.evidenceNodeMissing,
          message: `evidence node does not exist in the tree: ${record.node}`,
          path: location,
          target: record.id,
        });
      }

      if (sources !== undefined) {
        for (const source of record.sources) {
          if (sources[source.repo] === undefined) {
            warnings.push(`${location}: source repo is not declared in ${EVIDENCE_SOURCES_FILE}: ${source.repo}`);
          }
        }
      }

      for (const target of record.contradicts) {
        const pair = [record.id, target].sort().join(" <> ");
        contradictionPairs.set(pair, location);
      }

      if (daysSince(record.validAt, now) > EVIDENCE_STALE_DAYS) {
        warnings.push(`${location}: validAt ${record.validAt} is older than ${EVIDENCE_STALE_DAYS} days`);
      }
    }
  }

  if (sources === undefined && records > 0) {
    warnings.push(`${EVIDENCE_RELATIVE_DIR}/${EVIDENCE_SOURCES_FILE} not found; source repo anchors are not resolved`);
  }

  // Referential checks need every record indexed first.
  for (const { location, record } of indexed) {
    for (const target of [...record.supersedes, ...record.contradicts, ...record.dependsOn]) {
      if (!locationsById.has(target)) {
        findings.push({
          code: VALIDATION_CODES.evidenceDanglingReference,
          message: `evidence reference does not match any claim id: ${target}`,
          path: location,
          target: record.id,
        });
      }
    }
  }

  // Unresolved contradictions fail closed: a pair is only cleared by a human
  // resolving source truth and removing the edge.
  for (const [pair, location] of contradictionPairs) {
    findings.push({
      code: VALIDATION_CODES.evidenceContradiction,
      message: `unresolved contradiction between claims: ${pair}`,
      path: location,
    });
  }

  const errors = findings.map(formatValidationFinding);
  return { errors, files: files.length, findings, records, warnings };
}
