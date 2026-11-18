# House rules

RatchetStrap is a mechanism, not a house style. The engine ships identities,
count budgets, the ESLint runner, the CLI and the twelve golden defaults
(`U1`–`U12`). Thresholds, named profiles, enabled golden profiles and adoption
recipes belong here, in a directory your repository owns.

## Use it

Copy this directory into your repository, then edit `quality.mjs` and
`golden.mjs`:

```bash
cp -R node_modules/ratchet-strap/house-rules ./house-rules
```

The CLI loads `./house-rules/index.mjs` when it exists. Point it elsewhere with
`--house-rules DIR`:

```bash
ratchet-strap rules --house-rules ./house-rules/index.mjs
```

Programmatic consumers pass the same module:

```ts
import { configureHouseRules } from "ratchet-strap";
import houseRules from "./house-rules/index.js";

configureHouseRules(houseRules);
```

Keep the directory in version control. It is the reviewed record of your
thresholds, your enabled profiles and your exclusions; a dependency upgrade
cannot change it silently.

## What belongs here

| File | Contents |
| --- | --- |
| `quality.mjs` | Named ESLint rule record and its versioned id. |
| `golden.mjs` | Opt-in golden profiles and the enabled set. |
| `index.mjs` | The module the CLI and API load. |

Profiles that encode a specific migration (a legacy count format, a nested
package layout) stay with the repository that owns that migration. The starter
keeps none: add them beside `quality.mjs` when you need them.
