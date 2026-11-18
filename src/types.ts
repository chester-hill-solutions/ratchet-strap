export type AdapterId = "eslint-json@1" | "suppression-counts@1" | "message-counts@1" | "strict-counts@1";

export interface Baseline {
  schemaVersion: 1;
  adapter: AdapterId;
  counts: Record<string, number>;
  _comment?: string;
}

export interface Diagnostic {
  file: string;
  severity?: 1 | 2;
  line?: number;
  column?: number;
  ruleId: string | null;
  message: string;
  kind: "warning" | "error" | "suppressed" | "directive";
}

export interface Observation {
  adapter: AdapterId;
  counts: Record<string, number>;
  errors: Diagnostic[];
  diagnostics: Diagnostic[];
  files: number;
}

export interface RuleChange {
  ruleId: string;
  before: number;
  now: number;
  delta: number;
}

export interface Evaluation {
  ok: boolean;
  adapter: AdapterId;
  counts: Record<string, number>;
  changes: RuleChange[];
  regressions: RuleChange[];
  improvements: RuleChange[];
  errors: Diagnostic[];
  diagnostics: Diagnostic[];
  files: number;
}
