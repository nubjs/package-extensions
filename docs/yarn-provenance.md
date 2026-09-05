# Where Yarn's entries came from, and what a scan can reach

Yarn's `@yarnpkg/extensions` is the reference this dataset is measured against, so how its 159 entries were produced decides what agreement with it can possibly mean. They were not scanned. Every one traces to a person whose install broke.

## The list is a ledger of bug reports

Fifty-five commits touch the list across its two homes — `packages/plugin-compat/sources/extensions.ts` until May 2022, `packages/yarnpkg-extensions/sources/index.ts` after. Reading their messages in order gives the shape immediately:

```
2020-01-23  Adds builtin package extensions (#733)
2020-01-27  feat(compat): add @pm2/agent to extensions (#805)
2020-07-30  fix(compat): add ink-select-input extensions (#1645)
2020-08-08  fix(compat): add `promise-inflight` to extensions (#1680)
2021-01-20  chore(compat): add testcafe extensions (#2381)
2021-02-14  chore(compat): add @google-cloud/firestore@<=4.9.3 extensions (#2478)
2024-11-12  fix(extensions): notistack@^3.0.0 (#6593)
2026-07-26  fix(extensions): declare the `typescript` peer for the Volar packages (#7232)
```

The founding PR states the purpose plainly: *"Some packages don't properly list their dependencies, and it's painful to fix that for everyone. We should have a way to fix it once for each package, especially if they are popular."*

Individual entries name their trigger. TestCafe's (#2381) opens *"TestCafe won't run with Yarn 2, because of missing dependencies that aren't explicitly listed"* and links two upstream pull requests. The notistack entry (#6593) links notistack issue 551. The periodic `update list` batches are not automation — #4020 lists three upstream pull requests by URL.

Two consequences follow, and they govern every comparison in this repo.

**Coverage follows attention, not usage.** A package is on Yarn's list because somebody hit it and filed. Popular packages are over-represented, and a package nobody has used under Plug'n'Play is absent however broken it is. A scan has the opposite bias: it covers a ranked corpus uniformly and knows nothing about who was hurt.

**Entries outlive their cause.** A rule is usually capped when upstream fixes the package — `debug@<4.2.0` — but an unbounded one keeps applying after the reference is gone. Yarn carries `notistack@^3.0.0 → csstype`; notistack 3.0.2 ships eleven files with zero `csstype` references. Nothing retires it, because a stale extension costs only a `YN0069` warning.

## What a scan cannot reach

Of Yarn's 159 entries, 98 are outside the top-10,000 corpus, 43 no longer apply to the current version, and one only marks an already-declared peer optional. That leaves 17 entries where the rule still describes the scanned version. Splitting their edges by what the published source actually contains:

| | Edges | Can a scan find it? |
| --- | --- | --- |
| found | 8 | yes, and it did |
| dynamic specifier | 10 | **no** |
| literal reference, missed | 4 | two of them, in principle |
| target never referenced | 6 | nothing to find |

The agreement figure is **8 of 22**: the six never-referenced edges are excluded from the denominator, because there is nothing in the source for any detector to find.

The four-edge row is an upper bound, and checking each one halves it. Two are real misses:

- `useragent → semver` — `features/index.js:7` reads `, semver = require('semver')` against two declared dependencies. Nothing in the published tree references that file, so it is reachable only as a legacy deep path.
- `volar-service-typescript-twoslash-queries → typescript` — the package's entire declaration surface is `create(ts: typeof import('typescript'))`. A type-position `import()` is a distinct syntax from an import statement, and the detector did not read it.

The other two are quoted strings that are not imports at all:

- `vite-plugin-vue-devtools → vue` — the only hits are `"vue"` inside minified client bundles under `client/assets/`, which is payload.
- `eslint-plugin-import → @typescript-eslint/parser` — the only hit is an object key in `config/typescript.js`, naming a parser for ESLint to resolve. The package requires it nowhere.

Both survive a boundary-correct grep because a grep cannot tell a specifier from any other string. Separating them needs the parse, which is the limit noted at the end of this document.

**Dynamic specifiers are the hard floor.** `eslint-module-utils` loads resolvers as `` tryRequire(`eslint-import-resolver-${name}`) ``; `postcss-syntax` reaches its five syntaxes through `require(id + "/template-parse")` with `id` computed. Only the static prefix survives parsing, and completing it by enumerating the registry is not sound — `postcss-` matches thousands of published names, and over-inclusion breaks installs rather than merely bloating them. Curation is the only correct answer here, which is what Yarn did.

**Never-referenced entries are not a gap at all.** Six edges name a target the published source does not mention anywhere. A detector that stayed silent was right, so these are excluded from the agreement denominator rather than charged against it.

## The instrument needed correcting more than the detector did

The first version of this comparison reported 6 of 28 edges. Four separate defects in the comparison itself, not in the detector, account for most of the difference:

1. **It charged the detector for entries whose target the source never names.** Fixed by fetching the published tarball and checking. Six edges moved out of the denominator.
2. **It matched only `'` and `"` when testing whether a name appears.** A dynamic specifier is written with backticks, so `` `eslint-import-resolver-${name}` `` scored as never-referenced — which *improved* the reported score by hiding four real misses.
3. **It matched a name without a closing boundary.** `'typescript` also matches `'typescript-eslint'`, so any package whose name prefixes another scored as a literal reference: `eslint-config-react-app` and `react-dev-utils` both reported imports they do not have. Fixed by requiring a closing delimiter or a subpath slash, with the boundary cases unit-tested.
4. **A quoted string is still not an import.** `vite-plugin-vue-devtools` reaches the literal row because minified bundles under `client/assets/` contain `"vue"` as payload; `eslint-plugin-import` reaches it because an ESLint config names a parser as an object key. Unfixed, and the reason the four-edge row is an upper bound — half of it, as it turned out. Settling it needs the parse, not a grep.

Three of these four moved the number in *our* favour, and the second and third did so by hiding real misses. That is the direction worth distrusting, and it is why each correction here was made before reporting the figure rather than after.

## Reproducing

```sh
gh api --paginate "repos/yarnpkg/berry/commits?path=packages/yarnpkg-extensions/sources/index.ts"
gh api --paginate "repos/yarnpkg/berry/commits?path=packages/plugin-compat/sources/extensions.ts"
node harness/compare-yarn.mjs --scan records/<run>/scan.json
```

The bucket assignment for every entry, with per-target detail, is in [`yarn-agreement.json`](yarn-agreement.json).

## Changelog

- 2026-09-05 — Initial write-up.
- 2026-09-05 — Checked all four edges in the "literal reference, missed" row: two are real misses (`useragent → semver`, a legacy deep path; `volar-service-typescript-twoslash-queries → typescript`, a type-position `import()`), two are quoted strings that are not imports.
