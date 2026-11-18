import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMigrationFileOwner, withMigrationLock } from "./migration-transaction.js";

let root: string;
beforeEach(() => { root = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), "ratchet-strap-ownership-"))); });
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

describe("migration file ownership", () => {
  test("a failed durable write removes its temporary file without changing the target", () => {
    const target = join(root, "baseline.json");
    fs.writeFileSync(target, "original\n");
    const failure = new Error("fsync failed");
    const sync = spyOn(fs, "fsyncSync").mockImplementation(() => { throw failure; });
    try {
      expect(() => createMigrationFileOwner().temporary(target, "replacement\n", 0o600)).toThrow(failure);
      expect(fs.readdirSync(root)).toEqual(["baseline.json"]);
      expect(fs.readFileSync(target, "utf8")).toBe("original\n");
    } finally { sync.mockRestore(); }
  });

  test("owned cleanup preserves a replacement file at the same path", () => {
    const owner = createMigrationFileOwner();
    const file = owner.temporary(join(root, "baseline.json"), "ours\n", 0o600);
    // Keep the owned inode alive while replacing the directory entry, avoiding inode reuse.
    fs.renameSync(file.path, join(root, "owned-original"));
    fs.writeFileSync(file.path, "other writer\n");
    expect(owner.belongsTo(file)).toBe(false);
    owner.removeOwned(file);
    expect(fs.readFileSync(file.path, "utf8")).toBe("other writer\n");
  });

  test("a nested lock conflict preserves the active lock and outer callback error", () => {
    const lock = join(root, ".ratchet-strap-migration.lock");
    const failure = new Error("outer operation failed");
    expect(() => withMigrationLock(root, () => {
      const token = fs.readFileSync(lock, "utf8");
      expect(() => withMigrationLock(root, () => undefined)).toThrow("EEXIST");
      expect(fs.readFileSync(lock, "utf8")).toBe(token);
      throw failure;
    })).toThrow(failure);
    expect(fs.existsSync(lock)).toBe(false);
    expect(withMigrationLock(root, () => 42)).toBe(42);
    expect(fs.existsSync(lock)).toBe(false);
  });
});
