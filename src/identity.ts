import { diffRatchet } from "./ratchet.js";
import { parseEslintReports } from "./eslint-report.js";
import type {
  IdentityAdapterId, IdentityBaseline, IdentityEvaluation, IdentityMap, IdentityObservation,
} from "./identity-types.js";
import { legacyIdentitiesRuleIds } from "./identity-types.js";
import { getProfile } from "./profiles.js";
import type { Diagnostic } from "./types.js";
import { record } from "./validation.js";

function sameRules(left: IdentityMap, right: IdentityMap): boolean {
  return JSON.stringify(Object.keys(left).sort()) === JSON.stringify(Object.keys(right).sort());
}

export function parseIdentityBaseline(value: unknown): IdentityBaseline {
  function parseAdapter(value: unknown): IdentityAdapterId {
    if (value === "eslint-identities@1" || value === "identities-cycles@1") return value;
    throw new Error(`Unknown identity adapter: ${String(value)}`);
  }

  function parseIdentities(value: unknown, label: string): IdentityMap {
    const entries = Object.entries(record(value, label));
    if (entries.length === 0) throw new Error(`${label} must track at least one rule`);
    return Object.fromEntries(entries.map(([ruleId, identities]) => {
      if (!ruleId.trim() || !Array.isArray(identities)
        || identities.some((identity) => typeof identity !== "string" || !identity.trim())
        || new Set(identities).size !== identities.length) {
        throw new Error(`Invalid or duplicate identities for ${ruleId}`);
      }
      return [ruleId, [...identities]];
    }));
  }

  function validateLegacyIdentitiesRules(identities: IdentityMap): void {
    const expected = Object.fromEntries(legacyIdentitiesRuleIds.map((ruleId) => [ruleId, []]));
    if (!sameRules(identities, expected)) throw new Error("legacy identities must retain exactly its eight tracked rules");
  }

  const input = record(value, "Identity baseline");
  if (input.schemaVersion !== 2 || input.mode !== "identities") {
    throw new Error("Expected identity baseline schemaVersion 2 and mode identities");
  }
  const adapter = parseAdapter(input.adapter);
  const identities = parseIdentities(input.identities, "Baseline identities");
  let profileId: string | undefined;
  if (input.profileId !== undefined) {
    if (typeof input.profileId !== "string") throw new Error("Identity baseline profileId must be a string");
    const profile = getProfile(input.profileId);
    if (profile.adapter !== adapter) throw new Error("Identity baseline profile and adapter do not match");
    if (profile.rules && JSON.stringify([...profile.rules].sort()) !== JSON.stringify(Object.keys(identities).sort())) {
      throw new Error(`Identity baseline for ${profile.id} must track exactly its declared rules`);
    }
    profileId = profile.id;
  }
  if (input.counts !== undefined) throw new Error("Identity baselines cannot contain count budgets");
  if (input._comment !== undefined && typeof input._comment !== "string") throw new Error("Baseline _comment must be a string");
  if (input.legacyVersion !== undefined
    && (adapter !== "identities-cycles@1" || (input.legacyVersion !== 2 && input.legacyVersion !== 4))) {
    throw new Error("Invalid legacy version for identity baseline");
  }
  if (adapter === "identities-cycles@1") validateLegacyIdentitiesRules(identities);
  return {
    ...input,
    schemaVersion: 2,
    mode: "identities",
    adapter,
    identities,
    ...(profileId !== undefined ? { profileId } : {}),
  };
}

export function importLegacyIdentitiesBaseline(value: unknown): IdentityBaseline {
  const input = record(value, "legacy identities baseline");
  if (input.version !== 2 && input.version !== 4) throw new Error("Unsupported legacy identities baseline version; expected 2 or 4");
  const { version, _comment, ...identities } = input;
  return parseIdentityBaseline({
    schemaVersion: 2, mode: "identities", adapter: "identities-cycles@1", legacyVersion: version,
    identities, ...(_comment !== undefined ? { _comment } : {}),
  });
}

export function summarizeIdentities(
  reports: unknown,
  tracked: readonly string[],
  options: { adapter: IdentityAdapterId; root?: string },
): IdentityObservation {
  if (tracked.length === 0 || tracked.some((rule) => !rule.trim()) || new Set(tracked).size !== tracked.length) {
    throw new Error("Expected unique, non-empty tracked rule IDs");
  }
  const files = parseEslintReports(reports, { root: options.root, requireSuppressed: true });
  const identities: IdentityMap = Object.fromEntries(tracked.map((ruleId) => [ruleId, []]));
  const { adapter } = parseIdentityBaseline({ schemaVersion: 2, mode: "identities", adapter: options.adapter, identities });
  const occurrences = new Map<string, number>();
  const diagnostics: Diagnostic[] = [];
  const errors: Diagnostic[] = [];
  for (const file of files) {
    for (const [messages, suppressed] of [[file.messages, false], [file.suppressedMessages, true]] as const) {
      for (const message of messages) {
        const diagnostic: Diagnostic = {
          ...message, file: file.displayPath,
          kind: suppressed ? "suppressed" : message.severity === 2 ? "error" : "warning",
        };
        const hardError = !suppressed && message.severity === 2;
        if (hardError) errors.push(diagnostic);
        const trackedRule = message.ruleId !== null && Object.hasOwn(identities, message.ruleId);
        if (hardError || trackedRule) diagnostics.push(diagnostic);
        if (!trackedRule || message.ruleId === null) continue;
        const key = `${message.ruleId}:${file.displayPath}:${message.message}`;
        const occurrence = (occurrences.get(key) ?? 0) + 1;
        occurrences.set(key, occurrence);
        identities[message.ruleId]?.push(`${file.displayPath}:${message.ruleId}:${message.message}#${occurrence}`);
      }
    }
  }
  for (const values of Object.values(identities)) values.sort();
  return {
    adapter, identities, counts: Object.fromEntries(Object.entries(identities).map(([ruleId, values]) => [ruleId, values.length])),
    errors, diagnostics, files: files.length,
  };
}

