#!/usr/bin/env node
// Regression coverage for curated rules, which must not depend on scan recall.

import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const ROOT = resolve(new URL('..', import.meta.url).pathname);
const dir = mkdtempSync(join(tmpdir(), 'package-extensions-seed-'));

try {
  const scan = join(dir, 'scan.json');
  const manual = join(dir, 'manual-extensions.json');
  const conflictingManual = join(dir, 'conflicting-manual-extensions.json');
  const invalidManual = join(dir, 'invalid-manual-extensions.json');
  const first = join(dir, 'first.json');
  const second = join(dir, 'second.json');
  writeFileSync(
    scan,
    `${JSON.stringify({
      scanned_ok: 2,
      failed: [],
      offenders: [
        {
          package: 'manual-seed-fixture',
          version: '1.0.0',
          hard_phantoms: [
            { package: '@angular/core', from_main: true },
            { package: '@angular/compiler', from_main: true },
          ],
        },
        {
          package: 'reactcss',
          version: '1.0.0',
          hard_phantoms: [{ package: 'react', from_main: true }],
        },
      ],
    })}\n`
  );
  writeFileSync(
    manual,
    `${JSON.stringify({ entries: [
      ['manual-seed-fixture@*', {
        dependencies: { '@angular/core': '^20.0.0' },
        peerDependencies: { '@angular/compiler': '^20.0.0' },
        peerDependenciesMeta: { '@angular/compiler': { optional: false } },
      }],
      ['manual-without-scan@*', { peerDependencies: { '@angular/platform-browser': '^20.0.0' } }],
    ] })}\n`
  );
  writeFileSync(conflictingManual, `${JSON.stringify({ entries: [['reactcss@*', { peerDependencies: { react: '^20.0.0' } }]] })}\n`);
  writeFileSync(invalidManual, `${JSON.stringify({ entries: [['not a selector', { dependencies: { doesNotMatter: '*' } }]] })}\n`);

  for (const out of [first, second]) {
    build(scan, manual, out, 'inherit');
  }

  const a = readFileSync(first, 'utf8');
  const b = readFileSync(second, 'utf8');
  if (a !== b) throw new Error('two rebuilds from the same scan produced different output');

  const doc = JSON.parse(a);
  const manualExtension = doc.packageExtensions['manual-seed-fixture@*'];
  if (manualExtension?.dependencies?.['@angular/core'] !== '^20.0.0' || manualExtension.peerDependencies?.['@angular/core']) {
    throw new Error('manual dependency did not replace the scanner peer');
  }
  if (manualExtension.peerDependencies?.['@angular/compiler'] !== '^20.0.0' || manualExtension.peerDependenciesMeta?.['@angular/compiler']?.optional !== false) {
    throw new Error('manual rule did not replace the scanner range and optional metadata');
  }
  const unscanned = doc.packageExtensions['manual-without-scan@*'];
  if (unscanned?.peerDependencies?.['@angular/platform-browser'] !== '^20.0.0' || unscanned.peerDependenciesMeta?.['@angular/platform-browser']) {
    throw new Error('manual required peer was not emitted without a matching scanner result');
  }
  const reactcss = doc.packageExtensions['reactcss@*'];
  if (reactcss?.peerDependencies?.react !== '*' || reactcss.peerDependenciesMeta?.react) {
    throw new Error('Yarn required peer was weakened by the scanner result');
  }

  const yarn = JSON.parse(readFileSync(resolve(ROOT, 'inputs/yarn-extensions.json'), 'utf8'));
  for (const [selector, extension] of yarn.entries) {
    const emitted = doc.packageExtensions[selector];
    if (!emitted) throw new Error(`Yarn seed selector disappeared: ${selector}`);
    for (const field of ['dependencies', 'optionalDependencies', 'peerDependencies']) {
      for (const [name, range] of Object.entries(extension[field] ?? {})) {
        if (emitted[field]?.[name] !== range) throw new Error(`Yarn seed changed: ${selector} -> ${field}.${name}`);
      }
    }
    for (const [name, meta] of Object.entries(extension.peerDependenciesMeta ?? {})) {
      if (JSON.stringify(emitted.peerDependenciesMeta?.[name]) !== JSON.stringify(meta)) {
        throw new Error(`Yarn seed metadata changed: ${selector} -> ${name}`);
      }
    }
  }

  expectFailure(
    () => build(scan, conflictingManual, join(dir, 'conflict.json'), 'pipe'),
    'manual extension reactcss@* conflicts with the Yarn seed'
  );
  expectFailure(() => build(scan, invalidManual, join(dir, 'invalid.json'), 'pipe'), 'invalid selector not a selector');

  const yarnPackages = new Set(yarn.entries.map(([selector]) => selector.slice(0, selector.lastIndexOf('@'))));
  console.log(`curated seed: scanner/manual precedence, Yarn conflict rejection, and ${yarn.entries.length} Yarn entries across ${yarnPackages.size} package names`);
} finally {
  rmSync(dir, { recursive: true, force: true });
}

function build(scan, manual, out, stdio) {
  return execFileSync(process.execPath, ['harness/build.mjs', '--scan', scan, '--manual', manual, '--out', out], {
    cwd: ROOT,
    stdio,
  });
}

function expectFailure(fn, expected) {
  try {
    fn();
  } catch (error) {
    const output = `${error.stdout ?? ''}${error.stderr ?? ''}${error.message ?? ''}`;
    if (output.includes(expected)) return;
    throw new Error(`expected ${JSON.stringify(expected)}, got ${output}`);
  }
  throw new Error(`expected build failure containing ${JSON.stringify(expected)}`);
}
