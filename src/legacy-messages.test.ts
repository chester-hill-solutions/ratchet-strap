import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { runAdoption } from "./adoption-commands.js";
import { applyMigration } from "./apply-migration.js";
import { parseBaseline } from "./baseline.js";
import { initialize } from "./commands.js";
import { summarize } from "./eslint.js";
import { legacyMessagesCheckerSha256, legacyMessagesRuleIds } from "./legacy-messages-types.js";
import { importLegacyMessagesBaseline, summarizeLegacyMessages } from "./legacy-messages.js";
import { parseLegacyMessagesMeasurement } from "./legacy-messages-reference.js";
import { detectProjects, planMigration } from "./migration.js";
import { packageName, packageVersion } from "./package-meta.js";
import { checkBaseline, observeBaseline } from "./product.js";
import { verifyMigration } from "./verify-migration.js";

const fixtures = fileURLToPath(new URL("../fixtures/", import.meta.url));
const cli = fileURLToPath(new URL("./cli.ts", import.meta.url));
let root: string;
const warning = { ruleId: "no-console", severity: 1, message: "Unexpected console statement.", line: 1 };

function write(path: string, value: string, mode?: number): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, value, mode === undefined ? undefined : { mode });
}

function setup(baseline: unknown = {}): void {
  write(join(root, "app/a.ts"), "export {};\n");
  write(join(root, "scripts/baselines/lint-ratchet.json"), `${JSON.stringify(baseline)}\n`);
  copyFileSync(join(fixtures, "legacy-messages-check-lint-ratchet.mjs"), join(root, "scripts/check-lint-ratchet.mjs"));
  write(join(root, "package.json"), JSON.stringify({
    name: "legacy-messages-fixture", private: true, type: "module", devDependencies: { [packageName]: packageVersion },
    scripts: {
      lint: "eslint --cache --cache-location ./node_modules/.cache/eslint .",
      "check:lint-ratchet": "node scripts/check-lint-ratchet.mjs",
      "ci:local": "npm run lint && npm run check:lint-ratchet && npm run check:effects",
    },
  }));
}

function reports(messages: unknown[] = [], suppressedMessages: unknown[] = []) {
  return [{ filePath: join(root, "app/a.ts"), messages, suppressedMessages }];
}

function installedCandidate(): void {
  const directory = join(root, "node_modules", ...packageName.split("/"));
  write(join(directory, "package.json"), JSON.stringify({ name: packageName, version: packageVersion, main: "dist/index.js", bin: { "ratchet-strap": "dist/cli.js" } }));
  write(join(directory, "dist/index.js"), "module.exports = {};\n");
  write(join(directory, "dist/cli.js"), "#!/usr/bin/env node\n", 0o755);
  mkdirSync(join(root, "node_modules/.bin"), { recursive: true });
  symlinkSync(join(directory, "dist/cli.js"), join(root, "node_modules/.bin/ratchet-strap"));
}

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "ratchet-strap-legacy-messages-test-")));
  mkdirSync(join(root, "scripts/baselines"), { recursive: true });
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("LegacyMessages declared zero-budget import", () => {
  test("frozen checker bytes match the recognized upstream fingerprint", () => {
    expect(createHash("sha256").update(readFileSync(join(fixtures, "legacy-messages-check-lint-ratchet.mjs"))).digest("hex")).toBe(legacyMessagesCheckerSha256);
  });

  test("the actual empty flat baseline becomes exactly seven zero allowances", () => {
    const input = JSON.parse(readFileSync(join(fixtures, "legacy-messages-lint-ratchet.json"), "utf8"));
    const baseline = importLegacyMessagesBaseline(input);
    expect(baseline.adapter).toBe("message-counts@1");
    expect(baseline.counts).toEqual(Object.fromEntries(legacyMessagesRuleIds.map((rule) => [rule, 0])));
    expect(input).toEqual({});
  });

  test("preserves explicitly declared budgets and comments, defaulting only omitted rules", () => {
    const baseline = importLegacyMessagesBaseline({ complexity: 2, _comment: "Declared allowance" });
    expect(baseline.counts.complexity).toBe(2);
    expect(baseline.counts["no-console"]).toBe(0);
    expect(baseline._comment).toBe("Declared allowance");
  });

  for (const input of [{ counts: {} }, { version: 2 }, { unknown: 0 }, { complexity: -1 }, { complexity: "1" }, { complexity: null }]) {
    test(`rejects unsupported or invalid flat input ${JSON.stringify(input)}`, () => {
      expect(() => importLegacyMessagesBaseline(input)).toThrow();
    });
  }

  test("normalized baselines cannot silently drop one of the fixed rules", () => {
    expect(() => parseBaseline({ schemaVersion: 1, adapter: "message-counts@1", counts: { "no-console": 0 } })).toThrow("seven");
  });

  test("initialization cannot grandfather warnings into the zero-budget profile", () => {
    setup();
    const target = join(root, ".ratchet-strap.json");
    const result = initialize(target, importLegacyMessagesBaseline({}), reports([warning]), root);
    expect(result.code).toBe(1);
    expect(existsSync(target)).toBe(false);
  });
});

