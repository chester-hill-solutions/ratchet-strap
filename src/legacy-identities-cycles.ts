import { readFileSync, readdirSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

/** Frozen legacy identities traversal; changes require a new compatibility adapter. */
export function collectLegacyIdentitiesCycles(directory: string): string[] {
  function containedSource(path: string, canonicalRoot: string): string {
    const file = realpathSync(path);
    const rel = relative(canonicalRoot, file);
    if (isAbsolute(rel) || rel === ".." || rel.startsWith(`..${sep}`)) {
      throw new Error(`legacy identities source is outside --root: ${path}`);
    }
    return path;
  }

  const root = resolve(directory);
  const canonicalRoot = realpathSync(root);
  const sourceFiles: string[] = [];
  function collectSources(directory: string): void {
    containedSource(directory, canonicalRoot);
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.name === "node_modules" || entry.name === "build" || entry.name === ".react-router") continue;
      if (entry.isDirectory()) collectSources(path);
      else if (/\.(ts|tsx)$/.test(entry.name) && !entry.name.endsWith(".d.ts")) {
        sourceFiles.push(containedSource(path, canonicalRoot));
      }
    }
  }
  collectSources(resolve(root, "app"));
  const sourceSet = new Set(sourceFiles);
  function resolveImport(from: string, specifier: string): string | null {
    const base = specifier.startsWith("~/")
      ? resolve(root, "app", specifier.slice(2))
      : specifier.startsWith(".") ? resolve(dirname(from), specifier) : null;
    if (!base) return null;
    for (const candidate of [base, `${base}.ts`, `${base}.tsx`, `${base}.js`, join(base, "index.ts"), join(base, "index.tsx")]) {
      if (sourceSet.has(candidate)) return candidate;
    }
    return null;
  }
  const graph = new Map<string, string[]>(sourceFiles.map((file) => [file, []]));
  for (const file of sourceFiles) {
    const source = readFileSync(containedSource(file, canonicalRoot), "utf8");
    const targets = graph.get(file);
    if (!targets) throw new Error(`Missing legacy identities source graph entry: ${file}`);
    for (const match of source.matchAll(/(?:import|export)\s+(?:[^"']+?\s+from\s+)?["']([^"']+)["']/g)) {
      const specifier = match[1];
      if (specifier === undefined) throw new Error(`Invalid legacy identities import match: ${file}`);
      const target = resolveImport(file, specifier);
      if (target) targets.push(target);
    }
  }
  const cycleViolations = new Set<string>();
  function visit(file: string, path: string[] = [], seen: Set<string> = new Set()): void {
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
  return [...cycleViolations];
}
