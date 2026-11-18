import { spawnSync } from "node:child_process";
import { isAbsolute, relative, resolve } from "node:path";
import { importLegacyStrictCountsBaseline, parseLegacyStrictCountsBaseline } from "./legacy-strict-counts.js";
import type { LegacyStrictCountsBaseline } from "./legacy-strict-counts.js";

export interface LegacyStrictCountsPredecessor {
  availability: "found" | "first-adoption";
  ref: string;
  resolvedRef: string;
  source?: string;
  baseline?: LegacyStrictCountsBaseline;
}

export function readLegacyStrictCountsPredecessor(
  directory: string,
  path = "scripts/baselines/lint-ratchet.json",
  legacyPath = "scripts/baselines/lint-ratchet.json",
  options: { ref?: string } = {},
): LegacyStrictCountsPredecessor {
  function git(root: string, args: string[]) {
    const result = spawnSync("git", ["-C", root, ...args], { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
    if (result.error) throw new Error(`LegacyStrictCounts history lookup failed: ${result.error.message}`);
    return result;
  }

  function repositoryPath(root: string, path: string): string {
    const rel = relative(root, resolve(root, path)).replaceAll("\\", "/");
    if (isAbsolute(rel) || rel === ".." || rel.startsWith("../")) throw new Error("LegacyStrictCounts predecessor baseline must be inside --root");
    return rel;
  }

  const root = resolve(directory);
  const ref = options.ref?.trim() || process.env.RATCHET_STRAP_BASE_REF?.trim() || "HEAD^";
  const resolved = git(root, ["rev-parse", "--verify", ref]);
  if (resolved.status !== 0 || !resolved.stdout.trim()) {
    throw new Error(`Cannot resolve ratchet base ${ref}; check out full history (fetch-depth: 0) or set RATCHET_STRAP_BASE_REF`);
  }
  const resolvedRef = resolved.stdout.trim();
  const legacy = repositoryPath(root, legacyPath);
  const candidates = [...new Set([repositoryPath(root, path), legacy])];
  for (const candidate of candidates) {
    const isLegacy = candidate === legacy;
    if (!isLegacy) {
      const present = git(root, ["ls-tree", "--name-only", resolvedRef, "--", candidate]);
      if (present.status !== 0) throw new Error(`Cannot inspect LegacyStrictCounts predecessor: ${present.stderr.trim()}`);
      if (!present.stdout.trim()) continue;
    }
    const previous = git(root, ["show", `${resolvedRef}:${candidate}`]);
    if (previous.status !== 0) {
      if (isLegacy) return { availability: "first-adoption", ref, resolvedRef };
      throw new Error(`Cannot read LegacyStrictCounts predecessor: ${previous.stderr.trim()}`);
    }
    let value: unknown;
    try { value = JSON.parse(previous.stdout); }
    catch {
      // LegacyStrictCounts's legacy helper treats malformed historical JSON just like a missing blob.
      if (isLegacy) return { availability: "first-adoption", ref, resolvedRef };
      throw new Error("Malformed RatchetStrap predecessor baseline; refusing to erase LegacyStrictCounts history protection");
    }
    if (!isLegacy) return { availability: "found", ref, resolvedRef, source: `${resolvedRef}:${candidate}`, baseline: parseLegacyStrictCountsBaseline(value) };
    if (typeof value !== "object" || value === null || !("counts" in value) || value.counts == null) {
      return { availability: "found", ref, resolvedRef, source: `${resolvedRef}:${candidate}` };
    }
    return { availability: "found", ref, resolvedRef, source: `${resolvedRef}:${candidate}`, baseline: importLegacyStrictCountsBaseline(value) };
  }
  return { availability: "first-adoption", ref, resolvedRef };
}
