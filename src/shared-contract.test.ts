import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { evaluate, tighten } from "./baseline.js";
import type { Baseline, Observation } from "./types.js";

const fixture = new URL("../fixtures/chs-shared/ratchet.mjs", import.meta.url);
const provenance = JSON.parse(readFileSync(new URL("../fixtures/chs-shared/provenance.json", import.meta.url), "utf8"));

function reference(counts: Record<string, number>, baseline: Record<string, number>) {
  const result = spawnSync("node", ["--input-type=module", "-e",
    "const { compareCounts } = await import(process.argv[1]); console.log(JSON.stringify(compareCounts(JSON.parse(process.argv[2]), JSON.parse(process.argv[3]))));",
    fixture.href, JSON.stringify(counts), JSON.stringify(baseline),
  ], { encoding: "utf8" });
  if (result.status !== 0) throw new Error(result.stderr || "Shared reference failed");
  return JSON.parse(result.stdout);
}

function observe(counts: Record<string, number>): Observation {
  return { adapter: "eslint-json@1", counts, diagnostics: [], errors: [], files: 1 };
}

describe("upstream CHS shared count contract", () => {
  test("references the unchanged upstream implementation", () => {
    for (const [name, expected] of Object.entries(provenance.files)) {
      if (typeof expected !== "string") throw new Error("Reference fingerprint is missing");
      const bytes = readFileSync(new URL(`../fixtures/chs-shared/${name}`, import.meta.url));
      expect(createHash("sha256").update(bytes).digest("hex")).toBe(expected);
    }
  });

  for (const counts of [{ a: 2, b: 1 }, { a: 3, b: 1 }, { a: 0, b: 1 }, { a: 3, b: 0 }]) {
    test(`preserves growth and improvement decisions for ${JSON.stringify(counts)}`, () => {
      const baseline: Baseline = { schemaVersion: 1, adapter: "eslint-json@1", counts: { a: 2, b: 1 } };
      const upstream = reference(counts, baseline.counts);
      const current = evaluate(baseline, observe(counts));
      expect(current.regressions.map(({ ruleId, before, now }) => ({ rule: ruleId, before, after: now }))).toEqual(upstream.regressions);
      expect(current.improvements.map(({ ruleId, before, now }) => ({ rule: ruleId, before, after: now }))).toEqual(upstream.improvements);
      expect(current.ok).toBe(upstream.regressions.length === 0 && upstream.unmeasured.length === 0);
      if (current.ok) expect(tighten(baseline, observe(counts)).counts).toEqual(counts);
      else expect(() => tighten(baseline, observe(counts))).toThrow();
    });
  }

  test("rejects the removed-rule case reported by the upstream helper", () => {
    const baseline: Baseline = { schemaVersion: 1, adapter: "eslint-json@1", counts: { a: 0, retired: 3 } };
    expect(reference({ a: 0 }, baseline.counts).unmeasured).toEqual(["retired"]);
    expect(() => evaluate(baseline, observe({ a: 0 }))).toThrow("exactly");
  });
});
