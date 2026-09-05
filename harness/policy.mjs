// The policy that turns a detector finding into a `packageExtensions` entry.
//
// WHICH FIELD TO EMIT IS DECIDED BY WHO SUPPLIES THE TARGET, and that was
// settled by measurement rather than by reasoning. An optional peer INSTALLS
// NOTHING — it only tells the resolver that a package may reach for a name — so
// it fixes a phantom exactly when the consumer already has the package and not
// otherwise. Measured 2026-09-05 against Yarn 4.18.0 (PnP, default settings) and
// pnpm 11.25.0 (`hoist: false`), on a fixture whose manifest declares nothing
// and whose entry point requires `is-odd`, with the consumer NOT declaring
// `is-odd`:
//
//   extension            Yarn PnP     pnpm
//   none                 FAIL         FAIL
//   optional peer        FAIL         FAIL     "…(a peer dependency) but it
//                                               isn't provided by your
//                                               application"
//   dependencies         PASS         PASS
//
// So a package that genuinely forgot a dependency needs a real `dependencies`
// entry; an optional peer there is not a conservative choice, it is an inert
// one. The reverse holds for a backend the consumer picked: emitting
// `dependencies` for `@hookform/resolvers` would install all twenty-two
// validation libraries it can adapt.
//
// Which of the two a finding needs is not decidable from the finding alone, so
// `dependencies` comes only from a reviewed override and everything else ships
// as an optional peer. `fieldFor` carries the evidence for that.

/**
 * Targets a consumer chooses and installs, never something to add to their
 * install graph on a package's behalf.
 *
 * This list is what keeps the `runtime` class honest. The detector's guard model
 * is lexical, so an unguarded `require` sitting in a function body that a
 * consumer only calls on demand — a platform probe, an optional integration — is
 * classed `runtime` even though nothing loads it by default. Promoting one of
 * those to a dependency would install a whole framework for every consumer, so a
 * target named here falls back to an optional peer whatever its class.
 *
 * Scoped entries match the whole scope (`@angular/` covers `@angular/upgrade`).
 */
const CONSUMER_SUPPLIED = [
  // Frameworks and runtimes.
  'react', 'react-dom', 'react-native', 'vue', 'svelte', 'preact', 'solid-js', 'angular', 'next',
  'nuxt', 'electron', 'expo', 'bun', 'deno',
  '@angular/', '@vue/', '@nuxt/', '@react-native/', '@sveltejs/',
  // Build and type tooling a project owns.
  'typescript', 'webpack', 'vite', 'rollup', 'esbuild', 'rolldown', 'babel-plugin-macros',
  'eslint', 'prettier', 'postcss', 'tailwindcss',
  '@babel/', '@types/',
  // Test runners.
  'jest', 'vitest', 'mocha', 'cypress', 'playwright', '@jest/', '@playwright/',
  // Monorepo and platform tools.
  'nx', 'storybook', '@storybook/', '@nx/', '@nrwl/',
];

/**
 * Targets supplied by a host process, which no installer can provide.
 *
 * `require('vscode')` is injected by the VS Code extension host at runtime; it
 * is not resolved from `node_modules` and no install can satisfy it. The name is
 * also taken on npm by a deprecated helper package, so both the registry check
 * and the install probe pass it — the same trap as requirejs's `define('lang')`.
 * Emitting a dependency here installs a stranger's code and still does not fix
 * the import.
 */
const HOST_PROVIDED = ['vscode'];

function isConsumerSupplied(target) {
  return CONSUMER_SUPPLIED.some((entry) => (entry.endsWith('/') ? target.startsWith(entry) : target === entry));
}

/**
 * Targets a second copy of BREAKS, as opposed to merely wastes space on.
 *
 * This is the floor for `dependencies`, and it is deliberately much narrower
 * than `CONSUMER_SUPPLIED`. The two lists answer different questions. Being
 * consumer-supplied is about not bloating an install: `@babel/runtime` is
 * something a project owns, but it is stateless helpers, so a duplicate is
 * harmless — which is exactly why Yarn's own database ships
 * `dependencies: {'@babel/runtime': …}` for thirty-odd Gatsby packages, and why
 * a floor built on `CONSUMER_SUPPLIED` failed on Yarn's curated rules.
 *
 * The targets here are the ones where duplication is a RUNTIME FAULT: a second
 * React means two copies of the hook dispatcher and the context registry, so
 * hooks throw and providers silently miss their consumers. Same shape for the
 * other frameworks, for the plugin hosts that compare constructor identity, and
 * for `graphql`, which throws on cross-realm schema objects by name.
 *
 * Being a floor is the point: it outranks a reviewed override and the install
 * probe alike. Both answer "is the import real?" — the probe answers it very
 * well — and neither answers "who should supply the target?". Conflating them
 * put `dependencies: {react: "*"}` on `react-csv@*` for one build, off a
 * perfectly correct probe result.
 */
