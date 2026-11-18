import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { packageName, packageVersion } from "./package-meta.js";
import { runAdoption } from "./adoption-commands.js";

const cli = fileURLToPath(new URL("./cli.ts", import.meta.url));
const checkerFixture = fileURLToPath(new URL("../fixtures/legacy-counts-check-lint-ratchet.mjs", import.meta.url));
let root: string;

function run(...args: string[]) {
  return spawnSync(process.execPath, [cli, ...args, "--root", root], { encoding: "utf8" });
}

function setReport(warnings = 1) {
  writeFileSync(join(root, "eslint-report.json"), JSON.stringify([{
    filePath: join(root, "a.js"),
    messages: Array.from({ length: warnings }, () => ({ ruleId: "no-console", severity: 1, message: "Unexpected console statement.", line: 1 })),
    suppressedMessages: [],
  }]));
}

function installFixture(version = packageVersion) {
  const directory = join(root, "node_modules/ratchet-strap");
  mkdirSync(join(directory, "dist"), { recursive: true });
  writeFileSync(join(directory, "package.json"), JSON.stringify({ name: packageName, version, main: "dist/index.js", bin: { "ratchet-strap": "dist/cli.js" } }));
  writeFileSync(join(directory, "dist/index.js"), "module.exports = {};\n");
  writeFileSync(join(directory, "dist/cli.js"), "#!/usr/bin/env node\n", { mode: 0o755 });
  mkdirSync(join(root, "node_modules/.bin"), { recursive: true });
  symlinkSync("../ratchet-strap/dist/cli.js", join(root, "node_modules/.bin/ratchet-strap"));
}

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "ratchet-strap-adoption-")));
  mkdirSync(join(root, "scripts/baselines"), { recursive: true });
  copyFileSync(checkerFixture, join(root, "scripts/check-lint-ratchet.mjs"));
  writeFileSync(join(root, "scripts/baselines/lint-ratchet.json"), JSON.stringify({ _comment: "Existing debt", counts: { "no-console": 1 } }));
  writeFileSync(join(root, "a.js"), "console.log('existing');\n");
  writeFileSync(join(root, "package.json"), JSON.stringify({
    name: "adoption-fixture", private: true,
    devDependencies: { [packageName]: packageVersion },
    scripts: { "check:lint-ratchet": "node scripts/check-lint-ratchet.mjs", "tools:lint-ratchet:baseline": "node scripts/check-lint-ratchet.mjs --baseline", lint: "eslint .", "ci:local": "npm run lint && npm run check:lint-ratchet" },
  }, null, 2) + "\n");
  setReport();
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("verified migration CLI", () => {
  test("verify compares the actual original checker without changing project files", () => {
    const original = readFileSync(join(root, "scripts/baselines/lint-ratchet.json"), "utf8");
    const manifest = readFileSync(join(root, "package.json"), "utf8");
    const result = run("verify", "--report", "eslint-report.json");
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout).equivalent).toBe(true);
    expect(JSON.parse(result.stdout).canApply).toBe(true);
    expect(readFileSync(join(root, "scripts/baselines/lint-ratchet.json"), "utf8")).toBe(original);
    expect(readFileSync(join(root, "package.json"), "utf8")).toBe(manifest);
    expect(existsSync(join(root, ".ratchet-strap.json"))).toBe(false);
  });

  test("apply updates supported aliases while preserving debt and unrelated project settings", () => {
    installFixture();
    const legacy = readFileSync(join(root, "scripts/baselines/lint-ratchet.json"), "utf8");
    const result = run("migrate", "--apply", "--report", "eslint-report.json");
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout).applied).toBe(true);
    const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
    expect(manifest.scripts["check:lint-ratchet"]).toContain("ratchet-strap check");
    expect(manifest.scripts["tools:lint-ratchet:baseline"]).toContain("ratchet-strap tighten");
    expect(manifest.scripts.lint).toBe("eslint .");
    expect(manifest.scripts["ci:local"]).toBe("npm run lint && npm run check:lint-ratchet");
    expect(manifest.devDependencies).toEqual({ [packageName]: packageVersion });
    expect(JSON.parse(readFileSync(join(root, ".ratchet-strap.json"), "utf8")).counts).toEqual({ "no-console": 1 });
    expect(readFileSync(join(root, "scripts/baselines/lint-ratchet.json"), "utf8")).toBe(legacy);
  });

  test("agreement on a failing gate is not permission to apply", () => {
    installFixture();
    setReport(2);
    const manifest = readFileSync(join(root, "package.json"), "utf8");
    const verified = run("verify", "--report", "eslint-report.json");
    expect(verified.status).toBe(1);
    expect(JSON.parse(verified.stdout).equivalent).toBe(true);
    expect(JSON.parse(verified.stdout).canApply).toBe(false);
    expect(run("migrate", "--apply", "--report", "eslint-report.json").status).toBe(1);
    expect(readFileSync(join(root, "package.json"), "utf8")).toBe(manifest);
    expect(existsSync(join(root, ".ratchet-strap.json"))).toBe(false);
  });

  test("apply needs a matching installed package and never creates half an adoption", () => {
    const original = readFileSync(join(root, "package.json"), "utf8");
    expect(run("migrate", "--apply", "--report", "eslint-report.json").status).toBe(2);
    installFixture("0.0.0");
    expect(run("migrate", "--apply", "--report", "eslint-report.json").status).toBe(2);
    expect(readFileSync(join(root, "package.json"), "utf8")).toBe(original);
    expect(existsSync(join(root, ".ratchet-strap.json"))).toBe(false);
  });

  test("unrecognized legacy code cannot execute during verify", () => {
    writeFileSync(join(root, "scripts/check-lint-ratchet.mjs"), "import fs from 'node:fs'; fs.writeFileSync('UNEXPECTED','bad');\n");
    expect(run("verify", "--profile", "legacy-counts@1", "--report", "eslint-report.json").status).toBe(2);
    expect(existsSync(join(root, "UNEXPECTED"))).toBe(false);
  });

  test("preview, baseline-only writing, and applying remain distinct operations", () => {
    for (const args of [
      ["migrate", "--apply"],
      ["migrate", "--apply", "--write", "--report", "eslint-report.json"],
      ["migrate", "--report", "eslint-report.json"],
      ["verify", "--write"],
    ]) expect(run(...args).status).toBe(2);
    expect(existsSync(join(root, ".ratchet-strap.json"))).toBe(false);
    expect(run("migrate", "--write").status).toBe(0);
    installFixture();
    expect(run("migrate", "--apply", "--report", "eslint-report.json").status).toBe(2);
  });

  test("the CLI reports the package version", () => {
    const result = spawnSync(process.execPath, [cli, "--version"], { encoding: "utf8" });
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe(packageVersion);
  });

  test("verified adoption cannot generate a passing report using a relaxed config override", () => {
    expect(run("verify", "--exec-eslint", "--eslint-config", "relaxed.config.mjs").status).toBe(2);
    expect(() => runAdoption({
      command: "verify", root, profile: "legacy-counts@1",
      report: { execEslint: true, eslintConfig: "relaxed.config.mjs" },
    })).toThrow("fixed ESLint invocation");
    expect(() => runAdoption({
      command: "migrate", root, profile: "legacy-counts@1", apply: true,
      report: { execEslint: true, cacheLocation: "other-cache" },
    })).toThrow("fixed ESLint invocation");
  });
});
