import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { readLegacyStrictCountsPredecessor } from "./legacy-strict-counts-predecessor.js";
import { emptyBaseline, initialize } from "./commands.js";
import { detectProjects } from "./migration.js";
import { checkBaseline, observeBaseline, parseRatchetBaseline, tightenBaseline } from "./product.js";
import {
  evaluateLegacyStrictCounts, importLegacyStrictCountsBaseline, parseLegacyStrictCountsBaseline, legacyStrictCountsRuleIds, summarizeLegacyStrictCounts, tightenLegacyStrictCounts,
} from "./legacy-strict-counts.js";
import type { LegacyStrictCountsObservation } from "./legacy-strict-counts.js";

const fixtures = fileURLToPath(new URL("../fixtures/", import.meta.url));
const cliPath = fileURLToPath(new URL("./cli.ts", import.meta.url));
const sourcePath = "scripts/baselines/lint-ratchet.json";
let root: string;
const warning = { ruleId: "no-console", severity: 1, message: "Unexpected console statement.", line: 1 };
const counts = (overrides: Record<string, number> = {}) => ({ ...Object.fromEntries(legacyStrictCountsRuleIds.map((rule) => [rule, 0])), ...overrides });

function write(file: string, content: string): void {
  const path = join(root, file);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

function git(...args: string[]) {
  const result = spawnSync("git", [
    "-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false",
    "-c", "user.name=RatchetStrap fixture", "-c", "user.email=fixture@example.invalid", ...args,
  ], { cwd: root, encoding: "utf8", env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" } });
  expect(result.status).toBe(0);
  return result;
}

function recordHistory(files = [sourcePath]): void {
  git("init", "--quiet");
  git("add", ...files);
  git("commit", "--quiet", "-m", "Previous allowance");
  git("commit", "--quiet", "--allow-empty", "-m", "Current source");
}

function setup(allowed = counts(), previous: unknown = { counts: allowed }): void {
  write(sourcePath, typeof previous === "string" ? previous : JSON.stringify(previous));
  recordHistory();
  write(sourcePath, JSON.stringify({ _comment: "Current allowance", counts: allowed }));
}

function report(messages: unknown[] = [], suppressedMessages: unknown[] = []) {
  const reports = [{ filePath: join(root, "packages/legacy-strict-counts-s3/src/a.ts"), messages, suppressedMessages }];
  write("report.json", JSON.stringify(reports));
  return reports;
}

function original(args: string[] = [], options: { ref?: string; measurement?: boolean } = {}) {
  return spawnSync("node", [join(root, "scripts/check-lint-ratchet.mjs"), ...args], {
    cwd: root, encoding: "utf8", env: {
      ...process.env, RATCHET_STRAP_BASE_REF: options.ref ?? "HEAD^", RATCHET_STRAP_LEGACY_REPORT: join(root, "report.json"),
      RATCHET_STRAP_LEGACY_MEASURE: options.measurement ? "1" : "",
    },
  });
}

function measuredCounts(): Record<string, number> {
  const path = join(root, sourcePath);
  const saved = readFileSync(path, "utf8");
  try {
    const measured = original(["--baseline"], { measurement: true });
    expect(measured.status).toBe(0);
    return JSON.parse(readFileSync(path, "utf8")).counts;
  } finally {
    writeFileSync(path, saved);
  }
}

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "ratchet-strap-legacy-strict-counts-")));
  write("packages/legacy-strict-counts-s3/src/a.ts", "export {};\n");
  write("packages/legacy-strict-counts-s3/package.json", '{"type":"module"}\n');
  write("packages/legacy-strict-counts-s3/node_modules/eslint/package.json", '{"type":"commonjs"}\n');
  write("packages/legacy-strict-counts-s3/node_modules/eslint/bin/eslint.js", `const fs = require('node:fs');
const report = JSON.parse(fs.readFileSync(process.env.RATCHET_STRAP_LEGACY_REPORT, 'utf8'));
process.stdout.write(JSON.stringify(report));
if (!process.env.RATCHET_STRAP_LEGACY_MEASURE && report.some(file => (file.messages ?? []).some(message => message.severity === 2))) process.exit(1);
`);
  mkdirSync(join(root, "scripts"), { recursive: true });
  for (const file of ["check-lint-ratchet.mjs", "baseline-history.mjs", "ratchet.mjs"]) {
    copyFileSync(join(fixtures, `legacy-strict-counts-${file}`), join(root, "scripts", file));
  }
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

