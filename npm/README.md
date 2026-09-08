# @nubjs/extensions

Undeclared dependencies across the 10,000 most-downloaded packages on npm, published as a `packageExtensions` database that pnpm and Yarn read directly. Nub's phantom detector parses every published tarball in that corpus and resolves what the code imports against what the manifest declares.

```sh
npm add -D @nubjs/extensions
```

## Drop-in for `@yarnpkg/extensions`

Change the specifier and nothing else changes. Same export name, same `Array<[selector, data]>` shape, same CommonJS and ESM entry points, no dependencies.

```diff
- import { packageExtensions } from '@yarnpkg/extensions';
+ import { packageExtensions } from '@nubjs/extensions';
```

## A strict superset of Yarn's database

Every rule in `@yarnpkg/extensions@2.0.7` is carried through field for field: the same range, the same manifest field, and a peer Yarn declared required is never relaxed to optional. Every pnpm install already merges that database unless `ignoreCompatibilityDb` is set, so a replacement that dropped a single rule would break installs that work today — a gate fails the build if any rule is weakened.

Method, per-entry evidence and the ready-to-paste config blocks for pnpm and Yarn: https://github.com/nubjs/package-extensions
