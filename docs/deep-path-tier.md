# The deep-path tier, and why it is withheld

A package's manifest names the files a consumer is meant to load — `main`, `bin`, an `exports` map. Node's legacy resolution ignores that and lets a consumer import any published file by path, so long as the package publishes no `exports` map. `redux-persist/lib/integration/react` is the canonical case: a real entry point, documented in the package's own README, invisible to any walk that starts at the manifest.

The scanner seeds every such file as a speculative entry point, in a second phase after the manifest-reachable walk reaches its fixpoint. A reference that carries only that provenance bit is the deep-path tier. In the 2026-09-06 scan of the top 10,000 packages it is 246 edges across 97 packages, and **none of them ship**. This is what is in them.

## Seven classes, one publishable

Auditing them needed the file each reference was found in — the provenance bit alone cannot tell a legacy entry point from a file that merely happened to be in the tarball. The scanner emits that path now. Below is every edge of the 20 largest sources, 153 of the 246.

| class | example | tell |
| --- | --- | --- |
| **real library code** | `html-tokenize -> sax`, from `tokenize.js` | an ordinary module |
| template payload | `@nestjs/schematics -> @nestjs/common`, from `dist/lib/application/files/js/src/app.module.js` | a generator's file tree, copied *into* a user's project and never required by the package itself |
| browser asset | `@fastify/swagger-ui -> react`, from `static/swagger-ui.js` | served over HTTP; Node never resolves it |
| framework-virtual | `@docusaurus/plugin-debug -> @generated/routes` | resolves through a bundler alias, exists on no registry |
| build-time placeholder | `next -> VAR_MODULE_APP`, `next -> MODULE` | not an npm name at all |
| build config | `troika-three-text -> rollup-plugin-terser`, from `rollup.config.build-typr.js` | a config file that shipped |
| test scaffolding | `@material-ui/core -> enzyme`, from `es/test-utils/createMount.js` | test helpers in a package with no `files` field |

Only the first is a rule anyone should install.

## A filename rule cannot separate them

The obvious filter is the file's path: drop anything under `test/`, `spec/`, `examples/`, `scripts/`, and anything matching `*.config.js`. Scored against the 153 audited edges it calls **146 of them publishable** — it catches the build configs and the test directories, and misses everything else, because the three largest unpublishable classes look exactly like real modules:

```
defaults/server-node.mjs                              a template injected into a user's build
dist/lib/application/files/js/src/app.module.js       a scaffold the generator copies out
lib/theme/DebugLayout/index.js                        imports specifiers only a bundler resolves
static/swagger-ui.js                                  a browser bundle
```

Nothing in those paths says so. Lifting the withholding needs each class answered on its own terms, not one filter.

## The edges are real, which is the awkward part

They are not false positives. `swagger-ui-dist@5.32.15` declares exactly one dependency, `@scarf/scarf`, and `swagger-ui.js` externalizes twenty-odd packages:

```
swagger-ui.js                 require("dompurify")  require("immutable")  require("classnames")
swagger-ui-es-bundle-core.js  from"dompurify"       from"base64-js"       from"classnames"
swagger-ui-bundle.js          (none — inlined)
swagger-ui-es-bundle.js       (none — inlined)
```

On a clean install, `require("swagger-ui-dist/swagger-ui.js")` throws `MODULE_NOT_FOUND`. The reference is genuine and the resolution genuinely fails. It is withheld because the file is a browser bundle for a `<script>` tag, and a rule that made every consumer of `swagger-ui-dist` install React would be worse than the failure it prevents.

That distinction is invisible without the path. An earlier reading of this same block called it a bundled `dist` with every target already inlined — true of `swagger-ui-bundle.js`, false of the two files actually flagged.

## Reproducing

The published dataset records every withheld edge under `withheldDeepPath`, and from a scan carrying file provenance each one cites its files:

```sh
node -e 'const d=require("./package-extensions.json");
console.log(d.withheldDeepPath.filter(e=>e.package==="swagger-ui-dist").slice(0,3))'
```

So a class above can be checked by opening the package rather than rerunning the scan. `totals.withheldDeepPath` carries the count.

## Changelog

- 2026-09-07 — Initial write-up.
