#!/usr/bin/env node
// scan record -> package-extensions.json
//
//   node harness/build.mjs --scan records/<run>/scan.json --out package-extensions.json
//
// Every target is checked against the registry before it is emitted. That gate
// is not bureaucracy: the detector reads specifiers out of source, so a typo, a
// name that was unpublished, or a private-registry package all reach it looking
// exactly like a real dependency. An extension naming a package that does not
// exist is worse than no entry — Yarn fails the install outright.

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import semver from 'semver';
import { fileURLToPath } from 'node:url';

import { rowsForOffender, extensionFor, fieldFor, keyFor, sortKeys } from './policy.mjs';
import { fetchYarnDatabase } from './yarn-db.mjs';
import { registryStatus, assertVerifiedTargets } from './registry.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const CACHE = resolve(HERE, '../inputs/registry-cache.json');

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? fallback : process.argv[i + 1];
}

const scanPath = arg('scan');
const outPath = resolve(HERE, '..', arg('out', 'package-extensions.json'));
const overridesPath = resolve(HERE, 'overrides.json');
const manualPath = resolve(HERE, '..', arg('manual', 'inputs/manual-extensions.json'));
const includeGuarded = !process.argv.includes('--no-guarded');

if (!scanPath) {
  console.error('build.mjs: --scan <scan.json> is required');
  process.exit(2);
}

const scan = JSON.parse(readFileSync(resolve(scanPath), 'utf8'));
const overrides = existsSync(overridesPath) ? JSON.parse(readFileSync(overridesPath, 'utf8')) : {};
const manual = JSON.parse(readFileSync(manualPath, 'utf8'));
validateManualEntries(manual, manualPath);

// ---------------------------------------------------------------- flatten

let rows = scan.offenders.flatMap(rowsForOffender);
if (!includeGuarded) rows = rows.filter((r) => r.class !== 'guarded');

// WITHHELD, PENDING A DETECTOR FIX. Deep-path seeding finds real entry points —
// `redux-persist/integration/react` is the reason it exists — but it also parses
// published SOURCE, and a package built with a tsconfig `baseUrl` imports its own
// modules by bare-looking specifiers: pusher-js reaches `core/utils/url_store`
// and `isomorphic/runtime`, react-zoom-pan-pinch reaches `utils/ref.utils`. Those
// name directories inside the package, not packages, so they are outside this
// dataset's contract however Node treats them.
//
// They cannot be told apart HERE. `pusher-js -> core` via `core/utils/...` and
// `swagger-ui-dist -> lodash` via `lodash/merge` are the same shape, and only the
// offender's own file list separates them — which the scan does not carry. A
// filter built on that shape suppresses the true positives and keeps the false
// ones; that was measured before writing this, not assumed.
//
// So the tier is recorded as evidence and not emitted. Withholding costs users
// nothing, because it has never shipped; emitting it would put `pusher-js ->
// express` in a public dataset.
//
// A NOTE ON LIFTING THIS. Audited properly on 2026-09-07 by locating the FILE
// behind each edge rather than reasoning about the package: 153 of the 246 edges
// in the 2026-09-06 scan, being every edge of the 20 largest sources. Seven
// classes, and only the first is publishable:
//
//   real library code      html-tokenize -> sax, from tokenize.js
//   template payload       @nestjs/schematics -> @nestjs/common, from
//                          dist/lib/application/files/js/src/app.module.js — a
//                          file the generator COPIES into a user's project and
//                          never requires itself
//   browser asset          @fastify/swagger-ui -> react, from
//                          static/swagger-ui.js — served over HTTP, never
//                          resolved by Node
//   framework-virtual      @docusaurus/plugin-debug -> @generated/routes —
//                          resolves through a bundler alias, on no registry
//   build-time placeholder next -> VAR_MODULE_APP, MODULE — not npm names
//   build config           troika-three-text -> rollup-plugin-terser, from
//                          rollup.config.build-typr.js
//   test scaffolding       @material-ui/core -> enzyme, from
//                          es/test-utils/createMount.js
//
// A FILENAME HEURISTIC CANNOT SEPARATE THEM, which is the finding. Scoring the
// set with one (scaffolding directories plus `*.config.js`) called 146 of the
// 153 publishable, because `defaults/server-node.mjs`,
// `dist/lib/application/files/js/src/app.module.js` and
// `lib/theme/DebugLayout/index.js` are indistinguishable from real modules by
// their path — and three of the four largest classes look exactly like that.
//
// Corrects an earlier note here. It said the 64 swagger edges came from tarballs
// carrying a bundled `dist` "so every target is already inlined"; that is true of
// swagger-ui-bundle.js and false of the files actually flagged. swagger-ui.js
// really does `require("dompurify")`, swagger-ui-dist@5.32.15 declares only
// @scarf/scarf, and a clean install throws MODULE_NOT_FOUND on
// `require("swagger-ui-dist/swagger-ui.js")`. The edges are real; they are
// withheld because the file is a browser bundle, not because it is inlined.
const withheld = rows.filter((r) => r.class === 'deep-path');
rows = rows.filter((r) => r.class !== 'deep-path');

