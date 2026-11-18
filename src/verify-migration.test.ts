import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { legacyIdentitiesRuleIds } from "./identity-types.js";
import type { IdentityMap } from "./identity-types.js";
import { collectLegacyIdentitiesSources } from "./legacy-reference.js";
import type { MigrationProfile } from "./migration.js";
import { verifyMigration } from "./verify-migration.js";

const fixtures = fileURLToPath(new URL("../fixtures/", import.meta.url));
let root: string;
const warning = { ruleId: "no-console", severity: 1, message: "Unexpected console statement.", line: 1 };
const identity = `app/a.ts:no-console:${warning.message}#1`;

function write(file: string, content: string): void {
  const target = join(root, file);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, content);
}

function setup(profile: MigrationProfile, baseline: unknown): void {
  write("app/a.ts", "export {};\n");
  write("scripts/baselines/lint-ratchet.json", JSON.stringify(baseline));
  write("package.json", JSON.stringify({ scripts: { "check:lint-ratchet": "node scripts/check-lint-ratchet.mjs", untouched: "echo unchanged" } }));
  copyFileSync(join(fixtures, profile === "legacy-counts@1" ? "legacy-counts-check-lint-ratchet.mjs" : "legacy-identities-check-lint-ratchet.mjs"), join(root, "scripts/check-lint-ratchet.mjs"));
}

function quickBaseline(identities: IdentityMap = {}) {
  return { version: 4, ...Object.fromEntries(legacyIdentitiesRuleIds.map((rule) => [rule, []])), ...identities };
}

function reports(messages: unknown[] = [], suppressedMessages: unknown[] = [], file = "app/a.ts") {
  return [{ filePath: join(root, file), messages, suppressedMessages }];
}

function recordPredecessor(): void {
  const git = (...args: string[]) => {
    const result = spawnSync("git", ["-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false", ...args], {
      cwd: root, encoding: "utf8", env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" },
    });
    expect(result.status).toBe(0);
  };
  git("init", "--quiet");
  git("add", "scripts/baselines/lint-ratchet.json");
  git("-c", "user.name=RatchetStrap fixture", "-c", "user.email=fixture@example.invalid", "commit", "--quiet", "-m", "Initial allowance");
  git("-c", "user.name=RatchetStrap fixture", "-c", "user.email=fixture@example.invalid", "commit", "--quiet", "--allow-empty", "-m", "Current source");
}

beforeEach(() => { root = realpathSync(mkdtempSync(join(tmpdir(), "ratchet-strap-verify-"))); });
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("LegacyCounts verified adoption", () => {
  for (const example of [
    { name: "unchanged warnings", budget: 1, messages: [warning], source: "export {};", passed: true, count: 1 },
    { name: "growth", budget: 0, messages: [warning], source: "export {};", passed: false, count: 1 },
    { name: "hard errors", budget: 0, messages: [{ ...warning, severity: 2 }], source: "export {};", passed: false, count: 0 },
    { name: "suppression comments", budget: 1, messages: [], source: "/* eslint-disable no-console */\nexport {};", passed: true, count: 1 },
    { name: "repaired debt", budget: 1, messages: [], source: "export {};", passed: true, count: 0 },
  ]) {
    test(example.name, () => {
      setup("legacy-counts@1", { _comment: "Existing budget", counts: { "no-console": example.budget, complexity: 0 } });
      write("app/a.ts", example.source);
      const path = join(root, "scripts/baselines/lint-ratchet.json");
      const original = readFileSync(path, "utf8");
      const result = verifyMigration({ root, profile: "legacy-counts@1", reports: reports(example.messages) });
      expect(result.equivalent).toBe(true);
      expect(result.canApply).toBe(example.passed);
      expect(result.legacy.passed).toBe(example.passed);
      expect(result.current.ok).toBe(example.passed);
      expect(result.legacy.counts["no-console"]).toBe(example.count);
      expect(result.legacy.counts).toEqual(result.current.counts);
      expect(readFileSync(path, "utf8")).toBe(original);
      expect(existsSync(join(root, ".ratchet-strap.json"))).toBe(false);
    });
  }
});