describe("LegacyMessages original/new valid-report parity", () => {
  for (const example of [
    { name: "zero debt", baseline: {}, messages: [], suppressed: [], passed: true, count: 0, lintPassed: true },
    { name: "new warning", baseline: {}, messages: [warning], suppressed: [], passed: false, count: 1, lintPassed: true },
    { name: "declared allowance", baseline: { "no-console": 1 }, messages: [warning], suppressed: [], passed: true, count: 1, lintPassed: true },
    { name: "suppressed warning remains ignored", baseline: {}, messages: [], suppressed: [warning], passed: true, count: 0, lintPassed: true },
    { name: "tracked hard errors count as messages", baseline: { "no-console": 1 }, messages: [{ ...warning, severity: 2 }], suppressed: [], passed: true, count: 1, lintPassed: false },
    { name: "tracked hard error over budget", baseline: {}, messages: [{ ...warning, severity: 2 }], suppressed: [], passed: false, count: 1, lintPassed: false },
    { name: "untracked hard errors remain outside this legacy ratchet", baseline: {}, messages: [{ ...warning, ruleId: "no-undef", severity: 2 }], suppressed: [], passed: true, count: 0, lintPassed: false },
    { name: "untracked warnings", baseline: {}, messages: [{ ...warning, ruleId: "other" }], suppressed: [], passed: true, count: 0, lintPassed: true },
  ]) {
    test(example.name, () => {
      setup(example.baseline);
      const original = readFileSync(join(root, "scripts/baselines/lint-ratchet.json"), "utf8");
      const result = verifyMigration({ root, profile: "legacy-messages@1", reports: reports(example.messages, example.suppressed) });
      expect(result.equivalent).toBe(true);
      expect(result.legacy.passed).toBe(example.passed);
      expect(result.current.ok).toBe(example.passed);
      expect(result.legacy.counts).toEqual(result.current.counts);
      expect(result.current.counts["no-console"]).toBe(example.count);
      expect(result.lintPassed).toBe(example.lintPassed);
      expect(result.canApply).toBe(example.passed && example.lintPassed);
      expect(readFileSync(join(root, "scripts/baselines/lint-ratchet.json"), "utf8")).toBe(original);
    });
  }

  test("unused suppression source comments are not reinterpreted as LegacyCounts debt", () => {
    setup();
    write(join(root, "app/a.ts"), "// eslint-disable-next-line no-console\nexport {};\n");
    const result = verifyMigration({ root, profile: "legacy-messages@1", reports: reports() });
    expect(result.equivalent).toBe(true);
    expect(result.current.counts["no-console"]).toBe(0);
    expect(result.canApply).toBe(true);
  });

  test("the public count observer dispatches to LegacyMessages rather than LegacyCounts source scanning", () => {
    const baseline = importLegacyMessagesBaseline({});
    const observed = summarize(reports([], [warning]), legacyMessagesRuleIds, { adapter: baseline.adapter, root });
    expect(observed.counts["no-console"]).toBe(0);
    expect(checkBaseline(baseline, observed).ok).toBe(true);
    expect(summarizeLegacyMessages(reports([{ ...warning, severity: 2 }]), legacyMessagesRuleIds, root).counts["no-console"]).toBe(1);
  });

  test("incomplete reference measurements cannot authorize a parity claim", () => {
    expect(() => parseLegacyMessagesMeasurement("- no-console: 0 > baseline -1\n")).toThrow("Incomplete");
  });

  test("empty and malformed scans fail closed instead of copying legacy execution fallbacks", () => {
    setup();
    const baseline = importLegacyMessagesBaseline({});
    expect(() => observeBaseline(baseline, [], root)).toThrow("non-empty");
    expect(() => observeBaseline(baseline, [{ filePath: "a.ts" }], root)).toThrow();
  });
});

