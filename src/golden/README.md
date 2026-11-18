# The golden set

RatchetStrap has two layers of rules.

1. **Defaults** — `GOLDEN_RULES`: twelve rules every consumer follows,
   regardless of language, framework or product. They are the product's
   contract; a ratchet that breaks them is not trustworthy.
2. **Profiles** — supplied by the consumer's house rules: opt-in rule sets for
   a stack or concern. The engine ships none. The starter in
   [`house-rules/golden.mjs`](../../house-rules/golden.mjs) has eight examples
   (TypeScript, React, React Router, web, UI, quality, telemetry, release).

[`index.ts`](./index.ts) exports `GOLDEN_RULES`, `assertGoldenRules()`,
`assertGoldenProfiles()` and `goldenProfile(id)`. Profiles are validated against
the record you pass or configure with `configureHouseRules()`.
