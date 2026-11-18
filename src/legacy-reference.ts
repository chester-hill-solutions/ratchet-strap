import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { MigrationProfile } from "./migration.js";
import { observeOperation } from "./telemetry.js";
import { referencePreload } from "./reference-preload.js";
import { legacyMessagesCheckerSha256 } from "./legacy-messages-types.js";
import { legacyMessagesMeasurementBaseline, parseLegacyMessagesMeasurement } from "./legacy-messages-reference.js";

export function containedProjectFile(root: string, file: string): string {
  const canonical = realpathSync(file);
  const rel = relative(root, canonical);
  if (isAbsolute(rel) || rel === ".." || rel.startsWith(`..${sep}`)) throw new Error(`Verification source is outside --root: ${file}`);
  if (!statSync(canonical).isFile()) throw new Error(`Verification source is not a file: ${file}`);
  return canonical;
}

export function collectLegacyIdentitiesSources(directory: string): string[] {
  const root = realpathSync(resolve(directory));
  const sources = new Set<string>();
  function collect(directory: string): void {
    const canonical = realpathSync(directory);
    const rel = relative(root, canonical);
    if (isAbsolute(rel) || rel === ".." || rel.startsWith(`..${sep}`)) throw new Error(`Verification source is outside --root: ${directory}`);
    if (lstatSync(directory).isSymbolicLink()) throw new Error(`Verification does not support a symlinked source directory: ${directory}`);
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const file = join(directory, entry.name);
      if (["node_modules", "build", ".react-router"].includes(entry.name)) continue;
      if (entry.isDirectory()) collect(file);
      else if (/\.(ts|tsx)$/.test(entry.name) && !entry.name.endsWith(".d.ts")) {
        if (entry.isSymbolicLink()) throw new Error(`Verification does not support a symlinked cycle source: ${file}`);
        sources.add(containedProjectFile(root, file));
      }
    }
  }
  collect(join(root, "app"));
  return [...sources].sort();
}

interface ReferenceOptions {
  root: string;
  profile: MigrationProfile;
  checker: string;
  baseline: string;
  reports: unknown;
  sources: string[];
  lintExitCode: 0 | 1;
}

export interface LegacyReference {
  passed: boolean;
  exitCode: number;
  stdout: string;
  stderr: string;
  measured: unknown;
}

export function runLegacyReference(options: ReferenceOptions): LegacyReference {
  return observeOperation("ratchet.reference", () => {
    const approved: Record<MigrationProfile, string> = {
      "legacy-counts@1": "904cac2837b6541ca71f56e89d76a2346a6b09edf17da8d7576cd0d4abdcbe3c",
      "legacy-identities@1": "7d9e1760329ad2015bccf5b65433171b74159d7379f45e72f188bd68763c6479",
      "legacy-messages@1": legacyMessagesCheckerSha256,
    };
    if (createHash("sha256").update(options.checker).digest("hex") !== approved[options.profile]) {
      throw new Error("Cannot execute an unrecognized checker snapshot");
    }
    const scratch = realpathSync(mkdtempSync(join(tmpdir(), "ratchet-strap-reference-")));
    try {
      const checker = join(scratch, "scripts/check-lint-ratchet.mjs");
      const scratchBaseline = join(scratch, "scripts/baselines/lint-ratchet.json");
      mkdirSync(dirname(scratchBaseline), { recursive: true });
      writeFileSync(checker, options.checker);
      writeFileSync(scratchBaseline, options.baseline);
      const preload = join(scratch, "reference.cjs");
      const configPath = join(scratch, "reference.json");
      const reportPath = join(scratch, "report.json");
      writeFileSync(preload, referencePreload);
      writeFileSync(reportPath, JSON.stringify(options.reports));
      const env: NodeJS.ProcessEnv = { ...process.env, RATCHET_STRAP_REFERENCE_CONFIG: configPath };
      delete env.NODE_OPTIONS;
      delete env.NODE_PATH;
      const executable = process.versions.bun ? "node" : process.execPath;
      const run = (measurement: boolean) => {
        writeFileSync(scratchBaseline, measurement && options.profile === "legacy-messages@1"
          ? legacyMessagesMeasurementBaseline() : options.baseline);
        writeFileSync(configPath, JSON.stringify({
          profile: options.profile, root: options.root, scratch, scratchBaseline,
          legacyBaseline: resolve(options.root, "scripts/baselines/lint-ratchet.json"),
          report: reportPath, sources: options.sources, lintExitCode: options.lintExitCode, measurement,
        }));
        const args = ["--require", preload, checker];
        if (measurement && options.profile !== "legacy-messages@1") args.push(options.profile === "legacy-counts@1" ? "--baseline" : "--write-baseline");
        const result = spawnSync(executable, args, {
          cwd: options.root, env, encoding: "utf8", maxBuffer: 64 * 1024 * 1024,
        });
        if (result.error || result.signal || result.status === null) {
          throw new Error(`Legacy reference execution failed: ${result.error?.message ?? result.signal ?? "no exit status"}`);
        }
        return result;
      };
      const gate = run(false);
      const measurement = run(true);
      if (measurement.status !== (options.profile === "legacy-messages@1" ? 1 : 0)) throw new Error(`Legacy measurement failed: ${measurement.stderr.slice(0, 4000)}`);
      return {
        passed: gate.status === 0, exitCode: gate.status ?? 2,
        stdout: gate.stdout.slice(0, 8000), stderr: gate.stderr.slice(0, 8000),
        measured: options.profile === "legacy-messages@1"
          ? parseLegacyMessagesMeasurement(measurement.stderr) : JSON.parse(readFileSync(scratchBaseline, "utf8")),
      };
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });
}
