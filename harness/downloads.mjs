import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

const API = "https://api.npmjs.org/downloads/point";
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function validPeriod(value) {
  return (
    /^\d{4}-\d{2}-\d{2}$/.test(value?.start) &&
    /^\d{4}-\d{2}-\d{2}$/.test(value?.end) &&
    [value.start, value.end].every(
      (date) =>
        Number.isFinite(Date.parse(date)) &&
        new Date(date).toISOString().slice(0, 10) === date
    ) &&
    Date.parse(value.end) - Date.parse(value.start) === 6 * 86400000
  );
}

export async function collectDownloads(
  names,
  { request = fetch, wait = sleep, now = new Date(), progress = () => {} } = {}
) {
  async function json(url) {
    for (let attempt = 0; attempt < 3; attempt++) {
      let delay = 1000 * 2 ** attempt;
      try {
        const response = await request(url, {
          signal: AbortSignal.timeout(15_000),
        });
        if (response.ok) return await response.json();
        if (response.status === 404) return null;
        if (response.status === 429)
          delay = Math.max(
            30_000,
            Math.min(
              120_000,
              Number(response.headers?.get("retry-after")) * 1000 || 0
            )
          );
        if (attempt === 2)
          throw new Error(`HTTP ${response.status} from ${url}`);
      } catch (error) {
        if (attempt === 2) throw error;
      }
      if (attempt < 2) await wait(delay);
    }
    throw new Error("npm download API unavailable");
  }

  // Anchor every package to the last complete week available from npm.
  const period = await json(`${API}/last-week`);
  if (!validPeriod(period))
    throw new Error("npm returned an invalid weekly reporting period");
  const unique = [...new Set(names)].sort();
  const unscoped = unique.filter((name) => !name.startsWith("@"));
  const groups = [];
  for (let offset = 0; offset < unscoped.length; offset += 128)
    groups.push(unscoped.slice(offset, offset + 128));
  groups.push(
    ...unique.filter((name) => name.startsWith("@")).map((name) => [name])
  );
  const packages = Object.fromEntries(unique.map((name) => [name, null]));
  let cursor = 0;
  const failures = [];
  await Promise.all(
    Array.from({ length: Math.min(2, groups.length) }, async () => {
      while (cursor < groups.length) {
        const group = groups[cursor++];
        try {
          const data = await json(
            `${API}/${period.start}:${period.end}/${group
              .map(encodeURIComponent)
              .join(",")}`
          );
          for (const name of group) {
            const record = group.length === 1 ? data : data?.[name];
            if (
              record?.package === name &&
              record.start === period.start &&
              record.end === period.end &&
              Number.isSafeInteger(record.downloads) &&
              record.downloads >= 0
            )
              packages[name] = record.downloads;
          }
        } catch (error) {
          failures.push(error.message);
          progress(error.message);
        }
        if (cursor % 20 === 0)
          progress(`${cursor}/${groups.length} download requests`);
        if (failures.length) return;
        await wait(500);
      }
    })
  );
  if (failures.length)
    throw new Error(
      `Download requests failed; keeping the previous snapshot: ${failures.join(
        "; "
      )}`
    );
  const unavailable = unique.filter((name) => packages[name] === null);
  if (unique.length && unavailable.length === unique.length)
    throw new Error(
      "No package download counts could be fetched; keeping the previous snapshot"
    );
  return {
    generatedAt: now.toISOString(),
    source: API,
    start: period.start,
    end: period.end,
    packages,
    unavailable,
  };
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const root = fileURLToPath(new URL("..", import.meta.url));
  const dataset = JSON.parse(
    readFileSync(resolve(root, "package-extensions.json"), "utf8")
  );
  const names = Object.keys(dataset.packageExtensions).map((selector) =>
    selector.slice(0, selector.lastIndexOf("@"))
  );
  const snapshot = await collectDownloads(names, { progress: console.log });
  writeFileSync(
    resolve(root, "inputs/downloads.json"),
    `${JSON.stringify(snapshot, null, 2)}\n`
  );
  console.log(
    `Downloads: ${
      Object.keys(snapshot.packages).length - snapshot.unavailable.length
    } available, ${snapshot.unavailable.length} unavailable (${
      snapshot.start
    }–${snapshot.end})`
  );
}
