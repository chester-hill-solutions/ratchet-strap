import type { GoldenProfileRule } from "./golden/index.js";

/** A named ESLint rule record owned by the consumer's project. */
export interface HousePolicy {
  id: string;
  rules: Record<string, "warn" | ["warn", Record<string, number | boolean>]>;
}

/**
 * The project-owned layer. The engine ships no thresholds, profiles or golden
 * compositions; a repository vendors `house-rules/` and passes its module here.
 */
export interface HouseRules {
  policy?: HousePolicy;
  goldenProfiles?: Readonly<Record<string, readonly GoldenProfileRule[]>>;
}

let configured: HouseRules = {};

/** Register the project's house rules. The CLI does this after loading its module. */
export function configureHouseRules(rules: HouseRules): void {
  configured = rules;
}

/** Read-only view of the configured house rules. */
export function getHouseRules(): HouseRules {
  return configured;
}

/** Restore the empty registry. Intended for tests and long-lived processes. */
export function resetHouseRules(): void {
  configured = {};
}
