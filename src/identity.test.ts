import { describe, expect, test } from "bun:test";
import {
  evaluateIdentities, parseIdentityBaseline, summarizeIdentities, tightenIdentities,
} from "./identity.js";
import type { IdentityBaseline, IdentityObservation } from "./identity-types.js";

const warning = { ruleId: "no-console", severity: 1, message: "Unexpected console", line: 2, column: 1 };
const identity = "a.ts:no-console:Unexpected console#1";
const baseline: IdentityBaseline = {
  schemaVersion: 2, mode: "identities", adapter: "eslint-identities@1",
  identities: { "no-console": [identity], complexity: [] }, _comment: "Existing local budget",
};
const report = (messages: unknown[] = [], suppressedMessages: unknown[] = [], filePath = "/repo/a.ts") => [
  { filePath, messages, suppressedMessages },
];
const observe = (reports: unknown) => summarizeIdentities(reports, Object.keys(baseline.identities), {
  adapter: baseline.adapter, root: "/repo",
});

describe("identity comparison", () => {
  test("an unchanged diagnostic passes despite moved line numbers", () => {
    const observed = observe(report([{ ...warning, line: 100 }]));
    const result = evaluateIdentities(baseline, observed);
    expect(result.ok).toBe(true);
    expect(result.canTighten).toBe(true);
    expect(result.added).toEqual({});
    expect(result.stale).toEqual({});
    expect(result.baselineGrowth).toEqual({});
  });

  test("replacing debt at the same count fails instead of offsetting it", () => {
    const observed = observe(report([warning], [], "/repo/new.ts"));
    const result = evaluateIdentities(baseline, observed);
    expect(result.counts["no-console"]).toBe(1);
    expect(result.ok).toBe(false);
    expect(result.canTighten).toBe(false);
    expect(result.added).toEqual({ "no-console": ["new.ts:no-console:Unexpected console#1"] });
    expect(result.stale).toEqual({ "no-console": [identity] });
    expect(() => tightenIdentities(baseline, observed)).toThrow("new identities");
  });

  test("repairs require explicit tightening and retain clean tracked rules", () => {
    const observed = observe(report());
    const result = evaluateIdentities(baseline, observed);
    expect(result.ok).toBe(false);
    expect(result.canTighten).toBe(true);
    expect(result.stale).toEqual({ "no-console": [identity] });
    const next = tightenIdentities(baseline, observed);
    expect(next.identities).toEqual({ "no-console": [], complexity: [] });
    expect(next._comment).toBe(baseline._comment);
    expect(baseline.identities["no-console"]).toEqual([identity]);
    expect(evaluateIdentities(next, observed).ok).toBe(true);
    expect(evaluateIdentities(next, observe(report([warning]))).ok).toBe(false);
  });

  test("occurrence identities span normal and suppressed messages", () => {
    const observed = observe(report([warning], [warning, warning]));
    expect(observed.identities["no-console"]).toEqual([
      identity, "a.ts:no-console:Unexpected console#2", "a.ts:no-console:Unexpected console#3",
    ]);
    expect(observed.counts["no-console"]).toBe(3);
    expect(observed.diagnostics.map((diagnostic) => diagnostic.kind)).toEqual(["warning", "suppressed", "suppressed"]);
    expect(evaluateIdentities(baseline, observed).added["no-console"]).toHaveLength(2);
  });

  test("occurrence counters are independent per message, rule, and file", () => {
    const observed = observe([
      ...report([warning, { ...warning, message: "Different warning" }]),
      ...report([warning], [], "/repo/b.ts"),
    ]);
    expect(observed.identities["no-console"]).toEqual([
      "a.ts:no-console:Different warning#1", identity, "b.ts:no-console:Unexpected console#1",
    ]);
  });

  test("a zero-budget rule's first violation cannot be grandfathered", () => {
    const observed = observe(report([warning, { ...warning, ruleId: "complexity" }]));
    const result = evaluateIdentities(baseline, observed);
    expect(result.ok).toBe(false);
    expect(result.added.complexity).toEqual(["a.ts:complexity:Unexpected console#1"]);
  });

  test("untracked warnings are ignored but every unsuppressed error blocks", () => {
    const observed = observe(report([
      warning,
      { ...warning, ruleId: "other" },
      { ...warning, ruleId: null, severity: 2, message: "Parsing error" },
    ]));
    expect(observed.counts["no-console"]).toBe(1);
    expect(observed.errors).toHaveLength(1);
    expect(evaluateIdentities(baseline, observed).canTighten).toBe(false);
    expect(() => tightenIdentities(baseline, observed)).toThrow("ESLint errors");
  });

  test("tracked hard errors receive identities while suppressed errors count without becoming hard errors", () => {
    const observed = observe(report([{ ...warning, severity: 2 }], [{ ...warning, severity: 2 }]));
    expect(observed.identities["no-console"]).toEqual([identity, "a.ts:no-console:Unexpected console#2"]);
    expect(observed.errors).toHaveLength(1);
    const suppressed = observe(report([], [{ ...warning, severity: 2 }]));
    expect(evaluateIdentities(baseline, suppressed).ok).toBe(true);
  });
});

