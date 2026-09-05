#!/usr/bin/env node
// Turn a parse result into a reproduction.
//
//   node harness/probe.mjs --packages es-abstract,object.hasown
//   node harness/probe.mjs --queue 50 --concurrency 6
//   node harness/probe.mjs --all --concurrency 8 --out docs/probe-results.json
//
// Every entry in this dataset is, until this runs, a claim made by reading
// source. This installs the offending package ALONE under Yarn Plug'n'Play with
// the top-level fallback off, imports it, and records whether the resolution
// actually fails.
//
// Yarn PnP is the instrument because its error names BOTH SIDES:
//
//   Error: @nrwl/devkit tried to access tslib, but it isn't declared in its
//   dependencies; this makes the require call ambiguous and unsound.
//
// so a verdict is machine-readable rather than a judgement. `pnpFallbackMode:
// none` is what makes the test meaningful — with Yarn's default the root
// project's own dependencies silently satisfy any package's undeclared import,
// which is why these breakages are invisible to most people most of the time.
//
// What it settles that reading cannot:
//   - a package whose specifier only LOOKS like a package never throws, so the
//     requirejs `define('lang', …)` class refutes itself
//   - an import behind a branch nothing takes never throws either
//   - a target that IS needed throws by name, which is the evidence for
//     promoting an entry from an optional peer to a real dependency
//
// READ `notOnImport` AS A CONFIDENCE TIER, NOT A REFUTATION. The probe imports
// the package's entry points, so it only sees what those actually load.
// `es-abstract` really does `require('for-each')` unguarded — in
// `2025/EncodeForRegExpEscape.js`, which the main entry never pulls in — so it
// reports `notOnImport` while remaining a true finding for anyone who uses that
// abstract operation. Reaching those needs the detector to emit the FILE each
// occurrence was found in, so the probe can require that path directly; until
// then this tier means "does not break a bare import", which is weaker than
// "is not real".

import { execFileSync, execFile } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);
const ROOT = resolve(dirname(new URL(import.meta.url).pathname), '..');
const arg = (n, d) => {
  const i = process.argv.indexOf(`--${n}`);
  return i === -1 ? d : process.argv[i + 1];
};

const doc = JSON.parse(readFileSync(resolve(ROOT, 'package-extensions.json'), 'utf8'));
const concurrency = Number(arg('concurrency', 6));
const outPath = resolve(ROOT, arg('out', 'docs/probe-results.json'));

let targets;
if (arg('packages')) {
  const want = new Set(arg('packages').split(','));
  targets = doc.findings.filter((f) => want.has(f.package));
} else if (process.argv.includes('--all')) {
  targets = doc.findings;
} else {
  // The review queue first — those are the findings whose verdict decides
  // whether an entry becomes a real dependency, so they are worth the most.
  const queued = new Set(doc.candidates.map((c) => c.package));
  targets = doc.findings.filter((f) => queued.has(f.package)).slice(0, Number(arg('queue', 25)));
}

if (targets.length === 0) {
  console.error('probe.mjs: nothing selected');
  process.exit(2);
}

// A Yarn release is downloaded once and reused by every cell. Resolving it per
// cell would make the probe a test of npm's availability.
const YARN = await ensureYarn();

console.error(`probing ${targets.length} packages at concurrency ${concurrency}`);

const results = [];
let cursor = 0;
let done = 0;
await Promise.all(
  Array.from({ length: Math.min(concurrency, targets.length) }, async () => {
    for (;;) {
      const i = cursor++;
      if (i >= targets.length) return;
      results.push(await probe(targets[i]));
      if (++done % 10 === 0) console.error(`  ${done}/${targets.length}`);
    }
  })
);

results.sort((a, b) => (a.package < b.package ? -1 : 1));

const tally = { confirmed: 0, notOnImport: 0, installFailed: 0, inconclusive: 0 };
for (const r of results) tally[r.verdict]++;

mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(
  outPath,
  `${JSON.stringify({ generated: new Date().toISOString().slice(0, 10), instrument: { yarn: YARN.version, mode: 'pnp, pnpFallbackMode: none' }, tally, results }, null, 2)}\n`
);

console.log(`\nconfirmed        ${tally.confirmed}   (the import really fails, and Yarn names the target)`);
console.log(`not on import    ${tally.notOnImport}   (a bare import loads fine; the target sits behind a deeper path)`);
console.log(`install failed   ${tally.installFailed}`);
console.log(`inconclusive     ${tally.inconclusive}`);
console.log(`\nwrote ${outPath}`);

