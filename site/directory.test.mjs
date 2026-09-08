import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

test("filtering and blur preserve result nodes so the first click can navigate", () => {
  const listeners = {};
  let moves = 0;
  const rows = [
    { dataset: { name: "zebra", rank: "1", source: "scan" } },
    { dataset: { name: "alpha", rank: "2", source: "curated" } },
  ];
  const elements = {
    ".filters": {
      addEventListener: (name, callback) => (listeners[name] = callback),
    },
    "#search": { value: "" },
    "#source": { value: "all" },
    "#sort": { value: "rank" },
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
