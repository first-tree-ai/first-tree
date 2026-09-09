import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, normalize, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { RUNTIME_PROVIDER_IDS, runtimeAuthProviderSchema } from "@first-tree/shared";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { extractModuleReferences } from "./module-reference-extract.js";
import {
  PROVIDER_SUPPORT_EXPORT_ALLOWLISTS,
  TRANSITIONAL_PROVIDER_FAMILY_FILES,
} from "./provider-support-export-allowlists.js";

const here = dirname(fileURLToPath(import.meta.url));
const clientSrc = join(here, "..");
const repoRoot = join(clientSrc, "..", "..", "..");

/** Quote tokens derived from the Zod ID set — auto-expands when a provider is added. */
const PROVIDER_LITERAL_TOKENS: readonly string[] = RUNTIME_PROVIDER_IDS.flatMap((id) => [`"${id}"`, `'${id}'`]);

/**
 * The narrower in-product auth set, derived from its own schema so that
 * extending `runtimeAuthProviderSchema` widens this guard in the same commit
 * that widens the driver registry. The full-provider tokens above still apply
 * to the daemon dispatcher; this set pins the enum the dispatcher keys on.
 */
const AUTH_PROVIDER_LITERAL_TOKENS: readonly string[] = runtimeAuthProviderSchema.options.flatMap((id) => [
  `"${id}"`,
  `'${id}'`,
  `\`${id}\``,
]);

const THIRD_PARTY_SDK_IMPORTS = [
  "@anthropic-ai/claude-agent-sdk",
  "@openai/codex-sdk",
  "@botiverse/kimi-code-sdk",
  "@agentclientprotocol/sdk",
] as const;

/** Unique composition roots allowed to name concrete providers / import adapters. */
const COMPOSITION_ALLOWLIST = new Set([
  "providers/auth-drivers.ts",
  "providers/builtin-registry.ts",
  "providers/builtin-probes.ts",
  "providers/skill-roots.ts",
]);

/** Generic modules that must stay provider-neutral after this foundation PR. */
const GUARDED_CLIENT_FILES = [
  "providers/capabilities/index.ts",
  "runtime/managed-skills.ts",
  "runtime/runtime.ts",
  "runtime/handler.ts",
  "runtime/runtime-notice.ts",
  "runtime/session-runtime.ts",
  "runtime/error-taxonomy.ts",
  "providers/handlers/auth-error-hint.ts",
] as const;

/** Lexical normalize of a relative module specifier to a Client `src` POSIX path (`.js`). */
function normalizeClientSrcRelativeTarget(fromFileAbs: string, specifier: string): string | null {
  if (!specifier.startsWith(".")) return null;
  const abs = normalize(join(dirname(fromFileAbs), specifier));
  const rel = relative(clientSrc, abs).replaceAll("\\", "/");
  if (rel.startsWith("../") || rel === ".." || rel.startsWith("/")) return null;
  return rel.replace(/\.tsx?$/, ".js");
}

/**
 * Concrete provider implementation targets that generic Runtime must never load.
 * Deleted Cursor/Kimi/OpenCode/Pi owners stay forbidden forever alongside current
 * family paths and the shared `providers/capabilities/**` foundation.
 */
