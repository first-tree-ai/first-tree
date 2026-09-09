import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import type {
  AgentHandler,
  AgentIdentity,
  DeliveryToken,
  HandlerConfig,
  HandlerFactory,
  HandlerResumeOptions,
  HandlerShutdownOptions,
  LoginOutcome,
  ProviderContinuation,
  ReplayFenceEntry,
  ReplayFenceWriter,
  SessionContext,
  SessionMessage,
  TurnConsumedErrorReason,
  TurnOutcome,
} from "../runtime/contracts.js";
import * as contracts from "../runtime/contracts.js";
import * as handler from "../runtime/handler.js";

const clientSrc = join(dirname(fileURLToPath(import.meta.url)), "..");

/** Explicit allowlist mirrored from runtime/contracts.ts — keep in sync. */
const CONTRACT_TYPE_EXPORTS = [
  "AgentHandler",
  "AgentIdentity",
  "DeliveryToken",
  "HandlerConfig",
  "HandlerFactory",
  "HandlerResumeOptions",
  "HandlerShutdownOptions",
  "SessionContext",
  "SessionMessage",
  "TurnConsumedErrorReason",
  "TurnOutcome",
  "LoginOutcome",
  "ProviderContinuation",
  "ReplayFenceEntry",
  "ReplayFenceWriter",
] as const;

const CONTRACT_VALUE_EXPORTS = [
  "isTeamSkillCommandUnavailableError",
  "noopDeliveryToken",
  "requireDeliveryToken",
] as const;

const FORBIDDEN_CONTRACT_EXPORTS = [
  "SessionRuntime",
  "SessionManager",
  "SessionRegistry",
  "AgentSlot",
  "AgentRuntime",
  "ReplayFenceStore",
  "ReplayFenceError",
  "HANDLER_REGISTRY",
  "createBuiltinHandlerRegistry",
] as const;

type ParsedContractsExports = {
  typeNames: string[];
  valueNames: string[];
  /** Any export form outside the two allowlisted shapes. */
  violations: string[];
};

/**
 * Enumerate every top-level export via the TypeScript AST.
 *
 * Allowed shapes only:
 * - `export type { A, B } from "..."`  → type allowlist (unaliased names only)
 * - `export { a, b } from "..."` with no inline `type` modifiers → value allowlist
 *   (unaliased names only)
 *
 * Anything else (`export { type X }`, `Foo as Bar`, `export interface`,
 * `export type Alias =`, `export *`, `export default`, exported
 * classes/functions/vars, …) is a violation.
 */
function parseContractsExports(source: string): ParsedContractsExports {
  const sf = ts.createSourceFile("contracts.ts", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const typeNames: string[] = [];
  const valueNames: string[] = [];
  const violations: string[] = [];

  const rejectIfAliased = (el: ts.ExportSpecifier, kind: "type" | "value"): boolean => {
    // `export { Orig as Alias }` sets propertyName=Orig, name=Alias.
    if (el.propertyName != null && el.propertyName.text !== el.name.text) {
      violations.push(`aliased-${kind}-export:${el.propertyName.text}->${el.name.text}`);
      return true;
    }
    return false;
  };

  for (const stmt of sf.statements) {
    if (!ts.isExportDeclaration(stmt)) {
      if (
        (ts.isTypeAliasDeclaration(stmt) ||
          ts.isInterfaceDeclaration(stmt) ||
          ts.isEnumDeclaration(stmt) ||
          ts.isClassDeclaration(stmt) ||
          ts.isFunctionDeclaration(stmt) ||
          ts.isModuleDeclaration(stmt) ||
          ts.isVariableStatement(stmt)) &&
        stmt.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)
      ) {
        violations.push(`exported-declaration:${ts.SyntaxKind[stmt.kind]}`);
      } else if (ts.isExportAssignment(stmt)) {
        violations.push("export-assignment");
      } else {
        // Non-export statements are unexpected in this file (imports, bare decls, …).
        violations.push(`non-export-statement:${ts.SyntaxKind[stmt.kind]}`);
      }
      continue;
    }

    if (stmt.exportClause == null) {
      violations.push(stmt.moduleSpecifier ? "export-star" : "export-declaration-empty");
      continue;
    }
    if (!ts.isNamedExports(stmt.exportClause)) {
      violations.push("export-namespace");
      continue;
    }
    if (stmt.moduleSpecifier == null) {
      violations.push("local-named-export");
      continue;
    }

    if (stmt.isTypeOnly) {
      // Exact allowlisted shape: `export type { Name } from "..."` (no `as` rename).
      for (const el of stmt.exportClause.elements) {
        if (el.isTypeOnly) {
          violations.push(`redundant-inline-type-in-type-only-export:${el.name.text}`);
        }
        if (rejectIfAliased(el, "type")) continue;
        typeNames.push(el.name.text);
      }
      continue;
    }

    // `export { ... } from "..."` — must be values only (no `export { type X }`, no aliases).
    for (const el of stmt.exportClause.elements) {
      if (el.isTypeOnly) {
        violations.push(`inline-type-named-export:${el.name.text}`);
        continue;
      }
      if (rejectIfAliased(el, "value")) continue;
      valueNames.push(el.name.text);
    }
  }

  return {
    typeNames: typeNames.sort(),
    valueNames: valueNames.sort(),
    violations: violations.sort(),
  };
}