const DUPLICATION_BREAKS = [
  // A second copy means a second hook dispatcher, context registry or scheduler.
  'react', 'react-dom', 'react-native', 'vue', 'svelte', 'preact', 'solid-js', 'next', 'nuxt',
  'expo', 'electron', '@angular/', '@vue/runtime-core', '@vue/runtime-dom',
  // Plugin hosts that compare identity across the plugin boundary.
  'eslint', 'typescript', 'webpack', 'vite', 'rollup', 'jest', 'vitest', 'nx',
  // Throws by name on objects from another copy of itself.
  'graphql',
];

export function mustNotBeDependency(target) {
  return (
    HOST_PROVIDED.includes(target) ||
    DUPLICATION_BREAKS.some((entry) => (entry.endsWith('/') ? target.startsWith(entry) : target === entry))
  );
}

/**
 * The finding classes, in the order a reader should think about them.
 *
 * `deep-path` a hard phantom reached ONLY by seeding a published file that no
 *            entry point references, which Node's legacy resolution does make
 *            importable when a package ships no `exports` map. Speculative by
 *            construction: it is how `redux-persist/integration/react` is found,
 *            and also where bundler aliases and AMD ids live. Optional peer,
 *            never a promotion candidate.
 *
 * `adapter`  a hard phantom reachable ONLY from a non-`.` exports subpath. The
 *            pick-your-backend shape: `<pkg>/<adapter>` imports a backend the
 *            consumer chose and installed. Optional peer — the consumer has it.
 * `runtime`  a hard phantom on the main entry graph. The package needs this to
 *            run and forgot to say so, and nobody else is going to install it.
 *            Ships as an optional peer and is flagged as a review candidate; see
 *            `fieldFor` for why a real dependency cannot be emitted from a
 *            classifier alone.
 * `types`    reachable ONLY from the `.d.ts` surface, with no runtime edge at
 *            all. It breaks a type-check under a strict layout and nothing else,
 *            so it is an optional peer and is never a promotion candidate. This
 *            is the largest class by some distance — 894 of 1287 hard edges in
 *            the first full scan — and calling it `runtime` would have put a
 *            declaration-file import into the review queue as a missing runtime
 *            dependency.
 * `guarded`  every occurrence sits inside a try/catch or a conditional branch.
 *            The package survives absence by design, so installing the target
 *            unasked would be wrong. Optional peer, which is what lets a
 *            consumer who DOES have it get the feature under a strict layout.
 */
export const CLASSES = ['runtime', 'adapter', 'types', 'deep-path', 'guarded'];

/**
 * Flatten one scan offender into per-target rows.
 *
 * `subpath_adapter_phantoms` is a SUBSET of `hard_phantoms` (the detector
 * partitions by `from_subpath && !from_main`), so the adapter set is subtracted
 * from the hard set rather than concatenated, or every adapter would appear
 * twice.
 */
export function rowsForOffender(offender) {
  const adapters = new Set((offender.subpath_adapter_phantoms ?? []).map((f) => f.package));
  const rows = [];

  for (const f of offender.hard_phantoms ?? []) {
    rows.push(makeRow(offender, f, hardClass(f, adapters)));
  }
  for (const f of offender.soft_phantoms ?? []) {
    rows.push(makeRow(offender, f, 'guarded'));
  }
  return rows;
}

/**
 * Order matters. A finding with NO runtime edge is `types` however it was
 * reached; only then does the detector's own adapter partition apply. An edge
 * carrying both a type reference and a runtime one is a runtime finding — the
 * type surface is not what makes it load.
 */
function hardClass(finding, adapters) {
  if (finding.from_types === true && finding.from_main !== true && finding.from_subpath !== true) return 'types';
  // Reached ONLY by seeding a published file no entry point references. The
  // detector calls this speculative by construction, and it is: nothing in the
  // manifest says a consumer imports that path. The recall is real —
  // `redux-persist/integration/react` is a documented entry point — but so is
  // the noise, because a file nothing references is also where bundler aliases
  // and AMD ids live. Measured over the top 10,000: this seeding added 266 hard
  // edges, and a sample carried `@docusaurus/core -> @generated/client-modules`
  // (a webpack alias), `isomorphic-fetch -> fetch` and
  // `react-zoom-pan-pinch -> components` — none of them packages.
  //
  // So the tier ships as an optional peer, where a wrong entry is inert, and
  // never reaches the review queue: promoting one to a real dependency needs
  // evidence a consumer actually imports that path, which the finding does not
  // carry.
  if (finding.from_deep_path === true && finding.from_main !== true && finding.from_subpath !== true) return 'deep-path';
  return adapters.has(finding.package) ? 'adapter' : 'runtime';
}

