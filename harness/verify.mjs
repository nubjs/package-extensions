#!/usr/bin/env node
// Gate the dataset before it is committed.
//
//   node harness/verify.mjs
//
// It asserts SUBSTANCE, not validity. A generator can emit a perfectly
// well-formed document that says nothing, and a test that only checks the shape
// will pass on it forever. So every check here either compares generator output
// against a real CONSUMER parser, or refuses a document that is structurally
// fine and empty.

import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import YAML from 'yaml';
import semver from 'semver';

import { mustNotBeDependency } from './policy.mjs';

const ROOT = resolve(dirname(new URL(import.meta.url).pathname), '..');
const failures = [];
const checks = [];

/**
 * Thrown by a check that cannot apply to this run. Reported as `skip`, never as
 * `ok`: a check that quietly passes when it did not run reads as coverage and is
 * how a gate rots without anyone noticing.
 */
class NotApplicable extends Error {}

function check(name, fn) {
  try {
    const detail = fn();
    checks.push(`  ok   ${name}${detail ? ` — ${detail}` : ''}`);
  } catch (err) {
    if (err instanceof NotApplicable) {
      checks.push(`  skip ${name} — ${err.message}`);
      return;
    }
    failures.push(`  FAIL ${name} — ${err.message}`);
  }
}

const doc = JSON.parse(readFileSync(resolve(ROOT, 'package-extensions.json'), 'utf8'));
const exts = doc.packageExtensions;

/** The corpus a published dataset is built from. A smaller run is a smoke test. */
const FULL_CORPUS = 10000;

// ---------------------------------------------------------------- substance

check('the dataset is not empty', () => {
  const n = Object.keys(exts).length;
  if (n === 0) throw new Error('zero packages — a dataset with no entries is a generator failure, not a clean ecosystem');
  if (n !== doc.totals.packages) throw new Error(`totals.packages says ${doc.totals.packages}, the map holds ${n}`);
  return `${n} packages`;
});

check('every entry carries at least one field', () => {
  const empty = Object.entries(exts).filter(([, v]) => Object.keys(v).length === 0);
  if (empty.length) throw new Error(`${empty.length} empty entries, first: ${empty[0][0]}`);
  return 'no empty entries';
});

const yarnKeys = new Set(doc.yarnKeys ?? []);

check('the findings ledger covers every package this scan contributed', () => {
  // Scoped to our own layer. Yarn's entries are carried verbatim and have no
  // evidence row here by design — their provenance is `@yarnpkg/extensions`.
  const emitted = new Set(Object.keys(exts).filter((k) => !yarnKeys.has(k)).map(stripRange));
  const recorded = new Set(doc.findings.map((f) => f.package));
  const missing = [...emitted].filter((p) => !recorded.has(p));
  if (missing.length) throw new Error(`${missing.length} packages have an extension but no evidence row, first: ${missing[0]}`);
  return `${recorded.size} evidence rows, ${yarnKeys.size} keys carried from Yarn`;
});

check('every Yarn rule survives into the output', () => {
  // THE no-regression guarantee. pnpm applies `@yarnpkg/extensions` by default,
  // so a dataset that replaces it and silently drops a rule breaks installs that
  // work today. Two ways that happened before this check existed: our own scan
  // owning the same selector, and Yarn's list being an ARRAY that repeats a
  // selector, which keying by string collapses.
  // Checked at the level of EFFECT, not of presence. An earlier version compared
  // only the target NAMES, which a rule can survive while its meaning does not:
  // moving Yarn's `dependencies.got` to a peer, or widening its range, or marking
  // a peer Yarn made required as optional, all keep the name and change what the
  // consumer installs. The last of those was real — see `mergeInto`.
  const yarnEntries = JSON.parse(readFileSync(resolve(ROOT, 'inputs/yarn-extensions.json'), 'utf8')).entries;
  const lost = [];
  for (const [selector, ext] of yarnEntries) {
    const ours = exts[selector];
    if (!ours) {
      lost.push(`${selector} (entire entry)`);
      continue;
    }
    for (const field of ['dependencies', 'optionalDependencies', 'peerDependencies']) {
      for (const [name, range] of Object.entries(ext[field] ?? {})) {
        const got = ours[field]?.[name];
        if (got !== range) lost.push(`${selector} -> ${field}.${name}: want ${range}, got ${got ?? 'nothing'}`);
      }
    }
    for (const [name, meta] of Object.entries(ext.peerDependenciesMeta ?? {})) {
      const got = ours.peerDependenciesMeta?.[name];
      if (JSON.stringify(got) !== JSON.stringify(meta)) {
        lost.push(`${selector} -> peerDependenciesMeta.${name}: want ${JSON.stringify(meta)}, got ${JSON.stringify(got)}`);
      }
    }
    // A peer Yarn declares and does not mark optional must stay required.
    for (const name of Object.keys(ext.peerDependencies ?? {})) {
      if (ext.peerDependenciesMeta?.[name]?.optional === true) continue;
      if (ours.peerDependenciesMeta?.[name]?.optional === true) {
        lost.push(`${selector} -> ${name}: Yarn requires this peer, we mark it optional`);
      }
    }
  }
  if (lost.length) throw new Error(`${lost.length} Yarn rule(s) weakened, first: ${lost[0]}`);
  return `all ${yarnEntries.length} Yarn entries preserved field-for-field`;
});

