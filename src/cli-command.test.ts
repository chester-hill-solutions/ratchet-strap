import { describe, expect, test } from "bun:test";
import { runCli } from "./cli-command.js";
import { packageVersion } from "./package-meta.js";

describe("CLI command boundary", () => {
  test("explicit arguments and output work without changing process exit state", () => {
    const output: string[] = [];
    const before = process.exitCode;
    expect(runCli(["--version"], { stdout: text => output.push(text) })).toBe(0);
    expect(output).toEqual([packageVersion]);
    expect(process.exitCode).toBe(before);
  });
  test("invalid input throws before printing output", () => {
    const output: string[] = [];
    expect(() => runCli(["check", "--unsupported"], { stdout: text => output.push(text) })).toThrow();
    expect(output).toEqual([]);
  });
});
