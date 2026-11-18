# 0001 — Engine and vendored house rules

Status: accepted, 2026-11-17.

## Context

RatchetStrap grew inside the CHS monorepo with CHS thresholds, a CHS quality
policy, nine golden profiles and four compatibility profiles
for specific adopters. Publishing that as the product would make one company's
house style the default every consumer inherits, and it would publish client
adoption evidence alongside the mechanism.

## Decision

Split the package into three layers:

| Layer | Owner | Ships in `ratchet-strap` |
| --- | --- | --- |
| Mechanism: baselines, adapters, runner, CLI, golden defaults `U1`–`U12` | The package | Yes |
| House rules: quality policy, golden profiles, enabled set, adoption recipes | The consumer's repository, copied from `house-rules/` | A starter only |
| Adopter-specific compatibility profiles | The repository that owns that migration | No |

The engine keeps no thresholds and no named profiles beyond `eslint@1` and
`eslint-counts@1`. `configureHouseRules()` accepts the consumer's module; the
CLI loads `./house-rules/index.mjs` by default and `--house-rules FILE`
otherwise.

## Consequences

- Upgrading the package cannot change a project's thresholds, enabled profiles
  or golden composition. Those live in the consumer's reviewed directory.
- The public starter contains generic profiles and no client baselines. A
  consumer that needs a legacy adapter writes it beside `quality.mjs`.
- Engine tests import the starter from `house-rules/`; the engine's own tests
  cover validation with local fixtures.
- CHS keeps its full composition in the private monorepo and consumes the
  published engine, so there is one implementation of the mechanism.

## Follow-ups

1. ~~Sanitize the remaining adopter-specific identifiers and fixtures before the
   repository is made public.~~ Done: the public package ships no adopter
   profiles or fixtures.
2. Publish `@chester-hill-solutions/ratchet-strap@0.7.0` to npm after the public repository's CI passes.
3. Replace the monorepo's embedded package with the published dependency and a
   private `house-rules` module.