// -------------------------------------------------------- consumer grammar

check('every key is `name@range` with a range Yarn accepts', () => {
  // Yarn throws `Only semver ranges are allowed as keys for the packageExtensions
  // setting` on a key it cannot parse, and it does so at install time — for the
  // consumer, not for us. So the range is validated here with the same semver
  // library both package managers use.
  for (const key of Object.keys(exts)) {
    const at = key.lastIndexOf('@');
    if (at <= 0) throw new Error(`key has no version range: ${key}`);
    const range = key.slice(at + 1);
    if (semver.validRange(range) === null) throw new Error(`invalid semver range in key: ${key}`);
    if (!isValidNpmName(stripRange(key))) throw new Error(`invalid package name in key: ${key}`);
  }
  return `${Object.keys(exts).length} keys`;
});

check('every optional peer is declared as a peer too', () => {
  // `peerDependenciesMeta` marks an EXISTING peer optional. On a target the
  // package never declared there is nothing for it to mark, so both fields are
  // written together. A meta entry with no matching peer is a generator bug that
  // would silently do nothing in the consumer.
  // Our own entries only. Yarn's meta-only entries mark an ALREADY-DECLARED peer
  // optional, which is a different and valid shape — "correcting" one would
  // change upstream data this dataset promises to carry verbatim.
  for (const [key, ext] of Object.entries(exts)) {
    if (yarnKeys.has(key)) continue;
    for (const target of Object.keys(ext.peerDependenciesMeta ?? {})) {
      if (!ext.peerDependencies?.[target]) throw new Error(`${key}: ${target} is marked optional but never declared as a peer`);
    }
  }
  return 'meta and peer fields agree';
});

check('no target is emitted as both a dependency and a peer', () => {
  for (const [key, ext] of Object.entries(exts)) {
    const both = Object.keys(ext.dependencies ?? {}).filter((t) => ext.peerDependencies?.[t]);
    if (both.length) throw new Error(`${key}: ${both.join(', ')} in both dependencies and peerDependencies`);
  }
  return 'fields are disjoint';
});

check('the harness sources are text', () => {
  // A stray NUL byte makes git call a source file binary, so its diff stops
  // rendering and a review sees "Binary files differ" instead of the change.
  // One reached `probe.mjs` inside a template literal, where it separated two
  // interpolations consistently enough that every test still passed.
  const bad = [];
  for (const f of readdirSync(resolve(ROOT, 'harness'))) {
    if (!f.endsWith('.mjs') && !f.endsWith('.json')) continue;
    const buf = readFileSync(resolve(ROOT, 'harness', f));
    const n = buf.reduce((acc, b) => acc + (b === 0 ? 1 : 0), 0);
    if (n) bad.push(`${f} (${n})`);
  }
  if (bad.length) throw new Error(`NUL bytes in ${bad.join(', ')}`);
  return 'no NUL bytes';
});

check('no framework or host-provided target is emitted as a dependency', () => {
  // The most damaging entry this dataset can carry, and the one an install probe
  // actively argues FOR. A component library that requires `react` without
  // declaring it is a true finding, and `dependencies: {react: "*"}` is still the
  // wrong fix: the consumer gets a second React, so hooks and context break at
  // runtime rather than at resolve time. `react-csv@*` shipped exactly that for
  // one build, promoted on a correct probe result.
  // Our own entries only. Yarn's rules are carried verbatim by contract, so a
  // gate that judged them would be asserting against the no-regression promise
  // one check above it.
  const bad = [];
  for (const [key, ext] of Object.entries(exts)) {
    if (yarnKeys.has(key)) continue;
    for (const target of Object.keys(ext.dependencies ?? {})) {
      if (mustNotBeDependency(target)) bad.push(`${key} -> ${target}`);
    }
  }
  if (bad.length) throw new Error(`${bad.length} consumer-supplied target(s) emitted as dependencies: ${bad.join(', ')}`);
  return 'frameworks and host modules ship as peers only';
});

