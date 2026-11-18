/**
 * The golden set.
 *
 * `GOLDEN_RULES` is the open-source default: the twelve rules that must hold in
 * any repository using RatchetStrap, regardless of language, framework or
 * product. Everything opinionated lives in the consumer's house rules.
 *
 * The engine ships no profiles: they live in the consumer's vendored house
 * rules, so every project owns its thresholds and enabled set.
 */

import { getHouseRules } from "../house-rules.js";

export interface GoldenRule {
  /** Stable identifier used in reports and evidence. */
  id: string;
  /** Short human name. */
  title: string;
  /** The rule itself, stated so a change can violate it. */
  rule: string;
}

/**
 * Rules every consumer follows. These are the product's contract: they make a
 * ratchet trustworthy, not a codebase stylish.
 */
export const GOLDEN_RULES: readonly GoldenRule[] = Object.freeze([
  Object.freeze({
    id: "U1",
    title: "New debt fails",
    rule: "A change that adds a tracked violation fails the gate. Existing debt may be grandfathered once, explicitly.",
  }),
  Object.freeze({
    id: "U2",
    title: "Baselines only shrink",
    rule: "A baseline may only lose entries. Never raise one to make a change pass.",
  }),
  Object.freeze({
    id: "U3",
    title: "Suppressions count",
    rule: "A suppressed or disabled diagnostic still counts as a violation.",
  }),
  Object.freeze({
    id: "U4",
    title: "Stale allowances fail",
    rule: "A repaired violation must be removed from the baseline, not left behind as an allowance.",
  }),
  Object.freeze({
    id: "U5",
    title: "Exemptions are narrow",
    rule: "Every exemption is scoped to one rule, one location and one written reason.",
  }),
  Object.freeze({
    id: "U6",
    title: "One local command",
    rule: "A single local command runs exactly the same checks as CI.",
  }),
  Object.freeze({
    id: "U7",
    title: "Generated files are clean",
    rule: "Generated and checked-in artefacts reproduce with no diff.",
  }),
  Object.freeze({
    id: "U8",
    title: "Gates are self-tested",
    rule: "Every gate has a fault and a control fixture proving it rejects the fault and permits the control.",
  }),
  Object.freeze({
    id: "U9",
    title: "No secret material",
    rule: "No secret value reaches a response, log, span, error message or built artefact.",
  }),
  Object.freeze({
    id: "U10",
    title: "Published changes are versioned",
    rule: "A published change carries a version bump and a changelog line.",
  }),
  Object.freeze({
    id: "U11",
    title: "Mocks preserve exports",
    rule: "A shared module mock keeps the real export surface; never mock away the code under test.",
  }),
  Object.freeze({
    id: "U12",
    title: "Gates cannot disable themselves",
    rule: "Guarded code cannot opt out of the gate that guards it.",
  }),
]);

export type GoldenProfileId = string;

/**
 * How a profile rule is proved.
 *
 * `contract`, `ratchet` and `review` are resolved by the consumer's own
 * registries. `consumer` is the honest default for an open-source profile: the
 * rule is available, and the consumer supplies the detector.
 */
export type GoldenEnforcement =
  | { kind: "contract"; id: string }
  | { kind: "review"; anchor: string }
  | { kind: "ratchet"; rule: string }
  | { kind: "consumer"; detector: string };

export interface GoldenProfileRule {
  id: string;
  title: string;
  rule: string;
  enforcement: GoldenEnforcement[];
  pending?: string;
}

function nonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

/** Validate the open-source default set. A missing, duplicated or empty rule throws. */
export function assertGoldenRules(rules: readonly GoldenRule[] = GOLDEN_RULES): void {
  if (rules.length !== GOLDEN_RULES.length) {
    throw new Error(`Golden set must contain exactly ${GOLDEN_RULES.length} rules; received ${rules.length}.`);
  }
  const ids = new Set<string>();
  rules.forEach((rule, index) => {
    const expected = GOLDEN_RULES[index]?.id;
    if (rule.id !== expected) throw new Error(`Golden rule position ${index} must be ${expected}; received ${rule.id}.`);
    if (ids.has(rule.id)) throw new Error(`Duplicate golden rule id "${rule.id}".`);
    ids.add(rule.id);
    if (!nonEmpty(rule.title)) throw new Error(`${rule.id} must have a non-empty title.`);
    if (!nonEmpty(rule.rule)) throw new Error(`${rule.id} must have a non-empty rule.`);
  });
}

/**
 * Validate a profile set. The engine ships none: pass the consumer's house
 * rules, or the registry configured through {@link configureHouseRules}.
 */
export function assertGoldenProfiles(
  profiles: Readonly<Record<string, readonly GoldenProfileRule[]>> =
    getHouseRules().goldenProfiles ?? {},
): void {
  for (const [name, rules] of Object.entries(profiles)) {
    if (!rules.length) throw new Error(`Golden profile "${name}" must contain at least one rule.`);
    const ids = new Set<string>();
    for (const rule of rules) {
      if (!nonEmpty(rule.id)) throw new Error(`Golden profile "${name}" has a rule without an id.`);
      if (ids.has(rule.id)) throw new Error(`Duplicate golden rule id "${rule.id}" in profile "${name}".`);
      ids.add(rule.id);
      if (!nonEmpty(rule.title)) throw new Error(`${rule.id} must have a non-empty title.`);
      if (!nonEmpty(rule.rule)) throw new Error(`${rule.id} must have a non-empty rule.`);
      const enforced = Array.isArray(rule.enforcement) && rule.enforcement.length > 0;
      const hasPending = rule.pending !== undefined;
      if (enforced && hasPending) throw new Error(`${rule.id} cannot be both enforced and pending.`);
      if (!enforced && !hasPending) throw new Error(`${rule.id} must have enforcement or a pending ticket.`);
      if (hasPending && !nonEmpty(rule.pending)) throw new Error(`${rule.id} must name a non-empty pending ticket.`);
      for (const entry of rule.enforcement) {
        if (entry.kind === "consumer" && !nonEmpty(entry.detector)) {
          throw new Error(`${rule.id} must name a non-empty consumer detector.`);
        }
        if (entry.kind === "contract" && !nonEmpty(entry.id)) {
          throw new Error(`${rule.id} must name a non-empty contract id.`);
        }
        if (entry.kind === "review" && !nonEmpty(entry.anchor)) {
          throw new Error(`${rule.id} must name a non-empty review anchor.`);
        }
        if (entry.kind === "ratchet" && !nonEmpty(entry.rule)) {
          throw new Error(`${rule.id} must name a non-empty ratchet rule.`);
        }
      }
    }
  }
}

/** Look up one profile; an unknown id is a defect in the calling gate. */
export function goldenProfile(
  id: string,
  profiles: Readonly<Record<string, readonly GoldenProfileRule[]>> =
    getHouseRules().goldenProfiles ?? {},
): readonly GoldenProfileRule[] {
  const profile = profiles[id];
  if (!profile) throw new Error(`Unknown golden profile "${id}".`);
  return profile;
}
