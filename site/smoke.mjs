import assert from "node:assert/strict";

const origin = new URL(process.argv[2] || "https://dephantom.vercel.app")
  .origin;
const get = (path) =>
  fetch(`${origin}${path}`, {
    redirect: "manual",
    signal: AbortSignal.timeout(30_000),
  });
for (const path of ["/", "/packages/"]) {
  const response = await get(path);
  assert.equal(response.status, 200, path);
  assert.match(response.headers.get("content-type"), /text\/html/);
  assert.ok(!response.headers.get("x-robots-tag")?.includes("noindex"));
  const html = await response.text();
  assert.ok(html.includes(`rel="canonical" href="${origin}${path}"`));
  assert.ok(html.includes('name="twitter:card" content="summary_large_image"'));
  assert.ok(!html.includes('content="noindex'));
  const url = html.match(/property="og:image" content="([^"]+)"/)[1];
  const image = await fetch(url, { signal: AbortSignal.timeout(30_000) });
  assert.equal(image.status, 200);
  assert.match(image.headers.get("content-type"), /image\/png/);
  const bytes = Buffer.from(await image.arrayBuffer());
  assert.equal(bytes.readUInt32BE(16), 1200);
  assert.equal(bytes.readUInt32BE(20), 630);
  console.log(
    `PASS ${path}: public HTML, canonical URL, Twitter card and 1200×630 PNG`
  );
}
for (const [from, to] of [
  ["/guide/", "/#maintainers"],
  ["/about/", "/#contributing"],
  ["/packages/debug/", "/packages/?q=debug"],
  ["/packages/%40babel/parser/", "/packages/?q=%40babel%2Fparser"],
]) {
  const response = await get(from);
  assert.equal(response.status, 308, from);
  assert.equal(response.headers.get("location"), to, from);
  console.log(`PASS ${from} → ${to}`);
}
const missing = await get("/not-a-real-page/");
assert.equal(missing.status, 404);
assert.match(await missing.text(), /name="robots" content="noindex,follow"/);
const robots = await get("/robots.txt");
assert.equal(robots.status, 200);
assert.ok((await robots.text()).includes(`Sitemap: ${origin}/sitemap.xml`));
const sitemap = await get("/sitemap.xml");
assert.equal(sitemap.status, 200);
assert.deepEqual(
  [...(await sitemap.text()).matchAll(/<loc>(.*?)<\/loc>/g)].map((m) => m[1]),
  [`${origin}/`, `${origin}/packages/`]
);
console.log("PASS 404, robots.txt and two-page sitemap");