function isForbiddenConcreteProviderModuleTarget(relPosix: string): boolean {
  const rel = relPosix.replaceAll("\\", "/").replace(/\.tsx?$/, ".js");
  if (rel === "handlers/kimi-code.js" || rel === "providers/handlers/kimi-code.js") return true;
  if (/^(?:providers\/)?handlers\/(cursor|kimi-code|opencode|pi)\//.test(rel)) return true;
  if (/^providers\/(amp|claude|codex|cursor|deepseek|grok|kimi-code|opencode|pi)(\/|$)/.test(rel)) return true;
  // Shared capability foundation — Runtime must not reverse-load it.
  // Do not forbid providers/skill-roots (managed-skills composition seam).
  if (/^providers\/capabilities(\/|$)/.test(rel)) return true;
  if (/^runtime\/(cursor|grok|pi|kimi|opencode|codex)-binary\.js$/.test(rel)) return true;
  if (rel === "runtime/opencode-private-config.js") return true;
  // Deleted Cursor/Kimi Runtime owners (prior S3 slices).
  if (rel === "runtime/cursor-login.js") return true;
  if (
    rel === "runtime/capabilities/cursor.js" ||
    rel === "runtime/capabilities/kimi-code.js" ||
    rel === "runtime/capabilities/discover-models.js"
  ) {
    return true;
  }
  // Deleted OpenCode/Pi + shared capability foundation owners (this S3 final slice).
  if (
    rel === "runtime/capabilities/opencode.js" ||
    rel === "runtime/capabilities/pi.js" ||
    rel === "runtime/capabilities/detect.js" ||
    rel === "runtime/capabilities/index.js" ||
    rel === "runtime/capabilities/launch-probe.js"
  ) {
    return true;
  }
  return false;
}

/** Shared Runtime→concrete-provider module-edge violations (AST + normalized target). */
function concreteProviderModuleEdgeViolations(fromFileAbs: string, source: string): string[] {
  const refs = extractModuleReferences(source);
  const violations: string[] = [];
  if (refs.hasUnresolvableModuleReference) {
    violations.push("non-literal/unclassifiable module reference");
  }
  for (const spec of refs.literalSpecifiers) {
    const target = normalizeClientSrcRelativeTarget(fromFileAbs, spec);
    if (target && isForbiddenConcreteProviderModuleTarget(target)) {
      violations.push(`${spec} -> ${target}`);
    }
  }
  return violations;
}

/** Live presentation consumers that must derive catalog-owned copy. */
const CATALOG_CONSUMER_FILES = [
  "packages/web/src/components/new-agent-dialog.tsx",
  "packages/web/src/features/agent-setup/use-computer-connection.ts",
  "packages/web/src/pages/onboarding/steps/step-create-agent.tsx",
  "packages/web/src/pages/onboarding/steps/step-connect-computer.tsx",
  "packages/web/src/pages/agent-detail/runtime-section.tsx",
  "packages/web/src/pages/clients/cards/shared/providers.ts",
  "packages/web/src/pages/clients/cards/shared/runtime-auth-view.ts",
  "packages/web/src/pages/clients/cards/shared/bound-agents-list.tsx",
  "packages/client/src/providers/handlers/auth-error-hint.ts",
  "packages/client/src/runtime/runtime-notice.ts",
  "packages/client/src/providers/claude/capability.ts",
  "packages/client/src/providers/codex/binary.ts",
  "packages/client/src/providers/cursor/binary.ts",
  "packages/client/src/providers/grok/binary.ts",
  "packages/client/src/providers/kimi-code/binary.ts",
  "packages/client/src/providers/opencode/binary.ts",
  "packages/client/src/providers/pi/binary.ts",
  "packages/client/src/providers/amp/binary.ts",
  "packages/client/src/providers/deepseek-harness/binary.ts",
] as const;

function listFilesRecursive(root: string, predicate: (path: string) => boolean): string[] {
  const out: string[] = [];
  for (const name of readdirSync(root)) {
    const path = join(root, name);
    const st = statSync(path);
    if (st.isDirectory()) {
      if (name === "node_modules" || name === "dist" || name === "__tests__") continue;
      out.push(...listFilesRecursive(path, predicate));
    } else if (predicate(path)) {
      out.push(path);
    }
  }
  return out;
}

function containsAnyProviderLiteral(source: string): string | null {
  for (const token of PROVIDER_LITERAL_TOKENS) {
    if (source.includes(token)) return token;
  }
  return null;
}

describe("runtime provider architecture guard", () => {
  it("keeps migrated generic client files free of concrete provider literals and handler imports", () => {
    for (const rel of GUARDED_CLIENT_FILES) {
      const source = readFileSync(join(clientSrc, rel), "utf8");
      const relPosix = rel.replaceAll("\\", "/");

      if (COMPOSITION_ALLOWLIST.has(relPosix)) {
        continue;
      }

      if (relPosix === "runtime/managed-skills.ts") {
        expect(source).toContain("providerSkillRoots");
        expect(source).toContain("ProviderSkillRootProjection");
        expect(source).not.toContain('from "../providers/skill-roots.js"');
        expect(source).not.toContain("getProviderSkillRoots");
        const hit = containsAnyProviderLiteral(source);
        // managed-skills may mention providers only via typed RuntimeProvider params;
        // forbid hard-coded skill-root maps and quoted provider ids.
        expect(hit, `${rel} must not hard-code provider literal ${hit}`).toBeNull();
        continue;
      }

      if (relPosix === "providers/capabilities/index.ts") {
        expect(source).toContain("BUILTIN_PROVIDER_PROBES");
        expect(source).toContain("RUNTIME_PROVIDER_IDS");
        expect(source).not.toContain("peekInstalledBuiltinProviderRegistry");
        expect(source).not.toContain("installBuiltinProviderRegistry");
        const hit = containsAnyProviderLiteral(source);
        expect(hit, `${rel} must not contain ${hit}`).toBeNull();
        // Generic import rule: no concrete capability modules.
        expect(source).not.toMatch(/from "\.\/[^"]+\.js"/);
        continue;
      }

      if (relPosix === "providers/handlers/auth-error-hint.ts") {
        expect(source).toContain("runtimeProviderChatAuthLoginPhrase");
        expect(source).toContain("runtimeProviderAuthOwnerLabel");
        expect(source).not.toMatch(/case ["']codex["']/);
        // Detection keywords may mention provider names in comments/strings;
        // forbid runtime-id branching for login/owner copy.
        expect(source).not.toMatch(/runtime\s*===\s*["']/);
        continue;
      }

      if (relPosix === "runtime/runtime-notice.ts") {
        expect(source).toContain("runtimeProviderLabel");
        expect(source).not.toMatch(/function providerLabel/);
        expect(source).not.toMatch(/case ["']codex["']:\s*return ["']Codex["']/);
        continue;
      }

      if (relPosix === "runtime/session-runtime.ts") {
        // Session lifecycle owns provider-typed payloads but must not hard-code
        // a concrete runtime id (including the retired silent Claude-era default).
        const hit = containsAnyProviderLiteral(source);
        expect(hit, `${rel} must not hard-code provider literal ${hit}`).toBeNull();
        expect(concreteProviderModuleEdgeViolations(join(clientSrc, rel), source)).toEqual([]);
        expect(source).toContain("runtimeProviderSchema");
        expect(source).toMatch(/runtimeProvider is required/);
        continue;
      }

      if (relPosix === "runtime/error-taxonomy.ts") {
        // Generic taxonomy consumes normalized binary-failure signals only.
        expect(source).toContain("recognizeProviderBinaryFailure");
        expect(source).toContain("provider-support/binary-failure");
        expect(concreteProviderModuleEdgeViolations(join(clientSrc, rel), source)).toEqual([]);
        expect(source).not.toMatch(/from ["']\.\/(?:codex|cursor|grok|pi)-binary/);
        continue;
      }

      expect(concreteProviderModuleEdgeViolations(join(clientSrc, rel), source)).toEqual([]);
      if (relPosix === "runtime/handler.ts" || relPosix === "runtime/runtime.ts") {
        const hit = containsAnyProviderLiteral(source);
        expect(hit, `${rel} must not contain ${hit}`).toBeNull();
        expect(source).not.toContain("installHandlers");
      }
    }
  });

  it("keeps the provider-support binary-failure seam free of concrete provider implementations", () => {
    const rel = "runtime/provider-support/binary-failure.ts";
    const absolute = join(clientSrc, rel);
    const source = readFileSync(absolute, "utf8");
    expect(source).toContain("recognizeProviderBinaryFailure");
    expect(source).toContain("PROVIDER_BINARY_FAILURE_REASON_CODES");
    expect(concreteProviderModuleEdgeViolations(absolute, source)).toEqual([]);
    expect(source).not.toMatch(/from ["']\.\.\/(?:codex|cursor|grok|pi|kimi|opencode)-binary/);
    expect(source).not.toMatch(/from ["'].*handlers\//);
    // Match rules are owned here — binary modules must re-export, not duplicate.
    expect(source).toContain("isCodexBinaryMissingError");
    expect(source).toContain("isCursorBinaryMissingError");
    expect(source).toContain("isGrokBinaryMissingError");
    expect(source).toContain("isPiBinaryMissingError");
    expect(source).toContain("piProviderDetailBinaryMissingReasonCode");
    // Contextual Pi-detail entry must compose the strict matcher, not copy its phrases.
    expect(source).toMatch(
      /export function piProviderDetailBinaryMissingReasonCode\([\s\S]*?isPiBinaryMissingError\(detail\)/,
    );
    const contextualFn = source.slice(source.indexOf("export function piProviderDetailBinaryMissingReasonCode"));
    expect(contextualFn).not.toContain("pi cli is missing");
    expect(contextualFn).not.toContain("no pi binary");
    expect(contextualFn).toContain('includes("not found")');
    expect(contextualFn).toContain('includes("not installed")');
  });

  it("keeps binary modules as re-export delegates for missing-error matchers (single owner)", () => {
    for (const [file, symbol] of [
      ["providers/codex/binary.ts", "isCodexBinaryMissingError"],
      ["providers/cursor/binary.ts", "isCursorBinaryMissingError"],
      ["providers/grok/binary.ts", "isGrokBinaryMissingError"],
      ["providers/antigravity/binary.ts", "isAntigravityBinaryMissingError"],
      ["providers/pi/binary.ts", "isPiBinaryMissingError"],
    ] as const) {
      const source = readFileSync(join(clientSrc, file), "utf8");
      expect(source, `${file} must re-export ${symbol} from provider-support index`).toContain(
        "provider-support/index.js",
      );
      expect(source).toContain(symbol);
      // No second owner of the match tables / regexes.
      expect(source).not.toMatch(/BINARY_MISSING_PATTERNS/);
      expect(source).not.toMatch(/function is(?:Codex|Cursor|Grok|Antigravity|Pi)BinaryMissingError/);
      // Fail closed: no deep provider-support group import.
      expect(source).not.toMatch(/provider-support\/binary-failure\.js/);
    }
  });

  it("keeps production handlers from owning a second binary-missing matcher or reason-code table", () => {
    const handlersRoot = join(clientSrc, "providers", "handlers");
    const providersRoot = join(clientSrc, "providers");
    const productionFiles = [
      ...listFilesRecursive(handlersRoot, (p) => p.endsWith(".ts")),
      ...listFilesRecursive(
        providersRoot,
        (p) => p.endsWith(".ts") && !p.endsWith("/binary.ts") && !p.endsWith("\\binary.ts"),
      ),
    ];
    const productionRels = productionFiles.map((file) => relative(clientSrc, file).replaceAll("\\", "/"));
    // Capability modules stay in the scan set after S3 family moves — never
    // exempt by basename (that would fail-open Claude/Grok capability owners).
    expect(productionRels).toContain("providers/claude/capability.ts");
    expect(productionRels).toContain("providers/codex/capability.ts");
    expect(productionRels).toContain("providers/grok/capability.ts");
    expect(productionRels).toContain("providers/opencode/capability.ts");
    expect(productionRels).toContain("providers/pi/capability.ts");
    expect(productionRels).toContain("providers/amp/capability.ts");
    expect(productionRels).toContain("providers/deepseek-harness/capability.ts");
    expect(productionRels).toContain("providers/antigravity/capability.ts");

    // Local regex / phrase tables that re-recognize provider binary absence.
    const codexBundledLocateMatcher = /unable to locate codex cli binaries/i;
    const noPiBinaryMatcher = /no pi binary/i;
    const secondOwnerMatchers = [
      /pi cli is missing/i,
      noPiBinaryMatcher,
      /BINARY_MISSING_PATTERNS/,
      /codex runtime binary is missing/i,
      codexBundledLocateMatcher,
      /cursor agent cli is missing/i,
      /grok build cli is missing/i,
      /antigravity cli is missing/i,
    ] as const;
    const reasonLiterals = [
      '"codex_binary_missing"',
      '"cursor_binary_missing"',
      '"grok_binary_missing"',
      '"antigravity_binary_missing"',
      '"pi_binary_missing"',
      "'codex_binary_missing'",
      "'cursor_binary_missing'",
      "'grok_binary_missing'",
      "'antigravity_binary_missing'",
      "'pi_binary_missing'",
    ] as const;

    /**
     * Exact approved executable occurrence of the Codex bundled-locate phrase:
     * the unique exported async `resolveBundledCodexBinary` top-level try/catch
     * whose catch (`err`) directly returns `{ ok: false, error: <exact template> }`.
     * Non-recursive: nested functions / descendant returns are never approved.
     * Comments are not exceptions.
     */
    const approvedLocateHead =
      "unable to locate codex CLI binaries (is @openai/codex installed with optional dependencies?): ";
    const approvedLocateExpression = "err instanceof Error ? err.message : String(err)";
    const approvedLocateInterpolation = ["$", "{", approvedLocateExpression, "}"].join("");

    function approvedCodexBundledLocateErrorSpans(source: string): Array<{ start: number; end: number; text: string }> {
      const sourceFile = ts.createSourceFile(
        "providers/codex/capability.ts",
        source,
        ts.ScriptTarget.Latest,
        true,
        ts.ScriptKind.TS,
      );

      const candidates = sourceFile.statements.filter(
        (stmt): stmt is ts.FunctionDeclaration =>
          ts.isFunctionDeclaration(stmt) &&
          stmt.name?.text === "resolveBundledCodexBinary" &&
          !!stmt.body &&
          !!ts.getModifiers(stmt)?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword) &&
          !!ts.getModifiers(stmt)?.some((m) => m.kind === ts.SyntaxKind.AsyncKeyword),
      );
      if (candidates.length !== 1) return [];
      const fn = candidates[0];
      if (!fn?.body) return [];

      const spans: Array<{ start: number; end: number; text: string }> = [];

      for (const stmt of fn.body.statements) {
        if (!ts.isTryStatement(stmt) || !stmt.catchClause) continue;
        const catchDecl = stmt.catchClause.variableDeclaration;
        if (!catchDecl || !ts.isIdentifier(catchDecl.name) || catchDecl.name.text !== "err") continue;

        const catchStatements = stmt.catchClause.block.statements;
        if (catchStatements.length !== 1) continue;
        const ret = catchStatements[0];
        if (!ret || !ts.isReturnStatement(ret) || !ret.expression || !ts.isObjectLiteralExpression(ret.expression)) {
          continue;
        }
        if (ret.expression.properties.length !== 2) continue;
        if (!ret.expression.properties.every((prop) => ts.isPropertyAssignment(prop))) continue;

        const okProp = ret.expression.properties[0];
        const errorProp = ret.expression.properties[1];
        if (!okProp || !errorProp || !ts.isPropertyAssignment(okProp) || !ts.isPropertyAssignment(errorProp)) continue;
        if (!ts.isIdentifier(okProp.name) || okProp.name.text !== "ok") continue;
        if (okProp.initializer.kind !== ts.SyntaxKind.FalseKeyword) continue;
        if (!ts.isIdentifier(errorProp.name) || errorProp.name.text !== "error") continue;
        if (!ts.isTemplateExpression(errorProp.initializer)) continue;

        const template = errorProp.initializer;
        if (template.head.text !== approvedLocateHead) continue;
        if (template.templateSpans.length !== 1) continue;
        const templateSpan = template.templateSpans[0];
        if (!templateSpan) continue;
        if (templateSpan.expression.getText(sourceFile) !== approvedLocateExpression) continue;
        if (templateSpan.literal.text !== "") continue;

        spans.push({
          start: template.getStart(sourceFile),
          end: template.getEnd(),
          text: template.getText(sourceFile),
        });
      }

      return spans;
    }

    function maskSpans(source: string, spans: Array<{ start: number; end: number }>): string {
      if (spans.length === 0) return source;
      const ordered = [...spans].sort((a, b) => b.start - a.start);
      let out = source;
      for (const span of ordered) {
        out = `${out.slice(0, span.start)}${" ".repeat(span.end - span.start)}${out.slice(span.end)}`;
      }
      return out;
    }

    /**
     * Exact approved Pi capability occurrence of the pre-format resolution
     * phrase. Fail-closed: unique exported async `probePiCapability` must open
     * with the production reachable prefix
     * (`const env` / `const platform` / `const findOnPath` / `const detected`),
     * own exactly one `runDetect` via that fourth statement, and have a callback
     * body that is the production terminal missing-path sequence. Only the
     * terminal missing-return string literal is masked. Outer or callback
     * unconditional completion, reshaped/reordered predecessors, non-`const`
     * declarations, extra `detected` / `runDetect`, or non-terminal exact
     * returns yield zero spans.
     */
    const approvedPiCapabilityDetail = "no pi binary resolved on this host";

    function isExportedAsyncProbePiCapability(stmt: ts.Statement): stmt is ts.FunctionDeclaration {
      return (
        ts.isFunctionDeclaration(stmt) &&
        stmt.name?.text === "probePiCapability" &&
        !!stmt.body &&
        !!ts.getModifiers(stmt)?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword) &&
        !!ts.getModifiers(stmt)?.some((m) => m.kind === ts.SyntaxKind.AsyncKeyword)
      );
    }

    function isConstSingleDeclaration(
      stmt: ts.Statement,
      name: string,
    ): stmt is ts.VariableStatement & {
      declarationList: ts.VariableDeclarationList & { declarations: [ts.VariableDeclaration] };
    } {
      if (!ts.isVariableStatement(stmt)) return false;
      if ((stmt.declarationList.flags & ts.NodeFlags.Const) === 0) return false;
      if (stmt.declarationList.declarations.length !== 1) return false;
      const decl = stmt.declarationList.declarations[0];
      return !!decl && ts.isIdentifier(decl.name) && decl.name.text === name;
    }

    function isPropertyAccess(expr: ts.Expression, object: string, name: string): boolean {
      return (
        ts.isPropertyAccessExpression(expr) &&
        ts.isIdentifier(expr.expression) &&
        expr.expression.text === object &&
        expr.name.text === name
      );
    }

    function isNullishCoalesce(
      expr: ts.Expression | undefined,
      left: (e: ts.Expression) => boolean,
      right: (e: ts.Expression) => boolean,
    ): boolean {
      return (
        !!expr &&
        ts.isBinaryExpression(expr) &&
        expr.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken &&
        left(expr.left) &&
        right(expr.right)
      );
    }

    function isEnvDeclaration(stmt: ts.Statement): boolean {
      if (!isConstSingleDeclaration(stmt, "env")) return false;
      const init = stmt.declarationList.declarations[0]?.initializer;
      return isNullishCoalesce(
        init,
        (e) => isPropertyAccess(e, "deps", "env"),
        (e) => isPropertyAccess(e, "process", "env"),
      );
    }

    function isPlatformDeclaration(stmt: ts.Statement): boolean {
      if (!isConstSingleDeclaration(stmt, "platform")) return false;
      const init = stmt.declarationList.declarations[0]?.initializer;
      return isNullishCoalesce(
        init,
        (e) => isPropertyAccess(e, "deps", "platform"),
        (e) => isPropertyAccess(e, "process", "platform"),
      );
    }

    function isFindOnPathDeclaration(stmt: ts.Statement): boolean {
      if (!isConstSingleDeclaration(stmt, "findOnPath")) return false;
      const init = stmt.declarationList.declarations[0]?.initializer;
      return isNullishCoalesce(
        init,
        (e) => isPropertyAccess(e, "deps", "findOnPath"),
        (e) => ts.isIdentifier(e) && e.text === "findPiExecutableOnPath",
      );
    }

    function isPlatformWin32Binary(expr: ts.Expression): boolean {
      return (
        ts.isBinaryExpression(expr) &&
        expr.operatorToken.kind === ts.SyntaxKind.EqualsEqualsEqualsToken &&
        ts.isIdentifier(expr.left) &&
        expr.left.text === "platform" &&
        ts.isStringLiteral(expr.right) &&
        expr.right.text === "win32"
      );
    }

    function isWin32PlatformGate(stmt: ts.Statement): boolean {
      if (!ts.isIfStatement(stmt) || stmt.elseStatement) return false;
      if (!isPlatformWin32Binary(stmt.expression)) return false;
      if (!ts.isBlock(stmt.thenStatement) || stmt.thenStatement.statements.length !== 1) return false;
      const only = stmt.thenStatement.statements[0];
      if (!only || !ts.isThrowStatement(only) || !only.expression) return false;
      if (!ts.isNewExpression(only.expression)) return false;
      return ts.isIdentifier(only.expression.expression) && only.expression.expression.text === "Error";
    }

    function isRuntimePathDeclaration(stmt: ts.Statement): boolean {
      if (!isConstSingleDeclaration(stmt, "runtimePath")) return false;
      const decl = stmt.declarationList.declarations[0];
      if (!decl?.initializer || !ts.isCallExpression(decl.initializer)) return false;
      if (!ts.isIdentifier(decl.initializer.expression) || decl.initializer.expression.text !== "findOnPath") {
        return false;
      }
      if (decl.initializer.arguments.length !== 1) return false;
      const arg = decl.initializer.arguments[0];
      return !!arg && ts.isIdentifier(arg) && arg.text === "env";
    }

    function isInstalledSuccessObject(expr: ts.Expression): boolean {
      if (!ts.isObjectLiteralExpression(expr) || expr.properties.length !== 3) return false;
      const installed = expr.properties[0];
      const runtimeSource = expr.properties[1];
      const runtimePath = expr.properties[2];
      if (!installed || !runtimeSource || !runtimePath) return false;
      if (!ts.isPropertyAssignment(installed) || !ts.isPropertyAssignment(runtimeSource)) return false;
      if (!ts.isIdentifier(installed.name) || installed.name.text !== "installed") return false;
      if (installed.initializer.kind !== ts.SyntaxKind.TrueKeyword) return false;
      if (!ts.isIdentifier(runtimeSource.name) || runtimeSource.name.text !== "runtimeSource") return false;
      if (!ts.isStringLiteral(runtimeSource.initializer) || runtimeSource.initializer.text !== "path") return false;
      // Production uses object shorthand `{ …, runtimePath }`.
      if (ts.isShorthandPropertyAssignment(runtimePath)) {
        return runtimePath.name.text === "runtimePath";
      }
      if (!ts.isPropertyAssignment(runtimePath)) return false;
      if (!ts.isIdentifier(runtimePath.name) || runtimePath.name.text !== "runtimePath") return false;
      return ts.isIdentifier(runtimePath.initializer) && runtimePath.initializer.text === "runtimePath";
    }

    function isInstalledSuccessGate(stmt: ts.Statement): boolean {
      if (!ts.isIfStatement(stmt) || stmt.elseStatement) return false;
      if (!ts.isIdentifier(stmt.expression) || stmt.expression.text !== "runtimePath") return false;
      let ret: ts.ReturnStatement | undefined;
      if (ts.isReturnStatement(stmt.thenStatement)) {
        ret = stmt.thenStatement;
      } else if (ts.isBlock(stmt.thenStatement) && stmt.thenStatement.statements.length === 1) {
        const only = stmt.thenStatement.statements[0];
        if (only && ts.isReturnStatement(only)) ret = only;
      }
      if (!ret?.expression) return false;
      return isInstalledSuccessObject(ret.expression);
    }

    function isApprovedPiMissingDetectReturn(
      stmt: ts.Statement,
      sourceFile: ts.SourceFile,
    ): { start: number; end: number; text: string } | null {
      if (!ts.isReturnStatement(stmt) || !stmt.expression || !ts.isObjectLiteralExpression(stmt.expression)) {
        return null;
      }
      if (stmt.expression.properties.length !== 2) return null;
      if (!stmt.expression.properties.every((prop) => ts.isPropertyAssignment(prop))) return null;
      const installedProp = stmt.expression.properties[0];
      const errorProp = stmt.expression.properties[1];
      if (
        !installedProp ||
        !errorProp ||
        !ts.isPropertyAssignment(installedProp) ||
        !ts.isPropertyAssignment(errorProp)
      ) {
        return null;
      }
      if (!ts.isIdentifier(installedProp.name) || installedProp.name.text !== "installed") return null;
      if (installedProp.initializer.kind !== ts.SyntaxKind.FalseKeyword) return null;
      if (!ts.isIdentifier(errorProp.name) || errorProp.name.text !== "error") return null;
      if (!ts.isCallExpression(errorProp.initializer)) return null;
      const call = errorProp.initializer;
      if (!ts.isIdentifier(call.expression) || call.expression.text !== "formatPiBinaryMissingMessage") {
        return null;
      }
      if (call.arguments.length !== 1) return null;
      const arg = call.arguments[0];
      if (!arg || !ts.isStringLiteral(arg) || arg.text !== approvedPiCapabilityDetail) return null;
      return {
        start: arg.getStart(sourceFile),
        end: arg.getEnd(),
        text: arg.getText(sourceFile),
      };
    }

    function countRunDetectCalls(node: ts.Node): number {
      let count = 0;
      function visit(n: ts.Node): void {
        if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === "runDetect") {
          count += 1;
        }
        ts.forEachChild(n, visit);
      }
      visit(node);
      return count;
    }

    function extractDetectedRunDetectCallbackFromFourthStatement(fn: ts.FunctionDeclaration): ts.ArrowFunction | null {
      if (!fn.body) return null;
      if (countRunDetectCalls(fn.body) !== 1) return null;

      const stmts = fn.body.statements;
      // Reachable production prefix: detected is exactly the fourth top-level statement.
      if (stmts.length < 4) return null;
      if (!isEnvDeclaration(stmts[0]!)) return null;
      if (!isPlatformDeclaration(stmts[1]!)) return null;
      if (!isFindOnPathDeclaration(stmts[2]!)) return null;
      const detectedStmt = stmts[3];
      if (!detectedStmt || !isConstSingleDeclaration(detectedStmt, "detected")) return null;

      const decl = detectedStmt.declarationList.declarations[0];
      if (!decl?.initializer || !ts.isAwaitExpression(decl.initializer)) return null;
      const awaited = decl.initializer.expression;
      if (!ts.isCallExpression(awaited)) return null;
      if (!ts.isIdentifier(awaited.expression) || awaited.expression.text !== "runDetect") return null;
      if (awaited.arguments.length !== 1) return null;
      const callback = awaited.arguments[0];
      if (!callback || !ts.isArrowFunction(callback) || !callback.body) return null;
      if ((ts.getCombinedModifierFlags(callback) & ts.ModifierFlags.Async) === 0) return null;
      if (!ts.isBlock(callback.body)) return null;
      return callback;
    }

    function approvedPiCapabilityNoBinaryDetailSpans(
      source: string,
    ): Array<{ start: number; end: number; text: string }> {
      const sourceFile = ts.createSourceFile(
        "providers/pi/capability.ts",
        source,
        ts.ScriptTarget.Latest,
        true,
        ts.ScriptKind.TS,
      );

      const candidates = sourceFile.statements.filter(isExportedAsyncProbePiCapability);
      if (candidates.length !== 1) return [];
      const fn = candidates[0];
      if (!fn?.body) return [];

      const callback = extractDetectedRunDetectCallbackFromFourthStatement(fn);
      if (!callback || !ts.isBlock(callback.body)) return [];

      const stmts = callback.body.statements;
      // Exact production sequence: 4 direct statements; terminal is missing return.
      if (stmts.length !== 4) return [];
      if (!isWin32PlatformGate(stmts[0]!)) return [];
      if (!isRuntimePathDeclaration(stmts[1]!)) return [];
      if (!isInstalledSuccessGate(stmts[2]!)) return [];
      const span = isApprovedPiMissingDetectReturn(stmts[3]!, sourceFile);
      return span ? [span] : [];
    }

    function expectRejectedPiDetailFixture(label: string, snippet: string): void {
      expect(approvedPiCapabilityNoBinaryDetailSpans(snippet), label).toHaveLength(0);
      expect(noPiBinaryMatcher.test(snippet), `${label} still matches generic phrase`).toBe(true);
      expect(
        noPiBinaryMatcher.test(maskSpans(snippet, approvedPiCapabilityNoBinaryDetailSpans(snippet))),
        `${label} must not be neutralized by masking`,
      ).toBe(true);
    }

    function expectRejectedLocateFixture(label: string, snippet: string): void {
      expect(approvedCodexBundledLocateErrorSpans(snippet), label).toHaveLength(0);
      expect(codexBundledLocateMatcher.test(snippet), `${label} still matches generic phrase`).toBe(true);
      expect(
        codexBundledLocateMatcher.test(maskSpans(snippet, approvedCodexBundledLocateErrorSpans(snippet))),
        `${label} must not be neutralized by masking`,
      ).toBe(true);
    }

    for (const file of productionFiles) {
      const source = readFileSync(file, "utf8");
      const rel = relative(clientSrc, file).replaceAll("\\", "/");
      for (const matcher of secondOwnerMatchers) {
        if (rel === "providers/codex/capability.ts" && matcher === codexBundledLocateMatcher) {
          const spans = approvedCodexBundledLocateErrorSpans(source);
          expect(spans, "Codex capability must expose exactly one approved bundled-locate error template").toHaveLength(
            1,
          );
          expect(spans[0]?.text).toBe("`" + approvedLocateHead + approvedLocateInterpolation + "`");
          const neutralized = maskSpans(source, spans);
          expect(
            neutralized,
            `${rel} must not re-own binary-missing recognition outside the approved resolveBundledCodexBinary catch (${matcher})`,
          ).not.toMatch(matcher);
          continue;
        }
        if (rel === "providers/pi/capability.ts" && matcher === noPiBinaryMatcher) {
          const spans = approvedPiCapabilityNoBinaryDetailSpans(source);
          expect(
            spans,
            "Pi capability must expose exactly one approved formatPiBinaryMissingMessage detail literal",
          ).toHaveLength(1);
          expect(spans[0]?.text).toBe(JSON.stringify(approvedPiCapabilityDetail));
          const neutralized = maskSpans(source, spans);
          expect(
            neutralized,
            `${rel} must not re-own binary-missing recognition outside the approved formatPiBinaryMissingMessage detail (${matcher})`,
          ).not.toMatch(matcher);
          continue;
        }
        expect(source, `${rel} must not re-own binary-missing recognition (${matcher})`).not.toMatch(matcher);
      }
      for (const literal of reasonLiterals) {
        expect(
          source,
          `${rel} must not hard-code ${literal}; import PROVIDER_BINARY_FAILURE_REASON_CODES`,
        ).not.toContain(literal);
      }
    }

    const approvedErrorTemplate = "`" + approvedLocateHead + approvedLocateInterpolation + "`";
    const approvedShape = [
      "export async function resolveBundledCodexBinary() {",
      "  try { throw new Error('x'); } catch (err) {",
      `    return { ok: false, error: ${approvedErrorTemplate} };`,
      "  }",
      "}",
      "",
    ].join("\n");
    expect(approvedCodexBundledLocateErrorSpans(approvedShape)).toHaveLength(1);
    expect(
      codexBundledLocateMatcher.test(maskSpans(approvedShape, approvedCodexBundledLocateErrorSpans(approvedShape))),
    ).toBe(false);

    // QA-reproduced bypasses that must stay rejected.
    expectRejectedLocateFixture(
      "second phrase inside approved template tail",
      [
        "export async function resolveBundledCodexBinary() {",
        "  try { throw new Error('x'); } catch (err) {",
        `    return { ok: false, error: \`${approvedLocateHead}${approvedLocateInterpolation} unable to locate codex CLI binaries\` };`,
        "  }",
        "}",
        "",
      ].join("\n"),
    );
    const wrongInterp = ["$", "{", "unrelated", "}"].join("");
    expectRejectedLocateFixture(
      "wrong interpolation expression and changed suffix",
      [
        "export async function resolveBundledCodexBinary() {",
        "  try { throw new Error('x'); } catch (err) {",
        `    return { ok: false, error: \`${approvedLocateHead}${wrongInterp} changed-suffix\` };`,
        "  }",
        "}",
        "",
      ].join("\n"),
    );
    expectRejectedLocateFixture(
      "matcher returned from nested function inside catch",
      [
        "export async function resolveBundledCodexBinary() {",
        "  try { throw new Error('x'); } catch (err) {",
        "    function nested() {",
        `      return { ok: false, error: ${approvedErrorTemplate} };`,
        "    }",
        "    return nested();",
        "  }",
        "}",
        "",
      ].join("\n"),
    );

    // Broader fail-closed shapes.
    expectRejectedLocateFixture(
      "plain string return",
      'export async function resolveBundledCodexBinary() { return "unable to locate codex CLI binaries"; }',
    );
    expectRejectedLocateFixture(
      "wrong function name",
      [
        "export async function other() {",
        "  try { throw new Error('x'); } catch (err) {",
        `    return { ok: false, error: ${approvedErrorTemplate} };`,
        "  }",
        "}",
        "",
      ].join("\n"),
    );
    expectRejectedLocateFixture(
      "wrong property name",
      [
        "export async function resolveBundledCodexBinary() {",
        "  try { throw new Error('x'); } catch (err) {",
        `    return { ok: false, detail: ${approvedErrorTemplate} };`,
        "  }",
        "}",
        "",
      ].join("\n"),
    );
    expectRejectedLocateFixture(
      "comment-only restatement",
      [
        "export async function resolveBundledCodexBinary() {",
        "  // unable to locate codex CLI binaries",
        "  return { ok: true, binary: '/bin/codex' };",
        "}",
        "",
      ].join("\n"),
    );
    expectRejectedLocateFixture(
      "Claude capability occurrence",
      [
        "export async function probeClaudeCapability() {",
        '  return { installed: false, error: "unable to locate codex CLI binaries" };',
        "}",
        "",
      ].join("\n"),
    );
    expectRejectedLocateFixture(
      "Grok capability occurrence",
      [
        "export async function probeGrokCapability() {",
        '  return { installed: false, error: "unable to locate codex CLI binaries" };',
        "}",
        "",
      ].join("\n"),
    );

    const withExtraOutside = `${approvedShape}const leaked = "unable to locate codex CLI binaries";\n`;
    expect(approvedCodexBundledLocateErrorSpans(withExtraOutside)).toHaveLength(1);
    expect(
      codexBundledLocateMatcher.test(
        maskSpans(withExtraOutside, approvedCodexBundledLocateErrorSpans(withExtraOutside)),
      ),
    ).toBe(true);

    // Approved Pi shape — exact production AST skeleton (drives the same approver).
    const approvedPiOuterPrefix = [
      "  const env = deps.env ?? process.env;",
      "  const platform = deps.platform ?? process.platform;",
      "  const findOnPath = deps.findOnPath ?? findPiExecutableOnPath;",
    ].join("\n");
    const approvedPiCallbackBody = [
      '    if (platform === "win32") {',
      '      throw new Error("Pi provider is not supported on Windows in V1");',
      "    }",
      "    const runtimePath = findOnPath(env);",
      '    if (runtimePath) return { installed: true, runtimeSource: "path", runtimePath };',
      "    return {",
      "      installed: false,",
      '      error: formatPiBinaryMissingMessage("no pi binary resolved on this host"),',
      "    };",
    ].join("\n");
    const approvedPiShape = [
      "export async function probePiCapability(deps: PiProbeDeps = {}) {",
      approvedPiOuterPrefix,
      "  const detected = await runDetect(async (): Promise<DetectOutcome> => {",
      approvedPiCallbackBody,
      "  });",
      "  return detected;",
      "}",
      "",
    ].join("\n");
    expect(approvedPiCapabilityNoBinaryDetailSpans(approvedPiShape)).toHaveLength(1);
    expect(
      noPiBinaryMatcher.test(maskSpans(approvedPiShape, approvedPiCapabilityNoBinaryDetailSpans(approvedPiShape))),
    ).toBe(false);

    // QA-reproduced bypass: call moved to unrelated helper; probe detail changed.
    expectRejectedPiDetailFixture(
      "QA relocation to unrelatedPiDetailForMutation",
      [
        "export function unrelatedPiDetailForMutation(): string {",
        '  return formatPiBinaryMissingMessage("no pi binary resolved on this host");',
        "}",
        "export async function probePiCapability() {",
        "  const detected = await runDetect(async (): Promise<DetectOutcome> => {",
        '    if (platform === "win32") { throw new Error("x"); }',
        "    const runtimePath = findOnPath(env);",
        '    if (runtimePath) return { installed: true, runtimeSource: "path", runtimePath };',
        "    return {",
        "      installed: false,",
        '      error: formatPiBinaryMissingMessage("artifact unavailable"),',
        "    };",
        "  });",
        "  return detected;",
        "}",
        "",
      ].join("\n"),
    );
    expectRejectedPiDetailFixture(
      "dead helper outside probePiCapability",
      [
        "export function deadHelper() {",
        '  return formatPiBinaryMissingMessage("no pi binary resolved on this host");',
        "}",
        "export async function probePiCapability() {",
        "  return { state: 'ok', available: true, detectedAt: '' };",
        "}",
        "",
      ].join("\n"),
    );
    expectRejectedPiDetailFixture(
      "other provider file shape",
      [
        "export async function probeOpenCodeCapability() {",
        "  const detected = await runDetect(async () => {",
        approvedPiCallbackBody,
        "  });",
        "  return detected;",
        "}",
        "",
      ].join("\n"),
    );
    const withExtraPiOutside = `${approvedPiShape}export function leaked() { return formatPiBinaryMissingMessage("no pi binary resolved on this host"); }\n`;
    expect(approvedPiCapabilityNoBinaryDetailSpans(withExtraPiOutside)).toHaveLength(1);
    expect(
      noPiBinaryMatcher.test(
        maskSpans(withExtraPiOutside, approvedPiCapabilityNoBinaryDetailSpans(withExtraPiOutside)),
      ),
      "extra identical call outside approved return must not be neutralized",
    ).toBe(true);
    expectRejectedPiDetailFixture(
      "wrong callee",
      [
        "export async function probePiCapability() {",
        "  const detected = await runDetect(async () => {",
        '    if (platform === "win32") { throw new Error("x"); }',
        "    const runtimePath = findOnPath(env);",
        '    if (runtimePath) return { installed: true, runtimeSource: "path", runtimePath };',
        "    return {",
        "      installed: false,",
        '      error: formatOpenCodeBinaryMissingMessage("no pi binary resolved on this host"),',
        "    };",
        "  });",
        "  return detected;",
        "}",
        "",
      ].join("\n"),
    );
    expectRejectedPiDetailFixture(
      "wrong string argument",
      [
        "export async function probePiCapability() {",
        "  const detected = await runDetect(async () => {",
        '    if (platform === "win32") { throw new Error("x"); }',
        "    const runtimePath = findOnPath(env);",
        '    if (runtimePath) return { installed: true, runtimeSource: "path", runtimePath };',
        "    return {",
        "      installed: false,",
        '      error: formatPiBinaryMissingMessage("no pi binary resolved"),',
        "    };",
        "  });",
        "  return detected;",
        "}",
        "",
      ].join("\n"),
    );
    expectRejectedPiDetailFixture(
      "wrong object property name",
      [
        "export async function probePiCapability() {",
        "  const detected = await runDetect(async () => {",
        '    if (platform === "win32") { throw new Error("x"); }',
        "    const runtimePath = findOnPath(env);",
        '    if (runtimePath) return { installed: true, runtimeSource: "path", runtimePath };',
        "    return {",
        "      installed: false,",
        '      detail: formatPiBinaryMissingMessage("no pi binary resolved on this host"),',
        "    };",
        "  });",
        "  return detected;",
        "}",
        "",
      ].join("\n"),
    );
    expectRejectedPiDetailFixture(
      "nested function smuggling inside runDetect callback",
      [
        "export async function probePiCapability() {",
        "  const detected = await runDetect(async () => {",
        '    if (platform === "win32") { throw new Error("x"); }',
        "    const runtimePath = findOnPath(env);",
        '    if (runtimePath) return { installed: true, runtimeSource: "path", runtimePath };',
        "    function nested() {",
        "      return {",
        "        installed: false,",
        '        error: formatPiBinaryMissingMessage("no pi binary resolved on this host"),',
        "      };",
        "    }",
        "    return nested();",
        "  });",
        "  return detected;",
        "}",
        "",
      ].join("\n"),
    );
    expectRejectedPiDetailFixture(
      "missing runDetect await shape",
      [
        "export async function probePiCapability() {",
        "  return {",
        "    installed: false,",
        '    error: formatPiBinaryMissingMessage("no pi binary resolved on this host"),',
        "  };",
        "}",
        "",
      ].join("\n"),
    );

    // QA control-flow bypass: unconditional throw before still-present exact return.
    expectRejectedPiDetailFixture(
      "QA unreachable throw before terminal exact return",
      [
        "export async function probePiCapability() {",
        "  const detected = await runDetect(async (): Promise<DetectOutcome> => {",
        '    if (platform === "win32") {',
        '      throw new Error("Pi provider is not supported on Windows in V1");',
        "    }",
        "    const runtimePath = findOnPath(env);",
        '    if (runtimePath) return { installed: true, runtimeSource: "path", runtimePath };',
        '    throw new Error("QA mutation: make the approved missing return unreachable");',
        "    return {",
        "      installed: false,",
        '      error: formatPiBinaryMissingMessage("no pi binary resolved on this host"),',
        "    };",
        "  });",
        "  return detected;",
        "}",
        "",
      ].join("\n"),
    );
    expectRejectedPiDetailFixture(
      "unconditional return before terminal exact return",
      [
        "export async function probePiCapability() {",
        "  const detected = await runDetect(async () => {",
        '    if (platform === "win32") { throw new Error("x"); }',
        "    const runtimePath = findOnPath(env);",
        '    if (runtimePath) return { installed: true, runtimeSource: "path", runtimePath };',
        '    return { installed: false, error: "artifact unavailable" };',
        "    return {",
        "      installed: false,",
        '      error: formatPiBinaryMissingMessage("no pi binary resolved on this host"),',
        "    };",
        "  });",
        "  return detected;",
        "}",
        "",
      ].join("\n"),
    );
    expectRejectedPiDetailFixture(
      "exact return moved earlier; final missing return rewritten",
      [
        "export async function probePiCapability() {",
        "  const detected = await runDetect(async () => {",
        "    return {",
        "      installed: false,",
        '      error: formatPiBinaryMissingMessage("no pi binary resolved on this host"),',
        "    };",
        '    if (platform === "win32") { throw new Error("x"); }',
        "    const runtimePath = findOnPath(env);",
        '    if (runtimePath) return { installed: true, runtimeSource: "path", runtimePath };',
        "    return {",
        "      installed: false,",
        '      error: formatPiBinaryMissingMessage("artifact unavailable"),',
        "    };",
        "  });",
        "  return detected;",
        "}",
        "",
      ].join("\n"),
    );
    expectRejectedPiDetailFixture(
      "extra detected/runDetect while keeping final exact return",
      [
        "export async function probePiCapability() {",
        "  const ignored = await runDetect(async () => ({ installed: true, runtimeSource: 'path', runtimePath: '/x' }));",
        "  const detected = await runDetect(async () => {",
        approvedPiCallbackBody,
        "  });",
        "  void ignored;",
        "  return detected;",
        "}",
        "",
      ].join("\n"),
    );
    expectRejectedPiDetailFixture(
      "duplicate direct exact return in same callback",
      [
        "export async function probePiCapability() {",
        "  const detected = await runDetect(async () => {",
        '    if (platform === "win32") { throw new Error("x"); }',
        "    const runtimePath = findOnPath(env);",
        '    if (runtimePath) return { installed: true, runtimeSource: "path", runtimePath };',
        "    return {",
        "      installed: false,",
        '      error: formatPiBinaryMissingMessage("no pi binary resolved on this host"),',
        "    };",
        "    return {",
        "      installed: false,",
        '      error: formatPiBinaryMissingMessage("no pi binary resolved on this host"),',
        "    };",
        "  });",
        "  return detected;",
        "}",
        "",
      ].join("\n"),
    );
    expectRejectedPiDetailFixture(
      "reshaped platform predecessor gate",
      [
        "export async function probePiCapability() {",
        "  const detected = await runDetect(async () => {",
        '    if (platform === "darwin") { throw new Error("x"); }',
        "    const runtimePath = findOnPath(env);",
        '    if (runtimePath) return { installed: true, runtimeSource: "path", runtimePath };',
        "    return {",
        "      installed: false,",
        '      error: formatPiBinaryMissingMessage("no pi binary resolved on this host"),',
        "    };",
        "  });",
        "  return detected;",
        "}",
        "",
      ].join("\n"),
    );
    expectRejectedPiDetailFixture(
      "reshaped runtimePath declaration",
      [
        "export async function probePiCapability() {",
        "  const detected = await runDetect(async () => {",
        '    if (platform === "win32") { throw new Error("x"); }',
        "    const runtimePath = findOnPath();",
        '    if (runtimePath) return { installed: true, runtimeSource: "path", runtimePath };',
        "    return {",
        "      installed: false,",
        '      error: formatPiBinaryMissingMessage("no pi binary resolved on this host"),',
        "    };",
        "  });",
        "  return detected;",
        "}",
        "",
      ].join("\n"),
    );
    expectRejectedPiDetailFixture(
      "reshaped installed-success branch",
      [
        "export async function probePiCapability() {",
        "  const detected = await runDetect(async () => {",
        '    if (platform === "win32") { throw new Error("x"); }',
        "    const runtimePath = findOnPath(env);",
        '    if (runtimePath) return { installed: true, runtimeSource: "bundle", runtimePath };',
        "    return {",
        "      installed: false,",
        '      error: formatPiBinaryMissingMessage("no pi binary resolved on this host"),',
        "    };",
        "  });",
        "  return detected;",
        "}",
        "",
      ].join("\n"),
    );

    // Outer reachability — detected must be the fourth top-level const statement.
    expectRejectedPiDetailFixture(
      "QA outer unconditional throw before detected",
      [
        "export async function probePiCapability(deps: PiProbeDeps = {}) {",
        approvedPiOuterPrefix,
        '  throw new Error("QA mutation: make the runDetect owner unreachable");',
        "  const detected = await runDetect(async (): Promise<DetectOutcome> => {",
        approvedPiCallbackBody,
        "  });",
        "  return detected;",
        "}",
        "",
      ].join("\n"),
    );
    expectRejectedPiDetailFixture(
      "outer unconditional return before detected",
      [
        "export async function probePiCapability(deps: PiProbeDeps = {}) {",
        approvedPiOuterPrefix,
        "  return { state: 'error', available: false, detectedAt: '', error: 'x' };",
        "  const detected = await runDetect(async (): Promise<DetectOutcome> => {",
        approvedPiCallbackBody,
        "  });",
        "  return detected;",
        "}",
        "",
      ].join("\n"),
    );
    expectRejectedPiDetailFixture(
      "harmless extra statement before detected",
      [
        "export async function probePiCapability(deps: PiProbeDeps = {}) {",
        approvedPiOuterPrefix,
        "  void deps;",
        "  const detected = await runDetect(async (): Promise<DetectOutcome> => {",
        approvedPiCallbackBody,
        "  });",
        "  return detected;",
        "}",
        "",
      ].join("\n"),
    );
    expectRejectedPiDetailFixture(
      "env declaration renamed",
      [
        "export async function probePiCapability(deps: PiProbeDeps = {}) {",
        "  const environment = deps.env ?? process.env;",
        "  const platform = deps.platform ?? process.platform;",
        "  const findOnPath = deps.findOnPath ?? findPiExecutableOnPath;",
        "  const detected = await runDetect(async (): Promise<DetectOutcome> => {",
        approvedPiCallbackBody,
        "  });",
        "  return detected;",
        "}",
        "",
      ].join("\n"),
    );
    expectRejectedPiDetailFixture(
      "platform initializer reshaped",
      [
        "export async function probePiCapability(deps: PiProbeDeps = {}) {",
        "  const env = deps.env ?? process.env;",
        "  const platform = process.platform;",
        "  const findOnPath = deps.findOnPath ?? findPiExecutableOnPath;",
        "  const detected = await runDetect(async (): Promise<DetectOutcome> => {",
        approvedPiCallbackBody,
        "  });",
        "  return detected;",
        "}",
        "",
      ].join("\n"),
    );
    expectRejectedPiDetailFixture(
      "findOnPath / platform declaration order swapped",
      [
        "export async function probePiCapability(deps: PiProbeDeps = {}) {",
        "  const env = deps.env ?? process.env;",
        "  const findOnPath = deps.findOnPath ?? findPiExecutableOnPath;",
        "  const platform = deps.platform ?? process.platform;",
        "  const detected = await runDetect(async (): Promise<DetectOutcome> => {",
        approvedPiCallbackBody,
        "  });",
        "  return detected;",
        "}",
        "",
      ].join("\n"),
    );
    expectRejectedPiDetailFixture(
      "outer env uses let instead of const",
      [
        "export async function probePiCapability(deps: PiProbeDeps = {}) {",
        "  let env = deps.env ?? process.env;",
        "  const platform = deps.platform ?? process.platform;",
        "  const findOnPath = deps.findOnPath ?? findPiExecutableOnPath;",
        "  const detected = await runDetect(async (): Promise<DetectOutcome> => {",
        approvedPiCallbackBody,
        "  });",
        "  return detected;",
        "}",
        "",
      ].join("\n"),
    );
    expectRejectedPiDetailFixture(
      "detected uses let instead of const",
      [
        "export async function probePiCapability(deps: PiProbeDeps = {}) {",
        approvedPiOuterPrefix,
        "  let detected = await runDetect(async (): Promise<DetectOutcome> => {",
        approvedPiCallbackBody,
        "  });",
        "  return detected;",
        "}",
        "",
      ].join("\n"),
    );
    expectRejectedPiDetailFixture(
      "callback runtimePath uses var instead of const",
      [
        "export async function probePiCapability(deps: PiProbeDeps = {}) {",
        approvedPiOuterPrefix,
        "  const detected = await runDetect(async (): Promise<DetectOutcome> => {",
        '    if (platform === "win32") { throw new Error("x"); }',
        "    var runtimePath = findOnPath(env);",
        '    if (runtimePath) return { installed: true, runtimeSource: "path", runtimePath };',
        "    return {",
        "      installed: false,",
        '      error: formatPiBinaryMissingMessage("no pi binary resolved on this host"),',
        "    };",
        "  });",
        "  return detected;",
        "}",
        "",
      ].join("\n"),
    );
    expectRejectedPiDetailFixture(
      "detected nested inside block instead of fourth top-level statement",
      [
        "export async function probePiCapability(deps: PiProbeDeps = {}) {",
        approvedPiOuterPrefix,
        "  {",
        "    const detected = await runDetect(async (): Promise<DetectOutcome> => {",
        approvedPiCallbackBody,
        "    });",
        "    return detected;",
        "  }",
        "}",
        "",
      ].join("\n"),
    );

    // Pi sanitizer must consume the Pi-detail seam entry (not a local table).
    const piHandler = readFileSync(join(clientSrc, "providers/pi/index.ts"), "utf8");
    expect(piHandler).toContain("piProviderDetailBinaryMissingReasonCode");
    expect(piHandler).toMatch(/runtime\/provider-support\/(?:index|binary-failure)/);
    expect(piHandler).not.toContain("isPiBinaryMissingError");
    expect(piHandler).not.toContain("PROVIDER_BINARY_FAILURE_REASON_CODES");
  });

  it("names only the concrete composition file as the built-in handler factory root", () => {
    const registry = readFileSync(join(clientSrc, "providers/builtin-registry.ts"), "utf8");
    expect(registry).toContain("createBuiltinHandlerRegistry");
    expect(registry).toContain("Object.freeze");
    expect(registry).toContain("satisfies Record<RuntimeProvider, HandlerFactory>");
    expect(registry).not.toContain("installBuiltinProviderRegistry");
    expect(registry).not.toContain("installedRegistry");
    expect(registry).not.toContain("createBuiltinProviderRegistry");
    expect(registry).not.toContain("BuiltinProviderRegistry");
    expect(registry).not.toContain("builtinRegistryProviderIds");
    expect(registry).not.toContain("HANDLER_REGISTRY");
    expect(registry).not.toContain("registerHandler");
    expect(registry).not.toContain("registerBuiltinHandlers");
    expect(registry).not.toMatch(/probe\s*:/);
    expect(registry).not.toMatch(/skillRoot\s*:/);
    expect(registry).not.toMatch(/\{\s*factory\s*:/);

    const probes = readFileSync(join(clientSrc, "providers/builtin-probes.ts"), "utf8");
    const skills = readFileSync(join(clientSrc, "providers/skill-roots.ts"), "utf8");
    expect(probes).toContain("Object.freeze");
    expect(probes).not.toContain("builtinProbeProviderIds");
    expect(skills).toContain("Object.freeze");
    expect(skills).not.toContain("assertSkillRootsComplete");
  });

  it("forbids process-global handler registry symbols and keeps CLI on the package entry", () => {
    const forbidden = [
      "HANDLER_REGISTRY",
      "registerHandler",
      "getHandlerFactory",
      "hasHandler",
      "registerBuiltinHandlers",
    ] as const;
    const productionFiles = listFilesRecursive(clientSrc, (p) => p.endsWith(".ts") && !p.includes("__tests__"));
    for (const file of productionFiles) {
      const source = readFileSync(file, "utf8");
      const rel = relative(clientSrc, file).replaceAll("\\", "/");
      for (const symbol of forbidden) {
        expect(source, `${rel} must not retain ${symbol}`).not.toMatch(new RegExp(`\\b${symbol}\\b`));
      }
    }

    // handlers/index.ts was the old process-global registration root — gone.
    expect(() => readFileSync(join(clientSrc, "providers/handlers/index.ts"), "utf8")).toThrow();

    const cliRuntime = readFileSync(join(repoRoot, "apps/cli/src/core/client-runtime.ts"), "utf8");
    expect(cliRuntime).toContain("createBuiltinHandlerRegistry");
    expect(cliRuntime).toContain("resolveAndLogClaudeExecutable");
    expect(cliRuntime).toContain('from "@first-tree/client"');
    expect(cliRuntime).not.toMatch(/from ["']@first-tree\/client\//);
    expect(cliRuntime).not.toMatch(/from ["']\.\.\/\.\.\/packages\/client/);
    for (const symbol of forbidden) {
      expect(cliRuntime, `CLI must not retain ${symbol}`).not.toMatch(new RegExp(`\\b${symbol}\\b`));
    }

    const agentRuntime = readFileSync(join(clientSrc, "runtime/runtime.ts"), "utf8");
    expect(agentRuntime).toContain("handlerFactories");
    expect(agentRuntime).not.toMatch(/\bgetHandlerFactory\b/);
    expect(agentRuntime).not.toMatch(/\bHANDLER_REGISTRY\b/);
  });

  it("keeps SessionRuntime/SessionManager/SessionRegistry off public barrels and out of CLI production", () => {
    const rootIndex = readFileSync(join(clientSrc, "index.ts"), "utf8");
    const runtimeIndex = readFileSync(join(clientSrc, "runtime/index.ts"), "utf8");
    for (const [label, source] of [
      ["packages/client/src/index.ts", rootIndex],
      ["packages/client/src/runtime/index.ts", runtimeIndex],
    ] as const) {
      expect(source, `${label} must not re-export SessionRuntime`).not.toMatch(/export\s*\{[^}]*\bSessionRuntime\b/);
      expect(source, `${label} must not re-export SessionManager`).not.toMatch(/export\s*\{[^}]*\bSessionManager\b/);
      expect(source, `${label} must not re-export SessionRegistry`).not.toMatch(/export\s*\{[^}]*\bSessionRegistry\b/);
      expect(source, `${label} must expose cleanAgentWorkspaces`).toContain("cleanAgentWorkspaces");
      // contracts entry is provider-internal, not a new package public API / barrel export.
      expect(source, `${label} must not re-export runtime/contracts`).not.toMatch(/runtime\/contracts/);
    }

    const cliProduction = listFilesRecursive(join(repoRoot, "apps/cli/src"), (p) => {
      return p.endsWith(".ts") && !p.includes("__tests__") && !p.includes("/__mocks__/");
    });
    for (const file of cliProduction) {
      const source = readFileSync(file, "utf8");
      const rel = relative(repoRoot, file).replaceAll("\\", "/");
      expect(source, `${rel} must not import SessionRegistry`).not.toMatch(/\bSessionRegistry\b/);
      expect(source, `${rel} must not import SessionRuntime`).not.toMatch(/\bSessionRuntime\b/);
      expect(source, `${rel} must not import SessionManager`).not.toMatch(/\bSessionManager\b/);
      expect(source, `${rel} must not call low-level cleanWorkspaces`).not.toMatch(/\bcleanWorkspaces\b/);
      expect(source, `${rel} must not deep-import client`).not.toMatch(/from ["']@first-tree\/client\//);
    }

    const cleanCommand = readFileSync(join(repoRoot, "apps/cli/src/commands/agent/workspace/clean.ts"), "utf8");
    expect(cleanCommand).toContain("cleanAgentWorkspaces");
    const clientImport = cleanCommand.match(/import\s*\{([^}]*)\}\s*from\s*["']@first-tree\/client["']/);
    expect(clientImport?.[1]?.replace(/\s+/g, " ").trim()).toBe("cleanAgentWorkspaces");
    expect(cleanCommand).toMatch(/const DEFAULT_WORKSPACE_TTL_MS = 7 \* 24 \* 60 \* 60 \* 1000/);
    expect(cleanCommand).not.toMatch(/\bfrom ["']node:fs["']/);
    expect(cleanCommand).not.toMatch(/\bfrom ["']node:path["']/);
    expect(cleanCommand).not.toContain("defaultDataDir");

    const maintenance = readFileSync(join(clientSrc, "runtime/workspace-maintenance.ts"), "utf8");
    const optionsMatch = maintenance.match(/export type CleanAgentWorkspacesOptions = \{([\s\S]*?)\n\};/);
    expect(optionsMatch?.[1], "CleanAgentWorkspacesOptions must be declared").toBeTruthy();
    const optionsBody = optionsMatch?.[1] ?? "";
    expect(optionsBody).toMatch(/\bagentName\?:/);
    expect(optionsBody).toMatch(/\bttlMs:/);
    expect(optionsBody).not.toMatch(/\bdataDir\b/);
    expect(optionsBody).not.toMatch(/\bcleanWorkspacesFn\b/);
    for (const [label, source] of [
      ["packages/client/src/index.ts", rootIndex],
      ["packages/client/src/runtime/index.ts", runtimeIndex],
    ] as const) {
      expect(source, `${label} must not re-export cleanAgentWorkspacesWithDeps`).not.toMatch(
        /\bcleanAgentWorkspacesWithDeps\b/,
      );
      expect(source, `${label} must not re-export CleanAgentWorkspacesTestDeps`).not.toMatch(
        /\bCleanAgentWorkspacesTestDeps\b/,
      );
    }

    const cliRuntime = readFileSync(join(repoRoot, "apps/cli/src/core/client-runtime.ts"), "utf8");
    expect(cliRuntime).toMatch(/resolveHandlerFactory[\s\S]*Object\.hasOwn/);
  });

  it("routes provider production contract imports through runtime/contracts only", () => {
    const contractSymbols = [
      "AgentHandler",
      "AgentIdentity",
      "DeliveryToken",
      "HandlerConfig",
      "HandlerFactory",
      "HandlerShutdownOptions",
      "SessionContext",
      "SessionMessage",
      "TurnConsumedErrorReason",
      "TurnOutcome",
      "noopDeliveryToken",
      "requireDeliveryToken",
      "LoginOutcome",
      "ReplayFenceEntry",
      "ReplayFenceWriter",
      "isTeamSkillCommandUnavailableError",
    ] as const;
    const forbiddenOwners = ["runtime/handler.js", "runtime/runtime-login.js", "runtime/replay-fence.js"] as const;

    const productionProviderFiles = [
      ...listFilesRecursive(
        join(clientSrc, "providers", "handlers"),
        (p) => p.endsWith(".ts") && !p.includes("__tests__"),
      ),
      ...listFilesRecursive(join(clientSrc, "providers"), (p) => p.endsWith(".ts") && !p.includes("__tests__")),
    ];

    for (const file of productionProviderFiles) {
      const source = readFileSync(file, "utf8");
      const rel = relative(clientSrc, file).replaceAll("\\", "/");
      for (const owner of forbiddenOwners) {
        expect(source, `${rel} must not deep-import ${owner}`).not.toMatch(
          new RegExp(`from\\s+["'][^"']*${owner.replace(".", "\\.")}["']`),
        );
      }
    }

    // Positive: at least the known contract consumers resolve contracts.js.
    const mustUseContracts = [
      "providers/claude/index.ts",
      "providers/claude/tui/index.ts",
      "providers/codex/index.ts",
      "providers/codex/sdk.ts",
      "providers/codex/app-server/index.ts",
      "providers/codex/turn-completion.ts",
      "providers/cursor/index.ts",
      "providers/grok/index.ts",
      "providers/kimi-code/index.ts",
      "providers/opencode/index.ts",
      "providers/pi/index.ts",
      "providers/amp/index.ts",
      "providers/deepseek-harness/index.ts",
      "providers/antigravity/index.ts",
      "providers/handlers/turn-settlement.ts",
      "providers/builtin-registry.ts",
      "providers/auth-driver.ts",
    ] as const;
    for (const rel of mustUseContracts) {
      const source = readFileSync(join(clientSrc, rel), "utf8");
      expect(source, `${rel} must import runtime/contracts.js`).toMatch(/runtime\/contracts\.js/);
    }

    // contracts entry itself stays an allowlist and does not import forbidden owners as values beyond the declared re-exports.
    const contractsSource = readFileSync(join(clientSrc, "runtime/contracts.ts"), "utf8");
    expect(contractsSource).toContain('from "./handler.js"');
    expect(contractsSource).toContain('from "./runtime-login.js"');
    expect(contractsSource).toContain('from "./replay-fence.js"');
    for (const name of contractSymbols) {
      expect(contractsSource, `contracts allowlist must mention ${name}`).toMatch(new RegExp(`\\b${name}\\b`));
    }
    for (const banned of [
      "SessionRuntime",
      "SessionManager",
      "SessionRegistry",
      "AgentSlot",
      "AgentRuntime",
      "ReplayFenceStore",
      "createBuiltinHandlerRegistry",
    ]) {
      expect(contractsSource, `contracts must not mention ${banned}`).not.toMatch(new RegExp(`\\b${banned}\\b`));
    }
  });

  it("keeps the runtime-auth driver projection in one frozen, schema-exhaustive composition root", () => {
    const drivers = readFileSync(join(clientSrc, "providers/auth-drivers.ts"), "utf8");
    expect(drivers).toContain("Object.freeze");
    // The key set is a projection of the narrow server-accepted auth enum, not
    // a second handwritten known-provider list.
    expect(drivers).toContain("satisfies Record<RuntimeAuthProvider, RuntimeAuthDriver>");
    for (const provider of runtimeAuthProviderSchema.options) {
      expect(drivers, `auth-drivers must register ${provider}`).toContain(provider);
    }
    // The contract itself stays provider-neutral.
    const contract = readFileSync(join(clientSrc, "providers/auth-driver.ts"), "utf8");
    expect(containsAnyProviderLiteral(contract)).toBeNull();
    // Method-shorthand type syntax (`resolveLogin(): ...`) is NOT readonly, so
    // the contract must declare its function members as readonly properties -
    // the compile-time half of the immutability guarantee that Object.freeze
    // on each production driver enforces at runtime.
    expect(contract).toContain("readonly resolveLogin");
    expect(contract).toContain("readonly reprobe");

    // Every provider-owned factory must freeze what it hands back, so the
    // guarantee holds regardless of how - or whether - it is composed into
    // RUNTIME_AUTH_DRIVERS.
    for (const rel of [
      "providers/claude/login.ts",
      "providers/codex/login.ts",
      "providers/cursor/login.ts",
      "providers/grok/login.ts",
    ]) {
      const source = readFileSync(join(clientSrc, rel), "utf8");
      expect(source, `${rel} must freeze its returned driver`).toContain("Object.freeze");
    }
  });

  it("keeps the daemon runtime-auth dispatcher free of provider literals, imports and branches", () => {
    const rel = "apps/cli/src/core/runtime-auth-login.ts";
    const source = readFileSync(join(repoRoot, rel), "utf8");

    expect(source).toContain("RUNTIME_AUTH_DRIVERS");
    const hit = containsAnyProviderLiteral(source);
    expect(hit, `${rel} must not contain provider literal ${hit}`).toBeNull();
    // Same file, narrower lens: the auth enum the dispatcher keys on, derived
    // from its own schema so a new in-product target cannot widen the registry
    // without widening this guard.
    for (const token of AUTH_PROVIDER_LITERAL_TOKENS) {
      expect(source, `${rel} must not contain auth provider literal ${token}`).not.toContain(token);
    }
    for (const provider of runtimeAuthProviderSchema.options) {
      expect(source, `${rel} must not branch on ${provider}`).not.toMatch(
        new RegExp(`(===|case)\\s*["']${provider}["']`),
      );
    }
    // No provider-specific resolver / probe / browser-login imports remain.
    expect(source).not.toMatch(/\b(resolve|probe|run)(Codex|Claude|Cursor|Grok)\w*/);
    // Published failure text goes through the shared redaction boundary.
    expect(source).toContain("redactErrorPreview");
    expect(source).toContain("RUNTIME_AUTH_ERROR_MAX_LEN");
  });

  it("keeps provider login output bounded and incrementally scanned", () => {
    const source = readFileSync(join(clientSrc, "providers/runtime-login.ts"), "utf8");
    expect(source).toContain("createAuthUrlScanner");
    expect(source).toContain("AUTH_URL_TOKEN_MAX");
    expect(source).toContain("LOGIN_STDERR_TAIL_MAX");
    // No full-output accumulation, and no full-buffer handoff to consumers.
    expect(source).not.toMatch(/\bbuffer\s*\+=/);
    expect(source).not.toMatch(/onOutput\?\.\([^)]*,/);
    // `pendingAuth.authUrl` is a structured field that never itself passes
    // through redactErrorPreview, so URL candidacy is the only gate that
    // keeps a credential-bearing string (proxy URL, redirect echo, a vendor
    // token under a neutral key, ...) out of the capability snapshot. It must
    // delegate to that exact sanitizer rather than re-check a subset of its
    // rules (a partial reimplementation would fall behind the moment that
    // helper gains a new detection rule), and it must reject a bad candidate
    // outright rather than rewrite it.
    expect(source).toContain("redactErrorPreview");
    expect(source).toContain("hasCredentialShape");
  });

  it("keeps third-party provider SDKs out of shared and web packages", () => {
    const sharedSrc = join(repoRoot, "packages/shared/src");
    const webSrc = join(repoRoot, "packages/web/src");
    const files = [
      ...listFilesRecursive(sharedSrc, (p) => p.endsWith(".ts") || p.endsWith(".tsx")),
      ...listFilesRecursive(webSrc, (p) => p.endsWith(".ts") || p.endsWith(".tsx")),
    ];

    for (const file of files) {
      const source = readFileSync(file, "utf8");
      for (const sdk of THIRD_PARTY_SDK_IMPORTS) {
        expect(source, `${relative(repoRoot, file)} must not import ${sdk}`).not.toContain(`from "${sdk}"`);
        expect(source, `${relative(repoRoot, file)} must not import ${sdk}`).not.toContain(`from '${sdk}'`);
      }
    }
  });

  it("keeps live catalog consumers on shared helpers (not parallel switches)", () => {
    const providersTs = readFileSync(
      join(repoRoot, "packages/web/src/pages/clients/cards/shared/providers.ts"),
      "utf8",
    );
    expect(providersTs).toContain("RUNTIME_PROVIDER_CATALOG");
    expect(providersTs).toContain("enabledRuntimeProviders");
    expect(providersTs).toContain("runtimeProviderInstallCommand");
    expect(providersTs).toContain("runtimeProviderInteractiveLoginCue");
    expect(providersTs).toContain("runtimeProviderShowsHostLoginOnSetup");
    expect(providersTs).toContain("runtimeProviderComputerSetupCommand");
    expect(providersTs).not.toContain("runtimeProviderInstallLoginCommand");
    expect(providersTs).toContain("recordByRuntimeProvider");
    expect(providersTs).toContain('case "codex"');
    expect(providersTs).toContain("const _exhaustive: never = provider");
    expect(providersTs).not.toContain("Install the OpenAI Codex CLI");
    expect(providersTs).not.toMatch(
      /export const PROVIDER_LABEL: Record<RuntimeProvider, string> = \{\s*"claude-code":/,
    );

    for (const rel of CATALOG_CONSUMER_FILES) {
      const source = readFileSync(join(repoRoot, rel), "utf8");
      if (rel.endsWith("new-agent-dialog.tsx")) {
        expect(source).toMatch(/\b(?:pickPreferredRuntimeProvider|resolveRuntimeSelection)\b/);
        expect(source).toContain("enabledOkRuntimeProviders");
        expect(source).toContain("runtimeProviderLabel");
        expect(source).toContain("PREFERRED_RUNTIME_PROVIDER");
        expect(source).not.toContain("Object.entries(activeCapabilities)");
        expect(source).not.toContain('provider === "claude-code"');
        expect(source).not.toContain('"claude-code"');
        expect(source).not.toMatch(/function prettyRuntimeLabel/);
        expect(source).not.toMatch(/function asRuntimeProvider/);
      }
      if (rel.endsWith("use-computer-connection.ts")) {
        expect(source).toMatch(/\b(?:pickPreferredRuntimeProvider|resolveRuntimeSelection)\b/);
        expect(source).toContain("enabledOkRuntimeProviders");
        expect(source).not.toContain("Object.entries(activeCapabilities)");
        expect(source).not.toMatch(/Object\.entries\([^)]*capabilities/);
        expect(source).not.toMatch(/function pickPreferredRuntime/);
        expect(source).not.toContain('"claude-code"');
        expect(source).not.toContain('"codex"');
      }
      if (rel.endsWith("step-create-agent.tsx") || rel.endsWith("step-connect-computer.tsx")) {
        expect(source).toMatch(/from "@first-tree\/shared"/);
        expect(source).toContain("runtimeProviderLabel");
        expect(source).not.toContain("clients/cards/shared/providers");
        expect(source).not.toContain("PROVIDER_LABEL");
        expect(source).not.toContain("Object.entries(");
        expect(source).not.toMatch(/r === ["']claude-code["']/);
        expect(source).not.toContain('"claude-code"');
        expect(source).not.toMatch(/function pickPreferred/);
      }
      if (rel.endsWith("bound-agents-list.tsx")) {
        expect(source).toContain("asRuntimeProvider");
        expect(source).toContain("runtimeProviderLabel");
        expect(source).not.toContain("Object.values(RUNTIME_PROVIDERS)");
        expect(source).not.toContain("KNOWN_RUNTIME_PROVIDERS");
        expect(source).not.toContain("PROVIDER_LABEL");
      }
      if (rel.endsWith("runtime-section.tsx")) {
        expect(source).toContain("runtimeProviderLabel");
        expect(source).not.toMatch(/const RUNTIME_NAME/);
      }
      if (rel.endsWith("runtime-auth-view.ts")) {
        expect(source).toContain("runtimeProviderInProductAuthTarget");
        expect(source).not.toContain("runtimeProviderAuthRecovery");
        const hit = containsAnyProviderLiteral(source);
        expect(hit, `${rel} must not hard-code auth target ${hit}`).toBeNull();
      }
      if (rel.endsWith("auth-error-hint.ts")) {
        expect(source).toContain("runtimeProviderChatAuthLoginPhrase");
        expect(source).toContain("runtimeProviderAuthOwnerLabel");
      }
      if (rel.endsWith("runtime-notice.ts")) {
        expect(source).toContain("runtimeProviderLabel");
      }
      if (
        rel.endsWith("providers/cursor/binary.ts") ||
        rel.endsWith("cursor/binary.ts") ||
        rel.endsWith("providers/grok/binary.ts") ||
        rel.endsWith("grok/binary.ts")
      ) {
        expect(source).toMatch(/from "@first-tree\/shared"/);
        expect(source).toContain("INSTALL_COMMAND");
      }
      if (rel.endsWith("providers/opencode/binary.ts") || rel.endsWith("opencode/binary.ts")) {
        expect(source).toContain("OPENCODE_MINIMUM_VERSION");
        expect(source).toContain("runtimeProviderInstallCommand");
      }
      if (rel.endsWith("providers/amp/binary.ts") || rel.endsWith("amp/binary.ts")) {
        expect(source).toMatch(/from "@first-tree\/shared"/);
        expect(source).toContain("AMP_INSTALL_COMMAND");
        expect(source).toContain("runtimeProviderLoginCommand");
      }
      if (rel.endsWith("providers/deepseek-harness/binary.ts") || rel.endsWith("deepseek/binary.ts")) {
        expect(source).toMatch(/from "@first-tree\/shared"/);
        expect(source).toContain("DEEPSEEK_INSTALL_NPM_PACKAGE");
        expect(source).toContain("runtimeProviderLoginCommand");
      }
      if (rel.endsWith("providers/pi/binary.ts") || rel.endsWith("pi/binary.ts")) {
        expect(source).toContain("runtimeProviderInstallCommand");
        expect(source).toContain("runtimeProviderInteractiveLoginCue");
        expect(source).not.toContain("running `pi` and entering `/login`");
        expect(source).not.toContain("`pi` and enter `/login`");
      }
      if (rel.endsWith("providers/claude/capability.ts")) {
        expect(source).toContain("runtimeProviderInstallCommand");
        expect(source).toContain("runtimeProviderLoginCommand");
        expect(source).toContain("daemon install-claude");
        expect(source).not.toContain("npm install -g @anthropic-ai/claude-code");
        expect(source).not.toContain("then run `claude auth login`");
      }
      if (rel.endsWith("providers/codex/binary.ts") || rel.endsWith("codex/binary.ts")) {
        expect(source).toContain("runtimeProviderInstallCommand");
        expect(source).toContain("runtimeProviderLoginCommand");
        expect(source).toContain("daemon install-codex");
        expect(source).not.toContain("npm install -g @openai/codex");
        expect(source).not.toContain("then run `codex login`");
      }
      if (rel.endsWith("providers/kimi-code/binary.ts") || rel.endsWith("kimi-code/binary.ts")) {
        expect(source).toContain("KIMI_NPM_PACKAGE");
        expect(source).toContain("runtimeProviderInstallCommand");
        expect(source).toContain("runtimeProviderInteractiveLoginCue");
        expect(source).not.toContain('KIMI_CLI_PACKAGE = "@moonshot-ai/kimi-code"');
        expect(source).not.toMatch(/npm install -g \$\{KIMI_CLI_PACKAGE\}/);
        expect(source).not.toContain("then run `kimi` and enter `/login`");
      }
      if (rel.endsWith("providers.ts")) {
        expect(source).not.toContain("@moonshot-ai/kimi-code");
        expect(source).not.toContain("@earendil-works/pi-coding-agent");
        expect(source).not.toContain("Install the OpenAI Codex CLI");
        expect(source).not.toContain("run `kimi`, then `/login`");
        expect(source).not.toContain("run `pi` and enter `/login`");
      }
    }

    const activityTs = readFileSync(join(repoRoot, "packages/web/src/api/activity.ts"), "utf8");
    expect(activityTs).toContain("RuntimeAuthStartRequest");
    expect(activityTs).not.toMatch(/provider:\s*RuntimeProvider/);
  });

  it("fail-closes provider-side Runtime imports to contracts or provider-support/index only", () => {
    /**
     * Fail-closed classification for provider-side production code.
     *
     * Provider-side files: handlers/**, providers/** (including feature-first
     * family roots such as providers/grok/**), and the exact transitional
     * provider-family modules listed in TRANSITIONAL_PROVIDER_FAMILY_FILES.
     * For any import that resolves into
     * `runtime/`, the only legal targets are:
     *   - runtime/contracts.js
     *   - runtime/provider-support/index.js
     *   - an exact transitional provider-owned module from that list
     * Every other runtime path — including provider-support/<group>.js and
     * newly named `*-login` / `*-binary` files — fails closed because it is
     * absent from the explicit allowlist.
     */
    const transitionalTargets = new Set(TRANSITIONAL_PROVIDER_FAMILY_FILES.map((rel) => rel.replace(/\.ts$/, ".js")));

    // Explicit list must stay in sync with on-disk transitional modules.
    for (const rel of TRANSITIONAL_PROVIDER_FAMILY_FILES) {
      expect(existsSync(join(clientSrc, rel)), `missing transitional file ${rel}`).toBe(true);
    }
    // Pattern-shaped newcomers are NOT automatically trusted.
    expect(transitionalTargets.has("runtime/brand-new-login.js")).toBe(false);
    expect(transitionalTargets.has("runtime/brand-new-binary.js")).toBe(false);

    function listProviderSideFiles(): string[] {
      return [
        ...listFilesRecursive(
          join(clientSrc, "providers", "handlers"),
          (p) => p.endsWith(".ts") && !p.includes("__tests__"),
        ),
        ...listFilesRecursive(join(clientSrc, "providers"), (p) => p.endsWith(".ts") && !p.includes("__tests__")),
        ...TRANSITIONAL_PROVIDER_FAMILY_FILES.map((rel) => join(clientSrc, rel)),
      ];
    }

    /** Resolve an import specifier from `fromFile` into a runtime/*.js path, or null. */
    function resolveRuntimeImport(fromFile: string, specifier: string): string | null {
      if (!specifier.endsWith(".js")) return null;
      if (specifier.startsWith("@") || specifier.startsWith("node:")) return null;
      const fromDir = dirname(fromFile);
      let absolute: string;
      if (specifier.startsWith(".")) {
        absolute = join(fromDir, specifier);
      } else if (specifier.includes("/runtime/")) {
        // unusual but tolerate
        absolute = join(clientSrc, specifier.slice(specifier.indexOf("runtime/")));
      } else {
        return null;
      }
      const rel = relative(clientSrc, absolute).replaceAll("\\", "/");
      if (!rel.startsWith("runtime/") || rel.includes("..")) return null;
      return rel;
    }

    function classifyRuntimeImport(runtimeRel: string): "ok" | "forbidden" {
      if (runtimeRel === "runtime/contracts.js") return "ok";
      if (runtimeRel === "runtime/provider-support/index.js") return "ok";
      if (transitionalTargets.has(runtimeRel)) return "ok";
      return "forbidden";
    }

    const violations: string[] = [];
    const residualByClass = {
      contracts: [] as string[],
      providerSupportIndex: [] as string[],
      transitionalTarget: [] as string[],
      forbiddenRuntime: [] as string[],
    };

    for (const file of listProviderSideFiles()) {
      const source = readFileSync(file, "utf8");
      const rel = relative(clientSrc, file).replaceAll("\\", "/");
      const refs = extractModuleReferences(source);
      if (refs.hasUnresolvableModuleReference) {
        violations.push(
          `${rel} has a non-literal / unclassifiable module reference; provider-side Runtime edges must be statically classifiable (fail-closed)`,
        );
      }
      for (const spec of refs.literalSpecifiers) {
        const runtimeRel = resolveRuntimeImport(file, spec);
        if (!runtimeRel) continue;
        const verdict = classifyRuntimeImport(runtimeRel);
        if (verdict === "ok") {
          if (runtimeRel === "runtime/contracts.js") residualByClass.contracts.push(`${rel} -> ${runtimeRel}`);
          else if (runtimeRel === "runtime/provider-support/index.js")
            residualByClass.providerSupportIndex.push(`${rel} -> ${runtimeRel}`);
          else residualByClass.transitionalTarget.push(`${rel} -> ${runtimeRel}`);
        } else {
          residualByClass.forbiddenRuntime.push(`${rel} -> ${runtimeRel} (via ${spec})`);
          violations.push(`${rel} imports forbidden Runtime module ${runtimeRel} (specifier ${spec})`);
        }
      }
    }

    expect(violations, violations.join("\n")).toEqual([]);
    // Mechanically supported residual report for the review freeze note.
    expect(residualByClass.forbiddenRuntime).toEqual([]);
    expect(residualByClass.providerSupportIndex.length).toBeGreaterThan(0);

    // Negative fixtures: newly introduced Runtime owners / deep support paths fail closed.
    expect(classifyRuntimeImport("runtime/brand-new-owner.js")).toBe("forbidden");
    expect(classifyRuntimeImport("runtime/provider-support/preparation.js")).toBe("forbidden");
    expect(classifyRuntimeImport("runtime/provider-support/binary-failure.js")).toBe("forbidden");
    expect(classifyRuntimeImport("runtime/agent-io.js")).toBe("forbidden");
    expect(classifyRuntimeImport("runtime/install-locations.js")).toBe("forbidden");
    expect(classifyRuntimeImport("runtime/brand-new-login.js")).toBe("forbidden");
    expect(classifyRuntimeImport("runtime/brand-new-binary.js")).toBe("forbidden");

    const cursorHandler = join(clientSrc, "providers/cursor/index.ts");
    function expectForbiddenRuntimeSpec(source: string, expectedSpec: string): void {
      const refs = extractModuleReferences(source);
      expect(refs.hasUnresolvableModuleReference).toBe(false);
      expect(refs.literalSpecifiers).toContain(expectedSpec);
      const resolved = resolveRuntimeImport(cursorHandler, expectedSpec);
      expect(resolved).toBe("runtime/brand-new-owner.js");
      expect(classifyRuntimeImport(resolved ?? "")).toBe("forbidden");
    }

    // Bare side-effect import (no bindings) must still be classified.
    expectForbiddenRuntimeSpec(`import "../../runtime/brand-new-owner.js";`, "../../runtime/brand-new-owner.js");

    // Literal dynamic import must still be classified.
    expectForbiddenRuntimeSpec(`await import("../../runtime/brand-new-owner.js");`, "../../runtime/brand-new-owner.js");

    // Import type query (`ImportTypeNode`) must still be classified.
    expectForbiddenRuntimeSpec(
      `type Hidden = import("../../runtime/brand-new-owner.js").Hidden;`,
      "../../runtime/brand-new-owner.js",
    );

    // External import-equals (`import x = require("…")`) must still be classified.
    expectForbiddenRuntimeSpec(
      `import Owner = require("../../runtime/brand-new-owner.js");`,
      "../../runtime/brand-new-owner.js",
    );

    // Immediate createRequire(…)("…") CommonJS load must still be classified.
    expectForbiddenRuntimeSpec(
      `import { createRequire } from "node:module";
       createRequire(import.meta.url)("../../runtime/brand-new-owner.js");`,
      "../../runtime/brand-new-owner.js",
    );

    // Aliased createRequire binder call must still be classified.
    expectForbiddenRuntimeSpec(
      `import { createRequire } from "node:module";
       const req = createRequire(import.meta.url);
       req("../../runtime/brand-new-owner.js");`,
      "../../runtime/brand-new-owner.js",
    );

    // Renamed createRequire import + binder call must still be classified.
    expectForbiddenRuntimeSpec(
      `import { createRequire as cr } from "node:module";
       const load = cr(import.meta.url);
       load("../../runtime/brand-new-owner.js");`,
      "../../runtime/brand-new-owner.js",
    );

    // Namespace import `import * as module from "node:module"` must still be classified.
    expectForbiddenRuntimeSpec(
      `import * as module from "node:module";
       const req = module.createRequire(import.meta.url);
       req("../../runtime/brand-new-owner.js");`,
      "../../runtime/brand-new-owner.js",
    );

    // Namespace import under a non-`module` local name (yzw-codex fixture).
    expectForbiddenRuntimeSpec(
      `import * as moduleApi from "node:module";
       const load = moduleApi.createRequire(import.meta.url);
       load("../../runtime/brand-new-owner.js");`,
      "../../runtime/brand-new-owner.js",
    );

    // Namespace string-key destructured createRequire alias (baixiaohang exact fixture).
    expectForbiddenRuntimeSpec(
      `import * as nodeModule from "node:module";
       const { "createRequire": makeRequire } = nodeModule;
       const load = makeRequire(import.meta.url);
       load("../../runtime/brand-new-owner.js");`,
      "../../runtime/brand-new-owner.js",
    );

    // Simple binder propagation (`const load = req`) must still be classified.
    expectForbiddenRuntimeSpec(
      `import { createRequire } from "node:module";
       const req = createRequire(import.meta.url);
       const load = req;
       load("../../runtime/brand-new-owner.js");`,
      "../../runtime/brand-new-owner.js",
    );

    // Free require("…") CommonJS load must still be classified.
    expectForbiddenRuntimeSpec(`require("../../runtime/brand-new-owner.js");`, "../../runtime/brand-new-owner.js");

    // Aliased / multiline static import continues to fail closed.
    const multilineFixture = `
      import {
        prepareManagedSession as prep,
        type ChatContext as Ctx,
      } from "../../runtime/agent-bootstrap.js";
    `;
    const multilineRefs = extractModuleReferences(multilineFixture);
    expect(multilineRefs.literalSpecifiers).toEqual(["../../runtime/agent-bootstrap.js"]);
    const resolvedMultiline = resolveRuntimeImport(cursorHandler, multilineRefs.literalSpecifiers[0] ?? "");
    expect(resolvedMultiline).toBe("runtime/agent-bootstrap.js");
    expect(classifyRuntimeImport(resolvedMultiline ?? "")).toBe("forbidden");

    // Non-literal dynamic import cannot be classified → fail closed.
    const unresolvableDynamic = extractModuleReferences(`const p = "./x.js"; await import(p);`);
    expect(unresolvableDynamic.hasUnresolvableModuleReference).toBe(true);
    expect(unresolvableDynamic.literalSpecifiers).toEqual([]);

    // Non-literal import-equals require() → fail closed.
    const unresolvableEquals = extractModuleReferences(`import Owner = require(someVar);`);
    expect(unresolvableEquals.hasUnresolvableModuleReference).toBe(true);
    expect(unresolvableEquals.literalSpecifiers).toEqual([]);

    // Non-literal createRequire binder call → fail closed.
    const unresolvableCjs = extractModuleReferences(`
      import { createRequire } from "node:module";
      const req = createRequire(import.meta.url);
      req(someVar);
    `);
    expect(unresolvableCjs.hasUnresolvableModuleReference).toBe(true);
    expect(unresolvableCjs.literalSpecifiers).toEqual(["node:module"]);

    // Unsupported `*.createRequire` (not a tracked node:module namespace) → fail closed.
    const unresolvableNsCreateRequire = extractModuleReferences(`
      const req = someApi.createRequire(import.meta.url);
      req("../../runtime/brand-new-owner.js");
    `);
    expect(unresolvableNsCreateRequire.hasUnresolvableModuleReference).toBe(true);

    // Default-import property alias is untracked → fail closed (not namespace import).
    const defaultImportPropAlias = extractModuleReferences(`
      import moduleApi from "node:module";
      const cr = moduleApi.createRequire;
      const load = cr(import.meta.url);
      load("../../runtime/brand-new-owner.js");
    `);
    expect(defaultImportPropAlias.hasUnresolvableModuleReference).toBe(true);
    expect(defaultImportPropAlias.literalSpecifiers).toEqual(["node:module"]);

    // Dynamic-import namespace property alias is untracked → fail closed.
    const dynamicImportPropAlias = extractModuleReferences(`
      const moduleApi = await import("node:module");
      const cr = moduleApi.createRequire;
      const load = cr(import.meta.url);
      load("../../runtime/brand-new-owner.js");
    `);
    expect(dynamicImportPropAlias.hasUnresolvableModuleReference).toBe(true);
    expect(dynamicImportPropAlias.literalSpecifiers).toEqual(["node:module"]);

    // Free `require` alias must still classify the literal load.
    expectForbiddenRuntimeSpec(
      `const load = require;
       load("../../runtime/brand-new-owner.js");`,
      "../../runtime/brand-new-owner.js",
    );

    // Namespace factory property alias must still classify the binder load.
    expectForbiddenRuntimeSpec(
      `import * as moduleApi from "node:module";
       const cr = moduleApi.createRequire;
       const load = cr(import.meta.url);
       load("../../runtime/brand-new-owner.js");`,
      "../../runtime/brand-new-owner.js",
    );

    // Property storage of a known binder → fail closed (unsupported escape).
    const propEscape = extractModuleReferences(`
      import { createRequire } from "node:module";
      const req = createRequire(import.meta.url);
      const box = { load: req };
      box.load("../../runtime/brand-new-owner.js");
    `);
    expect(propEscape.hasUnresolvableModuleReference).toBe(true);

    // Passing a known binder as a call argument → fail closed.
    const argEscape = extractModuleReferences(`
      import { createRequire } from "node:module";
      const req = createRequire(import.meta.url);
      consume(req);
    `);
    expect(argEscape.hasUnresolvableModuleReference).toBe(true);

    // Package-resolution `.resolve(...)` is not a direct module-edge load.
    const resolveOnly = extractModuleReferences(`
      import { createRequire } from "node:module";
      const req = createRequire(import.meta.url);
      req.resolve("../../runtime/brand-new-owner.js");
    `);
    expect(resolveOnly.hasUnresolvableModuleReference).toBe(false);
    expect(resolveOnly.literalSpecifiers).toEqual(["node:module"]);

    const mustUseProviderSupport = [
      "providers/claude/index.ts",
      "providers/claude/tui/index.ts",
      "providers/codex/sdk.ts",
      "providers/codex/app-server/index.ts",
      "providers/cursor/index.ts",
      "providers/grok/index.ts",
      "providers/kimi-code/index.ts",
      "providers/opencode/index.ts",
      "providers/pi/index.ts",
      "providers/amp/index.ts",
      "providers/deepseek-harness/index.ts",
      "providers/antigravity/index.ts",
    ] as const;
    for (const rel of mustUseProviderSupport) {
      const source = readFileSync(join(clientSrc, rel), "utf8");
      expect(source, `${rel} must import provider-support/index.js`).toMatch(/runtime\/provider-support\/index\.js/);
      expect(source, `${rel} must call prepareManagedSession`).toMatch(/\bprepareManagedSession\b/);
      expect(source, `${rel} must not call acquireAgentHome directly`).not.toMatch(/\bacquireAgentHome\s*\(/);
      expect(source, `${rel} must not call markWorkspaceInitComplete directly`).not.toMatch(
        /\bmarkWorkspaceInitComplete\s*\(/,
      );
      expect(source, `${rel} must not call ensureAgentBootstrap directly`).not.toMatch(/\bensureAgentBootstrap\s*\(/);
      expect(source, `${rel} must not deep-import provider-support groups`).not.toMatch(
        /provider-support\/(?!index\.js)[\w-]+\.js/,
      );
    }
  });

  it("pins provider-support entry and group modules to exact AST export allowlists", () => {
    /**
     * Exact `(kind, exportedName, originalName, sourceModule)` tuples — not
     * substring / banned-name predicates. Adding any seam symbol requires an
     * explicit allowlist edit in provider-support-export-allowlists.ts.
     */
    function hasExportKeyword(node: ts.Node): boolean {
      return ts.canHaveModifiers(node) && !!ts.getModifiers(node)?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
    }

    function hasDefaultKeyword(node: ts.Node): boolean {
      return ts.canHaveModifiers(node) && !!ts.getModifiers(node)?.some((m) => m.kind === ts.SyntaxKind.DefaultKeyword);
    }

    function extractExportTuples(source: string): {
      tuples: string[];
      violations: string[];
    } {
      const sourceFile = ts.createSourceFile("exports.ts", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
      const tuples: string[] = [];
      const violations: string[] = [];

      for (const node of sourceFile.statements) {
        let handled = false;

        if (ts.isExportDeclaration(node)) {
          handled = true;
          if (node.moduleSpecifier && !ts.isStringLiteralLike(node.moduleSpecifier)) {
            violations.push("non-literal export module specifier");
          } else if (!node.exportClause && node.moduleSpecifier) {
            violations.push(
              `export * from ${ts.isStringLiteralLike(node.moduleSpecifier) ? node.moduleSpecifier.text : "?"}`,
            );
          } else if (node.exportClause && ts.isNamespaceExport(node.exportClause)) {
            violations.push("export * as namespace");
          } else if (node.exportClause && ts.isNamedExports(node.exportClause)) {
            const sourceModule =
              node.moduleSpecifier && ts.isStringLiteralLike(node.moduleSpecifier)
                ? node.moduleSpecifier.text
                : "<local>";
            for (const el of node.exportClause.elements) {
              const kind = node.isTypeOnly || el.isTypeOnly ? "type" : "value";
              const exportedName = el.name.text;
              const originalName = el.propertyName ? el.propertyName.text : exportedName;
              tuples.push(`${kind}|${exportedName}|${originalName}|${sourceModule}`);
            }
          } else {
            violations.push("unsupported ExportDeclaration shape");
          }
        } else if (ts.isExportAssignment(node)) {
          handled = true;
          violations.push(node.isExportEquals ? "export =" : "export default");
        } else if (ts.isFunctionDeclaration(node) && hasExportKeyword(node)) {
          handled = true;
          if (hasDefaultKeyword(node)) {
            violations.push("export default function");
          } else if (!node.name) {
            violations.push("unnamed exported function");
          } else {
            tuples.push(`value|${node.name.text}|${node.name.text}|<local>`);
          }
        } else if (ts.isClassDeclaration(node) && hasExportKeyword(node)) {
          // Local class exports are unused on the seam today — fail closed rather
          // than inventing an undocumented tuple kind.
          handled = true;
          if (hasDefaultKeyword(node)) {
            violations.push("export default class");
          } else {
            violations.push("unsupported exported local class");
          }
        } else if (ts.isInterfaceDeclaration(node) && hasExportKeyword(node)) {
          handled = true;
          if (hasDefaultKeyword(node)) {
            violations.push("export default interface");
          } else {
            tuples.push(`type|${node.name.text}|${node.name.text}|<local>`);
          }
        } else if (ts.isTypeAliasDeclaration(node) && hasExportKeyword(node)) {
          handled = true;
          if (hasDefaultKeyword(node)) {
            violations.push("export default type alias");
          } else {
            tuples.push(`type|${node.name.text}|${node.name.text}|<local>`);
          }
        } else if (ts.isEnumDeclaration(node) && hasExportKeyword(node)) {
          handled = true;
          if (hasDefaultKeyword(node)) {
            violations.push("export default enum");
          } else {
            violations.push("unsupported exported local enum");
          }
        } else if (ts.isVariableStatement(node) && hasExportKeyword(node)) {
          handled = true;
          if (hasDefaultKeyword(node)) {
            violations.push("export default variable");
          } else {
            for (const decl of node.declarationList.declarations) {
              if (ts.isIdentifier(decl.name)) {
                tuples.push(`value|${decl.name.text}|${decl.name.text}|<local>`);
              } else {
                violations.push("exported binding pattern");
              }
            }
          }
        } else if (ts.isModuleDeclaration(node) && hasExportKeyword(node)) {
          handled = true;
          violations.push("exported namespace/module");
        } else if (ts.isImportEqualsDeclaration(node) && hasExportKeyword(node)) {
          handled = true;
          violations.push("unsupported export import equals");
        } else if (ts.isNamespaceExportDeclaration(node)) {
          // `export as namespace Foo;` — canHaveModifiers is false, so the
          // ExportKeyword catch-all would miss it.
          handled = true;
          violations.push("unsupported export as namespace");
        }

        // Catch-all: any ExportKeyword statement that no supported branch owned.
        if (!handled && hasExportKeyword(node)) {
          violations.push(`unsupported exported declaration ${ts.SyntaxKind[node.kind]}`);
        }
      }

      return { tuples: [...tuples].sort(), violations };
    }

    const supportDir = join(clientSrc, "runtime/provider-support");
    let totalTuples = 0;
    for (const [relKey, expected] of Object.entries(PROVIDER_SUPPORT_EXPORT_ALLOWLISTS)) {
      const fileRel = `runtime/provider-support/${relKey}.ts`;
      const absolute = join(supportDir, `${relKey}.ts`);
      expect(existsSync(absolute), `missing support module ${fileRel}`).toBe(true);
      const source = readFileSync(absolute, "utf8");
      const { tuples, violations } = extractExportTuples(source);
      expect(violations, `${fileRel} export-shape violations:\n${violations.join("\n")}`).toEqual([]);
      expect(tuples, `${fileRel} export tuple mismatch`).toEqual([...expected]);
      totalTuples += tuples.length;
    }
    expect(totalTuples).toBeGreaterThan(100);

    // Negative: registry owner named re-export on the entry must diverge.
    const entrySource = readFileSync(join(supportDir, "index.ts"), "utf8");
    const registryInjection = `${entrySource}\nexport { getChildProcessRegistry } from "../child-process-registry.js";\n`;
    const injected = extractExportTuples(registryInjection);
    expect(injected.violations).toEqual([]);
    expect(injected.tuples).not.toEqual([...PROVIDER_SUPPORT_EXPORT_ALLOWLISTS.index]);
    expect(injected.tuples).toContain(
      "value|getChildProcessRegistry|getChildProcessRegistry|../child-process-registry.js",
    );

    // Negative: extra local symbol on a group module must diverge.
    const prepSource = readFileSync(join(supportDir, "preparation.ts"), "utf8");
    const sneakyLocal = `${prepSource}\nexport function sneakyExtraHelper(): void {}\n`;
    const sneaky = extractExportTuples(sneakyLocal);
    expect(sneaky.violations).toEqual([]);
    expect(sneaky.tuples).not.toEqual([...PROVIDER_SUPPORT_EXPORT_ALLOWLISTS.preparation]);
    expect(sneaky.tuples).toContain("value|sneakyExtraHelper|sneakyExtraHelper|<local>");

    // Negative: export * fail-closed.
    const starExport = extractExportTuples(`export * from "../child-process-registry.js";`);
    expect(starExport.violations).toContain("export * from ../child-process-registry.js");

    // Negative: default exports must not be mistaken for named local tuples.
    expect(extractExportTuples(`export default function namedDefault() {}`).violations).toContain(
      "export default function",
    );
    expect(extractExportTuples(`export default class NamedDefault {}`).violations).toContain("export default class");

    // Negative: export import equals is unsupported (catch-all / dedicated branch).
    expect(extractExportTuples(`export import Owner = require("../child-process-registry.js");`).violations).toContain(
      "unsupported export import equals",
    );

    // Negative: unsupported local class/enum fail closed (not silently tupled).
    expect(extractExportTuples(`export class LocalOwner {}`).violations).toContain("unsupported exported local class");
    expect(extractExportTuples(`export enum LocalKind { A }`).violations).toContain("unsupported exported local enum");

    // Negative: `export as namespace` is NamespaceExportDeclaration (no modifiers).
    expect(extractExportTuples(`export as namespace Sneaky;`).violations).toContain("unsupported export as namespace");
  });

  it("keeps provider-support value re-exports identical to their owning group modules", async () => {
    const entry = await import("../runtime/provider-support/index.js");
    const preparation = await import("../runtime/provider-support/preparation.js");
    const hostRuntime = await import("../runtime/provider-support/host-runtime.js");
    const turnInput = await import("../runtime/provider-support/turn-input.js");
    const failurePolicy = await import("../runtime/provider-support/failure-policy.js");
    const attachmentAvailability = await import("../runtime/provider-support/attachment-availability.js");

    expect(entry.prepareManagedSession).toBe(preparation.prepareManagedSession);
    expect(entry.projectManagedWorkspace).toBe(preparation.projectManagedWorkspace);
    expect(entry.wellKnownBinDirs).toBe(hostRuntime.wellKnownBinDirs);
    expect(entry.acquireWorkspaceFileLock).toBe(hostRuntime.acquireWorkspaceFileLock);
    expect(entry.InputController).toBe(turnInput.InputController);
    expect(entry.recognizeProviderBinaryFailure).toBe(failurePolicy.recognizeProviderBinaryFailure);
    expect(entry.isAttachmentGoneError).toBe(attachmentAvailability.isAttachmentGoneError);
    expect(entry.ATTACHMENT_UNAVAILABLE_NOTE).toBe(attachmentAvailability.ATTACHMENT_UNAVAILABLE_NOTE);
  });

  it("keeps generic Runtime free of handler and concrete provider implementation imports", () => {
    const runtimeRoot = join(clientSrc, "runtime");
    // Scan the full runtime tree, including capabilities/; only exact
    // transitional paths are exempt — basename / directory patterns are not.
    const runtimeFiles = listFilesRecursive(runtimeRoot, (p) => p.endsWith(".ts") && !p.includes("__tests__"));
    const transitionalRelPaths = new Set<string>(TRANSITIONAL_PROVIDER_FAMILY_FILES);

    function isExplicitTransitionalProviderFamilyPath(rel: string): boolean {
      return transitionalRelPaths.has(rel);
    }

    expect(TRANSITIONAL_PROVIDER_FAMILY_FILES).toHaveLength(0);
    expect(isExplicitTransitionalProviderFamilyPath("providers/capabilities/index.ts")).toBe(false);
    expect(isExplicitTransitionalProviderFamilyPath("runtime/brand-new/index.ts")).toBe(false);
    expect(isExplicitTransitionalProviderFamilyPath("runtime/capabilities/brand-new.ts")).toBe(false);
    expect(isExplicitTransitionalProviderFamilyPath("runtime/opencode-binary.ts")).toBe(false);

    for (const file of runtimeFiles) {
      const rel = relative(clientSrc, file).replaceAll("\\", "/");
      if (isExplicitTransitionalProviderFamilyPath(rel)) continue;
      const source = readFileSync(file, "utf8");
      const violations = concreteProviderModuleEdgeViolations(file, source);
      expect(violations, `${rel} concrete-provider module-edge violations:\n${violations.join("\n")}`).toEqual([]);
    }
  });

  it("fail-closes concrete provider-family module edges via AST + normalized targets", () => {
    // Mutation matrix: same predicate the recursive Runtime scan uses. Synthetic
    // importer paths cover Runtime root and nested capabilities/.
    const runtimeRootImporter = join(clientSrc, "runtime", "synthetic-guard-importer.ts");
    const capabilitiesImporter = join(clientSrc, "runtime", "capabilities", "synthetic-guard-importer.ts");
    const managedSkillsImporter = join(clientSrc, "runtime", "managed-skills.ts");

    // Every deleted OpenCode/Pi/shared-capability owner + current family /
    // shared-foundation targets must fail via real module-edge extraction
    // (not classifier-only booleans). Mix edge forms across the set.
    const mustFail: Array<{ importer: string; source: string; note: string }> = [
      // --- 12 deleted owners from this S3 final slice ---
      {
        importer: runtimeRootImporter,
        source: `import { createOpenCodeHandler } from "../providers/handlers/opencode/index.js";\n`,
        note: "deleted opencode handler index static",
      },
      {
        importer: capabilitiesImporter,
        source: `import "../../handlers/opencode/parser.js";\n`,
        note: "deleted opencode parser nested bare",
      },
      {
        importer: runtimeRootImporter,
        source: `await import("./opencode-binary.js");\n`,
        note: "deleted opencode-binary dynamic",
      },
      {
        importer: runtimeRootImporter,
        source: `export { acquireOpenCodePrivateConfigLease } from "./opencode-private-config.js";\n`,
        note: "deleted opencode-private-config export-from",
      },
      {
        importer: capabilitiesImporter,
        source: `import type { OpenCodeProbeDeps } from "./opencode.js";\nvoid null as unknown as OpenCodeProbeDeps;\n`,
        note: "deleted capabilities/opencode import-type",
      },
      {
        importer: runtimeRootImporter,
        source: `import "../handlers/pi/index.js";\n`,
        note: "deleted pi handler index bare",
      },
      {
        importer: capabilitiesImporter,
        source: `import PiRpc = require("../../handlers/pi/rpc-client.js");\nvoid PiRpc;\n`,
        note: "deleted pi rpc-client import-equals",
      },
      {
        importer: capabilitiesImporter,
        source: `import { findPiExecutableOnPath } from "../pi-binary.js";\n`,
        note: "deleted pi-binary nested static",
      },
      {
        importer: runtimeRootImporter,
        source: `export { probePiCapability } from "./capabilities/pi.js";\n`,
        note: "deleted capabilities/pi export-from",
      },
      {
        importer: runtimeRootImporter,
        source: `import { runDetect } from "./capabilities/detect.js";\n`,
        note: "deleted capabilities/detect static",
      },
      {
        importer: capabilitiesImporter,
        source: `await import("./index.js");\n`,
        note: "deleted capabilities/index nested dynamic",
      },
      {
        importer: runtimeRootImporter,
        source: `import type { LaunchProbeResult } from "./capabilities/launch-probe.js";\nvoid null as unknown as LaunchProbeResult;\n`,
        note: "deleted capabilities/launch-probe import-type",
      },
      // --- new family + shared foundation reverse-load ---
      {
        importer: runtimeRootImporter,
        source: `await import("../providers/opencode/index.js");\n`,
        note: "family opencode dynamic",
      },
      {
        importer: capabilitiesImporter,
        source: `import { createPiHandler } from "../../providers/pi/index.js";\n`,
        note: "family pi nested static",
      },
      {
        importer: runtimeRootImporter,
        source: `export { createOpenCodeHandler } from "../providers/opencode/index.js";\n`,
        note: "family opencode export-from",
      },
      {
        importer: runtimeRootImporter,
        source: `import type { PiProbeDeps } from "../providers/pi/capability.js";\nvoid null as unknown as PiProbeDeps;\n`,
        note: "family pi capability import-type",
      },
      {
        importer: runtimeRootImporter,
        source: `import OpenCode = require("../providers/opencode/binary.js");\nvoid OpenCode;\n`,
        note: "family opencode binary import-equals",
      },
      {
        importer: runtimeRootImporter,
        source: `import { probeCapabilities } from "../providers/capabilities/index.js";\n`,
        note: "shared providers/capabilities/index reverse-load",
      },
      {
        importer: capabilitiesImporter,
        source: `import "../../providers/capabilities/detect.js";\n`,
        note: "shared providers/capabilities/detect nested bare",
      },
      {
        importer: runtimeRootImporter,
        source: `await import("../providers/capabilities/launch-probe.js");\n`,
        note: "shared providers/capabilities/launch-probe dynamic",
      },
      // --- prior S3 Cursor/Kimi durability (must not regress) ---
      {
        importer: runtimeRootImporter,
        source: `import { createCursorHandler } from "../providers/handlers/cursor/index.js";\n`,
        note: "legacy cursor handler static",
      },
      {
        importer: runtimeRootImporter,
        source: `import { createKimiCodeHandler } from "../providers/handlers/kimi-code.js";\n`,
        note: "legacy kimi handler static",
      },
      {
        importer: runtimeRootImporter,
        source: `import { createCursorHandler } from "../providers/cursor/index.js";\n`,
        note: "family cursor static",
      },
      {
        importer: runtimeRootImporter,
        source: `import "../providers/kimi-code/index.js";\n`,
        note: "family kimi bare side-effect",
      },
      {
        importer: capabilitiesImporter,
        source: `import { resolveCursorRuntimeBinary } from "../cursor-binary.js";\n`,
        note: "nested legacy cursor-binary",
      },
      {
        importer: runtimeRootImporter,
        source: `import { createCursorAuthDriver } from "./cursor-login.js";\n`,
        note: "legacy cursor-login static",
      },
      {
        importer: runtimeRootImporter,
        source: `import { probeCursorCapability } from "./capabilities/cursor.js";\n`,
        note: "legacy capabilities/cursor static",
      },
      {
        importer: runtimeRootImporter,
        source: `export { discoverProviderModels } from "./capabilities/discover-models.js";\n`,
        note: "legacy capabilities/discover-models export-from",
      },
      {
        importer: runtimeRootImporter,
        source: `const p = "../providers/cursor/index.js";\nawait import(p);\n`,
        note: "non-literal dynamic import fail-closed",
      },
    ];

    for (const row of mustFail) {
      const violations = concreteProviderModuleEdgeViolations(row.importer, row.source);
      expect(violations.length, `${row.note} should violate`).toBeGreaterThan(0);
    }

    const mustPass: Array<{ importer: string; source: string; note: string }> = [
      {
        importer: runtimeRootImporter,
        source: `import type { AgentHandler } from "./contracts.js";\nvoid null as unknown as AgentHandler;\n`,
        note: "contracts seam",
      },
      {
        importer: runtimeRootImporter,
        source: `import { wellKnownBinDirs } from "./provider-support/index.js";\nvoid wellKnownBinDirs;\n`,
        note: "provider-support index seam",
      },
      {
        importer: runtimeRootImporter,
        source: `import { something } from "./child-process-registry.js";\nvoid something;\n`,
        note: "runtime-local child-process-registry",
      },
      {
        importer: runtimeRootImporter,
        source: `import { createRequire } from "node:module";\nconst req = createRequire(import.meta.url);\nconst ejs = req("ejs");\nvoid ejs;\n`,
        note: "literal package createRequire (agent-briefing shape)",
      },
      {
        importer: runtimeRootImporter,
        source: `import { createRequire } from "node:module";\nconst native = createRequire(import.meta.url)("fs-native-extensions");\nvoid native;\n`,
        note: "literal package createRequire (workspace-file-lock shape)",
      },
      {
        importer: managedSkillsImporter,
        source: `import { PROVIDER_SKILL_ROOTS } from "../providers/skill-roots.js";\nvoid PROVIDER_SKILL_ROOTS;\n`,
        note: "controlled managed-skills -> providers/skill-roots seam",
      },
    ];

    for (const row of mustPass) {
      const violations = concreteProviderModuleEdgeViolations(row.importer, row.source);
      expect(violations, `${row.note} must not violate:\n${violations.join("\n")}`).toEqual([]);
    }

    // Target classification durability (path existence not required).
    expect(isForbiddenConcreteProviderModuleTarget("handlers/cursor/index.js")).toBe(true);
    expect(isForbiddenConcreteProviderModuleTarget("handlers/kimi-code.js")).toBe(true);
    expect(isForbiddenConcreteProviderModuleTarget("providers/cursor/index.js")).toBe(true);
    expect(isForbiddenConcreteProviderModuleTarget("providers/kimi-code/binary.js")).toBe(true);
    expect(isForbiddenConcreteProviderModuleTarget("runtime/cursor-binary.js")).toBe(true);
    expect(isForbiddenConcreteProviderModuleTarget("runtime/kimi-binary.js")).toBe(true);
    expect(isForbiddenConcreteProviderModuleTarget("runtime/cursor-login.js")).toBe(true);
    expect(isForbiddenConcreteProviderModuleTarget("runtime/capabilities/cursor.js")).toBe(true);
    expect(isForbiddenConcreteProviderModuleTarget("runtime/capabilities/kimi-code.js")).toBe(true);
    expect(isForbiddenConcreteProviderModuleTarget("runtime/capabilities/discover-models.js")).toBe(true);
    expect(isForbiddenConcreteProviderModuleTarget("providers/claude/index.js")).toBe(true);
    expect(isForbiddenConcreteProviderModuleTarget("providers/codex/binary.js")).toBe(true);
    expect(isForbiddenConcreteProviderModuleTarget("providers/grok/login.js")).toBe(true);
    expect(isForbiddenConcreteProviderModuleTarget("handlers/opencode/index.js")).toBe(true);
    expect(isForbiddenConcreteProviderModuleTarget("handlers/opencode/parser.js")).toBe(true);
    expect(isForbiddenConcreteProviderModuleTarget("handlers/pi/index.js")).toBe(true);
    expect(isForbiddenConcreteProviderModuleTarget("handlers/pi/rpc-client.js")).toBe(true);
    expect(isForbiddenConcreteProviderModuleTarget("runtime/opencode-binary.js")).toBe(true);
    expect(isForbiddenConcreteProviderModuleTarget("runtime/opencode-private-config.js")).toBe(true);
    expect(isForbiddenConcreteProviderModuleTarget("runtime/pi-binary.js")).toBe(true);
    expect(isForbiddenConcreteProviderModuleTarget("runtime/capabilities/opencode.js")).toBe(true);
    expect(isForbiddenConcreteProviderModuleTarget("runtime/capabilities/pi.js")).toBe(true);
    expect(isForbiddenConcreteProviderModuleTarget("runtime/capabilities/detect.js")).toBe(true);
    expect(isForbiddenConcreteProviderModuleTarget("runtime/capabilities/index.js")).toBe(true);
    expect(isForbiddenConcreteProviderModuleTarget("runtime/capabilities/launch-probe.js")).toBe(true);
    expect(isForbiddenConcreteProviderModuleTarget("providers/opencode/index.js")).toBe(true);
    expect(isForbiddenConcreteProviderModuleTarget("providers/pi/binary.js")).toBe(true);
    expect(isForbiddenConcreteProviderModuleTarget("providers/capabilities/detect.js")).toBe(true);
    expect(isForbiddenConcreteProviderModuleTarget("providers/capabilities/index.js")).toBe(true);
    expect(isForbiddenConcreteProviderModuleTarget("runtime/contracts.js")).toBe(false);
    expect(isForbiddenConcreteProviderModuleTarget("runtime/provider-support/index.js")).toBe(false);
    expect(isForbiddenConcreteProviderModuleTarget("providers/skill-roots.js")).toBe(false);
  });
});
