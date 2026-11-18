import { existsSync, readFileSync, realpathSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { runAdoption } from "./adoption-commands.js";
import { importLegacyCountsBaseline } from "./baseline.js";
import { emptyBaseline, initialize, loadReport, parseRuleList, runGate } from "./commands.js";
import { importLegacyIdentitiesBaseline } from "./identity.js";
import { readJson, writeBaseline } from "./io.js";
import { detectProjects } from "./migration.js";
import { parseRatchetBaseline, trackedRules } from "./product.js";
import { describeRules, getProfile, profileForAdapter, profiles } from "./profiles.js";
import { packageVersion } from "./package-meta.js";
import { importLegacyMessagesBaseline } from "./legacy-messages.js";
import { importLegacyStrictCountsBaseline } from "./legacy-strict-counts.js";

const help = `RatchetStrap ${packageVersion}
  init --rules rule-a,rule-b [--profile eslint@1] [--report FILE | --exec-eslint]
  check | tighten | add --baseline FILE [--report FILE | --exec-eslint]
  add --rules rule-a,rule-b [--write]
  inspect --baseline FILE
  rules | profiles
  detect --root DIR
  verify [--profile legacy-counts@1|legacy-identities@1|legacy-messages@1] [--report FILE | --exec-eslint]
  migrate [--profile legacy-counts@1|legacy-identities@1|legacy-messages@1] [--from FILE] [--write]
  migrate --apply [--report FILE | --exec-eslint]
  import-legacy-counts | import-legacy-identities | import-legacy-messages | import-legacy-strict-counts --from FILE [--baseline FILE]

Common: --root DIR (default: cwd), --baseline FILE (default: .ratchet-strap.json)
Runner: --eslint-config FILE, --cache-location DIR (with --exec-eslint)
Guards: --previous-baseline FILE; legacy identities reads HEAD^; legacy strict counts requires --base-ref, RATCHET_STRAP_BASE_REF or HEAD^
Report default: eslint-report.json. Output is JSON. Exit: 0 success, 1 violations, 2 invalid input/tool failure.
New projects use strict identities. Tighten/add/migrate preview changes; --write saves only baselines.
Imports and init never overwrite. migrate --apply changes script aliases only after verified passing parity.`;

const reportFlags = ["report", "exec-eslint", "eslint-config", "cache-location"];
const gateFlags = ["baseline", "root", ...reportFlags, "previous-baseline", "legacy-baseline", "base-ref"];
const allowed: Record<string, readonly string[]> = {
  check: gateFlags, tighten: [...gateFlags, "write"], add: [...gateFlags, "write", "rules"],
  inspect: ["baseline", "root"],
  init: ["baseline", "root", "rules", "adapter", "profile", ...reportFlags],
  "import-legacy-counts": ["baseline", "root", "from"],
  "import-legacy-identities": ["baseline", "root", "from"],
  "import-legacy-messages": ["baseline", "root", "from"],
  "import-legacy-strict-counts": ["baseline", "root", "from"],
  detect: ["root"],
  verify: ["root", "profile", "from", "baseline", "report", "exec-eslint"],
  migrate: ["root", "profile", "from", "baseline", "write", "apply", "report", "exec-eslint"],
  profiles: [], rules: [],
};

export function runCli(args: string[], io: { cwd?: string; stdout?: (text: string) => void } = {}): number {
  const stdout = io.stdout ?? console.log;
  const { positionals, values } = parseArgs({
    args, allowPositionals: true, strict: true,
    options: {
      baseline: { type: "string" }, report: { type: "string" }, root: { type: "string" },
      from: { type: "string" }, rules: { type: "string" }, adapter: { type: "string" }, profile: { type: "string" },
      "eslint-config": { type: "string" }, "cache-location": { type: "string" },
      "previous-baseline": { type: "string" }, "legacy-baseline": { type: "string" },
      "base-ref": { type: "string" },
      "exec-eslint": { type: "boolean" }, write: { type: "boolean" }, apply: { type: "boolean" }, help: { type: "boolean" }, version: { type: "boolean" },
    },
  });
  const command = positionals[0] ?? "help";
  if (values.version) { stdout(packageVersion); return 0; }
  if (values.help || command === "help") { stdout(help); return 0; }
  if (positionals.length !== 1) throw new Error("Expected exactly one command");
  const allowedOptions = Object.hasOwn(allowed, command) ? allowed[command] : undefined;
  if (!allowedOptions) throw new Error(`Unknown command: ${command}`);
  for (const key of Object.keys(values)) {
    if (!allowedOptions.includes(key)) throw new Error(`--${key} is not supported by ${command}`);
  }
  const print = (value: unknown) => stdout(JSON.stringify(value, null, 2));
  if (command === "rules") { print(describeRules()); return 0; }
  if (command === "profiles") { print({ profiles }); return 0; }
  const root = realpathSync(resolve(values.root ?? io.cwd ?? process.cwd()));
  const path = resolve(root, values.baseline ?? ".ratchet-strap.json");
  if (command === "detect") { print(detectProjects(root)); return 0; }
  if (command === "migrate" || command === "verify") {
    const result = runAdoption({
      command, root, profile: values.profile, from: values.from, baseline: values.baseline,
      write: values.write, apply: values.apply,
      report: { report: values.report, execEslint: values["exec-eslint"], eslintConfig: values["eslint-config"], cacheLocation: values["cache-location"] },
    });
    print(result.output); return result.code;
  }
  if (command === "import-legacy-counts" || command === "import-legacy-identities" || command === "import-legacy-messages" || command === "import-legacy-strict-counts") {
    if (!values.from) throw new Error(`${command} requires --from FILE`);
    const input = readJson(resolve(root, values.from));
    const baseline = command === "import-legacy-counts" ? importLegacyCountsBaseline(input)
      : command === "import-legacy-messages" ? importLegacyMessagesBaseline(input)
        : command === "import-legacy-strict-counts" ? importLegacyStrictCountsBaseline(input) : importLegacyIdentitiesBaseline(input);
    writeBaseline(path, baseline, null);
    print({ baseline: path, imported: baseline }); return 0;
  }
  if (values.profile && values.adapter && getProfile(values.profile).adapter !== values.adapter) throw new Error("--adapter and --profile disagree");
  if (command === "init" && existsSync(path)) throw new Error(`Baseline already exists: ${path}`);
  const original = command === "init" ? null : readFileSync(path, "utf8");
  const baseline = original === null
    ? emptyBaseline(parseRuleList(values.rules), values.profile, values.adapter)
    : parseRatchetBaseline(JSON.parse(original));
  if (command === "inspect") {
    const profile = baseline.schemaVersion === 2 && baseline.profileId
      ? getProfile(baseline.profileId)
      : profileForAdapter(baseline.adapter);
    print({ baseline: path, ...baseline, profile, trackedRules: trackedRules(baseline) });
    return 0;
  }
  if (values["legacy-baseline"] && baseline.adapter !== "identities-cycles@1" && baseline.adapter !== "strict-counts@1") throw new Error("--legacy-baseline only applies to legacy identities or LegacyStrictCounts compatibility");
  if (values["base-ref"] && baseline.adapter !== "strict-counts@1") throw new Error("--base-ref only applies to LegacyStrictCounts compatibility");
  if (values["base-ref"] && values["previous-baseline"]) throw new Error("Choose --base-ref or --previous-baseline");
  const reports = loadReport(root, baseline, {
    report: values.report ? resolve(root, values.report) : undefined, execEslint: values["exec-eslint"],
    eslintConfig: values["eslint-config"], cacheLocation: values["cache-location"],
  });
  if (command === "init") {
    const result = initialize(path, baseline, reports, root);
    print(result.output); return result.code;
  }
  if ((command !== "check" && command !== "tighten" && command !== "add") || original === null) throw new Error(`Unknown gate command: ${command}`);
  const previous = values["previous-baseline"] ? parseRatchetBaseline(readJson(resolve(root, values["previous-baseline"]))) : undefined;
  const result = runGate({
    command, root, path, original, baseline, reports, previous, write: Boolean(values.write),
    rules: command === "add" ? parseRuleList(values.rules) : undefined, legacyBaseline: values["legacy-baseline"],
    baseRef: values["base-ref"],
  });
  print(result.output); return result.code;
}