describe("predecessor budgets", () => {
  test("a newly allowed identity fails even when the allowance count stays equal", () => {
    const replacement: IdentityBaseline = { ...baseline, identities: { ...baseline.identities, "no-console": ["a.ts:no-console:Different warning#1"] } };
    const observed = observe(report([{ ...warning, message: "Different warning" }]));
    const result = evaluateIdentities(replacement, observed, baseline);
    expect(result.ok).toBe(false);
    expect(result.canTighten).toBe(false);
    expect(result.baselineGrowth).toEqual({ "no-console": ["a.ts:no-console:Different warning#1"] });
    expect(() => tightenIdentities(replacement, observed, baseline)).toThrow("baseline growth");
  });

  test("a baseline can shrink to zero without changing the predecessor", () => {
    const tightened = tightenIdentities(baseline, observe(report()));
    const result = evaluateIdentities(tightened, observe(report()), baseline);
    expect(result.ok).toBe(true);
    expect(result.baselineGrowth).toEqual({});
    expect(baseline.identities["no-console"]).toEqual([identity]);
  });

  test("detector or tracked-rule changes require a separate reviewed transition", () => {
    const observed = observe(report([warning]));
    const differentRules = { ...baseline, identities: { "no-console": [identity] } };
    expect(() => evaluateIdentities(baseline, observed, differentRules)).toThrow("Predecessor");
  });
});

describe("identity baseline parsing", () => {
  for (const [name, invalid] of [
    ["schema", { ...baseline, schemaVersion: 1 }],
    ["mode", { ...baseline, mode: "counts" }],
    ["adapter", { ...baseline, adapter: "eslint-identities@2" }],
    ["empty tracked rules", { ...baseline, identities: {} }],
    ["duplicate identities", { ...baseline, identities: { "no-console": [identity, identity] } }],
    ["non-string identity", { ...baseline, identities: { "no-console": [4] } }],
    ["empty identity", { ...baseline, identities: { "no-console": [" "] } }],
    ["missing identity list", { ...baseline, identities: { "no-console": 1 } }],
    ["invalid comment", { ...baseline, _comment: 12 }],
    ["mixed count budget", { ...baseline, counts: { "no-console": 1 } }],
  ]) {
    test(`rejects invalid ${name}`, () => expect(() => parseIdentityBaseline(invalid)).toThrow());
  }

  test("parsing clones identity arrays so callers cannot mutate the input through the result", () => {
    const result = parseIdentityBaseline(baseline);
    result.identities["no-console"]?.push("another");
    expect(baseline.identities["no-console"]).toEqual([identity]);
  });
});

describe("observation validation", () => {
  for (const [name, reports] of [
    ["empty scan", []],
    ["missing suppression metadata", [{ filePath: "/repo/a.ts", messages: [] }]],
    ["duplicate file result", [...report(), ...report()]],
    ["invalid message", report([{ ...warning, severity: 0 }])],
    ["inconsistent error total", [{ filePath: "/repo/a.ts", messages: [], suppressedMessages: [], errorCount: 1 }]],
  ]) {
    test(`rejects ${name}`, () => expect(() => observe(reports)).toThrow());
  }

  test("evaluation rejects mismatched counts, missing rules, wrong adapters, or forged empty scans", () => {
    const observed = observe(report([warning]));
    const cases: IdentityObservation[] = [
      { ...observed, counts: { ...observed.counts, "no-console": 2 } },
      { ...observed, identities: { "no-console": [identity] } },
      { ...observed, counts: { "no-console": 1 } },
      { ...observed, files: 0 },
      { ...observed, files: 0.5 },
    ];
    for (const invalid of cases) expect(() => evaluateIdentities(baseline, invalid)).toThrow();
  });
});

describe("metric improvements", () => {
  const complexityBaseline = (value: number): IdentityBaseline => ({
    schemaVersion: 2, mode: "identities", adapter: "eslint-identities@1",
    identities: {
      complexity: [`a.ts:complexity:Async function 'f' has a complexity of ${value}. Maximum allowed is 10.#1`],
    },
  });
  const complexity = (value: number, filePath = "/repo/a.ts") => summarizeIdentities(report([{
    ruleId: "complexity", severity: 1, line: 1, column: 1,
    message: `Async function 'f' has a complexity of ${value}. Maximum allowed is 10.`,
  }], [], filePath), ["complexity"], { adapter: "eslint-identities@1", root: "/repo" });

  test("accepts a lower metric on the same diagnostic as a tightening", () => {
    const before = complexityBaseline(161);
    const observed = complexity(159);
    const result = evaluateIdentities(before, observed);
    expect(result.added).toEqual({});
    expect(result.stale).toEqual({});
    expect(result.canTighten).toBe(true);
    const tightened = tightenIdentities(before, observed);
    expect(tightened.identities.complexity?.[0]).toContain("of 159");
  });

  test("still refuses a higher metric", () => {
    const result = evaluateIdentities(complexityBaseline(161), complexity(165));
    expect(result.canTighten).toBe(false);
    expect(result.added.complexity).toHaveLength(1);
  });

  test("still refuses a genuinely new identity of the same shape", () => {
    const before = complexityBaseline(161);
    const observed = complexity(159, "/repo/b.ts");
    const result = evaluateIdentities(before, observed);
    expect(result.canTighten).toBe(false);
    expect(result.added.complexity).toHaveLength(1);
  });
});
