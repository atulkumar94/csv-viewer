/*
 * CSV Reader page script: file picking, rendering one page of rows, and sending queries to the
 * worker (worker.js), which holds the data and does all parsing, filtering and sorting.
 */
(() => {
  "use strict";

  const $ = id => document.getElementById(id);
  const ui = {
    headers: [], types: [], filters: [], global: "", sort: [],   // sort: [{col, dir: 1 | -1}]
    page: 0, pageSize: 100, fileName: ""
  };
  let worker = null, workerUrl = null, queryId = 0, busyTimer = 0;
  let nameCells = [], filterInputs = [];

  const thead = document.querySelector("#table thead");
  const tbody = document.querySelector("#table tbody");

  // ---------- Worker ----------
  function startWorker() {
    stopWorker();
    workerUrl = URL.createObjectURL(new Blob([`(${csvReaderWorker.toString()})(self);`], { type: "text/javascript" }));
    worker = new Worker(workerUrl);
    worker.onmessage = onWorkerMessage;
    worker.onerror = e => {
      e.preventDefault();
      setLoading(false);
      showError("The file reader stopped unexpectedly" + (e.message ? `: ${e.message}` : ".") +
        " The file may be too large for this device's memory.");
    };
  }

  function stopWorker() {
    if (worker) worker.terminate();
    if (workerUrl) URL.revokeObjectURL(workerUrl);
    worker = workerUrl = null;
  }

  function onWorkerMessage({ data: m }) {
    switch (m.type) {
      case "progress": {
        $("bar").value = m.total ? m.loaded / m.total : 0;
        $("loadText").textContent = `Reading ${formatBytes(m.loaded)} of ${formatBytes(m.total)} · ${m.rows.toLocaleString()} rows`;
        break;
      }
      case "loaded": {
        setLoading(false);
        ui.headers = m.headers;
        ui.types = m.types;
        ui.filters = m.headers.map(() => "");
        ui.sort = []; ui.global = ""; ui.page = 0;
        $("global").value = "";
        $("fileName").textContent = `Loaded ${ui.fileName}. Choose another file to replace it.`;
        if (m.ragged) {
          showNote(`${m.ragged.toLocaleString()} row(s) have a different number of values than the header row. Missing cells are shown blank.`);
        }
        buildHeader();
        $("viewer").hidden = false;
        document.body.classList.add("has-file");
        requestQuery();
        break;
      }
      case "result": {
        if (m.id !== queryId) return;   // a newer query is on its way
        setBusy(false);
        ui.page = m.page;
        render(m);
        break;
      }
      case "export": {
        const a = document.createElement("a");
        a.href = URL.createObjectURL(m.blob);
        a.download = ui.fileName.replace(/\.[^.]+$/, "") + "_filtered.csv";
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(a.href), 10000);
        $("export").disabled = false;
        break;
      }
      case "error": {
        setBusy(false);
        if (m.during === "load") {
          setLoading(false);
          stopWorker();
          showError(`Could not read ${ui.fileName}: ${m.message}`);
        } else {
          $("export").disabled = false;
          showError(m.message);
        }
        break;
      }
    }
  }

  function requestQuery() {
    queryId++;
    setBusy(true);
    worker.postMessage({
      type: "query", id: queryId, filters: ui.filters, global: ui.global,
      sort: ui.sort, page: ui.page, pageSize: ui.pageSize
    });
  }

  // ---------- Loading ----------
  function load(file) {
    showError(""); showNote("");
    $("viewer").hidden = true;
    document.body.classList.remove("has-file");
    ui.fileName = file.name;
    startWorker();
    setLoading(true, file);
    worker.postMessage({ type: "load", file });
  }

  function setLoading(on, file) {
    $("loading").hidden = !on;
    if (on) {
      $("bar").value = 0;
      $("loadText").textContent = `Reading ${file.name} (${formatBytes(file.size)})…`;
    }
  }

  // Show "Working…" only if a query takes long enough to notice.
  function setBusy(on) {
    clearTimeout(busyTimer);
    if (on) busyTimer = setTimeout(() => $("busy").hidden = false, 150);
    else $("busy").hidden = true;
  }

  // ---------- Rendering ----------
  function buildHeader() {
    thead.textContent = "";
    const names = document.createElement("tr"); names.className = "names";
    const filters = document.createElement("tr"); filters.className = "filters";
    const corner = document.createElement("th"); corner.className = "rownum"; corner.textContent = "#";
    corner.scope = "col";
    const corner2 = document.createElement("th"); corner2.className = "rownum";
    names.appendChild(corner);
    filters.appendChild(corner2);

    nameCells = []; filterInputs = [];
    ui.headers.forEach((h, c) => {
      const label = h || `Column ${c + 1}`;
      const th = document.createElement("th");
      th.scope = "col";
      th.tabIndex = 0;
      th.title = "Sort by this column";
      th.addEventListener("click", e => toggleSort(c, e.shiftKey || $("multi").checked));
      th.addEventListener("keydown", e => {
        if (e.key === "Enter" || e.key === " ") { e.preventDefault(); toggleSort(c, e.shiftKey || $("multi").checked); }
      });
      names.appendChild(th);
      nameCells.push(th);

      const fth = document.createElement("th");
      const inp = document.createElement("input");
      inp.type = "text";
      inp.placeholder = ui.types[c] === "text" ? "filter…" : "e.g. >10";
      inp.setAttribute("aria-label", `Filter ${label}`);
      inp.addEventListener("input", debounce(() => { ui.filters[c] = inp.value; ui.page = 0; requestQuery(); }, 250));
      fth.appendChild(inp);
      filters.appendChild(fth);
      filterInputs.push(inp);
    });
    thead.append(names, filters);
    requestAnimationFrame(() => {
      document.documentElement.style.setProperty("--names-h", names.getBoundingClientRect().height + "px");
    });
  }

  function renderHeaderLabels() {
    ui.headers.forEach((h, c) => {
      const th = nameCells[c];
      th.textContent = h || `Column ${c + 1}`;
      if (ui.types[c] !== "text") {
        const t = document.createElement("span"); t.className = "type";
        t.textContent = ui.types[c] === "number" ? "#" : "date";
        th.appendChild(t);
      }
      const si = ui.sort.findIndex(s => s.col === c);
      th.setAttribute("aria-sort", si < 0 ? "none" : ui.sort[si].dir === 1 ? "ascending" : "descending");
      if (si >= 0) {
        const a = document.createElement("span"); a.className = "arrow";
        a.textContent = (ui.sort[si].dir === 1 ? "▲" : "▼") + (ui.sort.length > 1 ? si + 1 : "");
        th.appendChild(a);
      }
    });
  }

  function render(m) {
    renderHeaderLabels();
    filterInputs.forEach((inp, c) => {
      inp.classList.toggle("active", !!ui.filters[c].trim());
      const bad = m.bad.includes(c);
      inp.classList.toggle("bad", bad);
      inp.title = bad ? "This filter can't be understood. See the filter help below the table." : "";
    });

    const frag = document.createDocumentFragment();
    if (!m.rows.length) {
      const tr = document.createElement("tr");
      const td = document.createElement("td");
      td.colSpan = ui.headers.length + 1; td.className = "empty";
      td.textContent = m.rowCount ? "No rows match the current filters." : "This file has a header row but no data rows.";
      tr.appendChild(td);
      frag.appendChild(tr);
    }
    for (const r of m.rows) {
      const tr = document.createElement("tr");
      const n = document.createElement("td"); n.className = "rownum"; n.textContent = r.n;
      tr.appendChild(n);
      r.cells.forEach((v, c) => {
        const td = document.createElement("td");
        td.textContent = v;
        if (v.length > 60) td.title = v;   // long values are cut off with "…"; show them in full on hover
        if (ui.types[c] === "number") td.className = "num";
        tr.appendChild(td);
      });
      frag.appendChild(tr);
    }
    tbody.textContent = "";
    tbody.appendChild(frag);

    $("pageInfo").textContent = `Page ${(m.page + 1).toLocaleString()} of ${m.pageCount.toLocaleString()}`;
    $("prev").disabled = m.page === 0;
    $("next").disabled = m.page >= m.pageCount - 1;
    $("export").disabled = m.total === 0;
    const shown = m.total ? `${(m.start + 1).toLocaleString()}–${(m.start + m.rows.length).toLocaleString()}` : "0";
    $("statusText").textContent =
      `${ui.fileName} · showing ${shown} of ${m.total.toLocaleString()} rows` +
      (m.total !== m.rowCount ? ` (filtered from ${m.rowCount.toLocaleString()})` : "") +
      ` · ${ui.headers.length} columns`;
  }

  function toggleSort(col, additive) {
    const i = ui.sort.findIndex(s => s.col === col);
    if (!additive) {
      const cur = i >= 0 ? ui.sort[i].dir : 0;
      ui.sort = cur === 0 ? [{ col, dir: 1 }] : cur === 1 ? [{ col, dir: -1 }] : [];
    } else if (i < 0) {
      ui.sort.push({ col, dir: 1 });
    } else if (ui.sort[i].dir === 1) {
      ui.sort[i].dir = -1;
    } else {
      ui.sort.splice(i, 1);
    }
    ui.page = 0;
    requestQuery();
  }

  // ---------- Sample data ----------
  // Built-in data so visitors can try the tool without a file. "?sample=N" generates N rows,
  // which is handy for testing large files.
  function sampleFile(n) {
    let seed = 42;
    const rand = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
    const pick = a => a[Math.floor(rand() * a.length)];
    const regions = ["North", "South", "East", "West", "Central"];
    const products = [
      ["Laptop", "Electronics", 899], ["Monitor 27\"", "Electronics", 249], ["Cable, USB-C", "Accessories", 12.5],
      ["Desk Chair", "Furniture", 179], ["Standing Desk", "Furniture", 420], ["Keyboard", "Accessories", 49.99],
      ["Headphones", "Electronics", 129], ["Notebook (pack of 5)", "Stationery", 8.75]
    ];
    const esc = v => /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
    const lines = ["Order ID,Order Date,Region,Product,Category,Units,Unit Price,Revenue,Returned"];
    const day0 = Date.UTC(2025, 0, 1);
    for (let i = 1; i <= n; i++) {
      const [product, category, price] = pick(products);
      const units = 1 + Math.floor(rand() * 20);
      const date = new Date(day0 + Math.floor(rand() * 365) * 86400000).toISOString().slice(0, 10);
      const returned = rand() < 0.06 ? "Yes" : rand() < 0.1 ? "" : "No";
      lines.push([
        "ORD-" + String(100000 + i), date, pick(regions), esc(product), category,
        units, price.toFixed(2), (units * price).toFixed(2), returned
      ].join(","));
    }
    return new File([lines.join("\n") + "\n"], "sample-orders.csv", { type: "text/csv" });
  }

  // ---------- Helpers & wiring ----------
  function debounce(fn, ms) { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; }
  function formatBytes(n) {
    return n < 1024 ? n + " B" : n < 1048576 ? (n / 1024).toFixed(1) + " KB"
      : n < 1073741824 ? (n / 1048576).toFixed(1) + " MB" : (n / 1073741824).toFixed(2) + " GB";
  }
  function showError(msg) { $("error").textContent = msg; $("error").hidden = !msg; }
  function showNote(msg) { $("note").textContent = msg; $("note").hidden = !msg; }

  $("file").addEventListener("change", e => { if (e.target.files[0]) load(e.target.files[0]); e.target.value = ""; });
  $("sample").addEventListener("click", () => load(sampleFile(500)));
  $("cancel").addEventListener("click", () => { stopWorker(); setLoading(false); showError("Loading cancelled."); });

  const drop = $("drop");
  ["dragenter", "dragover"].forEach(ev => drop.addEventListener(ev, e => { e.preventDefault(); drop.classList.add("over"); }));
  ["dragleave", "drop"].forEach(ev => drop.addEventListener(ev, e => { e.preventDefault(); drop.classList.remove("over"); }));
  drop.addEventListener("drop", e => { const f = e.dataTransfer.files[0]; if (f) load(f); });
  // Stop a file dropped outside the drop zone from replacing the page.
  window.addEventListener("dragover", e => e.preventDefault());
  window.addEventListener("drop", e => e.preventDefault());

  $("global").addEventListener("input", debounce(e => { ui.global = e.target.value; ui.page = 0; requestQuery(); }, 250));
  $("pageSize").addEventListener("change", e => { ui.pageSize = +e.target.value; ui.page = 0; requestQuery(); });
  $("prev").addEventListener("click", () => { ui.page--; requestQuery(); });
  $("next").addEventListener("click", () => { ui.page++; requestQuery(); });
  $("export").addEventListener("click", () => { $("export").disabled = true; worker.postMessage({ type: "export" }); });
  $("clear").addEventListener("click", () => {
    ui.filters = ui.headers.map(() => "");
    filterInputs.forEach(i => { i.value = ""; });
    ui.sort = []; ui.global = ""; $("global").value = ""; ui.page = 0;
    requestQuery();
  });

  const sample = new URLSearchParams(location.search).get("sample");
  if (sample !== null) load(sampleFile(Math.min(Math.max(parseInt(sample, 10) || 500, 1), 5000000)));
})();
