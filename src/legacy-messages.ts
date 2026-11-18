import { parseBaseline } from "./baseline.js";
import { parseEslintReports } from "./eslint-report.js";
import { hasLegacyMessagesRules, legacyMessagesRuleIds } from "./legacy-messages-types.js";
import type { Baseline, Diagnostic, Observation } from "./types.js";
import { record } from "./validation.js";

/** Import only declared allowances. Missing legacy keys are zero, never measured debt. */
export function importLegacyMessagesBaseline(value: unknown): Baseline {
  const input = record(value, "legacy messages baseline");
  const allowed = new Set<string>([...legacyMessagesRuleIds, "_comment"]);
  for (const key of Object.keys(input)) {
    if (!allowed.has(key)) throw new Error(`Unsupported legacy messages baseline key: ${key}`);
  }
  return parseBaseline({
    schemaVersion: 1, adapter: "message-counts@1",
    counts: Object.fromEntries(legacyMessagesRuleIds.map((rule) => [rule, input[rule] === undefined ? 0 : input[rule]])),
    ...(input._comment !== undefined ? { _comment: input._comment } : {}),
  });
}

/** Frozen valid-report semantics: all tracked messages count; suppressions and other errors do not. */
export function summarizeLegacyMessages(reports: unknown, tracked: readonly string[], root: string): Observation {
  if (!hasLegacyMessagesRules(tracked)) throw new Error("legacy messages must retain exactly its seven tracked rules");
  const files = parseEslintReports(reports, { root, requireSuppressed: false });
  const counts = Object.fromEntries(legacyMessagesRuleIds.map((rule) => [rule, 0]));
  const diagnostics: Diagnostic[] = [];
  for (const file of files) {
    for (const message of file.messages) {
      if (!message.ruleId || !Object.hasOwn(counts, message.ruleId)) continue;
      counts[message.ruleId] = (counts[message.ruleId] ?? 0) + 1;
      diagnostics.push({ ...message, file: file.displayPath, kind: message.severity === 2 ? "error" : "warning" });
    }
  }
  return { adapter: "message-counts@1", counts, errors: [], diagnostics, files: files.length };
}
