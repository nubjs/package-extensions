const form = document.querySelector(".filters");
const search = document.querySelector("#search");
const source = document.querySelector("#source");
const sort = document.querySelector("#sort");
const tbody = document.querySelector("#directory tbody");
const rows = [...tbody.rows];
let currentSort = "rank";
const params = new URLSearchParams(location.search);
search.value = params.get("q") ?? "";
if (["all", "scan", "curated"].includes(params.get("source")))
  source.value = params.get("source");
if (["rank", "name"].includes(params.get("sort")))
  sort.value = params.get("sort");

function update() {
  const query = search.value.trim().toLowerCase();
  let visible = 0;
  if (sort.value !== currentSort) {
    rows.sort((a, b) => {
      const names = a.dataset.name.localeCompare(b.dataset.name);
      return sort.value === "name"
        ? names
        : (Number(a.dataset.rank) || Infinity) -
            (Number(b.dataset.rank) || Infinity) || names;
    });
    const fragment = document.createDocumentFragment();
    for (const row of rows) fragment.append(row);
    tbody.append(fragment);
    currentSort = sort.value;
  }
  for (const row of rows) {
    row.hidden =
      !row.dataset.name.toLowerCase().includes(query) ||
      (source.value !== "all" && row.dataset.source !== source.value);
    if (!row.hidden) visible++;
  }
  document.querySelector(
    "#result-count"
  ).textContent = `${visible.toLocaleString()} package${
    visible === 1 ? "" : "s"
  }`;
  document.querySelector("#empty").hidden = visible !== 0;
  const next = new URLSearchParams();
  if (search.value) next.set("q", search.value);
  if (source.value !== "all") next.set("source", source.value);
  if (sort.value !== "rank") next.set("sort", sort.value);
  history.replaceState(
    null,
    "",
    `${location.pathname}${next.size ? `?${next}` : ""}`
  );
}

form.addEventListener("submit", (event) => {
  event.preventDefault();
  update();
});
form.addEventListener("input", update);
form.addEventListener("change", update);
form.addEventListener("reset", () => {
  search.value = "";
  source.value = "all";
  sort.value = "rank";
  queueMicrotask(update);
});
update();
