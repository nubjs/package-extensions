#!/usr/bin/env node
// Show the code behind a candidate, so a promotion decision is made by reading
// rather than by guessing from the name.
//
//   node harness/inspect.mjs @firebase/database @firebase/app
//   node harness/inspect.mjs --queue 20        # walk the review queue
//
// Prints every line of the published tarball that names the target, with the
// file it came from. A candidate is promotable when those lines are ordinary
// unconditional uses of a library. It is NOT when they are a platform probe, an
// optional integration behind a feature check, or — the case that motivated this
// tool — an AMD `define()` id that only looks like a package name.

import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { dirname } from 'node:path';

const ROOT = resolve(dirname(new URL(import.meta.url).pathname), '..');
const args = process.argv.slice(2);

if (args[0] === '--queue') {
  const limit = Number(args[1] ?? 20);
  const { candidates } = JSON.parse(readFileSync(join(ROOT, 'package-extensions.json'), 'utf8'));
  for (const c of candidates.slice(0, limit)) await show(c.package, c.target);
} else if (args.length === 2) {
  await show(args[0], args[1]);
} else {
  console.error('usage: inspect.mjs <package> <target>   |   inspect.mjs --queue [n]');
  process.exit(2);
}

async function show(pkg, target) {
  console.log(`\n${'='.repeat(70)}\n${pkg}  ->  ${target}\n${'='.repeat(70)}`);
  const dir = mkdtempSync(join(tmpdir(), 'inspect-'));
  try {
    const meta = await (await fetch(`https://registry.npmjs.org/${pkg.replace(/\//g, '%2f')}`, {
      headers: { accept: 'application/vnd.npm.install-v1+json' },
    })).json();
    const version = meta['dist-tags'].latest;
    const tarball = meta.versions[version].dist.tarball;
    const manifest = meta.versions[version];

    execFileSync('sh', ['-c', `curl -sL ${JSON.stringify(tarball)} | tar xz -C ${JSON.stringify(dir)}`]);
    const root = join(dir, 'package');

    console.log(`version ${version}`);
    for (const field of ['dependencies', 'peerDependencies', 'optionalDependencies']) {
      const names = Object.keys(manifest[field] ?? {});
      if (names.length) console.log(`  ${field}: ${names.length} declared${names.includes(target) ? `  <-- ALREADY DECLARES ${target}` : ''}`);
    }

    let shown = 0;
    for (const file of walk(root)) {
      if (!/\.(m|c)?[jt]sx?$/.test(file)) continue;
      let text;
      try {
        text = readFileSync(file, 'utf8');
      } catch {
        continue;
      }
      for (const [i, line] of text.split('\n').entries()) {
        if (!line.includes(`'${target}`) && !line.includes(`"${target}`)) continue;
        console.log(`  ${relative(root, file)}:${i + 1}  ${line.trim().slice(0, 140)}`);
        if (++shown >= 12) return;
      }
    }
    if (shown === 0) console.log('  (no literal reference found — the specifier may be built at runtime)');
  } catch (err) {
    console.log(`  ERROR ${err.message}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function* walk(dir) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of entries) {
    const full = join(dir, name);
    let st;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    if (st.isDirectory()) yield* walk(full);
    else yield full;
  }
}
