#!/usr/bin/env node
// Cross-check this dataset against the database Yarn ships.
//
//   node harness/compare-yarn.mjs --scan records/<run>/scan.json
//
// Yarn's `@yarnpkg/extensions` is the only comparable artifact in existence, so
// it is the closest thing to ground truth available. Agreement is not a count of
// shared entries, though, and reading it that way gives a number that means
// nothing: most of Yarn's entries are bounded ABOVE by the release that fixed
// them (`debug@<4.2.0`), so a scan of current versions SHOULD miss them. That is
// the two databases agreeing, not disagreeing.
//
// So every Yarn entry is placed in one of four buckets, and only the first one
// can hold a real defect:
//
//   applicable    the range covers the version scanned, and the package still
//                 does not declare the target. This dataset must find it.
//                 A miss here is a false negative in the detector.
//   fixed         the range excludes the scanned version, or the package now
//                 declares the target. Not finding it is correct.
//   optionality   Yarn only marks an ALREADY-DECLARED peer optional. A phantom
//                 detector cannot see these and should not: nothing is
//                 undeclared. Out of scope by construction.
//   out-of-corpus the package is not in the top 10,000.

import { readFileSync, existsSync, writeFileSync, readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import semver from 'semver';

const ROOT = resolve(dirname(new URL(import.meta.url).pathname), '..');
const arg = (n, d) => {
  const i = process.argv.indexOf(`--${n}`);
  return i === -1 ? d : process.argv[i + 1];
};

const scanPath = arg('scan');
if (!scanPath) {
  console.error('compare-yarn.mjs: --scan <scan.json> is required');
  process.exit(2);
}

// ------------------------------------------------- Yarn's published database

const dir = mkdtempSync(join(tmpdir(), 'yext-'));
let yarnEntries;
let yarnVersion;
try {
  const meta = await (await fetch('https://registry.npmjs.org/@yarnpkg/extensions', {
    headers: { accept: 'application/vnd.npm.install-v1+json' },
  })).json();
  yarnVersion = meta['dist-tags'].latest;
  const tarball = meta.versions[yarnVersion].dist.tarball;
  execFileSync('sh', ['-c', `curl -sL ${JSON.stringify(tarball)} | tar xz -C ${JSON.stringify(dir)}`]);
  const mod = await import(join(dir, 'package/lib/index.js'));
  yarnEntries = (mod.packageExtensions ?? mod.default?.packageExtensions).map(([selector, data]) => {
    const at = selector.lastIndexOf('@');
    return {
      package: selector.slice(0, at),
      range: selector.slice(at + 1),
      targets: [
        ...new Set([
          ...Object.keys(data.dependencies ?? {}),
          ...Object.keys(data.peerDependencies ?? {}),
          ...Object.keys(data.peerDependenciesMeta ?? {}),
        ]),
      ],
      // An entry that ONLY carries `peerDependenciesMeta` is adding optionality
      // to something already declared, not naming anything undeclared.
      metaOnly: !data.dependencies && !data.peerDependencies && Boolean(data.peerDependenciesMeta),
    };
  });
} finally {
  rmSync(dir, { recursive: true, force: true });
}

console.error(`@yarnpkg/extensions ${yarnVersion}: ${yarnEntries.length} entries`);

// ------------------------------------------------------------- this dataset

const scan = JSON.parse(readFileSync(resolve(scanPath), 'utf8'));
const mine = new Map(); // package -> { version, targets:Set }
for (const o of scan.offenders) {
  const targets = new Set();
  for (const f of [...(o.hard_phantoms ?? []), ...(o.soft_phantoms ?? [])]) targets.add(f.package);
  mine.set(o.package, { version: o.version, targets });
}
const scanFailed = new Set((scan.failed ?? []).map((f) => f.package));

// The corpus: whatever the detector actually walked. `scanned_ok` counts it but
// does not name it, so membership is decided by the ranking the scan used.
const corpusPath = resolve(ROOT, 'inputs/corpus.json');
let corpus = null;
if (existsSync(corpusPath)) corpus = new Set(JSON.parse(readFileSync(corpusPath, 'utf8')).packages);

// ---------------------------------------------------- resolve current state

const names = [...new Set(yarnEntries.map((e) => e.package))];
console.error(`resolving ${names.length} packages against the registry...`);
const manifests = new Map();
let cursor = 0;
await Promise.all(
  Array.from({ length: 12 }, async () => {
    for (;;) {
      const i = cursor++;
      if (i >= names.length) return;
      manifests.set(names[i], await manifest(names[i]));
    }
  })
);

async function manifest(name) {
  for (let a = 0; a < 4; a++) {
    try {
      const res = await fetch(`https://registry.npmjs.org/${name.replace(/\//g, '%2f')}`, {
        headers: { accept: 'application/vnd.npm.install-v1+json' },
      });
      if (res.status === 404) return null;
      if (!res.ok) {
        await new Promise((r) => setTimeout(r, 400 * 2 ** a));
        continue;
      }
      const j = await res.json();
      const v = j['dist-tags']?.latest;
      if (!v) return null;
      const m = j.versions[v];
      return {
        version: v,
        declared: new Set([
          ...Object.keys(m.dependencies ?? {}),
          ...Object.keys(m.optionalDependencies ?? {}),
          ...Object.keys(m.peerDependencies ?? {}),
        ]),
      };
    } catch {
      await new Promise((r) => setTimeout(r, 400 * 2 ** a));
    }
  }
  return null;
}

// --------------------------------------------------------------- bucketing

const buckets = { applicable: [], fixed: [], optionality: [], outOfCorpus: [], unresolved: [] };

for (const e of yarnEntries) {
  const m = manifests.get(e.package);
  if (!m) {
    buckets.unresolved.push({ ...e, why: 'not resolvable on the registry' });
    continue;
  }
  if (corpus && !corpus.has(e.package)) {
    buckets.outOfCorpus.push({ ...e, version: m.version });
    continue;
  }
  const found = mine.get(e.package);
  const undeclared = e.targets.filter((t) => !m.declared.has(t));

  if (e.metaOnly && undeclared.length === 0) {
    buckets.optionality.push({ ...e, version: m.version });
    continue;
  }
  if (!semver.satisfies(m.version, e.range, { includePrerelease: true }) || undeclared.length === 0) {
    buckets.fixed.push({
      ...e,
      version: m.version,
      why: undeclared.length === 0 ? 'the package now declares every target' : `latest ${m.version} is outside ${e.range}`,
    });
    continue;
  }
  const hit = undeclared.filter((t) => found?.targets.has(t));
  const miss = undeclared.filter((t) => !found?.targets.has(t));
  buckets.applicable.push({ ...e, version: m.version, undeclared, hit, miss, scanned: !scanFailed.has(e.package) });
}

// ------------------------------------------- what a miss is actually about
//
// A MISS IS ONLY A DETECTOR MISS IF THE REFERENCE IS THERE TO FIND. Yarn's
// rules are hand-written and outlive the code that justified them: Yarn carries
// `notistack@^3.0.0 -> csstype`, and notistack 3.0.2 ships eleven files with
// zero `csstype` references anywhere. Counting that against the detector blames
// it for being correctly silent, and three of twelve misses were this.
//
// A literal grep alone cannot settle it, because a dynamically-built specifier
// leaves no literal either — `postcss-syntax` reaches `postcss-html` through
// `require(id + "/...")`. Those are opposites: one is a stale rule, the other is
// a real limitation. What separates them is the PREFIX. A dynamic call still
// ships the static part of the name, so a long literal prefix of the target
// means the reference is real and merely uncomputable.
for (const e of buckets.applicable) {
  if (e.miss.length === 0) continue;
  const text = await publishedText(e.package);
  if (text === null) continue; // fetch failed; leave the miss as-is rather than excusing it
  e.missDetail = {};
  for (const t of e.miss) {
    if (quoted(text, t)) e.missDetail[t] = 'literal';
    else if (longestPrefixPresent(text, t) >= 8) e.missDetail[t] = 'dynamic';
    else e.missDetail[t] = 'absent';
  }
  e.notReferenced = e.miss.filter((t) => e.missDetail[t] === 'absent');
}

/** Concatenated source of every JS/TS file in the published tarball, or null. */
async function publishedText(pkg) {
  const dir = mkdtempSync(join(tmpdir(), 'ref-'));
  try {
    const meta = await (
      await fetch(`https://registry.npmjs.org/${pkg.replace(/\//g, '%2f')}`, {
        headers: { accept: 'application/vnd.npm.install-v1+json' },
      })
    ).json();
    const tarball = meta.versions[meta['dist-tags'].latest].dist.tarball;
    execFileSync('sh', ['-c', `curl -sL ${JSON.stringify(tarball)} | tar xz -C ${JSON.stringify(dir)}`]);
    let out = '';
    for (const f of walkFiles(join(dir, 'package'))) {
      if (!/\.(m|c)?[jt]sx?$/.test(f)) continue;
      try {
        out += readFileSync(f, 'utf8');
      } catch {
        /* unreadable file contributes nothing */
      }
    }
    return out;
  } catch {
    return null;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * Whether `s` appears opened by any string delimiter.
 *
 * The BACKTICK is the one that matters and the one first missed here: a dynamic
 * specifier is written `` `eslint-import-resolver-${name}` ``, so checking only
 * `'` and `"` classed four of `eslint-module-utils`'s edges as never-referenced
 * and dropped them from the denominator — improving the score by hiding real
 * misses, which is the wrong direction to be wrong in.
 */
function quoted(text, s) {
  return text.includes(`'${s}`) || text.includes(`"${s}`) || text.includes(`\`${s}`);
}

/** Length of the longest prefix of `target` appearing as a quoted literal. */
function longestPrefixPresent(text, target) {
  for (let n = target.length - 1; n >= 8; n--) {
    if (quoted(text, target.slice(0, n))) return n;
  }
  return 0;
}

function* walkFiles(dir) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const d of entries) {
    const p = join(dir, d.name);
    if (d.isDirectory()) yield* walkFiles(p);
    else yield p;
  }
}

// ------------------------------------------------------------------ report

const app = buckets.applicable;
// An edge whose target the published source never names is not detectable, so
// it is excluded from the denominator rather than charged to the detector.
const unref = (e) => (e.notReferenced ?? []).length;
const realMiss = (e) => e.miss.filter((t) => !(e.notReferenced ?? []).includes(t));
const fullHit = app.filter((e) => realMiss(e).length === 0);
const partial = app.filter((e) => e.hit.length > 0 && realMiss(e).length > 0);
const missed = app.filter((e) => e.hit.length === 0 && realMiss(e).length > 0);
const edgeTotal = app.reduce((n, e) => n + e.undeclared.length - unref(e), 0);
const edgeHit = app.reduce((n, e) => n + e.hit.length, 0);
const edgeNotReferenced = app.reduce((n, e) => n + unref(e), 0);
const edgeDynamic = app.reduce(
  (n, e) => n + Object.values(e.missDetail ?? {}).filter((v) => v === 'dynamic').length,
  0
);

const out = {
  yarnDatabase: { package: '@yarnpkg/extensions', version: yarnVersion, entries: yarnEntries.length },
  corpus: { scannedOk: scan.scanned_ok, corpusKnown: Boolean(corpus) },
  buckets: {
    applicable: app.length,
    fixed: buckets.fixed.length,
    optionality: buckets.optionality.length,
    outOfCorpus: buckets.outOfCorpus.length,
    unresolved: buckets.unresolved.length,
  },
  agreement: {
    entriesFullyMatched: fullHit.length,
    entriesPartiallyMatched: partial.length,
    entriesMissed: missed.length,
    edgeAgreement: edgeTotal ? `${edgeHit}/${edgeTotal}` : 'n/a',
    // Excluded from the denominator above: the published source never names the
    // target, so Yarn's rule outlived the code that justified it and there is
    // nothing for a detector to find.
    edgesNotReferenced: edgeNotReferenced,
    // Counted AGAINST the detector, and correctly: the reference is real, only
    // the specifier is computed at runtime.
    edgesDynamicSpecifier: edgeDynamic,
  },
  detail: { applicable: app, missed, fixed: buckets.fixed, optionality: buckets.optionality, unresolved: buckets.unresolved },
};

writeFileSync(resolve(ROOT, 'docs/yarn-agreement.json'), `${JSON.stringify(out, null, 2)}\n`);

console.log(`\n@yarnpkg/extensions ${yarnVersion} — ${yarnEntries.length} entries\n`);
console.log(`  applicable to what was scanned   ${app.length}`);
console.log(`  already fixed upstream           ${buckets.fixed.length}`);
console.log(`  optionality-only (out of scope)  ${buckets.optionality.length}`);
console.log(`  outside the top-10000 corpus     ${buckets.outOfCorpus.length}`);
console.log(`  unresolved                       ${buckets.unresolved.length}`);
console.log(`\nOf the ${app.length} applicable entries:`);
console.log(`  fully matched      ${fullHit.length}`);
console.log(`  partially matched  ${partial.length}`);
console.log(`  missed entirely    ${missed.length}`);
console.log(`  edge agreement     ${edgeTotal ? `${edgeHit}/${edgeTotal} (${Math.round((edgeHit / edgeTotal) * 100)}%)` : 'n/a'}`);
if (missed.length) {
  console.log('\nMissed:');
  for (const e of missed) console.log(`  ${e.package}@${e.version} (rule ${e.range}) -> ${e.miss.join(', ')}`);
}
if (partial.length) {
  console.log('\nPartial:');
  for (const e of partial) console.log(`  ${e.package}@${e.version} found ${e.hit.join(', ')} | missed ${e.miss.join(', ')}`);
}
console.log('\nwrote docs/yarn-agreement.json');
