import { isAbsolute, resolve } from "node:path";
import { parseEslintReports } from "./eslint-report.js";
import type { Diagnostic, Evaluation, Observation, RuleChange } from "./types.js";
import { parseCounts, record } from "./validation.js";

export const legacyStrictCountsRuleIds = [
  "complexity", "max-depth", "max-params", "max-lines-per-function", "no-console", "no-return-await",
  "@typescript-eslint/no-explicit-any", "@typescript-eslint/no-non-null-assertion",
  "@typescript-eslint/consistent-type-imports", "@typescript-eslint/no-unused-vars",
] as const;

export const legacyStrictCountsCheckerSha256 = "20159bdf68123e8160b65b3af722f1c458730992d47587dfb433b913a6ac915d";

export interface LegacyStrictCountsBaseline {
  schemaVersion: 1;
  adapter: "strict-counts@1";
  counts: Record<string, number>;
  _comment?: string;
}

export interface LegacyStrictCountsObservation extends Omit<Observation, "adapter"> {
  adapter: "strict-counts@1";
}

export interface LegacyStrictCountsEvaluation extends Omit<Evaluation, "adapter"> {
  adapter: "strict-counts@1";
  canTighten: boolean;
  stale: RuleChange[];
  baselineGrowth: RuleChange[];
}

export function parseLegacyStrictCountsBaseline(value: unknown): LegacyStrictCountsBaseline {
  function trackedCounts(value: unknown): Record<string, number> {
    const counts = parseCounts(value);
    const expected = [...legacyStrictCountsRuleIds].sort();
    if (JSON.stringify(Object.keys(counts).sort()) !== JSON.stringify(expected)) {
      throw new Error("LegacyStrictCounts lint requires exactly its ten tracked rule IDs");
    }
    return counts;
  }

  const input = record(value, "LegacyStrictCounts baseline");
  if (input.schemaVersion !== 1 || input.adapter !== "strict-counts@1") throw new Error("Expected schemaVersion 1 and adapter strict-counts@1");
  if (input.identities !== undefined || (input.mode !== undefined && input.mode !== "counts")) throw new Error("LegacyStrictCounts lint uses count budgets");
  if (input._comment !== undefined && typeof input._comment !== "string") throw new Error("Baseline _comment must be a string");
  return { ...input, schemaVersion: 1, adapter: "strict-counts@1", counts: trackedCounts(input.counts) };
}

export function importLegacyStrictCountsBaseline(value: unknown): LegacyStrictCountsBaseline {
  const input = record(value, "Legacy LegacyStrictCounts baseline");
  if (input.schemaVersion !== undefined || input.adapter !== undefined || input.identities !== undefined) {
    throw new Error("importLegacyStrictCountsBaseline expects an unversioned LegacyStrictCounts count baseline");
  }
  const counts = record(input.counts ?? {}, "Legacy LegacyStrictCounts counts");
  if (Object.keys(counts).some((rule) => !legacyStrictCountsRuleIds.some((tracked) => tracked === rule))) {
    throw new Error("Legacy LegacyStrictCounts baseline contains an unknown rule; refusing to discard it");
  }
  return parseLegacyStrictCountsBaseline({
    ...input, schemaVersion: 1, adapter: "strict-counts@1",
    counts: Object.fromEntries(legacyStrictCountsRuleIds.map((rule) => [rule, counts[rule] ?? 0])),
  });
}

/** --root is the repository; the frozen checker lints only packages/legacy-strict-counts-s3. */
export function summarizeLegacyStrictCounts(reports: unknown, options: { root: string }): LegacyStrictCountsObservation {
  const packageRoot = resolve(options.root, "packages/legacy-strict-counts-s3");
  const files = parseEslintReports(reports, { root: packageRoot, requireSuppressed: true });
  const counts: Record<string, number> = Object.fromEntries(legacyStrictCountsRuleIds.map((rule) => [rule, 0]));
  const errors: Diagnostic[] = [];
  const diagnostics: Diagnostic[] = [];
  for (const file of files) {
    if (!file.displayPath || isAbsolute(file.displayPath) || file.displayPath === ".." || file.displayPath.startsWith("../")) {
      throw new Error(`LegacyStrictCounts lint report source is outside packages/legacy-strict-counts-s3: ${file.filePath}`);
    }
    for (const message of file.messages) {
      const diagnostic: Diagnostic = { ...message, file: file.displayPath, kind: message.severity === 2 ? "error" : "warning" };
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
  return { adapter: "strict-counts@1", counts, errors, diagnostics, files: files.length };
}

export function evaluateLegacyStrictCounts(baseline: LegacyStrictCountsBaseline, observed: LegacyStrictCountsObservation, previous?: LegacyStrictCountsBaseline): LegacyStrictCountsEvaluation {
  const current = parseLegacyStrictCountsBaseline(baseline);
  if (observed.adapter !== current.adapter) throw new Error("LegacyStrictCounts observation adapter changed");
  if (!Number.isSafeInteger(observed.files) || observed.files <= 0) throw new Error("LegacyStrictCounts observation must contain a non-empty scan");
  const counts = parseLegacyStrictCountsBaseline({ ...current, counts: observed.counts }).counts;
  if (!Array.isArray(observed.errors) || !Array.isArray(observed.diagnostics)) throw new Error("Invalid LegacyStrictCounts observation diagnostics");
  const before = previous ? parseLegacyStrictCountsBaseline(previous).counts : undefined;
  const changes: RuleChange[] = [];
  const baselineGrowth: RuleChange[] = [];
  for (const ruleId of legacyStrictCountsRuleIds) {
    const allowed = current.counts[ruleId] ?? 0;
    const now = counts[ruleId] ?? 0;
    changes.push({ ruleId, before: allowed, now, delta: now - allowed });
    if (before && allowed > (before[ruleId] ?? 0)) {
      const prior = before[ruleId] ?? 0;
      baselineGrowth.push({ ruleId, before: prior, now: allowed, delta: allowed - prior });
    }
  }
  const regressions = changes.filter((change) => change.delta > 0);
  const stale = changes.filter((change) => change.delta < 0);
  const canTighten = observed.errors.length === 0 && regressions.length === 0 && baselineGrowth.length === 0;
  return {
    ok: canTighten && stale.length === 0, canTighten, adapter: current.adapter, counts, changes, regressions,
    improvements: stale, stale, baselineGrowth, errors: observed.errors, diagnostics: observed.diagnostics, files: observed.files,
  };
}

export function tightenLegacyStrictCounts(baseline: LegacyStrictCountsBaseline, observed: LegacyStrictCountsObservation, previous?: LegacyStrictCountsBaseline): LegacyStrictCountsBaseline {
  const result = evaluateLegacyStrictCounts(baseline, observed, previous);
  if (!result.canTighten) throw new Error("Cannot tighten LegacyStrictCounts with new debt, ESLint errors, or baseline growth");
  return { ...baseline, counts: { ...result.counts } };
}
