<p align="center">
  <img src="assets/ratchet-strap.png" alt="RatchetStrap" width="180">
</p>

<h1 align="center">RatchetStrap</h1>

<p align="center">
  <em>A ratchet for lint debt. New violations fail, repaired ones must be removed,<br>and the baseline only ever shrinks.</em>
</p>

<p align="center">
  <sub>Deterministic set comparison. No LLM, no network, no source parsing.</sub>
</p>

<p align="center">
  <a href="https://github.com/chester-hill-solutions/ratchet-strap/actions/workflows/ci.yml"><img alt="CI" src="https://github.com/chester-hill-solutions/ratchet-strap/actions/workflows/ci.yml/badge.svg"></a>
  <img alt="Node" src="https://img.shields.io/badge/node-%3E%3D20.11-brightgreen">
  <a href="LICENSE"><img alt="MIT" src="https://img.shields.io/badge/license-MIT-blue"></a>
  <img alt="status" src="https://img.shields.io/badge/status-pre--release-orange">
</p>

---

ESLint finds violations. RatchetStrap compares them with a baseline you review
and commit. An identity that is not in the baseline fails the gate; an identity
that no longer appears must be tightened out. The baseline is compared with a
trusted revision, so it cannot be raised to make a change pass.

The engine is deliberately opinion-free: thresholds, named profiles and enabled
golden rules live in a `house-rules/` directory your repository owns.

> **Not a linter.** RatchetStrap ships no rules and never reads your source.
> ESLint detects; RatchetStrap ratchets the report. If you do not run ESLint,
> there is nothing here to ratchet.

```console
$ ratchet-strap check --exec-eslint
{
  "ok": false,
  "mode": "identities",
  "added": {
    "max-params": [
      "src/mail.js:max-params:Function 'sendMessage' has too many parameters (6). Maximum allowed is 5.#1"
    ]
  },
  "stale": {}
}
$ echo $?
1
```

## The model

**ESLint finds violations. The baseline records the ones you have agreed to live
with. Every run proves the difference did not grow.**

That is the whole product. Three outcomes:

| What the report shows | What it means | Gate |
| --- | --- | --- |
| A violation that is **not** in the baseline | New debt | **fail** |
| A baseline entry that **did not** appear | You repaired it, but the allowance is still there | **fail** until tightened |
| A baseline that grew relative to a trusted revision | Someone raised the allowance | **fail**, whatever the report says |

There is no "pass with new warnings". A green run means the baseline and the
report still describe the same debt, and that the baseline has not grown since
the last reviewed revision.

## Why

Coding agents are good at making a red check green. Left alone they mock the
thing under test, sleep until a race usually goes their way, retry the flake,
raise the timeout, or add an `// eslint-disable`. Every one of those passes CI.

RatchetStrap is built so the shortcut is *also* a gate failure:

| Shortcut | What RatchetStrap does |
| --- | --- |
| Fix the code but leave the allowance | `stale` entry fails until `tighten` |
| Add a violation somewhere else | `added` identity fails |
| Disable the rule inline | Suppressed diagnostics still count |
| Add the new identity to the baseline | Predecessor comparison fails |
| Raise a count budget | Counts are non-increasing |
| Rerun until it passes | The comparison is deterministic |

## What it actually does

RatchetStrap is a deterministic Node script. It never reads your source. It
reads the JSON ESLint already produced and compares it with a committed file.

| Actor | Tests | How |
| --- | --- | --- |
| **ESLint** | your code against its rules | AST and rule implementations |
| **RatchetStrap** | ESLint's report against the baseline | exact string set comparison |
| **the test suite** | RatchetStrap itself | `bun test`, 92 deterministic tests |

```text
report = spawn(eslint) | read(--report)

for file in report:
  for message in file.messages ++ file.suppressedMessages:
    if message.ruleId not in baseline.rules: continue
    key = "${relative(file)}:${ruleId}:${message.message}"
    id  = "${key}#${++occurrences[key]}"
    current[ruleId].add(id)

added = current − baseline
stale = baseline − current
ok    = added.empty && stale.empty && errors.empty && growth.empty
exit  ok ? 0 : 1
```

`spawn` is the only execution. ESLint does the parsing and the rule logic;
RatchetStrap does set arithmetic on strings and writes one local JSON file.

- **No LLM, no model call, no embeddings.** There is nothing to be
  non-deterministic about: same report plus same baseline gives the same answer.
- **No network.** Reports are read from disk or from the child process; baselines
  are written locally.
- **No regex over your code.** One regex exists in the matching path:
  `/\d+/`, used only to pair a lower metric in a message (complexity 21 → 19)
  with the recorded identity instead of calling it new debt.
- **Hard errors still fail.** An unsuppressed severity-2 diagnostic fails
  regardless of the baseline.
