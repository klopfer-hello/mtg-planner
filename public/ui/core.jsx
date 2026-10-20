"use strict";
const { useState, useEffect, useLayoutEffect, useRef, useMemo, useCallback, useReducer } = React;

// ===========================================================================
// Utilities
// ===========================================================================

/** localStorage that never throws (private mode, blocked storage, ...). */
const store = {
  get(key, fallback) {
    try {
      const v = localStorage.getItem(key);
      return v == null ? fallback : JSON.parse(v);
    } catch { return fallback; }
  },
  set(key, value) {
    try {
      if (value == null) localStorage.removeItem(key);
      else localStorage.setItem(key, JSON.stringify(value));
    } catch { /* ignore */ }
  },
};

class ApiError extends Error {
  constructor(status, message, data = null) {
    super(message);
    this.status = status;
    this.data = data; // the JSON error body ({error, code, ...}) when there is one
  }
}

/**
 * fetch() wrapper: JSON in/out, every failure becomes an ApiError with a
 * human-readable message ({error} from the server when present).
 */
async function api(path, { method = "GET", json, body, headers = {}, signal } = {}) {
  const opts = { method, headers: { ...headers }, signal };
  if (json !== undefined) {
    opts.body = JSON.stringify(json);
    opts.headers["Content-Type"] = "application/json";
  } else if (body !== undefined) {
    opts.body = body;
  }
  let res;
  try {
    res = await fetch(path, opts);
  } catch (err) {
    if (err.name === "AbortError") throw err;
    throw new ApiError(0, `Network error: ${err.message}. Is the server reachable?`);
  }
  if (res.status === 204) return null;
  const type = res.headers.get("content-type") || "";
  let data = null;
  if (type.includes("application/json")) {
    try { data = await res.json(); } catch { data = null; }
  } else {
    data = await res.text().catch(() => "");
  }
  if (!res.ok) {
    let message = data && typeof data === "object" && data.error;
    if (!message && typeof data === "string" && data.trim() && !data.trim().startsWith("<")) message = data.trim().slice(0, 300);
    throw new ApiError(res.status, message || `Request failed: HTTP ${res.status} ${res.statusText}`.trim(), data && typeof data === "object" ? data : null);
  }
  return data;
}

/** Parse a Server-Sent Events body into JSON events ("data: <json>" lines). */
async function* readSse(body) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, "\n");
      let idx;
      while ((idx = buffer.indexOf("\n\n")) >= 0) {
        const block = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        const data = block.split("\n")
          .filter((l) => l.startsWith("data:"))
          .map((l) => l.slice(5).replace(/^ /, ""))
          .join("\n");
        if (!data) continue; // ": ping" keep-alive comments
        let ev;
        try { ev = JSON.parse(data); } catch { continue; }
        yield ev;
      }
    }
  } finally {
    reader.cancel().catch(() => {});
  }
}

function useDebounced(value, ms) {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

/**
 * GET `path` and keep the answer: {data, error, loading, reload, setData}. A null path loads nothing.
 * It loads again when the path or one of `deps` changes, or on reload(); an answer that arrives after
 * that (or after unmount) is dropped. The last data stays while the next load runs. Options: `map(d)`
 * shapes the answer, `error(e)` turns a failure into the shown message (default e.message).
 */
function useApi(path, deps = [], { map = null, error: errorText = null } = {}) {
  const [state, setState] = useState({ data: null, error: null, loading: path != null });
  const [tick, reload] = useReducer((x) => x + 1, 0);
  const opts = useRef(null);
  opts.current = { map, errorText };
  useEffect(() => {
    if (path == null) return undefined;
    let live = true;
    setState((s) => ({ ...s, error: null, loading: true }));
    api(path).then(
      (d) => { if (live) setState({ data: opts.current.map ? opts.current.map(d) : d, error: null, loading: false }); },
      (e) => { if (live) setState((s) => ({ ...s, error: opts.current.errorText ? opts.current.errorText(e) : e.message, loading: false })); },
    );
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, tick, ...deps]);
  const setData = useCallback((v) => setState((s) => ({ ...s, data: typeof v === "function" ? v(s.data) : v })), []);
  return { ...state, reload, setData };
}

/** SQLite datetime('now') is "YYYY-MM-DD HH:MM:SS" in UTC without a zone. */
function parseTs(s) {
  if (!s) return null;
  if (typeof s === "number") { const d = new Date(s); return Number.isNaN(d.getTime()) ? null : d; }
  if (s instanceof Date) return s;
  s = String(s);
  const iso = /[zZ]|[+-]\d\d:?\d\d$/.test(s) ? s : s.replace(" ", "T") + "Z";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d;
}
function fmtDate(s) {
  const d = parseTs(s);
  return d ? d.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" }) : "—";
}
const RTF = typeof Intl !== "undefined" && Intl.RelativeTimeFormat ? new Intl.RelativeTimeFormat(undefined, { numeric: "auto" }) : null;
function fmtAgo(s) {
  const d = parseTs(s);
  if (!d) return "—";
  const sec = (d.getTime() - Date.now()) / 1000;
  if (!RTF) return fmtDate(s);
  const abs = Math.abs(sec);
  if (abs < 60) return RTF.format(Math.round(sec), "second");
  if (abs < 3600) return RTF.format(Math.round(sec / 60), "minute");
  if (abs < 86400) return RTF.format(Math.round(sec / 3600), "hour");
  if (abs < 86400 * 30) return RTF.format(Math.round(sec / 86400), "day");
  return d.toLocaleDateString(undefined, { dateStyle: "medium" });
}
const fmtInt = (n) => (n == null ? "—" : Number(n).toLocaleString());
const fmtEur = (n) => (n == null ? "—" : `€${Number(n).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`);
const fmtPrice = (p) => (p && p.value != null ? `${p.currency}${Number(p.value).toFixed(2)}` : "—");
const plural = (n, one, many = one + "s") => `${fmtInt(n)} ${n === 1 ? one : many}`;
const cap = (s) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : "");
const conditionLabel = (s) => (s || "").split("_").map(cap).join(" ");

