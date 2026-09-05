# package-extensions

Undeclared dependencies across the 10,000 most-downloaded packages on npm, published as a `packageExtensions` database that pnpm and Yarn read directly.

A package has an undeclared dependency when its published code imports a package its own manifest never lists. Under npm's flat `node_modules` the import finds a copy something else installed. Under Yarn Plug'n'Play, or pnpm with hoisting off, there is nothing to find and the import throws.

```yaml
# .yarnrc.yml — two entries from dist/yarnrc.yml
packageExtensions:
  "@nrwl/devkit@*":
    dependencies:
      tslib: "*"                    # index.js requires it and nothing declares it
  "@hookform/resolvers@*":
    peerDependencies:
      zod: "*"                      # the consumer picked zod; only wire it up
    peerDependenciesMeta:
      zod:
        optional: true
```

The current scan covers 9,982 packages and finds **888 with an undeclared dependency, across 1,501 edges**. Yarn's own hand-curated database carries 125 entries.

## Using it

The setting has a different home in each package manager, so the same data ships three ways. Copy the block from the matching file and merge it into your own config, then re-run the install — pnpm records a `packageExtensionsChecksum` in the lockfile, and Yarn applies extensions at resolution time.

| Package manager | File to merge into | Source |
| --- | --- | --- |
| Yarn Berry (2+) | `.yarnrc.yml` | [`dist/yarnrc.yml`](dist/yarnrc.yml) |
| pnpm 10 and 11 | `pnpm-workspace.yaml` | [`dist/pnpm-workspace.yaml`](dist/pnpm-workspace.yaml) |
| pnpm 10 and earlier | the `pnpm` block of `package.json` | [`dist/pnpm-package.json`](dist/pnpm-package.json) |

Prefer the workspace file on any pnpm 10 or newer. Version 11 dropped the `package.json` home and says so on stderr rather than failing:

```
[WARN] The "pnpm" field in package.json is no longer read by pnpm. The following
keys were ignored: "pnpm.packageExtensions".
```

Both package managers merge an extension *under* the real manifest, so an entry for a package that has since declared the dependency itself loses to the manifest. A stale entry is a no-op in pnpm and a `YN0069` warning in Yarn, never an error.

The Yarn file also carries a `logFilters` block, which is load-bearing at this size. Yarn reports `YN0068` for every entry whose package is absent from your tree, twice per entry, so a database covering 888 packages buries the install log:

| Install of a two-dependency project | Log lines | `YN0068` |
| --- | --- | --- |
| dataset pasted as-is | 2,957 | 2,943 |
| with the `logFilters` block | 14 | 0 |

The extensions still apply either way. `YN0069` is deliberately left on — that one reports an entry a package has since made redundant, which is actionable, and is how an entry gets retired. pnpm needs no filter; it is silent about an extension that matches nothing.

npm has no equivalent setting and needs none. Its flat layout is what makes these imports resolve in the first place.

### What it fixes, end to end

Installing `@nrwl/devkit` under Yarn PnP, with nothing else changed but the contents of `dist/yarnrc.yml`:

```
# without the dataset
Error: @nrwl/devkit tried to access tslib, but it isn't declared in its
dependencies; this makes the require call ambiguous and unsound.

# with it
loaded ok, exports: 69
```

The same package in a pnpm workspace member with `hoist: false` behaves the same way. That case exercises both halves of the dataset at once: `tslib` resolves through a reviewed `dependencies` entry, and `nx` through an optional peer the consumer supplies.

## The four classes

Each finding is classed by where the import sits. The class decides which manifest field the entry uses, and both are recorded per entry in [`package-extensions.json`](package-extensions.json).

