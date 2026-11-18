import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { evaluate, importLegacyCountsBaseline } from "./baseline.js";
import { summarize } from "./eslint.js";

const fixture = fileURLToPath(new URL("../fixtures/", import.meta.url));
let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "ratchet-strap-parity-"));
  mkdirSync(join(root, "scripts/baselines"), { recursive: true });
  mkdirSync(join(root, "bin"));
  copyFileSync(join(fixture, "legacy-counts-check-lint-ratchet.mjs"), join(root, "scripts/check-lint-ratchet.mjs"));
  writeFileSync(join(root, "bin/npx"), `#!/usr/bin/env node
process.stdout.write(require('node:fs').readFileSync(process.env.RATCHET_STRAP_REPORT, 'utf8'));
process.exit(Number(process.env.RATCHET_STRAP_ESLINT_STATUS));
`, { mode: 0o755 });
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const warning = { ruleId: "no-console", severity: 1, message: "Unexpected console", line: 1 };
const cases = [
  { name: "ordinary warnings", source: "console.log(1)", messages: [warning, warning] },
  { name: "zero violations", source: "export {};", messages: [] },
  { name: "untracked warnings", source: "", messages: [{ ...warning, ruleId: "untracked" }] },
  { name: "hard errors", source: "broken", messages: [{ ...warning, severity: 2 }] },
  { name: "unused suppression", source: "// eslint-disable-next-line no-console\nexport {};", messages: [] },
  { name: "multiple listed rules", source: "/* eslint-disable complexity, no-console */", messages: [] },
  { name: "inline suppression", source: "console.log(1); // eslint-disable-line no-console", messages: [] },
  { name: "multiline suppression", source: "/* eslint-disable\n no-console */", messages: [] },
  { name: "wildcard suppression", source: "/* eslint-disable */", messages: [] },
  { name: "suppressed metadata is not double counted", source: "// eslint-disable-next-line no-console\nconsole.log(1)", messages: [], suppressedMessages: [warning, warning] },
];

describe("LegacyCounts compatibility against its unmodified checker", () => {
  test("imports the real 13-rule baseline without changing its budget", () => {
    const original = JSON.parse(readFileSync(join(fixture, "legacy-counts-lint-ratchet.json"), "utf8"));
    const imported = importLegacyCountsBaseline(original);
    expect(imported.counts).toEqual(original.counts);
    expect(imported._comment).toBe(original._comment);
    expect(Object.keys(imported.counts)).toHaveLength(13);
  });

  for (const example of cases) {
    test(example.name, () => {
      const baseline = importLegacyCountsBaseline({ counts: { "no-console": 1, complexity: 0, "max-depth": 0 } });
      const baselinePath = join(root, "scripts/baselines/lint-ratchet.json");
      writeFileSync(baselinePath, JSON.stringify({ counts: baseline.counts }));
      writeFileSync(join(root, "a.js"), example.source);
      const reports = [{ filePath: join(root, "a.js"), messages: example.messages, suppressedMessages: "suppressedMessages" in example ? example.suppressedMessages : [] }];
      const reportPath = join(root, "report.json");
      writeFileSync(reportPath, JSON.stringify(reports));
      const env = {
        ...process.env, PATH: `${join(root, "bin")}:${process.env.PATH}`,
        RATCHET_STRAP_REPORT: reportPath, RATCHET_STRAP_ESLINT_STATUS: "1",
      };
      const old = spawnSync(process.execPath, [join(root, "scripts/check-lint-ratchet.mjs")], { env, encoding: "utf8" });
      const observed = summarize(reports, Object.keys(baseline.counts), { adapter: baseline.adapter, root });
      expect(old.status).toBe(evaluate(baseline, observed).ok ? 0 : 1);
      const snapshot = spawnSync(process.execPath, [join(root, "scripts/check-lint-ratchet.mjs"), "--baseline"], { env, encoding: "utf8" });
      expect(snapshot.status).toBe(0);
      const legacyCounts = JSON.parse(readFileSync(baselinePath, "utf8")).counts;
      expect(observed.counts).toEqual(Object.fromEntries(Object.keys(baseline.counts).map((rule) => [rule, legacyCounts[rule] ?? 0])));
    });
  }

  test("source read failures do not masquerade as zero debt", () => {
    expect(() => summarize([{ filePath: join(root, "missing.js"), messages: [] }], ["no-console"], {
      adapter: "suppression-counts@1", root,
    })).toThrow();
  });

  test("source scanning refuses files outside the selected repository", () => {
    expect(() => summarize([{ filePath: join(fixture, "legacy-counts-check-lint-ratchet.mjs"), messages: [] }], ["no-console"], {
      adapter: "suppression-counts@1", root,
    })).toThrow("outside --root");
  });
});