const manualTargets = new Set(
  manual.entries.flatMap(([, extension]) => [
    ...Object.keys(extension.dependencies ?? {}),
    ...Object.keys(extension.optionalDependencies ?? {}),
    ...Object.keys(extension.peerDependencies ?? {}),
    ...Object.keys(extension.peerDependenciesMeta ?? {}),
  ])
);
const targets = [...new Set([...rows.map((r) => r.target), ...manualTargets])].sort();
console.error(`${rows.length} findings across ${new Set(rows.map((r) => r.package)).size} packages, ${targets.length} distinct targets`);

// ------------------------------------------------------- registry existence

const cache = existsSync(CACHE) ? JSON.parse(readFileSync(CACHE, 'utf8')) : {};
const unknown = targets.filter((t) => cache[t] == null);

if (unknown.length) {
  console.error(`checking ${unknown.length} targets against the registry...`);
  const CONCURRENCY = 16;
  let cursor = 0;
  let done = 0;
  await Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, unknown.length) }, async () => {
      for (;;) {
        const i = cursor++;
        if (i >= unknown.length) return;
        cache[unknown[i]] = await registryStatus(unknown[i]);
        if (++done % 50 === 0) console.error(`  ${done}/${unknown.length}`);
      }
    })
  );
  mkdirSync(dirname(CACHE), { recursive: true });
  writeFileSync(CACHE, `${JSON.stringify(sortKeys(cache), null, 2)}\n`);
}

assertVerifiedTargets(manualTargets, cache, manualPath);

// A bundler artifact that happens to be a real package name. webpack's UMD
// wrapper writes each external's name into the header, and a misconfigured
// external comes out as the literal `null`:
//
//   module.exports = t(require("null"))                 redoc.standalone.js
//
// npm has a package called `null`, so the published-target check above waves it
// straight through and the rule ships. It shipped: `redoc@*` carried
// `peerDependencies: { null: "*" }` in the 2026-09-07 dataset. Nothing depends
// on these names deliberately, and one false positive costs more trust than the
// rules it sits beside are worth.
const BUNDLER_LITERALS = new Set(['null', 'undefined', 'true', 'false', 'NaN']);

const dropped = { unpublished: [], unresolved: [], bundlerLiteral: [] };
rows = rows.filter((r) => {
  if (BUNDLER_LITERALS.has(r.target)) {
    dropped.bundlerLiteral.push(`${r.package} -> ${r.target}`);
    return false;
  }
  if (cache[r.target] === true) return true;
  (cache[r.target] === false ? dropped.unpublished : dropped.unresolved).push(`${r.package} -> ${r.target}`);
  return false;
});
for (const k of Object.keys(dropped)) dropped[k] = [...new Set(dropped[k])].sort();

// ------------------------------------------------------------------ emit

const byPackage = new Map();
for (const row of rows) {
  if (!byPackage.has(row.package)) byPackage.set(row.package, []);
  byPackage.get(row.package).push(row);
}

const packageExtensions = {};
const findings = [];
for (const pkg of [...byPackage.keys()].sort()) {
  const pkgRows = byPackage.get(pkg);
  packageExtensions[keyFor(pkg)] = extensionFor(pkg, pkgRows, overrides);
  findings.push({
    package: pkg,
    measuredVersion: pkgRows[0].measuredVersion,
    targets: pkgRows
      .map((r) => {
        const { field, candidate, reason } = fieldFor(r, overrides);
        // `files` is the citation: the published path a reader can open to
        // check the rule themselves. Omitted rather than emitted empty when the
        // scan predates it, so an absent field never reads as "no evidence".
        const cite = r.files.length ? { files: r.files, fileCount: r.fileCount } : {};
        return { target: r.target, class: r.class, field, candidate, reason, specifiers: r.specifiers, ...cite };
      })
      .sort((a, b) => (a.target < b.target ? -1 : 1)),
  });
}

