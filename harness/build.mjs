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
import { fetchYarnDatabase } from './yarn-db.mjs';

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

// WITHHELD, PENDING A DETECTOR FIX. Deep-path seeding finds real entry points —
// `redux-persist/integration/react` is the reason it exists — but it also parses
// published SOURCE, and a package built with a tsconfig `baseUrl` imports its own
// modules by bare-looking specifiers: pusher-js reaches `core/utils/url_store`
// and `isomorphic/runtime`, react-zoom-pan-pinch reaches `utils/ref.utils`. Those
// name directories inside the package, not packages, so they are outside this
// dataset's contract however Node treats them.
//
// They cannot be told apart HERE. `pusher-js -> core` via `core/utils/...` and
// `swagger-ui-dist -> lodash` via `lodash/merge` are the same shape, and only the
// offender's own file list separates them — which the scan does not carry. A
// filter built on that shape suppresses the true positives and keeps the false
// ones; that was measured before writing this, not assumed.
//
// So the tier is recorded as evidence and not emitted. Withholding costs users
// nothing, because it has never shipped; emitting it would put `pusher-js ->
// express` in a public dataset. Delete these three lines once the detector skips
// a bare specifier that resolves inside the package's own tree.
const withheld = rows.filter((r) => r.class === 'deep-path');
rows = rows.filter((r) => r.class !== 'deep-path');

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

// Yarn's own database, included verbatim so that swapping this dataset in for
// `@yarnpkg/extensions` can never lose an entry. pnpm applies that database by
// DEFAULT (`createReadPackageHook` merges it unless `ignoreCompatibilityDb` is
// set), so a pnpm user already has these 159 rules and a replacement that
// dropped them would be a silent regression.
//
// Yarn's keys are kept exactly as published — `debug@<4.2.0`, not `debug@*` —
// and ours are separate `@*` keys. Both package managers accept several entries
// for one package and apply whichever ranges match, so the two layers coexist
// with no merge and Yarn's version precision survives intact.
const yarn = await fetchYarnDatabase();
let yarnAdded = 0;
let yarnMerged = 0;
for (const [selector, ext] of yarn.entries) {
  if (packageExtensions[selector]) {
    // Two ways a key collides, and skipping either one drops a rule. Our scan
    // may already own the exact selector (`eslint-plugin-import@*`), and Yarn's
    // own list is an ARRAY that repeats a selector — `gatsby-core-utils@<2.14.0
    // -next.1` appears twice with different fields — so keying it by string
    // collapses the duplicates. Both are real losses, both measured. Union the
    // fields instead of choosing.
    if (mergeInto(packageExtensions[selector], ext)) yarnMerged++;
    continue;
  }
  packageExtensions[selector] = ext;
  yarnAdded++;
}

/** Union `from` into `into` without overwriting a range already there. Returns whether anything was added. */
function mergeInto(into, from) {
  let changed = false;
  for (const field of ['dependencies', 'optionalDependencies', 'peerDependencies']) {
    for (const [name, range] of Object.entries(from[field] ?? {})) {
      into[field] ??= {};
      if (into[field][name] === undefined) {
        into[field][name] = range;
        changed = true;
      }
    }
  }
  for (const [name, meta] of Object.entries(from.peerDependenciesMeta ?? {})) {
    into.peerDependenciesMeta ??= {};
    if (into.peerDependenciesMeta[name] === undefined) {
      into.peerDependenciesMeta[name] = meta;
      changed = true;
    }
  }
  return changed;
}

const counts = { runtime: 0, adapter: 0, types: 0, 'deep-path': 0, guarded: 0 };
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
  sources: {
    scan: { entries: rows.length, packages: byPackage.size },
    yarn: {
      package: '@yarnpkg/extensions',
      version: yarn.version,
      entries: yarn.entries.length,
      addedAsNewKeys: yarnAdded,
      mergedIntoExistingKeys: yarnMerged,
    },
  },
  totals: {
    packages: Object.keys(packageExtensions).length,
    entries: rows.length,
    byClass: counts,
    byField: { dependency: fieldCounts.dependency, peer: fieldCounts.peer },
    candidatesForReview: candidates.length,
    droppedUnpublishedTargets: dropped.unpublished.length,
    droppedUnresolvedTargets: dropped.unresolved.length,
    // Found, recorded, deliberately not emitted. See the withholding note above.
    withheldDeepPath: withheld.length,
  },
  withheldDeepPath: withheld
    .map((r) => ({ package: r.package, target: r.target, specifiers: r.specifiers }))
    .sort((a, b) => (`${a.package} ${a.target}` < `${b.package} ${b.target}` ? -1 : 1)),
  yarnKeys: yarn.entries.map(([selector]) => selector).sort(),
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
    `${candidates.length} candidates for review; ` +
    `+${yarnAdded} from @yarnpkg/extensions@${yarn.version}`
);