- **When a predecessor is supplied** (`--previous-baseline`), the baseline is
  checked against it, so an agent cannot add an identity and pass.

What it does **not** do: run your tests, judge whether a rule is correct, decide
whether a suppression is honest, or inspect source. Those are ESLint's job, your
review's job, or a test-honesty linter's job.

## ESLint in one minute

RatchetStrap is a ledger for ESLint. It contains no lint rules.

1. **You give ESLint a config.** A flat config names the files, the parser, the
   plugins and the rules.
2. **ESLint parses each file into a tree** (an AST) and runs the rules you
   enabled. A rule is ordinary JavaScript that visits nodes.
3. **A rule reports a message** with a rule id, a severity, text and a position.
4. **ESLint prints the report.** With `--format json` it is one array of files,
   each with `messages` and `suppressedMessages`. That array is the entire input
   RatchetStrap sees.

A rule is small enough to read:

```js
// eslint.config.mjs — deliberately crude: flags every useEffect
const house = {
  rules: {
    "no-derived-effect": {
      meta: { messages: { derived: "Compute this during render." } },
      create(context) {
        return {
          CallExpression(node) {
            if (node.callee.type === "Identifier" && node.callee.name === "useEffect") {
              context.report({ node, messageId: "derived" });
            }
          },
        };
      },
    },
  },
};

export default [{
  files: ["**/*.tsx"],
  plugins: { house },
  rules: { "house/no-derived-effect": "warn" },
}];
```

That produces:

```json
[{
  "filePath": "/repo/src/profile.tsx",
  "messages": [{
    "ruleId": "house/no-derived-effect",
    "severity": 1,
    "message": "Compute this during render.",
    "line": 4,
    "column": 3
  }],
  "suppressedMessages": []
}]
```

- **Built-in rules** include `no-console`, `complexity`, `max-params` and
  `no-restricted-syntax`. **Plugin rules** (`react-hooks/*`,
  `@typescript-eslint/*`) come from packages. **House rules** like
  `house/no-derived-effect` are local plugins in your repository.
- `"warn"` does not fail ESLint by itself; that is why an agent can ignore it.
  RatchetStrap treats a tracked warning as debt and fails the gate when it grows.
  `"error"` fails regardless of the baseline and is not grandfathered.
- `// eslint-disable-next-line house/no-derived-effect` moves the message to
  `suppressedMessages`. RatchetStrap counts both arrays, so the debt remains.

The two examples above are house rules. RatchetStrap does not know what a
`useEffect` or a boolean is; it knows the rule id and the message.

## Two examples

The detectors are your house rules; RatchetStrap ships none. These are the
findings a warning-only setup never fixes, and they are what the baseline is for.

### 1. The effect that should be a value

**Before**

```tsx
const [fullName, setFullName] = useState("");
useEffect(() => {
  setFullName(`${first} ${last}`);
}, [first, last]);
```

The house rule reports:

```text
src/profile.tsx:house/no-derived-effect:This effect derives state from props. Compute it during render; an effect adds a render pass and a stale frame.#1
```

The rule is tracked and the baseline has no allowance for this identity, so
`check` says:

```json
{
  "ok": false,
  "added": {
    "house/no-derived-effect": ["src/profile.tsx:...#1"]
  }
}
```

`exit 1`. The rule stays on; disabling it moves the diagnostic to
`suppressedMessages`, where it still counts.

**After**

```tsx
const fullName = `${first} ${last}`;
```

The diagnostic is gone. If it had already been in the baseline, the entry would
now be `stale`, and `tighten --write` would be the reviewed act that removes it.

### 2. The implicit state machine

**Before**

```tsx
const [loading, setLoading] = useState(false);
const [error, setError] = useState<Error | null>(null);
const [data, setData] = useState<Data | null>(null);
```

The house rule reports:

```text
src/order.tsx:house/explicit-state-machine:Three booleans encode an implicit state machine. Replace them with a discriminated union and a named event reducer.#1
```

`check` fails the same way: the identity is not in the baseline.

```json
{
  "ok": false,
  "added": {
    "house/explicit-state-machine": ["src/order.tsx:...#1"]
  }
}
```

`exit 1`. `loading && error` is representable today, and the rule is only a
warning until the ratchet holds it.

**After**

```tsx
type OrderState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "ready"; data: Data }
  | { status: "failed"; error: Error };
```

Three booleans with eight combinations and several impossible ones become four
states. The diagnostic is gone; an old baseline entry would be `stale` until
tightened.

Both examples are ordinary ESLint findings. The rule IDs are house-rule names,
not detectors bundled here. What RatchetStrap adds is that the new finding fails,
the repaired one must be recorded, and neither can be hidden by suppressing it
or editing the baseline.

## Matching, precisely

An identity is a string:

