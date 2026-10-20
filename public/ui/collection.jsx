"use strict";

// ===========================================================================
// Collection tab
// ===========================================================================

const PAGE_SIZE = 60;
// Select mode "All": at most this many cards (the server takes ≤1000 items per move/delete).
const SELECT_ALL_MAX = 1000;
const QUICK_FILTERS = [
  ["Commanders", "is:commander"],
  ["Creatures", "t:creature"],
  ["Lands", "t:land"],
  ["Foils", "is:foil"],
  ["Valuable", "eur>5"],
  ["Mythics", "r:mythic"],
  ["Free copies", "avail>=1"],
];
const SORTS = [
  ["name", "Name", "asc"], ["price", "Price", "desc"], ["cmc", "Mana value", "asc"],
  ["qty", "Quantity", "desc"], ["set", "Set", "asc"], ["rarity", "Rarity", "desc"],
];
const tokenize = (q) => q.match(/-?[a-z]*(?:[:<>=!]+)?(?:"[^"]*"|\S+)/gi) || [];
/** q plus a filter chip's term; a search with a bare `or` is wrapped first, so the chip applies to all of it. */
const appendTerm = (q, term) => {
  const base = q.trim();
  if (!base) return term;
  return tokenize(base).some((t) => t.toLowerCase() === "or") ? `(${base}) ${term}` : `${base} ${term}`;
};

// binder: null = whole collection, "" = Unsorted, else that binder (GET /api/stats?binder=, exact, case-insensitive).
function StatsBar({ dataVersion, binder = null, scopeLine = true, compact = false }) {
  const qs = binder == null ? "" : `?${new URLSearchParams({ binder })}`;
  const { data, error, loading, reload: load } = useApi(`/api/stats${qs}`, [dataVersion], { error: (e) => `Could not load stats: ${e.message}` });
  const stats = loading ? null : data;
  if (error) return <ErrorNotice error={error} onRetry={load} />;
  const s = stats || {};
  const scope = binder == null ? null : binder || UNSORTED;
  return (
    <div className="stats-wrap">
      {scope != null && scopeLine && (
        <p className="stats-scope small muted" aria-live="polite">Showing <b>{scope}</b> only</p>
      )}
      <div className={`stats${compact ? " compact" : ""}`} aria-busy={!stats}>
        <div className="stat"><div className="v">{stats ? fmtInt(s.unique_cards) : "…"}</div><div className="k">{compact ? "Cards" : "Unique cards"}</div></div>
        <div className="stat"><div className="v">{stats ? fmtInt(s.total_cards) : "…"}</div><div className="k">{compact ? "Copies" : "Total copies"}</div></div>
        <div className="stat"><div className="v">{stats ? fmtEur(s.value_eur) : "…"}</div><div className="k">{compact ? "Value" : scope != null ? "Binder value" : "Est. value"}</div></div>
        {!compact && <div className="stat"><div className="v" style={{ fontSize: "1rem" }} title={stats?.last_import ? fmtDate(s.last_import) : undefined}>{stats ? (s.last_import ? fmtAgo(s.last_import) : "never") : "…"}</div><div className="k">Last import</div></div>}
      </div>
    </div>
  );
}

function QueryHelp() {
  const [opened, setOpened] = useState(false); // loads on the first open
  const { data: help, error, reload } = useApi(opened ? "/api/query-help" : null, [], { map: (d) => d.help });
  return (
    <details className="disclosure" onToggle={(e) => { if (e.currentTarget.open) setOpened(true); }}>
      <summary>Search syntax</summary>
      {error && <ErrorNotice error={error} onRetry={reload} />}
      {!help && !error && <p className="muted small">Loading…</p>}
      {help && (
        <>
          <ul className="help-list">
            {help.split(/;\s*/).map((h) => <li key={h}><code>{h}</code></li>)}
          </ul>
          <p className="muted small" style={{ marginBottom: 0 }}>
            Terms are combined with AND. Example: <code>t:creature c:g cmc&lt;=3 -r:common</code>
          </p>
        </>
      )}
    </details>
  );
}

function CardTile({ row, group, onOpen, selecting = false, selected = false, onToggle }) {
  // Badge text names the special finish(es) owned: "foil", "etched" or both.
  const foil = (row.finishes || "").split(",").filter((f) => f === "foil" || f === "etched").join(" · ");
  const langs = rowLangs(row);
  const label = `${selecting ? "Select " : ""}${row.name}, ${row.qty} owned${langs.length ? ` (${langs.map((l) => l.toUpperCase()).join(", ")})` : ""}${row.price ? `, ${fmtPrice(row.price)}` : ""}`;
  return (
    <button type="button" className="tile" onClick={() => (selecting ? onToggle() : onOpen(row.scryfall_id))} aria-label={label}
      aria-pressed={selecting ? selected : undefined}>
      {selecting && <span className="sel-mark" aria-hidden="true">{selected && <Icon.check />}</span>}
      <div className="img">
        {row.image_small
          ? <img src={row.image_small} alt="" loading="lazy" decoding="async" width="146" height="204" />
          : <div className="ph">{row.name}</div>}
        {foil && <span className="foil" aria-hidden="true">✦ {foil}</span>}
        {rowLangs(row).length > 0 && <span className="langs">{rowLangs(row).slice(0, 3).map((l) => <LangTag key={l} lang={l} />)}</span>}
        <span className="qty" aria-hidden="true">×{row.qty}</span>
      </div>
      <div className="cap" aria-hidden="true">
        <span className="n">{group === "printing" ? `${(row.set_code || "").toUpperCase()} #${row.collector_number}` : row.name}</span>
        <span className="p">{fmtPrice(row.price)}</span>
      </div>
    </button>
  );
}

function CardListRow({ row, group, onOpen, selecting = false, selected = false, onToggle }) {
  const where = group === "printing" || row.printing_count === 1
    ? `${(row.set_code || "").toUpperCase()} #${row.collector_number}`
    : `${row.printing_count} printings`;
  return (
    <button type="button" className="list-row" onClick={() => (selecting ? onToggle() : onOpen(row.scryfall_id))} aria-pressed={selecting ? selected : undefined}>
      {selecting
        ? <span className="sel-mark" aria-hidden="true">{selected && <Icon.check />}</span>
        : <span className="q">{row.qty}×</span>}
      <span className="main">
        <span className="nm"><b>{row.name}</b> {rowLangs(row).map((l) => <LangTag key={l} lang={l} />)} <ManaCost cost={row.mana_cost} /></span>
        <span className="sub">{selecting ? `${row.qty}× · ` : ""}{row.type_line} · {where}</span>
      </span>
      <span className="end">
        <span>{fmtPrice(row.price)}</span>
        {/foil|etched/.test(row.finishes || "") && <span className="badge accent">✦ {row.finishes.split(",").filter((f) => f !== "normal").join(", ")}</span>}
      </span>
    </button>
  );
}

// Collection routes (URL hash, so the browser's back button works):
// #collection = binder overview, #collection/all = every card,
// #collection/binder/<name> = one binder, #collection/unsorted = copies without a binder.
function parseCollectionRoute(hash) {
  // A binder search from the overview travels as ?q=… (binder names are encoded, so "?" is never part of one).
  const raw = String(hash || "").replace(/^#/, "");
  const qi = raw.indexOf("?");
  let q = null;
  if (qi >= 0) { try { q = new URLSearchParams(raw.slice(qi + 1)).get("q") || null; } catch { /* ignore */ } }
  const parts = (qi < 0 ? raw : raw.slice(0, qi)).split("/");
  if (parts[0] !== "collection") return null;
  const withQ = (r) => (q ? { ...r, q } : r);
  if (parts[1] === "all") return withQ({ view: "all" });
  if (parts[1] === "sets") return { view: "sets" };
  if (parts[1] === "set" && /^[a-z0-9]{2,8}$/i.test(parts[2] || "")) return { view: "set", code: parts[2].toLowerCase() };
  if (parts[1] === "unsorted") return withQ({ view: "binder", binder: "" });
  if (parts[1] === "binder" && parts.length > 2) {
    try { return withQ({ view: "binder", binder: decodeURIComponent(parts.slice(2).join("/")) }); } catch { /* bad escape */ }
  }
  return { view: "overview" };
}
const collectionHash = (r) => (r.view === "all" ? "#collection/all"
  : r.view === "sets" ? "#collection/sets"
  : r.view === "set" ? `#collection/set/${r.code}`
  : r.view === "binder" ? (r.binder ? `#collection/binder/${encodeURIComponent(r.binder)}` : "#collection/unsorted")
  : "#collection") + (r.q && r.view !== "overview" ? `?q=${encodeURIComponent(r.q)}` : "");
/** Change the hash (push, or replace keeping the history state) and tell the listeners. */
function goHash(h, { replace = false } = {}) {
  if (location.hash === h) return;
  if (replace) history.replaceState(history.state, "", h);
  else history.pushState({ mtgNav: true }, "", h);
  window.dispatchEvent(new HashChangeEvent("hashchange"));
}
// Binders above this many copies open in sections by set (each section loads on demand).
const BIG_BINDER_COPIES = 300;
const SECTION_OPTIONS = [["none", "No sections"], ["set", "By set"], ["color", "By colour"], ["rarity", "By rarity"], ["type", "By type"]];

/**
 * Collection tab: the binder overview (one entry per binder, grouped by type), a binder's
 * detail page or All cards. The view lives in the URL hash and in localStorage
 * (mtg.collection.route), so a reload or the back button lands where the user was.
 */
function CollectionTab({ dataVersion, homeKey = 0, onOpenCard, onOpenDeck, onGoImport, onGoScan, onChanged }) {
  const [route, setRoute] = useState(() => {
    const r = parseCollectionRoute(location.hash);
    if (r && r.view !== "overview") return r;
    const last = store.get("mtg.collection.route", null);
    return last && (last.view === "all" || (last.view === "binder" && typeof last.binder === "string")) ? last : { view: "overview" };
  });
  const binderList = useBinderList(dataVersion);
  // The search (?q=) is not remembered: a restored view opens without it.
  useEffect(() => { store.set("mtg.collection.route", route.view === "binder" ? { view: "binder", binder: route.binder } : { view: route.view }); }, [route]);
  // A restored view puts its hash in the URL (only while the Collection tab is shown).
  useEffect(() => {
    if (location.hash.slice(1).split("/")[0] === "collection" && location.hash !== collectionHash(route)) goHash(collectionHash(route), { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => {
    const onHash = () => { const r = parseCollectionRoute(location.hash); if (r) { setRoute(r); window.scrollTo(0, 0); } };
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);
  // Tapping the active Collection tab returns to the overview.
  const firstHome = useRef(homeKey);
  useEffect(() => { if (homeKey !== firstHome.current) goHash("#collection"); }, [homeKey]);

  const open = useCallback((r, opts) => goHash(collectionHash(r), opts), []);
  // Back: pop our own history entry when there is one, else replace with the overview.
  const back = useCallback(() => { if (history.state?.mtgNav) history.back(); else goHash("#collection", { replace: true }); }, []);

  const data = binderList.data;
  const entry = route.view === "binder" && data
    ? (route.binder === "" ? { ...data.unsorted, name: "" } : data.binders.find((b) => sameName(b.name, route.binder)) ?? null)
    : null;
  // A binder that no longer exists (renamed, deleted elsewhere) falls back to the overview.
  useEffect(() => {
    if (route.view === "binder" && route.binder && data && !entry) goHash("#collection", { replace: true });
  }, [route, data, entry]);

  if (route.view === "overview") {
    return <BinderOverview list={binderList} onOpen={open} onGoImport={onGoImport} onGoScan={onGoScan} onChanged={onChanged} />;
  }
  if (route.view === "sets") return <SetsView key="sets" dataVersion={dataVersion} onOpen={open} onBack={back} />;
  if (route.view === "set") return <SetView key={route.code} code={route.code} dataVersion={dataVersion} onBack={back} onOpenCard={onOpenCard} onChanged={onChanged} />;
  if (route.view === "binder" && !entry) {
    return binderList.error ? <ErrorNotice error={`Could not load binders: ${binderList.error}`} onRetry={binderList.reload} /> : <Spinner />;
  }
  const key = collectionHash(route);
  return (
    <CollectionBrowser key={key} binder={route.view === "binder" ? entry.name : null} entry={entry} binderList={binderList} initialQ={route.q ?? null}
      dataVersion={dataVersion} onBack={back} onOpen={open} onOpenCard={onOpenCard} onOpenDeck={onOpenDeck}
      onGoImport={onGoImport} onGoScan={onGoScan} onChanged={onChanged} />
  );
}

/** Tiles or list rows of collection rows (search results or one section). */
function CardRows({ rows, view, group, onOpenCard, selecting, isSelected, onToggle }) {
  return view === "grid"
    ? <div className="grid">{rows.map((r) => <CardTile key={r.scryfall_id} row={r} group={group} onOpen={onOpenCard}
        selecting={selecting} selected={isSelected(r)} onToggle={() => onToggle(r)} />)}</div>
    : <div className="list">{rows.map((r) => <CardListRow key={r.scryfall_id} row={r} group={group} onOpen={onOpenCard}
        selecting={selecting} selected={isSelected(r)} onToggle={() => onToggle(r)} />)}</div>;
}

/**
 * Search, sort, select/move/delete over one binder (binder = name, "" = Unsorted) or the
 * whole collection (binder = null). Optional sections (by set / colour / rarity / type):
 * only the headers load first, each section fetches its cards when opened.
 */
function CollectionBrowser({ binder, entry, binderList, initialQ = null, dataVersion, onBack, onOpen, onOpenCard, onOpenDeck, onGoImport, onGoScan, onChanged }) {
  const all = binder == null;
  // initialQ: the search the Binders overview found this binder with.
  const [q, setQ] = useState(() => initialQ ?? (all ? store.get("mtg.q", "") : ""));
  const dq = useDebounced(q.trim(), 300);
  const [group, setGroup] = useState(() => store.get("mtg.group", "card"));
  const [sort, setSort] = useState(() => store.get("mtg.sort", "name"));
  const [dir, setDir] = useState(() => store.get("mtg.dir", "asc"));
  const [view, setView] = useState(() => store.get("mtg.view", "grid"));
  // Sections per view (mtg.sections {<binder | "*all">: by}); big binders default to sets.
  const scopeKey = all ? "*all" : (binder || "*unsorted").toLowerCase();
  const [sectionPref, setSectionPref] = useState(() => store.get("mtg.sections", {})?.[scopeKey] ?? null);
  const sectionBy = sectionPref ?? (all ? "none" : entry ? (entry.copies > BIG_BINDER_COPIES ? "set" : "none") : null);
  const changeSections = (by) => {
    setSectionPref(by);
    store.set("mtg.sections", { ...(store.get("mtg.sections", {}) || {}), [scopeKey]: by });
  };
  const [selecting, setSelecting] = useState(false);
  const [selected, setSelected] = useState(() => new Map()); // key -> {key, oracle_id, scryfall_id, name}
  const [sheet, setSheet] = useState(null); // "new" | "manage" | "move" | "delete" | "menu"
  const [guarded, masterDialog] = useMasterConfirm();
  const [rows, setRows] = useState([]);
  const [total, setTotal] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const reqId = useRef(0);
  const loadingRef = useRef(false);
  const sentinel = useRef(null);
  const sectioned = sectionBy != null && sectionBy !== "none";

  useEffect(() => { if (all) store.set("mtg.q", q); }, [q, all]);
  useEffect(() => { store.set("mtg.group", group); store.set("mtg.sort", sort); store.set("mtg.dir", dir); store.set("mtg.view", view); }, [group, sort, dir, view]);
  // Selection keys depend on the grouping.
  useEffect(() => { setSelected(new Map()); }, [group]);

  const baseParams = useCallback((extra = {}) => {
    const p = new URLSearchParams({ q: dq, group, sort, dir, ...extra });
    if (binder != null) p.set("binder", binder);
    return p;
  }, [dq, group, sort, dir, binder]);

  const load = useCallback(async (offset) => {
    const id = ++reqId.current;
    loadingRef.current = true;
    setLoading(true);
    setError(null);
    try {
      const data = await api(`/api/collection?${baseParams({ limit: String(PAGE_SIZE), offset: String(offset) })}`);
      if (id !== reqId.current) return;
      setTotal(data.total);
      setRows((prev) => (offset === 0 ? data.rows : [...prev, ...data.rows]));
    } catch (e) {
      if (id !== reqId.current) return;
      setError(e.status === 400 ? `Search error: ${e.message}` : e.message);
      if (offset === 0) { setRows([]); setTotal(null); }
    } finally {
      if (id === reqId.current) { loadingRef.current = false; setLoading(false); }
    }
  }, [baseParams]);

  // Flat list: loads pages. Sectioned: the sections load themselves (SectionList).
  useEffect(() => {
    if (sectionBy == null) return;
    if (!sectioned) { load(0); return; }
    reqId.current++;
    setRows([]); setTotal(null); setLoading(false); loadingRef.current = false;
  }, [load, dataVersion, sectionBy, sectioned]);

  const hasMore = !sectioned && total != null && rows.length < total;
  // Infinite scroll: auto-load when the sentinel nears the viewport.
  useEffect(() => {
    const el = sentinel.current;
    if (!el || !hasMore || error || typeof IntersectionObserver === "undefined") return;
    const io = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting) && !loadingRef.current) load(rows.length);
    }, { rootMargin: "600px 0px" });
    io.observe(el);
    return () => io.disconnect();
  }, [hasMore, rows.length, load, error]);

  const tokens = tokenize(q);
  const toggleFilter = (term) => {
    const lower = term.toLowerCase();
    const has = tokens.some((t) => t.toLowerCase() === lower);
    setQ(has ? tokens.filter((t) => t.toLowerCase() !== lower).join(" ") : appendTerm(q, term));
  };
  const changeSort = (s) => {
    setSort(s);
    setDir(SORTS.find(([k]) => k === s)?.[2] || "asc");
  };

  const copies = all ? null : entry?.copies ?? null;
  const emptyCollection = all && total === 0 && !dq;
  const emptyBinder = !all && copies === 0 && !dq;
  const keyOf = (r) => (group === "card" ? r.oracle_id || r.scryfall_id : r.scryfall_id);
  const isSelected = (r) => selected.has(keyOf(r));
  const toggleRow = (r) => setSelected((m) => {
    const n = new Map(m);
    const k = keyOf(r);
    if (n.has(k)) n.delete(k); else n.set(k, { key: k, oracle_id: r.oracle_id, scryfall_id: r.scryfall_id, name: r.name });
    return n;
  });
  // "All" means every card of the current view (search + binder), not just the loaded pages: it pages
  // through /api/collection. Capped at SELECT_ALL_MAX, the server's per-action item limit.
  const [selectingAll, setSelectingAll] = useState(false);
  const [selectCapped, setSelectCapped] = useState(false);
  const [viewTotal, setViewTotal] = useState(null); // sectioned: cards in the view (for "All")
  const totalForAll = sectioned ? viewTotal : total;
  const allSelected = totalForAll != null && totalForAll > 0 && selected.size >= Math.min(totalForAll, SELECT_ALL_MAX);
  const selectAll = async () => {
    if (allSelected) { setSelected(new Map()); setSelectCapped(false); return; }
    setSelectingAll(true);
    try {
      const picked = new Map();
      for (let offset = 0; picked.size < SELECT_ALL_MAX; offset += 500) {
        const data = await api(`/api/collection?${baseParams({ limit: "500", offset: String(offset) })}`);
        for (const r of data.rows) if (picked.size < SELECT_ALL_MAX) picked.set(keyOf(r), { key: keyOf(r), oracle_id: r.oracle_id, scryfall_id: r.scryfall_id, name: r.name });
        setViewTotal(data.total);
        if (data.rows.length < 500 || offset + 500 >= data.total) { setSelectCapped(data.total > SELECT_ALL_MAX); break; }
      }
      setSelected(picked);
    } catch (e) {
      setError(e.message);
    } finally {
      setSelectingAll(false);
    }
  };
  const stopSelecting = () => { setSelecting(false); setSelected(new Map()); };
  const binderName = all ? null : binder || UNSORTED;
  const [showToast, toastEl] = useEditToast(() => { binderList.reload(); onChanged?.(); });
  const afterChange = (text, editId = null) => { if (text) showToast({ text, editId }); binderList.reload(); onChanged?.(); };
  const canSelect = sectioned ? !emptyBinder : rows.length > 0;

  return (
    <div className="stack-lg">
      <BinderHeader binder={binder} entry={entry} list={binderList.data} onBack={onBack} onOpen={onOpen} onOpenDeck={onOpenDeck}
        onMenu={() => setSheet("menu")} onChanged={() => afterChange(null)} />
      <StatsBar dataVersion={dataVersion} binder={binder} scopeLine={false} compact={!all} />

      <div className="stack">
        <form className="search" role="search" onSubmit={(e) => { e.preventDefault(); e.currentTarget.querySelector("input")?.blur(); }}>
          <Icon.search />
          <label htmlFor="collection-q" className="sr-only">{all ? "Search your collection" : `Search ${binderName}`}</label>
          <input id="collection-q" className="input" type="search" inputMode="search" enterKeyHint="search"
            autoComplete="off" autoCorrect="off" autoCapitalize="off" spellCheck="false"
            placeholder={all ? "Search… e.g. t:creature c:g cmc<=3" : `Search in ${binderName}…`} value={q} onChange={(e) => setQ(e.target.value)} />
          {q && <button type="button" className="btn ghost icon clear" aria-label="Clear search" onClick={() => setQ("")}><Icon.close /></button>}
        </form>
        <div className="chips" role="group" aria-label="Quick filters">
          {QUICK_FILTERS.map(([label, term]) => (
            <button key={term} type="button" className="chip" aria-pressed={tokens.some((t) => t.toLowerCase() === term.toLowerCase())}
              onClick={() => toggleFilter(term)}>{label}</button>
          ))}
        </div>
        <QueryHelp />
        <div className="toolbar">
          <div className="segmented" role="group" aria-label="Group by">
            <button type="button" aria-pressed={group === "card"} onClick={() => setGroup("card")}>Cards</button>
            <button type="button" aria-pressed={group === "printing"} onClick={() => setGroup("printing")}>Printings</button>
          </div>
          <label htmlFor="collection-sort" className="sr-only">Sort by</label>
          <select id="collection-sort" className="select grow" style={{ maxWidth: 170 }} value={sort} onChange={(e) => changeSort(e.target.value)}>
            {SORTS.map(([k, label]) => <option key={k} value={k}>{label}</option>)}
          </select>
          <button type="button" className="btn icon" onClick={() => setDir(dir === "asc" ? "desc" : "asc")}
            aria-label={dir === "asc" ? "Ascending, switch to descending" : "Descending, switch to ascending"} title={dir === "asc" ? "Ascending" : "Descending"}>
            {dir === "asc" ? <Icon.up /> : <Icon.down />}
          </button>
          <label htmlFor="collection-sections" className="sr-only">Sections</label>
          <select id="collection-sections" className="select grow" style={{ maxWidth: 160 }} value={sectionBy ?? "none"} onChange={(e) => changeSections(e.target.value)}>
            {SECTION_OPTIONS.map(([k, label]) => <option key={k} value={k}>{label}</option>)}
          </select>
          <button type="button" className={`btn${selecting ? " primary" : ""}`} aria-pressed={selecting} onClick={() => (selecting ? stopSelecting() : setSelecting(true))}
            disabled={!canSelect && !selecting}><Icon.check /> {selecting ? "Done" : "Select"}</button>
          <div className="segmented" role="group" aria-label="View" style={{ marginLeft: "auto" }}>
            <button type="button" aria-pressed={view === "grid"} aria-label="Grid view" onClick={() => setView("grid")}><Icon.grid /></button>
            <button type="button" aria-pressed={view === "list"} aria-label="List view" onClick={() => setView("list")}><Icon.list /></button>
          </div>
        </div>
      </div>

      <div className="stack">
        {!sectioned && (
          <div className="result-count" aria-live="polite">
            {total != null && !emptyCollection && !emptyBinder && `${plural(total, group === "card" ? "card" : "printing")}${dq ? " match" + (total === 1 ? "es" : "") : ""}${binderName ? ` in ${binderName}` : ""}`}
          </div>
        )}

        {error && <ErrorNotice error={error} onRetry={() => load(rows.length && hasMore ? rows.length : 0)} />}

        {emptyCollection && (
          <div className="empty card">
            <h3>Your collection is empty</h3>
            <p style={{ margin: 0 }}>Scan your cards with the camera, or export your collection from ManaBox as CSV and import it here.</p>
            <div className="row" style={{ justifyContent: "center" }}>
              <button type="button" className="btn primary" onClick={onGoScan}><Icon.scan /> Scan cards</button>
              <button type="button" className="btn" onClick={onGoImport}><Icon.import /> Import from ManaBox</button>
            </div>
          </div>
        )}
        {emptyBinder && (
          <div className="empty card">
            <h3>{binder ? `“${binder}” is empty` : "Nothing unsorted"}</h3>
            <p style={{ margin: 0 }}>{binder ? "Open All cards, tap Select, pick cards and move them into this binder. Or use Move… on a card's owned printings." : "Every copy is in a binder."}</p>
            <button type="button" className="btn" onClick={() => onOpen({ view: "all" })}>Show all cards</button>
          </div>
        )}
        {!sectioned && total === 0 && dq && !error && (
          <div className="empty"><h3>No matches</h3><p style={{ margin: 0 }}>Nothing {binderName ? `in ${binderName}` : "in your collection"} matches <code>{dq}</code>.</p></div>
        )}

        {sectioned && !emptyBinder && (
          <SectionList by={sectionBy} params={baseParams} dq={dq} group={group} view={view} dataVersion={dataVersion} binderName={binderName}
            onOpenCard={onOpenCard} selecting={selecting} isSelected={isSelected} onToggle={toggleRow} />
        )}
        {!sectioned && rows.length > 0 && (
          <CardRows rows={rows} view={view} group={group} onOpenCard={onOpenCard} selecting={selecting} isSelected={isSelected} onToggle={toggleRow} />
        )}

        {!sectioned && loading && <Spinner label={rows.length ? "Loading more…" : "Searching…"} />}
        <div ref={sentinel} aria-hidden="true" />
        {hasMore && !loading && !error && (
          <button type="button" className="btn" onClick={() => load(rows.length)}>
            Load more ({fmtInt(total - rows.length)} left)
          </button>
        )}
      </div>

      {selecting && (
        <div className="commit-bar" role="region" aria-label="Selection">
          <span className="grow small">{selected.size
            ? plural(selected.size, group === "card" ? "card" : "printing") + " selected" + (selectCapped && allSelected ? ` (max ${SELECT_ALL_MAX} at once)` : "")
            : "Tap cards to select"}</span>
          <button type="button" className="btn ghost" onClick={selectAll} disabled={!canSelect || selectingAll}>
            {selectingAll ? "…" : allSelected ? "None" : "All"}</button>
          <button type="button" className="btn danger" disabled={!selected.size} onClick={() => setSheet("delete")} aria-label="Delete the selected copies"><Icon.trash /><span className="sel-del-label"> Delete</span></button>
          <button type="button" className="btn primary" disabled={!selected.size} onClick={() => setSheet("move")}>Move to…</button>
        </div>
      )}
      {sheet === "menu" && entry && binder && (
        <BinderMenuSheet entry={entry} list={binderList.data} onClose={() => setSheet(null)}
          onChanged={() => afterChange(null)}
          onRenamed={(name) => { setSheet(null); afterChange(`Renamed to “${name}”`); onOpen({ view: "binder", binder: name }, { replace: true }); }}
          onDeleted={(text, editId) => { setSheet(null); afterChange(text, editId); onBack(); }} />
      )}
      {sheet === "move" && (
        <BulkMoveSheet items={[...selected.values()]} group={group} binder={binder} guarded={guarded} onClose={() => setSheet(null)}
          onDone={(res) => {
            setSheet(null);
            stopSelecting();
            afterChange(`Moved ${plural(res.moved_copies, "copy", "copies")} to ${res.to_binder || UNSORTED}`);
          }} />
      )}
      {sheet === "delete" && (
        <BulkDeleteSheet items={[...selected.values()]} group={group} binder={binder} onClose={() => setSheet(null)}
          onDone={(res, n) => {
            setSheet(null);
            stopSelecting();
            afterChange(`Deleted ${plural(res?.deleted_copies ?? n, "copy", "copies")}`, res?.edit_id ?? null);
          }} />
      )}
      {masterDialog}
      {toastEl}
    </div>
  );
}

/**
 * Collapsible sections of a collection view (GET /api/collection/sections). Closed
 * sections render only their header; an open one pages its cards like the flat list.
 */
function SectionList({ by, params, dq, group, view, dataVersion, binderName, onOpenCard, selecting, isSelected, onToggle }) {
  const [open, setOpen] = useState(() => new Set());
  const sp = params();
  sp.delete("sort"); sp.delete("dir");
  sp.set("by", by);
  const qs = sp.toString();
  const { data, error, reload: load, setData } = useApi(`/api/collection/sections?${qs}`, [dataVersion],
    { map: (d) => d.sections, error: (e) => (e.status === 400 ? `Search error: ${e.message}` : e.message) });
  useEffect(() => { setOpen(new Set()); setData(null); }, [by, qs, setData]);
  // Few sections or a search: open the first ones, else everything starts closed.
  useEffect(() => {
    if (data) setOpen((prev) => (prev.size ? prev : new Set(data.length <= 2 ? data.map((s) => s.key) : dq ? data.slice(0, 3).map((s) => s.key) : [])));
  }, [data]); // eslint-disable-line react-hooks/exhaustive-deps
  const toggle = (k) => setOpen((s) => { const n = new Set(s); if (n.has(k)) n.delete(k); else n.add(k); return n; });
  const unit = { set: ["set", "sets"], color: ["colour", "colours"], rarity: ["rarity", "rarities"], type: ["type", "types"] }[by] || ["section", "sections"];
  if (error) return <ErrorNotice error={error} onRetry={load} />;
  if (!data) return <Spinner />;
  if (!data.length) {
    return <div className="empty"><h3>No matches</h3><p style={{ margin: 0 }}>Nothing {binderName ? `in ${binderName}` : "in your collection"} matches <code>{dq}</code>.</p></div>;
  }
  const allOpen = data.every((s) => open.has(s.key));
  return (
    <div className="stack" style={{ gap: 8 }}>
      <div className="row between">
        <span className="result-count" aria-live="polite">{plural(data.length, ...unit)}{dq ? " with matches" : ""} · tap one to open</span>
        {data.length > 1 && (
          <button type="button" className="btn ghost sm" onClick={() => setOpen(allOpen ? new Set() : new Set(data.map((s) => s.key)))}>
            {allOpen ? "Close all" : "Open all"}</button>
        )}
      </div>
      {data.map((s) => (
        <CollSection key={s.key} s={s} by={by} open={open.has(s.key)} onToggle={() => toggle(s.key)} qs={qs} params={params}
          group={group} view={view} dataVersion={dataVersion} onOpenCard={onOpenCard} selecting={selecting} isSelected={isSelected} onToggle2={onToggle} />
      ))}
    </div>
  );
}

function CollSection({ s, by, open, onToggle, params, group, view, dataVersion, onOpenCard, selecting, isSelected, onToggle2 }) {
  const id = useMemo(() => `sec-${Math.random().toString(36).slice(2)}`, []);
  return (
    <section className={`coll-section${open ? " open" : ""}`}>
      <h3 className="coll-section-h">
        <button type="button" aria-expanded={open} aria-controls={id} onClick={onToggle}>
          <span className="chev" aria-hidden="true">▸</span>
          <span className="nm">{s.label}{by === "set" && s.key ? <span className="muted small"> {s.key.toUpperCase()}</span> : null}</span>
          <span className="sub">{fmtInt(s.copies)} · {fmtEur(s.value_eur)}</span>
        </button>
      </h3>
      {open && (
        <div id={id} className="coll-section-body">
          <SectionRows section={s} by={by} params={params} group={group} view={view} dataVersion={dataVersion} onOpenCard={onOpenCard}
            selecting={selecting} isSelected={isSelected} onToggle={onToggle2} />
        </div>
      )}
    </section>
  );
}

function SectionRows({ section, by, params, group, view, dataVersion, onOpenCard, selecting, isSelected, onToggle }) {
  const [rows, setRows] = useState([]);
  const [total, setTotal] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const reqId = useRef(0);
  const loadingRef = useRef(false);
  const sentinel = useRef(null);
  const load = useCallback(async (offset) => {
    const id = ++reqId.current;
    loadingRef.current = true;
    setLoading(true); setError(null);
    try {
      const d = await api(`/api/collection?${params({ section_by: by, section: section.key, limit: String(PAGE_SIZE), offset: String(offset) })}`);
      if (id !== reqId.current) return;
      setTotal(d.total);
      setRows((prev) => (offset === 0 ? d.rows : [...prev, ...d.rows]));
    } catch (e) {
      if (id === reqId.current) setError(e.message);
    } finally {
      if (id === reqId.current) { loadingRef.current = false; setLoading(false); }
    }
  }, [params, by, section.key]);
  useEffect(() => { load(0); }, [load, dataVersion]);
  const hasMore = total != null && rows.length < total;
  useEffect(() => {
    const el = sentinel.current;
    if (!el || !hasMore || error || typeof IntersectionObserver === "undefined") return;
    const io = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting) && !loadingRef.current) load(rows.length);
    }, { rootMargin: "400px 0px" });
    io.observe(el);
    return () => io.disconnect();
  }, [hasMore, rows.length, load, error]);
  return (
    <div className="stack" style={{ gap: 8 }}>
      {error && <ErrorNotice error={error} onRetry={() => load(rows.length && hasMore ? rows.length : 0)} />}
      {rows.length > 0 && <CardRows rows={rows} view={view} group={group} onOpenCard={onOpenCard} selecting={selecting} isSelected={isSelected} onToggle={onToggle} />}
      {loading && <Spinner label={rows.length ? "Loading more…" : "Loading…"} />}
      <div ref={sentinel} aria-hidden="true" />
      {hasMore && !loading && !error && (
        <button type="button" className="btn sm" onClick={() => load(rows.length)}>Load more ({fmtInt(total - rows.length)} left)</button>
      )}
    </div>
  );
}

