import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { evaluateIdentities, importLegacyIdentitiesBaseline, tightenIdentities } from "./identity.js";
import { legacyIdentitiesRuleIds } from "./identity-types.js";
import type { IdentityMap } from "./identity-types.js";
import { collectLegacyIdentitiesCycles } from "./legacy-identities-cycles.js";
import { summarizeLegacyIdentities } from "./legacy-identities.js";

const fixtures = fileURLToPath(new URL("../fixtures/", import.meta.url));
let root: string;
const warning = { ruleId: "no-console", severity: 1, message: "Unexpected console statement.", line: 1 };
const identity = (file: string, occurrence = 1) => `${file}:no-console:${warning.message}#${occurrence}`;

function write(relative: string, content: string): void {
  const path = join(root, relative);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

function legacyBaseline(overrides: IdentityMap = {}) {
  return { version: 4, ...Object.fromEntries(legacyIdentitiesRuleIds.map((rule) => [rule, []])), ...overrides };
}

function setReport(files: { file: string; messages?: unknown[]; suppressedMessages?: unknown[] }[]) {
  const reports = files.map(({ file, messages = [], suppressedMessages = [] }) => ({
    filePath: join(root, file), messages, suppressedMessages,
  }));
  write("report.json", JSON.stringify(reports));
  return reports;
}

function original(...args: string[]) {
  return spawnSync(process.execPath, [join(root, "scripts/check-lint-ratchet.mjs"), ...args], {
    cwd: root, encoding: "utf8", env: { ...process.env, RATCHET_STRAP_REPORT: join(root, "report.json") },
  });
}

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "ratchet-strap-quick-parity-")));
  write("app/a.ts", "export {};\n");
  write("scripts/baselines/lint-ratchet.json", JSON.stringify(legacyBaseline()));
  copyFileSync(join(fixtures, "legacy-identities-check-lint-ratchet.mjs"), join(root, "scripts/check-lint-ratchet.mjs"));
  write("node_modules/eslint/bin/eslint.js", "process.stdout.write(require('node:fs').readFileSync(process.env.RATCHET_STRAP_REPORT, 'utf8'));\n");
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("legacy identities compatibility against its original checker", () => {
  test("the fixture preserves its recorded source bytes and baseline metadata", () => {
    const provenance = JSON.parse(readFileSync(join(fixtures, "legacy-identities-provenance.json"), "utf8"));
    const checker = readFileSync(join(fixtures, "legacy-identities-check-lint-ratchet.mjs"));
    expect(createHash("sha256").update(checker).digest("hex")).toBe(provenance.checkerSha256);
    expect(provenance.checkerGitBlob).toBe("4ffc94b5502518a8a18be9630097ca8e29272ddb");
    expect(provenance.baselineVersion).toBe(4);
    expect(Object.keys(provenance.baselineCounts).sort()).toEqual([...legacyIdentitiesRuleIds].sort());
    expect(Object.values<number>(provenance.baselineCounts).reduce((sum, count) => sum + count, 0)).toBe(918);
  });

  const cases: { name: string; allowed: IdentityMap; messages: unknown[]; suppressed: unknown[] }[] = [
    { name: "zero violations", allowed: {}, messages: [], suppressed: [] },
    { name: "unchanged warning", allowed: { "no-console": [identity("app/a.ts")] }, messages: [warning], suppressed: [] },
    { name: "new identity", allowed: {}, messages: [warning], suppressed: [] },
    { name: "stale identity", allowed: { "no-console": [identity("app/a.ts")] }, messages: [], suppressed: [] },
    { name: "same-count replacement", allowed: { "no-console": [identity("app/old.ts")] }, messages: [warning], suppressed: [] },
    { name: "suppressed warning", allowed: { "no-console": [identity("app/a.ts")] }, messages: [], suppressed: [warning] },
    {
      name: "duplicate occurrences span normal and suppressed messages",
      allowed: { "no-console": [identity("app/a.ts"), identity("app/a.ts", 2), identity("app/a.ts", 3)] },
      messages: [warning, warning], suppressed: [warning],
    },
  ];

  for (const example of cases) {
    test(example.name, () => {
      const legacy = legacyBaseline(example.allowed);
      write("scripts/baselines/lint-ratchet.json", JSON.stringify(legacy));
      const reports = setReport([{ file: "app/a.ts", messages: example.messages, suppressedMessages: example.suppressed }]);
      const baseline = importLegacyIdentitiesBaseline(legacy);
      const observed = summarizeLegacyIdentities(reports, legacyIdentitiesRuleIds, { root });
      const outcome = evaluateIdentities(baseline, observed);
      const old = original();
      expect(old.status).toBe(outcome.ok ? 0 : 1);
      const snapshot = original("--write-baseline");
      expect(snapshot.status).toBe(0);
      const measured = JSON.parse(readFileSync(join(root, "scripts/baselines/lint-ratchet.json"), "utf8"));
      expect(observed.identities).toEqual(Object.fromEntries(legacyIdentitiesRuleIds.map((rule) => [rule, measured[rule]])));
      expect(observed.counts).toEqual(Object.fromEntries(legacyIdentitiesRuleIds.map((rule) => [rule, measured[rule].length])));
      if (example.name === "stale identity") {
        expect(outcome.canTighten).toBe(true);
        expect(tightenIdentities(baseline, observed).identities["no-console"]).toEqual([]);
      }
    });
  }

  test("identical messages in different files each start at occurrence one", () => {
    write("app/b.ts", "export {};\n");
    const legacy = legacyBaseline({ "no-console": [identity("app/a.ts"), identity("app/b.ts")] });
    write("scripts/baselines/lint-ratchet.json", JSON.stringify(legacy));
    const reports = setReport([{ file: "app/a.ts", messages: [warning] }, { file: "app/b.ts", messages: [warning] }]);
    const observed = summarizeLegacyIdentities(reports, legacyIdentitiesRuleIds, { root });
    expect(original().status).toBe(0);
    expect(evaluateIdentities(importLegacyIdentitiesBaseline(legacy), observed).ok).toBe(true);
    expect(observed.identities["no-console"]).toEqual([identity("app/a.ts"), identity("app/b.ts")]);
  });

  test("supplemental cycles preserve root direction and import alias/index resolution", () => {
    write("app/a.ts", 'import "~/folder";\n');
    write("app/folder/index.tsx", 'export { value } from "../a";\n');
    const cycles = [
      "app/a.ts -> app/folder/index.tsx -> app/a.ts:depth=2",
      "app/folder/index.tsx -> app/a.ts -> app/folder/index.tsx:depth=2",
    ];
    const legacy = legacyBaseline({ "import/no-cycle": cycles });
    write("scripts/baselines/lint-ratchet.json", JSON.stringify(legacy));
    const reports = setReport([{ file: "app/a.ts" }, { file: "app/folder/index.tsx" }]);
    const observed = summarizeLegacyIdentities(reports, legacyIdentitiesRuleIds, { root });
    expect(collectLegacyIdentitiesCycles(root).sort()).toEqual(cycles);
    expect(original().status).toBe(0);
    expect(evaluateIdentities(importLegacyIdentitiesBaseline(legacy), observed).ok).toBe(true);
    expect(observed.identities["import/no-cycle"]).toEqual(cycles);
    expect(original("--write-baseline").status).toBe(0);
    const measured = JSON.parse(readFileSync(join(root, "scripts/baselines/lint-ratchet.json"), "utf8"));
    expect(observed.identities["import/no-cycle"]).toEqual(measured["import/no-cycle"]);
    expect(observed.diagnostics.filter((item) => item.ruleId === "import/no-cycle")).toHaveLength(2);
  });

  test("predecessor budget growth still fails when current diagnostics match the expanded baseline", () => {
    const git = (...args: string[]) => {
      const result = spawnSync("git", ["-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false", ...args], {
        cwd: root, encoding: "utf8",
        env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" },
      });
      expect(result.status).toBe(0);
      return result;
    };
    git("init", "--quiet");
    git("add", "scripts/baselines/lint-ratchet.json");
    git("-c", "user.name=RatchetStrap fixture", "-c", "user.email=fixture@example.invalid", "commit", "--quiet", "-m", "Initial baseline");
    git("-c", "user.name=RatchetStrap fixture", "-c", "user.email=fixture@example.invalid", "commit", "--quiet", "--allow-empty", "-m", "Current tree");
    const expanded = legacyBaseline({ "no-console": [identity("app/a.ts")] });
    write("scripts/baselines/lint-ratchet.json", JSON.stringify(expanded));
    const reports = setReport([{ file: "app/a.ts", messages: [warning] }]);
    const observed = summarizeLegacyIdentities(reports, legacyIdentitiesRuleIds, { root });
    const outcome = evaluateIdentities(importLegacyIdentitiesBaseline(expanded), observed, importLegacyIdentitiesBaseline(legacyBaseline()));
    expect(original().status).toBe(1);
    expect(outcome.ok).toBe(false);
    expect(outcome.baselineGrowth).toEqual({ "no-console": [identity("app/a.ts")] });
  });
});