/** Digits replaced by a placeholder, with the numbers kept for comparison. */
function metricShape(identity: string): { key: string; numbers: number[] } {
  const numbers: number[] = [];
  const key = identity.replace(/\d+/g, (digits) => {
    numbers.push(Number(digits));
    return "#";
  });
  return { key, numbers };
}

/** A stale identity that differs from `candidate` only by one lower metric. */
function improvementOver(candidate: string, stale: string[]): string | undefined {
  const shape = metricShape(candidate);
  return stale.find((existing) => {
    const other = metricShape(existing);
    if (other.key !== shape.key || other.numbers.length !== shape.numbers.length) return false;
    let differing = -1;
    for (let index = 0; index < shape.numbers.length; index++) {
      if (shape.numbers[index] === other.numbers[index]) continue;
      if (differing >= 0) return false;
      differing = index;
    }
    return differing >= 0 && (shape.numbers[differing] ?? 0) < (other.numbers[differing] ?? 0);
  });
}

/**
 * The identity string embeds the metric, so lowering one (161 -> 159) reads as a
 * new identity plus a stale one. Pair those: a metric that moved down on the
 * same diagnostic is a tightening, not debt. An upward move stays `added`.
 */
function reconcileImprovements(added: IdentityMap, stale: IdentityMap): void {
  for (const [ruleId, values] of Object.entries(added)) {
    const remaining: string[] = [];
    for (const value of values) {
      const staleValues = stale[ruleId] ?? [];
      const match = improvementOver(value, staleValues);
      if (match === undefined) {
        remaining.push(value);
        continue;
      }
      const remainingStale = staleValues.filter((candidate) => candidate !== match);
      if (remainingStale.length) stale[ruleId] = remainingStale;
      else delete stale[ruleId];
    }
    if (remaining.length) added[ruleId] = remaining;
    else delete added[ruleId];
  }
}

function difference(left: IdentityMap, right: IdentityMap): IdentityMap {
  const changes: [string, string[]][] = [];
  for (const [ruleId, values] of Object.entries(left)) {
    const { fresh: diff } = diffRatchet(values, right[ruleId] ?? []);
    if (diff.length) changes.push([ruleId, diff]);
  }
  return Object.fromEntries(changes);
}

export function evaluateIdentities(
  baseline: IdentityBaseline,
  observation: IdentityObservation,
  previousBaseline?: IdentityBaseline,
): IdentityEvaluation {
  function validateObservation(baseline: IdentityBaseline, observation: IdentityObservation): IdentityMap {
    if (observation.adapter !== baseline.adapter) throw new Error("Identity adapter changed; review detector upgrades separately");
    if (!Number.isSafeInteger(observation.files) || observation.files <= 0) throw new Error("Identity observation must contain a non-empty scan");
    const identities = parseIdentityBaseline({ ...baseline, identities: observation.identities }).identities;
    const counts = record(observation.counts, "Observation counts");
    if (!sameRules(baseline.identities, identities)
      || JSON.stringify(Object.keys(counts).sort()) !== JSON.stringify(Object.keys(identities).sort())) {
      throw new Error("Observation must contain exactly the baseline's tracked rules");
    }
    for (const [ruleId, values] of Object.entries(identities)) {
      if (counts[ruleId] !== values.length) throw new Error(`Observation count does not match identities for ${ruleId}`);
    }
    if (!Array.isArray(observation.errors) || !Array.isArray(observation.diagnostics)) throw new Error("Invalid identity diagnostics");
    return identities;
  }

  const current = parseIdentityBaseline(baseline);
  const identities = validateObservation(current, observation);
  let baselineGrowth: IdentityMap = {};
  if (previousBaseline) {
    const previous = parseIdentityBaseline(previousBaseline);
    if (previous.adapter !== current.adapter || previous.legacyVersion !== current.legacyVersion
      || !sameRules(previous.identities, current.identities)) {
      throw new Error("Predecessor baseline must have the same adapter, legacy version, and tracked rules");
    }
    baselineGrowth = difference(current.identities, previous.identities);
  }
  const added = difference(identities, current.identities);
  const stale = difference(current.identities, identities);
  reconcileImprovements(added, stale);
  const changes = Object.entries(current.identities).sort(([a], [b]) => a.localeCompare(b, "en")).map(([ruleId, values]) => {
    const now = identities[ruleId]?.length ?? 0;
    return { ruleId, before: values.length, now, delta: now - values.length };
  });
  const canTighten = observation.errors.length === 0 && Object.keys(added).length === 0 && Object.keys(baselineGrowth).length === 0;
  return {
    ok: canTighten && Object.keys(stale).length === 0, canTighten, adapter: current.adapter,
    counts: { ...observation.counts }, changes,
    regressions: changes.filter((change) => change.delta > 0), improvements: changes.filter((change) => change.delta < 0),
    added, stale, baselineGrowth, errors: observation.errors, diagnostics: observation.diagnostics, files: observation.files,
  };
}

export function tightenIdentities(
  baseline: IdentityBaseline,
  observation: IdentityObservation,
  previousBaseline?: IdentityBaseline,
): IdentityBaseline {
  const result = evaluateIdentities(baseline, observation, previousBaseline);
  if (!result.canTighten) throw new Error("Cannot tighten with new identities, ESLint errors, or baseline growth");
  return parseIdentityBaseline({ ...baseline, identities: observation.identities });
}
