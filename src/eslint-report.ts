import { relative, resolve } from "node:path";
import { record } from "./validation.js";

export interface LintMessage {
  ruleId: string | null;
  severity: 1 | 2;
  message: string;
  line?: number;
  column?: number;
}

export interface EslintFile {
  filePath: string;
  displayPath: string;
  messages: LintMessage[];
  suppressedMessages: LintMessage[];
}

export function parseEslintReports(
  reports: unknown,
  options: { root?: string; requireSuppressed: boolean },
): EslintFile[] {
  function parseMessages(value: unknown, label: string): LintMessage[] {
    if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
    return value.map((value) => {
      const input = record(value, label);
      if ((input.severity !== 1 && input.severity !== 2)
        || (input.ruleId !== null && typeof input.ruleId !== "string")
        || typeof input.message !== "string") throw new Error(`Invalid ESLint message in ${label}`);
      for (const field of ["line", "column"] as const) {
        if (input[field] !== undefined && (!Number.isSafeInteger(input[field]) || Number(input[field]) < 0)) {
          throw new Error(`Invalid ${field} in ${label}`);
        }
      }
      return {
        ruleId: input.ruleId, severity: input.severity, message: input.message,
        ...(typeof input.line === "number" ? { line: input.line } : {}),
        ...(typeof input.column === "number" ? { column: input.column } : {}),
      };
    });
  }

  if (!Array.isArray(reports) || reports.length === 0) {
    throw new Error("Expected a non-empty ESLint JSON report; refusing an empty scan");
  }
  const root = resolve(options.root ?? process.cwd());
  const seen = new Set<string>();
  return reports.map((value) => {
    const file = record(value, "ESLint file result");
    if (typeof file.filePath !== "string" || !file.filePath.trim()) throw new Error("ESLint file result must have a filePath");
    const path = resolve(root, file.filePath);
    if (seen.has(path)) throw new Error(`Duplicate ESLint file result: ${file.filePath}`);
    seen.add(path);
    const displayPath = relative(root, path).replaceAll("\\", "/");
    const messages = parseMessages(file.messages, `${displayPath}.messages`);
    const errors = messages.filter((message) => message.severity === 2).length;
    for (const field of ["errorCount", "fatalErrorCount", "warningCount"] as const) {
      const count = file[field];
      const expected = field === "warningCount" ? messages.length - errors : errors;
      if (count !== undefined && (!Number.isSafeInteger(count) || Number(count) < 0
        || (field === "fatalErrorCount" ? Number(count) > expected : count !== expected))) {
        throw new Error(`Inconsistent ${field} in ${displayPath}`);
      }
    }
    return {
      filePath: file.filePath, displayPath, messages,
      suppressedMessages: options.requireSuppressed
        ? parseMessages(file.suppressedMessages, `${displayPath}.suppressedMessages`) : [],
    };
  });
}
