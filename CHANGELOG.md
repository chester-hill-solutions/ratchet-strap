# Changelog

## 0.7.0 — 2026-11-17

First public release.

- Extracted from the Chester Hill Solutions monorepo as a standalone package.
- The engine ships the mechanism only: identity and count baselines, adapters,
  the ESLint runner, the CLI and the twelve golden defaults.
- Thresholds, golden profiles and enabled sets moved to a vendorable
  `house-rules/` directory. The CLI loads `house-rules/index.mjs` by default.
- Packaging is self-contained: no private registry or workspace dependency.
- Sanitized the legacy compatibility profiles and fixtures for public use.

Earlier development history is retained in the private source repository.
