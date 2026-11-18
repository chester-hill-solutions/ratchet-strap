import { describe, expect, test } from "bun:test";
import { evaluate, parseBaseline, tighten } from "./baseline.js";
import { summarize } from "./eslint.js";
import { qualityPolicy } from "../house-rules/quality.mjs";
import type { Baseline } from "./types.js";

const baseline: Baseline = {
  schemaVersion: 1, adapter: "eslint-json@1", counts: { "no-console": 2, complexity: 0 },
  _comment: "Keep this explanation",
};
const warning = { ruleId: "no-console", severity: 1, message: "Unexpected console", line: 2 };
const report = (messages: unknown[] = [], suppressedMessages: unknown[] = []) => [
  { filePath: "/repo/a.ts", messages, suppressedMessages },
];
const observe = (reports: unknown) => summarize(reports, Object.keys(baseline.counts), {
  adapter: baseline.adapter, root: "/repo",
});

describe("RatchetStrap counts", () => {
  test("counts warnings and suppressed diagnostics without forgiving a disabled warning", () => {
    const observed = observe(report([warning, warning], [warning]));
    expect(observed.counts["no-console"]).toBe(3);
    expect(evaluate(baseline, observed).regressions).toEqual([
      { ruleId: "no-console", before: 2, now: 3, delta: 1 },
    ]);
    expect(observed.diagnostics.map((diagnostic) => diagnostic.file)).toEqual(["a.ts", "a.ts", "a.ts"]);
  });

  test("untracked warnings are ignored; all unsuppressed errors fail", () => {
    const observed = observe(report([
      { ...warning, ruleId: "untracked" },
      { ...warning, ruleId: null, severity: 2, message: "Parsing error" },
      { ...warning, severity: 2 },
    ]));
    expect(observed.counts["no-console"]).toBe(0);
    expect(observed.errors).toHaveLength(2);
    expect(evaluate(baseline, observed).ok).toBe(false);
    expect(() => tighten(baseline, observed)).toThrow("Cannot tighten");
  });

  test("tightening retains zero rules, metadata, and the original input", () => {
    const next = tighten(baseline, observe(report([warning])));
    expect(next.counts).toEqual({ "no-console": 1, complexity: 0 });
    expect(next._comment).toBe(baseline._comment);
    expect(baseline.counts["no-console"]).toBe(2);
    const zero = tighten(next, observe(report()));
    expect(Object.keys(zero.counts).sort()).toEqual(["complexity", "no-console"]);
    expect(evaluate(zero, observe(report([warning]))).ok).toBe(false);
  });

  test("growth prevents tightening any rule", () => {
    const observed = observe(report([{ ...warning, ruleId: "complexity" }]));
    expect(() => tighten(baseline, observed)).toThrow("regressions");
  });

  test("an adapter change or incomplete observation cannot be tightened", () => {
    const observed = observe(report());
    expect(() => tighten(baseline, { ...observed, counts: { "no-console": 0 } })).toThrow("exactly");
    expect(() => evaluate(baseline, { ...observed, counts: { "no-console": NaN, complexity: 0 } })).toThrow("Invalid observation");
  });
});

describe("fail-closed inputs", () => {
  test("public count evaluation refuses forged empty scans before tightening", () => {
    const observed = observe(report());
    expect(() => evaluate(baseline, { ...observed, files: 0 })).toThrow("non-empty scan");
    expect(() => tighten(baseline, { ...observed, files: -1 })).toThrow("non-empty scan");
    expect(() => evaluate(baseline, { ...observed, files: NaN })).toThrow("non-empty scan");
    expect(baseline.counts["no-console"]).toBe(2);
  });

  for (const [label, invalid] of [
    ["empty report", []],
    ["non-array report", {}],
    ["missing messages", [{ filePath: "a.ts", suppressedMessages: [] }]],
    ["missing suppression metadata", [{ filePath: "a.ts", messages: [] }]],
    ["invalid severity", report([{ ...warning, severity: 0 }])],
    ["missing message text", report([{ ruleId: "a", severity: 1 }])],
    ["inconsistent errors", [{ filePath: "a.ts", messages: [], suppressedMessages: [], errorCount: 1 }]],
    ["duplicate files", [...report(), ...report()]],
  ]) {
    test(`rejects ${label}`, () => expect(() => observe(invalid)).toThrow());
  }

  for (const counts of [{}, { a: -1 }, { a: 0.5 }, { a: "1" }, { a: Number.MAX_SAFE_INTEGER + 1 }]) {
    test(`rejects invalid baseline ${JSON.stringify(counts)}`, () => {
      expect(() => parseBaseline({ ...baseline, counts })).toThrow();
    });
  }

  test("unknown schema or detector versions do not silently upgrade", () => {
    expect(() => parseBaseline({ ...baseline, schemaVersion: 2 })).toThrow("schemaVersion");
    expect(() => parseBaseline({ ...baseline, adapter: "eslint-json@2" })).toThrow("Unknown adapter");
    expect(() => parseBaseline({ counts: { a: 1 } })).toThrow("schemaVersion");
  });

  test("shared rule definitions can be used as ESLint rule entries", () => {
    const rules = qualityPolicy.rules as unknown as Record<string, "warn" | ["warn", Record<string, number | boolean>]>;
    expect(rules.complexity).toEqual(["warn", { max: 20 }]);
  });
});