check('only the four fields both package managers apply are used', () => {
  const allowed = new Set(['dependencies', 'optionalDependencies', 'peerDependencies', 'peerDependenciesMeta']);
  for (const [key, ext] of Object.entries(exts)) {
    for (const field of Object.keys(ext)) {
      if (!allowed.has(field)) throw new Error(`${key}: unsupported field ${field}`);
    }
  }
  return 'dependencies / optionalDependencies / peerDependencies / peerDependenciesMeta';
});

check('no dropped target leaked into an emitted entry', () => {
  // The registry-existence gate is only worth having if its verdict survives to
  // the output. An extension naming an unpublished package fails a Yarn install
  // outright, so this is the one check whose failure is user-visible breakage.
  const droppedTargets = new Set([...(doc.dropped?.unpublished ?? []), ...(doc.dropped?.unresolved ?? [])].map((s) => s.split(' -> ')[1]));
  const emitted = new Set();
  for (const ext of Object.values(exts)) {
    for (const field of ['dependencies', 'peerDependencies']) for (const t of Object.keys(ext[field] ?? {})) emitted.add(t);
  }
  const leaked = [...emitted].filter((t) => droppedTargets.has(t));
  if (leaked.length) throw new Error(`${leaked.length} dropped targets emitted anyway, first: ${leaked[0]}`);
  return `${emitted.size} distinct targets, ${droppedTargets.size} dropped`;
});

