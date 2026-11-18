import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runEslint, runLegacyStrictCountsEslint } from "./runner.js";

let root: string;
function executable(body: string, nested = false): void {
  const directory = join(root, nested ? "packages/legacy-strict-counts-s3/node_modules/eslint" : "node_modules/eslint");
  mkdirSync(join(directory, "bin"), { recursive: true });
  writeFileSync(join(directory, "package.json"), JSON.stringify({ name: "eslint", version: "1.0.0" }));
  writeFileSync(join(directory, "bin/eslint.js"), body);
}
beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "ratchet-runner-")));
  writeFileSync(join(root, "package.json"), "{}\n");
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("installed ESLint process boundary", () => {
  test("exit 1 still returns its JSON report and retains the exact override arguments", () => {
    executable('console.log(JSON.stringify(process.argv.slice(2))); process.exitCode = 1;');
    expect(runEslint(root, { config: "strict.config.mjs", cacheLocation: "cache/lint" })).toEqual([
      ".", "--format", "json", "--config", "strict.config.mjs", "--cache", "--cache-location", "cache/lint",
    ]);
  });
  test("resolves ESLint beside a flat config outside the consuming package", () => {
    const boundary = join(root, "packages/boundary");
    const config = join(root, "packages/eslint-config/dist/boundary-config.js");
    const eslintPackage = join(root, "packages/eslint-config/node_modules/eslint");
    mkdirSync(boundary, { recursive: true });
    mkdirSync(join(config, ".."), { recursive: true });
    writeFileSync(config, "export default [];\n");
    mkdirSync(join(eslintPackage, "bin"), { recursive: true });
    writeFileSync(join(eslintPackage, "package.json"), JSON.stringify({ name: "eslint", version: "1.0.0" }));
    writeFileSync(
      join(eslintPackage, "bin/eslint.js"),
      'console.log(JSON.stringify({ cwd: process.cwd(), args: process.argv.slice(2) }));',
    );

    expect(runEslint(boundary, { config: "../../packages/eslint-config/dist/boundary-config.js" })).toEqual({
      cwd: boundary,
      args: [".", "--format", "json", "--config", "../../packages/eslint-config/dist/boundary-config.js", "--no-cache"],
    });
  });
  for (const [description, script, message] of [
    ["tool exit", 'console.error("broken tool"); process.exitCode = 2;', /ESLint failed \(2\).*broken tool/],
    ["empty output", 'process.exitCode = 0;', /no JSON output/],
    ["malformed output", 'console.log("not JSON");', /JSON/],
    ["signal termination", 'process.kill(process.pid, "SIGTERM");', /ESLint failed \(SIGTERM\)/],
  ] as const) {
    test(`${description} rejects without changing the executable or manifest`, () => {
      executable(script);
      const manifest = readFileSync(join(root, "package.json"), "utf8");
      expect(() => runEslint(root)).toThrow(message);
      expect(readFileSync(join(root, "node_modules/eslint/bin/eslint.js"), "utf8")).toBe(script);
      expect(readFileSync(join(root, "package.json"), "utf8")).toBe(manifest);
    });
  }
  test("LegacyStrictCounts cannot borrow the ancestor executable and runs with its nested cwd", () => {
    executable('console.log("[]");');
    expect(() => runLegacyStrictCountsEslint(root)).toThrow("Install ESLint in packages/legacy-strict-counts-s3");
    executable('console.log(JSON.stringify({ cwd: process.cwd(), args: process.argv.slice(2) }));', true);
    expect(runLegacyStrictCountsEslint(root)).toEqual({ cwd: join(root, "packages/legacy-strict-counts-s3"), args: [".", "--format", "json", "--no-cache"] });
  });
});
