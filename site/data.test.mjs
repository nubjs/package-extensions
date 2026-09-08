import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildDirectory,
  splitSelector,
  formatDownloads,
  escapeHtml,
} from "./data.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const dataset = JSON.parse(
  readFileSync(resolve(root, "package-extensions.json"))
);
const downloads = JSON.parse(
  readFileSync(resolve(root, "inputs/downloads.json"))
);

test("version selectors collapse to one package and preserve scoped names", () => {
  const records = buildDirectory(
    {
      findings: [],
      yarnKeys: [],
      packageExtensions: {
        "low@*": {},
        "@scope/pkg@^1": {},
        "@scope/pkg@^2": {},
        "unknown@*": {},
      },
    },
    { packages: { "@scope/pkg": 100, low: 0 } }
  );
  assert.deepEqual(
    records.map((p) => p.name),
    ["@scope/pkg", "low", "unknown"]
  );
  assert.equal(records[0].rules.length, 2);
  assert.equal(records[2].downloads, null);
  assert.equal(records[1].downloads, 0);
  assert.equal(formatDownloads(152836339), "152.8M");
  assert.equal(formatDownloads(0), "0");
  assert.equal(formatDownloads(null), "Unavailable");
});

test("unsafe HTML is escaped and invalid package paths are rejected", () => {
  assert.equal(escapeHtml("<script>\"&'"), "&lt;script&gt;&quot;&amp;&#39;");
  for (const value of [
    "../escape@*",
    "@scope/..@*",
    "bad/name@*",
    "missing",
    "name@",
  ]) {
    assert.throws(() => splitSelector(value));
  }
});

test("every emitted name has an expandable entry, sorted by downloads", () => {
  const rows = buildDirectory(dataset, downloads);
  assert.equal(
    rows.length,
    new Set(
      Object.keys(dataset.packageExtensions).map((s) => splitSelector(s).name)
    ).size
  );
  const ranked = rows.filter((p) => p.downloads !== null);
  assert.deepEqual(
    ranked.map((p) => p.downloads),
    ranked.map((p) => p.downloads).sort((a, b) => b - a)
  );
  const html = readFileSync(
    resolve(root, "site/public/packages/index.html"),
    "utf8"
  );
  for (const p of rows) {
    assert.ok(html.includes(`<details id="${escapeHtml(p.name)}">`));
    assert.ok(html.includes("Package extensions"));
    if (p.finding)
      assert.ok(html.includes(escapeHtml(p.finding.measuredVersion)));
    else assert.ok(html.includes("No matching scan evidence"));
  }
  assert.doesNotMatch(
    html,
    /data-rank|data-source|<th[^>]*>Source|id="source"|Curated/
  );
});

test("public pages have metadata, source links and safe static scripts", () => {
  for (const route of ["", "packages"]) {
    const html = readFileSync(
      resolve(root, "site/public", route, "index.html"),
      "utf8"
    );
    assert.match(html, /<html lang="en">/);
    assert.match(html, /rel="canonical"/);
    assert.match(html, /github.com\/nubjs\/package-extensions/);
    assert.match(html, /npmjs.com\/package\/@nubjs\/extensions/);
    assert.doesNotMatch(
      html,
      /<script(?![^>]*(?:src=|type="application\/ld\+json"))/
    );
  }
});

test("all internal links and assets resolve in the built site", () => {
  const output = resolve(root, "site/public");
  for (const file of readdirSync(output, { recursive: true }).filter((f) =>
    f.endsWith(".html")
  )) {
    const html = readFileSync(resolve(output, file), "utf8");
    for (const [, value] of html.matchAll(/(?:href|src)="([^"]+)"/g)) {
      if (!value.startsWith("/")) continue;
      const url = new URL(value, "https://dephantom.dev");
      const path = decodeURIComponent(url.pathname);
      const target = resolve(
        output,
        path.slice(1),
        ...(path.endsWith("/") ? ["index.html"] : [])
      );
      assert.ok(existsSync(target), `${file}: ${value}`);
      if (url.hash)
        assert.ok(
          readFileSync(target, "utf8").includes(`id="${url.hash.slice(1)}"`),
          `${file}: ${value}`
        );
    }
  }
});
