import { readFileSync, readdirSync } from "node:fs";
import { extname, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";
import { DYNAMIC_FAMILIES, isRegisteredAction } from "../src/domains/audit/events/registry";

/*
 * The registry in src/domains/audit/events/registry.ts is the contract for
 * what an audit action means; this script makes it enforceable. It parses
 * every production file under src/ with the TypeScript compiler, finds the
 * two audit emit shapes (recordAudit calls and direct
 * `.insert(auditEvents).values(...)` writes), and collects the action each
 * one writes: string literals exactly, template literals as their static
 * prefix (a dynamic family that must be declared in DYNAMIC_FAMILIES).
 *
 * The check fails when an emitted action has no registry definition - a new
 * action cannot merge unregistered - or when an emit passes the action as
 * something the scanner cannot prove (an identifier, a spread), which would
 * let an unregistered action through silently. Listing files that merely
 * name actions (outbox topics, the daybook action registry) are not emit
 * sites and never match.
 */

export type EmitFinding =
  | { kind: "literal"; action: string; file: string; line: number }
  | { kind: "prefix"; prefix: string; file: string; line: number }
  | { kind: "unanalyzable"; file: string; line: number };

const SCAN_ROOTS = ["src"];
const SKIP_SEGMENTS = new Set(["node_modules", "tests", "e2e", "__tests__", ".next"]);

function listFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_SEGMENTS.has(entry.name)) continue;
      listFiles(path, out);
    } else if (/\.(ts|tsx)$/.test(entry.name) && !/\.(test|spec)\.(ts|tsx)$/.test(entry.name)) {
      out.push(path);
    }
  }
  return out;
}

/** Collect every `action:` property assignment at the top level of an object literal. */
function collectActionInitializers(objectNode: ts.ObjectLiteralExpression): ts.Expression[] {
  const initializers: ts.Expression[] = [];
  for (const property of objectNode.properties) {
    if (!ts.isPropertyAssignment(property)) continue;
    const name = property.name;
    if ((ts.isIdentifier(name) && name.text === "action") || (ts.isStringLiteral(name) && name.text === "action")) {
      initializers.push(property.initializer);
    }
  }
  return initializers;
}

/**
 * A shared-helper pass-through (`recordAudit(auth, { action: audit.action, ... })`)
 * hides its literals from the emit-site scan. The fail-closed treatment follows
 * them to the object literals in the same file: those `action:` fields are the
 * candidate sources, so they are scanned as if emitted here. A new action in a
 * pass-through object still cannot merge unregistered. Files with no literal
 * candidates fail as unanalyzable - except the audit write door itself
 * (src/domains/audit/record.ts), whose `action: input.action` is the typed
 * AuditInput boundary every caller is scanned against.
 */
const AUDIT_WRITE_DOOR = "src/domains/audit/record.ts";

