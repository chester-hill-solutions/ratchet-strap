import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

/**
 * Lint-quality ratchet. Tracked strictness rules are `warn` in ESLint so editors
 * surface them, but their counts may only ratchet DOWN against
 * scripts/baselines/lint-ratchet.json. This product is greenfield: baseline 0.
 */
const TRACKED = [
  "complexity",
  "max-depth",
  "max-params",
  "max-lines-per-function",
  "no-console",
  "no-return-await",
  "@typescript-eslint/no-non-null-assertion",
];

const baselinePath = path.join(process.cwd(), "scripts", "baselines", "lint-ratchet.json");

let raw = "[]";
try {
  raw = execFileSync("npx", ["eslint", "-f", "json", "."], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
  });
} catch (error) {
  raw = error.stdout ?? "[]";
}

const results = JSON.parse(raw);
const counts = Object.fromEntries(TRACKED.map((rule) => [rule, 0]));
for (const file of results) {
  for (const message of file.messages) {
    if (message.ruleId && counts[message.ruleId] !== undefined) {
      counts[message.ruleId] += 1;
    }
  }
}

const baseline = fs.existsSync(baselinePath)
  ? JSON.parse(fs.readFileSync(baselinePath, "utf8"))
  : {};

const grown = TRACKED.filter((rule) => counts[rule] > (baseline[rule] ?? 0)).map(
  (rule) => `${rule}: ${counts[rule]} > baseline ${baseline[rule] ?? 0}`
);

if (grown.length) {
  console.error("Lint ratchet failed: strictness rules grew beyond baseline.");
  for (const line of grown) console.error(`- ${line}`);
  console.error("\nFix the violation; never raise the baseline.");
  process.exit(1);
}

console.log("Lint ratchet passed.");
