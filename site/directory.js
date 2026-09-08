const form = document.querySelector(".filters");
const search = document.querySelector("#search");
const sort = document.querySelector("#sort");
const tbody = document.querySelector("#directory tbody");
const rows = [...tbody.rows];
let currentSort = "downloads";
const params = new URLSearchParams(location.search);
search.value = params.get("q") ?? "";
if (["downloads", "name"].includes(params.get("sort")))
  sort.value = params.get("sort");

function update() {
  const query = search.value.trim().toLowerCase();
  let visible = 0;
  if (sort.value !== currentSort) {
    rows.sort((a, b) => {
      const names = a.dataset.name.localeCompare(b.dataset.name);
      return sort.value === "name"
        ? names
        : (b.dataset.downloads === "" ? -1 : Number(b.dataset.downloads)) -
            (a.dataset.downloads === "" ? -1 : Number(a.dataset.downloads)) ||
            names;
    });
    const fragment = document.createDocumentFragment();
    for (const row of rows) fragment.append(row);
    tbody.append(fragment);
    currentSort = sort.value;
  }
  for (const row of rows) {
    row.hidden = !row.dataset.name.toLowerCase().includes(query);
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
  if (sort.value !== "downloads") next.set("sort", sort.value);
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
  sort.value = "downloads";
  queueMicrotask(update);
});
update();