/** Move every copy of the selected cards (or only those in the filtered binder). */
function BulkMoveSheet({ items, group, binder, guarded, onClose, onDone }) {
  const [scoped, setScoped] = useState(binder != null);
  const what = plural(items.length, group === "card" ? "card" : "printing");
  return (
    <MoveSheet title={`Move ${what}`} exclude={scoped ? binder : null} submitLabel="Move" onClose={onClose}
      intro={<span className="small muted" style={{ overflowWrap: "anywhere" }}>{selectionNames(items)}</span>}
      onMove={async ({ to_binder, create }) => {
        const list = selectionItems(items, group, scoped ? binder : null);
        const res = await guarded((confirm) => api("/api/collection/move", { method: "POST", json: { items: list, to_binder, create, confirm_master: confirm } }));
        if (!res) return false;
        onDone(res);
        return true;
      }}>
      {binder != null ? (
        <label className="radio-card">
          <input type="checkbox" checked={scoped} onChange={(e) => setScoped(e.target.checked)} />
          <span><b>Only copies in {binder || UNSORTED}</b><br /><span className="small muted">{scoped ? "Copies in other binders stay where they are." : `Every copy of the selected ${group === "card" ? "cards" : "printings"} moves, from all binders.`}</span></span>
        </label>
      ) : (
        <span className="small muted">Every copy of the selected {group === "card" ? "cards (all printings)" : "printings"} moves, from all binders.</span>
      )}
    </MoveSheet>
  );
}
