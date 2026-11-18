/**
 * The ratchet decision, in one place.
 *
 * A ratchet gate counts a class of violation, compares it to a checked-in baseline,
 * and fails only when a count goes up. The point is that existing debt is frozen
 * rather than forgiven: every baseline entry is a whittle-me-down invitation, and no
 * new one may be added.
 *
 * This is the **union** of two implementations that disagreed, not a copy of either.
 * What each contributed, and what the disagreement was:
 *
 *   - this repository carried the 28-line policy (load baseline, refuse to raise,
 *     fail on growth, fail on an unrecorded improvement) written out by hand four
 *     times, in four scripts, with no test.
 *   - a consumer repository carried the richer instrument (per-rule baselines,
 *     comment stripping, `file:line` per match) and two holes in it, each of which
 *     is the same failure this repository just paid to fix at directory level: a
 *     listing helper that returns `[]` for a missing directory, and an `--update`
 *     that rewrites the baseline with no comparison against the old one — so it
 *     raises the floor and reports success.
 *
 * Two design points that came from the failure rather than from either source:
 *
 *   - `--update` may never raise a floor. Not even one rule at a time. A baseline
 *     rewritten upward to absorb a regression is a gate that has been turned off
 *     while still printing the word "baseline".
 *   - a reduction is a failure too, deliberately. A floor that stays put after the
 *     floor is met is a floor that stops describing anything, and lowering it is
 *     the only way the next regression is caught.
 *
 * A gate that has quietly stopped rejecting new debt is worse than no gate, because
 * the debt is still described as baselined. `compareCounts` is pure so the policy can
 * be asserted directly rather than inferred from four scripts that happen to exit
 * non-zero on whatever tree happened to be checked out.
 *
 * Deliberately free of any repository-specific path, rule, or file extension, so that
 * publishing this later is a copy rather than a rewrite. Callers pass in every path,
 * every scan root, and every rule.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";

import { ScanRootError } from "./scan.mjs";

/** The flag every guard takes to rewrite its baseline. One spelling, so it can be taught. */
export const UPDATE_FLAG = "--update";

/** Directories whose contents are never a source file. */
const DEFAULT_SKIP_DIRS = new Set([
  "node_modules",
  "dist",
  "build",
  "coverage",
  ".git",
  "vendor",
  "archive",
  "generated",
]);

const DEFAULT_SKIP_FILES = [/\.test\.tsx?$/, /\.spec\.tsx?$/, /\.d\.ts$/];

/**
 * List source files under `dirs`, skipping vendored, built and test paths.
 *
 * **Fail-closed**, unlike the version this was unioned from, which returned quietly
 * for a directory that did not exist. A guard cannot report a result over a path it
 * did not read: a missing root silently yields `[]`, and `[]` is exactly what a clean
 * gate reports. That is not a near-miss — a probe planted in a directory a guard is
 * *meant* to scan still reported zero and exited 0.
 *
 * @param {string} root absolute repository root, used only to compute relative paths
 * @param {string[]} dirs directories relative to `root`
 */
export function sourceFiles(root, dirs, options = {}) {
  const skipDirs = options.skipDirs ?? DEFAULT_SKIP_DIRS;
  const skipFiles = options.skipFiles ?? DEFAULT_SKIP_FILES;
  const exts = options.extensions ?? [".ts", ".tsx", ".mjs", ".js"];

  const out = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!skipDirs.has(entry.name)) walk(full);
      } else if (exts.some((ext) => entry.name.endsWith(ext))) {
        if (!skipFiles.some((re) => re.test(full))) out.push(full);
      }
    }
  };

  for (const rel of dirs) {
    const full = resolve(root, rel);
    if (!existsSync(full)) {
      throw new ScanRootError(full, "it does not exist");
    }
    walk(full);
  }
  return out;
}

/**
 * Read a file for a rule to match against.
 *
 * **Throws.** The version this was unioned from returned `""` for an unreadable file,
 * which is the same false zero one level down: an empty string matches nothing, so a
 * file that could not be read reported as a file with no violations.
 */
export function readSource(file) {
  return readFileSync(file, "utf8");
}

