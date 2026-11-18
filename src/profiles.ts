import type { AdapterId } from "./types.js";
import type { IdentityAdapterId } from "./identity-types.js";
import { getHouseRules } from "./house-rules.js";

export type ProfileId = "eslint@1" | "eslint-counts@1";

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
  {
    id: "eslint@1",
    adapter: "eslint-identities@1",
    mode: "identities",
    description: "Reject new violations and stale baseline entries",
  },
  {
    id: "eslint-counts@1",
    adapter: "eslint-json@1",
    mode: "counts",
    description: "Per-rule warning and suppressed-diagnostic budgets",
  },
];

export function getProfile(id: string): Profile {
  const profile = profiles.find((entry) => entry.id === id);
  if (!profile) throw new Error(`Unknown profile: ${id}. Supported: ${profiles.map((entry) => entry.id).join(", ")}`);
  return profile;
}

export function profileForAdapter(adapter: AdapterId | IdentityAdapterId): Profile {
  const profile = profiles.find((entry) => entry.adapter === adapter);
  if (!profile) throw new Error(`Unknown adapter: ${adapter}`);
  return profile;
}

export function describeRules() {
  const policy = getHouseRules().policy;
  return { policy: policy?.id ?? null, rules: policy?.rules ?? {}, profiles };
}