// A confirmed probe is stronger evidence than anything reading the source can
// produce: the resolver itself refused, and named both sides. So `--promote`
// writes those verdicts into the reviewed overrides, where they become real
// `dependencies` entries. It only ever ADDS — an existing decision, human or
// otherwise, is never overwritten by a later run.
//
// BUT A CONFIRMED PROBE ANSWERS ONLY HALF THE QUESTION. It proves the import is
// real and unguarded; it says nothing about who should supply the target, and
// promoting on the strength of it alone put `dependencies: {react: "*"}` on
// `react-csv@*` — a true finding and a fix that would break every consumer with
// a second React. So a promotion also requires the policy to have marked the row
// a review CANDIDATE, which is what excludes frameworks and host-provided names.
// Refusals are printed rather than dropped: a confirmed throw against a
// consumer-supplied target is still worth knowing about.
if (process.argv.includes('--promote')) {
  const path = resolve(ROOT, 'harness/overrides.json');
  const overrides = JSON.parse(readFileSync(path, 'utf8'));
  const candidateTargets = new Set(doc.candidates.map((c) => `${c.package} ${c.target}`));
  let added = 0;
  let settled = 0;
  const refused = [];
  for (const r of results) {
    if (r.verdict !== 'confirmed') continue;
    for (const target of r.confirmed) {
      // An existing override is a decision already made, not a refusal. Both
      // reach this point as non-candidates, and reporting them together claims
      // "the policy does not let this become a dependency" about entries that
      // already ARE dependencies from an earlier run.
      if (overrides[r.package]?.[target]) {
        settled++;
        continue;
      }
      if (!candidateTargets.has(`${r.package} ${target}`)) {
        refused.push(`${r.package} -> ${target}`);
        continue;
      }
      overrides[r.package] ??= {};
      overrides[r.package][target] = {
        field: 'dependency',
        why: `probe ${r.version}: importing the package under Yarn PnP with pnpFallbackMode none throws "tried to access ${target}"`,
      };
      added++;
    }
  }
  writeFileSync(path, `${JSON.stringify(overrides, null, 2)}\n`);
  console.log(`promoted ${added} confirmed finding(s) into harness/overrides.json`);
  if (settled) console.log(`${settled} confirmed finding(s) already carry a decision and were left alone`);
  if (refused.length) {
    console.log(`refused ${refused.length} confirmed finding(s) the policy does not let become a dependency:`);
    for (const r of refused) console.log(`  ${r}`);
  }
}

/**
 * One package, alone, under the strictest resolver setting.
 *
 * The consumer declares ONLY the offender. That is deliberate: it is the
 * condition under which an undeclared import has nothing to resolve against, so
 * a throw is attributable to the package rather than to the fixture.
 */