/**
 * Blank out comments, preserving line numbering, so a rule named in prose is not
 * counted as a violation of it. String contents are left alone — a violation inside a
 * string is rare enough that losing it is the cheaper error.
 */
export function stripComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, (block) => block.replace(/[^\n]/g, " "))
    .replace(/(^|[^:])\/\/[^\n]*/g, (_match, prefix) => prefix);
}

/**
 * Count each named rule.
 *
 * A rule is either a pattern, matched by `count`, or a function that does its own
 * matching. The second form exists because not every violation is a grep away: a guard
 * that has to look at a construct spanning several lines has to read the file, and
 * forcing such a guard through a line regex would hand it a worse instrument on the
 * way to a shared one.
 *
 * Rules are counted in the order given and every rule is counted, so a rule that
 * throws cannot be skipped by an early return in a caller.
 *
 * @param {Array<{name: string, count?: () => number}>} rules
 * @param {(rule: {name: string}) => number} count
 * @returns {Record<string, number>} every rule present, zero if it matched nothing
 */
export function countByRule(rules, count) {
  const counts = {};
  for (const rule of rules) {
    counts[rule.name] = rule.count ? rule.count() : count(rule);
  }
  return counts;
}

/** Read a per-rule baseline. An absent baseline is an empty one, and every rule reads 0. */
export function loadBaseline(baselinePath) {
  if (!existsSync(baselinePath)) return { exists: false, counts: {} };

  const raw = readFileSync(baselinePath, "utf8").trim();
  if (raw === "") return { exists: true, counts: {} };

  // A bare integer is the single-count format this file replaced. Saying so is more
  // useful than a JSON parse error, and more useful than silently reading it as a
  // set of rule names.
  if (/^\d+$/.test(raw)) {
    throw new Error(
      `${baselinePath} holds a single count (${raw}), not per-rule counts.\n` +
        `  Re-establish it with the guard's update flag; the rules are named in the script that owns it.`,
    );
  }

  const parsed = JSON.parse(raw);
  return { exists: true, counts: parsed.counts ?? stripCommentKey(parsed) };
}

/** Serialise per-rule counts. The comment is kept as a `_comment` key, not in a header. */
export function writeBaseline(baselinePath, counts, comment) {
  mkdirSync(dirname(baselinePath), { recursive: true });
  const body = comment ? { _comment: comment, ...counts } : counts;
  writeFileSync(baselinePath, `${JSON.stringify(body, null, 2)}\n`, "utf8");
}

/**
 * Compare per-rule counts to a baseline.
 *
 * A rule missing from the baseline counts as 0, so introducing a rule to a gate that
 * already has one is a visible event rather than a free addition — a rule added
 * alongside debt it already matches fails immediately, which is the point.
 *
 * @returns {{regressions: Array<{rule: string, before: number, after: number}>,
 *            improvements: Array<{rule: string, before: number, after: number}>}}
 */
export function compareCounts(counts, baseline) {
  const regressions = [];
  const improvements = [];

  for (const [rule, after] of Object.entries(counts)) {
    const before = baseline[rule] ?? 0;
    if (after > before) regressions.push({ rule, before, after });
    else if (after < before) improvements.push({ rule, before, after });
  }

  // A baseline entry with no rule of the same name measures nothing. Without this check,
  // deleting a rule from a guard stops enforcing it while the baseline file still
  // describes the debt as baselined. That is a regression the counts cannot see, because
  // the counts come from the rules that remain.
  const unmeasured = Object.keys(baseline).filter(
    (rule) => rule !== "_comment" && !Object.prototype.hasOwnProperty.call(counts, rule),
  );

  return { regressions, improvements, unmeasured };
}

