import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { writeBaseline } from "./io.js";
import type { Baseline } from "./types.js";

const cliPath = fileURLToPath(new URL("./cli.ts", import.meta.url));
let root: string;
const baseline: Baseline = {
  schemaVersion: 1, adapter: "eslint-json@1", counts: { "no-console": 2, complexity: 0 },
};

function run(...args: string[]) {
  return spawnSync(process.execPath, [cliPath, ...args, "--root", root], { encoding: "utf8" });
}

function setReport(messages: unknown[] = []) {
  writeFileSync(join(root, "eslint-report.json"), JSON.stringify([
    { filePath: join(root, "a.js"), messages, suppressedMessages: [] },
  ]));
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "ratchet-strap-cli-"));
  writeFileSync(join(root, ".ratchet-strap.json"), JSON.stringify(baseline));
  writeFileSync(join(root, "a.js"), "export {};\n");
  setReport();
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("RatchetStrap CLI", () => {
  test("check returns structured improvements without writing", () => {
    const original = readFileSync(join(root, ".ratchet-strap.json"), "utf8");
    const result = run("check");
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout).improvements).toHaveLength(1);
    expect(readFileSync(join(root, ".ratchet-strap.json"), "utf8")).toBe(original);
  });

  test("tighten previews, then writes only with --write", () => {
    const preview = run("tighten");
    expect(JSON.parse(preview.stdout).written).toBe(false);
    expect(JSON.parse(readFileSync(join(root, ".ratchet-strap.json"), "utf8")).counts["no-console"]).toBe(2);
    const saved = run("tighten", "--write");
    expect(saved.status).toBe(0);
    expect(JSON.parse(saved.stdout).written).toBe(true);
    expect(JSON.parse(readFileSync(join(root, ".ratchet-strap.json"), "utf8")).counts).toEqual({ "no-console": 0, complexity: 0 });
  });

  test("growth and hard errors return 1 and leave the file intact", () => {
    const original = readFileSync(join(root, ".ratchet-strap.json"), "utf8");
    for (const message of [
      { ruleId: "complexity", severity: 1, message: "Too complex" },
      { ruleId: null, severity: 2, message: "Parsing error" },
    ]) {
      setReport([message]);
      const result = run("tighten", "--write");
      expect(result.status).toBe(1);
      expect(JSON.parse(result.stdout).ok).toBe(false);
      expect(readFileSync(join(root, ".ratchet-strap.json"), "utf8")).toBe(original);
    }
  });

  test("inspect discovers rules and detector versions without running ESLint", () => {
    rmSync(join(root, "eslint-report.json"));
    const result = run("inspect");
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout).counts).toEqual(baseline.counts);
  });

  test("import never overwrites a baseline or changes its counts", () => {
    const legacy = { _comment: "Existing", counts: { complexity: 17, "no-console": 0 } };
    writeFileSync(join(root, "old.json"), JSON.stringify(legacy));
    const result = run("import-legacy-counts", "--from", "old.json", "--baseline", "imported.json");
    expect(result.status).toBe(0);
    const content = readFileSync(join(root, "imported.json"), "utf8");
    expect(JSON.parse(content)).toEqual({ ...legacy, schemaVersion: 1, adapter: "suppression-counts@1" });
    expect(run("import-legacy-counts", "--from", "old.json", "--baseline", "imported.json").status).toBe(2);
    expect(readFileSync(join(root, "imported.json"), "utf8")).toBe(content);
  });

  test("init records explicit tracked rules including zeros and refuses overwrite", () => {
    expect(run("init", "--rules", "no-console,complexity", "--baseline", "new.json").status).toBe(0);
    expect(JSON.parse(readFileSync(join(root, "new.json"), "utf8")).identities).toEqual({ "no-console": [], complexity: [] });
    expect(run("init", "--rules", "no-console", "--baseline", "new.json").status).toBe(2);
  });

  test("init refuses to grandfather hard errors", () => {
    setReport([{ ruleId: "broken", severity: 2, message: "Bad code" }]);
    expect(run("init", "--rules", "no-console", "--baseline", "new.json").status).toBe(1);
    expect(readdirSync(root)).not.toContain("new.json");
  });

  for (const args of [
    ["check", "--unknown"], ["check", "--baseline"], ["check", "--write"],
    ["check", "--report", "a.json", "--exec-eslint"], ["unknown"],
    ["init", "--rules", "a,a", "--baseline", "new.json"],
  ]) {
    test(`rejects invalid arguments: ${args.join(" ")}`, () => expect(run(...args).status).toBe(2));
  }

  test("the ESLint runner uses a local installation and rejects abnormal exits even with JSON stdout", () => {
    const directory = join(root, "node_modules/eslint");
    mkdirSync(join(directory, "bin"), { recursive: true });
    writeFileSync(join(directory, "package.json"), JSON.stringify({ name: "eslint", version: "9.0.0" }));
    const localReport = readFileSync(join(root, "eslint-report.json"), "utf8");
    const entry = join(directory, "bin/eslint.js");
    writeFileSync(entry, `console.log(${JSON.stringify(localReport)}); process.exit(2);`);
    expect(run("check", "--exec-eslint").status).toBe(2);
    writeFileSync(entry, `console.log(${JSON.stringify(localReport)}); process.exit(1);`);
    expect(run("check", "--exec-eslint").status).toBe(0);
  });
});

describe("baseline writes", () => {
  test("a changed baseline or another writer prevents replacement", () => {
    const path = join(root, ".ratchet-strap.json");
    expect(() => writeBaseline(path, baseline, "stale")).toThrow("changed during");
    const original = readFileSync(path, "utf8");
    writeFileSync(`${path}.lock`, "another process");
    expect(() => writeBaseline(path, baseline, original)).toThrow();
    expect(readFileSync(path, "utf8")).toBe(original);
    expect(readFileSync(`${path}.lock`, "utf8")).toBe("another process");
    expect(readdirSync(root).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });
});
