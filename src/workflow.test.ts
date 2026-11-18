import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { importLegacyIdentitiesBaseline } from "./identity.js";
import { legacyIdentitiesRuleIds } from "./identity-types.js";

const cli = fileURLToPath(new URL("./cli.ts", import.meta.url));
const fixture = fileURLToPath(new URL("../fixtures/legacy-counts-check-lint-ratchet.mjs", import.meta.url));
let root: string;

function run(...args: string[]) {
  return spawnSync(process.execPath, [cli, ...args, "--root", root], { encoding: "utf8" });
}

function setReport(rule?: string, file = "a.js", message = "Violation") {
  writeFileSync(join(root, "eslint-report.json"), JSON.stringify([{
    filePath: join(root, file),
    messages: rule ? [{ ruleId: rule, message, severity: 1, line: 1 }] : [],
    suppressedMessages: [],
  }]));
}

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "ratchet-strap-workflow-")));
  writeFileSync(join(root, "a.js"), "export {};\n");
  setReport();
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("unified CLI workflow", () => {
  test("strict identities require an explicit tightening step after a repair", () => {
    setReport("no-console");
    expect(run("init", "--rules", "no-console").status).toBe(0);
    setReport();
    expect(run("check").status).toBe(1);
    const original = readFileSync(join(root, ".ratchet-strap.json"), "utf8");
    const preview = run("tighten");
    expect(preview.status).toBe(0);
    expect(JSON.parse(preview.stdout).checkOk).toBe(false);
    expect(JSON.parse(preview.stdout).written).toBe(false);
    expect(readFileSync(join(root, ".ratchet-strap.json"), "utf8")).toBe(original);
    expect(run("tighten", "--write").status).toBe(0);
    expect(run("check").status).toBe(0);
    setReport("no-console");
    expect(run("check").status).toBe(1);
    expect(run("tighten", "--write").status).toBe(1);
  });

  test("same-count replacements cannot be accepted by tighten", () => {
    setReport("no-console");
    expect(run("init", "--rules", "no-console").status).toBe(0);
    setReport("no-console", "b.js");
    const result = run("check");
    expect(result.status).toBe(1);
    expect(JSON.parse(result.stdout).added["no-console"]).toHaveLength(1);
    expect(JSON.parse(result.stdout).stale["no-console"]).toHaveLength(1);
    expect(run("tighten", "--write").status).toBe(1);
  });

  test("add previews one new rule and never resets existing budgets", () => {
    expect(run("init", "--rules", "no-console").status).toBe(0);
    setReport("complexity");
    const preview = run("add", "--rules", "complexity");
    expect(preview.status).toBe(0);
    expect(JSON.parse(preview.stdout).written).toBe(false);
    expect(JSON.parse(readFileSync(join(root, ".ratchet-strap.json"), "utf8")).identities).toEqual({ "no-console": [] });
    expect(run("add", "--rules", "complexity", "--write").status).toBe(0);
    expect(run("check").status).toBe(0);
    expect(run("add", "--rules", "complexity", "--write").status).toBe(2);
  });

  test("an explicit predecessor rejects a baseline edited to allow a replacement", () => {
    setReport("no-console");
    run("init", "--rules", "no-console");
    copyFileSync(join(root, ".ratchet-strap.json"), join(root, "previous.json"));
    const current = JSON.parse(readFileSync(join(root, ".ratchet-strap.json"), "utf8"));
    current.identities["no-console"] = ["b.js:no-console:Violation#1"];
    writeFileSync(join(root, ".ratchet-strap.json"), JSON.stringify(current));
    setReport("no-console", "b.js");
    expect(run("check").status).toBe(0);
    expect(run("check", "--previous-baseline", "previous.json").status).toBe(1);
  });

  test("migration recognizes a frozen contract, previews scripts, and writes only a new baseline", () => {
    mkdirSync(join(root, "scripts/baselines"), { recursive: true });
    copyFileSync(fixture, join(root, "scripts/check-lint-ratchet.mjs"));
    writeFileSync(join(root, "scripts/baselines/lint-ratchet.json"), JSON.stringify({ counts: { "no-console": 4 } }));
    const manifest = JSON.stringify({ scripts: { "check:lint-ratchet": "node scripts/check-lint-ratchet.mjs" } });
    writeFileSync(join(root, "package.json"), manifest);
    expect(JSON.parse(run("detect").stdout).candidates[0].recognized).toBe(true);
    const preview = run("migrate");
    expect(preview.status).toBe(0);
    expect(JSON.parse(preview.stdout).scripts["check:lint-ratchet"]).toContain("ratchet-strap check");
    expect(existsSync(join(root, ".ratchet-strap.json"))).toBe(false);
    expect(run("migrate", "--write").status).toBe(0);
    expect(readFileSync(join(root, "package.json"), "utf8")).toBe(manifest);
    expect(run("migrate", "--write").status).toBe(2);
  });

  test("legacy identities automatically compares its imported baseline with the Git predecessor", () => {
    mkdirSync(join(root, "app"));
    mkdirSync(join(root, "scripts/baselines"), { recursive: true });
    writeFileSync(join(root, "app/a.ts"), "export {};\n");
    const identities: Record<string, string[]> = Object.fromEntries(legacyIdentitiesRuleIds.map((rule) => [rule, []]));
    identities["no-console"] = ["app/a.ts:no-console:Original#1"];
    const legacy = { version: 4, ...identities };
    writeFileSync(join(root, "scripts/baselines/lint-ratchet.json"), JSON.stringify(legacy));
    const git = (...args: string[]) => {
      const result = spawnSync("git", ["-C", root, ...args], { encoding: "utf8" });
      expect(result.status).toBe(0);
    };
    git("init", "--quiet"); git("config", "user.email", "ratchet@example.invalid"); git("config", "user.name", "RatchetStrap test");
    git("add", "."); git("commit", "--quiet", "-m", "baseline");
    writeFileSync(join(root, "marker"), "next"); git("add", "marker"); git("commit", "--quiet", "-m", "next");
    const current = importLegacyIdentitiesBaseline(legacy);
    current.identities["no-console"] = ["app/a.ts:no-console:Replacement#1"];
    writeFileSync(join(root, ".ratchet-strap.json"), JSON.stringify(current));
    setReport("no-console", "app/a.ts", "Replacement");
    const result = run("check");
    expect(result.status).toBe(1);
    expect(JSON.parse(result.stdout).baselineGrowth["no-console"]).toEqual(["app/a.ts:no-console:Replacement#1"]);
    expect(JSON.parse(result.stdout).predecessor).toBe("HEAD^:scripts/baselines/lint-ratchet.json");
  });

  test("runner options require execution and conflicting profiles fail clearly", () => {
    expect(run("init", "--rules", "no-console", "--profile", "eslint@1", "--adapter", "eslint-json@1").status).toBe(2);
    expect(run("init", "--rules", "no-console", "--eslint-config", "other.mjs").status).toBe(2);
    expect(run("init", "--rules", "no-console", "--profile", "eslint-counts@1").status).toBe(0);
    expect(JSON.parse(readFileSync(join(root, ".ratchet-strap.json"), "utf8")).adapter).toBe("eslint-json@1");
  });
});
