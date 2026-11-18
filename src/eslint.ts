import type { AdapterId, Diagnostic, Observation } from "./types.js";
import { parseAdapter } from "./baseline.js";
import { parseEslintReports } from "./eslint-report.js";

export function summarize(
  reports: unknown,
  tracked: readonly string[],
  options: { adapter: AdapterId; root?: string },
): Observation {
  if (tracked.length === 0 || tracked.some((rule) => !rule.trim()) || new Set(tracked).size !== tracked.length) {
    throw new Error("Expected unique, non-empty tracked rule IDs");
  }
  const counts: Record<string, number> = Object.fromEntries(tracked.map((id) => [id, 0]));
  const errors: Diagnostic[] = [];
  const diagnostics: Diagnostic[] = [];
  const adapter = parseAdapter(options.adapter);
  const files = parseEslintReports(reports, {
    root: options.root === undefined ? undefined : options.root,
    requireSuppressed: true,
  });

  for (const file of files) {
    for (const message of file.messages) {
      const diagnostic: Diagnostic = {
        ...message,
        file: file.displayPath,
        kind: message.severity === 2 ? "error" : "warning",
      };
      if (message.severity === 2) {
        errors.push(diagnostic);
        diagnostics.push(diagnostic);
      } else if (message.ruleId && Object.hasOwn(counts, message.ruleId)) {
        counts[message.ruleId] = (counts[message.ruleId] ?? 0) + 1;
        diagnostics.push(diagnostic);
      }
    }
    for (const message of file.suppressedMessages) {
      if (message.ruleId && Object.hasOwn(counts, message.ruleId)) {
        counts[message.ruleId] = (counts[message.ruleId] ?? 0) + 1;
        diagnostics.push({ ...message, file: file.displayPath, kind: "suppressed" });
      }
    }
  }

  const compare = (a: Diagnostic, b: Diagnostic) =>
    a.file.localeCompare(b.file, "en")
    || (a.line ?? 0) - (b.line ?? 0)
    || (a.column ?? 0) - (b.column ?? 0)
    || (a.ruleId ?? "").localeCompare(b.ruleId ?? "", "en")
    || a.kind.localeCompare(b.kind, "en");

  return {
    adapter,
    counts,
    errors: errors.sort(compare),
    diagnostics: diagnostics.sort(compare),
    files: files.length,
  };
}