/** Lines to show under a failure, and the policy stated once instead of four times. */
function report({ name, unit, regressions, improvements, unmeasured = [], baselinePath, updateFlag, fix }) {
  const where = relative(process.cwd(), baselinePath) || baselinePath;
  const out = [
    `[${name}] the ratchet only moves one way.`,
    "",
    ...regressions.map((r) => `  ${r.rule}: ${r.before} -> ${r.after} (+${r.after - r.before})`),
    ...unmeasured.map((rule) => `  ${rule}: the guard has no rule of this name, so nothing measured it`),
  ];

  if (improvements.length > 0) {
    out.push(
      "",
      `  ${improvements.length} ${unit} below the baseline but not yet recorded:`,
      ...improvements.map((i) => `  ${i.rule}: ${i.before} -> ${i.after}`),
    );
  }

  out.push("", fix, "", `Baseline: ${where} (rewrite: pass ${updateFlag}).`);
  out.push(
    "Rewrite it only to lock in an improvement, never to absorb a regression — raising a baseline",
    "turns the gate off while still printing the word.",
  );

  return out.join("\n");
}

/**
 * Gate on one rule set. Counts, compares, and exits non-zero with one explanation.
 *
 * Callers pass a `count` function rather than counts so that the work happens after
 * the arguments are known to be sound, and so a caller cannot accidentally gate on a
 * count it computed a second way.
 *
 * @param {object} spec
 * @param {string} spec.name          guard name, for the failure line
 * @param {Array} spec.rules          rules, passed to countByRule
 * @param {(rule: {name: string}) => number} spec.count
 * @param {string} spec.baselinePath  absolute path to the JSON baseline
 * @param {string} [spec.comment]     written into the baseline as `_comment`
 * @param {string} spec.unit          what is being counted, for the message
 * @param {string} spec.fix           what the reader should do about it
 * @param {boolean} [spec.update]     rewrite the baseline instead of gating
 * @returns {number} process exit code
 */
export function gate(spec) {
  const {
    name,
    rules,
    count,
    baselinePath,
    comment,
    unit = "violation",
    fix,
    update = process.argv.includes(UPDATE_FLAG),
  } = spec;

  const counts = countByRule(rules, count);
  const total = Object.values(counts).reduce((a, n) => a + n, 0);
  const { exists, counts: baseline } = loadBaseline(baselinePath);
  const { regressions, improvements, unmeasured } = compareCounts(counts, baseline);

  // Establishing a first baseline is allowed; it is the documented first step and the
  // gate fails loudly without one. Lowering is allowed, because that is the whole
  // mechanism. Raising is not, from any direction. Every entry of `regressions` already
  // raised its count, so the set needs no second filter.

  if (update) {
    if (exists && (regressions.length > 0 || unmeasured.length > 0)) {
      console.error(
        report({
          name,
          unit,
          regressions,
          improvements: [],
          unmeasured,
          baselinePath,
          updateFlag: UPDATE_FLAG,
          fix,
        }),
      );
      console.error(
        `\nIf ${regressions.map((r) => r.rule).join(", ")} is pre-existing debt rather than a regression,`,
        "add it to the baseline by hand with a reason. A hand-written entry is visible in the",
        "diff; one written by this flag is not.",
      );
      return 1;
    }
    writeBaseline(baselinePath, counts, comment);
    console.log(
      `[${name}] baseline set to ${total} ${unit} across ${Object.keys(counts).length} rules` +
        `${exists ? " (lowered; improvements recorded)" : " (established)"}.`,
    );
    return 0;
  }

  if (!exists) {
    console.error(
      `[${name}] no baseline at ${relative(process.cwd(), baselinePath) || baselinePath}.\n` +
        `  Measured ${total} ${unit} across ${Object.keys(counts).length} rules.\n` +
        `  Establish it with ${UPDATE_FLAG} — once, having read the number first.`,
    );
    return 1;
  }

  if (regressions.length > 0 || unmeasured.length > 0) {
    console.error(
      report({ name, unit, regressions, improvements, unmeasured, baselinePath, updateFlag: UPDATE_FLAG, fix }),
    );
    return 1;
  }

  console.log(`[${name}] ${total} ${unit}, no growth versus baseline.`);
  for (const i of improvements) {
    console.log(`  improved: ${i.rule} ${i.before} -> ${i.after} (run with ${UPDATE_FLAG} to lock it in)`);
  }
  return 0;
}

function stripCommentKey(obj) {
  const { _comment, ...rest } = obj;
  return rest;
}