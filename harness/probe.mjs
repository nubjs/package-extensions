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
// writes those verdicts straight into the reviewed overrides, where they become
// real `dependencies` entries. It only ever ADDS — an existing decision, human
// or otherwise, is never overwritten by a later run.
if (process.argv.includes('--promote')) {
  const path = resolve(ROOT, 'harness/overrides.json');
  const overrides = JSON.parse(readFileSync(path, 'utf8'));
  let added = 0;
  for (const r of results) {
    if (r.verdict !== 'confirmed') continue;
    for (const target of r.confirmed) {
      overrides[r.package] ??= {};
      if (overrides[r.package][target]) continue;
      overrides[r.package][target] = {
        field: 'dependency',
        why: `probe ${r.version}: importing the package under Yarn PnP with pnpFallbackMode none throws "tried to access ${target}"`,
      };
      added++;
    }
  }
  writeFileSync(path, `${JSON.stringify(overrides, null, 2)}\n`);
  console.log(`promoted ${added} confirmed finding(s) into harness/overrides.json`);
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
    // measurement rather than an inference.
    const accessed = new Set();
    for (const r of parsed) {
      if (r.ok) continue;
      for (const m of r.message.matchAll(/tried to access ([@\w./-]+)/g)) accessed.add(m[1]);
    }
    const confirmed = base.expected.filter((t) => accessed.has(t));
    return {
      ...base,
      verdict: confirmed.length ? 'confirmed' : 'notOnImport',
      confirmed,
      accessedButNotPredicted: [...accessed].filter((t) => !base.expected.includes(t)),
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
