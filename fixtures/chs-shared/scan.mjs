/**
 * Fail-closed scanning for the guard scripts.
 *
 * grep has two distinct outcomes and they must never share a handler:
 *
 *   exit 1   the pattern matched nothing          → a real result: zero occurrences
 *   exit 2   the path is missing or unreadable    → NOT a result
 *
 * The guards this replaces ran grep through a shell string and caught every non-zero
 * exit in one `catch {}` commented "no matches". An unresolvable scan root therefore
 * reported exactly what a clean gate reports. That is not a near-miss: a probe planted
 * in the directory `check-money-units.mjs` is *meant* to scan still reported
 * `0 (baseline 0)` and exited 0.
 *
 * So: a missing root throws, and only a genuine no-match returns zero.
 *
 * This is deliberately the scan primitive only. The baseline-ratchet machinery that
 * sits on top of it is a separate concern, tracked separately.
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";

/** A scan root that does not exist. Accepts a file or a directory. */
export class ScanRootError extends Error {
  constructor(root, detail) {
    super(
      `unresolvable scan root: ${root}\n  ${detail}\n` +
        `  A guard cannot report a result over a path it did not read. This is an error, not a zero.`,
    );
    this.name = "ScanRootError";
    this.root = root;
  }
}

/** grep itself failed for a reason other than "no match". */
export class ScanError extends Error {
  constructor(pattern, root, status, stderr) {
    super(`grep failed (exit ${status}) scanning ${root} for ${pattern}\n  ${stderr.trim()}`);
    this.name = "ScanError";
  }
}

function assertReadableRoot(root) {
  // A file is a legitimate root — allowlist entries are single files.
  if (!existsSync(root)) {
    throw new ScanRootError(root, "it does not exist");
  }
}

/**
 * Count occurrences of `pattern` under `root`.
 *
 * Counts *occurrences*, not matching lines: one line carrying three violations is
 * three violations. A ratchet that counts lines under-counts by exactly the factor
 * that makes a baseline look better than reality.
 *
 * @param {object} opts
 * @param {string} opts.root      absolute path to scan
 * @param {string} opts.pattern   extended regex
 * @param {string[]} [opts.include]  --include globs
 * @param {string[]} [opts.exclude]  exclude globs, applied as a second filter
 * @returns {number} occurrences, 0 when the pattern genuinely matched nothing
 */
export function countOccurrences({ root, pattern, include = [], exclude = [] }) {
  assertReadableRoot(root);

  const args = ["-rEo", pattern, root];
  for (const glob of include) args.push(`--include=${glob}`);
  for (const glob of exclude) args.push(`--exclude=${glob}`);

  const res = spawnSync("grep", args, { encoding: "utf8" });

  // grep did not run at all (binary missing, bad args). Never a zero.
  if (res.error) throw new ScanError(pattern, root, "spawn failed", String(res.error));

  if (res.status === 0) {
    const lines = res.stdout.split("\n").filter((l) => l.length > 0);
    return lines.length;
  }
  if (res.status === 1) return 0; // genuine no-match

  throw new ScanError(pattern, root, res.status, res.stderr || "(no stderr)");
}

/** Total occurrences across several roots. Every root is checked, so one bad root fails the run. */
export function countAcross(roots, opts) {
  return roots.reduce((sum, root) => sum + countOccurrences({ ...opts, root }), 0);
}