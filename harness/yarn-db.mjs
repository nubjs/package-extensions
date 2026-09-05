// Yarn's own `packageExtensions` database, fetched from npm and cached.
//
// It is included in this dataset verbatim, which is a compatibility guarantee
// rather than a convenience: pnpm merges `@yarnpkg/extensions` into every
// install unless `ignoreCompatibilityDb` is set, and Yarn ships it inside the
// binary. Anyone swapping this dataset in for that one must not lose a rule, so
// every entry Yarn publishes is carried through even where our own scan found
// nothing.
//
// The cache under `inputs/` is what makes a rebuild reproducible and a diff
// readable — a regenerated dataset should change because the scan changed, not
// because Yarn published while the job was running.

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

const ROOT = resolve(dirname(new URL(import.meta.url).pathname), '..');
const CACHE = join(ROOT, 'inputs/yarn-extensions.json');

/**
 * Returns `{ version, entries: [[selector, extension], …] }`.
 *
 * Pass `refresh` to re-fetch; otherwise a cached copy is reused so a rebuild is
 * deterministic. A network failure with a cache present is not fatal — dropping
 * Yarn's rules silently would be the actual harm.
 */
export async function fetchYarnDatabase({ refresh = false } = {}) {
  if (!refresh && existsSync(CACHE)) return JSON.parse(readFileSync(CACHE, 'utf8'));

  const dir = mkdtempSync(join(tmpdir(), 'yarn-ext-'));
  try {
    const meta = await (await fetch('https://registry.npmjs.org/@yarnpkg/extensions', {
      headers: { accept: 'application/vnd.npm.install-v1+json' },
    })).json();
    const version = meta['dist-tags'].latest;
    const tarball = meta.versions[version].dist.tarball;
    execFileSync('sh', ['-c', `curl -sL ${JSON.stringify(tarball)} | tar xz -C ${JSON.stringify(dir)}`]);

    const mod = await import(join(dir, 'package/lib/index.js'));
    const raw = mod.packageExtensions ?? mod.default?.packageExtensions;
    if (!Array.isArray(raw) || raw.length === 0) {
      throw new Error('@yarnpkg/extensions exported no entries — refusing to write an empty cache');
    }

    const doc = { package: '@yarnpkg/extensions', version, fetched: new Date().toISOString().slice(0, 10), entries: raw };
    mkdirSync(dirname(CACHE), { recursive: true });
    writeFileSync(CACHE, `${JSON.stringify(doc, null, 1)}\n`);
    return doc;
  } catch (err) {
    if (existsSync(CACHE)) {
      console.error(`warning: could not refresh @yarnpkg/extensions (${err.message}); using the cached copy`);
      return JSON.parse(readFileSync(CACHE, 'utf8'));
    }
    throw err;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
