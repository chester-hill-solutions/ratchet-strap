import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

const root = process.cwd();
const baselinePath = resolve(root, "scripts/baselines/lint-ratchet.json");
const rules = [
  "max-lines-per-function",
  "complexity",
  "@typescript-eslint/no-non-null-assertion",
  "max-params",
  "max-depth",
  "import/no-cycle",
  "no-return-await",
  "no-console",
];

const output = execFileSync(
  process.execPath,
  [resolve(root, "node_modules/eslint/bin/eslint.js"), ".", "--config", "eslint.config.mjs", "--format", "json", "--cache", "--cache-location", ".cache/eslint-ratchet"],
  { cwd: root, encoding: "utf8", maxBuffer: 50 * 1024 * 1024 },
);
const results = JSON.parse(output);
const baseline = JSON.parse(readFileSync(baselinePath, "utf8"));
const current = new Map(rules.map((rule) => [rule, new Set()]));
const occurrenceCounts = new Map();

for (const result of results) {
  for (const message of [...(result.messages ?? []), ...(result.suppressedMessages ?? [])]) {
    if (!current.has(message.ruleId)) continue;
    const file = relative(root, result.filePath);
    const occurrenceKey = `${message.ruleId}:${file}:${message.message}`;
    const occurrence = (occurrenceCounts.get(occurrenceKey) ?? 0) + 1;
    occurrenceCounts.set(occurrenceKey, occurrence);
    const identity = `${file}:${message.ruleId}:${message.message}#${occurrence}`;
    current.get(message.ruleId).add(identity);
  }
}

const sourceFiles = [];
function collectSources(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.name === "node_modules" || entry.name === "build" || entry.name === ".react-router") continue;
    if (entry.isDirectory()) collectSources(path);
    else if (/\.(ts|tsx)$/.test(entry.name) && !entry.name.endsWith(".d.ts")) sourceFiles.push(path);
  }
}
collectSources(resolve(root, "app"));
const sourceSet = new Set(sourceFiles);
function resolveImport(from, specifier) {
  const base = specifier.startsWith("~/")
    ? resolve(root, "app", specifier.slice(2))
    : specifier.startsWith(".") ? resolve(dirname(from), specifier) : null;
  if (!base) return null;
  for (const candidate of [base, `${base}.ts`, `${base}.tsx`, `${base}.js`, join(base, "index.ts"), join(base, "index.tsx")]) {
    if (sourceSet.has(candidate)) return candidate;
  }
  return null;
}
const graph = new Map(sourceFiles.map((file) => [file, []]));
for (const file of sourceFiles) {
  const source = readFileSync(file, "utf8");
  for (const match of source.matchAll(/(?:import|export)\s+(?:[^"']+?\s+from\s+)?["']([^"']+)["']/g)) {
    const target = resolveImport(file, match[1]);
    if (target) graph.get(file).push(target);
  }
}
const cycleViolations = new Set();
function visit(file, path = [], seen = new Set()) {
  if (path.includes(file)) {
    const cycle = [...path.slice(path.indexOf(file)), file].map((item) => relative(root, item)).join(" -> ");
    cycleViolations.add(`${cycle}:depth=${path.length - path.indexOf(file)}`);
    return;
  }
  if (seen.has(file)) return;
  const nextSeen = new Set(seen).add(file);
  for (const target of graph.get(file) ?? []) visit(target, [...path, file], nextSeen);
}
for (const file of sourceFiles) visit(file);
for (const identity of cycleViolations) current.get("import/no-cycle").add(identity);

function previousBaseline() {
  try {
    return JSON.parse(execFileSync("git", ["show", `HEAD^:${relative(root, baselinePath)}`], {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }));
  } catch {
    return null;
  }
}

const previous = previousBaseline();
if (previous && baseline.version && previous.version === baseline.version) {
  for (const rule of rules) {
    const prior = new Set(previous[rule] ?? []);
    const currentCount = (baseline[rule] ?? []).length;
    if (currentCount > prior.size) {
      console.error(`Lint baseline increased: ${rule}`);
      console.error(`  current=${currentCount}; previous=${prior.size}`);
      console.error("  remediation: fix the violation instead of expanding the baseline");
      process.exitCode = 1;
    }
  }
  if (process.exitCode) process.exit(process.exitCode);
}

if (process.argv.includes("--write-baseline")) {
  writeFileSync(
    baselinePath,
    `${JSON.stringify({ version: 2, ...Object.fromEntries([...current].map(([rule, identities]) => [rule, [...identities].sort()])) }, null, 2)}\n`,
  );
  console.log(`Wrote ${baselinePath}`);
  process.exit(0);
}

const failures = [];
for (const rule of rules) {
  const actual = current.get(rule);
  const allowed = new Set(baseline[rule] ?? []);
  const newViolations = [...actual].filter((identity) => !allowed.has(identity));
  const staleEntries = [...allowed].filter((identity) => !actual.has(identity));
  if (newViolations.length > 0 || staleEntries.length > 0) {
    failures.push({ rule, actual: actual.size, permitted: allowed.size, newViolations, staleEntries });
  }
}

if (failures.length > 0) {
  for (const failure of failures) {
    console.error(`Lint ratchet violation: ${failure.rule}`);
    console.error(`  current=${failure.actual}; permitted baseline=${failure.permitted}`);
    for (const identity of failure.newViolations) console.error(`  new: ${identity}`);
    for (const identity of failure.staleEntries) console.error(`  stale baseline: ${identity}`);
    console.error("  detail: npm run lint:ci -- --format stylish");
    console.error("  remediation: fix the violation, or regenerate the baseline only after removing debt");
  }
  process.exitCode = 1;
} else {
  console.log(`Lint ratchet OK (${rules.map((rule) => `${rule}=${current.get(rule).size}`).join(", ")})`);
}
