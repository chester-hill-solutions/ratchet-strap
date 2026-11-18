import { existsSync } from "node:fs";
import { applyMigration } from "./apply-migration.js";
import { loadReport } from "./commands.js";
import { writeBaseline } from "./io.js";
import { detectProjects, planMigration } from "./migration.js";
import { verifyMigration } from "./verify-migration.js";
import type { ReportOptions } from "./commands.js";
import type { MigrationProfile } from "./migration.js";

export function runAdoption(options: {
  command: "verify" | "migrate";
  root: string;
  profile?: string;
  from?: string;
  baseline?: string;
  write?: boolean;
  apply?: boolean;
  report: ReportOptions;
}) {
  function selectProfile(root: string, explicit?: string): MigrationProfile {
    if (explicit === "legacy-counts@1" || explicit === "legacy-identities@1" || explicit === "legacy-messages@1") return explicit;
    if (explicit) throw new Error(`Unsupported migration profile: ${explicit}`);
    const recognized = detectProjects(root).candidates.filter((candidate) => candidate.recognized);
    const profile = recognized.length === 1 ? recognized[0]?.profile : undefined;
    if (!profile) throw new Error("Automatic migration needs one recognized checker; select a supported --profile explicitly for a preview");
    return profile;
  }

  if (options.apply && options.write) throw new Error("Choose --apply for verified script migration or --write for baseline creation");
  const profile = selectProfile(options.root, options.profile);
  const plan = planMigration({ ...options, profile });
  if (options.command === "migrate" && !options.apply) {
    if (Object.values(options.report).some((value) => value !== undefined && value !== false)) {
      throw new Error("Runner/report flags on migrate require --apply; use verify for a read-only comparison");
    }
    if (options.write) writeBaseline(plan.target, plan.baseline, null);
    return { code: 0, output: { ...plan, written: Boolean(options.write), scriptsWritten: false } };
  }
  if (!plan.recognized) throw new Error("Verification requires an exact recognized legacy checker; inspect the migration preview for unsupported changes");
  if (options.report.eslintConfig !== undefined || options.report.cacheLocation !== undefined) {
    throw new Error("Verified adoption uses the legacy profile's fixed ESLint invocation; runner overrides are supported only on ordinary checks");
  }
  if (options.apply && existsSync(plan.target)) throw new Error("Verified migration requires a new target baseline; an existing target must not be overwritten");
  if (options.apply && !options.report.report && !options.report.execEslint) {
    throw new Error("migrate --apply requires --exec-eslint or an explicit fresh --report FILE");
  }
  const reports = loadReport(options.root, plan.baseline, options.report);
  const verified = verifyMigration({ root: options.root, profile, from: options.from, baseline: options.baseline, reports });
  if (options.command === "verify") return { code: verified.canApply ? 0 : 1, output: { ok: verified.canApply, ...verified } };
  if (!verified.canApply) return { code: 1, output: { ok: false, applied: false, ...verified } };
  const applied = applyMigration(verified, { root: options.root });
  return { code: 0, output: { ok: true, verification: verified, ...applied, scriptsWritten: true } };
}
