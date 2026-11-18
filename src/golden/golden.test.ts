import { describe, expect, test } from "bun:test";
import {
  enabledProfiles,
  goldenProfiles,
} from "../../house-rules/golden.mjs";
import {
  assertGoldenProfiles,
  assertGoldenRules,
  GOLDEN_RULES,
  goldenProfile,
  type GoldenProfileRule,
} from "./index.js";

const profiles = goldenProfiles as Readonly<Record<string, readonly GoldenProfileRule[]>>;
const enabled = enabledProfiles as readonly string[];

const profileClone = (): Record<string, GoldenProfileRule[]> =>
  Object.fromEntries(
    Object.entries(profiles).map(([name, rules]) => [
      name,
      rules.map((rule) => ({ ...rule, enforcement: rule.enforcement.map((entry) => ({ ...entry })) })),
    ]),
  );

describe("open-source defaults", () => {
  test("the twelve defaults validate and keep their declared order", () => {
    expect(GOLDEN_RULES.map((rule) => rule.id)).toEqual([
      "U1", "U2", "U3", "U4", "U5", "U6", "U7", "U8", "U9", "U10", "U11", "U12",
    ]);
    expect(() => assertGoldenRules()).not.toThrow();
    expect(Object.isFrozen(GOLDEN_RULES)).toBe(true);
  });

  test("rejects a missing, reordered, duplicated or empty default", () => {
    const rules = GOLDEN_RULES.map((rule) => ({ ...rule }));
    expect(() => assertGoldenRules(rules.slice(0, -1))).toThrow("exactly");
    expect(() => assertGoldenRules([rules[1]!, rules[0]!, ...rules.slice(2)])).toThrow("position 0");
    expect(() => assertGoldenRules([rules[0]!, { ...rules[0]! }, ...rules.slice(2)])).toThrow("position 1");
    expect(() => assertGoldenRules([{ ...rules[0]!, title: " " }, ...rules.slice(1)])).toThrow("non-empty title");
    expect(() => assertGoldenRules([{ ...rules[0]!, rule: "" }, ...rules.slice(1)])).toThrow("non-empty rule");
  });
});

describe("opt-in profiles", () => {
  test("all nine profiles are present, non-empty and valid", () => {
    expect(Object.keys(profiles).sort()).toEqual([
      "quality", "react", "react-router", "release", "telemetry", "typescript", "ui", "web",
    ]);
    for (const rules of Object.values(profiles)) expect(rules.length).toBeGreaterThan(0);
    expect(() => assertGoldenProfiles(profiles)).not.toThrow();
  });

  test("the starter enables every profile it ships", () => {
    expect([...enabled].sort() as string[]).toEqual(Object.keys(profiles).sort());
    expect(Object.isFrozen(enabled)).toBe(true);
  });

  test("profile lookup returns rules and rejects an unknown id", () => {
    expect(goldenProfile("react", profiles).map((rule) => rule.id)).toContain("react.effects");
    expect(() => goldenProfile("nope", profiles)).toThrow("Unknown golden profile");
  });

  test("rejects an empty profile or duplicate rule id", () => {
    expect(() => assertGoldenProfiles({ ...profileClone(), react: [] })).toThrow("at least one rule");
    expect(() => assertGoldenProfiles({ ...profileClone(), react: [profileClone().react![0]!, profileClone().react![0]!] }))
      .toThrow("Duplicate golden rule id");
  });

  test("rejects a rule with neither enforcement nor a pending ticket", () => {
    const profiles = profileClone();
    profiles.react = [{ ...profiles.react![0]!, enforcement: [], pending: undefined }];
    expect(() => assertGoldenProfiles(profiles)).toThrow("must have enforcement or a pending ticket");
  });

  test("rejects a rule that is both enforced and pending", () => {
    const profiles = profileClone();
    profiles.react = [{ ...profiles.react![0]!, pending: "RS-03" }];
    expect(() => assertGoldenProfiles(profiles)).toThrow("cannot be both enforced and pending");
  });

  test("rejects an empty consumer detector", () => {
    const profiles = profileClone();
    profiles.react = [{
      ...profiles.react![0]!,
      enforcement: [{ kind: "consumer", detector: " " }],
    }];
    expect(() => assertGoldenProfiles(profiles)).toThrow("non-empty consumer detector");
  });


});