function runCli(...args: string[]) {
  return spawnSync(process.execPath, [cliPath, ...args, "--root", root], {
    encoding: "utf8", env: {
      ...process.env, RATCHET_STRAP_BASE_REF: "HEAD^", RATCHET_STRAP_LEGACY_REPORT: join(root, "report.json"),
    },
  });
}

describe("LegacyStrictCounts product and CLI integration", () => {
  test("generic APIs preserve strict stale decisions and downward tightening", () => {
    const baseline = parseRatchetBaseline(importLegacyStrictCountsBaseline({ counts: counts({ "no-console": 1 }) }));
    const observed = observeBaseline(baseline, report(), root);
    const result = checkBaseline(baseline, observed);
    expect(result.ok).toBe(false);
    expect(result.canTighten).toBe(true);
    expect(tightenBaseline(baseline, observed)).toMatchObject({ counts: counts() });
    expect(() => emptyBaseline(legacyStrictCountsRuleIds, "legacy-strict-counts@1")).toThrow("import-legacy-strict-counts");
    expect(() => initialize(join(root, "new.json"), baseline, report(), root)).toThrow("import-legacy-strict-counts");
  });

  test("imports once, runs nested ESLint, then previews and saves stale improvements", () => {
    setup(counts({ "no-console": 1 }));
    report();
    const original = readFileSync(join(root, sourcePath), "utf8");
    expect(runCli("import-legacy-strict-counts", "--from", sourcePath).status).toBe(0);
    expect(runCli("import-legacy-strict-counts", "--from", sourcePath).status).toBe(2);
    const check = runCli("check", "--exec-eslint", "--base-ref", "HEAD^");
    expect(check.status).toBe(1);
    expect(JSON.parse(check.stdout)).toMatchObject({ canTighten: true, improvements: [{ ruleId: "no-console" }] });
    const preview = runCli("tighten", "--exec-eslint");
    expect(preview.status).toBe(0);
    expect(JSON.parse(preview.stdout).written).toBe(false);
    expect(JSON.parse(readFileSync(join(root, ".ratchet-strap.json"), "utf8")).counts["no-console"]).toBe(1);
    expect(runCli("tighten", "--exec-eslint", "--write").status).toBe(0);
    expect(runCli("check", "--exec-eslint").status).toBe(0);
    expect(readFileSync(join(root, sourcePath), "utf8")).toBe(original);
  });

  test("rejects expanded budgets against legacy history and leaves the baseline intact", () => {
    setup(counts({ "no-console": 2 }), { counts: counts({ "no-console": 1 }) });
    report([warning, warning]);
    expect(runCli("import-legacy-strict-counts", "--from", sourcePath).status).toBe(0);
    const before = readFileSync(join(root, ".ratchet-strap.json"), "utf8");
    const result = runCli("tighten", "--exec-eslint", "--write");
    expect(result.status).toBe(1);
    expect(JSON.parse(result.stdout).baselineGrowth).toHaveLength(1);
    expect(readFileSync(join(root, ".ratchet-strap.json"), "utf8")).toBe(before);
    expect(runCli("check", "--exec-eslint", "--base-ref", "refs/missing").status).toBe(2);
    expect(runCli("check", "--exec-eslint", "--cache-location", "other-cache").status).toBe(2);
  });

  test("detection does not suggest automatic LegacyCounts migration for LegacyStrictCounts", () => {
    setup();
    const found = detectProjects(root);
    expect(found.candidates).toEqual([]);
    expect(found.unsupported.join(" ")).toContain("import-legacy-strict-counts");
    expect(runCli("migrate", "--apply", "--exec-eslint").status).toBe(2);
  });

  test("a missing nested ESLint never falls back to an ancestor installation", () => {
    setup();
    report();
    expect(runCli("import-legacy-strict-counts", "--from", sourcePath).status).toBe(0);
    rmSync(join(root, "packages/legacy-strict-counts-s3/node_modules/eslint"), { recursive: true });
    write("node_modules/eslint/package.json", '{"name":"eslint","type":"commonjs"}\n');
    write("node_modules/eslint/bin/eslint.js", "process.stdout.write(require('node:fs').readFileSync(process.env.RATCHET_STRAP_LEGACY_REPORT, 'utf8'));\n");
    expect(original().status).not.toBe(0);
    const result = runCli("check", "--exec-eslint");
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("Install ESLint in packages/legacy-strict-counts-s3");
  });
});

