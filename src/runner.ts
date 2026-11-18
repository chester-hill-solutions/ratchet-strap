import { spawnSync } from "node:child_process";
import { statSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";

interface EslintOptions {
  config?: string;
  cacheLocation?: string;
  invocation?: "standard" | "legacyStrictCounts" | "legacyMessages";
}

/** Runs one installed ESLint invocation; exit 1 is a report, not a tool failure. */
export function runEslint(root: string, options: EslintOptions = {}): unknown {
  const invocation = options.invocation ?? "standard";
  const packageRoot = invocation === "legacyStrictCounts" ? resolve(root, "packages/legacy-strict-counts-s3") : root;
  let eslint: string;
  try {
    const configPath = options.config ? resolve(packageRoot, options.config) : undefined;
    const require = createRequire(configPath ?? join(resolve(packageRoot), "package.json"));
    eslint = invocation === "legacyStrictCounts" ? resolve(packageRoot, "node_modules/eslint/bin/eslint.js")
      : join(dirname(require.resolve("eslint/package.json")), "bin/eslint.js");
    if (!statSync(eslint).isFile()) throw new Error("Missing ESLint executable");
  } catch {
    throw new Error(invocation === "legacyStrictCounts" ? "Install ESLint in packages/legacy-strict-counts-s3 before using the LegacyStrictCounts runner"
      : "Install ESLint in the consuming repository before using --exec-eslint");
  }
  const args = invocation === "legacyMessages" ? ["eslint", "-f", "json", "."] : [eslint, ".", "--format", "json"];
  if (invocation === "standard" && options.config) args.push("--config", options.config);
  if (invocation === "standard" && options.cacheLocation) args.push("--cache", "--cache-location", options.cacheLocation);
  else if (invocation !== "legacyMessages") args.push("--no-cache");
  const result = spawnSync(invocation === "legacyMessages" ? "npx" : process.execPath, args, {
    cwd: packageRoot, encoding: "utf8", maxBuffer: (invocation === "legacyMessages" ? 1 : 64) * 1024 * 1024,
    ...(invocation === "legacyMessages" ? { env: { ...process.env, npm_config_yes: "false" } } : {}),
  });
  if (result.error || (result.status !== 0 && result.status !== 1)) {
    throw new Error(`ESLint failed (${result.status ?? result.signal}): ${result.error?.message ?? result.stderr.slice(0, 2000)}`);
  }
  if (!result.stdout.trim()) throw new Error("ESLint returned no JSON output");
  return JSON.parse(result.stdout);
}

/** LegacyStrictCounts requires the executable in its nested package, even when an ancestor has ESLint. */
export function runLegacyStrictCountsEslint(root: string): unknown {
  return runEslint(root, { invocation: "legacyStrictCounts" });
}

/** Fixed legacy invocation; require installed ESLint so npx cannot silently install one. */
export function runLegacyMessagesEslint(root: string): unknown {
  return runEslint(root, { invocation: "legacyMessages" });
}
