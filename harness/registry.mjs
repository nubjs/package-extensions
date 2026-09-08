const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

export async function registryStatus(name, { request = fetch, wait = sleep } = {}) {
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const response = await request(`https://registry.npmjs.org/${encodeURIComponent(name)}`, {
        method: 'HEAD',
        headers: { accept: 'application/vnd.npm.install-v1+json' },
        signal: AbortSignal.timeout(15_000),
      });
      if (response.status === 404) return false;
      if (response.ok) return true;
      if (response.status !== 429 && response.status < 500) return null;
    } catch {
      // A failed request provides no evidence about whether a package exists.
    }
    if (attempt < 3) await wait(500 * 2 ** attempt);
  }
  return null;
}

export function assertVerifiedTargets(targets, cache, label) {
  const absent = [...targets].filter(name => cache[name] === false);
  const unresolved = [...targets].filter(name => cache[name] !== true && cache[name] !== false);
  if (absent.length) throw new Error(`${label}: target(s) are not published on npm: ${absent.join(', ')}`);
  if (unresolved.length) throw new Error(`${label}: unable to verify target(s) against npm; retry the build: ${unresolved.join(', ')}`);
}