check('every extension key quoted in the README still exists', () => {
  // The dataset moves under the prose. `@hookform/resolvers` was the README's
  // headline example until the package declared its twenty-two optional peers
  // upstream and vanished from the scan, leaving a documented entry that shipped
  // nowhere. An example nobody can find is worse than no example.
  // The README describes the full corpus, so a reduced run legitimately lacks
  // its examples. Coupling a documentation invariant to corpus size made the
  // workflow's own `top=300` smoke test impossible to pass.
  if (doc.corpus.size < FULL_CORPUS) {
    throw new NotApplicable(`corpus is ${doc.corpus.size}, not a full run — the README documents the ${FULL_CORPUS}-package dataset`);
  }
  const md = readFileSync(resolve(ROOT, 'README.md'), 'utf8');
  const quoted = [...new Set([...md.matchAll(/"([^"]+@\*)"/g)].map((m) => m[1]))];
  const missing = quoted.filter((k) => !exts[k]);
  if (missing.length) throw new Error(`README quotes ${missing.length} key(s) absent from the dataset: ${missing.join(', ')}`);
  return `${quoted.length} quoted keys`;
});

check('every dataset total the README states matches the dataset', () => {
  // The README quotes derived numbers in prose, and nothing was checking them.
  // They drifted across three rebuilds — the headline said 1,055 packages while
  // the dataset held 812, and the class table was a scan and a half out of date.
  // The key-drift check above does not cover this: a stale COUNT names no key.
  if (doc.corpus.size < FULL_CORPUS) {
    throw new NotApplicable(`corpus is ${doc.corpus.size}, not a full run — the README documents the ${FULL_CORPUS}-package dataset`);
  }
  const md = readFileSync(resolve(ROOT, 'README.md'), 'utf8');
  const num = (label, pattern, expected) => {
    const m = md.match(pattern);
    // A pattern that stops matching is reported, never skipped. Reword the prose
    // and this fails, which is the prompt to confirm the number came with it.
    if (!m) return `${label}: the README no longer states this — update ${pattern}`;
    const got = Number(m[1].replace(/,/g, ''));
    return got === expected ? null : `${label}: README says ${got}, dataset has ${expected}`;
  };
  const t = doc.totals;
  const wrong = [
    num('headline packages', /\*\*([\d,]+) packages\.\*\*/, t.packages),
    num('scan-contributed packages', /finds ([\d,]+) with an undeclared dependency/, doc.sources.scan.packages),
    num('total edges', /undeclared dependency across ([\d,]+) edges/, t.entries),
    num('carried from Yarn', /remaining ([\d,]+) come from Yarn/, doc.sources.yarn.addedAsNewKeys),
    ...Object.entries(t.byClass)
      .filter(([, count]) => count > 0)
      .map(([cls, count]) => num(`class ${cls}`, new RegExp(`\\| \`${cls}\` \\| ([\\d,]+) \\|`), count)),
  ].filter(Boolean);
  if (wrong.length) throw new Error(`${wrong.length} stale figure(s): ${wrong.join('; ')}`);
  return `${4 + Object.values(t.byClass).filter((c) => c > 0).length} figures agree`;
});

// --------------------------------------------- generator against a consumer

for (const rel of ['dist/yarnrc.yml', 'dist/pnpm-workspace.yaml']) {
  check(`${rel} round-trips through a real YAML parser`, () => {
    if (!existsSync(resolve(ROOT, rel))) throw new Error('file missing — run harness/emit.mjs');
    const parsed = YAML.parse(readFileSync(resolve(ROOT, rel), 'utf8'));
    if (!parsed?.packageExtensions) throw new Error('no packageExtensions key after parsing');
    assertDeepEqual(parsed.packageExtensions, exts, 'packageExtensions');
    return `${Object.keys(parsed.packageExtensions).length} packages survived the round trip`;
  });
}

check('dist/pnpm-package.json round-trips', () => {
  const parsed = JSON.parse(readFileSync(resolve(ROOT, 'dist/pnpm-package.json'), 'utf8'));
  assertDeepEqual(parsed.pnpm?.packageExtensions, exts, 'pnpm.packageExtensions');
  return `${Object.keys(parsed.pnpm.packageExtensions).length} packages`;
});

// ------------------------------------------------- the published artifact

// `npm/` is what a consumer installs, and `pack.mjs` is not in the rebuild
// chain — so between a data change and a release nothing else here would notice
// it going stale. It shipped stale once, which is why this gate exists.
const packed = await loadPacked();

check('the published npm artifact carries the whole dataset', () => {
  if (!packed) throw new NotApplicable('npm/ not built — run harness/pack.mjs');
  // An ARRAY of pairs, matching `@yarnpkg/extensions`. The shape is load-bearing
  // rather than cosmetic: Yarn's own database repeats a selector, so a consumer
  // written against an object would collapse entries, and the drop-in claim
  // rests on the container being the same one Yarn publishes.
  if (!Array.isArray(packed.cjs)) throw new Error('packageExtensions is not an array');
  if (JSON.stringify(packed.cjs) !== JSON.stringify(packed.esm)) {
    throw new Error('index.js and index.mjs disagree');
  }
  const keys = packed.cjs.map(([selector]) => selector);
  if (new Set(keys).size !== keys.length) throw new Error('a selector is repeated in the packed array');
  assertDeepEqual(Object.fromEntries(packed.cjs), exts, 'npm/index.js');
  return `${keys.length} entries, CJS and ESM identical`;
});

async function loadPacked() {
  const entry = resolve(ROOT, 'npm/index.js');
  if (!existsSync(entry)) return null;
  return {
    cjs: createRequire(import.meta.url)(entry).packageExtensions,
    esm: (await import(pathToFileURL(resolve(ROOT, 'npm/index.mjs')).href)).packageExtensions,
  };
}

// ------------------------------------------------------------------ report

console.log([...checks, ...failures].join('\n'));
if (failures.length) {
  console.error(`\n${failures.length} check(s) failed`);
  process.exit(1);
}
const skipped = checks.filter((c) => c.startsWith('  skip')).length;
console.log(`\nall ${checks.length - skipped} checks passed${skipped ? `, ${skipped} not applicable to this run` : ''}`);

// ----------------------------------------------------------------- helpers

function stripRange(key) {
  return key.slice(0, key.lastIndexOf('@'));
}

function isValidNpmName(name) {
  return /^(?:@[a-z0-9][\w.-]*\/)?[a-z0-9][\w.-]*$/i.test(name) && name.length <= 214;
}

function assertDeepEqual(actual, expected, label) {
  const a = JSON.stringify(sortDeep(actual));
  const b = JSON.stringify(sortDeep(expected));
  if (a !== b) {
    const at = [...a].findIndex((c, i) => c !== b[i]);
    throw new Error(`${label} differs from package-extensions.json near offset ${at}: got ${a.slice(Math.max(0, at - 60), at + 60)}`);
  }
}

function sortDeep(v) {
  if (Array.isArray(v)) return v.map(sortDeep);
  if (v && typeof v === 'object') return Object.fromEntries(Object.keys(v).sort().map((k) => [k, sortDeep(v[k])]));
  return v;
}
