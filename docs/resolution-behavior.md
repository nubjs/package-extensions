# How package managers treat an undeclared dependency

The measurements behind the dataset's field choices. Everything below was run against real package managers on a fixture built for the purpose, and every claim in the README traces here.

## What was measured

The fixture is a package whose manifest declares nothing at all and whose entry point requires something:

```json
{ "name": "phantom-fixture", "version": "1.0.0", "main": "index.js", "license": "MIT" }
```

```js
const isOdd = require('is-odd');
module.exports = { isOdd, ok: true };
```

Packed with `npm pack` and consumed as a `file:` tarball dependency, so both package managers treat it as an ordinary published package rather than a workspace link. Each cell is a fresh directory with no lockfile.

| Tool | Version |
| --- | --- |
| Node | 26.7.0 |
| Yarn Berry | 4.18.0, PnP linker |
| pnpm | 11.25.0, plus 9.15.9, 10.15.1 and 10.34.5 for the config-location rows |

The real-package rows use `object.hasown@1.1.4`, whose `index.js` requires `call-bind` while its manifest declares only `define-properties`, `es-abstract` and `es-object-atoms`.

## The decisive result

The consumer does **not** declare the missing package. This is the ordinary case for a package that simply forgot a dependency — nobody installing `es-abstract` has a reason to add `for-each` themselves.

| Extension on the offending package | Yarn PnP | pnpm, `hoist: false` |
| --- | --- | --- |
| none | fail | fail |
| `peerDependencies` + `peerDependenciesMeta.optional` | **fail** | **fail** |
| `dependencies` | pass | pass |

Yarn distinguishes the two failures, which is what makes the mechanism legible:

```
# no extension
Error: phantom-fixture tried to access is-odd, but it isn't declared in its
dependencies; this makes the require call ambiguous and unsound.

# optional-peer extension
Error: phantom-fixture tried to access is-odd (a peer dependency) but it isn't
provided by your application; this makes the require call ambiguous and unsound.
```

The extension applied. It just installs nothing, so there was still no copy to wire up. An optional peer fixes a phantom when the consumer already has the package, and never otherwise.

## Where the failure exists at all

Default settings hide most of this, which is why an entry can look inert on a first test.

- **Yarn's `enableTopLevelFallback` is on by default.** The generated `.pnp.cjs` consults `fallbackLocators`, which holds the top-level workspace, for any issuer outside `fallbackExclusionList`. The root project's own dependencies therefore satisfy any third-party package's phantom import, silently. Setting `pnpFallbackMode: none` turns this off.
- **pnpm hoists by default.** With `hoist: true` the whole graph is linked into `node_modules/.pnpm/node_modules`, which Node's upward walk reaches.
- **Node's own walk reaches the project root.** From `<proj>/node_modules/.pnpm/<pkg>@<v>/node_modules/<pkg>`, the walk yields `<proj>/node_modules` — so even with hoisting off, a single-project consumer's own dependencies satisfy a phantom. Moving the consumer to a workspace member breaks that path.

So the entries here bite under `pnpFallbackMode: none`, under pnpm with `hoist: false`, in a pnpm workspace member, and under any resolver that canonicalizes a package's realpath into a shared store.

## Where the setting lives

| pnpm | `pnpm-workspace.yaml` | `package.json` → `pnpm.packageExtensions` |
| --- | --- | --- |
| 11.25.0 | honored | **ignored** |
| 10.34.5 | honored | honored |
| 10.15.1 | honored | honored |
| 9.15.9 | **ignored** | honored |

Version 10 is the only major that reads both, so it is the hinge: 9 accepts the `package.json` form alone and 11 accepts the workspace form alone. Neither file works everywhere, which is why both ship.

The 9 and 10.34.5 rows were measured by extending `is-odd` with a dependency on `is-even` and checking whether `pnpm-lock.yaml` picked it up — a positive signal that needs no phantom, so it cannot pass for the wrong reason. Version 9 produced no warning for the workspace-file form; it simply ignored it.

Version 11 warns rather than failing, so a dataset published only in the `package.json` shape would silently do nothing:

```
[WARN] The "pnpm" field in package.json is no longer read by pnpm. The following
keys were ignored: "pnpm.packageExtensions". See https://pnpm.io/settings for the
new home of each setting.
```

The workspace file is the single form that works on both current majors, but it is not universal: a project still on pnpm 9 needs the `package.json` form.

## Entry shapes, and what each package manager tolerates

| Question | Yarn 4.18.0 | pnpm 11.25.0 |
| --- | --- | --- |
| Is `peerDependenciesMeta` alone enough, with no paired `peerDependencies`? | works | works — the lockfile shows the missing half synthesized |
| A redundant entry, duplicating something the manifest already declares | `YN0069` warning, exit 0 | silent, exit 0 |
| A key whose range matches nothing, such as `pkg@^99.0.0` | `YN0068` warning, exit 0 | silent, not applied |
| An unbounded `pkg@*` key | accepted | accepted |
| An exact `pkg@1.1.4` key | accepted | accepted |

Both tolerate a meta-only entry today, but neither documents it as a contract, so this dataset writes both peer fields. Nothing in the table errors, which is what makes a generated list safe to paste: a stale or over-broad entry costs a warning at worst.

## Reproducing

Each cell installs and runs separately, capturing the two exit codes independently rather than through a pipe:

```sh
<pm> install --ignore-scripts > install.log 2>&1; INSTALL_EXIT=$?
node test.cjs > run.log 2>&1; RUN_EXIT=$?
```

The Yarn cells vary one setting in `.yarnrc.yml` (`pnpFallbackMode`), the pnpm cells one setting in `pnpm-workspace.yaml` (`hoist`), and each pair of extension cells differs by exactly the `packageExtensions` block.
