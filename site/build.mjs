import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  rmSync,
  copyFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { buildDirectory, escapeHtml as e, formatDownloads } from "./data.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");
const out = resolve(here, "public");
const read = (name) => JSON.parse(readFileSync(resolve(root, name), "utf8"));
const dataset = read("package-extensions.json");
const downloads = read("inputs/downloads.json");
const packages = buildDirectory(dataset, downloads);
const repository = "https://github.com/nubjs/package-extensions";
const npm = "https://www.npmjs.com/package/@nubjs/extensions";
// Switch the origin after the custom domain is registered and serves HTTPS.
const origin = "https://dephantom.vercel.app";
const revision =
  process.env.VERCEL_GIT_COMMIT_SHA ||
  execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: root,
    encoding: "utf8",
  }).trim();
if (!/^[a-f0-9]{40}$/.test(revision))
  throw new Error("Expected a full git revision");
const source = `${repository}/blob/${revision}`;
const count = packages.length.toLocaleString("en-US");
const period = `${downloads.start}–${downloads.end}`;
const code = (text, label = "package.json") =>
  `<div class="code"><div class="code-label">${e(label)}</div><pre><code>${e(
    text
  )}</code></pre></div>`;

function page(
  path,
  name,
  description,
  body,
  { script = false, missing = false } = {}
) {
  const image = `${origin}/social-${
    path === "/packages/" ? "packages" : "home"
  }.png`;
  const title = `${name} · dephantom`;
  const schema = {
    "@context": "https://schema.org",
    "@type": "WebSite",
    name: "dephantom",
    url: `${origin}/`,
    description,
    sameAs: [repository, npm],
  };
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${e(title)}</title><meta name="description" content="${e(
    description
  )}"><meta name="theme-color" content="#31594d">
${
  missing
    ? '<meta name="robots" content="noindex,follow">'
    : `<link rel="canonical" href="${origin}${path}">`
}
<meta property="og:title" content="${e(
    title
  )}"><meta property="og:description" content="${e(
    description
  )}"><meta property="og:type" content="website"><meta property="og:site_name" content="dephantom"><meta property="og:locale" content="en_US"><meta property="og:url" content="${origin}${path}">
<meta property="og:image" content="${image}"><meta property="og:image:width" content="1200"><meta property="og:image:height" content="630"><meta property="og:image:type" content="image/png"><meta property="og:image:alt" content="dephantom — @nubjs/extensions. An open database of npm package extensions.">
<meta name="twitter:card" content="summary_large_image"><meta name="twitter:title" content="${e(
    title
  )}"><meta name="twitter:description" content="${e(
    description
  )}"><meta name="twitter:image" content="${image}"><meta name="twitter:image:alt" content="dephantom — @nubjs/extensions. An open database of npm package extensions.">
<link rel="icon" href="/favicon.svg" type="image/svg+xml"><link rel="icon" href="/favicon-32.png" type="image/png" sizes="32x32"><link rel="apple-touch-icon" href="/apple-touch-icon.png"><link rel="stylesheet" href="/style.css">
${
  path === "/"
    ? `<script type="application/ld+json">${JSON.stringify(schema).replaceAll(
        "<",
        "\\u003c"
      )}</script>`
    : ""
}
${script ? '<script src="/directory.js" defer></script>' : ""}</head>
<body><a class="skip" href="#main">Skip to content</a><header><a class="brand" href="/"><img src="/favicon.svg" width="36" height="36" alt=""><span>dephantom</span></a><nav aria-label="Main"><a href="/packages/"${
    path === "/packages/" ? ' aria-current="page"' : ""
  }>Packages</a><a href="${repository}">GitHub ↗</a></nav></header>
