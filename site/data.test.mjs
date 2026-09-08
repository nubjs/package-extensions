import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildDirectory, splitSelector, packagePath, escapeHtml } from './data.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dataset = JSON.parse(readFileSync(resolve(root, 'package-extensions.json')));
const corpus = JSON.parse(readFileSync(resolve(root, 'inputs/corpus.json')));

test('version selectors collapse to one package and preserve scoped names', () => {
  const records = buildDirectory({ findings: [], yarnKeys: [], packageExtensions: {
    'low@*': {}, '@scope/pkg@^1': {}, '@scope/pkg@^2': {}, 'unknown@*': {},
  } }, { packages: ['@scope/pkg', 'low'] });
  assert.deepEqual(records.map(p => p.name), ['@scope/pkg', 'low', 'unknown']);
  assert.equal(records[0].rules.length, 2);
  assert.equal(records[2].rank, null);
  assert.equal(packagePath('@scope/pkg'), '/packages/%40scope/pkg/');
});

test('unsafe HTML is escaped and invalid package paths are rejected', () => {
  assert.equal(escapeHtml('<script>"&\''), '&lt;script&gt;&quot;&amp;&#39;');
  for (const value of ['../escape@*', '@scope/..@*', 'bad/name@*', 'missing', 'name@']) {
    assert.throws(() => splitSelector(value));
  }
});

test('every emitted name has a page, with ranked entries in source order', () => {
  const rows = buildDirectory(dataset, corpus);
  assert.equal(rows.length, new Set(Object.keys(dataset.packageExtensions).map(s => splitSelector(s).name)).size);
  const ranked = rows.filter(p => p.rank !== null);
  assert.deepEqual(ranked.map(p => p.rank), ranked.map(p => p.rank).sort((a, b) => a - b));
  for (const p of rows) {
    const path = resolve(root, 'site/public', decodeURIComponent(packagePath(p.name)).slice(1), 'index.html');
    assert.ok(existsSync(path), path);
    const html = readFileSync(path, 'utf8');
    assert.ok(html.includes(escapeHtml(p.name)));
    assert.ok(html.includes('Package extensions'));
    if (p.finding) assert.ok(html.includes(escapeHtml(p.finding.measuredVersion)));
    else assert.ok(html.includes('There is no matching scan finding'));
  }
});

test('public pages have metadata, source links and safe static scripts', () => {
  for (const route of ['', 'packages', 'guide', 'about']) {
    const html = readFileSync(resolve(root, 'site/public', route, 'index.html'), 'utf8');
    assert.match(html, /<html lang="en">/);
    assert.match(html, /rel="canonical"/);
    assert.match(html, /github.com\/nubjs\/package-extensions/);
    assert.match(html, /npmjs.com\/package\/@nubjs\/extensions/);
    assert.doesNotMatch(html, /<script(?![^>]* src=)/);
  }
});
