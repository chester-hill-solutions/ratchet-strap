import { readdirSync, readlinkSync } from "node:fs";
import { join, relative, resolve } from "node:path";

/** Conservative project membership, excluding dependency/Git internals and known migration/cache outputs. */
export function collectProjectMembership(root: string, target: string, ownedTemporary: readonly string[] = []): string[] {
  const excluded = new Set([
    resolve(target), join(root, ".ratchet-strap-migration.lock"),
    join(root, ".cache/eslint-ratchet"), ...ownedTemporary.map((path) => resolve(path)),
  ]);
  const members: string[] = [];
  function collect(directory: string): void {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.name === ".git" || entry.name === "node_modules") continue;
      const path = join(directory, entry.name);
      if (excluded.has(path)) continue;
      const label = relative(root, path).replaceAll("\\", "/");
      if (entry.isDirectory()) collect(path);
      else if (entry.isSymbolicLink()) members.push(`link:${label}:${readlinkSync(path)}`);
      else members.push(`file:${label}`);
    }
  }
  collect(root);
  return members.sort();
}