// ---------------------------------------------------------------------------
// Card symbols: {W/U} -> WU.svg, {2} -> 2.svg, {T} -> T.svg

function symbolUrl(sym) {
  let code = sym.toUpperCase().replace(/\//g, "");
  if (code === "½") code = "HALF";
  if (code === "∞") code = "INFINITY";
  return `https://svgs.scryfall.io/card-symbols/${encodeURIComponent(code)}.svg`;
}

/** Text with {X} symbols replaced by inline Scryfall SVGs. */
function SymbolText({ text }) {
  if (!text) return null;
  const parts = String(text).split(/(\{[^{}\s]{1,8}\})/g);
  return (
    <>
      {parts.map((p, i) => (/^\{[^{}\s]{1,8}\}$/.test(p)
        ? <img key={i} className="sym" src={symbolUrl(p.slice(1, -1))} alt={p} title={p} loading="lazy" decoding="async" />
        : p ? <React.Fragment key={i}>{p}</React.Fragment> : null))}
    </>
  );
}

function ManaCost({ cost }) {
  if (!cost) return null;
  return <span className="mana" aria-label={`Mana cost ${cost}`}><SymbolText text={cost} /></span>;
}

/** Oracle text: paragraphs, "//" face separators, italic reminder text. */
function OracleText({ text }) {
  if (!text) return <p className="muted">No rules text.</p>;
  return (
    <>
      {String(text).split("\n").map((line, i) => {
        if (line.trim() === "//") return <hr key={i} />;
        const parts = line.split(/(\([^)]*\))/g);
        return (
          <p key={i}>
            {parts.map((p, j) => (/^\(.*\)$/.test(p)
              ? <i key={j} className="muted"><SymbolText text={p} /></i>
              : <SymbolText key={j} text={p} />))}
          </p>
        );
      })}
    </>
  );
}

// ---------------------------------------------------------------------------
// Markdown (Claude answers): marked -> mana symbols -> DOMPurify

if (window.DOMPurify) {
  DOMPurify.addHook("afterSanitizeAttributes", (node) => {
    if (node.tagName === "A" && node.getAttribute("href")) {
      node.setAttribute("target", "_blank");
      node.setAttribute("rel", "noopener noreferrer");
    }
  });
}
const MD_SYMBOL_RE = /\{((?:[WUBRGCSXYZTQEP0-9]|HALF|½|∞)(?:\/[WUBRGCP0-9])?)\}/g;

function renderMarkdown(text) {
  const src = text || "";
  try {
    let html = window.marked ? marked.parse(src, { gfm: true, breaks: true }) : escapeHtml(src).replace(/\n/g, "<br>");
    html = html.replace(MD_SYMBOL_RE, (m, sym) => `<img class="sym" src="${symbolUrl(sym)}" alt="${m}" title="${m}">`);
    return window.DOMPurify ? layoutTables(DOMPurify.sanitize(html)) : escapeHtml(src);
  } catch {
    return escapeHtml(src).replace(/\n/g, "<br>");
  }
}
/**
 * Phone-friendly tables: each table gets its own horizontal scroller, short
 * cells stay on one line and longer ones get a readable minimum width, so a
 * wide table scrolls inside the bubble instead of being squeezed into columns
 * a few letters wide.
 */