// Yarn's own database, included verbatim so that swapping this dataset in for
// `@yarnpkg/extensions` can never lose an entry. pnpm applies that database by
// DEFAULT (`createReadPackageHook` merges it unless `ignoreCompatibilityDb` is
// set), so a pnpm user already has these 159 rules and a replacement that
// dropped them would be a silent regression.
//
// Yarn's keys are kept exactly as published — `debug@<4.2.0`, not `debug@*` —
// and ours are separate `@*` keys. Both package managers accept several entries
// for one package and apply whichever ranges match, so the two layers coexist
// with no merge and Yarn's version precision survives intact.
const yarn = await fetchYarnDatabase();
const yarnSelectors = new Set();
const addYarnEntries = (entries) => {
  let added = 0;
  let merged = 0;
  for (const entry of entries) {
    if (!Array.isArray(entry) || entry.length !== 2) {
      throw new Error(`invalid curated extension: ${JSON.stringify(entry)}`);
    }
    const [selector, ext] = entry;
    if (typeof selector !== 'string' || !ext || typeof ext !== 'object' || Array.isArray(ext)) {
      throw new Error(`invalid curated extension: ${JSON.stringify(entry)}`);
    }
    if (packageExtensions[selector]) {
    // Two ways a key collides, and skipping either one drops a rule. Our scan
    // may already own the exact selector (`eslint-plugin-import@*`), and Yarn's
    // own list is an ARRAY that repeats a selector — `gatsby-core-utils@<2.14.0
    // -next.1` appears twice with different fields — so keying it by string
    // collapses the duplicates. Both are real losses, both measured. Union the
    // fields instead of choosing.
      if (
        mergeInto(packageExtensions[selector], ext, {
          preferIncoming: !yarnSelectors.has(selector),
          removeMissingPeerMeta: !yarnSelectors.has(selector),
          conflictLabel: `Yarn seed ${selector}`,
        })
      ) merged++;
      yarnSelectors.add(selector);
      continue;
    }
    packageExtensions[selector] = structuredClone(ext);
    yarnSelectors.add(selector);
    added++;
  }
  return { added, merged };
};

const addManualEntries = (entries) => {
  let added = 0;
  let merged = 0;
  for (const [selector, ext] of entries) {
    if (!packageExtensions[selector]) {
      packageExtensions[selector] = structuredClone(ext);
      added++;
      continue;
    }
    if (
      mergeInto(packageExtensions[selector], ext, {
        // A selector can contain both a Yarn rule and a scan-only target. The
        // manual layer may correct the latter, so precedence cannot be decided
        // from the selector alone. Apply it, then compare every original Yarn
        // field below; a change to an actual Yarn rule is rejected there.
        preferIncoming: true,
        removeMissingPeerMeta: true,
        conflictLabel: `manual extension ${selector}`,
      })
    ) merged++;
  }
  return { added, merged };
};

const yarnResult = addYarnEntries(yarn.entries);
const manualResult = addManualEntries(manual.entries);
assertYarnRulesPreserved(packageExtensions, yarn.entries);
const packageName = (selector) => selector.slice(0, selector.lastIndexOf('@'));
const scanPackages = new Set(byPackage.keys());
const yarnPackages = new Set(yarn.entries.map(([selector]) => packageName(selector)));
const manualPackages = new Set(manual.entries.map(([selector]) => packageName(selector)));

