import { lstatSync, realpathSync } from "node:fs";
import { isAbsolute, join, relative, sep } from "node:path";

const controlNames = [
  "eslint.config.js", "eslint.config.mjs", "eslint.config.cjs",
  "eslint.config.ts", "eslint.config.mts", "eslint.config.cts",
  ".eslintrc", ".eslintrc.json", ".eslintrc.js", ".eslintrc.cjs", ".eslintrc.yml", ".eslintrc.yaml", ".eslintignore",
  "package-lock.json", "npm-shrinkwrap.json", "bun.lock", "bun.lockb", "pnpm-lock.yaml", "yarn.lock",
] as const;

export function collectVerificationControls(root: string): string[] {
  const paths: string[] = [];
  for (const name of controlNames) {
    const path = join(root, name);
    let stat;
    try { stat = lstatSync(path); }
    catch (error) {
      if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") continue;
      throw error;
    }
    const canonical = realpathSync(path);
    const rel = relative(root, canonical);
    if (!stat.isFile() || canonical !== path || isAbsolute(rel) || rel === ".." || rel.startsWith(`..${sep}`)) {
      throw new Error(`Verification configuration must be a canonical project file: ${path}`);
    }
    paths.push(path);
  }
  return paths.sort();
}
