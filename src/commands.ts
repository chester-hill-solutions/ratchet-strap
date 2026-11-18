import { existsSync } from "node:fs";
import { resolve } from "node:path";

import { parseBaseline } from "./baseline.js";
import { parseIdentityBaseline } from "./identity.js";
import { addRules, checkBaseline, observeBaseline, tightenBaseline } from "./product.js";
import { getProfile, profileForAdapter, profiles } from "./profiles.js";
import { runEslint } from "./runner.js";
import { readJson, writeBaseline } from "./io.js";
import type { RatchetBaseline } from "./product.js";

export interface ReportOptions {
  report?: string;
  execEslint?: boolean;
  eslintConfig?: string;
  cacheLocation?: string;
}

export function parseRuleList(value: string | undefined): string[] {
  if (!value) throw new Error("An explicit --rules rule-a,rule-b list is required");
  const rules = value.split(",").map((rule) => rule.trim());
  if (rules.some((rule) => !rule) || new Set(rules).size !== rules.length) throw new Error("--rules must list unique non-empty rule IDs");
  return rules;
}

export function emptyBaseline(rules: readonly string[], profileId = "eslint@1", adapter?: string): RatchetBaseline {
  function parseAdapterId(value: string) {
    const profile = profiles.find((entry) => entry.adapter === value);
    if (!profile) throw new Error(`Unknown adapter: ${value}`);
    return profile.adapter;
  }

  const profile = adapter ? profileForAdapter(parseAdapterId(adapter)) : getProfile(profileId);
  if (adapter && profileId !== "eslint@1" && profile.id !== profileId) throw new Error("--adapter and --profile disagree");
  if (profile.mode === "identities") {
    return parseIdentityBaseline({
      schemaVersion: 2,
      mode: "identities",
      adapter: profile.adapter,
      identities: Object.fromEntries(rules.map((rule) => [rule, []])),
      ...(profileId !== "eslint@1" ? { profileId: profile.id } : {}),
    });
  }
  return parseBaseline({
    schemaVersion: 1,
    adapter: profile.adapter,
    counts: Object.fromEntries(rules.map((rule) => [rule, 0])),
  });
}

export function loadReport(root: string, baseline: RatchetBaseline, options: ReportOptions): unknown {
  if (options.report && options.execEslint) throw new Error("Choose either --report or --exec-eslint");
  if (!options.execEslint && (options.eslintConfig || options.cacheLocation)) throw new Error("ESLint runner flags require --exec-eslint");
  if (!options.execEslint) return readJson(resolve(root, options.report ?? "eslint-report.json"));
  const profile = baseline.schemaVersion === 2 && baseline.profileId
    ? getProfile(baseline.profileId)
    : profileForAdapter(baseline.adapter);
  return runEslint(resolve(root, profile.eslintDirectory ?? "."), {
    config: options.eslintConfig ?? profile.eslintConfig,
    cacheLocation: options.cacheLocation ?? profile.cacheLocation,
  });
}

export function initialize(path: string, baseline: RatchetBaseline, reports: unknown, root: string) {
  if (existsSync(path)) throw new Error(`Baseline already exists: ${path}`);
  const observed = observeBaseline(baseline, reports, root);
  const result = checkBaseline(baseline, observed);
  if (observed.errors.length) return { code: 1, output: result };
  const initial = baseline.schemaVersion === 2 && "identities" in observed
    ? { ...baseline, identities: observed.identities }
    : { ...baseline, counts: observed.counts };
  writeBaseline(path, initial, null);
  return { code: 0, output: { baseline: path, initialized: initial } };
}

export function runGate(options: {
  command: "check" | "tighten" | "add";
  root: string;
  path: string;
  original: string;
  baseline: RatchetBaseline;
  reports: unknown;
  write: boolean;
  rules?: string[];
  previous?: RatchetBaseline;
}) {
  const { command, baseline, reports, root, path, original, write } = options;
  const observed = observeBaseline(baseline, reports, root);
  const result = checkBaseline(baseline, observed, options.previous);
  if (command === "check") return { code: result.ok ? 0 : 1, output: { ...result, baseline: path } };
  if (command === "add") {
    if (!result.ok) return { code: 1, output: { ...result, baseline: path } };
    const next = addRules(baseline, options.rules ?? [], reports, root);
    if (write) writeBaseline(path, next, original);
    return { code: 0, output: { ok: true, baseline: path, written: write, proposedBaseline: next } };
  }
  if (!result.canTighten) return { code: 1, output: { ...result, baseline: path } };
  const next = tightenBaseline(baseline, observed, options.previous);
  const changed = JSON.stringify(next) !== JSON.stringify(baseline);
  const written = write && changed;
  if (written) writeBaseline(path, next, original);
  return { code: 0, output: { ...result, ok: true, checkOk: result.ok, baseline: path, written, proposedBaseline: next } };
}
