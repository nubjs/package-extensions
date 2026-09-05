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
write('dist/yarnrc.yml', `${comment}\n\n${yamlBody}`);

// pnpm 11+ — merge into `pnpm-workspace.yaml`.
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
