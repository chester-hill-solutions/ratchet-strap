import type { Diagnostic, RuleChange } from "./types.js";

export type IdentityAdapterId = "eslint-identities@1";
export type IdentityMap = Record<string, string[]>;

export interface IdentityBaseline {
  schemaVersion: 2;
  mode: "identities";
  adapter: IdentityAdapterId;
  identities: IdentityMap;
  profileId?: string;
  _comment?: string;
}

export interface IdentityObservation {
  adapter: IdentityAdapterId;
  identities: IdentityMap;
  counts: Record<string, number>;
  errors: Diagnostic[];
  diagnostics: Diagnostic[];
  files: number;
}

export interface IdentityEvaluation {
  ok: boolean;
  canTighten: boolean;
  adapter: IdentityAdapterId;
  counts: Record<string, number>;
  changes: RuleChange[];
  regressions: RuleChange[];
  improvements: RuleChange[];
  added: IdentityMap;
  stale: IdentityMap;
  baselineGrowth: IdentityMap;
  errors: Diagnostic[];
  diagnostics: Diagnostic[];
  files: number;
}