```text
app/mail.js:max-params:Function 'sendMessage' has too many parameters (6). Maximum allowed is 5.#1
└─────┬────┘ └───┬────┘ └──────────────────────────┬──────────────────────────────────┘ └┬┘
      file      rule                            message                              occurrence
```

- **File** is relative to `--root`, with forward slashes. Duplicate file results in
  one report are rejected.
- **Only tracked rules** get identities. An untracked warning is ignored; an
  unsuppressed error always fails.
- **Occurrence** counts identical `(rule, file, message)` triples in report order,
  across `messages` then `suppressedMessages`. Suppressing a diagnostic moves
  it between those arrays without changing its key, so the identity survives.
- **Line and column are not in the key.** Moving code, reordering imports or
  reformatting inside the file does not invalidate the baseline.
- Comparison is exact set difference per rule: present-now-but-not-in-baseline is
  `added`; in-baseline-but-not-present is `stale`. Both fail.

| Edit | Identity result |
| --- | --- |
| Move the function down 40 lines | unchanged → pass |
| Add a second identical warning | new `#2` → `added` → fail |
| Remove one of two identical warnings | `#2` disappears → `stale` → fail until tightened |
| Suppress the warning | same key, now suppressed → unchanged → still counted |
| Rename the file or change the message | old is `stale`, new is `added` → fail |
| Lower an embedded metric (complexity 21 → 19) | paired as an improvement, not new debt |

That last case is the one concession to cleverness. An identity embeds its
metric, so a lower number would otherwise look like one new identity plus one
stale one. `reconcileImprovements` pairs a candidate with a stale identity that
has the same shape and exactly one lower number. A higher number stays `added`.

Counts mode does not do any of this: it compares per-rule totals, so one repair
can offset one new violation of the same rule. That is why identities are the
default and counts are opt-in.

## A worked example

Suppose the baseline carries one known violation:

```json
{
  "schemaVersion": 2,
  "mode": "identities",
  "adapter": "eslint-identities@1",
  "identities": {
    "max-params": [
      "app/mail.js:max-params:Function 'sendMessage' has too many parameters (6). Maximum allowed is 5.#1"
    ]
  }
}
```

Someone adds a second six-parameter function and refactors the first one. The
report now has one new diagnostic and none of the old one:

```console
$ ratchet-strap check --report eslint-report.json
{
  "ok": false,
  "added": {
    "max-params": [
      "app/notify.js:max-params:Function 'notify' has too many parameters (6). Maximum allowed is 5.#1"
    ]
  },
  "stale": {
    "max-params": [
      "app/mail.js:max-params:Function 'sendMessage' has too many parameters (6). Maximum allowed is 5.#1"
    ]
  }
}
$ echo $?
1
```

Two separate facts, both true: new debt arrived, and the recorded debt was
repaired. The gate is red until both are dealt with:

```bash
# remove the new debt, then record the repair
ratchet-strap tighten --exec-eslint --write
```

`tighten` recomputes the baseline from the current report. It refuses if the
report contains a new identity, an ESLint error or baseline growth, so it cannot
be used to launder a regression.

## Two counting modes

| Mode | Identity | Detects | Cannot distinguish |
| --- | --- | --- | --- |
| `identities` **default** | file + rule + message + occurrence | A new occurrence anywhere; a repair must be tightened out | Removal and replacement of the same occurrence in one file |
| `counts` | per-rule total | Growth beyond the recorded budget | One repair offsetting one new violation of the same rule |

New projects should use identities. Count profiles exist to preserve a gate that
already exists, and every legacied profile pins its adapter in the baseline.
There is no implicit conversion between the two.

## Install

```bash
npm install --save-dev @chester-hill-solutions/ratchet-strap
# or
bun add --dev @chester-hill-solutions/ratchet-strap
```

Requires Node 20.11 or later.

## Quick start

Enable the rules you want to ratchet in your ESLint flat config, then record the
existing debt once:

```bash
ratchet-strap init --rules no-console,complexity --exec-eslint
ratchet-strap check --exec-eslint
```

After repairing debt:

```bash
ratchet-strap tighten --exec-eslint         # preview the removal
ratchet-strap tighten --exec-eslint --write # apply it
```

After enabling another rule:

```bash
ratchet-strap add --rules no-alert --exec-eslint --write
```

Already have a report? Skip the runner:

```bash
eslint . --format json --no-cache --output-file eslint-report.json
ratchet-strap check --report eslint-report.json
```

## House rules

Copy the starter and edit it:

```bash
cp -R node_modules/@chester-hill-solutions/ratchet-strap/house-rules ./house-rules
```

```js
// eslint.config.mjs
import { houseRules } from "./house-rules/index.mjs";

export default [
  { files: ["**/*.{ts,tsx}"], rules: { ...houseRules.policy.rules } },
];
```

