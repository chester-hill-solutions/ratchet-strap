/**
 * Ratchet semantics moved here from the shared CHS guard package when
 * the package was extracted. The behaviour is unchanged: existing debt is
 * grandfathered, new debt fails, and the baseline can only shrink.
 */
import { readFileSync } from "node:fs";

export type BaselineShape = string[] | Record<string, unknown>;

function isBaseline(value: unknown): value is BaselineShape {
  return Array.isArray(value)
    ? value.every((entry) => typeof entry === "string")
    : typeof value === "object" && value !== null;
}

export function baselineEntries(baseline: BaselineShape): string[] {
  if (!isBaseline(baseline)) throw new TypeError("Expected a string array or identifier map baseline");
  return Array.isArray(baseline) ? baseline : Object.keys(baseline);
}

/** New (not baselined) + stale (baselined but no longer present) entries. */
export function diffRatchet(
  current: string[],
  baseline: BaselineShape,
): { fresh: string[]; stale: string[] } {
  const allowed = new Set(baselineEntries(baseline));
  const present = new Set(current);
  return {
    fresh: current.filter((entry) => !allowed.has(entry)).sort(),
    stale: baselineEntries(baseline).filter((entry) => !present.has(entry)).sort(),
  };
}

export function loadBaseline(path: string): BaselineShape {
  const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (!isBaseline(parsed)) throw new TypeError(`Invalid baseline at ${path}: expected string array or identifier map`);
  return parsed;
}
