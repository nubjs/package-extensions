import test from 'node:test';
import assert from 'node:assert/strict';
import { registryStatus, assertVerifiedTargets } from './registry.mjs';

test('only a 404 proves absence; other failed requests remain unresolved', async () => {
  for (const [status, expected] of [[200, true], [404, false], [403, null], [429, null], [503, null]]) {
    let calls = 0;
    const actual = await registryStatus('@scope/package', {
      request: async url => { calls++; assert.ok(url.endsWith('%40scope%2Fpackage')); return { status, ok: status === 200 }; },
      wait: async () => {},
    });
    assert.equal(actual, expected);
    assert.equal(calls, status === 429 || status === 503 ? 4 : 1);
  }
  assert.equal(await registryStatus('package', { request: async () => { throw new Error('offline'); }, wait: async () => {} }), null);
});

test('a transient registry error can recover on retry', async () => {
  let attempts = 0;
  assert.equal(await registryStatus('package', { request: async () => ({ status: ++attempts === 1 ? 503 : 200, ok: attempts > 1 }), wait: async () => {} }), true);
  assert.equal(attempts, 2);
});

test('manual seeds fail closed with separate absent and unresolved errors', () => {
  assert.doesNotThrow(() => assertVerifiedTargets(['package'], { package: true }, 'seed'));
  assert.throws(() => assertVerifiedTargets(['package'], { package: false }, 'seed'), /not published/);
  for (const cache of [{ package: null }, {}]) assert.throws(() => assertVerifiedTargets(['package'], cache, 'seed'), /unable to verify.*retry/);
});