| Class | Count | Shape | Field |
| --- | --- | --- | --- |
| `types` | 840 | Only a `.d.ts` references it. No runtime edge at all. | optional peer |
| `guarded` | 273 | Every occurrence sits inside a try/catch or a conditional branch. | optional peer |
| `runtime` | 258 | The main entry graph imports it, unguarded. | optional peer, or `dependencies` once reviewed |
| `adapter` | 130 | A non-`.` exports subpath imports a backend the consumer chose. | optional peer |

Two of these are easy to misread. A `types` finding breaks a type-check and nothing else, so it is never treated as a missing runtime dependency — it is also the largest class, and folding it into `runtime` would have put 840 declaration-file imports into the review queue. A `guarded` import looks harmless in the other direction: the package survives absence by design, but under a strict layout the guard swallows a resolution error that fires even when the consumer *has* the package, so the feature silently stays off.

## Why the field differs, measured

An optional peer installs nothing. It tells the resolver a package may reach for a name, which fixes a phantom exactly when the consumer already has that package, and does nothing otherwise.

That is not a design preference. It was measured against Yarn 4.18.0 in PnP mode and pnpm 11.25.0 with `hoist: false`, on a fixture whose manifest declares nothing and whose entry point requires `is-odd`, with the consumer **not** declaring `is-odd`. The full matrix and the mechanisms are in [`docs/resolution-behavior.md`](docs/resolution-behavior.md).

| Extension | Yarn PnP | pnpm |
| --- | --- | --- |
| none | fail | fail |
| optional peer | **fail** | **fail** |
| `dependencies` | pass | pass |

Yarn names the reason exactly:

```
Error: phantom-fixture tried to access is-odd (a peer dependency) but it isn't
provided by your application; this makes the require call ambiguous and unsound.
```

So the two fields fix different problems, and using either one everywhere gets a large part of the dataset wrong. A package that forgot a dependency needs a real `dependencies` entry, because nobody else is going to install `tslib` for `@nrwl/devkit`. A backend the consumer picked needs an optional peer, because emitting `dependencies` for `@hookform/resolvers` would install all twenty-two validation libraries it can adapt.

Both peer fields are always written together. Marking a peer optional needs a peer to mark, and on a target the package never declared, `peerDependenciesMeta` alone has nothing to apply to.

### Why `dependencies` is reviewed rather than generated

Which of the two a finding needs is not decidable from the finding. Generating `dependencies` for the whole `runtime` class was tried, and the output contained entries that would do real damage:

| Offender and target | What it actually is |
| --- | --- |
| `es-abstract` → `for-each` | a genuinely forgotten dependency |
| `unzipper` → `@aws-sdk/client-s3` | an optional integration nobody asked for |
| `requirejs` → `lang` | not a package at all |

The last one is the sharpest. RequireJS's published bundle calls `define('lang', …)` and requires the id back, so the specifier is indistinguishable from a package reference — and an unrelated package named `lang` really is published, so even a registry check passes it. Installing it would put a stranger's code into every consumer's tree.

So every finding ships as an optional peer, which is inert when the consumer lacks the target but never wrong. A `dependencies` entry comes only from [`harness/overrides.json`](harness/overrides.json), where each one records what reading the package showed. The **160 candidates** the policy would otherwise promote are listed in `package-extensions.json` under `candidates`, which is the review queue. Read one with the source in front of you:

```sh
node harness/inspect.mjs @firebase/database @firebase/app
node harness/inspect.mjs --queue 20
```

### Version ranges

Every key carries an unbounded `@*` range. The scan measures one version — whatever `latest` was that day — so a narrower range would assert something about versions nobody looked at. Yarn additionally rejects a key with no range at all. Both accept `@*` without complaint.

## What counts as undeclared

A bare import in the package's **published, reachable** code that no field of its manifest covers. Reachable means the module graph walked from `exports`, `main` and `bin`, so a `devDependencies` import in a test file nobody publishes a path to is never counted.

Not counted, because each one resolves or is already declared:

