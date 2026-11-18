import type { AdapterId, Baseline, Evaluation, Observation } from "./types.js";
import { parseCounts, record } from "./validation.js";

export const adapters: readonly AdapterId[] = ["eslint-json@1"];

export function parseAdapter(value: unknown): AdapterId {
  if (value === "eslint-json@1") return value;
  throw new Error(`Unknown adapter: ${String(value)}. Supported: ${adapters.join(", ")}`);
}

export function parseBaseline(value: unknown): Baseline {
  const input = record(value, "Baseline");
  if (input.schemaVersion !== 1) {
    throw new Error("Expected baseline schemaVersion 1");
  }
  if (input.identities !== undefined || (input.mode !== undefined && input.mode !== "counts")) {
    throw new Error("Count baselines cannot contain identity budgets or a different comparison mode");
  }
  if (input._comment !== undefined && typeof input._comment !== "string") {
    throw new Error("Baseline _comment must be a string");
  }
  return {
    ...input,
    schemaVersion: 1,
    adapter: parseAdapter(input.adapter),
    counts: parseCounts(input.counts),
  };
}

export function evaluate(baseline: Baseline, observed: Observation): Evaluation {
  parseBaseline(baseline);
  if (!Number.isSafeInteger(observed.files) || observed.files <= 0) {
    throw new Error("Count observation must contain a non-empty scan");
  }
  if (!Array.isArray(observed.errors) || !Array.isArray(observed.diagnostics)) {
    throw new Error("Invalid count diagnostics");
  }
  if (baseline.adapter !== observed.adapter) {
    throw new Error("Adapter changed: compare detectors and create a separately reviewed baseline before upgrading");
  }
  const expected = Object.keys(baseline.counts).sort();
  const actual = Object.keys(observed.counts).sort();
  if (JSON.stringify(expected) !== JSON.stringify(actual)) {
    throw new Error("Observation must contain exactly the baseline's tracked rules");
  }
  const changes = Object.entries(baseline.counts).sort(([a], [b]) => a.localeCompare(b, "en")).map(([ruleId, before]) => {
    const now = observed.counts[ruleId];
    if (now === undefined || !Number.isSafeInteger(now) || now < 0) throw new Error(`Invalid observation for ${ruleId}`);
    return { ruleId, before, now, delta: now - before };
  });
  const regressions = changes.filter((change) => change.delta > 0);
  return {
    ok: observed.errors.length === 0 && regressions.length === 0,
    adapter: baseline.adapter,
    counts: observed.counts,
    changes,
    regressions,
    improvements: changes.filter((change) => change.delta < 0),
    errors: observed.errors,
    diagnostics: observed.diagnostics,
    files: observed.files,
  };
}

export function tighten(baseline: Baseline, observed: Observation): Baseline {
  const result = evaluate(baseline, observed);
  if (!result.ok) throw new Error("Cannot tighten with ESLint errors or ratchet regressions");
  return { ...baseline, counts: { ...observed.counts } };
}