function layoutTables(html) {
  if (!html.includes("<table")) return html;
  const t = document.createElement("template");
  t.innerHTML = html;
  for (const table of t.content.querySelectorAll("table")) {
    for (const cell of table.querySelectorAll("th, td")) cell.className = (cell.textContent || "").trim().length <= 14 ? "nw" : "wide";
    const wrap = document.createElement("div");
    wrap.className = "md-table";
    table.replaceWith(wrap);
    wrap.appendChild(table);
  }
  return t.innerHTML;
}
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
function Markdown({ text }) {
  const html = useMemo(() => renderMarkdown(text), [text]);
  return <div className="md" dangerouslySetInnerHTML={{ __html: html }} />;
}

/** A deck's notes (Markdown); long notes collapse to a few lines with Show more. */
function DeckNotes({ text }) {
  const ref = useRef(null);
  const [open, setOpen] = useState(false);
  const [long, setLong] = useState(false);
  useLayoutEffect(() => {
    const el = ref.current;
    if (el) setLong(el.scrollHeight > el.clientHeight + 4);
  }, [text]);
  return (
    <div className="deck-notes">
      <div ref={ref} className={`deck-notes-body${open ? " open" : ""}${long && !open ? " clipped" : ""}`}>
        <Markdown text={text} />
      </div>
      {(long || open) && (
        <button type="button" className="btn ghost sm" aria-expanded={open} onClick={() => setOpen(!open)}>
          {open ? "Show less" : "Show more"}
        </button>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Card type classification for deck grouping

const TYPE_ORDER = ["Creature", "Planeswalker", "Battle", "Instant", "Sorcery", "Artifact", "Enchantment", "Land", "Other"];
const DISPLAY_TYPES = ["Creature", "Instant", "Sorcery", "Artifact", "Enchantment", "Planeswalker", "Battle", "Land", "Other"];
function mainType(typeLine) {
  if (!typeLine) return "Other";
  const front = typeLine.split(" // ")[0].split(/\s+[—-]\s+/)[0];
  for (const t of TYPE_ORDER) if (t !== "Other" && new RegExp(`\\b${t}\\b`).test(front)) return t;
  return "Other";
}

// ===========================================================================
// Icons (inline SVG, currentColor)
// ===========================================================================

const Svg = ({ children, ...p }) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false" {...p}>{children}</svg>
);
const Icon = {
  collection: () => <Svg><rect x="3" y="3" width="7.5" height="9" rx="1.5" /><rect x="13.5" y="3" width="7.5" height="9" rx="1.5" /><rect x="3" y="15" width="7.5" height="6" rx="1.5" /><rect x="13.5" y="15" width="7.5" height="6" rx="1.5" /></Svg>,
  decks: () => <Svg><rect x="7" y="3" width="12" height="16" rx="2" /><path d="M4 7v12a2 2 0 0 0 2 2h9" /></Svg>,
  planner: () => <Svg><path d="M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.6A8 8 0 1 1 21 12z" /><path d="M12 8.5l1 2.5 2.5 1-2.5 1-1 2.5-1-2.5-2.5-1 2.5-1z" /></Svg>,
  import: () => <Svg><path d="M12 3v12" /><path d="M7 10l5 5 5-5" /><path d="M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2" /></Svg>,
  search: () => <Svg><circle cx="11" cy="11" r="7" /><path d="M20 20l-3.5-3.5" /></Svg>,
  close: () => <Svg><path d="M6 6l12 12M18 6L6 18" /></Svg>,
  back: () => <Svg><path d="M15 18l-6-6 6-6" /></Svg>,
  grid: () => <Svg><rect x="4" y="4" width="6" height="6" rx="1" /><rect x="14" y="4" width="6" height="6" rx="1" /><rect x="4" y="14" width="6" height="6" rx="1" /><rect x="14" y="14" width="6" height="6" rx="1" /></Svg>,
  list: () => <Svg><path d="M9 6h11M9 12h11M9 18h11M4 6h.01M4 12h.01M4 18h.01" /></Svg>,
  up: () => <Svg><path d="M12 19V5M6 11l6-6 6 6" /></Svg>,
  down: () => <Svg><path d="M12 5v14M6 13l6 6 6-6" /></Svg>,
  send: () => <Svg><path d="M5 12h14M13 6l6 6-6 6" /></Svg>,
  plus: () => <Svg><path d="M12 5v14M5 12h14" /></Svg>,
  menu: () => <Svg><path d="M4 6h16M4 12h16M4 18h16" /></Svg>,
  trash: () => <Svg><path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3" /></Svg>,
  download: () => <Svg><path d="M12 4v11M7 10l5 5 5-5M5 20h14" /></Svg>,
  edit: () => <Svg><path d="M4 20h4L19 9l-4-4L4 16v4z" /></Svg>,
  external: () => <Svg><path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5" /></Svg>,
  refresh: () => <Svg><path d="M20 11a8 8 0 0 0-14.8-4M4 4v4h4M4 13a8 8 0 0 0 14.8 4M20 20v-4h-4" /></Svg>,
  file: () => <Svg><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" /><path d="M14 3v5h5M9 13h6M9 17h6" /></Svg>,
  sparkle: () => <Svg><path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z" /><path d="M19 16l.7 1.8 1.8.7-1.8.7L19 21l-.7-1.8-1.8-.7 1.8-.7z" /></Svg>,
  scan: () => <Svg><path d="M4 8V6a2 2 0 0 1 2-2h2M16 4h2a2 2 0 0 1 2 2v2M20 16v2a2 2 0 0 1-2 2h-2M8 20H6a2 2 0 0 1-2-2v-2" /><rect x="8.5" y="7" width="7" height="10" rx="1" /></Svg>,
  camera: () => <Svg><path d="M4 8h3l2-3h6l2 3h3a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V9a1 1 0 0 1 1-1z" /><circle cx="12" cy="13" r="3.5" /></Svg>,
  bolt: () => <Svg><path d="M13 2L5 14h6l-1 8 8-12h-6z" /></Svg>,
  undo: () => <Svg><path d="M9 14L4 9l5-5" /><path d="M4 9h11a5 5 0 0 1 0 10h-3" /></Svg>,
  check: () => <Svg><path d="M5 12.5l4.5 4.5L19 7" /></Svg>,
  history: () => <Svg><path d="M4 12a8 8 0 1 0 2.3-5.6M4 4v4h4" /><path d="M12 8v4l3 2" /></Svg>,
  checklist: () => <Svg><path d="M4 6l1.5 1.5L8 5M4 12l1.5 1.5L8 11M4 18l1.5 1.5L8 17M11 6h9M11 12h9M11 18h9" /></Svg>,
  minus: () => <Svg><path d="M5 12h14" /></Svg>,
  share: () => <Svg><path d="M12 3v12M8 7l4-4 4 4" /><path d="M5 12v7a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-7" /></Svg>,
  more: () => <Svg><circle cx="5" cy="12" r="1.3" /><circle cx="12" cy="12" r="1.3" /><circle cx="19" cy="12" r="1.3" /></Svg>,
  crown: () => <Svg><path d="M4 18h16M5 15l-1-9 5 4 3-6 3 6 5-4-1 9z" /></Svg>,
  zoomIn: () => <Svg><circle cx="11" cy="11" r="7" /><path d="M20 20l-3.5-3.5M8 11h6M11 8v6" /></Svg>,
  zoomOut: () => <Svg><circle cx="11" cy="11" r="7" /><path d="M20 20l-3.5-3.5M8 11h6" /></Svg>,
  cart: () => <Svg><path d="M3 4h2l2.4 11h10.2L20 8H6.2" /><circle cx="9" cy="19.5" r="1.3" /><circle cx="17" cy="19.5" r="1.3" /></Svg>,
  box: () => <Svg><path d="M3 8l9-4 9 4v9l-9 4-9-4z" /><path d="M3 8l9 4 9-4M12 12v9" /></Svg>,
  lock: () => <Svg><rect x="5" y="11" width="14" height="10" rx="2" /><path d="M8 11V7a4 4 0 0 1 8 0v4" /></Svg>,
  unlock: () => <Svg><rect x="5" y="11" width="14" height="10" rx="2" /><path d="M8 11V7a4 4 0 0 1 7.6-1.8" /></Svg>,
  filter: () => <Svg><path d="M4 5h16l-6 7v6l-4 2v-8z" /></Svg>,
  chart: () => <Svg><path d="M4 4v16h16" /><path d="M7 15l4-4 3 3 5-6" /></Svg>,
  heart: () => <Svg><path d="M12 20s-7-4.35-7-10a4 4 0 0 1 7-2.65A4 4 0 0 1 19 10c0 5.65-7 10-7 10z" /></Svg>,
  heartFull: () => <Svg><path d="M12 20s-7-4.35-7-10a4 4 0 0 1 7-2.65A4 4 0 0 1 19 10c0 5.65-7 10-7 10z" fill="currentColor" /></Svg>,
  image: () => <Svg><rect x="3" y="5" width="18" height="14" rx="2" /><circle cx="9" cy="10" r="2" /><path d="M21 16l-5-5-8 8" /></Svg>,
  gear: () => <Svg><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z" /></Svg>,
};
