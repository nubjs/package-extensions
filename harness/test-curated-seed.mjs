#!/usr/bin/env node
// Regression coverage for curated rules, which must not depend on scan recall.

import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const ROOT = resolve(new URL('..', import.meta.url).pathname);
const dir = mkdtempSync(join(tmpdir(), 'package-extensions-seed-'));

try {
  const scan = join(dir, 'empty-scan.json');
  const manual = join(dir, 'manual-extensions.json');
  const first = join(dir, 'first.json');
  const second = join(dir, 'second.json');
  writeFileSync(scan, `${JSON.stringify({ scanned_ok: 0, failed: [], offenders: [] })}\n`);
  writeFileSync(
    manual,
    `${JSON.stringify({ entries: [['manual-seed-fixture@*', { dependencies: { '@angular/core': '^20.0.0' } }]] })}\n`
  );

  for (const out of [first, second]) {
    execFileSync(process.execPath, ['harness/build.mjs', '--scan', scan, '--manual', manual, '--out', out], {
      cwd: ROOT,
      stdio: 'inherit',
    });
  }

  const a = readFileSync(first, 'utf8');
  const b = readFileSync(second, 'utf8');
  if (a !== b) throw new Error('two rebuilds from the same empty scan produced different output');

  const doc = JSON.parse(a);
  if (doc.packageExtensions['manual-seed-fixture@*']?.dependencies?.['@angular/core'] !== '^20.0.0') {
    throw new Error('manual extension was not emitted without a matching scan result');
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

  const yarnPackages = new Set(yarn.entries.map(([selector]) => selector.slice(0, selector.lastIndexOf('@'))));
  console.log(`curated seed: ${yarn.entries.length} Yarn entries across ${yarnPackages.size} package names and one manual entry survive an empty scan`);
} finally {
  rmSync(dir, { recursive: true, force: true });
}
