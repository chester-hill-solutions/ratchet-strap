# Contributing

Thanks for taking a look. Small, focused pull requests are easiest to review.

## Development

```bash
bun install
bun run typecheck
bun run test
bun run build
```

Run the same checks before opening a pull request; CI runs all four.

## Scope

- The engine owns baselines, adapters, the ESLint runner, the CLI and the twelve
  golden defaults.
- Thresholds, named profiles and enabled golden rules belong in `house-rules/`.
  A pull request that hard-codes a project's thresholds in `src/` will be asked
  to move them.
- A new adapter should preserve an existing gate's exact semantics and state
  what it cannot distinguish. Add a fault fixture and a control fixture.
- Do not add a dependency where the standard library or the existing code will
  do. Do not upgrade ESLint for the consumer.

## Pull requests

- Describe the behaviour change, not the diff.
- Include the failure the change prevents, with a test that fails before it.
- Keep generated artefacts out of the diff; the build is reproducible.
- Do not include client names, baselines or scan output from a private
  repository. Use `fixtures/example-*` or a synthetic fixture.

## License

By contributing you agree that your contribution is licensed under the
repository's MIT licence.