describe("runtime/contracts entry", () => {
  it("re-exports delivery token helpers with owner value identity", () => {
    expect(contracts.noopDeliveryToken).toBe(handler.noopDeliveryToken);
    expect(contracts.requireDeliveryToken).toBe(handler.requireDeliveryToken);
    const token = contracts.noopDeliveryToken();
    expect(typeof token.complete).toBe("function");
    expect(() => contracts.requireDeliveryToken(undefined, "contracts-test")).toThrow(/contracts-test/);
  });

  it("exposes only the allowlisted runtime bindings", () => {
    const valueKeys = Object.keys(contracts).sort();
    expect(valueKeys).toEqual([...CONTRACT_VALUE_EXPORTS].sort());

    for (const name of FORBIDDEN_CONTRACT_EXPORTS) {
      expect(contracts, `contracts must not export ${name}`).not.toHaveProperty(name);
    }

    const source = readFileSync(join(clientSrc, "runtime/contracts.ts"), "utf8");
    const parsed = parseContractsExports(source);

    // Catch-all: no other export morphologies beyond the two allowlisted shapes.
    expect(parsed.violations, `unexpected export forms: ${parsed.violations.join(", ")}`).toEqual([]);
    expect(parsed.typeNames).toEqual([...CONTRACT_TYPE_EXPORTS].sort());
    expect(parsed.valueNames).toEqual([...CONTRACT_VALUE_EXPORTS].sort());

    for (const name of FORBIDDEN_CONTRACT_EXPORTS) {
      expect(source).not.toMatch(new RegExp(`\\b${name}\\b`));
    }
  });

  it("rejects inline type re-exports and other declaration exports via AST catch-all", () => {
    const bypassInlineType = `
export type { AgentHandler } from "./handler.js";
export { type HandlerContext } from "./handler.js";
export { noopDeliveryToken, requireDeliveryToken } from "./handler.js";
`;
    const inline = parseContractsExports(bypassInlineType);
    expect(inline.violations.some((v) => v.startsWith("inline-type-named-export:"))).toBe(true);

    const bypassInterface = `
export type { AgentHandler } from "./handler.js";
export interface Extra {}
export { noopDeliveryToken, requireDeliveryToken } from "./handler.js";
`;
    const iface = parseContractsExports(bypassInterface);
    expect(iface.violations).toContain("exported-declaration:InterfaceDeclaration");

    const bypassTypeAlias = `
export type { AgentHandler } from "./handler.js";
export type Extra = string;
export { noopDeliveryToken, requireDeliveryToken } from "./handler.js";
`;
    const alias = parseContractsExports(bypassTypeAlias);
    expect(alias.violations).toContain("exported-declaration:TypeAliasDeclaration");

    const bypassStar = `
export type { AgentHandler } from "./handler.js";
export * from "./handler.js";
`;
    const star = parseContractsExports(bypassStar);
    expect(star.violations).toContain("export-star");

    // Aliased type re-export must not satisfy the allowlist via the exported name alone.
    const bypassAliasedType = `
export type { HandlerContext as AgentHandler } from "./handler.js";
export { noopDeliveryToken, requireDeliveryToken } from "./handler.js";
`;
    const aliasedType = parseContractsExports(bypassAliasedType);
    expect(aliasedType.violations).toContain("aliased-type-export:HandlerContext->AgentHandler");
    expect(aliasedType.typeNames).not.toContain("AgentHandler");

    const bypassAliasedValue = `
export type { AgentHandler } from "./handler.js";
export { noopDeliveryToken as requireDeliveryToken } from "./handler.js";
`;
    const aliasedValue = parseContractsExports(bypassAliasedValue);
    expect(aliasedValue.violations).toContain("aliased-value-export:noopDeliveryToken->requireDeliveryToken");
  });

  it("compiles the allowlisted type surface for provider consumers", () => {
    type _Occupancy =
      | AgentHandler
      | AgentIdentity
      | DeliveryToken
      | HandlerConfig
      | HandlerFactory
      | HandlerResumeOptions
      | HandlerShutdownOptions
      | SessionContext
      | SessionMessage
      | TurnConsumedErrorReason
      | TurnOutcome
      | LoginOutcome
      | ProviderContinuation
      | ReplayFenceEntry
      | ReplayFenceWriter
      | undefined;
    const occupied: _Occupancy[] = [undefined];
    expect(occupied).toHaveLength(1);
  });
});
