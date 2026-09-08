export function splitSelector(selector) {
  const at = selector.lastIndexOf('@');
  if (at <= 0 || at === selector.length - 1) throw new Error(`Invalid selector: ${selector}`);
  const name = selector.slice(0, at);
  if (!/^(@[a-z0-9._-]+\/)?[a-z0-9._-]+$/i.test(name) || name.split('/').some(p => p === '.' || p === '..')) {
    throw new Error(`Invalid package name: ${name}`);
  }
  return { name, range: selector.slice(at + 1) };
}

export function packagePath(name) {
  return `/packages/${name.split('/').map(encodeURIComponent).join('/')}/`;
}

export function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

export function buildDirectory(dataset, corpus) {
  const ranks = new Map(corpus.packages.map((name, index) => [name, index + 1]));
  const findings = new Map(dataset.findings.map(f => [f.package, f]));
  const yarn = new Set(dataset.yarnKeys);
  const packages = new Map();
  for (const [selector, extension] of Object.entries(dataset.packageExtensions)) {
    const { name, range } = splitSelector(selector);
    if (!packages.has(name)) packages.set(name, {
      name, rank: ranks.get(name) ?? null, finding: findings.get(name) ?? null, rules: [],
    });
    packages.get(name).rules.push({ selector, range, extension, yarn: yarn.has(selector) });
  }
  return [...packages.values()].sort((a, b) => (a.rank ?? Infinity) - (b.rank ?? Infinity) || a.name.localeCompare(b.name));
}