describe("legacy identities scan boundaries", () => {
  test("requires all eight known rule IDs", () => {
    const reports = setReport([{ file: "app/a.ts" }]);
    expect(() => summarizeLegacyIdentities(reports, ["no-console"], { root })).toThrow("exactly");
    expect(() => summarizeLegacyIdentities(reports, [...legacyIdentitiesRuleIds, "other"], { root })).toThrow("exactly");
  });

  test("skips the original generated directories and declaration files", () => {
    write("app/a.ts", 'import "./build/b"; import "./types";\n');
    write("app/build/b.ts", 'import "../a";\n');
    write("app/node_modules/c.ts", 'import "../a";\n');
    write("app/.react-router/d.ts", 'import "../a";\n');
    write("app/types.d.ts", 'import "./a";\n');
    expect(collectLegacyIdentitiesCycles(root)).toEqual([]);
    setReport([{ file: "app/a.ts" }]);
    expect(original("--write-baseline").status).toBe(0);
    const measured = JSON.parse(readFileSync(join(root, "scripts/baselines/lint-ratchet.json"), "utf8"));
    expect(measured["import/no-cycle"]).toEqual([]);
  });

  test("a missing app tree fails instead of reporting no cycles", () => {
    rmSync(join(root, "app"), { recursive: true });
    expect(() => collectLegacyIdentitiesCycles(root)).toThrow();
  });

  test("source symlinks outside root are refused", () => {
    const external = mkdtempSync(join(tmpdir(), "ratchet-strap-quick-external-"));
    try {
      writeFileSync(join(external, "outside.ts"), "export {};\n");
      symlinkSync(join(external, "outside.ts"), join(root, "app/link.ts"));
      expect(() => collectLegacyIdentitiesCycles(root)).toThrow("outside --root");
    } finally {
      rmSync(external, { recursive: true, force: true });
    }
  });
});
