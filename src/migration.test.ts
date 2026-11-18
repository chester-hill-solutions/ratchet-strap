import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { detectProjects, planMigration } from "./migration.js";
import { legacyIdentitiesRuleIds } from "./identity-types.js";

const fixtures = fileURLToPath(new URL("../fixtures/", import.meta.url));
let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "ratchet-strap-migration-"));
  mkdirSync(join(root, "scripts/baselines"), { recursive: true });
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

function setupLegacyCounts() {
  copyFileSync(join(fixtures, "legacy-counts-check-lint-ratchet.mjs"), join(root, "scripts/check-lint-ratchet.mjs"));
  copyFileSync(join(fixtures, "legacy-counts-lint-ratchet.json"), join(root, "scripts/baselines/lint-ratchet.json"));
  writeFileSync(join(root, "package.json"), JSON.stringify({ scripts: {
    "check:lint-ratchet": "node scripts/check-lint-ratchet.mjs",
    "tools:lint-ratchet:baseline": "node scripts/check-lint-ratchet.mjs --baseline",
    "ci:local": "npm run lint && npm run check:lint-ratchet && npm test",
  } }));
}

function setupLegacyIdentities() {
  copyFileSync(join(fixtures, "legacy-identities-check-lint-ratchet.mjs"), join(root, "scripts/check-lint-ratchet.mjs"));
  const baseline = { version: 4, ...Object.fromEntries(legacyIdentitiesRuleIds.map((rule) => [rule, rule === "no-console" ? ["app/a.ts:no-console:Unexpected console statement.#1"] : []])) };
  writeFileSync(join(root, "scripts/baselines/lint-ratchet.json"), JSON.stringify(baseline));
  return baseline;
}

describe("project detection", () => {
  test("a known checker remains recognized for a custom source without the default baseline", () => {
    setupLegacyCounts();
    const legacy = join(root, "scripts/baselines/lint-ratchet.json");
    const custom = join(root, "custom-lint.json");
    const original = readFileSync(legacy, "utf8");
    writeFileSync(custom, original);
    rmSync(legacy);
    const plan = planMigration({ root, profile: "legacy-counts@1", from: "custom-lint.json" });
    expect(plan.recognized).toBe(true);
    expect(plan.source).toBe(custom);
    expect(plan.baseline).toMatchObject({ counts: JSON.parse(original).counts });
    expect(readFileSync(custom, "utf8")).toBe(original);
  });

  test("recognizes a frozen LegacyCounts checker and valid baseline without executing code", () => {
    setupLegacyCounts();
    const detected = detectProjects(root);
    expect(detected.unsupported).toEqual([]);
    expect(detected.candidates).toHaveLength(1);
    expect(detected.candidates[0]?.profile).toBe("legacy-counts@1");
    expect(detected.candidates[0]?.recognized).toBe(true);
  });

  test("an edited checker cannot inherit compatibility from a familiar filename", () => {
    setupLegacyCounts();
    const checker = join(root, "scripts/check-lint-ratchet.mjs");
    writeFileSync(checker, `throw new Error('must not execute');\n${readFileSync(checker, "utf8")}`);
    const detected = detectProjects(root);
    expect(detected.candidates[0]?.recognized).toBe(false);
    expect(detected.candidates[0]?.reason).toContain("unknown");
    expect(planMigration({ root, profile: "legacy-counts@1" }).recognized).toBe(false);
  });

  test("a known checker with malformed baseline remains unsupported", () => {
    setupLegacyCounts();
    writeFileSync(join(root, "scripts/baselines/lint-ratchet.json"), JSON.stringify({ counts: { complexity: -1 } }));
    const detected = detectProjects(root);
    expect(detected.candidates[0]?.recognized).toBe(false);
    expect(detected.unsupported).toHaveLength(1);
    expect(() => planMigration({ root, profile: "legacy-counts@1" })).toThrow();
  });

  test("missing or unknown ratchets do not receive a supported classification", () => {
    expect(detectProjects(root)).toEqual({ candidates: [], unsupported: [] });
    writeFileSync(join(root, "scripts/baselines/lint-ratchet.json"), JSON.stringify({ version: 99, entries: [] }));
    expect(detectProjects(root).candidates).toEqual([]);
    expect(detectProjects(root).unsupported).toHaveLength(1);
  });

  test("recognizes legacy identities only with its identity format and fingerprint", () => {
    setupLegacyIdentities();
    const detected = detectProjects(root);
    expect(detected.candidates[0]?.profile).toBe("legacy-identities@1");
    expect(detected.candidates[0]?.recognized).toBe(true);
    expect(detected.unsupported).toEqual([]);
  });
});

