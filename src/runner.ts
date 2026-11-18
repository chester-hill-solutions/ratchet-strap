import { spawnSync } from "node:child_process";
import { statSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";

export interface EslintOptions {
  config?: string;
  cacheLocation?: string;
}

/** Runs the consumer's installed ESLint; exit 1 is a report, not a tool failure. */
export function runEslint(root: string, options: EslintOptions = {}): unknown {
  const packageRoot = resolve(root);
  let eslint: string;
  try {
    const configPath = options.config ? resolve(packageRoot, options.config) : undefined;
    const require = createRequire(configPath ?? join(packageRoot, "package.json"));
    eslint = join(dirname(require.resolve("eslint/package.json")), "bin/eslint.js");
    if (!statSync(eslint).isFile()) throw new Error("Missing ESLint executable");
  } catch {
    throw new Error("Install ESLint in the consuming repository before using --exec-eslint");
  }
  const args = [eslint, ".", "--format", "json"];
  if (options.config) args.push("--config", options.config);
  if (options.cacheLocation) args.push("--cache", "--cache-location", options.cacheLocation);
  else args.push("--no-cache");
  const result = spawnSync(process.execPath, args, {
    cwd: packageRoot,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.error || (result.status !== 0 && result.status !== 1)) {
    throw new Error(`ESLint failed (${result.status ?? result.signal}): ${result.error?.message ?? result.stderr.slice(0, 2000)}`);
  }
  if (!result.stdout.trim()) throw new Error("ESLint returned no JSON output");
  return JSON.parse(result.stdout);
}
