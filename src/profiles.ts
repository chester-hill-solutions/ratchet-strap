import type { AdapterId } from "./types.js";
import type { IdentityAdapterId } from "./identity-types.js";
import { legacyIdentitiesRuleIds } from "./identity-types.js";
import { legacyMessagesRuleIds } from "./legacy-messages-types.js";
import { legacyStrictCountsRuleIds } from "./legacy-strict-counts.js";
import { getHouseRules } from "./house-rules.js";

export type ProfileId = "eslint@1" | "eslint-counts@1" | "legacy-counts@1" | "legacy-identities@1" | "legacy-messages@1" | "legacy-strict-counts@1";

export interface Profile {
  id: ProfileId;
  adapter: AdapterId | IdentityAdapterId;
  mode: "counts" | "identities";
  description: string;
  rules?: readonly string[];
  eslintConfig?: string;
  cacheLocation?: string;
  eslintDirectory?: string;
}

export const profiles: readonly Profile[] = [
  { id: "eslint@1", adapter: "eslint-identities@1", mode: "identities", description: "Recommended: reject new violations and stale baseline entries" },
  { id: "eslint-counts@1", adapter: "eslint-json@1", mode: "counts", description: "Per-rule warning and suppressed-diagnostic budgets" },
  { id: "legacy-counts@1", adapter: "suppression-counts@1", mode: "counts", description: "Preserve legacy count suppression-comment accounting", cacheLocation: "./node_modules/.cache/eslint" },
  { id: "legacy-identities@1", adapter: "identities-cycles@1", mode: "identities", description: "Preserve legacy identities, import cycles, and predecessor protection", rules: legacyIdentitiesRuleIds, eslintConfig: "eslint.config.mjs", cacheLocation: ".cache/eslint-ratchet" },
  { id: "legacy-messages@1", adapter: "message-counts@1", mode: "counts", description: "Preserve seven message counts; suppressions and unrelated errors are ignored, so retain the preceding lint gate", rules: legacyMessagesRuleIds },
  { id: "legacy-strict-counts@1", adapter: "strict-counts@1", mode: "counts", description: "Preserve strict count suppression budgets, stale budgets and required Git-base protection; import only, no automatic script migration", rules: legacyStrictCountsRuleIds, eslintDirectory: "packages/legacy-strict-counts-s3" },
];

export function getProfile(id: string): Profile {
  const profile = profiles.find((profile) => profile.id === id);
  if (!profile) throw new Error(`Unknown profile: ${id}. Supported: ${profiles.map((entry) => entry.id).join(", ")}`);
  return profile;
}

export function profileForAdapter(adapter: AdapterId | IdentityAdapterId): Profile {
  const profile = profiles.find((profile) => profile.adapter === adapter);
  if (!profile) throw new Error(`Unknown adapter: ${adapter}`);
  return profile;
}

export function describeRules() {
  const policy = getHouseRules().policy;
  return { policy: policy?.id ?? null, rules: policy?.rules ?? {}, profiles };
}
