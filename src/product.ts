import { evaluate, parseBaseline, tighten } from "./baseline.js";
import { summarize } from "./eslint.js";
import { evaluateIdentities, parseIdentityBaseline, summarizeIdentities, tightenIdentities } from "./identity.js";
import { summarizeLegacyIdentities } from "./legacy-identities.js";
import { getProfile, profileForAdapter } from "./profiles.js";
import { record } from "./validation.js";
import { evaluateLegacyStrictCounts, parseLegacyStrictCountsBaseline, tightenLegacyStrictCounts } from "./legacy-strict-counts.js";
import { summarizeLegacyMessages } from "./legacy-messages.js";
import type { Baseline, Evaluation, Observation, RuleChange } from "./types.js";
import type { IdentityBaseline, IdentityEvaluation, IdentityObservation } from "./identity-types.js";

export type RatchetBaseline = Baseline | IdentityBaseline;
export type RatchetObservation = Observation | IdentityObservation;
export type RatchetEvaluation =
  | (Evaluation & { mode: "counts"; canTighten: boolean; baselineGrowth: RuleChange[] })
  | (IdentityEvaluation & { mode: "identities" });

export function parseRatchetBaseline(value: unknown): RatchetBaseline {
  const input = record(value, "Baseline");
  return input.schemaVersion === 2 ? parseIdentityBaseline(input) : parseBaseline(input);
}

export function trackedRules(baseline: RatchetBaseline): string[] {
  return Object.keys(baseline.schemaVersion === 2 ? baseline.identities : baseline.counts);
}

export function observeBaseline(baseline: RatchetBaseline, reports: unknown, root: string): RatchetObservation {
  const tracked = trackedRules(baseline);
  if (baseline.adapter === "message-counts@1") return summarizeLegacyMessages(reports, tracked, root);
  if (baseline.schemaVersion === 1) return summarize(reports, tracked, { adapter: baseline.adapter, root });
  return baseline.adapter === "identities-cycles@1"
    ? summarizeLegacyIdentities(reports, tracked, { root })
    : summarizeIdentities(reports, tracked, { adapter: baseline.adapter, root });
}

export function checkBaseline(
  baseline: RatchetBaseline,
  observed: RatchetObservation,
  previous?: RatchetBaseline,
): RatchetEvaluation {
  if (baseline.schemaVersion === 2 && "identities" in observed) {
    if (previous && previous.schemaVersion !== 2) throw new Error("Predecessor comparison mode changed; review the migration separately");
    return { ...evaluateIdentities(baseline, observed, previous), mode: "identities" };
  }
  if (baseline.schemaVersion !== 1 || "identities" in observed) throw new Error("Observation comparison mode does not match the baseline");
  if (baseline.adapter === "strict-counts@1" && observed.adapter === "strict-counts@1") {
    return {
      ...evaluateLegacyStrictCounts(parseLegacyStrictCountsBaseline(baseline), { ...observed, adapter: "strict-counts@1" }, previous ? parseLegacyStrictCountsBaseline(previous) : undefined),
      mode: "counts",
    };
  }
  const result = evaluate(baseline, observed);
  const baselineGrowth: RuleChange[] = [];
  if (previous) {
    if (previous.schemaVersion !== 1 || previous.adapter !== baseline.adapter
      || JSON.stringify(trackedRules(previous).sort()) !== JSON.stringify(trackedRules(baseline).sort())) {
      throw new Error("Predecessor adapter or tracked rules changed; review the migration separately");
    }
    for (const [ruleId, now] of Object.entries(baseline.counts)) {
      const before = previous.counts[ruleId];
      if (before !== undefined && now > before) baselineGrowth.push({ ruleId, before, now, delta: now - before });
    }
  }
  const ok = result.ok && baselineGrowth.length === 0;
  return { ...result, mode: "counts", ok, canTighten: ok, baselineGrowth };
}

export function tightenBaseline(
  baseline: RatchetBaseline,
  observed: RatchetObservation,
  previous?: RatchetBaseline,
): RatchetBaseline {
  const result = checkBaseline(baseline, observed, previous);
  if (!result.canTighten) throw new Error("Cannot tighten with new debt, ESLint errors, or baseline growth");
  if (baseline.schemaVersion === 1 && baseline.adapter === "strict-counts@1" && !("identities" in observed) && observed.adapter === "strict-counts@1") {
    return tightenLegacyStrictCounts(parseLegacyStrictCountsBaseline(baseline), { ...observed, adapter: "strict-counts@1" }, previous ? parseLegacyStrictCountsBaseline(previous) : undefined);
  }
  if (baseline.schemaVersion === 2 && "identities" in observed) return tightenIdentities(baseline, observed, previous?.schemaVersion === 2 ? previous : undefined);
  if (baseline.schemaVersion === 1 && !("identities" in observed)) return tighten(baseline, observed);
  throw new Error("Observation comparison mode does not match the baseline");
}

export function addRules(baseline: RatchetBaseline, rules: readonly string[], reports: unknown, root: string): RatchetBaseline {
  const profile = baseline.schemaVersion === 2 && baseline.profileId
    ? getProfile(baseline.profileId)
    : profileForAdapter(baseline.adapter);
  if (profile.id !== "eslint@1" && profile.id !== "eslint-counts@1") throw new Error("Compatibility profiles have frozen tracked rules; adopt a generic profile before adding new rules");
  const current = checkBaseline(baseline, observeBaseline(baseline, reports, root));
  if (!current.ok) throw new Error("Repair or tighten the existing baseline before adding rules");
  const existing = new Set(trackedRules(baseline));
  if (!rules.length || new Set(rules).size !== rules.length || rules.some((rule) => !rule.trim() || existing.has(rule))) {
    throw new Error("Add unique, non-empty rule IDs that are not already tracked");
  }
  if (baseline.schemaVersion === 2) {
    const expanded: IdentityBaseline = { ...baseline, identities: { ...baseline.identities, ...Object.fromEntries(rules.map((rule) => [rule, []])) } };
    const observed = observeBaseline(expanded, reports, root);
    if (!("identities" in observed)) throw new Error("Expected identity observations");
    return { ...baseline, identities: { ...baseline.identities, ...Object.fromEntries(rules.map((rule) => [rule, observed.identities[rule] ?? []])) } };
  }
  const expanded: Baseline = { ...baseline, counts: { ...baseline.counts, ...Object.fromEntries(rules.map((rule) => [rule, 0])) } };
  const observed = observeBaseline(expanded, reports, root);
  return { ...baseline, counts: { ...baseline.counts, ...Object.fromEntries(rules.map((rule) => [rule, observed.counts[rule] ?? 0])) } };
}
