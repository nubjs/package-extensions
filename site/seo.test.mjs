import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";

const read = (path) =>
  readFileSync(new URL(`./public/${path}`, import.meta.url), "utf8");
const origin = "https://dephantom.vercel.app";

test("both canonical pages carry complete, distinct SEO and social metadata", () => {
  const titles = new Set();
  const descriptions = new Set();
  for (const route of ["", "packages/"]) {
    const html = read(`${route}index.html`);
    assert.equal([...html.matchAll(/<h1>/g)].length, 1);
    assert.doesNotMatch(html, /<pre(?! tabindex="0")/);
    const title = html.match(/<title>(.*?)<\/title>/)[1];
    const description = html.match(/name="description" content="([^"]+)"/)[1];
    titles.add(title);
    descriptions.add(description);
    assert.ok(title.length <= 65);
    assert.ok(description.length >= 80 && description.length <= 160);
    assert.ok(html.includes(`rel="canonical" href="${origin}/${route}"`));
    assert.ok(html.includes(`property="og:url" content="${origin}/${route}"`));
    for (const tag of [
      "og:title",
      "og:description",
      "og:type",
      "og:site_name",
      "og:locale",
      "og:image",
      "og:image:width",
      "og:image:height",
      "og:image:type",
      "og:image:alt",
      "twitter:card",
      "twitter:title",
      "twitter:description",
      "twitter:image",
      "twitter:image:alt",
    ]) {
      assert.equal(
        [
          ...html.matchAll(
            new RegExp(`(?:property|name)="${tag}" content="[^"]+"`, "g")
          ),
        ].length,
        1,
        tag
      );
    }
    assert.match(html, /name="twitter:card" content="summary_large_image"/);
    assert.doesNotMatch(html, /noindex|dephantom\.dev/);
    const image = html.match(/property="og:image" content="([^"]+)"/)[1];
    assert.equal(new URL(image).origin, origin);
    const bytes = readFileSync(
      new URL(`./public${new URL(image).pathname}`, import.meta.url)
    );
    assert.equal(bytes.toString("hex", 0, 8), "89504e470d0a1a0a");
    assert.equal(bytes.readUInt32BE(16), 1200);
    assert.equal(bytes.readUInt32BE(20), 630);
    assert.ok(bytes.length < 5_000_000);
    assert.ok(html.includes(`name="twitter:image" content="${image}"`));
  }
  assert.equal(titles.size, 2);
  assert.equal(descriptions.size, 2);
});

test("crawl surface is limited to two pages and an unindexed error page", () => {
  const sitemap = read("sitemap.xml");
  assert.deepEqual(
    [...sitemap.matchAll(/<loc>(.*?)<\/loc>/g)].map((m) => m[1]),
    [`${origin}/`, `${origin}/packages/`]
  );
  assert.match(
    read("robots.txt"),
    /Allow: \/\nSitemap: https:\/\/dephantom\.vercel\.app\/sitemap.xml/
  );
  assert.match(read("404.html"), /name="robots" content="noindex,follow"/);
  assert.doesNotMatch(read("404.html"), /rel="canonical"/);
  const pages = readdirSync(new URL("./public/", import.meta.url), {
    recursive: true,
  }).filter((p) => p.endsWith(".html"));
  assert.deepEqual(pages.sort(), [
    "404.html",
    "index.html",
    "packages/index.html",
  ]);
  const schema = JSON.parse(
    read("index.html").match(
      /<script type="application\/ld\+json">(.*?)<\/script>/
    )[1]
  );
  assert.equal(schema["@type"], "WebSite");
  assert.equal(schema.url, `${origin}/`);
  assert.equal(schema.name, "dephantom");
  assert.ok(
    schema.sameAs.includes("https://www.npmjs.com/package/@nubjs/extensions")
  );
});
