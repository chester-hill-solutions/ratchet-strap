import { describe, expect, test } from "bun:test";
import { emptyBaseline } from "./commands.js";
import { getProfile } from "./profiles.js";

describe("lint profiles", () => {
  test("initializing without a profile keeps the recommended identity mode", () => {
    const baseline = emptyBaseline(["complexity"], "eslint@1");
    expect(baseline.schemaVersion).toBe(2);
    expect(getProfile("eslint@1").mode).toBe("identities");
  });
});