async function probe(finding) {
  const dir = mkdtempSync(join(tmpdir(), 'probe-'));
  const base = { package: finding.package, version: finding.measuredVersion, expected: finding.targets.map((t) => t.target) };
  try {
    writeFileSync(
      join(dir, 'package.json'),
      JSON.stringify({ name: 'probe', version: '1.0.0', dependencies: { [finding.package]: finding.measuredVersion } })
    );
    mkdirSync(join(dir, '.yarn/releases'), { recursive: true });
    execFileSync('cp', [YARN.path, join(dir, '.yarn/releases/yarn.cjs')]);
    writeFileSync(
      join(dir, '.yarnrc.yml'),
      ['yarnPath: .yarn/releases/yarn.cjs', 'enableGlobalCache: true', 'pnpFallbackMode: none', 'enableTelemetry: false'].join('\n')
    );

    try {
      await run('node', ['.yarn/releases/yarn.cjs', 'install', '--mode=skip-build'], { cwd: dir, timeout: 180_000, maxBuffer: 1 << 26 });
    } catch (err) {
      return { ...base, verdict: 'installFailed', detail: (err.stderr || err.stdout || err.message).slice(0, 300) };
    }

    // Import the main entry and every non-`.` exports subpath. An adapter-class
    // phantom lives only behind a subpath, so importing the root alone would
    // report it as fine.
    const specifiers = [finding.package, ...(await subpaths(dir, finding.package)).map((s) => `${finding.package}${s.slice(1)}`)];
    writeFileSync(
      join(dir, 'probe.cjs'),
      `const out = [];
for (const s of ${JSON.stringify(specifiers)}) {
  try { require(s); out.push({ specifier: s, ok: true }); }
  catch (e) { out.push({ specifier: s, ok: false, message: String(e && e.message || e).slice(0, 400) }); }
}
console.log(JSON.stringify(out));`
    );

    let parsed;
    try {
      const { stdout } = await run('node', ['.yarn/releases/yarn.cjs', 'node', 'probe.cjs'], { cwd: dir, timeout: 120_000, maxBuffer: 1 << 26 });
      parsed = JSON.parse(stdout.trim().split('\n').pop());
    } catch (err) {
      return { ...base, verdict: 'inconclusive', detail: (err.stderr || err.message).slice(0, 300) };
    }

    // Yarn's message names the accessed package, which is what makes this a
    // measurement rather than an inference. It has TWO forms and they mean
    // opposite things, so the parenthetical is part of the signal:
    //
    //   X tried to access Y, but it isn't declared in its dependencies
    //   X tried to access Y (a peer dependency) but it isn't provided by ...
    //
    // The first is an undeclared import — a real finding. The second is a peer
    // the package DID declare, behaving exactly as designed under a fixture that
    // deliberately provides nothing. Matching only `tried to access` conflates
    // them, which made `accessedButNotPredicted` read as a list of detector
    // misses when five of the six sampled were declared peers.
    // THE ISSUER IS PART OF THE MESSAGE AND MUST BE CHECKED. Importing a package
    // loads its whole graph, so a failure raised here is not necessarily ITS
    // failure: probing `@swagger-api/apidom-reference` throws
    //
    //   @swaggerexpert/json-pointer tried to access @swagger-api/apidom-core ...
    //
    // and apidom-reference declares apidom-core perfectly well. Matching the
    // accessed name alone credits a nested package's phantom to the package
    // under test, which on the promotion path would write a `dependencies` entry
    // onto the wrong package entirely.
    const accessed = new Set();
    const unprovidedPeers = new Set();
    const byOtherIssuers = new Set();
    for (const r of parsed) {
      if (r.ok) continue;
      for (const m of r.message.matchAll(/([@\w./-]+) tried to access ([@\w./-]+)(\s*\(a peer dependency\))?/g)) {
        const [, issuer, target, isPeer] = m;
        if (issuer !== finding.package) {
          byOtherIssuers.add(`${issuer} -> ${target}`);
          continue;
        }
        (isPeer ? unprovidedPeers : accessed).add(target);
      }
    }
    const confirmed = base.expected.filter((t) => accessed.has(t));
    return {
      ...base,
      verdict: confirmed.length ? 'confirmed' : 'notOnImport',
      confirmed,
      // Undeclared imports the detector did not predict — a genuine false-negative
      // signal, now that declared-but-unprovided peers are counted separately.
      accessedButNotPredicted: [...accessed].filter((t) => !base.expected.includes(t)),
      unprovidedPeers: [...unprovidedPeers],
      // Real phantoms raised by other packages in the graph. Not this package's
      // finding, and worth keeping: an issuer here may be outside the corpus.
      byOtherIssuers: [...byOtherIssuers],
      specifiersTried: specifiers.length,
    };
  } catch (err) {
    return { ...base, verdict: 'inconclusive', detail: String(err.message).slice(0, 300) };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Non-`.` keys of the installed package's `exports`, if it has one. */
async function subpaths(dir, name) {
  try {
    const { stdout } = await run(
      'node',
      ['.yarn/releases/yarn.cjs', 'node', '-e', `try{const p=require(${JSON.stringify(`${name}/package.json`)});console.log(JSON.stringify(Object.keys(p.exports||{})))}catch{console.log("[]")}`],
      { cwd: dir, timeout: 60_000 }
    );
    return JSON.parse(stdout.trim().split('\n').pop())
      .filter((k) => k.startsWith('./') && !k.includes('*') && k !== './package.json')
      .slice(0, 25);
  } catch {
    return [];
  }
}

async function ensureYarn() {
  const cache = resolve(ROOT, 'inputs/yarn-release.cjs');
  if (existsSync(cache)) return { path: cache, version: readVersion(cache) };
  const meta = await (await fetch('https://registry.npmjs.org/@yarnpkg/cli-dist', { headers: { accept: 'application/vnd.npm.install-v1+json' } })).json();
  const version = meta['dist-tags'].latest;
  const dir = mkdtempSync(join(tmpdir(), 'yarn-dist-'));
  execFileSync('sh', ['-c', `curl -sL ${JSON.stringify(meta.versions[version].dist.tarball)} | tar xz -C ${JSON.stringify(dir)}`]);
  mkdirSync(dirname(cache), { recursive: true });
  execFileSync('cp', [join(dir, 'package/bin/yarn.js'), cache]);
  rmSync(dir, { recursive: true, force: true });
  return { path: cache, version };
}

function readVersion(p) {
  const m = readFileSync(p, 'utf8').slice(0, 4000).match(/(\d+\.\d+\.\d+)/);
  return m ? m[1] : 'unknown';
}
