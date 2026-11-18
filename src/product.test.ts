import { describe, expect, test } from "bun:test";
import { emptyBaseline } from "./commands.js";
import { addRules, checkBaseline, observeBaseline, parseRatchetBaseline, trackedRules } from "./product.js";

const report = (rule = "no-console", file = "/repo/a.js", severity = 1) => [{
  filePath: file,
  messages: [{ ruleId: rule, severity, message: "Violation", line: 1 }],
  suppressedMessages: [],
}];

describe("one ratchet product", () => {
  test("new projects use identity tracking; explicit count profiles remain available", () => {
    expect(emptyBaseline(["no-console"]).adapter).toBe("eslint-identities@1");
    expect(emptyBaseline(["no-console"], "eslint-counts@1").adapter).toBe("eslint-json@1");
    expect(emptyBaseline(["no-console"], undefined, "eslint-json@1").schemaVersion).toBe(1);
  });

  test("same-count replacements fail under the strict default", () => {
    const baseline = parseRatchetBaseline({
      schemaVersion: 2, mode: "identities", adapter: "eslint-identities@1",
      identities: { "no-console": ["a.js:no-console:Violation#1"] },
    });
    const result = checkBaseline(baseline, observeBaseline(baseline, report("no-console", "/repo/b.js"), "/repo"));
    expect(result.ok).toBe(false);
    expect(result.canTighten).toBe(false);
    expect(result.regressions).toHaveLength(0);
    expect(result.mode === "identities" && result.added["no-console"]).toEqual(["b.js:no-console:Violation#1"]);
  });

  test("indistinguishable diagnostics within one file retain identity when line numbers move", () => {
    const baseline = parseRatchetBaseline({
      schemaVersion: 2, mode: "identities", adapter: "eslint-identities@1",
      identities: { "no-console": ["a.js:no-console:Violation#1"] },
    });
    const moved = [{ filePath: "/repo/a.js", messages: [{ ruleId: "no-console", severity: 1, message: "Violation", line: 100 }], suppressedMessages: [] }];
    expect(checkBaseline(baseline, observeBaseline(baseline, moved, "/repo")).ok).toBe(true);
  });

  test("count predecessor protection catches an inflated allowance even when lint passes", () => {
    const previous = parseRatchetBaseline({ schemaVersion: 1, adapter: "eslint-json@1", counts: { "no-console": 1 } });
    const current = parseRatchetBaseline({ schemaVersion: 1, adapter: "eslint-json@1", counts: { "no-console": 2 } });
    const observed = observeBaseline(current, report(), "/repo");
    expect(checkBaseline(current, observed).ok).toBe(true);
    expect(checkBaseline(current, observed, previous).ok).toBe(false);
  });

  test("adding a rule preserves existing count budgets instead of reinitializing them", () => {
    const baseline = parseRatchetBaseline({ schemaVersion: 1, adapter: "eslint-json@1", counts: { "no-console": 7 } });
    const next = addRules(baseline, ["complexity"], report("complexity"), "/repo");
    expect(next.schemaVersion === 1 && next.counts).toEqual({ "no-console": 7, complexity: 1 });
    expect(trackedRules(baseline)).toEqual(["no-console"]);
  });

  test("adding a rule retains old identities and zero rules", () => {
    const baseline = emptyBaseline(["no-console"]);
    const next = addRules(baseline, ["complexity"], report("complexity"), "/repo");
    expect(next.schemaVersion === 2 && next.identities).toEqual({
      "no-console": [], complexity: ["a.js:complexity:Violation#1"],
    });
  });

  test("rule additions cannot absorb old regressions or hard errors", () => {
    const baseline = emptyBaseline(["no-console"]);
    expect(() => addRules(baseline, ["complexity"], report(), "/repo")).toThrow("Repair or tighten");
    expect(() => addRules(baseline, ["complexity"], report("complexity", "/repo/a.js", 2), "/repo")).toThrow("Repair or tighten");
    expect(() => addRules(baseline, ["no-console"], [{ filePath: "/repo/a.js", messages: [], suppressedMessages: [] }], "/repo")).toThrow("not already tracked");
  });

  test("schema modes cannot be mixed or silently upgraded", () => {
    const identities = emptyBaseline(["no-console"]);
    const counts = emptyBaseline(["no-console"], "eslint-counts@1");
    expect(() => checkBaseline(identities, observeBaseline(counts, report(), "/repo"))).toThrow("comparison mode");
    expect(() => checkBaseline(identities, observeBaseline(identities, report(), "/repo"), counts)).toThrow("mode changed");
    expect(() => parseRatchetBaseline({ schemaVersion: 99 })).toThrow();
  });
});
