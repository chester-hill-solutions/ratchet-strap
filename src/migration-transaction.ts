import { createHash, randomUUID } from "node:crypto";
import {
  closeSync, fchmodSync, fstatSync, fsyncSync, linkSync, lstatSync, openSync, readFileSync,
  renameSync, unlinkSync, writeFileSync,
} from "node:fs";
import type { Stats } from "node:fs";
import { observeOperation } from "./telemetry.js";

interface OwnedFile {
  path: string;
  stat: Stats;
}

/** Shared inode ownership protects both lock cleanup and transactional temporary files. */
export function createMigrationFileOwner(): {
  capture: (path: string, descriptor: number) => OwnedFile;
  belongsTo: (file: OwnedFile) => boolean;
  removeOwned: (file: OwnedFile) => void;
  temporary: (path: string, text: string, mode: number, preserveMode?: boolean) => OwnedFile;
} {
  function stat(path: string): Stats | undefined {
    try { return lstatSync(path); }
    catch (error) {
      if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") return undefined;
      throw error;
    }
  }

  function belongsTo(file: OwnedFile): boolean {
    const current = stat(file.path);
    return current !== undefined && current.dev === file.stat.dev && current.ino === file.stat.ino;
  }

  function removeOwned(file: OwnedFile): void {
    if (belongsTo(file)) unlinkSync(file.path);
  }

  function temporary(path: string, text: string, mode: number, preserveMode = false): OwnedFile {
    const temporaryPath = `${path}.${randomUUID()}.tmp`;
    const fd = openSync(temporaryPath, "wx", mode);
    const owned = { path: temporaryPath, stat: fstatSync(fd) };
    try {
      if (preserveMode) fchmodSync(fd, mode);
      writeFileSync(fd, text, "utf8");
      fsyncSync(fd);
      return owned;
    } catch (error) {
      removeOwned(owned);
      throw error;
    } finally {
      closeSync(fd);
    }
  }

  return {
    capture: (path, descriptor) => ({ path, stat: fstatSync(descriptor) }),
    belongsTo, removeOwned, temporary,
  };
}

export function withMigrationLock<T>(root: string, run: () => T): T {
  const path = `${root}/.ratchet-strap-migration.lock`;
  const fd = openSync(path, "wx", 0o600);
  const owner = createMigrationFileOwner();
  const lock = owner.capture(path, fd);
  const token = `${randomUUID()}\n`;
  let initialized = false;
  try {
    writeFileSync(fd, token, "utf8");
    initialized = true;
    return run();
  } finally {
    closeSync(fd);
    if (owner.belongsTo(lock) && (!initialized || readFileSync(path, "utf8") === token)) owner.removeOwned(lock);
  }
}

/** Caller holds the project lock; freshness is checked immediately before each commit. */
export function commitMigrationFiles(options: {
  baseline: string;
  manifest: string;
  baselineText: string;
  manifestText: string;
  manifestMode: number;
  assertFresh: (ownedTemporary: readonly string[]) => void;
}): void {
  return observeOperation("ratchet.commit", () => {
    const owner = createMigrationFileOwner();
    function digest(value: string | Buffer): string {
      return createHash("sha256").update(value).digest("hex");
    }

    const files: OwnedFile[] = [];
    let createdBaseline: OwnedFile | undefined;
    let committed = false;
    try {
      const baseline = owner.temporary(options.baseline, options.baselineText, 0o644);
      files.push(baseline);
      const manifest = owner.temporary(options.manifest, options.manifestText, options.manifestMode, true);
      files.push(manifest);
      options.assertFresh(files.map((file) => file.path));
      linkSync(baseline.path, options.baseline);
      createdBaseline = { path: options.baseline, stat: baseline.stat };
      options.assertFresh(files.map((file) => file.path));
      if (!owner.belongsTo(createdBaseline) || digest(readFileSync(createdBaseline.path)) !== digest(options.baselineText)) {
        throw new Error("Migration baseline changed before manifest commit");
      }
      renameSync(manifest.path, options.manifest);
      committed = true;
    } finally {
      if (!committed && createdBaseline && owner.belongsTo(createdBaseline)) {
        const expected = digest(options.baselineText);
        const current = digest(readFileSync(createdBaseline.path));
        if (current === expected) owner.removeOwned(createdBaseline);
      }
      for (const file of files) owner.removeOwned(file);
    }
  });
}