The CLI loads `./house-rules/index.mjs` by default; use `--house-rules FILE`
to point elsewhere. Programmatic consumers call `configureHouseRules()`.

| File | Contents |
| --- | --- |
| `quality.mjs` | A named ESLint rule record and its versioned id. |
| `golden.mjs` | Opt-in golden profiles and the set you enable. |
| `index.mjs` | The module the CLI and API load. |

Keep it in version control: a package upgrade cannot change your thresholds,
your enabled profiles or your exclusions.

## Profiles

| Profile | Adapter | Comparison |
| --- | --- | --- |
| `eslint@1` **default** | `eslint-identities@1` | New and stale identities fail |
| `eslint-counts@1` | `eslint-json@1` | Per-rule warning and suppressed counts cannot grow |

New projects should use `eslint@1`. A project that already has a count gate can
adopt `eslint-counts@1` deliberately; baselines pin their adapter, and there is
no implicit conversion between counts and identities.

## Commands

| Command | Does |
| --- | --- |
| `init` | Create a baseline from explicit rules and current debt |
| `check` | Fail on new debt or a stale entry; never writes |
| `tighten` | Remove repaired entries; preview unless `--write` |
| `add` | Track another rule and accept only its initial debt |
| `inspect` | Print the baseline, profile and tracked rules |
| `rules` / `profiles` | Print the configured policy and profiles |

Output is JSON. Exit codes: `0` passed, `1` violations or new debt,
`2` invalid input or tool failure. `--previous-baseline FILE` rejects growth
against a versioned predecessor; fetch full history in CI (`fetch-depth: 0`).

## Golden defaults

<details>
<summary>Twelve rules every consumer follows, with the mechanism that proves each one.</summary>

| Id | Rule | Enforced by |
| --- | --- | --- |
| U1 | A change that adds a tracked violation fails the gate. | Engine: `check` compares report and baseline |
| U2 | A baseline may only lose entries. Never raise one to make a change pass. | Engine: predecessor growth guard |
| U3 | A suppressed or disabled diagnostic still counts as a violation. | Engine: suppressed diagnostics are counted; unsuppressed errors fail |
| U4 | A repaired violation must be removed from the baseline. | Engine: a stale entry fails until `tighten` |
| U5 | Every exemption is scoped to one rule, one location and one written reason. | Review: the exemption is scoped and recorded |
| U6 | One local command runs exactly the same checks as CI. | Consumer: one command, local and CI |
| U7 | Generated artefacts reproduce with no diff. | Consumer: a build-and-diff check |
| U8 | Every gate has a fault and a control fixture proving both directions. | Consumer: a fault and a control fixture per gate |
| U9 | No secret value reaches a response, log, span, error or built artefact. | Consumer: a secret scan over code and artefacts |
| U10 | A published change carries a version bump and a changelog line. | Consumer: a version and changelog gate |
| U11 | A shared module mock keeps the real export surface. | Consumer: a mock detector |
| U12 | Guarded code cannot opt out of the gate that guards it. | Review: the gate configuration is protected |

</details>

The table is honest about the boundary: four rules are proved by this engine,
the rest by the consumer's checks or review. `GOLDEN_RULES` carries the same
`enforcement` metadata, and `assertGoldenRules()` refuses a rule with none.

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
} from "@chester-hill-solutions/ratchet-strap";
```

The CLI is the supported surface for most users; the API mirrors it.

## Limits

- The engine never downloads ESLint and never changes your configuration.
- Historical comparison requires the predecessor file or the Git history.
- Identities are diagnostic, not semantic: a rename or a message change can
  require a reviewed migration.
- Count profiles are weaker by design; one repaired violation can offset one new
  violation of the same rule. Prefer identities.

## How it is tested

The gate is tested the way it tests a project: with a fault and a control.

- **92 tests in 8 files** (`bun test src/`), run with typecheck and build in CI
  on every push and pull request.
- Identity and count comparisons have a fixture that must fail and a control
  that must pass. The golden set makes that a requirement: U8 says every gate
  needs both directions.
- CLI tests spawn the real CLI in throwaway directories with real report files
  and a fake ESLint executable. They assert the exit code (0/1/2), the JSON
  output, and that a failed run left the baseline byte-identical.
- Baseline writers are tested against the lock, an interrupted write, unchanged
  input and a refused overwrite.
- The golden defaults and the house-rules loader have their own tests.

A consumer should keep the same pair around its gate: a planted violation that
must exit 1, a clean report that must exit 0, and a raised baseline that must
exit 1 through the growth guard.

## Contributing

Issues and pull requests are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md) and
[SECURITY.md](SECURITY.md). Run the same checks as CI:

```bash
bun install
bun run typecheck && bun run build && bun run test
```

## License

MIT. See [LICENSE](LICENSE).