function sameFileActionCandidates(sourceFile: ts.SourceFile): string[] {
  const candidates = new Set<string>();
  const visit = (node: ts.Node): void => {
    if (ts.isObjectLiteralExpression(node)) {
      for (const initializer of collectActionInitializers(node)) {
        if (ts.isStringLiteral(initializer) || ts.isNoSubstitutionTemplateLiteral(initializer)) {
          candidates.add(initializer.text);
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return [...candidates];
}

/**
 * Resolve one `action:` initializer to findings. Literals register exactly;
 * template literals register their static prefix; conditional and nullish
 * expressions recurse into every branch; anything else cannot be proven and
 * fails the check rather than passing silently.
 */
function findingsForInitializer(
  initializer: ts.Expression,
  file: string,
  sourceFile: ts.SourceFile,
  candidates: string[],
  out: EmitFinding[],
): void {
  if (ts.isStringLiteral(initializer)) {
    const line = sourceFile.getLineAndCharacterOfPosition(initializer.getStart(sourceFile)).line + 1;
    out.push({ kind: "literal", action: initializer.text, file, line });
    return;
  }
  if (ts.isNoSubstitutionTemplateLiteral(initializer)) {
    const line = sourceFile.getLineAndCharacterOfPosition(initializer.getStart(sourceFile)).line + 1;
    out.push({ kind: "literal", action: initializer.text, file, line });
    return;
  }
  if (ts.isTemplateExpression(initializer)) {
    const prefix = initializer.head.text;
    const line = sourceFile.getLineAndCharacterOfPosition(initializer.getStart(sourceFile)).line + 1;
    out.push({ kind: "prefix", prefix, file, line });
    return;
  }
  if (ts.isConditionalExpression(initializer)) {
    findingsForInitializer(initializer.whenTrue, file, sourceFile, candidates, out);
    findingsForInitializer(initializer.whenFalse, file, sourceFile, candidates, out);
    return;
  }
  if (
    ts.isBinaryExpression(initializer) &&
    (initializer.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken ||
      initializer.operatorToken.kind === ts.SyntaxKind.BarBarToken)
  ) {
    findingsForInitializer(initializer.left, file, sourceFile, candidates, out);
    findingsForInitializer(initializer.right, file, sourceFile, candidates, out);
    return;
  }
  if (
    ts.isPropertyAccessExpression(initializer) &&
    ts.isIdentifier(initializer.expression) &&
    initializer.name.text === "action"
  ) {
    if (file.replace(/\\/g, "/") === AUDIT_WRITE_DOOR) return; // typed AuditInput pass-through; callers are scanned
    if (candidates.length > 0) {
      for (const candidate of candidates)
        out.push({
          kind: "literal",
          action: candidate,
          file,
          line: sourceFile.getLineAndCharacterOfPosition(initializer.getStart(sourceFile)).line + 1,
        });
      return;
    }
  }
  const line = sourceFile.getLineAndCharacterOfPosition(initializer.getStart(sourceFile)).line + 1;
  out.push({ kind: "unanalyzable", file, line });
}

function isInsertCall(node: ts.CallExpression): boolean {
  // <tx>.insert(auditEvents) - the direct write that bypasses recordAudit.
  if (!ts.isPropertyAccessExpression(node.expression) || node.expression.name.text !== "insert") return false;
  const firstArg = node.arguments[0];
  return ts.isIdentifier(firstArg) && firstArg.text === "auditEvents";
}

function scanSourceFile(content: string, file: string, out: EmitFinding[]): void {
  const sourceFile = ts.createSourceFile(
    file,
    content,
    ts.ScriptTarget.Latest,
    true,
    extname(file) === ".tsx" ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const candidates = sameFileActionCandidates(sourceFile);

  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      // Shape 1: recordAudit(auth, { action: ... }, tx?)
      const callee = node.expression;
      if (ts.isIdentifier(callee) && callee.text === "recordAudit" && node.arguments.length >= 2) {
        const input = node.arguments[1];
        if (ts.isObjectLiteralExpression(input)) {
          for (const initializer of collectActionInitializers(input))
            findingsForInitializer(initializer, file, sourceFile, candidates, out);
        } else {
          // Fail closed: an action built elsewhere cannot be proven covered.
          const line = sourceFile.getLineAndCharacterOfPosition(input.getStart(sourceFile)).line + 1;
          out.push({ kind: "unanalyzable", file, line });
        }
      }
      // Shape 2: <tx>.insert(auditEvents).values({ action: ... }) - the object
      // lives on the .values() call wrapping the insert call.
      if (
        ts.isPropertyAccessExpression(node.expression) &&
        node.expression.name.text === "values" &&
        ts.isCallExpression(node.expression.expression) &&
        isInsertCall(node.expression.expression)
      ) {
        for (const argument of node.arguments) {
          if (ts.isObjectLiteralExpression(argument)) {
            for (const initializer of collectActionInitializers(argument))
              findingsForInitializer(initializer, file, sourceFile, candidates, out);
          } else if (ts.isArrayLiteralExpression(argument)) {
            for (const element of argument.elements) {
              if (ts.isObjectLiteralExpression(element)) {
                for (const initializer of collectActionInitializers(element))
                  findingsForInitializer(initializer, file, sourceFile, candidates, out);
              }
            }
          }
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
}

/** Every audit emit site under src/, as findings keyed by what the action is. */
export function scanAuditEmits(rootDir = process.cwd()): EmitFinding[] {
  const findings: EmitFinding[] = [];
  for (const root of SCAN_ROOTS) {
    const absolute = resolve(rootDir, root);
    for (const file of listFiles(absolute)) {
      scanSourceFile(readFileSync(file, "utf8"), relative(rootDir, file), findings);
    }
  }
  return findings;
}

export type RegistryCheckError = { message: string };

export function checkRegistry(findings: EmitFinding[]): RegistryCheckError[] {
  const errors: RegistryCheckError[] = [];
  for (const finding of findings) {
    if (finding.kind === "literal") {
      if (!isRegisteredAction(finding.action)) {
        errors.push({
          message: `Unregistered audit action "${finding.action}" at ${finding.file}:${finding.line} - add an EventDefinition (or a Tier 2 default) to src/domains/audit/events/registry.ts`,
        });
      }
      continue;
    }
    if (finding.kind === "prefix") {
      const suffixes = DYNAMIC_FAMILIES[finding.prefix];
      if (!suffixes) {
        errors.push({
          message: `Dynamic audit action family "${finding.prefix}..." at ${finding.file}:${finding.line} is not declared in DYNAMIC_FAMILIES (src/domains/audit/events/registry.ts)`,
        });
      }
      continue;
    }
    errors.push({
      message: `Audit emit at ${finding.file}:${finding.line} passes the action as a value the scanner cannot prove - inline the literal (or extend the scanner) so the registry can cover it`,
    });
  }
  return errors;
}

export function familyCoverageErrors(): RegistryCheckError[] {
  const errors: RegistryCheckError[] = [];
  for (const [prefix, suffixes] of Object.entries(DYNAMIC_FAMILIES)) {
    if (suffixes.length === 0) errors.push({ message: `Dynamic family "${prefix}" declares no suffixes` });
    for (const suffix of suffixes) {
      if (!isRegisteredAction(`${prefix}${suffix}`)) {
        errors.push({
          message: `Dynamic family "${prefix}" suffix "${suffix}" has no registry definition for "${prefix}${suffix}"`,
        });
      }
    }
  }
  return errors;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const findings = scanAuditEmits();
  const emitCount = findings.filter((finding) => finding.kind !== "unanalyzable").length;
  const errors = [...familyCoverageErrors(), ...checkRegistry(findings)];
  if (process.argv.includes("--dump")) {
    const literals = [
      ...new Set(
        findings
          .filter((finding): finding is Extract<EmitFinding, { kind: "literal" }> => finding.kind === "literal")
          .map((finding) => finding.action),
      ),
    ].sort();
    console.log(literals.join("\n"));
    console.error(`\n${literals.length} distinct actions across ${emitCount} emit sites`);
  }
  if (errors.length) {
    console.error(errors.map((error) => error.message).join("\n"));
    process.exitCode = 1;
  } else {
    console.log(`Audit registry covers every emitted action (${emitCount} emit sites scanned).`);
  }
}
