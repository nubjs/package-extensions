#!/usr/bin/env node
// Rewrite the README's derived figures from the dataset.
//
// The gate in verify.mjs refuses a README whose numbers no longer match, and it
// was right to: they had drifted across three rebuilds. But it also made the
// daily cadence impossible to keep green, because nothing updated them — the
// first rebuild that moved the dataset by a single package failed the gate and
// committed nothing (run 34141360882, 812 -> 811).
//
// So the numbers are generated and the gate verifies the generation happened. A
// reworded sentence still fails loudly, which is the part worth keeping: this
// only ever rewrites a CAPTURE GROUP inside a pattern that already matched.
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { readmeFigures, likeSample } from './readme-figures.mjs';

const ROOT = resolve(dirname(new URL(import.meta.url).pathname), '..');
const doc = JSON.parse(readFileSync(resolve(ROOT, 'package-extensions.json'), 'utf8'));
const path = resolve(ROOT, 'README.md');
let md = readFileSync(path, 'utf8');

const missing = [];
const changed = [];
for (const { label, pattern, expected } of readmeFigures(doc)) {
  const m = md.match(pattern);
  // A pattern that no longer matches is a REWORDED README, not a stale number.
  // Reported and left alone: guessing where the sentence went would be worse
  // than the gate failing on it a moment later.
  if (!m) {
    missing.push(`${label}: no longer stated — ${pattern}`);
    continue;
  }
  const was = m[1];
  const now = likeSample(expected, was);
  if (was === now) continue;
  md = md.replace(m[0], m[0].replace(was, now));
  changed.push(`${label}: ${was} -> ${now}`);
}

writeFileSync(path, md);
for (const c of changed) console.log(`  ${c}`);
console.log(`README: ${changed.length} figure(s) updated${missing.length ? `, ${missing.length} not found` : ''}`);
for (const m of missing) console.error(`  ${m}`);
// Not fatal. The gate that runs next is the authority on whether the README is
// acceptable, and it reports every mismatch at once rather than the first.
