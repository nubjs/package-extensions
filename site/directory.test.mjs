import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

test("filtering and blur preserve result nodes so the first click can navigate", () => {
  const listeners = {};
  let moves = 0;
  const rows = [
    { dataset: { name: "zebra", downloads: "1000" } },
    { dataset: { name: "alpha", downloads: "900" } },
  ];
  const elements = {
    ".filters": {
      addEventListener: (name, callback) => (listeners[name] = callback),
    },
    "#search": { value: "" },
    "#sort": { value: "downloads" },
    "#directory tbody": { rows, append: () => moves++ },
    "#result-count": {},
    "#empty": {},
  };
  runInNewContext(
    readFileSync(new URL("./directory.js", import.meta.url), "utf8"),
    {
      document: {
        querySelector: (key) => elements[key],
        createDocumentFragment: () => ({
          append() {
            moves++;
          },
        }),
      },
      URLSearchParams,
      location: { search: "", pathname: "/packages/" },
      history: { replaceState() {} },
      queueMicrotask: (fn) => fn(),
    }
  );
  elements["#search"].value = "zebra";
  listeners.input();
  listeners.change();
  assert.equal(moves, 0, "blur must not detach the link being clicked");
  assert.equal(elements["#result-count"].textContent, "1 package");
  assert.equal(rows[1].hidden, true);
  elements["#search"].value = "missing";
  listeners.input();
  assert.equal(elements["#empty"].hidden, false);
  listeners.reset();
  assert.equal(elements["#result-count"].textContent, "2 packages");
  elements["#sort"].value = "name";
  listeners.change();
  assert.equal(moves, 3);
  listeners.change();
  assert.equal(moves, 3, "unchanged sorting must not move nodes");
});

test("download sorting is numeric and puts zero before unavailable", () => {
  const listeners = {};
  const rows = ["2", "", "100", "0"].map((downloads, i) => ({
    dataset: { name: `package-${i}`, downloads },
  }));
  let sorted;
  let url;
  const elements = {
    ".filters": {
      addEventListener: (name, callback) => (listeners[name] = callback),
    },
    "#search": { value: "" },
    "#sort": { value: "downloads" },
    "#directory tbody": {
      rows,
      append: (fragment) => (sorted = fragment.rows),
    },
    "#result-count": {},
    "#empty": {},
  };
  runInNewContext(
    readFileSync(new URL("./directory.js", import.meta.url), "utf8"),
    {
      document: {
        querySelector: (key) => elements[key],
        createDocumentFragment: () => ({
          rows: [],
          append(row) {
            this.rows.push(row);
          },
        }),
      },
      URLSearchParams,
      location: { search: "?sort=name&source=curated", pathname: "/packages/" },
      history: { replaceState: (_a, _b, value) => (url = value) },
      queueMicrotask: (fn) => fn(),
    }
  );
  assert.equal(url, "/packages/?sort=name");
  elements["#sort"].value = "downloads";
  listeners.change();
  assert.equal(sorted.map((r) => r.dataset.downloads).join(","), "100,2,0,");
  assert.equal(url, "/packages/");
});
