import { existsSync, readFileSync } from "node:fs";
import { relative, resolve } from "node:path";
import { importLegacyCountsBaseline } from "./baseline.js";
import { importLegacyIdentitiesBaseline } from "./identity.js";
import type { IdentityBaseline } from "./identity-types.js";
import type { Baseline } from "./types.js";
import { record } from "./validation.js";
import { importLegacyMessagesBaseline } from "./legacy-messages.js";
import { legacyMessagesCheckerSha256 } from "./legacy-messages-types.js";
import { importLegacyStrictCountsBaseline, legacyStrictCountsCheckerSha256 } from "./legacy-strict-counts.js";
import { createMigrationEnvironment } from "./migration-environment.js";

export type MigrationProfile = "legacy-counts@1" | "legacy-identities@1" | "legacy-messages@1";

export interface MigrationCandidate {
  profile: MigrationProfile;
  source: string;
  checker: string;
  recognized: boolean;
  reason: string;
}

export interface ProjectDetection {
  candidates: MigrationCandidate[];
  unsupported: string[];
}

export interface MigrationPlan {
  profile: MigrationProfile;
  source: string;
  target: string;
  baseline: Baseline | IdentityBaseline;
  scripts: Record<string, string>;
  notes: string[];
  recognized: boolean;
}

const sourceFile = "scripts/baselines/lint-ratchet.json";
const checkerFile = "scripts/check-lint-ratchet.mjs";
const profiles: readonly MigrationProfile[] = ["legacy-counts@1", "legacy-identities@1", "legacy-messages@1"];
const checkerHashes: Record<MigrationProfile, string> = {
  "legacy-counts@1": "904cac2837b6541ca71f56e89d76a2346a6b09edf17da8d7576cd0d4abdcbe3c",
  "legacy-identities@1": "7d9e1760329ad2015bccf5b65433171b74159d7379f45e72f188bd68763c6479",
  "legacy-messages@1": legacyMessagesCheckerSha256,
};

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf8"));
}