<main id="main">${body}</main><footer><p>Maintained by <a href="https://nubjs.dev">Nub</a> · <a href="${repository}/blob/main/npm/package.json">MIT licensed</a></p><p><a href="${npm}">@nubjs/extensions</a> · <a href="/#contributing">Contribute</a></p></footer></body></html>`;
}

rmSync(out, { recursive: true, force: true });
mkdirSync(resolve(out, "packages"), { recursive: true });
for (const asset of [
  "style.css",
  "directory.js",
  "favicon.svg",
  "favicon-32.png",
  "apple-touch-icon.png",
  "social-home.png",
  "social-packages.png",
])
  copyFileSync(resolve(here, asset), resolve(out, asset));

const home = `<div class="readme">
<section class="project-intro"><h1>@nubjs/extensions</h1><p>An open database of package extensions for undeclared dependencies in npm packages.</p>
<p class="project-links"><a href="${npm}">npm</a><a href="${repository}">Source code</a><a href="/packages/">${count} packages →</a></p>
${code("import { packageExtensions } from '@nubjs/extensions';", "JavaScript")}
<p>Package extensions add missing dependency declarations to a package’s manifest during resolution. They let package managers support packages that would otherwise fail under an isolated dependency layout.</p></section>
<nav class="contents" aria-label="On this page"><a href="#usage">Usage</a><a href="#phantom-dependencies">Phantom dependencies</a><a href="#maintainers">Fixing a package</a><a href="#contributing">Contributing</a></nav>
<section id="usage"><h2>Usage</h2><p>The npm package exports <code>packageExtensions</code> as an array of <code>[selector, extension]</code> pairs, using the same format as <code>@yarnpkg/extensions</code>.</p>
${code("npm install @nubjs/extensions", "Install")}
${code(
  "import { packageExtensions } from '@nubjs/extensions';\n\n// Convert to the mapping used by packageExtensions configuration.\nconst extensions = Object.fromEntries(packageExtensions);",
  "JavaScript"
)}
<p>The database covers <a href="/packages/">${count} package names</a>. <a href="https://nubjs.dev">Nub</a> incorporates it into dependency resolution. Other tools can consume the export or use its rules in <a href="https://yarnpkg.com/configuration/yarnrc#packageExtensions">Yarn</a> and <a href="https://pnpm.io/settings#packageextensions">pnpm</a> package extensions configuration.</p>
<p class="small">Dataset: ${e(
  dataset.generated
)}. The site reflects the repository; the latest npm release may differ.</p></section>
<section id="phantom-dependencies"><h2>Phantom dependencies</h2><p>A package imports a dependency it has not declared. The import can work in a flat <code>node_modules</code> tree because another package installed that dependency nearby. It can fail when each package can access only its own declared dependencies.</p>
<p>Nub’s <a href="https://github.com/nubjs/nub/tree/main/crates/nub-phantom">phantom detector</a> statically analyzes published code to find these references. The database is rebuilt from a daily scan of the top 10,000 npm packages by downloads. It also retains Yarn’s package extensions and accepts manually contributed rules for cases static analysis cannot detect.</p>
<p>The current snapshot scanned ${dataset.corpus.scannedOk.toLocaleString(
  "en-US"
)} of ${dataset.corpus.size.toLocaleString(
  "en-US"
)} selected packages. Some findings are optional integrations or type references, not unconditional runtime imports. The <a href="/packages/">directory</a> includes version ranges and available evidence.</p></section>
<section id="maintainers"><h2>Fixing a package</h2><p>Declare the dependencies that the published package uses. The appropriate field depends on how the dependency is consumed.</p>
<div class="table-wrap"><table class="fields"><thead><tr><th>Usage</th><th>Manifest field</th></tr></thead><tbody>
<tr><td>A library the package needs its own copy of</td><td><code>dependencies</code></td></tr><tr><td>A compatible host supplied by the application</td><td><code>peerDependencies</code></td></tr><tr><td>A consumer-selected integration</td><td>Optional peer</td></tr><tr><td>A dependency whose failed or omitted install is handled</td><td><code>optionalDependencies</code></td></tr><tr><td>A development or build tool only</td><td><code>devDependencies</code></td></tr></tbody></table></div>
<h3 id="optional-peers">Optional integrations</h3><p>For an optional React integration, declare the peer and mark it optional. Use the version range the package supports:</p>
${code(
  JSON.stringify(
    {
      peerDependencies: { react: "^18.0.0 || ^19.0.0" },
      peerDependenciesMeta: { react: { optional: true } },
    },
    null,
    2
  )
)}
<p>The optional marker does not make an unconditional import safe when React is absent. Keep optional integrations out of the default entry point’s eager import graph. See <a href="https://docs.npmjs.com/cli/v11/configuring-npm/package-json/#peerdependenciesmeta">npm’s optional peer documentation</a>.</p>
<h3>Optional dependencies</h3><p>Use <code>optionalDependencies</code> when installation should be attempted but the package still works if the dependency is unavailable. Unlike optional peers, these dependencies are installed automatically unless omitted. Runtime code must handle their absence.</p>
<h3>Testing the published package</h3><ol><li>Pack the package and install its tarball in a fresh consumer using Yarn Plug’n’Play without fallback, or pnpm with hoisting disabled.</li><li>Exercise every public entry point, including CLI and type entry points. Published type declarations can also reference undeclared packages.</li><li>Test optional integrations both with and without their peers installed. The base entry point should work in both cases.</li><li>Publish the manifest fix and <a href="#contributing">report the corrected version</a> to update the database.</li></ol></section>
<section id="contributing"><h2>Contributing</h2><p>Open an <a href="${repository}/issues/new">issue</a> or <a href="${repository}/pulls">pull request</a> with the package name, version, import path and a reproduction. Corrections, missing entries and version-range updates are welcome.</p>
<p>Add fixed rules to <a href="${repository}/blob/main/inputs/manual-extensions.json">inputs/manual-extensions.json</a>. They are merged into the final database on every rebuild, including rules the detector cannot infer. See the <a href="${repository}#regenerating">repository instructions</a> before editing generated files.</p>
<p>The <a href="${repository}/actions/workflows/rebuild.yml">daily rebuild</a> refreshes scan findings and download estimates. A separate <a href="${repository}/actions/workflows/release.yml">publication workflow</a> publishes changed extension rules. Failed or delayed jobs can leave an older snapshot in place.</p></section></div>`;

function evidence(p) {
  const finding = p.finding;
  const notes = finding
    ? `<p>References recorded in version <code>${e(
        finding.measuredVersion
      )}</code>:</p><ul>${finding.targets
        .map(
          (t) =>
            `<li><code>${e(t.target)}</code> — ${e(t.reason)}${
              t.candidate
                ? " The runtime dependency classification is awaiting review; the extension remains a peer declaration."
                : ""
            }<ul>${t.files
              .map(
                (f) =>
                  `<li><a href="https://unpkg.com/${encodeURIComponent(
                    p.name
                  )}@${encodeURIComponent(finding.measuredVersion)}/${f
                    .split("/")
                    .map(encodeURIComponent)
                    .join("/")}"><code>${e(f)}</code></a></li>`
              )
              .join("")}</ul></li>`
        )
        .join("")}</ul>`
    : "<p>No matching scan evidence is available in this snapshot. Check the rule’s version range before applying it to a current release.</p>";
  return `<div class="entry-body"><p><a href="https://www.npmjs.com/package/${e(
    p.name
  )}">npm package ↗</a> · <a href="${source}/package-extensions.json">Database ↗</a></p>${code(
    JSON.stringify(
      {
        packageExtensions: Object.fromEntries(
          p.rules.map((r) => [r.selector, r.extension])
        ),
      },
      null,
      2
    ),
    "Package extensions"
  )}${notes}</div>`;
}
const rows = packages
  .map(
    (p) =>
      `<tr data-name="${e(p.name)}" data-downloads="${
        p.downloads ?? ""
      }"><td><details id="${e(p.name)}"><summary><span class="package-name">${e(
        p.name
      )}</span></summary>${evidence(p)}</details></td><td class="downloads"${
        p.downloads === null
          ? ""
          : ` title="${p.downloads.toLocaleString(
              "en-US"
            )} downloads · ${period}"`
      }>${formatDownloads(p.downloads)}</td></tr>`
  )
  .join("\n");
const directory = `<h1>Package directory</h1><p>Package extensions for ${count} npm packages, sorted by estimated weekly downloads.</p><p class="small">${period} · Counts from <a href="https://github.com/npm/registry/blob/main/docs/download-counts.md">npm’s downloads API</a>, across all versions. Downloads are not unique users or a count of affected installations. Unavailable estimates appear last.</p>
<form class="filters" role="search"><label>Package name<input type="search" id="search" name="q" placeholder="Search packages…" autocomplete="off"></label><label>Sort by<select id="sort" name="sort"><option value="downloads">Weekly downloads</option><option value="name">Package name</option></select></label><button type="reset">Reset</button></form>
<p id="result-count" class="small" role="status" aria-live="polite">${count} packages</p><table id="directory"><thead><tr><th scope="col">Package</th><th scope="col" class="downloads">Weekly downloads</th></tr></thead><tbody>${rows}</tbody></table><p id="empty" hidden>No packages match. Try a shorter name or reset the filters.</p>
<p class="small directory-note">Expand a package for version ranges and available evidence. A listing does not mean the latest version is broken. Findings include optional integrations and type references; static analysis does not prove every reference causes a runtime failure. Dataset: ${e(
  dataset.generated
)}.</p>`;

writeFileSync(
  resolve(out, "index.html"),
  page(
    "/",
    "@nubjs/extensions — npm package extensions",
    "An open database of package extensions for undeclared npm dependencies, with usage examples, optional peer guidance and contribution instructions.",
    home
  )
);
writeFileSync(
  resolve(out, "packages/index.html"),
  page(
    "/packages/",
    "Package directory",
    "Browse npm packages with package extensions, sorted by estimated weekly downloads. Inspect dependency rules, version ranges and scan evidence.",
    directory,
    { script: true }
  )
);
writeFileSync(
  resolve(out, "404.html"),
  page(
    "/404/",
    "Page not found",
    "This page does not exist.",
    '<h1>Page not found</h1><p><a href="/">Return to the project</a> or <a href="/packages/">browse packages</a>.</p>',
    { missing: true }
  )
);
writeFileSync(
  resolve(out, "sitemap.xml"),
  `<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${[
    "/",
    "/packages/",
  ]
    .map((path) => `<url><loc>${origin}${path}</loc></url>`)
    .join("")}</urlset>\n`
);
writeFileSync(
  resolve(out, "robots.txt"),
  `User-agent: *\nAllow: /\nSitemap: ${origin}/sitemap.xml\n`
);
console.log(
  `Built two pages with ${packages.length} package entries (${revision})`
);
