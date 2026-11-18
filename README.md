# RatchetStrap

A ratchet for lint debt. ESLint finds violations; RatchetStrap compares them with
a baseline you review and commit. New violations fail, repaired violations must
be removed, and the baseline only ever shrinks.

The engine is deliberately opinion-free. Thresholds, named profiles and enabled
golden rules live in a `house-rules/` directory your repository owns.

## Why

Coding agents are good at making a red check green. Left alone they mock the
thing under test, sleep until a race usually goes their way, retry the flake,
raise the timeout, or add a `// eslint-disable`. Every one of those passes CI.

RatchetStrap makes the honest path the one that also passes:

- an identity that is not in the baseline fails the gate;
- a baseline entry that no longer appears must be tightened out;
- a suppressed diagnostic still counts;
- the baseline is compared with a trusted revision, so it cannot be raised.

## Install

```bash
npm install --save-dev ratchet-strap
# or
bun add --dev ratchet-strap
```

Requires Node 20.11 or later. RatchetStrap uses your project's ESLint; it does
not install or upgrade one.

## Quick start

Enable the rules you want to ratchet in your ESLint flat config, then record the
existing debt once:

```bash
ratchet-strap rules
ratchet-strap init --rules no-console,complexity --exec-eslint
ratchet-strap check --exec-eslint
```

After repairing debt:

```bash
ratchet-strap tighten --exec-eslint         # preview
ratchet-strap tighten --exec-eslint --write # remove the repaired entries
```

After enabling another rule:

```bash
ratchet-strap add --rules no-alert --exec-eslint         # preview
ratchet-strap add --rules no-alert --exec-eslint --write # accept its initial debt
```

`check` never writes. `tighten`, `add` and `migrate` preview unless you pass
`--write`. The default baseline is `.ratchet-strap.json`; use `--baseline FILE`
to change it. Commands print JSON. Exit codes: `0` passed, `1` violations or
new debt, `2` invalid input or tool failure.

You can also feed an existing report instead of running ESLint:

```bash
eslint . --format json --no-cache --output-file eslint-report.json
ratchet-strap check --report eslint-report.json
```

## House rules

The package ships a starter under `house-rules/`. Copy it and edit it:

```bash
cp -R node_modules/ratchet-strap/house-rules ./house-rules
```

```ts
// eslint.config.mjs
import { houseRules } from "./house-rules/index.mjs";

export default [
  {
    files: ["**/*.{ts,tsx}"],
    rules: { ...houseRules.policy.rules },
  },
];
```

The CLI loads `./house-rules/index.mjs` by default; point it elsewhere with
`--house-rules FILE`. Programmatic consumers call `configureHouseRules()`.

What belongs in the directory:

| File | Contents |
| --- | --- |
| `quality.mjs` | A named ESLint rule record and its versioned id. |
| `golden.mjs` | Opt-in golden profiles and the set you enable. |
| `index.mjs` | The module the CLI and API load. |

Keep it in version control. A package upgrade cannot change your thresholds,
your enabled profiles or your exclusions; only a reviewed edit can.

## Profiles and baselines

A **profile** selects a comparison mode, an adapter and runner defaults. An
**adapter** translates detector output. The **baseline** stores accepted debt.

| Profile | Adapter | Comparison |
| --- | --- | --- |
| `eslint@1` (default) | `eslint-identities@1` | New and stale identities fail |
| `eslint-counts@1` | `eslint-json@1` | Per-rule warning and suppressed counts cannot grow |

Additional profiles cover legacy formats: `legacy-counts@1` preserves
suppression-comment accounting, `legacy-identities@1` preserves identities plus
import cycles and predecessor protection, `legacy-messages@1` preserves message
counts, and `legacy-strict-counts@1` preserves strict suppression budgets with a
required Git base. They exist for repositories that already have those gates;
new projects should use `eslint@1`.

Baselines pin their adapter. Unknown versions and mixed modes fail; there is no
implicit conversion between counts and identities.

## Identity behavior

An identity is the relative file, rule id, diagnostic message and occurrence
number. Line and column do not form the identity, so moving unchanged code
within its file does not invalidate the baseline. Suppressed messages
participate in the same numbering.

This detects substitutions across files or messages. It cannot distinguish the
removal and replacement of the same rule/message occurrence in one file, and a
rename or a message change may need a reviewed migration. These are diagnostic
identities, not semantic source identities.

Count profiles are weaker by design: one repaired violation can offset one new
violation of the same rule anywhere in the scope. Choose them only to preserve
an existing count contract.

## Baseline growth

All profiles accept `--previous-baseline FILE` to reject new allowed debt
relative to a versioned predecessor. Identities compare set membership, so a
replacement with the same count still fails. Counts enforce non-increasing
budgets.

Baseline writes preserve comments and tracked zero rules. They use a
cooperative lock, an unchanged-input check, a temporary file and an atomic
replace. Imports never overwrite an existing file.

Fetch the required history in CI (`fetch-depth: 0`) or supply a trusted
`--previous-baseline`. A `no-history` result does not establish historical
non-regression.

## Golden defaults

Twelve rules apply to any consumer, independent of language or framework:

| Id | Rule |
| --- | --- |
| U1 | A change that adds a tracked violation fails the gate. |
| U2 | A baseline may only lose entries. Never raise one to make a change pass. |
| U3 | A suppressed or disabled diagnostic still counts as a violation. |
| U4 | A repaired violation must be removed from the baseline. |
| U5 | Every exemption is scoped to one rule, one location and one written reason. |
| U6 | One local command runs exactly the same checks as CI. |
| U7 | Generated artefacts reproduce with no diff. |
| U8 | Every gate has a fault and a control fixture proving both directions. |
| U9 | No secret value reaches a response, log, span, error or built artefact. |
| U10 | A published change carries a version bump and a changelog line. |
| U11 | A shared module mock keeps the real export surface. |
| U12 | Guarded code cannot opt out of the gate that guards it. |

`GOLDEN_RULES`, `assertGoldenRules()`, `assertGoldenProfiles()` and
`goldenProfile()` are exported. Profiles are supplied by your house rules;
the engine ships none.

## Custom rules

Use an ordinary ESLint rule. RatchetStrap consumes the resulting diagnostics by
rule id, so no separate rule language is involved. See the
[ESLint custom-rule documentation](https://eslint.org/docs/latest/extend/custom-rules).

## API

```ts
import {
  configureHouseRules,
  parseRatchetBaseline,
  checkBaseline,
  tightenBaseline,
  addRules,
  parseIdentityBaseline,
  evaluateIdentities,
  tightenIdentities,
} from "ratchet-strap";
```

The CLI is the supported surface for most users; the API mirrors it.

## Verification and limits

- Every gate has a fault and a control fixture in this repository's tests.
- The engine never downloads ESLint and never changes your configuration.
- A baseline grows only through a reviewed edit; `init`, `add` and `tighten`
  are the only writers, and each refuses to absorb an unrelated regression.
- Historical comparison requires the predecessor file or the Git history.

## License

MIT.