describe("LegacyStrictCounts lint contract against its frozen checker and helpers", () => {
  test("fixtures retain their recorded source bytes and the original ten zero budgets", () => {
    const provenance = JSON.parse(readFileSync(join(fixtures, "legacy-strict-counts-provenance.json"), "utf8"));
    for (const name of ["check-lint-ratchet.mjs", "baseline-history.mjs", "ratchet.mjs"]) {
      expect(createHash("sha256").update(readFileSync(join(fixtures, `legacy-strict-counts-${name}`))).digest("hex")).toBe(provenance.files[`scripts/${name}`].sha256);
    }
    const baseline = importLegacyStrictCountsBaseline(JSON.parse(readFileSync(join(fixtures, "legacy-strict-counts-lint-ratchet.json"), "utf8")));
    expect(baseline.counts).toEqual(counts());
    expect(Object.keys(baseline.counts)).toHaveLength(10);
  });

  const cases = [
    { name: "zero debt", allowed: 0, messages: [], suppressed: [], passed: true, measured: 0 },
    { name: "unchanged warning", allowed: 1, messages: [warning], suppressed: [], passed: true, measured: 1 },
    { name: "new warning", allowed: 0, messages: [warning], suppressed: [], passed: false, measured: 1 },
    { name: "stale count", allowed: 2, messages: [warning], suppressed: [], passed: false, measured: 1 },
    { name: "untracked warning", allowed: 0, messages: [{ ...warning, ruleId: "other" }], suppressed: [], passed: true, measured: 0 },
    { name: "hard error", allowed: 0, messages: [{ ...warning, severity: 2 }], suppressed: [], passed: false, measured: 0 },
    { name: "suppressed warnings", allowed: 3, messages: [], suppressed: [warning, warning, warning], passed: true, measured: 3 },
    { name: "suppressed hard error", allowed: 1, messages: [], suppressed: [{ ...warning, severity: 2 }], passed: true, measured: 1 },
  ];
  for (const example of cases) {
    test(example.name, () => {
      setup(counts({ "no-console": example.allowed }));
      const reports = report(example.messages, example.suppressed);
      const baseline = importLegacyStrictCountsBaseline(JSON.parse(readFileSync(join(root, sourcePath), "utf8")));
      const previous = readLegacyStrictCountsPredecessor(root, undefined, undefined, { ref: "HEAD^" }).baseline;
      const observed = summarizeLegacyStrictCounts(reports, { root });
      const result = evaluateLegacyStrictCounts(baseline, observed, previous);
      const legacy = original();
      expect(legacy.status === 0).toBe(example.passed);
      expect(result.ok).toBe(example.passed);
      expect(observed.counts).toEqual(measuredCounts());
      expect(observed.counts["no-console"]).toBe(example.measured);
      if (example.name === "stale count") {
        expect(result.canTighten).toBe(true);
        expect(result.stale).toEqual([{ ruleId: "no-console", before: 2, now: 1, delta: -1 }]);
        const next = tightenLegacyStrictCounts(baseline, observed, previous);
        expect(evaluateLegacyStrictCounts(next, observed, previous).ok).toBe(true);
        expect(next.counts["no-console"]).toBe(1);
        expect(next.counts.complexity).toBe(0);
        expect(baseline.counts["no-console"]).toBe(2);
      }
    });
  }

  test("unused suppression comments do not create phantom violations", () => {
    setup();
    write("packages/legacy-strict-counts-s3/src/a.ts", "// eslint-disable-next-line no-console\nexport {};\n");
    const observed = summarizeLegacyStrictCounts(report(), { root });
    expect(original().status).toBe(0);
    expect(observed.counts["no-console"]).toBe(0);
    expect(evaluateLegacyStrictCounts(importLegacyStrictCountsBaseline({ counts: counts() }), observed).ok).toBe(true);
  });

  test("baseline expansion fails even when the measured count matches the edited budget", () => {
    setup(counts({ "no-console": 2 }), { counts: counts({ "no-console": 1 }) });
    const observed = summarizeLegacyStrictCounts(report([warning, warning]), { root });
    const current = importLegacyStrictCountsBaseline({ counts: counts({ "no-console": 2 }) });
    const previous = readLegacyStrictCountsPredecessor(root, undefined, undefined, { ref: "HEAD^" }).baseline;
    const result = evaluateLegacyStrictCounts(current, observed, previous);
    expect(original().status).toBe(1);
    expect(result.ok).toBe(false);
    expect(result.canTighten).toBe(false);
    expect(result.baselineGrowth).toEqual([{ ruleId: "no-console", before: 1, now: 2, delta: 1 }]);
    expect(() => tightenLegacyStrictCounts(current, observed, previous)).toThrow("baseline growth");
  });
});