describe("migration preview", () => {
  test("preserves every LegacyCounts count and existing script names without writes", () => {
    setupLegacyCounts();
    const baselinePath = join(root, "scripts/baselines/lint-ratchet.json");
    const manifestPath = join(root, "package.json");
    const originalBaseline = readFileSync(baselinePath, "utf8");
    const originalManifest = readFileSync(manifestPath, "utf8");
    const plan = planMigration({ root, profile: "legacy-counts@1" });
    expect(plan.baseline).toMatchObject({ counts: JSON.parse(originalBaseline).counts, adapter: "suppression-counts@1" });
    expect(plan.scripts["check:lint-ratchet"]).toContain("ratchet-strap check");
    expect(plan.scripts["check:lint-ratchet"]).toContain("--cache-location './node_modules/.cache/eslint'");
    expect(plan.scripts["tools:lint-ratchet:baseline"]).toContain("tighten");
    expect(plan.scripts).not.toHaveProperty("ci:local");
    expect(readFileSync(baselinePath, "utf8")).toBe(originalBaseline);
    expect(readFileSync(manifestPath, "utf8")).toBe(originalManifest);
    expect(readdirSync(root)).not.toContain(".ratchet-strap.json");
  });

  test("legacy identities preserves identities, zero rules, configuration, and cache", () => {
    const legacy = setupLegacyIdentities();
    const plan = planMigration({ root, profile: "legacy-identities@1" });
    const { version: _version, ...identities } = legacy;
    expect(plan.baseline).toMatchObject({ schemaVersion: 2, legacyVersion: 4, identities });
    expect(plan.scripts["check:lint-ratchet"]).toContain("--eslint-config 'eslint.config.mjs'");
    expect(plan.scripts["check:lint-ratchet"]).toContain("--cache-location '.cache/eslint-ratchet'");
    expect(plan.scripts["check:lint-ratchet"]).toContain("--legacy-baseline 'scripts/baselines/lint-ratchet.json'");
  });

  test("rejects unsupported legacy identities versions and omitted rules", () => {
    setupLegacyIdentities();
    const source = join(root, "scripts/baselines/lint-ratchet.json");
    writeFileSync(source, JSON.stringify({ version: 99, ...Object.fromEntries(legacyIdentitiesRuleIds.map((rule) => [rule, []])) }));
    expect(() => planMigration({ root, profile: "legacy-identities@1" })).toThrow();
    writeFileSync(source, JSON.stringify({ version: 4, "no-console": [] }));
    expect(() => planMigration({ root, profile: "legacy-identities@1" })).toThrow();
  });

  test("preview never replaces the source or an existing target", () => {
    setupLegacyCounts();
    expect(() => planMigration({ root, profile: "legacy-counts@1", baseline: "scripts/baselines/lint-ratchet.json" })).toThrow("must differ");
    writeFileSync(join(root, ".ratchet-strap.json"), "existing target\n");
    const plan = planMigration({ root, profile: "legacy-counts@1" });
    expect(plan.notes.join(" ")).toContain("already exists");
    expect(readFileSync(join(root, ".ratchet-strap.json"), "utf8")).toBe("existing target\n");
  });

  test("preserves custom aliases and does not erase compound commands", () => {
    setupLegacyCounts();
    writeFileSync(join(root, "package.json"), JSON.stringify({ scripts: {
      "ratchet:gate": "node ./scripts/check-lint-ratchet.mjs",
      "ratchet:lower": "node scripts/check-lint-ratchet.mjs --baseline",
      "check:lint-ratchet": "node scripts/check-lint-ratchet.mjs && node scripts/another-check.mjs",
    } }));
    const plan = planMigration({ root, profile: "legacy-counts@1" });
    expect(plan.scripts["ratchet:gate"]).toContain(" check ");
    expect(plan.scripts["ratchet:lower"]).toContain(" tighten ");
    expect(plan.scripts).not.toHaveProperty("check:lint-ratchet");
    expect(plan.notes.join(" ")).toContain("compound");
  });

  test("script arguments preserve hostile-looking paths as literal data", () => {
    setupLegacyCounts();
    const target = "a dir/quote'$(touch SHOULD_NOT_EXIST);`echo injected`.json";
    const plan = planMigration({ root, profile: "legacy-counts@1", baseline: target });
    const capture = join(root, "ratchet-strap");
    writeFileSync(capture, "#!/usr/bin/env node\nprocess.stdout.write(JSON.stringify(process.argv.slice(2)));\n", { mode: 0o755 });
    const result = spawnSync("/bin/sh", ["-c", plan.scripts["check:lint-ratchet"] ?? "exit 99"], {
      cwd: root, env: { ...process.env, PATH: `${root}:${process.env.PATH}` }, encoding: "utf8",
    });
    expect(result.status).toBe(0);
    const argv: string[] = JSON.parse(result.stdout);
    expect(argv[argv.indexOf("--baseline") + 1]).toBe(target);
    expect(readdirSync(root)).not.toContain("SHOULD_NOT_EXIST");
  });

  test("suggested paths beginning with a dash are accepted by Node's argument parser", () => {
    setupLegacyIdentities();
    copyFileSync(join(root, "scripts/baselines/lint-ratchet.json"), join(root, "-old.json"));
    const plan = planMigration({ root, profile: "legacy-identities@1", from: "-old.json", baseline: "-debt.json" });
    writeFileSync(join(root, "ratchet-strap"), `#!/usr/bin/env node
const {values}=require('node:util').parseArgs({allowPositionals:true,options:{baseline:{type:'string'},'legacy-baseline':{type:'string'},'eslint-config':{type:'string'},'cache-location':{type:'string'},'exec-eslint':{type:'boolean'}}});
process.stdout.write(JSON.stringify(values));
`, { mode: 0o755 });
    const result = spawnSync("/bin/sh", ["-c", plan.scripts["check:lint-ratchet"] ?? "exit 99"], {
      cwd: root, env: { ...process.env, PATH: `${root}:${process.env.PATH}` }, encoding: "utf8",
    });
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout).baseline).toBe("./-debt.json");
    expect(JSON.parse(result.stdout)["legacy-baseline"]).toBe("./-old.json");
  });
});
