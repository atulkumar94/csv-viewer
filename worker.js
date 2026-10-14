/*
 * CSV Reader worker: parsing, filtering, sorting and export all run here, off the page's main
 * thread, so large files don't freeze the tab. The page only ever receives one page of rows.
 *
 * app.js starts this function from a Blob URL, which also works when index.html is opened straight
 * from disk.
 */
function csvReaderWorker(self) {
  "use strict";

  const DETECT_BYTES = 64 * 1024;   // text sampled to detect the delimiter
  const PROGRESS_MS = 100;          // minimum gap between progress messages

  let headers = [], rows = [], types = [], width = 0;
  let numKeys = [];                 // per column: Float64Array sort keys (NaN = blank) for number/date columns
  let lowerCache = [];              // per column: lower-cased cell text, built on first use
  let view = new Uint32Array(0), lastKey = null, lastBad = [];

  // ---------- Value typing ----------
  const NUM_RE = /^[+-]?(\d{1,3}(,\d{3})+|\d+)?(\.\d+)?([eE][+-]?\d+)?%?$/;
  const DATE_RE = /^\d{4}-\d{2}-\d{2}([ T]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?)?$|^\d{1,2}[\/.-]\d{1,2}[\/.-]\d{4}$|^\d{4}\/\d{1,2}\/\d{1,2}$/;

  function toNumber(s) {
    s = s.trim();
    if (!s || !NUM_RE.test(s) || !/\d/.test(s)) return NaN;
    return Number(s.replace(/,/g, "").replace(/%$/, ""));
  }

  function toDate(s) {
    s = s.trim();
    if (!DATE_RE.test(s)) return NaN;
    let m = s.match(/^(\d{1,2})[\/.-](\d{1,2})[\/.-](\d{4})$/);
    if (m) {
      // Day-first when the first part can't be a month, otherwise month-first.
      const a = +m[1], b = +m[2], y = +m[3];
      const [mo, d] = a > 12 ? [b, a] : [a, b];
      return Date.UTC(y, mo - 1, d);
    }
    m = s.match(/^(\d{4})[\/-](\d{1,2})[\/-](\d{1,2})$/);
    if (m) return Date.UTC(+m[1], +m[2] - 1, +m[3]);
    return Date.parse(s.replace(" ", "T"));
  }

  // ---------- CSV parsing (RFC 4180, streamed in chunks) ----------
  function detectDelimiter(text) {
    const lines = text.split(/\r?\n/).slice(0, 20).filter(l => l.length);
    let best = ",", bestScore = -1;
    for (const d of [",", ";", "\t", "|"]) {
      const counts = lines.map(l => countOutsideQuotes(l, d));
      if (!counts.length || counts[0] === 0) continue;
      const score = counts.filter(c => c === counts[0]).length * 1000 + counts[0];
      if (score > bestScore) { bestScore = score; best = d; }
    }
    return best;
  }

  function countOutsideQuotes(line, d) {
    let n = 0, q = false;
    for (const ch of line) { if (ch === '"') q = !q; else if (ch === d && !q) n++; }
    return n;
  }

  const START = 0, UNQUOTED = 1, QUOTED = 2, QUOTE = 3, AFTER_QUOTE = 4;

  // Incremental parser: feed() any number of text chunks, then end(). A chunk may split a field,
  // an escaped quote or a CRLF pair anywhere.
  class CsvParser {
    constructor(delimiter, onRow) {
      this.delim = delimiter.charCodeAt(0);
      this.onRow = onRow;
      this.row = [];
      this.buf = "";
      this.state = START;
      this.skipLF = false;
    }

    feed(chunk) {
      const n = chunk.length, delim = this.delim;
      let { state, buf, row } = this;
      let i = 0, start = 0;
      if (this.skipLF && n) {
        if (chunk.charCodeAt(0) === 10) i = start = 1;
        this.skipLF = false;
      }
      for (; i < n; i++) {
        const c = chunk.charCodeAt(i);
        if (state === QUOTED) {
          if (c === 34) { buf += chunk.slice(start, i); state = QUOTE; start = i + 1; }
          continue;
        }
        if (state === QUOTE) {
          if (c === 34) { buf += '"'; state = QUOTED; start = i + 1; continue; }  // "" inside quotes
          state = AFTER_QUOTE;
          start = i;
        }
        if (c === delim) {
          row.push(buf + chunk.slice(start, i));
          buf = ""; state = START; start = i + 1;
        } else if (c === 10 || c === 13) {
          row.push(buf + chunk.slice(start, i));
          this.onRow(row);
          row = []; buf = ""; state = START;
          if (c === 13) {
            if (i + 1 < n) { if (chunk.charCodeAt(i + 1) === 10) i++; }
            else this.skipLF = true;
          }
          start = i + 1;
        } else if (state === START) {
          if (c === 34) { state = QUOTED; start = i + 1; } else state = UNQUOTED;
        }
      }
      buf += chunk.slice(start);
      Object.assign(this, { state, buf, row });
    }

    end() {
      if (this.state === QUOTED) throw new Error("The file ends inside a quoted value, so it may be cut off or malformed.");
      if (this.buf !== "" || this.row.length || this.state !== START) {
        this.row.push(this.buf);
        this.onRow(this.row);
      }
      this.row = []; this.buf = ""; this.state = START;
    }
  }

  // ---------- Loading ----------
  async function load(file) {
    headers = []; rows = []; types = []; width = 0;
    numKeys = []; lowerCache = []; view = new Uint32Array(0); lastKey = null; lastBad = [];

    const stats = [];   // per column: {n: non-blank cells, num: numeric cells, date: date cells}
    let headerLen = 0, ragged = 0, sawHeader = false;

    const onRow = r => {
      if (r.length === 1 && r[0].trim() === "") return;   // blank line
      if (!sawHeader) {
        headers = r.map(h => h.trim());
        headerLen = width = headers.length;
        sawHeader = true;
        return;
      }
      if (r.length !== headerLen) ragged++;
      if (r.length > width) width = r.length;
      for (let c = 0; c < r.length; c++) {
        const v = r[c];
        if (v === "" || v.trim() === "") continue;
        const s = stats[c] || (stats[c] = { n: 0, num: 0, date: 0 });
        s.n++;
        // Once a column has failed a test, stop testing it.
        if (s.num === s.n - 1 && !isNaN(toNumber(v))) s.num++;
        if (s.date === s.n - 1 && !isNaN(toDate(v))) s.date++;
      }
      rows.push(r);
    };

    const reader = file.stream().getReader();
    const decoder = new TextDecoder("utf-8");   // also strips a UTF-8 byte-order mark
    let parser = null, pending = "", delimiter = ",", loaded = 0, lastPost = 0;

    for (;;) {
      const { done, value } = await reader.read();
      let text;
      if (value) { loaded += value.byteLength; text = decoder.decode(value, { stream: true }); }
      else text = done ? decoder.decode() : "";

      if (!parser) {
        pending += text;
        if (pending.length < DETECT_BYTES && !done) continue;
        delimiter = detectDelimiter(pending);
        parser = new CsvParser(delimiter, onRow);
        text = pending;
        pending = "";
      }
      parser.feed(text);
      if (done) break;

      const now = Date.now();
      if (now - lastPost >= PROGRESS_MS) {
        lastPost = now;
        self.postMessage({ type: "progress", loaded, total: file.size, rows: rows.length });
      }
    }
    parser.end();

    if (!sawHeader) throw new Error("The file is empty.");
    while (headers.length < width) headers.push("");

    types = headers.map((_, c) => {
      const s = stats[c];
      if (!s || !s.n) return "text";
      if (s.num === s.n) return "number";
      if (s.date === s.n) return "date";
      return "text";
    });
    numKeys = types.map((t, c) => {
      if (t === "text") return null;
      const parse = t === "number" ? toNumber : toDate;
      const keys = new Float64Array(rows.length);
      for (let i = 0; i < rows.length; i++) {
        const v = rows[i][c];
        keys[i] = v == null || v.trim() === "" ? NaN : parse(v);
      }
      return keys;
    });

    self.postMessage({ type: "loaded", headers, types, rowCount: rows.length, ragged, delimiter });
  }

  function lowerCol(c) {
    let col = lowerCache[c];
    if (!col) {
      col = lowerCache[c] = new Array(rows.length);
      for (let i = 0; i < rows.length; i++) col[i] = (rows[i][c] ?? "").toLowerCase();
    }
    return col;
  }

  // ---------- Filters ----------
  // Compile one column's filter into a row-index predicate. Throws if the filter can't be understood.
  function compileFilter(expr, c) {
    expr = String(expr || "").trim();
    if (!expr) return null;
    const groups = expr.split("|").map(s => s.trim()).filter(Boolean)
      .map(p => p.split("&").map(s => s.trim()).filter(Boolean).map(t => compileTerm(t, c)))
      .filter(g => g.length);
    if (!groups.length) return null;
    if (groups.length === 1 && groups[0].length === 1) return groups[0][0];
    return i => groups.some(g => g.every(fn => fn(i)));
  }

  function compileTerm(t, c) {
    const keys = numKeys[c];
    const lower = t.toLowerCase();

    if (lower === "(empty)" || lower === "!(empty)") {
      const want = lower === "(empty)";
      if (keys) return i => (keys[i] !== keys[i]) === want;
      const L = lowerCol(c);
      return i => (L[i].trim() === "") === want;
    }

    if (keys) {
      const parse = types[c] === "number" ? toNumber : toDate;
      const range = t.match(/^(.+?)\s*\.\.\s*(.+)$/);
      if (range) {
        const lo = parse(range[1]), hi = parse(range[2]);
        if (isNaN(lo) || isNaN(hi)) throw new Error("bad range");
        return i => keys[i] >= lo && keys[i] <= hi;
      }
      const m = t.match(/^(>=|<=|!=|>|<|=)?\s*(.+)$/);
      const op = m[1] || "", val = parse(m[2]);
      if (!isNaN(val)) {
        switch (op) {   // blanks are NaN, so every comparison but != is false for them
          case ">":  return i => keys[i] > val;
          case ">=": return i => keys[i] >= val;
          case "<":  return i => keys[i] < val;
          case "<=": return i => keys[i] <= val;
          case "!=": return i => keys[i] !== val;
          case "=":  return i => keys[i] === val;
          default:   break;   // no operator: plain "contains", so "12" also matches "120"
        }
      } else if (op && op !== "=" && op !== "!=") {
        throw new Error("bad value");
      }
    }

    const L = lowerCol(c);
    if (lower.startsWith("!=")) { const s = lower.slice(2); return i => L[i] !== s; }
    if (lower.startsWith("="))  { const s = lower.slice(1); return i => L[i] === s; }
    if (lower.startsWith("!"))  { const s = lower.slice(1); return i => !L[i].includes(s); }
    if (lower.startsWith("^"))  { const s = lower.slice(1); return i => L[i].startsWith(s); }
    if (lower.length > 1 && lower.endsWith("$")) { const s = lower.slice(0, -1); return i => L[i].endsWith(s); }
    return i => L[i].includes(lower);
  }

  // ---------- Query: filter -> sort -> one page ----------
  function isBlankText(s) { return s === "" || (s.charCodeAt(0) <= 32 && s.trim() === ""); }

  function sortView(idx, sort) {
    const cmps = sort.map(({ col, dir }) => {
      const keys = numKeys[col];
      if (keys) {
        return (a, b) => {
          const x = keys[a], y = keys[b], xb = x !== x, yb = y !== y;
          if (xb || yb) return xb === yb ? 0 : xb ? 1 : -1;   // blanks last in both directions
          return x < y ? -dir : x > y ? dir : 0;
        };
      }
      const L = lowerCol(col);
      return (a, b) => {
        const x = L[a], y = L[b], xb = isBlankText(x), yb = isBlankText(y);
        if (xb || yb) return xb === yb ? 0 : xb ? 1 : -1;
        return x < y ? -dir : x > y ? dir : 0;
      };
    });
    idx.sort((a, b) => {
      for (const cmp of cmps) { const r = cmp(a, b); if (r) return r; }
      return a - b;   // keep file order for ties
    });
  }

  function query(msg) {
    const filters = msg.filters || [], sort = (msg.sort || []).filter(s => s.col < width);
    const global = String(msg.global || "").trim().toLowerCase();
    const key = JSON.stringify([filters, global, sort]);

    if (key !== lastKey) {
      const preds = [], bad = [];
      filters.forEach((f, c) => {
        if (c >= width) return;
        try { const p = compileFilter(f, c); if (p) preds.push(p); } catch { bad.push(c); }
      });
      const cols = global ? headers.map((_, c) => lowerCol(c)) : null;
      const out = new Uint32Array(rows.length);
      let n = 0;
      rowLoop:
      for (let i = 0; i < rows.length; i++) {
        for (const p of preds) if (!p(i)) continue rowLoop;
        if (cols) {
          let hit = false;
          for (const L of cols) if (L[i].includes(global)) { hit = true; break; }
          if (!hit) continue;
        }
        out[n++] = i;
      }
      view = out.slice(0, n);
      if (sort.length) sortView(view, sort);
      lastKey = key;
      lastBad = bad;
    }

    const total = view.length;
    const size = msg.pageSize > 0 ? msg.pageSize : 100;
    const pageCount = Math.max(1, Math.ceil(total / size));
    const page = Math.min(Math.max(0, msg.page | 0), pageCount - 1);
    const start = page * size, end = Math.min(start + size, total);
    const pageRows = [];
    for (let j = start; j < end; j++) {
      const r = rows[view[j]], cells = new Array(width);
      for (let c = 0; c < width; c++) cells[c] = r[c] ?? "";
      pageRows.push({ n: view[j] + 1, cells });
    }
    self.postMessage({ type: "result", id: msg.id, total, rowCount: rows.length, page, pageCount, start, rows: pageRows, bad: lastBad });
  }

  // ---------- Export the current view ----------
  function exportCsv() {
    const esc = v => /[",\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
    const parts = [headers.map(esc).join(",") + "\r\n"];
    let lines = [];
    for (let j = 0; j < view.length; j++) {
      const r = rows[view[j]], cells = new Array(width);
      for (let c = 0; c < width; c++) cells[c] = esc(r[c] ?? "");
      lines.push(cells.join(","));
      if (lines.length === 10000) { parts.push(lines.join("\r\n") + "\r\n"); lines = []; }
    }
    if (lines.length) parts.push(lines.join("\r\n") + "\r\n");
    self.postMessage({ type: "export", blob: new Blob(parts, { type: "text/csv" }), rows: view.length });
  }

  self.onmessage = async e => {
    const m = e.data;
    try {
      if (m.type === "load") await load(m.file);
      else if (m.type === "query") query(m);
      else if (m.type === "export") exportCsv();
    } catch (err) {
      self.postMessage({ type: "error", during: m.type, message: (err && err.message) || String(err) });
    }
  };

}
