import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync,
  readdirSync, realpathSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { applyMigration } from "./apply-migration.js";
import { legacyIdentitiesRuleIds } from "./identity-types.js";
import { planMigration } from "./migration.js";
import type { MigrationProfile } from "./migration.js";
import { commitMigrationFiles, withMigrationLock } from "./migration-transaction.js";
import { packageName, packageVersion } from "./package-meta.js";
import { checkBaseline, observeBaseline } from "./product.js";
import { collectVerificationControls } from "./verification-inputs.js";
import { collectProjectMembership } from "./verification-membership.js";
import type { MigrationVerification } from "./verification-types.js";

const fixtures = fileURLToPath(new URL("../fixtures/", import.meta.url));
let root: string;
let ownedRoot: string;
const sourcePath = () => join(root, "scripts/baselines/lint-ratchet.json");
const manifestPath = () => join(root, "package.json");
const targetPath = () => join(root, ".ratchet-strap.json");
const installedPath = () => join(root, "node_modules", ...packageName.split("/"));

function write(path: string, text: string, mode?: number): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text, mode === undefined ? undefined : { mode });
}

function digest(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function git(...args: string[]) {
  return spawnSync("git", ["-C", root, "-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false", ...args], {
    encoding: "utf8", env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" },
  });
}

function install(version = packageVersion): void {
  write(join(installedPath(), "package.json"), JSON.stringify({
    name: packageName, version, type: "module", exports: { ".": "./dist/index.js" },
    bin: { "ratchet-strap": "./dist/cli.js" },
  }));
  write(join(installedPath(), "dist/index.js"), "export {};\n");
  write(join(installedPath(), "dist/cli.js"), "#!/usr/bin/env node\nprocess.exit(0);\n", 0o755);
  const bin = join(root, "node_modules/.bin/ratchet-strap");
  mkdirSync(dirname(bin), { recursive: true });
  rmSync(bin, { force: true });
  symlinkSync(join(installedPath(), "dist/cli.js"), bin);
}

function setup(profile: MigrationProfile = "legacy-counts@1"): void {
  mkdirSync(join(root, "scripts/baselines"), { recursive: true });
  copyFileSync(join(fixtures, profile === "legacy-counts@1" ? "legacy-counts-check-lint-ratchet.mjs" : "legacy-identities-check-lint-ratchet.mjs"),
    join(root, "scripts/check-lint-ratchet.mjs"));
  const baseline = profile === "legacy-counts@1"
    ? { _comment: "Original budgets stay unchanged", counts: { "no-console": 3, complexity: 0 } }
    : { version: 4, ...Object.fromEntries(legacyIdentitiesRuleIds.map((rule) => [rule, []])) };
  write(sourcePath(), `${JSON.stringify(baseline, null, 4)}\n`);
  write(manifestPath(), JSON.stringify({
    name: "adoption-fixture", private: true, type: "module",
    scripts: {
      "ratchet:gate": "node ./scripts/check-lint-ratchet.mjs",
      "ratchet:lower": `node scripts/check-lint-ratchet.mjs ${profile === "legacy-counts@1" ? "--baseline" : "--write-baseline"}`,
      "ci:local": "npm run ratchet:gate && npm test",
      custom: "echo untouched",
    },
    dependencies: { other: "^1.2.3" }, devDependencies: { [packageName]: packageVersion },
    application: { unchanged: ["one", "two"] },
  }));
  write(join(root, "app/a.ts"), "export {};\n");
  install();
}

function verification(profile: MigrationProfile = "legacy-counts@1"): MigrationVerification {
  const plan = planMigration({ root, profile });
  const report = [{ filePath: join(root, "app/a.ts"), messages: [], suppressedMessages: [] }];
  const observed = observeBaseline(plan.baseline, report, root);
  const head = git("rev-parse", "--verify", "HEAD");
  return {
    plan, equivalent: true, canApply: true,
    legacy: { passed: true, exitCode: 0, counts: observed.counts, stdout: "passed", stderr: "" },
    current: checkBaseline(plan.baseline, observed), differences: [],
    projectFiles: collectProjectMembership(root, plan.target),
    snapshot: Object.fromEntries([
      manifestPath(), sourcePath(), join(root, "scripts/check-lint-ratchet.mjs"), join(root, "app/a.ts"),
      ...collectVerificationControls(root),
    ].map((path) => [path, digest(path)])),
    ...(head.status === 0 ? { gitHead: head.stdout.trim() } : {}),
    ...(profile === "legacy-identities@1" ? { cycleSources: [join(root, "app/a.ts")] } : {}),
  };
}

function unchanged(action: () => unknown, message?: string): void {
  const manifest = readFileSync(manifestPath(), "utf8");
  const source = readFileSync(sourcePath(), "utf8");
  if (message) expect(action).toThrow(message);
  else expect(action).toThrow();
  expect(readFileSync(manifestPath(), "utf8")).toBe(manifest);
  expect(readFileSync(sourcePath(), "utf8")).toBe(source);
  expect(existsSync(targetPath())).toBe(false);
  expect(existsSync(join(root, ".ratchet-strap-migration.lock"))).toBe(false);
}

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "ratchet-strap-apply-")));
  ownedRoot = root;
  setup();
});
afterEach(() => rmSync(ownedRoot, { recursive: true, force: true }));

