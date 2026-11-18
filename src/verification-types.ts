import type { MigrationPlan } from "./migration.js";
import type { RatchetEvaluation } from "./product.js";
import type { IdentityMap } from "./identity-types.js";

export interface MigrationVerification {
  plan: MigrationPlan;
  equivalent: boolean;
  canApply: boolean;
  lintPassed?: boolean;
  legacy: {
    passed: boolean;
    exitCode: number;
    counts: Record<string, number>;
    identities?: IdentityMap;
    stdout: string;
    stderr: string;
  };
  current: RatchetEvaluation;
  differences: string[];
  snapshot: Record<string, string>;
  cycleSources?: string[];
  projectFiles?: string[];
  gitHead?: string;
}
