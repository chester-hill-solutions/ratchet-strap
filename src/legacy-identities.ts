import { summarizeIdentities } from "./identity.js";
import { legacyIdentitiesRuleIds } from "./identity-types.js";
import type { IdentityObservation } from "./identity-types.js";
import { collectLegacyIdentitiesCycles } from "./legacy-identities-cycles.js";

export function summarizeLegacyIdentities(
  reports: unknown,
  tracked: readonly string[],
  options: { root: string },
): IdentityObservation {
  if (tracked.length !== legacyIdentitiesRuleIds.length || legacyIdentitiesRuleIds.some((rule) => !tracked.includes(rule))) {
    throw new Error("identities-cycles@1 requires exactly its eight tracked rule IDs");
  }
  const observed = summarizeIdentities(reports, tracked, { adapter: "identities-cycles@1", root: options.root });
  const cycles = collectLegacyIdentitiesCycles(options.root);
  const identities = new Set(observed.identities["import/no-cycle"] ?? []);
  for (const identity of cycles) {
    if (!identities.has(identity)) {
      identities.add(identity);
      observed.diagnostics.push({
        file: identity.split(" -> ")[0] ?? "app",
        ruleId: "import/no-cycle", kind: "warning",
        message: `Import cycle: ${identity}`,
      });
    }
  }
  observed.identities["import/no-cycle"] = [...identities].sort();
  observed.counts["import/no-cycle"] = identities.size;
  return observed;
}