describe("verified migration application", () => {
  test("replaces supported aliases while retaining unrelated manifest data and exact source bytes", () => {
    const proof = verification();
    const original = JSON.parse(readFileSync(manifestPath(), "utf8"));
    const source = readFileSync(sourcePath(), "utf8");
    const result = applyMigration(proof, { root });
    expect(result).toEqual({ baseline: targetPath(), manifest: manifestPath(), scripts: ["ratchet:gate", "ratchet:lower"], applied: true });
    const manifest = JSON.parse(readFileSync(manifestPath(), "utf8"));
    expect(manifest.scripts["ratchet:gate"]).toBe(proof.plan.scripts["ratchet:gate"]);
    expect(manifest.scripts["ratchet:lower"]).toBe(proof.plan.scripts["ratchet:lower"]);
    expect(manifest.scripts.custom).toBe(original.scripts.custom);
    expect(manifest.scripts["ci:local"]).toBe(original.scripts["ci:local"]);
    expect(manifest.dependencies).toEqual(original.dependencies);
    expect(manifest.devDependencies).toEqual(original.devDependencies);
    expect(manifest.application).toEqual(original.application);
    expect(JSON.parse(readFileSync(targetPath(), "utf8"))).toEqual(proof.plan.baseline);
    expect(readFileSync(sourcePath(), "utf8")).toBe(source);
    expect(existsSync(join(root, ".ratchet-strap-migration.lock"))).toBe(false);
    expect(readdirSync(root).filter((path) => path.endsWith(".tmp"))).toEqual([]);
  });

  test("preserves legacy identities identities and its legacy baseline", () => {
    setup("legacy-identities@1");
    const proof = verification("legacy-identities@1");
    const source = readFileSync(sourcePath(), "utf8");
    expect(applyMigration(proof, { root }).applied).toBe(true);
    const imported = JSON.parse(readFileSync(targetPath(), "utf8"));
    expect(imported.adapter).toBe("identities-cycles@1");
    expect(imported.identities).toEqual(Object.fromEntries(legacyIdentitiesRuleIds.map((rule) => [rule, []])));
    expect(readFileSync(sourcePath(), "utf8")).toBe(source);
  });

  test("retains manifest indentation, CRLF, trailing newline, and mode", () => {
    const input = JSON.parse(readFileSync(manifestPath(), "utf8"));
    writeFileSync(manifestPath(), `${JSON.stringify(input, null, "\t").replaceAll("\n", "\r\n")}\r\n`);
    chmodSync(manifestPath(), 0o660);
    applyMigration(verification(), { root });
    const result = readFileSync(manifestPath(), "utf8");
    expect(result).toContain('\r\n\t"scripts"');
    expect(result.endsWith("\r\n")).toBe(true);
    expect(result.replaceAll("\r\n", "")).not.toContain("\n");
    expect(lstatSync(manifestPath()).mode & 0o777).toBe(0o660);
  });

  test("can derive an unambiguous root from the snapshotted project manifest", () => {
    expect(applyMigration(verification()).applied).toBe(true);
  });

  for (const state of ["mismatch", "cannot apply", "unknown", "legacy failed", "current failed", "differences"] as const) {
    test(`refuses ${state} verification without writes`, () => {
      const proof = verification();
      if (state === "mismatch") proof.equivalent = false;
      if (state === "cannot apply") proof.canApply = false;
      if (state === "unknown") proof.plan.recognized = false;
      if (state === "legacy failed") { proof.legacy.passed = false; proof.legacy.exitCode = 1; }
      if (state === "current failed") proof.current.ok = false;
      if (state === "differences") proof.differences.push("counts differ");
      unchanged(() => applyMigration(proof, { root }));
    });
  }

  for (const file of ["package.json", "scripts/baselines/lint-ratchet.json", "scripts/check-lint-ratchet.mjs", "app/a.ts"]) {
    test(`refuses changed ${file}`, () => {
      const proof = verification();
      const path = join(root, file);
      writeFileSync(path, `${readFileSync(path, "utf8")}\n`);
      unchanged(() => applyMigration(proof, { root }));
    });
  }

  test("requires snapshots for all fixed inputs", () => {
    const proof = verification();
    delete proof.snapshot[manifestPath()];
    unchanged(() => applyMigration(proof, { root }));
  });

  for (const file of ["eslint.config.mjs", "bun.lock"]) {
    test(`refuses changed snapshotted ${file}`, () => {
      const path = join(root, file);
      writeFileSync(path, file.endsWith(".mjs") ? "export default [];\n" : "original lock bytes\n");
      const proof = verification();
      expect(Object.hasOwn(proof.snapshot, path)).toBe(true);
      writeFileSync(path, `${readFileSync(path, "utf8")}\n`);
      unchanged(() => applyMigration(proof, { root }));
    });
  }

  test("a newly introduced higher-priority ESLint configuration invalidates verification", () => {
    writeFileSync(join(root, "eslint.config.mjs"), "export default [];\n");
    const proof = verification();
    const added = join(root, "eslint.config.js");
    writeFileSync(added, "export default [{ rules: {} }];\n");
    expect(Object.hasOwn(proof.snapshot, added)).toBe(false);
    unchanged(() => applyMigration(proof, { root }));
    expect(readFileSync(added, "utf8")).toBe("export default [{ rules: {} }];\n");
  });

  test("rejects tampered baseline and custom script suggestions even with passing booleans", () => {
    const baseline = verification();
    if (baseline.plan.baseline.schemaVersion === 1) baseline.plan.baseline.counts["no-console"] = 99;
    unchanged(() => applyMigration(baseline, { root }));
    const scripts = verification();
    scripts.plan.scripts.custom = "echo replaced";
    unchanged(() => applyMigration(scripts, { root }));
  });

  test("an edited checker cannot be authorized by updating its snapshot digest", () => {
    const proof = verification();
    const path = join(root, "scripts/check-lint-ratchet.mjs");
    writeFileSync(path, `${readFileSync(path, "utf8")}\n// modified checker\n`);
    proof.snapshot[path] = digest(path);
    unchanged(() => applyMigration(proof, { root }));
  });

  test("rejects an existing target, including a dangling symlink", () => {
    const proof = verification();
    writeFileSync(targetPath(), "another writer\n");
    expect(() => applyMigration(proof, { root })).toThrow("already exists");
    expect(readFileSync(targetPath(), "utf8")).toBe("another writer\n");
    unlinkSync(targetPath());
    symlinkSync(join(root, "missing.json"), targetPath());
    expect(() => applyMigration(proof, { root })).toThrow("already exists");
    expect(lstatSync(targetPath()).isSymbolicLink()).toBe(true);
  });

  test("refuses a manifest symlink without editing its target", () => {
    const proof = verification();
    const other = join(root, "other-manifest.json");
    renameSync(manifestPath(), other);
    symlinkSync(other, manifestPath());
    const original = readFileSync(other, "utf8");
    expect(() => applyMigration(proof, { root })).toThrow("symlink");
    expect(readFileSync(other, "utf8")).toBe(original);
    expect(existsSync(targetPath())).toBe(false);
  });

  test("refuses custom source paths, source/target collisions, and paths outside root", () => {
    const custom = verification();
    copyFileSync(sourcePath(), join(root, "custom.json"));
    custom.plan.source = join(root, "custom.json");
    unchanged(() => applyMigration(custom, { root }));
    const collision = verification();
    collision.plan.target = sourcePath();
    unchanged(() => applyMigration(collision, { root }));
    const outside = verification();
    outside.plan.target = join(root, "..", "ratchet-strap-apply-outside.json");
    unchanged(() => applyMigration(outside, { root }));
  });

  for (const condition of ["missing", "wrong version", "missing bin", "nonexecutable bin"] as const) {
    test(`refuses an installed package with ${condition}`, () => {
      const proof = verification();
      if (condition === "missing") rmSync(installedPath(), { recursive: true });
      if (condition === "wrong version") install("999.0.0");
      if (condition === "missing bin") rmSync(join(installedPath(), "dist/cli.js"));
      if (condition === "nonexecutable bin") chmodSync(join(installedPath(), "dist/cli.js"), 0o644);
      unchanged(() => applyMigration(proof, { root }));
    });
  }

  test("changed Git HEAD prevents application", () => {
    expect(git("init", "--quiet").status).toBe(0);
    expect(git("add", "package.json").status).toBe(0);
    const commit = (...args: string[]) => git("-c", "user.name=RatchetStrap fixture", "-c", "user.email=fixture@example.invalid", "commit", "--quiet", ...args);
    expect(commit("-m", "Initial manifest").status).toBe(0);
    const proof = verification();
    expect(commit("--allow-empty", "-m", "New HEAD").status).toBe(0);
    unchanged(() => applyMigration(proof, { root }));
  });

  test("new legacy identities cycle inputs invalidate verification", () => {
    setup("legacy-identities@1");
    const proof = verification("legacy-identities@1");
    write(join(root, "app/new.ts"), "export {};\n");
    unchanged(() => applyMigration(proof, { root }));
  });

  for (const profile of ["legacy-counts@1", "legacy-identities@1"] as const) {
    test(`a new JavaScript source invalidates ${profile} project membership`, () => {
      if (profile === "legacy-identities@1") setup(profile);
      const proof = verification(profile);
      write(join(root, "app/new.js"), "console.log('new source');\n");
      unchanged(() => applyMigration(proof, { root }), "membership changed");
    });
  }

  test("refuses a missing npm bin link despite a resolvable package", () => {
    const proof = verification();
    unlinkSync(join(root, "node_modules/.bin/ratchet-strap"));
    unchanged(() => applyMigration(proof, { root }), "npm script executable");
  });

  test("refuses an extraneously installed package without a dependency declaration", () => {
    const manifest = JSON.parse(readFileSync(manifestPath(), "utf8"));
    delete manifest.devDependencies[packageName];
    writeFileSync(manifestPath(), JSON.stringify(manifest));
    unchanged(() => applyMigration(verification(), { root }), "as a project dependency");
  });

  test("refuses a wrong npm bin target despite a resolvable package", () => {
    const wrong = join(root, "node_modules/wrong-cli");
    write(wrong, "#!/usr/bin/env node\nprocess.exit(99);\n", 0o755);
    const bin = join(root, "node_modules/.bin/ratchet-strap");
    unlinkSync(bin);
    symlinkSync(wrong, bin);
    unchanged(() => applyMigration(verification(), { root }), "npm script executable");
  });

  test("a nearer npm bin cannot shadow the verified ancestor package executable", () => {
    root = join(ownedRoot, "project");
    mkdirSync(root);
    setup();
    rmSync(installedPath(), { recursive: true });
    const wrong = join(root, "node_modules/shadow-cli");
    write(wrong, "#!/usr/bin/env node\nprocess.exit(99);\n", 0o755);
    const bin = join(root, "node_modules/.bin/ratchet-strap");
    unlinkSync(bin);
    symlinkSync(wrong, bin);
    unchanged(() => applyMigration(verification(), { root }), "npm script executable");
  });

  test("accepts an ancestor package and bin when no nearer executable shadows it", () => {
    root = join(ownedRoot, "project");
    mkdirSync(root);
    setup();
    rmSync(installedPath(), { recursive: true });
    unlinkSync(join(root, "node_modules/.bin/ratchet-strap"));
    expect(applyMigration(verification(), { root }).applied).toBe(true);
  });

  test("preserves another process's project lock", () => {
    const proof = verification();
    const lock = join(root, ".ratchet-strap-migration.lock");
    writeFileSync(lock, "other writer\n");
    expect(() => applyMigration(proof, { root })).toThrow();
    expect(readFileSync(lock, "utf8")).toBe("other writer\n");
    expect(existsSync(targetPath())).toBe(false);
  });
});