const baselineImporters = {
  "legacy-counts@1": importLegacyCountsBaseline,
  "legacy-identities@1": importLegacyIdentitiesBaseline,
  "legacy-messages@1": importLegacyMessagesBaseline,
} satisfies Record<MigrationProfile, (input: unknown) => Baseline | IdentityBaseline>;

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function detectProjects(root: string): ProjectDetection {
  const source = resolve(root, sourceFile);
  const checker = resolve(root, checkerFile);
  const result: ProjectDetection = { candidates: [], unsupported: [] };
  if (!existsSync(source) && !existsSync(checker)) return result;
  const hash = createMigrationEnvironment(root).checkerHash();
  if (hash === legacyStrictCountsCheckerSha256) {
    try {
      importLegacyStrictCountsBaseline(readJson(source));
      result.unsupported.push("LegacyStrictCounts lint detected: use import-legacy-strict-counts and the legacy-strict-counts@1 profile after comparing its checker/helpers; automatic verify/apply is not supported for this nested-package migration.");
    } catch (error) {
      result.unsupported.push(`LegacyStrictCounts lint detected with an unsupported baseline: ${message(error)}`);
    }
    return result;
  }
  const identified = profiles.find((profile) => checkerHashes[profile] === hash);
  let input: unknown;
  try {
    input = readJson(source);
  } catch (error) {
    const reason = `Cannot import ${sourceFile}: ${message(error)}`;
    if (identified) result.candidates.push({ profile: identified, source, checker, recognized: false, reason });
    result.unsupported.push(reason);
    return result;
  }
  const candidates = identified ? [identified] : profiles;
  for (const profile of candidates) {
    try {
      baselineImporters[profile](input);
      const recognized = hash === checkerHashes[profile];
      result.candidates.push({
        profile, source, checker, recognized,
        reason: recognized ? "Known checker fingerprint and supported baseline format"
          : hash ? "Baseline format is supported, but the checker fingerprint is unknown; parity is unverified"
            : "Baseline format is supported, but the checker is missing; parity is unverified",
      });
    } catch (error) {
      if (identified) {
        const reason = `Known checker has an unsupported baseline: ${message(error)}`;
        result.candidates.push({ profile, source, checker, recognized: false, reason });
        result.unsupported.push(reason);
      }
    }
  }
  if (result.candidates.length === 0) result.unsupported.push(`Unsupported lint-ratchet checker or baseline format at ${sourceFile}`);
  return result;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function commandPath(value: string): string {
  return value.startsWith("-") ? `./${value}` : value;
}

export function planMigration(options: {
  root: string;
  profile: MigrationProfile;
  from?: string;
  baseline?: string;
}): MigrationPlan {
  function packageScripts(root: string): Record<string, string> {
    const path = resolve(root, "package.json");
    if (!existsSync(path)) return {};
    const manifest = record(readJson(path), "Project package.json");
    if (manifest.scripts === undefined) return {};
    const scripts = record(manifest.scripts, "Project package.json scripts");
    return Object.fromEntries(Object.entries(scripts).map(([name, command]) => {
      if (typeof command !== "string") throw new Error(`Invalid package script: ${name}`);
      return [name, command];
    }));
  }

  function proposeScripts(
    root: string, source: string, target: string, profile: MigrationProfile, notes: string[],
  ): Record<string, string> {
    const scripts = packageScripts(root);
    const path = commandPath(relative(resolve(root), target).replaceAll("\\", "/"));
    const flags = ` --baseline ${shellQuote(path)} --exec-eslint`
      + (profile === "legacy-identities@1" ? " --eslint-config 'eslint.config.mjs' --cache-location '.cache/eslint-ratchet'"
        + ` --legacy-baseline ${shellQuote(commandPath(relative(resolve(root), source).replaceAll("\\", "/")))}`
        : profile === "legacy-counts@1" ? " --cache-location './node_modules/.cache/eslint'" : "");
    const suggestions: Record<string, string> = {};
    let checkFound = false;
    let baselineFound = false;
    for (const [name, command] of Object.entries(scripts)) {
      const simple = /^node\s+(?:\.\/)?scripts\/check-lint-ratchet\.mjs(?:\s+(--baseline|--write-baseline))?$/.exec(command.trim());
      if (simple) {
        const updating = Boolean(simple[1]);
        suggestions[name] = `ratchet-strap ${updating ? "tighten" : "check"}${flags}${updating ? " --write" : ""}`;
        if (updating) baselineFound = true;
        else checkFound = true;
      } else if (command.includes("check-lint-ratchet.mjs")) {
        notes.push(`Script ${name} contains custom or compound commands and has no automatic replacement suggestion.`);
      }
    }
    if (!checkFound && !Object.hasOwn(scripts, "check:lint-ratchet")) {
      suggestions["check:lint-ratchet"] = `ratchet-strap check${flags}`;
    }
    if (!baselineFound && !Object.hasOwn(scripts, "tools:lint-ratchet:baseline")) {
      suggestions["tools:lint-ratchet:baseline"] = `ratchet-strap tighten${flags} --write`;
    }
    return suggestions;
  }

  const root = resolve(options.root);
  const source = resolve(root, options.from ?? sourceFile);
  const target = resolve(root, options.baseline ?? ".ratchet-strap.json");
  if (source === target) throw new Error("Migration target must differ from the legacy baseline source");
  if (!Object.hasOwn(baselineImporters, options.profile)) throw new Error(`Unsupported migration profile: ${String(options.profile)}`);
  const baseline = baselineImporters[options.profile](readJson(source));
  const recognized = createMigrationEnvironment(root).checkerHash() === checkerHashes[options.profile];
  const notes = [
    "This plan does not execute the legacy checker or edit package scripts.",
    "Compare old and new gates on the same fresh reports and source tree before switching CI entry points.",
    "Keep the existing ESLint configuration, file scope, detector versions, and legacy baseline during adoption.",
    "The suggested baseline command only tightens allowances; it cannot reproduce a legacy writer that increases debt.",
  ];
  if (!recognized) notes.push("The checker fingerprint is unknown or missing. The baseline can be imported, but compatibility is unverified.");
  if (options.profile === "legacy-messages@1") {
    notes.push(
      "LegacyMessages compatibility counts tracked messages of either severity, ignores suppression metadata and unrelated errors, and retains the preceding npm run lint gate. Stronger suppression/error enforcement is a separate policy change.",
      "Guarded application also requires a clean ESLint result, even when the legacy ratchet alone would ignore an unrelated hard error.",
      "Missing legacy rule budgets import as zero. Initialization must not grandfather newly measured debt.",
      "The fixed runner is npx eslint -f json . without caching. Malformed, empty, or failed scans are rejected instead of reproducing legacy execution-error fallbacks.",
    );
  }
  if (existsSync(target)) notes.push("The target already exists. Preview is allowed; baseline creation must not overwrite it.");
  return {
    profile: options.profile, source, target, baseline, recognized, notes,
    scripts: proposeScripts(root, source, target, options.profile, notes),
  };
}
