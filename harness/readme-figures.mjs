// The derived numbers the README states in prose, in one place.
//
// Two consumers read this table and they MUST agree: `verify.mjs` gates the
// README against the dataset, and `sync-readme.mjs` rewrites it to match. Two
// copies of these patterns would drift, and the failure would be silent in the
// worst direction — a sync that updates three figures while the gate checks
// four still fails, and a sync that updates a figure the gate does not check
// rewrites prose nobody verified.

/** @returns {{label: string, pattern: RegExp, expected: number}[]} */
export function readmeFigures(doc) {
  const t = doc.totals;
  return [
    { label: 'headline package names', pattern: /\*\*([\d,]+) package names\.\*\*/, expected: t.packages },
    { label: 'scan-contributed packages', pattern: /finds ([\d,]+) with an undeclared dependency/, expected: doc.sources.scan.packages },
    { label: 'total edges', pattern: /undeclared dependency across ([\d,]+) edges/, expected: t.entries },
    { label: 'Yarn package names', pattern: /Yarn seed contributes ([\d,]+) package names/, expected: doc.sources.yarn.packages },
    { label: 'Yarn package names outside scan', pattern: /including ([\d,]+) not found by the scan/, expected: doc.sources.yarn.packagesOutsideScan },
    ...Object.entries(t.byClass)
      .filter(([, count]) => count > 0)
      .map(([cls, count]) => ({
        label: `class ${cls}`,
        pattern: new RegExp(`\\| \`${cls}\` \\| ([\\d,]+) \\|`),
        expected: count,
      })),
  ];
}

/**
 * Format `n` the way `sample` is written, so a rewrite does not silently
 * restyle the prose around it — the README uses `1,190` in one sentence and
 * `812` in another, and both are deliberate.
 */
export function likeSample(n, sample) {
  return sample.includes(',') || n >= 1000 ? n.toLocaleString('en-US') : String(n);
}
