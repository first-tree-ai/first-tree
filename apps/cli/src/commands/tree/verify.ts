import { lstatSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

import type { Command } from "commander";

import { channelConfig } from "../../core/channel.js";
import type { CommandContext, SubcommandModule } from "../types.js";
import { readSourceBindingContract, SOURCE_INTEGRATION_FILES } from "./binding-contract.js";
import { TREE_PROGRESS_FILE } from "./binding-state.js";
import type { ContextContentClassCounts } from "./content-class.js";
import { inspectRepoInfraMarkdownFile } from "./content-class.js";
import { collectEvidenceValidationFindings } from "./evidence.js";
import { resolveRepoRoot } from "./shared.js";
import { readTreeIdentityContract } from "./tree-identity.js";
import { collectMemberValidationFindings, formatLegacyMemberError } from "./validate-members.js";
import { collectNodeValidationFindings, formatLegacyNodeError } from "./validate-nodes.js";
import {
  formatValidationFinding,
  type TreeValidationFinding,
  VALIDATION_CODES,
  type ValidationCode,
} from "./validation-finding.js";

const UNCHECKED_RE = /^- \[ \] (.+)$/gmu;

export const VERIFY_USAGE = `usage: ${channelConfig.binName} tree verify [--tree-path PATH] [--evidence]

Run validation checks against a Context Tree repo.

Options:
  --tree-path PATH   Verify a tree repo from another working directory
  --evidence         Also validate evidence records under raw-context/evidence/
  --help             Show this help message`;

type VerifyCheck = {
  errors?: string[];
  ok: boolean;
};

export type VerifySummary = {
  checks: {
    frameworkVersion: VerifyCheck;
    members: VerifyCheck;
    nodes: VerifyCheck;
    progress: VerifyCheck & { uncheckedItems: string[] };
    rootNodeFrontmatter: VerifyCheck;
    treeState: VerifyCheck;
    evidence?: VerifyCheck & { files: number; records: number; warnings: string[] };
  };
  findings: TreeValidationFinding[];
  ok: boolean;
  scannedByContentClass: ContextContentClassCounts;
  targetRoot: string;
};

export type VerifyOptions = {
  evidence?: boolean;
};

function configureVerifyCommand(command: Command): void {
  command.option("--tree-path <path>", "verify a tree repo from another working directory");
  command.option("--evidence", "also validate evidence records under raw-context/evidence/");
}

function readTargetRoot(command: Command): string {
  const options = command.opts() as { treePath?: string };

  if (options.treePath) {
    return resolve(process.cwd(), options.treePath);
  }

  return resolveRepoRoot(process.cwd());
}

function readUncheckedProgressItems(root: string): string[] {
  try {
    const text = readFileSync(join(root, TREE_PROGRESS_FILE), "utf-8");
    return [...text.matchAll(UNCHECKED_RE)].map((match) => match[1]);
  } catch {
    return [];
  }
}

function formatSourceRepoError(targetRoot: string): string {
  const sourceBinding = readSourceBindingContract(targetRoot);
  const treeRepoName = sourceBinding?.treeRepoName;
  const examplePath = treeRepoName ? `../${treeRepoName}` : "../<tree-repo>";
  return `This repo only has source/workspace integration installed. Verify the tree repo instead, for example \`${channelConfig.binName} tree verify --tree-path ${examplePath}\`.`;
}

function deduplicateFindings(findings: TreeValidationFinding[]): TreeValidationFinding[] {
  return findings.filter(
    (finding, index, all) =>
      all.findIndex(
        (candidate) =>
          candidate.code === finding.code && candidate.path === finding.path && candidate.target === finding.target,
      ) === index,
  );
}

const ROOT_METADATA_CODES = new Set<ValidationCode>([
  VALIDATION_CODES.frontmatterMissing,
  VALIDATION_CODES.frontmatterParse,
  VALIDATION_CODES.titleMissing,
  VALIDATION_CODES.titleInvalid,
  VALIDATION_CODES.ownersMissing,
  VALIDATION_CODES.ownersInvalid,
  VALIDATION_CODES.markdownFileSymlinkBroken,
  VALIDATION_CODES.markdownFileSymlinkUnsupported,
  VALIDATION_CODES.markdownFilePathEscape,
]);

function rootNodeExists(path: string): boolean {
  try {
    const entry = lstatSync(path);
    if (entry.isFile()) {
      return true;
    }
    if (!entry.isSymbolicLink()) {
      return false;
    }
    try {
      return !statSync(path).isDirectory();
    } catch {
      return true;
    }
  } catch {
    return false;
  }
}

function formatRootNodeError(finding: TreeValidationFinding): string {
  switch (finding.code) {
    case VALIDATION_CODES.frontmatterMissing:
    case VALIDATION_CODES.frontmatterParse:
      return "Root NODE.md is missing frontmatter.";
    case VALIDATION_CODES.titleMissing:
    case VALIDATION_CODES.titleInvalid:
      return "Root NODE.md is missing a title.";
    case VALIDATION_CODES.ownersMissing:
    case VALIDATION_CODES.ownersInvalid:
      return "Root NODE.md is missing owners.";
    case VALIDATION_CODES.markdownFilePathEscape:
      return "Root NODE.md resolves outside the Context Tree root.";
    case VALIDATION_CODES.markdownFileSymlinkBroken:
      return "Root NODE.md symlink target cannot be resolved.";
    case VALIDATION_CODES.markdownFileSymlinkUnsupported:
      return "Root NODE.md symlink target is not a regular file.";
    default:
      return formatValidationFinding(finding);
  }
}

export function verifyTreeRoot(targetRoot: string, options: VerifyOptions = {}): VerifySummary {
  const invalidManagedPath = SOURCE_INTEGRATION_FILES.some(
    (file) => inspectRepoInfraMarkdownFile(targetRoot, file).kind === "invalid",
  );
  if (
    !invalidManagedPath &&
    readSourceBindingContract(targetRoot) !== undefined &&
    readTreeIdentityContract(targetRoot) === undefined
  ) {
    throw new Error(formatSourceRepoError(targetRoot));
  }

  const progressItems = readUncheckedProgressItems(targetRoot);
  const nodeResult = collectNodeValidationFindings(targetRoot);
  const memberResult = collectMemberValidationFindings(targetRoot);
  const missingRootFinding: TreeValidationFinding[] = rootNodeExists(join(targetRoot, "NODE.md"))
    ? []
    : [
        {
          code: VALIDATION_CODES.frontmatterMissing,
          message: "root NODE.md is missing",
          path: "NODE.md",
        },
      ];
  const nodeFindings = [...missingRootFinding, ...nodeResult.findings];
  const rootFindings = nodeFindings.filter(
    (finding) => finding.path === "NODE.md" && ROOT_METADATA_CODES.has(finding.code),
  );
  const findings = deduplicateFindings([...nodeFindings, ...memberResult.findings]);
  const nodeErrors = nodeFindings.map(formatLegacyNodeError);
  const memberErrors = memberResult.findings.map(formatLegacyMemberError);
  const rootNodeErrors = rootFindings.map(formatRootNodeError);

  // W1 moved workspace/tree identity out of the tree repo and into the
  // workspace-root manifest. A fresh CI checkout of a tree repo is therefore
  // valid without the pre-W1 `.first-tree/VERSION` / `tree.json` files.
  // Keep these rows as compatibility signals for existing parsers, but do not
  // fail validation on metadata that is no longer durable tree content.
  const summary: VerifySummary = {
    checks: {
      frameworkVersion: {
        ok: true,
      },
      members: {
        ok: memberErrors.length === 0,
        ...(memberErrors.length === 0 ? {} : { errors: memberErrors }),
      },
      nodes: {
        ok: nodeErrors.length === 0,
        ...(nodeErrors.length === 0 ? {} : { errors: nodeErrors }),
      },
      progress: {
        ok: progressItems.length === 0,
        ...(progressItems.length === 0
          ? {}
          : { errors: progressItems.map((item) => `Unchecked progress item: ${item}`) }),
        uncheckedItems: progressItems,
      },
      rootNodeFrontmatter: {
        ok: rootNodeErrors.length === 0,
        ...(rootNodeErrors.length === 0 ? {} : { errors: rootNodeErrors }),
      },
      treeState: {
        ok: true,
      },
    },
    findings,
    ok: false,
    scannedByContentClass: nodeResult.scannedByContentClass,
    targetRoot,
  };

  if (options.evidence === true) {
    const evidenceResult = collectEvidenceValidationFindings(targetRoot);
    summary.checks.evidence = {
      ok: evidenceResult.errors.length === 0,
      ...(evidenceResult.errors.length === 0 ? {} : { errors: evidenceResult.errors }),
      files: evidenceResult.files,
      records: evidenceResult.records,
      warnings: evidenceResult.warnings,
    };
    summary.findings = deduplicateFindings([...summary.findings, ...evidenceResult.findings]);
  }

  summary.ok = Object.values(summary.checks).every((check) => check.ok);
  return summary;
}

function printVerifySummary(summary: VerifySummary): void {
  console.log("Context Tree Verification\n");
  console.log(`  Tree root: ${summary.targetRoot}\n`);

  const rows: Array<[string, VerifyCheck]> = [
    ["framework version", summary.checks.frameworkVersion],
    ["tree state", summary.checks.treeState],
    ["root node frontmatter", summary.checks.rootNodeFrontmatter],
    ["node validation", summary.checks.nodes],
    ["member validation", summary.checks.members],
    ["progress checklist", summary.checks.progress],
  ];

  for (const [label, check] of rows) {
    const icon = check.ok ? "PASS" : "FAIL";
    console.log(`  [${icon}] ${label}`);
    for (const error of check.errors ?? []) {
      console.log(`    - ${error}`);
    }
  }

  const evidence = summary.checks.evidence;
  if (evidence !== undefined) {
    const icon = evidence.ok ? "PASS" : "FAIL";
    console.log(`  [${icon}] evidence validation (${evidence.records} records in ${evidence.files} files)`);
    for (const error of evidence.errors ?? []) {
      console.log(`    - ${error}`);
    }
    for (const warning of evidence.warnings) {
      console.log(`    ! ${warning}`);
    }
  }

  if (summary.findings.length > 0) {
    console.log("\n  Findings");
    for (const finding of summary.findings) {
      console.log(`    - ${formatValidationFinding(finding)}`);
    }
  }

  console.log("");
  console.log(summary.ok ? "All checks passed." : "Some checks failed. See above for details.");
}

function runVerifyCommand(context: CommandContext): void {
  try {
    const options = context.command.opts() as { evidence?: boolean };
    const summary = verifyTreeRoot(readTargetRoot(context.command), { evidence: options.evidence === true });

    if (context.options.json) {
      console.log(JSON.stringify(summary, null, 2));
    } else {
      printVerifySummary(summary);
    }

    if (!summary.ok) {
      process.exitCode = 1;
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

export const verifyCommand: SubcommandModule = {
  name: "verify",
  alias: "",
  summary: "",
  description: "Validate a Context Tree repo.",
  action: runVerifyCommand,
  configure: configureVerifyCommand,
};