describe("LegacyStrictCounts history selection", () => {
  test("an unresolved ref is a hard failure, including a checkout without HEAD^", () => {
    setup();
    expect(() => readLegacyStrictCountsPredecessor(root, undefined, undefined, { ref: "refs/heads/missing" })).toThrow("Cannot resolve ratchet base");
    expect(original([], { ref: "refs/heads/missing" }).status).not.toBe(0);
    git("checkout", "--quiet", "HEAD^");
    expect(() => readLegacyStrictCountsPredecessor(root, undefined, undefined, { ref: "HEAD^" })).toThrow("fetch-depth: 0");
  });

  test("RATCHET_STRAP_BASE_REF selects the same explicit history as the original checker", () => {
    setup(counts({ "no-console": 2 }), { counts: counts({ "no-console": 1 }) });
    git("add", sourcePath);
    git("commit", "--quiet", "-m", "Current stored budget");
    report([warning, warning]);
    const saved = process.env.RATCHET_STRAP_BASE_REF;
    try {
      process.env.RATCHET_STRAP_BASE_REF = " HEAD ";
      const selected = readLegacyStrictCountsPredecessor(root);
      expect(selected.ref).toBe("HEAD");
      expect(selected.baseline?.counts["no-console"]).toBe(2);
      expect(original([], { ref: " HEAD " }).status).toBe(0);
      const old = readLegacyStrictCountsPredecessor(root, undefined, undefined, { ref: "HEAD^" });
      expect(old.baseline?.counts["no-console"]).toBe(1);
      expect(original([], { ref: "HEAD^" }).status).toBe(1);
    } finally {
      if (saved === undefined) delete process.env.RATCHET_STRAP_BASE_REF;
      else process.env.RATCHET_STRAP_BASE_REF = saved;
    }
  });

  test("a resolved legacy ref without the baseline is legitimate first adoption", () => {
    write("marker", "initial source\n");
    recordHistory(["marker"]);
    write(sourcePath, JSON.stringify({ counts: counts() }));
    report();
    const prior = readLegacyStrictCountsPredecessor(root, undefined, undefined, { ref: "HEAD^" });
    expect(prior.availability).toBe("first-adoption");
    expect(prior.baseline).toBeUndefined();
    expect(original().status).toBe(0);
  });

  test("legacy malformed historical JSON retains the original first-adoption behavior", () => {
    setup(counts(), "{broken");
    report();
    expect(readLegacyStrictCountsPredecessor(root, undefined, undefined, { ref: "HEAD^" }).availability).toBe("first-adoption");
    expect(original().status).toBe(0);
  });

  test("a missing migrated predecessor falls back to the original legacy path", () => {
    setup(counts({ "no-console": 2 }));
    const prior = readLegacyStrictCountsPredecessor(root, ".ratchet-strap.json", undefined, { ref: "HEAD^" });
    expect(prior.availability).toBe("found");
    expect(prior.source).toContain(`:${sourcePath}`);
    expect(prior.baseline?.counts["no-console"]).toBe(2);
  });

  test("malformed migrated history fails closed rather than falling back to legacy", () => {
    write(sourcePath, JSON.stringify({ counts: counts() }));
    write(".ratchet-strap.json", "{broken");
    recordHistory([sourcePath, ".ratchet-strap.json"]);
    expect(() => readLegacyStrictCountsPredecessor(root, ".ratchet-strap.json", undefined, { ref: "HEAD^" })).toThrow("Malformed RatchetStrap predecessor");
  });

  test("migrated history takes precedence so a later baseline cannot regain paid debt", () => {
    write(sourcePath, JSON.stringify({ counts: counts({ "no-console": 1 }) }));
    write(".ratchet-strap.json", JSON.stringify(importLegacyStrictCountsBaseline({ counts: counts() })));
    recordHistory([sourcePath, ".ratchet-strap.json"]);
    const previous = readLegacyStrictCountsPredecessor(root, ".ratchet-strap.json", undefined, { ref: "HEAD^" });
    expect(previous.source).toContain(":.ratchet-strap.json");
    expect(previous.baseline?.counts["no-console"]).toBe(0);
    const expanded = importLegacyStrictCountsBaseline({ counts: counts({ "no-console": 1 }) });
    const outcome = evaluateLegacyStrictCounts(expanded, summarizeLegacyStrictCounts(report([warning]), { root }), previous.baseline);
    expect(outcome.ok).toBe(false);
    expect(outcome.baselineGrowth).toEqual([{ ruleId: "no-console", before: 0, now: 1, delta: 1 }]);
  });
});