/** Merge a curated rule, applying the source-specific precedence declared by the caller. */
function mergeInto(into, from, { preferIncoming = false, rejectConflicts = false, removeMissingPeerMeta = false, conflictLabel }) {
  let changed = false;
  const providerFields = ['dependencies', 'optionalDependencies', 'peerDependencies'];
  for (const field of providerFields) {
    for (const name of Object.keys(from[field] ?? {})) {
      for (const other of providerFields) {
        if (other === field || into[other]?.[name] === undefined) continue;
        if (rejectConflicts) throw new Error(`${conflictLabel}: ${name} is already in ${other}, not ${field}`);
        if (preferIncoming) {
          delete into[other][name];
          if (other === 'peerDependencies') delete into.peerDependenciesMeta?.[name];
          changed = true;
        }
      }
    }
  }
  for (const field of providerFields) {
    for (const [name, range] of Object.entries(from[field] ?? {})) {
      into[field] ??= {};
      if (into[field][name] === undefined || (preferIncoming && into[field][name] !== range)) {
        into[field][name] = range;
        changed = true;
      } else if (rejectConflicts && into[field][name] !== range) {
        throw new Error(`${conflictLabel}: ${field}.${name} is ${into[field][name]}, not ${range}`);
      }
    }
  }
  for (const [name, meta] of Object.entries(from.peerDependenciesMeta ?? {})) {
    into.peerDependenciesMeta ??= {};
    if (into.peerDependenciesMeta[name] === undefined || (preferIncoming && JSON.stringify(into.peerDependenciesMeta[name]) !== JSON.stringify(meta))) {
      into.peerDependenciesMeta[name] = structuredClone(meta);
      changed = true;
    } else if (rejectConflicts && JSON.stringify(into.peerDependenciesMeta[name]) !== JSON.stringify(meta)) {
      throw new Error(`${conflictLabel}: peerDependenciesMeta.${name} differs`);
    }
  }
  // A curated peer with no metadata is required. Removing a scanner-generated
  // `optional: true` is therefore part of applying the curated rule, not an
  // omission. This is disabled for a manual rule sharing a Yarn selector: that
  // layer may add fields but may never weaken Yarn's required peers.
  for (const name of Object.keys(from.peerDependencies ?? {})) {
    if (!removeMissingPeerMeta || Object.hasOwn(from.peerDependenciesMeta ?? {}, name) || !into.peerDependenciesMeta?.[name]) continue;
    delete into.peerDependenciesMeta[name];
    changed = true;
  }
  return changed;
}

function assertYarnRulesPreserved(extensions, entries) {
  const weakened = [];
  for (const [selector, extension] of entries) {
    const emitted = extensions[selector];
    if (!emitted) {
      weakened.push(`${selector} is missing`);
      continue;
    }
    for (const field of ['dependencies', 'optionalDependencies', 'peerDependencies']) {
      for (const [name, range] of Object.entries(extension[field] ?? {})) {
        if (emitted[field]?.[name] !== range) weakened.push(`${selector} -> ${field}.${name}: want ${range}, got ${emitted[field]?.[name] ?? 'nothing'}`);
      }
    }
    for (const [name, meta] of Object.entries(extension.peerDependenciesMeta ?? {})) {
      if (JSON.stringify(emitted.peerDependenciesMeta?.[name]) !== JSON.stringify(meta)) weakened.push(`${selector} -> peerDependenciesMeta.${name} changed`);
    }
    for (const name of Object.keys(extension.peerDependencies ?? {})) {
      if (extension.peerDependenciesMeta?.[name]?.optional !== true && emitted.peerDependenciesMeta?.[name]?.optional === true) {
        weakened.push(`${selector} -> ${name} was made optional`);
      }
    }
  }
  if (weakened.length) throw new Error(`manual extensions weaken the Yarn seed: ${weakened[0]}`);
}

function validateManualEntries(manual, path) {
  if (!Array.isArray(manual.entries)) throw new Error(`${path}: expected an entries array`);
  const fields = new Set(['dependencies', 'optionalDependencies', 'peerDependencies', 'peerDependenciesMeta']);
  for (const entry of manual.entries) {
    if (!Array.isArray(entry) || entry.length !== 2 || typeof entry[0] !== 'string' || !entry[1] || typeof entry[1] !== 'object' || Array.isArray(entry[1])) {
      throw new Error(`${path}: invalid curated extension ${JSON.stringify(entry)}`);
    }
    const [selector, extension] = entry;
    if (Object.keys(extension).length === 0) throw new Error(`${path}: empty extension for ${selector}`);
    const at = selector.lastIndexOf('@');
    const packageName = selector.slice(0, at);
    const range = selector.slice(at + 1);
    if (at <= 0 || !isValidNpmName(packageName) || semver.validRange(range) === null) {
      throw new Error(`${path}: invalid selector ${selector}`);
    }
    for (const [field, data] of Object.entries(extension)) {
      if (!fields.has(field) || !data || typeof data !== 'object' || Array.isArray(data)) throw new Error(`${path}: invalid ${field} for ${selector}`);
      for (const [target, value] of Object.entries(data)) {
        if (!isValidNpmName(target)) throw new Error(`${path}: invalid target ${target} for ${selector}`);
        if (field === 'peerDependenciesMeta') {
          if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some((key) => key !== 'optional') || ('optional' in value && typeof value.optional !== 'boolean')) {
            throw new Error(`${path}: invalid peerDependenciesMeta.${target} for ${selector}`);
          }
        } else if (typeof value !== 'string' || semver.validRange(value) === null) {
          throw new Error(`${path}: invalid ${field}.${target} for ${selector}`);
        }
      }
    }
  }
}

