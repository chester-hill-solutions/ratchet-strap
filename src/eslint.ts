import { readFileSync, realpathSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import type { AdapterId, Diagnostic, Observation } from "./types.js";
import { parseAdapter } from "./baseline.js";
import { parseEslintReports } from "./eslint-report.js";
import { summarizeLegacyMessages } from "./legacy-messages.js";
import { legacyStrictCountsRuleIds, summarizeLegacyStrictCounts } from "./legacy-strict-counts.js";

// Frozen from LegacyCounts 91c4409b: changing this expression requires a new adapter ID.
const LEGACY_DISABLE_RE = /eslint-disable(?:-next-line)?\b[^\n]*?(@typescript-eslint\/no-non-null-assertion|complexity|max-depth|max-params|max-lines-per-function|no-console|no-return-await|shadcn\/no-restyle|shadcn\/no-raw-colors|shadcn\/no-arbitrary-values|shadcn\/no-inline-styles|shadcn\/no-unknown-classes|shadcn\/require-static-classes)\b/g;

export function summarize(
  reports: unknown,
  tracked: readonly string[],
  options: { adapter: AdapterId; root?: string },
): Observation {
  function sourcePath(filePath: string, root: string): string {
    const file = realpathSync(resolve(root, filePath));
    const rel = relative(realpathSync(root), file);
    if (isAbsolute(rel) || rel === ".." || rel.startsWith("../") || rel.startsWith("..\\")) {
      throw new Error(`ESLint source is outside --root: ${filePath}`);
    }
    return file;
  }

  const adapter = parseAdapter(options.adapter);
  if (adapter === "message-counts@1") return summarizeLegacyMessages(reports, tracked, options.root ?? process.cwd());
  if (adapter === "strict-counts@1") {
    if (tracked.length !== legacyStrictCountsRuleIds.length || !legacyStrictCountsRuleIds.every((rule) => tracked.includes(rule))) throw new Error("LegacyStrictCounts lint requires exactly its ten tracked rule IDs");
    return summarizeLegacyStrictCounts(reports, { root: options.root ?? process.cwd() });
  }
  if (tracked.length === 0 || tracked.some((rule) => !rule.trim()) || new Set(tracked).size !== tracked.length) {
    throw new Error("Expected unique, non-empty tracked rule IDs");
  }
  const counts: Record<string, number> = Object.fromEntries(tracked.map((id) => [id, 0]));
  const errors: Diagnostic[] = [];
  const diagnostics: Diagnostic[] = [];
  const root = resolve(options.root ?? process.cwd());
  const files = parseEslintReports(reports, { root, requireSuppressed: adapter === "eslint-json@1" });
  for (const file of files) {
    const displayPath = file.displayPath;
    for (const message of file.messages) {
      const diagnostic: Diagnostic = {
        ...message, file: displayPath, kind: message.severity === 2 ? "error" : "warning",
      };
      if (message.severity === 2) {
        errors.push(diagnostic);
        diagnostics.push(diagnostic);
      } else if (message.ruleId && Object.hasOwn(counts, message.ruleId)) {
        counts[message.ruleId] = (counts[message.ruleId] ?? 0) + 1;
        diagnostics.push(diagnostic);
      }
    }
    if (adapter === "eslint-json@1") {
      for (const message of file.suppressedMessages) {
        if (message.ruleId && Object.hasOwn(counts, message.ruleId)) {
          counts[message.ruleId] = (counts[message.ruleId] ?? 0) + 1;
          diagnostics.push({ ...message, file: displayPath, kind: "suppressed" });
        }
      }
    } else {
      const source = readFileSync(sourcePath(file.filePath, root), "utf8");
      for (const match of source.matchAll(LEGACY_DISABLE_RE)) {
        const ruleId = match[1];
        if (!ruleId || !Object.hasOwn(counts, ruleId)) continue;
        counts[ruleId] = (counts[ruleId] ?? 0) + 1;
        diagnostics.push({
          file: displayPath, line: source.slice(0, match.index).split("\n").length,
          ruleId, kind: "directive", message: "Suppression directive counted by suppression-counts@1",
        });
      }
    }
  }
  const compare = (a: Diagnostic, b: Diagnostic) => a.file.localeCompare(b.file, "en")
    || (a.line ?? 0) - (b.line ?? 0) || (a.column ?? 0) - (b.column ?? 0)
    || (a.ruleId ?? "").localeCompare(b.ruleId ?? "", "en") || a.kind.localeCompare(b.kind, "en");
  return { adapter, counts, errors: errors.sort(compare), diagnostics: diagnostics.sort(compare), files: files.length };
}
