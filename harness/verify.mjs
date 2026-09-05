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

import { readFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

import YAML from 'yaml';
import semver from 'semver';

const ROOT = resolve(dirname(new URL(import.meta.url).pathname), '..');
const failures = [];
const checks = [];

function check(name, fn) {
  try {
    const detail = fn();
    checks.push(`  ok   ${name}${detail ? ` — ${detail}` : ''}`);
  } catch (err) {
    failures.push(`  FAIL ${name} — ${err.message}`);
  }
}

const doc = JSON.parse(readFileSync(resolve(ROOT, 'package-extensions.json'), 'utf8'));
const exts = doc.packageExtensions;

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

check('the findings ledger covers every emitted package', () => {
  const emitted = new Set(Object.keys(exts).map(stripRange));
  const recorded = new Set(doc.findings.map((f) => f.package));
  const missing = [...emitted].filter((p) => !recorded.has(p));
  if (missing.length) throw new Error(`${missing.length} packages have an extension but no evidence row, first: ${missing[0]}`);
  return `${recorded.size} evidence rows`;
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
  for (const [key, ext] of Object.entries(exts)) {
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

// ------------------------------------------------------------------ report

console.log([...checks, ...failures].join('\n'));
if (failures.length) {
  console.error(`\n${failures.length} check(s) failed`);
  process.exit(1);
}
console.log(`\nall ${checks.length} checks passed`);

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
