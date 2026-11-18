# Changelog

## 0.7.1 — 2026-11-18

- Documented the npm alias for installing under the bare `ratchet-strap` name
  without publishing a personal wrapper package.
- The README now leads with the deterministic mechanism and the two house-rule
  examples.

## 0.7.0 — 2026-11-17

First public release.

- Extracted from the Chester Hill Solutions monorepo as a standalone package.
- The engine ships the mechanism only: identity and count baselines, adapters,
  the ESLint runner, the CLI and the twelve golden defaults.
- Thresholds, golden profiles and enabled sets moved to a vendorable
  `house-rules/` directory. The CLI loads `house-rules/index.mjs` by default.
- Packaging is self-contained: no private registry or workspace dependency.
- Ships only `eslint@1` and `eslint-counts@1`. The legacy compatibility adapters remain in the private source repository and are not part of the public package.

Earlier development history is retained in the private source repository.
