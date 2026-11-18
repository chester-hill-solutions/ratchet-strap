export const legacyMessagesRuleIds = [
  "complexity", "max-depth", "max-params", "max-lines-per-function",
  "no-console", "no-return-await", "@typescript-eslint/no-non-null-assertion",
] as const;

export const legacyMessagesCheckerSha256 = "64cc33ad3dd55dd74e8d46be08ac1db387faa0755b4c998048c565f405127fb2";

export function hasLegacyMessagesRules(rules: readonly string[]): boolean {
  return rules.length === legacyMessagesRuleIds.length && legacyMessagesRuleIds.every((rule) => rules.includes(rule));
}
