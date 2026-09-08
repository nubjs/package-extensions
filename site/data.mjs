export function splitSelector(selector) {
  const at = selector.lastIndexOf("@");
  if (at <= 0 || at === selector.length - 1)
    throw new Error(`Invalid selector: ${selector}`);
  const name = selector.slice(0, at);
  if (
    !/^(@[a-z0-9._-]+\/)?[a-z0-9._-]+$/i.test(name) ||
    name.split("/").some((p) => p === "." || p === "..")
  ) {
    throw new Error(`Invalid package name: ${name}`);
  }
  return { name, range: selector.slice(at + 1) };
}

export function escapeHtml(value) {
  return String(value).replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[
        c
      ])
  );
}

export function buildDirectory(dataset, downloads) {
  const findings = new Map(dataset.findings.map((f) => [f.package, f]));
  const packages = new Map();
  for (const [selector, extension] of Object.entries(
    dataset.packageExtensions
  )) {
    const { name, range } = splitSelector(selector);
    if (!packages.has(name))
      packages.set(name, {
        name,
        downloads: downloads.packages[name] ?? null,
        finding: findings.get(name) ?? null,
        rules: [],
      });
    packages.get(name).rules.push({ selector, range, extension });
  }
  return [...packages.values()].sort(
    (a, b) =>
      (b.downloads ?? -1) - (a.downloads ?? -1) || a.name.localeCompare(b.name)
  );
}

export function formatDownloads(value) {
  return value === null
    ? "Unavailable"
    : new Intl.NumberFormat("en-US", {
        notation: "compact",
        maximumFractionDigits: 1,
      }).format(value);
}
