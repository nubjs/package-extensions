#!/usr/bin/env node
// Build the publishable npm package under `npm/`.
//
//   node harness/pack.mjs
//
// The package is a DROP-IN REPLACEMENT for `@yarnpkg/extensions`: same export
// name, same `Array<[selector, data]>` shape, same CommonJS entry. That is the
// whole point of matching it rather than inventing a shape — pnpm already does
//
//   import { packageExtensions } from '@yarnpkg/extensions'
//
// in `createReadPackageHook`, and applies the result to every install unless
// `ignoreCompatibilityDb` is set. A consumer swaps one specifier and gets this
// dataset instead, with every Yarn rule still in it.

import { mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const ROOT = resolve(dirname(new URL(import.meta.url).pathname), '..');
const OUT = resolve(ROOT, 'npm');

const doc = JSON.parse(readFileSync(resolve(ROOT, 'package-extensions.json'), 'utf8'));
const version = process.argv.includes('--version')
  ? process.argv[process.argv.indexOf('--version') + 1]
  : currentVersion();

// Yarn's array-of-pairs, not an object: the selector is NOT unique in Yarn's own
// database, and an object silently collapses the duplicates.
const pairs = Object.entries(doc.packageExtensions);

rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });

const banner = `// @nubjs/extensions ${version} — generated ${doc.generated}, do not edit.
// ${doc.totals.packages} packages, ${doc.totals.entries} undeclared dependencies found by scanning
// the ${doc.corpus.size} most-downloaded npm packages, plus every rule from
// ${doc.sources.yarn.package}@${doc.sources.yarn.version}.
// https://github.com/nubjs/package-extensions`;

const data = JSON.stringify(pairs, null, 1);

writeFileSync(resolve(OUT, 'index.js'), `${banner}
'use strict';
Object.defineProperty(exports, '__esModule', { value: true });
exports.packageExtensions = ${data};
`);

writeFileSync(resolve(OUT, 'index.mjs'), `${banner}
export const packageExtensions = ${data};
export default { packageExtensions };
`);

// The type is declared locally rather than imported from `@yarnpkg/core`, so
// the package has no dependencies at all and typechecks for a consumer who does
// not use Yarn.
writeFileSync(resolve(OUT, 'index.d.ts'), `${banner}

export interface PackageExtensionData {
  dependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  peerDependenciesMeta?: Record<string, { optional?: boolean }>;
}

/** Selector-to-extension pairs, in the shape \`@yarnpkg/extensions\` publishes. */
export declare const packageExtensions: Array<[string, PackageExtensionData]>;
`);

// The full document — findings, per-entry evidence, the review queue — for
// anyone who wants more than the rules themselves.
writeFileSync(resolve(OUT, 'package-extensions.json'), `${JSON.stringify(doc, null, 1)}\n`);

writeFileSync(
  resolve(OUT, 'package.json'),
  `${JSON.stringify(
    {
      name: '@nubjs/extensions',
      version,
      description:
        'Undeclared dependencies across the most-downloaded npm packages, as a packageExtensions database for pnpm and Yarn',
      license: 'MIT',
      repository: { type: 'git', url: 'git+https://github.com/nubjs/package-extensions.git' },
      homepage: 'https://github.com/nubjs/package-extensions',
      main: './index.js',
      types: './index.d.ts',
      exports: {
        '.': { types: './index.d.ts', import: './index.mjs', require: './index.js' },
        './package-extensions.json': './package-extensions.json',
        './package.json': './package.json',
      },
      files: ['index.js', 'index.mjs', 'index.d.ts', 'package-extensions.json', 'README.md'],
      keywords: ['packageExtensions', 'pnpm', 'yarn', 'phantom-dependencies', 'undeclared-dependencies', 'package-manager'],
      publishConfig: { access: 'public' },
    },
    null,
    2
  )}\n`
);

// The README leads with the METHOD, not with a count. A headline of "N packages
// instead of Yarn's M" invites the reader to price the dataset by its size, which
// is the least interesting thing about it and moves on every rebuild. What makes
// it worth installing is that the whole corpus was swept by one detector, and
// that swapping it in cannot break an install.
writeFileSync(
  resolve(OUT, 'README.md'),
  `# @nubjs/extensions

Undeclared dependencies across the ${doc.corpus.size.toLocaleString('en-US')} most-downloaded packages on npm, published as a \`packageExtensions\` database that pnpm and Yarn read directly. Nub's phantom detector parses every published tarball in that corpus and resolves what the code imports against what the manifest declares.

\`\`\`sh
npm add -D @nubjs/extensions
\`\`\`

## Drop-in for \`${doc.sources.yarn.package}\`

Change the specifier and nothing else changes. Same export name, same \`Array<[selector, data]>\` shape, same CommonJS and ESM entry points, no dependencies.

\`\`\`diff
- import { packageExtensions } from '${doc.sources.yarn.package}';
+ import { packageExtensions } from '@nubjs/extensions';
\`\`\`

## A strict superset of Yarn's database

Every rule in \`${doc.sources.yarn.package}@${doc.sources.yarn.version}\` is carried through field for field: the same range, the same manifest field, and a peer Yarn declared required is never relaxed to optional. Every pnpm install already merges that database unless \`ignoreCompatibilityDb\` is set, so a replacement that dropped a single rule would break installs that work today — a gate fails the build if any rule is weakened.

Method, per-entry evidence and the ready-to-paste config blocks for pnpm and Yarn: https://github.com/nubjs/package-extensions
`
);

console.error(`wrote npm/ — @nubjs/extensions@${version}, ${pairs.length} entries`);

/**
 * Plain semver, matching `@yarnpkg/extensions` — the package this one is a
 * drop-in replacement for, so the version people read next to it should mean the
 * same thing.
 *
 * Yarn patch-bumps for a data refresh and reserves minor/major for a change in
 * the exported SHAPE: 2.0.1 through 2.0.7 span two years of list updates, and
 * every `Array<[selector, data]>` consumer keeps working across all of them. We
 * match that, so a caret range is safe for anyone tracking the data and a minor
 * bump is a real signal.
 *
 * Deliberately NOT derived from the build date. Calendar versioning was the
 * first choice here on the grounds that the dataset is a snapshot rather than an
 * API — but the scan runs daily, and a date-stamped version implies every
 * rebuild is worth publishing. It also cannot express "the data changed
 * substantially" versus "the export shape changed", which is exactly the
 * distinction a consumer pinning this package needs.
 *
 * The version lives in `harness/version.json` so a release is a reviewable
 * one-line commit rather than a side effect of the clock.
 */
function currentVersion() {
  return JSON.parse(readFileSync(resolve(ROOT, 'harness/version.json'), 'utf8')).version;
}
