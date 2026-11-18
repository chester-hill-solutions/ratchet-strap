import { randomUUID } from "node:crypto";
import {
  closeSync, fsyncSync, linkSync, openSync, readFileSync, renameSync, rmSync, statSync, writeFileSync,
} from "node:fs";
import type { RatchetBaseline } from "./product.js";

export function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf8"));
}

/** null creates a new file; a string replaces only that exact existing revision. */
export function writeBaseline(path: string, baseline: RatchetBaseline, expected: string | null): void {
  const lock = `${path}.lock`;
  const lockFd = openSync(lock, "wx", 0o600);
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    if (expected !== null && readFileSync(path, "utf8") !== expected) {
      throw new Error("Baseline changed during this run; rerun against the latest baseline");
    }
    const mode = expected === null ? 0o644 : statSync(path).mode & 0o777;
    const fd = openSync(temporary, "wx", mode);
    try {
      writeFileSync(fd, `${JSON.stringify(baseline, null, 2)}\n`);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    if (expected === null) linkSync(temporary, path);
    else renameSync(temporary, path);
  } finally {
    rmSync(temporary, { force: true });
    closeSync(lockFd);
    rmSync(lock, { force: true });
  }
}
