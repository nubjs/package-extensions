import test from "node:test";
import assert from "node:assert/strict";
import { collectDownloads, validPeriod } from "./downloads.mjs";

const period = { start: "2026-08-31", end: "2026-09-06" };
const record = (name, downloads) => ({ ...period, package: name, downloads });

test("weekly counts use one period, deduplicate names and isolate scoped requests", async () => {
  const urls = [];
  const snapshot = await collectDownloads(
    ["alpha", "alpha", "zero", "missing", "@scope/name"],
    {
      wait: async () => {},
      request: async (url) => {
        urls.push(url);
        return {
          ok: true,
          json: async () =>
            url.endsWith("last-week")
              ? period
              : url.includes("%40scope")
              ? record("@scope/name", 500)
              : {
                  alpha: record("alpha", 100),
                  zero: record("zero", 0),
                  missing: null,
                },
        };
      },
    }
  );
  assert.deepEqual(snapshot.packages, {
    "@scope/name": 500,
    alpha: 100,
    missing: null,
    zero: 0,
  });
  assert.deepEqual(snapshot.unavailable, ["missing"]);
  assert.equal(urls.length, 3);
  assert.ok(
    urls.slice(1).every((url) => url.includes(`${period.start}:${period.end}`))
  );
});

test("bulk requests do not exceed the npm limit", async () => {
  const names = Array.from({ length: 260 }, (_, i) => `package-${i}`);
  const batches = [];
  await collectDownloads(names, {
    wait: async () => {},
    request: async (url) => {
      if (url.endsWith("last-week"))
        return { ok: true, json: async () => period };
      const batch = url.split("/").at(-1).split(",");
      batches.push(batch.length);
      return {
        ok: true,
        json: async () =>
          Object.fromEntries(batch.map((name) => [name, record(name, 10)])),
      };
    },
  });
  assert.deepEqual(batches, [128, 128, 4]);
});

test("invalid or wholly unavailable data cannot replace the snapshot", async () => {
  assert.equal(validPeriod({ start: "invalid", end: period.end }), false);
  assert.equal(validPeriod({ start: period.end, end: period.start }), false);
  for (const bad of [
    record("wrong-package", 42),
    record("alpha", -1),
    record("alpha", "42"),
    { ...record("alpha", 10), end: "2026-09-07" },
  ]) {
    await assert.rejects(
      collectDownloads(["alpha"], {
        wait: async () => {},
        request: async (url) => ({
          ok: true,
          json: async () => (url.endsWith("last-week") ? period : bad),
        }),
      }),
      /No package download counts/
    );
  }
});

test("rate limits back off, and exhausted transport errors preserve the snapshot", async () => {
  const delays = [];
  let calls = 0;
  const snapshot = await collectDownloads(["alpha"], {
    wait: async (ms) => delays.push(ms),
    request: async (url) =>
      url.endsWith("last-week")
        ? { ok: true, json: async () => period }
        : ++calls === 1
        ? { ok: false, status: 429 }
        : { ok: true, json: async () => record("alpha", 10) },
  });
  assert.equal(snapshot.packages.alpha, 10);
  assert.ok(delays.includes(30_000));
  await assert.rejects(
    collectDownloads(["alpha"], {
      wait: async () => {},
      request: async (url) =>
        url.endsWith("last-week")
          ? { ok: true, json: async () => period }
          : { ok: false, status: 503 },
    }),
    /Download requests failed/
  );
});
