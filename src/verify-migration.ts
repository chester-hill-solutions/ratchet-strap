import { createHash } from "node:crypto";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { resolve } from "node:path";
import { importLegacyCountsBaseline } from "./baseline.js";
import { parseEslintReports } from "./eslint-report.js";
import { importLegacyIdentitiesBaseline } from "./identity.js";
import { collectLegacyIdentitiesSources, containedProjectFile, runLegacyReference } from "./legacy-reference.js";
import { planMigration } from "./migration.js";
import type { MigrationProfile } from "./migration.js";
import { readLegacyIdentitiesPredecessor } from "./predecessor.js";
import { checkBaseline, observeBaseline } from "./product.js";
import { record } from "./validation.js";
import { collectVerificationControls } from "./verification-inputs.js";
import { collectProjectMembership } from "./verification-membership.js";
import { importLegacyMessagesBaseline } from "./legacy-messages.js";
import { createMigrationEnvironment } from "./migration-environment.js";
import { observeOperation } from "./telemetry.js";
import type { MigrationVerification } from "./verification-types.js";

export function verifyMigration(options: {
  root: string;
  profile: MigrationProfile;
  from?: string;
  baseline?: string;
  reports: unknown;
}): MigrationVerification {
  return observeOperation("ratchet.verify", () => {
    function snapshot(paths: Iterable<string>): Record<string, string> {
      return Object.fromEntries([...new Set(paths)].sort().map((file) => [
        file, createHash("sha256").update(readFileSync(file)).digest("hex"),
      ]));
    }

    const root = realpathSync(resolve(options.root));
    const environment = createMigrationEnvironment(root);
    const source = containedProjectFile(root, resolve(root, options.from ?? "scripts/baselines/lint-ratchet.json"));
    const expectedSource = containedProjectFile(root, resolve(root, "scripts/baselines/lint-ratchet.json"));
    if (source !== expectedSource) throw new Error("Automatic verification requires the default legacy baseline source; custom sources are preview/import only");
    if (expectedSource !== resolve(root, "scripts/baselines/lint-ratchet.json")) throw new Error("Automatic verification requires an unsymlinked default legacy baseline to preserve its Git history path");
    const checkerPath = containedProjectFile(root, resolve(root, "scripts/check-lint-ratchet.mjs"));
    const manifestPath = resolve(root, "package.json");
    const manifest = existsSync(manifestPath) ? containedProjectFile(root, manifestPath) : undefined;
    const plan = planMigration({ ...options, root, from: source });
    if (!plan.recognized) throw new Error("Cannot verify an unrecognized checker fingerprint; no project code was executed");
    const files = parseEslintReports(options.reports, { root, requireSuppressed: options.profile === "legacy-identities@1" });
    const reportedSources = files.map((file) => containedProjectFile(root, resolve(root, file.filePath)));
    const cycleSources = options.profile === "legacy-identities@1" ? collectLegacyIdentitiesSources(root) : undefined;
    const sources = [...new Set([...reportedSources, ...(cycleSources ?? [])])];
    const controls = collectVerificationControls(root);
    const projectFiles = collectProjectMembership(root, plan.target);
    const inputs = [checkerPath, source, ...sources, ...controls, ...(manifest ? [manifest] : [])];
    const before = snapshot(inputs);
    const head = environment.gitHead();
    const checker = readFileSync(checkerPath, "utf8");
    const baseline = readFileSync(source, "utf8");
    if (createHash("sha256").update(checker).digest("hex") !== before[checkerPath]
      || createHash("sha256").update(baseline).digest("hex") !== before[source]) {
      throw new Error("Verification inputs changed before reference execution");
    }
    const imported = options.profile === "legacy-counts@1"
      ? importLegacyCountsBaseline(JSON.parse(baseline)) : options.profile === "legacy-messages@1"
        ? importLegacyMessagesBaseline(JSON.parse(baseline)) : importLegacyIdentitiesBaseline(JSON.parse(baseline));
    if (JSON.stringify(imported) !== JSON.stringify(plan.baseline)) throw new Error("Legacy baseline changed while planning verification");
    const lintPassed = !files.some((file) => file.messages.some((message) => message.severity === 2));
    const reference = runLegacyReference({
      root, profile: options.profile, checker, baseline,
      reports: options.reports, sources, lintExitCode: lintPassed ? 0 : 1,
    });
    const observed = observeBaseline(plan.baseline, options.reports, root);
    const previous = options.profile === "legacy-identities@1"
      ? readLegacyIdentitiesPredecessor(root, plan.target, source).baseline : undefined;
    const current = checkBaseline(plan.baseline, observed, previous);
    const measured = record(reference.measured, "Legacy observation");
    const counts: Record<string, number> = {};
    const differences: string[] = [];
    let identities: Record<string, string[]> | undefined;
    if (options.profile === "legacy-identities@1") {
      identities = importLegacyIdentitiesBaseline(measured).identities;
      for (const [ruleId, entries] of Object.entries(identities)) {
        counts[ruleId] = entries.length;
        if (!("identities" in observed)
          || JSON.stringify([...entries].sort()) !== JSON.stringify([...(observed.identities[ruleId] ?? [])].sort())) {
          differences.push(`Observed identities differ for ${ruleId}`);
        }
      }
    } else {
      const measuredCounts = record(measured.counts, "Legacy observed counts");
      for (const [ruleId, now] of Object.entries(observed.counts)) {
        const legacyCount = measuredCounts[ruleId] ?? 0;
        if (!Number.isSafeInteger(legacyCount) || typeof legacyCount !== "number" || legacyCount < 0) throw new Error(`Invalid legacy observation count for ${ruleId}`);
        counts[ruleId] = legacyCount;
        if (legacyCount !== now) differences.push(`Observed counts differ for ${ruleId}: legacy ${legacyCount}, RatchetStrap ${now}`);
      }
    }
    if (reference.passed !== current.ok) differences.push(`Gate outcomes differ: legacy ${reference.passed ? "pass" : "fail"}, RatchetStrap ${current.ok ? "pass" : "fail"}`);
    const after = snapshot(inputs);
    if (JSON.stringify(before) !== JSON.stringify(after) || environment.gitHead() !== head) throw new Error("Verification inputs changed during comparison; rerun against a stable source tree");
    if (JSON.stringify(controls) !== JSON.stringify(collectVerificationControls(root))) throw new Error("Verification configuration or lockfile membership changed during comparison");
    if (cycleSources && JSON.stringify(cycleSources) !== JSON.stringify(collectLegacyIdentitiesSources(root))) throw new Error("legacy identities source membership changed during comparison");
    if (JSON.stringify(projectFiles) !== JSON.stringify(collectProjectMembership(root, plan.target))) throw new Error("Project file membership changed during comparison; rerun against a stable source tree");
    const equivalent = differences.length === 0;
    return {
      plan, equivalent, canApply: equivalent && reference.passed && current.ok && plan.recognized && lintPassed,
      lintPassed,
      legacy: { passed: reference.passed, exitCode: reference.exitCode, counts, identities, stdout: reference.stdout, stderr: reference.stderr },
      current, differences, snapshot: before, projectFiles, ...(head ? { gitHead: head } : {}), ...(cycleSources ? { cycleSources } : {}),
    };
  });
}
