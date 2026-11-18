import { legacyMessagesRuleIds } from "./legacy-messages-types.js";

/** The original checker has no writer. A temporary -1 allowance exposes each original count. */
export function legacyMessagesMeasurementBaseline(): string {
  return JSON.stringify(Object.fromEntries(legacyMessagesRuleIds.map((rule) => [rule, -1])));
}

export function parseLegacyMessagesMeasurement(stderr: string): { counts: Record<string, number> } {
  const counts: Record<string, number> = {};
  for (const line of stderr.split("\n")) {
    const match = /^- (.+): ([0-9]+) > baseline -1$/.exec(line);
    if (!match) continue;
    const rule = match[1];
    const count = Number(match[2]);
    if (!rule || !legacyMessagesRuleIds.some((known) => known === rule) || Object.hasOwn(counts, rule) || !Number.isSafeInteger(count)) {
      throw new Error("Invalid legacy messages reference measurement");
    }
    counts[rule] = count;
  }
  if (Object.keys(counts).length !== legacyMessagesRuleIds.length) throw new Error("Incomplete legacy messages reference measurement");
  return { counts };
}
