import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { accessSync, constants, existsSync, lstatSync, readFileSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { packageName, packageVersion } from "./package-meta.js";
import { observeOperation } from "./telemetry.js";
import { record } from "./validation.js";

/** Canonical project paths and the installed executable share one migration trust boundary. */
export function createMigrationEnvironment(root: string): {
  existingFile: (path: string) => string;
  targetFile: (path: string) => string;
  gitHead: () => string | undefined;
  installedPackage: (manifest: string) => void;
  checkerHash: () => string | undefined;
} {
  function contained(root: string, path: string): void {
    const rel = relative(root, path);
    if (!rel || isAbsolute(rel) || rel === ".." || rel.startsWith(`..${sep}`)) {
      throw new Error(`Migration path is outside the project: ${path}`);
    }
  }

  function existingFile(root: string, path: string): string {
    contained(root, path);
    const canonical = realpathSync(path);
    contained(root, canonical);
    if (canonical !== path || !lstatSync(path).isFile()) throw new Error(`Migration input must be a canonical regular file: ${path}`);
    return canonical;
  }

  function targetFile(root: string, path: string): string {
    contained(root, path);
    const parent = realpathSync(dirname(path));
    if (parent !== root) contained(root, parent);
    const canonical = join(parent, basename(path));
    if (canonical !== path) throw new Error("Migration target parent must be canonical");
    try {
      lstatSync(path);
    } catch (error) {
      if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") return canonical;
      throw error;
    }
    throw new Error(`Migration baseline already exists: ${path}`);
  }

  function gitHead(root: string): string | undefined {
    const result = spawnSync("git", ["-C", root, "rev-parse", "--verify", "HEAD"], { encoding: "utf8", maxBuffer: 1024 * 1024 });
    if (result.error) throw new Error(`Cannot inspect migration Git HEAD: ${result.error.message}`);
    return result.status === 0 ? result.stdout.trim() : undefined;
  }

  function npmExecutable(manifest: string): string | undefined {
    let directory = dirname(manifest);
    while (true) {
      const path = join(directory, "node_modules/.bin/ratchet-strap");
      try {
        const executable = realpathSync(path);
        if (lstatSync(executable).isFile()) {
          accessSync(executable, constants.X_OK);
          return executable;
        }
      } catch (error) {
        if (!(typeof error === "object" && error !== null && "code" in error
          && ["ENOENT", "ENOTDIR", "EACCES", "EPERM"].includes(String(error.code)))) throw error;
      }
      const parent = dirname(directory);
      if (parent === directory) return undefined;
      directory = parent;
    }
  }

  function installedPackage(manifest: string): void {
    existingFile(root, manifest);
    const project = record(JSON.parse(readFileSync(manifest, "utf8")), "Project package.json");
    const declared = ["dependencies", "devDependencies", "optionalDependencies"].some((section) => {
      const input = project[section];
      if (input === undefined) return false;
      const version = record(input, `Project package.json ${section}`)[packageName];
      return typeof version === "string" && Boolean(version.trim());
    });
    if (!declared) throw new Error(`Declare ${packageName} as a project dependency before applying migration`);
    const require = createRequire(manifest);
    let entry: string;
    try { entry = realpathSync(require.resolve(packageName)); }
    catch { throw new Error(`Install ${packageName}@${packageVersion} in this project before applying migration`); }
    let directory = dirname(entry);
    while (true) {
      const path = join(directory, "package.json");
      let input: Record<string, unknown> | undefined;
      try { input = record(JSON.parse(readFileSync(path, "utf8")), "Installed RatchetStrap package.json"); }
      catch (error) {
        if (!(typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT")) throw error;
      }
      if (input?.name === packageName) {
        if (input.version !== packageVersion) throw new Error(`Installed RatchetStrap must match version ${packageVersion}`);
        const bin = typeof input.bin === "string" ? input.bin : record(input.bin, "Installed RatchetStrap bin")["ratchet-strap"];
        if (typeof bin !== "string") throw new Error("Installed RatchetStrap executable is missing");
        const executable = realpathSync(resolve(directory, bin));
        contained(directory, executable);
        if (!lstatSync(executable).isFile()) throw new Error("Installed RatchetStrap executable must be a file");
        accessSync(executable, constants.X_OK);
        if (npmExecutable(manifest) !== executable) {
          throw new Error("The npm script executable must resolve to the verified installed RatchetStrap bin");
        }
        return;
      }
      const parent = dirname(directory);
      if (parent === directory) throw new Error("Resolved RatchetStrap entry has no matching package manifest");
      directory = parent;
    }
  }

  return {
    existingFile: (path) => existingFile(root, path),
    targetFile: (path) => targetFile(root, path),
    gitHead: () => gitHead(root),
    installedPackage,
    checkerHash: () => observeOperation("ratchet.checker", () => {
      const path = resolve(root, "scripts/check-lint-ratchet.mjs");
      if (!existsSync(path)) return undefined;
      return createHash("sha256").update(readFileSync(path)).digest("hex");
    }),
  };
}