function isValidNpmName(name) {
  return /^(?:@[a-z0-9][\w.-]*\/)?[a-z0-9][\w.-]*$/i.test(name) && name.length <= 214;
}

const counts = { runtime: 0, adapter: 0, types: 0, 'deep-path': 0, guarded: 0 };
const fieldCounts = { dependency: 0, peer: 0 };
// The review queue: findings that would be a real `dependencies` entry if a
// human confirmed the target is a package the offender genuinely needs its own
// copy of. Recorded here rather than emitted, and separate from the extension
// map so nothing in `dist/` depends on an unreviewed judgement.
const candidates = [];
for (const r of rows) {
  counts[r.class]++;
  const { field, candidate } = fieldFor(r, overrides);
  fieldCounts[field === 'dependency' ? 'dependency' : 'peer']++;
  if (candidate) {
    candidates.push({
      package: r.package,
      measuredVersion: r.measuredVersion,
      target: r.target,
      specifiers: r.specifiers,
    });
  }
}
candidates.sort((a, b) => (a.package === b.package ? (a.target < b.target ? -1 : 1) : a.package < b.package ? -1 : 1));

const doc = {
  generated: new Date().toISOString().slice(0, 10),
  corpus: {
    ranking: 'npm-high-impact topDownload',
    size: (scan.scanned_ok ?? 0) + (scan.failed?.length ?? 0),
    scannedOk: scan.scanned_ok,
    failed: scan.failed?.length ?? 0,
  },
  sources: {
    scan: { entries: rows.length, packages: byPackage.size },
    yarn: {
      package: '@yarnpkg/extensions',
      version: yarn.version,
      entries: yarn.entries.length,
      packages: yarnPackages.size,
      packagesOutsideScan: [...yarnPackages].filter((name) => !scanPackages.has(name)).length,
      addedAsNewKeys: yarnResult.added,
      mergedIntoExistingKeys: yarnResult.merged,
    },
    manual: {
      entries: manual.entries.length,
      packages: manualPackages.size,
      addedAsNewKeys: manualResult.added,
      mergedIntoExistingKeys: manualResult.merged,
    },
  },
  totals: {
    // A package name can have several range selectors. The headline count is
    // package names; selectors are reported separately so a range split is not
    // mistaken for another affected package.
    packages: new Set(Object.keys(packageExtensions).map(packageName)).size,
    selectors: Object.keys(packageExtensions).length,
    entries: rows.length,
    byClass: counts,
    byField: { dependency: fieldCounts.dependency, peer: fieldCounts.peer },
    candidatesForReview: candidates.length,
    droppedUnpublishedTargets: dropped.unpublished.length,
    droppedBundlerLiterals: dropped.bundlerLiteral.length,
    droppedUnresolvedTargets: dropped.unresolved.length,
    // Found, recorded, deliberately not emitted. See the withholding note above.
    withheldDeepPath: withheld.length,
  },
  // Withheld, but recorded in full and with its citations: the whole reason this
  // tier does not ship is that the file behind an edge decides whether the rule
  // is a legacy entry point or a template a generator copies out, and a reader
  // cannot check that claim from a package name alone. docs/deep-path-tier.md
  // walks the seven classes.
  withheldDeepPath: withheld
    .map((r) => ({
      package: r.package,
      target: r.target,
      specifiers: r.specifiers,
      ...(r.files.length ? { files: r.files } : {}),
    }))
    .sort((a, b) => (`${a.package} ${a.target}` < `${b.package} ${b.target}` ? -1 : 1)),
  yarnKeys: yarn.entries.map(([selector]) => selector).sort(),
  manualKeys: manual.entries.map(([selector]) => selector).sort(),
  packageExtensions,
  findings,
  candidates,
  dropped,
};

mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, `${JSON.stringify(doc, null, 2)}\n`);
console.error(
  `wrote ${outPath}: ${doc.totals.packages} packages, ${doc.totals.entries} entries ` +
    `(${counts.runtime} runtime, ${counts.adapter} adapter, ${counts.types} types, ${counts.guarded} guarded; ` +
    `${fieldCounts.dependency} dependency, ${fieldCounts.peer} peer), ` +
    `${dropped.unpublished.length} dropped as unpublished, ` +
    `${dropped.bundlerLiteral.length} as bundler literals, ` +
    `${candidates.length} candidates for review; ` +
    `+${yarnResult.added} from @yarnpkg/extensions@${yarn.version}, ` +
    `+${manualResult.added} manually curated`
);
