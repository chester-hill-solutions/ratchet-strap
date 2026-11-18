import { spawnSync } from "node:child_process";
import { isAbsolute, relative, resolve } from "node:path";
import { importLegacyIdentitiesBaseline, parseIdentityBaseline } from "./identity.js";
import type { IdentityBaseline } from "./identity-types.js";

interface Predecessor {
  availability: "found" | "no-history" | "first-adoption";
  source?: string;
  baseline?: IdentityBaseline;
}

export function readLegacyIdentitiesPredecessor(root: string, path: string, legacyPath?: string): Predecessor {
  function git(root: string, args: string[]) {
    const result = spawnSync("git", ["-C", root, ...args], { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
    if (result.error) throw new Error(`Git predecessor lookup failed: ${result.error.message}`);
    return result;
  }

  const repository = git(root, ["rev-parse", "--show-toplevel"]);
  if (repository.status !== 0) return { availability: "no-history" };
  const gitRoot = repository.stdout.trim();
  if (git(root, ["rev-parse", "--verify", "HEAD^"]).status !== 0) return { availability: "no-history" };
  const candidates = [resolve(path), resolve(root, legacyPath ?? "scripts/baselines/lint-ratchet.json")];
  for (const candidate of candidates) {
    const relativePath = relative(gitRoot, candidate).replaceAll("\\", "/");
    if (isAbsolute(relativePath) || relativePath === ".." || relativePath.startsWith("../")) continue;
    const listed = git(root, ["ls-tree", "--name-only", "HEAD^", "--", relativePath]);
    if (listed.status !== 0) throw new Error(`Cannot inspect predecessor baseline: ${listed.stderr.trim()}`);
    if (!listed.stdout.trim()) continue;
    const content = git(root, ["show", `HEAD^:${relativePath}`]);
    if (content.status !== 0) throw new Error(`Cannot read predecessor baseline: ${content.stderr.trim()}`);
    const value: unknown = JSON.parse(content.stdout);
    const baseline = typeof value === "object" && value !== null && "schemaVersion" in value
      ? parseIdentityBaseline(value) : importLegacyIdentitiesBaseline(value);
    return { availability: "found", source: `HEAD^:${relativePath}`, baseline };
  }
  return { availability: "first-adoption" };
}
