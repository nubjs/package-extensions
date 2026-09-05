#!/usr/bin/env node
// package-extensions.json -> the three files a consumer actually pastes into.
//
//   node harness/emit.mjs
//
// Three files rather than one because the setting lives in a different place in
// each package manager, and in two different places across pnpm's own majors.
// The DATA is identical in all three — the same `name@range` keys and the same
// four manifest fields — so nothing here re-derives a policy decision; it only
// re-wraps the same object.

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

import YAML from 'yaml';

const HERE = dirname(new URL(import.meta.url).pathname);
const ROOT = resolve(HERE, '..');

const doc = JSON.parse(readFileSync(resolve(ROOT, 'package-extensions.json'), 'utf8'));
const { packageExtensions, generated, totals } = doc;

const banner = [
  `Generated ${generated} from the ${doc.corpus.size} most-downloaded npm packages.`,
  `${totals.packages} packages, ${totals.entries} undeclared dependencies.`,
  'Source, method and per-entry evidence: https://github.com/nubjs/package-extensions',
  'Do not hand-edit — this block is regenerated.',
];

const yamlBody = YAML.stringify({ packageExtensions }, { lineWidth: 0 });
const comment = banner.map((l) => `# ${l}`).join('\n');

mkdirSync(resolve(ROOT, 'dist'), { recursive: true });

// Yarn Berry — merge into the project's `.yarnrc.yml`.
//
// The `logFilters` block is not decoration. Yarn reports YN0068 for every
// extension whose package is absent from the tree, twice per entry, so a
// general-purpose database of this size buries a real install log under
// thousands of lines that carry no information — measured at 2,943 warnings in
// a 2,957-line log for a project with two dependencies. Discarding that one
// code brought the same install to 14 lines with the extensions still applied.
// YN0069, which reports an extension a package has since made redundant, is
// left on: that one is actionable, and it is how an entry gets retired.
const logFilters = YAML.stringify({ logFilters: [{ code: 'YN0068', level: 'discard' }] }, { lineWidth: 0 });
write('dist/yarnrc.yml', `${comment}\n\n${logFilters}\n${yamlBody}`);

// pnpm 10 and 11 — merge into `pnpm-workspace.yaml`. No log filter: pnpm is
// silent about an extension that matches nothing.
write('dist/pnpm-workspace.yaml', `${comment}\n\n${yamlBody}`);

// pnpm 10 and earlier — the `pnpm` block of the root `package.json`, which is
// JSON and so cannot carry the banner. The provenance lives in the JSON's own
// `generated` field instead.
write('dist/pnpm-package.json', `${JSON.stringify({ pnpm: { packageExtensions } }, null, 2)}\n`);

function write(rel, content) {
  const path = resolve(ROOT, rel);
  writeFileSync(path, content);
  console.error(`wrote ${rel} (${content.length} bytes)`);
}