describe("LegacyStrictCounts validation", () => {
  test("legacy missing known rules become zero; unknown rules are never discarded", () => {
    const imported = importLegacyStrictCountsBaseline({ _comment: "Legacy", counts: { "no-console": 2 } });
    expect(imported.counts).toEqual(counts({ "no-console": 2 }));
    expect(imported._comment).toBe("Legacy");
    expect(() => importLegacyStrictCountsBaseline({ counts: { custom: 1 } })).toThrow("unknown rule");
  });

  test("new baselines and observations require all ten rules", () => {
    const baseline = importLegacyStrictCountsBaseline({ counts: counts() });
    expect(() => parseLegacyStrictCountsBaseline({ ...baseline, counts: { "no-console": 0 } })).toThrow("exactly");
    const observed = summarizeLegacyStrictCounts(report(), { root });
    const missing: LegacyStrictCountsObservation = { ...observed, counts: { ...observed.counts } };
    delete missing.counts.complexity;
    expect(() => evaluateLegacyStrictCounts(baseline, missing)).toThrow("exactly");
    expect(() => evaluateLegacyStrictCounts(baseline, { ...observed, counts: { ...observed.counts, unknown: 0 } })).toThrow("exactly");
    expect(() => evaluateLegacyStrictCounts(baseline, { ...observed, counts: { ...observed.counts, complexity: 0.5 } })).toThrow("Invalid baseline count");
    expect(() => evaluateLegacyStrictCounts(baseline, { ...observed, files: 0 })).toThrow("non-empty scan");
  });

  test("missing scan metadata or the wrong package scope fails", () => {
    expect(() => summarizeLegacyStrictCounts([], { root })).toThrow("non-empty");
    expect(() => summarizeLegacyStrictCounts([{ filePath: join(root, "packages/legacy-strict-counts-s3/src/a.ts"), messages: [] }], { root })).toThrow("suppressedMessages");
    expect(() => summarizeLegacyStrictCounts([{ filePath: join(root, "other/a.ts"), messages: [], suppressedMessages: [] }], { root })).toThrow("outside packages/legacy-strict-counts-s3");
  });
});