- Node builtins, and any `node:` specifier.
- A self-reference, a `#imports` subpath, or a bundled dependency.
- Anything in `dependencies`, `optionalDependencies` or `peerDependencies`, including a peer already marked optional.
- Type-only imports, which erase before runtime.
- URLs, framework virtuals such as `$app/env`, and other runtimes' internals.

The detector is [`nub-phantom`](https://github.com/nubjs/nub/tree/main/crates/nub-phantom), which parses each published tarball with the same oxc parser Nub transpiles with. Filtering matters more than finding: across the corpus a naive "is this specifier declared?" scan flags 2,478 edges where 1,287 are real, and the difference is 745 declared optional peers and 446 guarded loads.

**Every target is checked against the registry before it is emitted.** The detector reads specifiers out of source, so a typo, an unpublished name and a private-registry package all reach it looking like real dependencies. An extension naming a package that does not exist fails a Yarn install outright, which makes this the one gate whose failure is user-visible breakage. It also catches the largest single source of noise: N-API loaders probe for platform packages such as `@napi-rs/canvas-openharmony-arm` that were never published for that platform.

## Regenerating

```sh
npm install

# Scan the corpus. Needs a nub-phantom build from nubjs/nub.
nub-phantom scan --top 10000 --concurrency 8 --json > records/<run>/scan.json

node harness/build.mjs --scan records/<run>/scan.json   # -> package-extensions.json
node harness/emit.mjs                                    # -> dist/
node harness/verify.mjs                                  # gate
```

The workflow in [`.github/workflows/rebuild.yml`](.github/workflows/rebuild.yml) runs all four against a pinned `nubjs/nub` commit, monthly and on demand. Each run keeps its raw detector output and a `meta.json` naming that commit under `records/`, so a published entry traces back to the scan that produced it.

Regeneration is also what keeps the dataset from rotting. Packages fix their manifests: `@hookform/resolvers` declared twenty-two optional peers between version 5.4.0 and 5.9.1, and every one of its entries disappeared from the next scan.

The gate is where a generated dataset is worth trusting or is not. Every check in `verify.mjs` either compares generator output against a real consumer parser or refuses a document that is structurally fine and empty — a well-formed file that says nothing is the failure mode a shape test passes forever.

## Limits

- **One version per package.** The scan reads whatever `latest` resolved to, so a package that fixed its manifest last week still appears until the next regeneration.
- **Guards are lexical.** An import inside a function body a consumer only calls on demand is classed `runtime`, because the classifier reads syntax rather than control flow. It errs toward calling a load unconditional.
- **A dynamic specifier is invisible.** Only a string literal is recorded, so `require(name)` and a template literal are missed. The list undercounts.
- **An AMD module id is indistinguishable from a package.** A bundle that calls `define('name', …)` and requires the id back produces a finding for a package it never meant. Those stay optional peers, where they are inert.
- **Default settings hide most of this.** Yarn's `enableTopLevelFallback` lets the root project's own dependencies satisfy any package's phantom import, and pnpm hoists into `node_modules/.pnpm/node_modules` unless told not to. The entries here matter under `pnpFallbackMode: none`, under pnpm with `hoist: false`, in a pnpm workspace member, and under any resolver that canonicalizes paths into a shared store.
- **Nothing here is a bug report.** An undeclared dependency that resolves under a flat layout is not a defect in the package, and most of these entries describe code that works correctly everywhere its author tested it. Where an entry belongs upstream, the fix is a pull request to that package.

## Related

[Yarn's own database](https://github.com/yarnpkg/berry/blob/master/packages/yarnpkg-extensions/sources/index.ts) ships inside Yarn and carries 125 hand-curated entries, each pinned to the version range a merged upstream pull request later fixed. It is the model for this one and covers a different set: those entries are mostly historical, bounded above by the release that fixed them, while a generated scan finds what is broken in the current release.

Nub uses this data to decide which packages need a project-local copy under its global virtual store. The database is published separately because the finding is about the ecosystem rather than about any one package manager.
