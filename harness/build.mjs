#!/usr/bin/env node
// scan record -> package-extensions.json
//
//   node harness/build.mjs --scan records/<run>/scan.json --out package-extensions.json
//
// Every target is checked against the registry before it is emitted. That gate
// is not bureaucracy: the detector reads specifiers out of source, so a typo, a
// name that was unpublished, or a private-registry package all reach it looking
// exactly like a real dependency. An extension naming a package that does not
// exist is worse than no entry — Yarn fails the install outright.

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

import { rowsForOffender, extensionFor, fieldFor, keyFor, sortKeys } from './policy.mjs';

const HERE = dirname(new URL(import.meta.url).pathname);
const CACHE = resolve(HERE, '../inputs/registry-cache.json');
const REGISTRY = 'https://registry.npmjs.org';

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? fallback : process.argv[i + 1];
}

const scanPath = arg('scan');
const outPath = resolve(HERE, '..', arg('out', 'package-extensions.json'));
const overridesPath = resolve(HERE, 'overrides.json');
const includeGuarded = !process.argv.includes('--no-guarded');

if (!scanPath) {
  console.error('build.mjs: --scan <scan.json> is required');
  process.exit(2);
}

const scan = JSON.parse(readFileSync(resolve(scanPath), 'utf8'));
const overrides = existsSync(overridesPath) ? JSON.parse(readFileSync(overridesPath, 'utf8')) : {};

// ---------------------------------------------------------------- flatten

let rows = scan.offenders.flatMap(rowsForOffender);
if (!includeGuarded) rows = rows.filter((r) => r.class !== 'guarded');

const targets = [...new Set(rows.map((r) => r.target))].sort();
console.error(`${rows.length} findings across ${new Set(rows.map((r) => r.package)).size} packages, ${targets.length} distinct targets`);

// ------------------------------------------------------- registry existence

const cache = existsSync(CACHE) ? JSON.parse(readFileSync(CACHE, 'utf8')) : {};
const unknown = targets.filter((t) => cache[t] === undefined);

if (unknown.length) {
  console.error(`checking ${unknown.length} targets against the registry...`);
  const CONCURRENCY = 16;
  let cursor = 0;
  let done = 0;
  await Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, unknown.length) }, async () => {
      for (;;) {
        const i = cursor++;
        if (i >= unknown.length) return;
        cache[unknown[i]] = await exists(unknown[i]);
        if (++done % 50 === 0) console.error(`  ${done}/${unknown.length}`);
      }
    })
  );
  mkdirSync(dirname(CACHE), { recursive: true });
  writeFileSync(CACHE, `${JSON.stringify(sortKeys(cache), null, 2)}\n`);
}

/** A published package, per the registry. `null` on a network fault, so a blip is never cached as "absent". */
async function exists(name) {
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const res = await fetch(`${REGISTRY}/${name.replace(/\//g, '%2f')}`, {
        method: 'HEAD',
        headers: { accept: 'application/vnd.npm.install-v1+json' },
      });
      if (res.status === 404) return false;
      if (res.ok) return true;
      if (res.status === 429 || res.status >= 500) {
        await sleep(500 * 2 ** attempt);
        continue;
      }
      return false;
    } catch {
      await sleep(500 * 2 ** attempt);
    }
  }
  return null; // unresolved — excluded, and reported as such
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const dropped = { unpublished: [], unresolved: [] };
rows = rows.filter((r) => {
  if (cache[r.target] === true) return true;
  (cache[r.target] === false ? dropped.unpublished : dropped.unresolved).push(`${r.package} -> ${r.target}`);
  return false;
});
for (const k of Object.keys(dropped)) dropped[k] = [...new Set(dropped[k])].sort();

// ------------------------------------------------------------------ emit

const byPackage = new Map();
for (const row of rows) {
  if (!byPackage.has(row.package)) byPackage.set(row.package, []);
  byPackage.get(row.package).push(row);
}

const packageExtensions = {};
const findings = [];
for (const pkg of [...byPackage.keys()].sort()) {
  const pkgRows = byPackage.get(pkg);
  packageExtensions[keyFor(pkg)] = extensionFor(pkg, pkgRows, overrides);
  findings.push({
    package: pkg,
    measuredVersion: pkgRows[0].measuredVersion,
    targets: pkgRows
      .map((r) => {
        const { field, candidate, reason } = fieldFor(r, overrides);
        return { target: r.target, class: r.class, field, candidate, reason, specifiers: r.specifiers };
      })
      .sort((a, b) => (a.target < b.target ? -1 : 1)),
  });
}

const counts = { runtime: 0, adapter: 0, types: 0, guarded: 0 };
const fieldCounts = { dependency: 0, peer: 0 };
// The review queue: findings that would be a real `dependencies` entry if a
// human confirmed the target is a package the offender genuinely needs its own
// copy of. Recorded here rather than emitted, and separate from the extension
// map so nothing in `dist/` depends on an unreviewed judgement.
const candidates = [];
for (const r of rows) {
  counts[r.class]++;
  const { field, candidate } = fieldFor(r, overrides);
  fieldCounts[field === 'dependency' ? 'dependency' : 'peer']++;
  if (candidate) {
    candidates.push({
      package: r.package,
      measuredVersion: r.measuredVersion,
      target: r.target,
      specifiers: r.specifiers,
    });
  }
}
candidates.sort((a, b) => (a.package === b.package ? (a.target < b.target ? -1 : 1) : a.package < b.package ? -1 : 1));

const doc = {
  generated: new Date().toISOString().slice(0, 10),
  corpus: {
    ranking: 'npm-high-impact topDownload',
    size: (scan.scanned_ok ?? 0) + (scan.failed?.length ?? 0),
    scannedOk: scan.scanned_ok,
    failed: scan.failed?.length ?? 0,
  },
  totals: {
    packages: Object.keys(packageExtensions).length,
    entries: rows.length,
    byClass: counts,
    byField: { dependency: fieldCounts.dependency, peer: fieldCounts.peer },
    candidatesForReview: candidates.length,
    droppedUnpublishedTargets: dropped.unpublished.length,
    droppedUnresolvedTargets: dropped.unresolved.length,
  },
  packageExtensions,
  findings,
  candidates,
  dropped,
};

mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, `${JSON.stringify(doc, null, 2)}\n`);
console.error(
  `wrote ${outPath}: ${doc.totals.packages} packages, ${doc.totals.entries} entries ` +
    `(${counts.runtime} runtime, ${counts.adapter} adapter, ${counts.types} types, ${counts.guarded} guarded; ` +
    `${fieldCounts.dependency} dependency, ${fieldCounts.peer} peer), ` +
    `${dropped.unpublished.length} dropped as unpublished, ` +
    `${candidates.length} candidates for review`
);