describe("migration transaction ownership and rollback", () => {
  test("an actual manifest rename failure removes only the baseline it created", () => {
    const original = readFileSync(manifestPath(), "utf8");
    let checks = 0;
    expect(() => commitMigrationFiles({
      baseline: targetPath(), manifest: manifestPath(), baselineText: "new baseline\n", manifestText: "new manifest\n", manifestMode: 0o644,
      assertFresh: () => {
        if (++checks === 2) {
          renameSync(manifestPath(), join(root, "manifest-backup.json"));
          mkdirSync(manifestPath());
        }
      },
    })).toThrow();
    expect(existsSync(targetPath())).toBe(false);
    expect(lstatSync(manifestPath()).isDirectory()).toBe(true);
    expect(readFileSync(join(root, "manifest-backup.json"), "utf8")).toBe(original);
    expect(readdirSync(root).filter((path) => path.endsWith(".tmp"))).toEqual([]);
  });

  test("a baseline created by another writer wins the exclusive creation race", () => {
    const original = readFileSync(manifestPath(), "utf8");
    expect(() => commitMigrationFiles({
      baseline: targetPath(), manifest: manifestPath(), baselineText: "ours\n", manifestText: "new manifest\n", manifestMode: 0o644,
      assertFresh: () => writeFileSync(targetPath(), "other writer\n"),
    })).toThrow();
    expect(readFileSync(targetPath(), "utf8")).toBe("other writer\n");
    expect(readFileSync(manifestPath(), "utf8")).toBe(original);
  });

  test("a concurrent modification of the created baseline is preserved on rollback", () => {
    const original = readFileSync(manifestPath(), "utf8");
    let checks = 0;
    expect(() => commitMigrationFiles({
      baseline: targetPath(), manifest: manifestPath(), baselineText: "ours\n", manifestText: "new manifest\n", manifestMode: 0o644,
      assertFresh: () => { if (++checks === 2) writeFileSync(targetPath(), "other writer's changes\n"); },
    })).toThrow("changed before manifest commit");
    expect(readFileSync(targetPath(), "utf8")).toBe("other writer's changes\n");
    expect(readFileSync(manifestPath(), "utf8")).toBe(original);
  });

  test("lock cleanup never deletes a replacement lock owned by another writer", () => {
    const lock = join(root, ".ratchet-strap-migration.lock");
    withMigrationLock(root, () => { unlinkSync(lock); writeFileSync(lock, "replacement lock\n"); });
    expect(readFileSync(lock, "utf8")).toBe("replacement lock\n");
  });

  test("lock cleanup preserves another writer's replacement token even on the same inode", () => {
    const lock = join(root, ".ratchet-strap-migration.lock");
    withMigrationLock(root, () => writeFileSync(lock, "replacement token\n"));
    expect(readFileSync(lock, "utf8")).toBe("replacement token\n");
  });
});