function makeRow(offender, finding, klass) {
  return {
    package: offender.package,
    measuredVersion: offender.version,
    target: finding.package,
    class: klass,
    fromMain: finding.from_main === true,
    fromSubpath: finding.from_subpath === true,
    fromTypes: finding.from_types === true,
    specifiers: finding.specifiers ?? [],
  };
}

/**
 * Which manifest field one row becomes, and whether it belongs in the review
 * queue. Exported so the build can record the decision beside the finding.
 *
 * A `dependency` is emitted ONLY from a reviewed override. That is not caution
 * for its own sake — an automatic promotion was tried and produced entries that
 * would do real damage, because a detector reads specifiers and cannot tell
 * three different things apart:
 *
 *   - a genuinely forgotten dependency        `es-abstract` -> `for-each`
 *   - an optional integration nobody wants    `unzipper` -> `@aws-sdk/client-s3`
 *   - a module id that is not a package       `requirejs` -> `lang`
 *
 * The last one is the sharpest. RequireJS's published bundle calls
 * `define('lang', …)` and requires `'lang'` back, so the specifier looks exactly
 * like a bare package reference, and an unrelated package named `lang` really is
 * published — so even a registry check passes it. Installing it would put a
 * stranger's code into every consumer's tree.
 *
 * So the runtime class ships as an optional peer, which is inert when the
 * consumer lacks the target but never wrong, and is flagged `candidate` for a
 * human to read. Promotion happens one entry at a time in `overrides.json`,
 * after someone looks at the package.
 */
const REASONS = {
  adapter: 'adapter class — the consumer picked and installed the backend',
  'deep-path': 'deep-path class — reached only by seeding an unreferenced published file, so the import is speculative',
  types: 'types class — no runtime edge, only a declaration-file reference',
  guarded: 'guarded class — the package handles absence, so nothing may be installed for it',
};

export function fieldFor(row, overrides = {}) {
  const override = overrides[row.package]?.[row.target];
  if (override) {
    // An override is either the bare field name or `{ field, why }`. The second
    // form is preferred: a promotion changes real install graphs, so the reason
    // someone made it belongs beside the decision.
    const field = typeof override === 'string' ? override : override.field;
    const why = typeof override === 'string' ? 'reviewed override' : override.why;
    if (field === 'dependency' && mustNotBeDependency(row.target)) {
      return {
        field: 'peer',
        candidate: false,
        reason: `override asked for a dependency, refused: ${row.target} is supplied by the consumer or its host, so a private copy would break rather than fix it`,
      };
    }
    return { field, candidate: false, reason: why };
  }
  if (row.class !== 'runtime') return { field: 'peer', candidate: false, reason: REASONS[row.class] };
  // The broad list, not the floor. Whether to put a target in front of a
  // reviewer is a question about install bloat, so it covers everything a
  // project supplies itself; whether a reviewer may then choose `dependencies`
  // is a question about breakage, and only `mustNotBeDependency` answers that.
  if (isConsumerSupplied(row.target)) return { field: 'peer', candidate: false, reason: 'target is a framework or tool a consumer installs itself' };
  return {
    field: 'peer',
    candidate: true,
    reason: 'unguarded on the main entry graph — a dependency once reviewed',
  };
}

/** Build the extension body for one package's rows. */
export function extensionFor(pkg, rows, overrides = {}) {
  const ext = {};

  for (const row of rows) {
    if (fieldFor(row, overrides).field === 'dependency') {
      ext.dependencies ??= {};
      ext.dependencies[row.target] = '*';
      continue;
    }
    ext.peerDependencies ??= {};
    ext.peerDependencies[row.target] = '*';
    ext.peerDependenciesMeta ??= {};
    ext.peerDependenciesMeta[row.target] = { optional: true };
  }

  // Sort every map so a regenerated dataset diffs against the previous one by
  // content rather than by whatever order the scan happened to walk in.
  for (const field of ['dependencies', 'peerDependencies', 'peerDependenciesMeta']) {
    if (ext[field]) ext[field] = sortKeys(ext[field]);
  }
  return ext;
}

/**
 * The key both package managers parse: `name@<range>`.
 *
 * The range is `*` and that is a deliberate, documented limit rather than an
 * oversight. The scan measures ONE version — whatever `latest` was that day — so
 * a narrower range would assert something about versions nobody looked at. A
 * stale entry costs little: both package managers merge an extension UNDER the
 * real manifest, so a package that has since declared the dependency wins, and
 * the next regeneration drops the entry. Yarn additionally rejects a key with no
 * range, so it cannot be omitted. Measured: both accept `@*` without complaint.
 */
export function keyFor(pkg) {
  return `${pkg}@*`;
}

export function sortKeys(obj) {
  return Object.fromEntries(Object.entries(obj).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}
