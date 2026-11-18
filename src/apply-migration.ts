import { createHash } from "node:crypto";
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { collectLegacyIdentitiesSources } from "./legacy-reference.js";
import { planMigration } from "./migration.js";
import { commitMigrationFiles, withMigrationLock } from "./migration-transaction.js";
import { createMigrationEnvironment } from "./migration-environment.js";
import { observeOperation } from "./telemetry.js";
import { record } from "./validation.js";
import { collectVerificationControls } from "./verification-inputs.js";
import { collectProjectMembership } from "./verification-membership.js";
import type { MigrationVerification } from "./verification-types.js";

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b, "en")).map(([key, item]) => `${JSON.stringify(key)}:${stable(item)}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "undefined";
}

function formatManifest(original: string, manifest: Record<string, unknown>): string {
  const newline = original.includes("\r\n") ? "\r\n" : "\n";
  const pretty = original.trimEnd().includes("\n");
  const indentation = pretty ? original.match(/(?:^|\r?\n)([ \t]+)"/)?.[1] ?? 2 : undefined;
  const text = JSON.stringify(manifest, null, indentation).replaceAll("\n", newline);
  return text + (original.endsWith("\n") ? newline : "");
}

export function applyMigration(verification: MigrationVerification, options: { root?: string } = {}): {
  baseline: string;
  manifest: string;
  scripts: string[];
  applied: true;
} {
  return observeOperation("ratchet.apply", () => {
    function projectRoot(verification: MigrationVerification, supplied?: string): string {
      if (supplied) return realpathSync(resolve(supplied));
      const manifests = Object.keys(verification.snapshot).filter((path) => basename(path) === "package.json");
      if (manifests.length !== 1 || !manifests[0]) throw new Error("An explicit migration root is required");
      return realpathSync(dirname(manifests[0]));
    }

    if (verification.plan.profile === "legacy-messages@1" && verification.lintPassed !== true) {
      throw new Error("LegacyMessages adoption requires the preceding standalone ESLint gate to pass");
    }
    if (!verification.equivalent || !verification.canApply || !verification.plan.recognized
      || !verification.legacy.passed || verification.legacy.exitCode !== 0 || !verification.current.ok
      || !verification.current.canTighten || verification.current.errors.length || verification.current.regressions.length
      || Object.keys(verification.current.baselineGrowth).length || verification.differences.length
      || (verification.current.mode === "identities"
        && (Object.keys(verification.current.added).length || Object.keys(verification.current.stale).length))) {
      throw new Error("Migration requires equivalent, passing legacy and current verification results");
    }
    const root = projectRoot(verification, options.root);
    const environment = createMigrationEnvironment(root);
    const manifest = join(root, "package.json");
    if (lstatSync(manifest).isSymbolicLink()) throw new Error("Migration package.json must not be a symlink");
    environment.existingFile(manifest);
    const source = environment.existingFile(resolve(root, verification.plan.source));
    if (source !== join(root, "scripts/baselines/lint-ratchet.json")) {
      throw new Error("Verified migration requires the recognized default legacy baseline path");
    }
    const target = resolve(root, verification.plan.target);
    if (source === target) throw new Error("Migration target must differ from the legacy baseline source");
    const checker = environment.existingFile(join(root, "scripts/check-lint-ratchet.mjs"));
    for (const required of [manifest, checker, source]) {
      if (!Object.hasOwn(verification.snapshot, required)) throw new Error(`Migration verification is missing an input snapshot: ${required}`);
    }
    const assertFresh = (ownedTemporary: readonly string[] = []) => {
      if (lstatSync(manifest).isSymbolicLink()) throw new Error("Migration package.json must not be a symlink");
      if (!verification.projectFiles
        || stable(collectProjectMembership(root, target, ownedTemporary)) !== stable(verification.projectFiles)) {
        throw new Error("Project file membership changed since migration verification");
      }
      for (const path of collectVerificationControls(root)) {
        if (!Object.hasOwn(verification.snapshot, path)) {
          throw new Error(`Migration verification is missing a current configuration snapshot: ${path}`);
        }
      }
      for (const [path, expected] of Object.entries(verification.snapshot)) {
        if (!isAbsolute(path) || !/^[a-f0-9]{64}$/.test(expected)) throw new Error("Invalid migration input snapshot");
        environment.existingFile(path);
        const actual = createHash("sha256").update(readFileSync(path)).digest("hex");
        if (actual !== expected) throw new Error(`Migration input changed since verification: ${path}`);
      }
      if (environment.gitHead() !== verification.gitHead) throw new Error("Migration Git HEAD changed since verification");
      if (verification.plan.profile === "legacy-identities@1") {
        if (!verification.cycleSources) throw new Error("legacy identities verification is missing its cycle-source snapshot");
        if (verification.cycleSources.some((path) => !Object.hasOwn(verification.snapshot, path))) {
          throw new Error("legacy identities cycle sources must have byte snapshots");
        }
        const current = collectLegacyIdentitiesSources(root);
        if (stable([...current].sort()) !== stable([...verification.cycleSources].sort())) {
          throw new Error("legacy identities cycle-source membership changed since verification");
        }
      }
    };
    return withMigrationLock(root, () => {
      environment.targetFile(target);
      assertFresh();
      environment.installedPackage(manifest);
      const fresh = planMigration({ root, profile: verification.plan.profile, from: source, baseline: target });
      if (!fresh.recognized || stable(fresh.baseline) !== stable(verification.plan.baseline)
        || stable(fresh.scripts) !== stable(verification.plan.scripts)) {
        throw new Error("Migration plan no longer matches the recognized baseline and supported script aliases");
      }
      if (Object.keys(fresh.scripts).length === 0) throw new Error("Migration has no supported script aliases to replace");
      const original = readFileSync(manifest, "utf8");
      const input = record(JSON.parse(original), "Project package.json");
      const scripts = input.scripts === undefined ? {} : record(input.scripts, "Project package.json scripts");
      const next = { ...input, scripts: { ...scripts, ...fresh.scripts } };
      commitMigrationFiles({
        baseline: target, manifest,
        baselineText: `${JSON.stringify(fresh.baseline, null, 2)}\n`,
        manifestText: formatManifest(original, next),
        manifestMode: lstatSync(manifest).mode & 0o777,
        assertFresh,
      });
      return { baseline: target, manifest, scripts: Object.keys(fresh.scripts), applied: true };
    });
  });
}