describe("legacy identities verified adoption", () => {
  for (const example of [
    { name: "unchanged identities", allowed: [identity], messages: [warning], suppressed: [], passed: true },
    { name: "stale identities", allowed: [identity], messages: [], suppressed: [], passed: false },
    { name: "new identities", allowed: [], messages: [warning], suppressed: [], passed: false },
    { name: "suppressed identities", allowed: [identity], messages: [], suppressed: [warning], passed: true },
    { name: "hard errors", allowed: [], messages: [{ ...warning, severity: 2 }], suppressed: [], passed: false },
  ]) {
    test(example.name, () => {
      setup("legacy-identities@1", quickBaseline({ "no-console": example.allowed }));
      const path = join(root, "scripts/baselines/lint-ratchet.json");
      const original = readFileSync(path, "utf8");
      const result = verifyMigration({ root, profile: "legacy-identities@1", reports: reports(example.messages, example.suppressed) });
      expect(result.equivalent).toBe(true);
      expect(result.canApply).toBe(example.passed);
      expect(result.legacy.passed).toBe(example.passed);
      expect(result.current.ok).toBe(example.passed);
      expect(result.legacy.counts["no-console"]).toBe(example.messages.length + example.suppressed.length);
      expect(result.legacy.identities?.["no-console"]).toHaveLength(example.messages.length + example.suppressed.length);
      expect(readFileSync(path, "utf8")).toBe(original);
      expect(result.cycleSources).toEqual([join(root, "app/a.ts")]);
      if (example.name === "hard errors") {
        const scratch = /([^\s()]*ratchet-strap-reference-[^/\s]+)\/reference\.cjs/.exec(result.legacy.stderr)?.[1];
        expect(scratch).toBeDefined();
        if (scratch) expect(existsSync(scratch)).toBe(false);
      }
    });
  }

  test("the supplemental cycle detector observes the same source bytes", () => {
    const cycles = ["app/a.ts -> app/b.ts -> app/a.ts:depth=2", "app/b.ts -> app/a.ts -> app/b.ts:depth=2"];
    setup("legacy-identities@1", quickBaseline({ "import/no-cycle": cycles }));
    write("app/a.ts", 'import "./b";\n');
    write("app/b.ts", 'import "./a";\n');
    const result = verifyMigration({ root, profile: "legacy-identities@1", reports: reports() });
    expect(result.equivalent).toBe(true);
    expect(result.canApply).toBe(true);
    expect(result.legacy.identities?.["import/no-cycle"]).toEqual(cycles);
    expect(result.snapshot[join(root, "app/b.ts")]).toHaveLength(64);
    expect(result.cycleSources).toEqual([join(root, "app/a.ts"), join(root, "app/b.ts")]);
  });

  test("the gate retains the real predecessor check while measurement cannot alter it", () => {
    setup("legacy-identities@1", quickBaseline());
    recordPredecessor();
    write("scripts/baselines/lint-ratchet.json", JSON.stringify(quickBaseline({ "no-console": [identity] })));
    const result = verifyMigration({ root, profile: "legacy-identities@1", reports: reports([warning]) });
    expect(result.equivalent).toBe(true);
    expect(result.legacy.passed).toBe(false);
    expect(result.current.ok).toBe(false);
    expect(result.legacy.identities?.["no-console"]).toEqual([identity]);
    expect(result.gitHead).toMatch(/^[a-f0-9]{40}$/);
  });

  test("stronger predecessor identity checks are reported as a real parity difference", () => {
    setup("legacy-identities@1", quickBaseline({ "no-console": [`app/old.ts:no-console:${warning.message}#1`] }));
    recordPredecessor();
    write("scripts/baselines/lint-ratchet.json", JSON.stringify(quickBaseline({ "no-console": [identity] })));
    const result = verifyMigration({ root, profile: "legacy-identities@1", reports: reports([warning]) });
    expect(result.legacy.passed).toBe(true);
    expect(result.current.ok).toBe(false);
    expect(result.equivalent).toBe(false);
    expect(result.canApply).toBe(false);
    expect(result.differences).toEqual(["Gate outcomes differ: legacy pass, RatchetStrap fail"]);
    expect(result.legacy.counts).toEqual(result.current.counts);
  });
});

