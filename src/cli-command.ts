import { existsSync, readFileSync, realpathSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs } from "node:util";

import { emptyBaseline, initialize, loadReport, parseRuleList, runGate } from "./commands.js";
import { readJson } from "./io.js";
import { parseRatchetBaseline, trackedRules } from "./product.js";
import { describeRules, getProfile, profileForAdapter, profiles } from "./profiles.js";
import { packageVersion } from "./package-meta.js";

const help = `RatchetStrap ${packageVersion}
  init --rules rule-a,rule-b [--profile eslint@1] [--report FILE | --exec-eslint]
  check | tighten | add --baseline FILE [--report FILE | --exec-eslint]
  add --rules rule-a,rule-b [--write]
  inspect --baseline FILE
  rules | profiles

Common: --root DIR (default: cwd), --baseline FILE (default: .ratchet-strap.json)
Runner: --exec-eslint, --eslint-config FILE, --cache-location DIR
Guard: --previous-baseline FILE rejects baseline growth
Report default: eslint-report.json. Output is JSON. Exit: 0 success, 1 violations, 2 invalid input/tool failure.
New projects use strict identities. tighten/add preview; --write saves only baselines.`;

const reportFlags = ["report", "exec-eslint", "eslint-config", "cache-location"];
const gateFlags = ["baseline", "root", ...reportFlags, "previous-baseline"];
const allowed: Record<string, readonly string[]> = {
  check: gateFlags,
  tighten: [...gateFlags, "write"],
  add: [...gateFlags, "write", "rules"],
  inspect: ["baseline", "root"],
  init: ["baseline", "root", "rules", "adapter", "profile", ...reportFlags],
  profiles: [],
  rules: [],
};

export function runCli(args: string[], io: { cwd?: string; stdout?: (text: string) => void } = {}): number {
  const stdout = io.stdout ?? console.log;
  const { positionals, values } = parseArgs({
    args,
    allowPositionals: true,
    strict: true,
    options: {
      baseline: { type: "string" },
      report: { type: "string" },
      root: { type: "string" },
      rules: { type: "string" },
      adapter: { type: "string" },
      profile: { type: "string" },
      "eslint-config": { type: "string" },
      "cache-location": { type: "string" },
      "previous-baseline": { type: "string" },
      "exec-eslint": { type: "boolean" },
      write: { type: "boolean" },
      help: { type: "boolean" },
      version: { type: "boolean" },
    },
  });
  const command = positionals[0] ?? "help";

  if (values.version) {
    stdout(packageVersion);
    return 0;
  }
  if (values.help || command === "help") {
    stdout(help);
    return 0;
  }
  if (positionals.length !== 1) throw new Error("Expected exactly one command");

  const allowedOptions = Object.hasOwn(allowed, command) ? allowed[command] : undefined;
  if (!allowedOptions) throw new Error(`Unknown command: ${command}`);
  for (const key of Object.keys(values)) {
    if (!allowedOptions.includes(key)) throw new Error(`--${key} is not supported by ${command}`);
  }

  const print = (value: unknown) => stdout(JSON.stringify(value, null, 2));
  if (command === "rules") {
    print(describeRules());
    return 0;
  }
  if (command === "profiles") {
    print({ profiles });
    return 0;
  }

  const root = realpathSync(resolve(values.root ?? io.cwd ?? process.cwd()));
  const path = resolve(root, values.baseline ?? ".ratchet-strap.json");
  if (values.profile && values.adapter && getProfile(values.profile).adapter !== values.adapter) {
    throw new Error("--adapter and --profile disagree");
  }
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

  const reports = loadReport(root, baseline, {
    report: values.report ? resolve(root, values.report) : undefined,
    execEslint: values["exec-eslint"],
    eslintConfig: values["eslint-config"],
    cacheLocation: values["cache-location"],
  });

  if (command === "init") {
    const result = initialize(path, baseline, reports, root);
    print(result.output);
    return result.code;
  }
  if ((command !== "check" && command !== "tighten" && command !== "add") || original === null) {
    throw new Error(`Unknown gate command: ${command}`);
  }

  const previous = values["previous-baseline"]
    ? parseRatchetBaseline(readJson(resolve(root, values["previous-baseline"])))
    : undefined;
  const result = runGate({
    command,
    root,
    path,
    original,
    baseline,
    reports,
    previous,
    write: Boolean(values.write),
    rules: command === "add" ? parseRuleList(values.rules) : undefined,
  });
  print(result.output);
  return result.code;
}