describe("LegacyMessages discovery, fixed runner, and guarded adoption", () => {
  test("discovers the actual checker/flat baseline and preserves its uncached alias invocation", () => {
    setup();
    expect(detectProjects(root).candidates).toMatchObject([{ profile: "legacy-messages@1", recognized: true }]);
    const plan = planMigration({ root, profile: "legacy-messages@1" });
    expect(plan.scripts["check:lint-ratchet"]).toContain("--exec-eslint");
    expect(plan.scripts["check:lint-ratchet"]).not.toContain("--cache");
    expect(plan.notes.join(" ")).toContain("preceding npm run lint");
    expect(plan.baseline).toMatchObject({ counts: importLegacyMessagesBaseline({}).counts });
  });

  test("runner uses exactly npx eslint -f json . with no cache and refuses abnormal execution", () => {
    setup();
    write(join(root, ".ratchet-strap.json"), JSON.stringify(importLegacyMessagesBaseline({})));
    write(join(root, "report.json"), JSON.stringify(reports()));
    write(join(root, "node_modules/eslint/package.json"), '{"name":"eslint","version":"9.0.0"}');
    write(join(root, "node_modules/eslint/bin/eslint.js"), "// Installed executable is required before invoking npx.\n");
    write(join(root, "bin/npx"), `#!/usr/bin/env node
import fs from 'node:fs';
fs.writeFileSync(process.env.LEGACY_MESSAGES_ARGV, JSON.stringify(process.argv.slice(2)));
process.stdout.write(fs.readFileSync(process.env.LEGACY_MESSAGES_REPORT, 'utf8'));
process.exit(Number(process.env.LEGACY_MESSAGES_STATUS));
`, 0o755);
    const run = (status: string) => spawnSync(process.execPath, [cli, "check", "--root", root, "--exec-eslint"], {
      encoding: "utf8", env: {
        ...process.env, PATH: `${join(root, "bin")}:${process.env.PATH}`,
        LEGACY_MESSAGES_ARGV: join(root, "argv.json"), LEGACY_MESSAGES_REPORT: join(root, "report.json"), LEGACY_MESSAGES_STATUS: status,
      },
    });
    expect(run("0").status).toBe(0);
    expect(JSON.parse(readFileSync(join(root, "argv.json"), "utf8"))).toEqual(["eslint", "-f", "json", "."]);
    expect(run("2").status).toBe(2);
    rmSync(join(root, "node_modules/eslint/bin/eslint.js"));
    const missing = run("0");
    expect(missing.status).toBe(2);
    expect(missing.stderr).toContain("Install ESLint");
  });

  test("verified adoption still rejects runner overrides", () => {
    setup();
    expect(() => runAdoption({ command: "verify", root, profile: "legacy-messages@1", report: { execEslint: true, eslintConfig: "relaxed.mjs" } })).toThrow("fixed ESLint invocation");
  });

  test("guarded apply retains standalone lint and all original legacy baseline bytes", () => {
    setup();
    installedCandidate();
    const legacy = readFileSync(join(root, "scripts/baselines/lint-ratchet.json"), "utf8");
    const input = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
    const verification = verifyMigration({ root, profile: "legacy-messages@1", reports: reports() });
    expect(applyMigration(verification, { root }).applied).toBe(true);
    const next = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
    expect(next.scripts.lint).toBe(input.scripts.lint);
    expect(next.scripts["ci:local"]).toBe(input.scripts["ci:local"]);
    expect(next.scripts["check:lint-ratchet"]).toContain("ratchet-strap check");
    expect(JSON.parse(readFileSync(join(root, ".ratchet-strap.json"), "utf8")).counts).toEqual(importLegacyMessagesBaseline({}).counts);
    expect(readFileSync(join(root, "scripts/baselines/lint-ratchet.json"), "utf8")).toBe(legacy);
  });

  test("parity alone cannot apply when the mandatory lint gate fails", () => {
    setup();
    installedCandidate();
    const proof = verifyMigration({ root, profile: "legacy-messages@1", reports: reports([{ ...warning, ruleId: "no-undef", severity: 2 }]) });
    expect(proof.equivalent).toBe(true);
    expect(proof.current.ok).toBe(true);
    expect(proof.canApply).toBe(false);
    expect(() => applyMigration(proof, { root })).toThrow("preceding standalone ESLint");
    expect(existsSync(join(root, ".ratchet-strap.json"))).toBe(false);
  });
});