describe("verification boundaries", () => {
  test("unknown checker code is never executed", () => {
    setup("legacy-counts@1", { counts: { "no-console": 0 } });
    write("scripts/check-lint-ratchet.mjs", 'import { writeFileSync } from "node:fs"; writeFileSync("executed", "bad");\n');
    expect(() => verifyMigration({ root, profile: "legacy-counts@1", reports: reports() })).toThrow("unrecognized checker");
    expect(existsSync(join(root, "executed"))).toBe(false);
  });

  test("empty scans and custom baseline substitutions fail before execution", () => {
    setup("legacy-counts@1", { counts: { "no-console": 0 } });
    expect(() => verifyMigration({ root, profile: "legacy-counts@1", reports: [] })).toThrow("non-empty");
    write("custom.json", JSON.stringify({ counts: { "no-console": 4 } }));
    expect(() => verifyMigration({ root, profile: "legacy-counts@1", from: "custom.json", reports: reports() })).toThrow("default legacy baseline");
  });

  test("snapshots bind the checker, legacy baseline, manifest, and reported sources", () => {
    setup("legacy-counts@1", { counts: { "no-console": 0 } });
    const result = verifyMigration({ root, profile: "legacy-counts@1", reports: reports() });
    const expected = ["scripts/check-lint-ratchet.mjs", "scripts/baselines/lint-ratchet.json", "package.json", "app/a.ts"];
    expect(Object.keys(result.snapshot).sort()).toEqual(expected.map((file) => join(root, file)).sort());
    for (const [path, hash] of Object.entries(result.snapshot)) expect(hash).toBe(createHash("sha256").update(readFileSync(path)).digest("hex"));
  });

  test("snapshots bind lint configuration and lockfiles that are absent from the supplied report", () => {
    setup("legacy-counts@1", { counts: { "no-console": 0 } });
    write("eslint.config.mjs", 'throw new Error("Config must not execute during reference comparison");\n');
    write(".eslintignore", "generated/\n");
    write("package-lock.json", '{"lockfileVersion":3,"packages":{}}\n');
    const result = verifyMigration({ root, profile: "legacy-counts@1", reports: reports() });
    expect(result.equivalent).toBe(true);
    for (const file of ["eslint.config.mjs", ".eslintignore", "package-lock.json"]) {
      const path = join(root, file);
      expect(result.snapshot[path]).toBe(createHash("sha256").update(readFileSync(path)).digest("hex"));
    }
  });

  test("project membership binds ordinary JavaScript files outside the supplied report", () => {
    setup("legacy-counts@1", { counts: { "no-console": 0 } });
    write("app/ordinary.js", "export {};\n");
    const result = verifyMigration({ root, profile: "legacy-counts@1", reports: reports() });
    expect(result.projectFiles).toContain("file:app/ordinary.js");
    expect(result.projectFiles).toContain("file:app/a.ts");
    expect(result.projectFiles).toContain("file:package.json");
    expect(result.projectFiles).not.toContain("file:.ratchet-strap.json");
  });

  for (const profile of ["legacy-counts@1", "legacy-identities@1"] as const) {
    test(`${profile} rejects a JavaScript file added after membership capture`, () => {
      setup(profile, profile === "legacy-counts@1" ? { counts: { "no-console": 0 } } : quickBaseline());
      const input = reports();
      Object.defineProperty(input, "toJSON", { value: () => {
        write("app/added-after-snapshot.js", "export {};\n");
        return input;
      } });
      expect(() => verifyMigration({ root, profile, reports: input })).toThrow("Project file membership changed");
      expect(existsSync(join(root, "app/added-after-snapshot.js"))).toBe(true);
    });
  }

  test("source paths outside root fail, including symlink escapes", () => {
    setup("legacy-counts@1", { counts: { "no-console": 0 } });
    const outside = mkdtempSync(join(tmpdir(), "ratchet-strap-verify-outside-"));
    try {
      writeFileSync(join(outside, "outside.ts"), "export {};\n");
      symlinkSync(join(outside, "outside.ts"), join(root, "app/outside.ts"));
      expect(() => verifyMigration({ root, profile: "legacy-counts@1", reports: reports([], [], "app/outside.ts") })).toThrow("outside --root");
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  test("cycle membership mirrors original exclusions", () => {
    setup("legacy-identities@1", quickBaseline());
    write("app/build/b.ts", "export {};\n");
    write("app/node_modules/c.ts", "export {};\n");
    write("app/.react-router/routes.ts", "export {};\n");
    write("app/types.d.ts", "export {};\n");
    expect(collectLegacyIdentitiesSources(root)).toEqual([join(root, "app/a.ts")]);
    verifyMigration({ root, profile: "legacy-identities@1", reports: reports() });
    expect(existsSync(join(root, ".ratchet-strap.json"))).toBe(false);
  });
});
