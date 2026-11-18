export function record(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

export function parseCounts(value: unknown): Record<string, number> {
  const entries = Object.entries(record(value, "Baseline counts"));
  if (entries.length === 0) throw new Error("Baseline must track at least one rule");
  return Object.fromEntries(entries.map(([ruleId, count]) => {
    if (!ruleId.trim() || !Number.isSafeInteger(count) || typeof count !== "number" || count < 0) {
      throw new Error(`Invalid baseline count for ${ruleId}`);
    }
    return [ruleId, count];
  }));
}
