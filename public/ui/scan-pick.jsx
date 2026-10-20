"use strict";

// ---------------------------------------------------------------------------
// Printing picker (candidates, all printings of a card, title search)

/**
 * Where a list of printings differs: per field, whether the values differ and
 * the common prefix/suffix length (so only the differing characters of a set
 * code or collector number get marked).
 */
function printingDiff(list) {
  const out = { set: null, cn: null, lang: false, finish: false, tags: new Set() };
  if (!list || list.length < 2) return out;
  const affix = (vals) => {
    if (new Set(vals).size < 2) return null;
    const min = Math.min(...vals.map((v) => v.length));
    let pre = 0;
    while (pre < min && vals.every((v) => v[pre] === vals[0][pre])) pre++;
    let suf = 0;
    while (suf < min - pre && vals.every((v) => v[v.length - 1 - suf] === vals[0][vals[0].length - 1 - suf])) suf++;
    return { pre, suf };
  };
  out.set = affix(list.map((p) => p.set.toUpperCase()));
  out.cn = affix(list.map((p) => String(p.cn)));
  out.lang = new Set(list.map((p) => p.lang)).size > 1;
  out.finish = new Set(list.map((p) => p.finishes.join("/"))).size > 1;
  const all = list.map((p) => new Set(p.tags || []));
  for (const t of new Set(list.flatMap((p) => p.tags || []))) if (!all.every((x) => x.has(t))) out.tags.add(t);
  return out;
}

/** Text with the differing middle part (between common prefix and suffix) marked. */
function DiffText({ text, d, prefix = "" }) {
  const t = String(text);
  if (!d) return <span className="same">{prefix}{t}</span>;
  const mid = t.slice(d.pre, t.length - d.suf);
  return <span>{prefix}{t.slice(0, d.pre)}{mid ? <mark>{mid}</mark> : null}{t.slice(t.length - d.suf)}</span>;
}

function PickTile({ p, current, onPick, diff }) {
  const d = diff || printingDiff([]);
  const tags = (p.tags || []).filter((t) => d.tags.has(t) || (p.tags || []).length <= 2);
  return (
    <button type="button" className="pick" aria-current={current || undefined} onClick={() => onPick(p)}
      aria-label={`${p.name}, ${p.set_name || p.set.toUpperCase()} number ${p.cn}${p.lang ? `, ${p.lang}` : ""}${p.tags?.length ? `, ${p.tags.join(", ")}` : ""}`}>
      <span className="pcode" aria-hidden="true">
        <span className="pset"><DiffText text={p.set.toUpperCase()} d={d.set} /></span>
        <span className="pcn"><DiffText text={p.cn} d={d.cn} prefix="#" /></span>
        {/* Language variants share set + number: then the language is the difference. */}
        {d.lang && p.lang ? <span className="pcn"><mark>{p.lang.toUpperCase()}</mark></span> : null}
      </span>
      {p.img ? <img src={p.img} alt="" loading="lazy" decoding="async" /> : <span className="ph">{p.name}</span>}
      <span className="cap">
        <b>{p.name}</b>
        {p.set_name && <span className="muted" style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{p.set_name}</span>}
        <span className="ptags">
          {p.lang && <span className={`badge${d.lang ? " diff" : ""}`}>{p.lang.toUpperCase()}</span>}
          {p.finishes.length > 0 && <span className={`badge${d.finish ? " diff" : ""}`}>{p.finishes.map((f) => (f === "nonfoil" ? "non-foil" : f)).join(" / ")}</span>}
          {tags.map((t) => <span key={t} className={`badge${d.tags.has(t) ? " diff" : ""}`}>{t}</span>)}
        </span>
        {p.score != null && <span className="muted">score {p.score.toFixed(2)}</span>}
      </span>
    </button>
  );
}

/**
 * The user's own capture of the collector line (the high-res bottom strip),
 * zoomed in so near-identical printings can be told apart. Tries each source in
 * turn (server copy, then the local capture) and hides itself when none loads.
 * Pinch (touch), ctrl+wheel or the buttons zoom.
 */
function ScanStrip({ srcs, startZoom = 2 }) {
  const list = useMemo(() => (srcs || []).filter(Boolean), [srcs]);
  const [i, setI] = useState(0);
  const [zoom, setZoom] = useState(startZoom);
  const zoomRef = useRef(startZoom);
  zoomRef.current = zoom;
  const boxRef = useRef(null);
  const placed = useRef(false);

  // Zoom around a point (box coordinates), keeping that point in place.
  const zoomTo = useCallback((z, cx, cy) => {
    const box = boxRef.current;
    const prev = zoomRef.current;
    const next = Math.max(1, Math.min(6, z));
    if (!box || next === prev) return;
    const x = cx ?? box.clientWidth / 2, y = cy ?? box.clientHeight / 2;
    const sl = box.scrollLeft, st = box.scrollTop;
    zoomRef.current = next;
    setZoom(next);
    requestAnimationFrame(() => {
      box.scrollLeft = (sl + x) * (next / prev) - x;
      box.scrollTop = (st + y) * (next / prev) - y;
    });
  }, []);

  useEffect(() => {
    const box = boxRef.current;
    if (!box) return;
    let start = null;
    const dist = (t) => Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY);
    const mid = (t) => {
      const r = box.getBoundingClientRect();
      return [(t[0].clientX + t[1].clientX) / 2 - r.left, (t[0].clientY + t[1].clientY) / 2 - r.top];
    };
    const onStart = (e) => { if (e.touches.length === 2) start = { d: dist(e.touches), z: zoomRef.current }; };
    const onMove = (e) => {
      if (!start || e.touches.length !== 2) return;
      e.preventDefault();
      const [x, y] = mid(e.touches);
      zoomTo(start.z * dist(e.touches) / start.d, x, y);
    };
    const onEnd = (e) => { if (e.touches.length < 2) start = null; };
    const onWheel = (e) => {
      if (!e.ctrlKey) return;
      e.preventDefault();
      const r = box.getBoundingClientRect();
      zoomTo(zoomRef.current * Math.exp(-e.deltaY / 200), e.clientX - r.left, e.clientY - r.top);
    };
    box.addEventListener("touchstart", onStart, { passive: true });
    box.addEventListener("touchmove", onMove, { passive: false });
    box.addEventListener("touchend", onEnd, { passive: true });
    box.addEventListener("touchcancel", onEnd, { passive: true });
    box.addEventListener("wheel", onWheel, { passive: false });
    return () => {
      box.removeEventListener("touchstart", onStart);
      box.removeEventListener("touchmove", onMove);
      box.removeEventListener("touchend", onEnd);
      box.removeEventListener("touchcancel", onEnd);
      box.removeEventListener("wheel", onWheel);
    };
  }, [zoomTo, i, list.length]);

  if (i >= list.length) return null;
  const onLoad = () => {
    // M15+ frames: the collector line sits in the upper-left part of the strip,
    // start there. Older frames (startZoom 1) show the whole strip.
    const box = boxRef.current;
    if (!box || placed.current) return;
    placed.current = true;
    box.scrollLeft = 0;
    box.scrollTop = Math.max(0, (box.scrollHeight - box.clientHeight) * 0.25);
  };
  return (
    <figure className="scan-strip" style={{ margin: 0 }}>
      <div className="strip-box" ref={boxRef}>
        <img src={list[i]} alt="Your scan: the card's bottom edge with set code and collector number" draggable={false}
          style={{ width: `${zoom * 100}%` }} onLoad={onLoad} onError={() => { placed.current = false; setI((n) => n + 1); }} />
      </div>
      <figcaption className="strip-bar">
        <span className="grow">Your scan · compare the set code and number</span>
        <button type="button" className="btn ghost icon" aria-label="Zoom out" disabled={zoom <= 1} onClick={() => zoomTo(zoom / 1.4)}><Icon.zoomOut /></button>
        <button type="button" className="btn ghost icon" aria-label="Zoom in" disabled={zoom >= 6} onClick={() => zoomTo(zoom * 1.4)}><Icon.zoomIn /></button>
      </figcaption>
    </figure>
  );
}

function PrintingPicker({ title, candidates = [], oracleId = null, lang = "", currentId = null, startInSearch = false, strips = null, onPick, onClose }) {
  const cands = useMemo(() => candidates.map((c) => (c && c.set !== undefined && c.cn !== undefined ? c : normPrinting(c))).filter((c) => c && c.id), [candidates]);
  const [mode, setMode] = useState(startInSearch ? "search" : cands.length ? "cand" : oracleId ? "all" : "search");
  const [oid, setOid] = useState(oracleId || cands.find((c) => c.oracle_id)?.oracle_id || null);
  const [plang, setPlang] = useState(lang || "");
  const [all, setAll] = useState(null);
  const [q, setQ] = useState("");
  const dq = useDebounced(q.trim(), 300);
  const [hits, setHits] = useState(null);
  const [error, setError] = useState(null);
  const candDiff = useMemo(() => printingDiff(cands), [cands]);
  // Only the 2015 frame puts the collector line in the strip's upper-left
  // corner; for older frames (info at the centre/right) start with the whole strip.
  const stripZoom = cands.length && cands.every((c) => c.frame && c.frame !== "2015" && c.frame !== "future") ? 1 : 2;
  const allDiff = useMemo(() => printingDiff(all || []), [all]);

  useEffect(() => {
    if (mode !== "all" || !oid) return;
    let alive = true;
    setAll(null); setError(null);
    const params = new URLSearchParams({ oracle_id: oid });
    if (plang) params.set("lang", plang);
    api(`/api/printings?${params}`)
      .then((d) => { if (alive) setAll(asList(d).map(normPrinting).filter((p) => p && p.id)); })
      .catch((e) => { if (alive) setError(e.message); });
    return () => { alive = false; };
  }, [mode, oid, plang]);

  useEffect(() => {
    if (mode !== "search" || dq.length < 2) { setHits(null); return; }
    let alive = true;
    setError(null);
    const params = new URLSearchParams({ q: dq });
    if (plang) params.set("lang", plang);
    api(`/api/printings/search?${params}`)
      .then((d) => { if (alive) setHits(asList(d)); })
      .catch((e) => { if (alive) setError(e.message); });
    return () => { alive = false; };
  }, [mode, dq, plang]);

  const langSelect = (
    <select className="select" style={{ width: "auto" }} aria-label="Language filter" value={plang} onChange={(e) => setPlang(e.target.value)}>
      <option value="">All languages</option>
      {SCAN_LANGS.map(([k, label]) => <option key={k} value={k}>{label}</option>)}
    </select>
  );

  return (
    <Sheet title={title} onClose={onClose} pinned={strips && strips.length ? <ScanStrip srcs={strips} startZoom={stripZoom} /> : null}>
      <div className="stack">
        <div className="row">
          <div className="segmented" role="group" aria-label="Show">
            {cands.length > 0 && <button type="button" aria-pressed={mode === "cand"} onClick={() => setMode("cand")}>Candidates ({cands.length})</button>}
            {oid && <button type="button" aria-pressed={mode === "all"} onClick={() => setMode("all")}>All printings</button>}
            <button type="button" aria-pressed={mode === "search"} onClick={() => setMode("search")}><Icon.search /> Name</button>
          </div>
          {mode !== "cand" && langSelect}
        </div>
        <ErrorNotice error={error} />
        {mode === "cand" && (
          <div className="pick-grid">{cands.map((p) => <PickTile key={p.id} p={p} diff={candDiff} current={p.id === currentId} onPick={onPick} />)}</div>
        )}
        {mode === "all" && (!all ? (!error && <Spinner />) : all.length === 0
          ? <p className="muted">No printings found{plang ? " in this language" : ""}.</p>
          : <div className="pick-grid">{all.map((p) => <PickTile key={p.id} p={p} diff={allDiff} current={p.id === currentId} onPick={onPick} />)}</div>)}
        {mode === "search" && (
          <div className="stack">
            <div className="search">
              <Icon.search />
              <label htmlFor="pick-q" className="sr-only">Card name</label>
              <input id="pick-q" className="input" type="search" autoFocus autoComplete="off" autoCorrect="off" spellCheck="false"
                placeholder="Card name (any language)…" value={q} onChange={(e) => setQ(e.target.value)} />
            </div>
            {hits && hits.length === 0 && <p className="muted">No card matches “{dq}”.</p>}
            {hits && hits.length > 0 && (
              <div className="hit-list">
                {hits.map((h, i) => (
                  <button key={`${h.id || h.oracle_id}-${i}`} type="button" className="hit"
                    onClick={() => { setOid(h.oracle_id); if (h.lang && !plang) setPlang(h.lang); setMode("all"); }}>
                    <span><b>{h.printed_name || h.name}</b>{h.printed_name && h.printed_name !== h.name && <span className="muted small"> · {h.name}</span>}</span>
                    {h.lang && <span className="badge">{String(h.lang).toUpperCase()}</span>}
                  </button>
                ))}
              </div>
            )}
          </div>
        )}
      </div>
    </Sheet>
  );
}

// ---------------------------------------------------------------------------
// Commit sheet: add staged scans to a binder or a deck

function CommitSheet({ ids, onClose, onDone }) {
  const saved = store.get("mtg.scan.target", {}) || {};
  const [type, setType] = useState(saved.type === "deck" ? "deck" : "binder");
  // Failures leave empty lists (new binder / new deck stays possible).
  const binderList = useBinderList();
  const binders = binderList.data?.binders ?? (binderList.error ? [] : null);
  // Decks synced from ManaBox are rebuilt by the next replace import: not a target.
  const deckList = useApi("/api/decks", [], { map: (d) => d.filter((dk) => dk.source !== "manabox") });
  const decks = deckList.data ?? (deckList.error ? [] : null);
  const [binder, setBinder] = useState(saved.type === "binder" && saved.name ? saved.name : "");
  const [newBinder, setNewBinder] = useState("");
  const [deckId, setDeckId] = useState(saved.type === "deck" && saved.id ? String(saved.id) : "");
  const [newDeck, setNewDeck] = useState({ name: "", format: "commander" });
  const [board, setBoard] = useState(saved.board || "main");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  // Default targets once the lists are in: the remembered one when it still exists, else the first, else new.
  useEffect(() => {
    if (binders) setBinder((b) => (b && (b === "__new" || binders.some((x) => x.name === b)) ? b : binders[0]?.name || "__new"));
  }, [binderList.data, binderList.error]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (decks) setDeckId((x) => (x && (x === "__new" || decks.some((dk) => String(dk.id) === x)) ? x : decks[0] ? String(decks[0].id) : "__new"));
  }, [deckList.data, deckList.error]); // eslint-disable-line react-hooks/exhaustive-deps

  let target = null, label = "";
  if (type === "binder") {
    const name = binder === "__new" ? newBinder.trim() : binder;
    if (name) { target = { type: "binder", name, create: binder === "__new" }; label = `binder “${name}”`; }
  } else if (deckId === "__new") {
    if (newDeck.name.trim()) { target = { type: "deck", name: newDeck.name.trim(), create: true, format: newDeck.format, board }; label = `new deck “${newDeck.name.trim()}”`; }
  } else if (deckId) {
    const dk = decks?.find((d) => String(d.id) === deckId);
    target = { type: "deck", id: Number(deckId), board };
    label = `deck “${dk?.name || deckId}”`;
  }

  const submit = async (e) => {
    e.preventDefault();
    if (!target || busy) return;
    setBusy(true); setError(null);
    try {
      const res = await api("/api/scans/commit", { method: "POST", json: { ids, target } });
      const resTarget = res?.target || {};
      store.set("mtg.scan.target", target.type === "binder"
        ? { type: "binder", name: target.name }
        : { type: "deck", id: resTarget.id ?? target.id ?? null, board });
      onDone(res, label);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Sheet title={`Add ${plural(ids.length, "scan")} to…`} onClose={onClose}>
      <form className="stack" onSubmit={submit}>
        <div className="segmented" role="group" aria-label="Destination">
          <button type="button" aria-pressed={type === "binder"} onClick={() => setType("binder")}><Icon.collection /> Binder</button>
          <button type="button" aria-pressed={type === "deck"} onClick={() => setType("deck")}><Icon.decks /> Deck</button>
        </div>
        {type === "binder" && (
          <fieldset className="stack" style={{ border: 0, padding: 0, margin: 0 }}>
            <legend className="label" style={{ marginBottom: 8 }}>Binder (collection)</legend>
            {!binders && <Spinner />}
            {binders?.map((b) => (
              <label key={b.name} className="radio-card">
                <input type="radio" name="binder" checked={binder === b.name} onChange={() => setBinder(b.name)} />
                <span className="grow"><b>{b.name}</b><br /><span className="small muted">{plural(b.copies ?? b.cards ?? 0, "copy", "copies")}{b.sources ? ` · ${[].concat(b.sources).join(", ")}` : ""}</span></span>
              </label>
            ))}
            <label className="radio-card">
              <input type="radio" name="binder" checked={binder === "__new"} onChange={() => setBinder("__new")} />
              <span className="grow"><b>New binder…</b></span>
            </label>
            {binder === "__new" && (
              <input className="input" style={{ fontSize: 16 }} aria-label="New binder name" placeholder="New binder name, e.g. Trade binder" maxLength={100} autoFocus
                value={newBinder} onChange={(e) => setNewBinder(e.target.value)} />
            )}
          </fieldset>
        )}
        {type === "deck" && (
          <div className="stack">
            <div className="field">
              <label htmlFor="commit-deck">Deck</label>
              <select id="commit-deck" className="select" value={deckId} onChange={(e) => setDeckId(e.target.value)}>
                {decks?.map((d) => <option key={d.id} value={String(d.id)}>{d.name}{d.format ? ` (${d.format})` : ""}</option>)}
                <option value="__new">New deck…</option>
              </select>
            </div>
            {deckId === "__new" && (
              <div className="row" style={{ alignItems: "flex-end" }}>
                <div className="field grow" style={{ flexBasis: 200 }}>
                  <label htmlFor="commit-deck-name">Deck name</label>
                  <input id="commit-deck-name" className="input" required maxLength={200} value={newDeck.name} onChange={(e) => setNewDeck({ ...newDeck, name: e.target.value })} />
                </div>
                <div className="field" style={{ flexBasis: 150, flexGrow: 1 }}>
                  <label htmlFor="commit-deck-format">Format</label>
                  <select id="commit-deck-format" className="select" value={newDeck.format} onChange={(e) => setNewDeck({ ...newDeck, format: e.target.value })}>
                    {FORMATS.map((f) => <option key={f} value={f}>{cap(f)}</option>)}
                  </select>
                </div>
              </div>
            )}
            <div className="field">
              <label htmlFor="commit-board">Board</label>
              <select id="commit-board" className="select" value={board} onChange={(e) => setBoard(e.target.value)}>
                {["main", "side", "commander", "maybe"].map((k) => <option key={k} value={k}>{BOARD_LABEL[k]}</option>)}
              </select>
            </div>
            <p className="small muted" style={{ margin: 0 }}>Deck cards are added to the deck list; they don't change your binders.</p>
          </div>
        )}
        <ErrorNotice error={error} />
        <button type="submit" className="btn primary" disabled={!target || busy}>
          {busy ? <><span className="spinner" aria-hidden="true" style={{ borderTopColor: "var(--accent-ink)" }} /> Adding…</> : <><Icon.check /> Add {plural(ids.length, "scan")}{label ? ` to ${label}` : ""}</>}
        </button>
      </form>
    </Sheet>
  );
}

// ---------------------------------------------------------------------------
// Calibration: confirm or correct the truth for each scan

// No finish is pre-selected (beta.1: the detected finish was pre-selected and 6 of 25 foil truths were
// saved as non-foil), and "Wrong: pick the printing" offers every finish, not just the wrong printing's.
// "Not a card / discard" deletes the staged scan; "Later" keeps it unconfirmed.
function TruthSheet({ entry, onClose, onDone, onPickNeeded, onDiscard }) {
  const { scan, result, preview } = entry;
  const detected = normPrinting(result?.printing || scan?.printing || (scan ? { ...scan, id: scan.printing_id } : null));
  const [finish, setFinish] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const confirm = async (printingId) => {
    if (!scan?.id || !printingId || !finish) return;
    setBusy(true); setError(null);
    try {
      await api(`/api/scans/${scan.id}/truth`, { method: "POST", json: { printing_id: printingId, finish } });
      onDone(`Truth saved for scan #${scan.id}`);
    } catch (e) { setError(e.message); } finally { setBusy(false); }
  };
  const fits = Boolean(finish && scan && scanFinishes(scan).includes(finish));
  return (
    <Sheet title="Calibration: is this right?" onClose={onClose}>
      <div className="stack">
        <div className="truth">
          <figure>{preview ? <img src={preview} alt="Your capture" /> : <div className="ph" />}<figcaption>Your capture</figcaption></figure>
          <figure>
            {detected?.img ? <img src={detected.img} alt={detected.name} /> : <div className="pick"><span className="ph">{detected?.name || "No match"}</span></div>}
            <figcaption>{detected ? `${detected.name} · ${printingLabel(detected)}` : `Identification: ${result?.status || "failed"}`}</figcaption>
          </figure>
        </div>
        <div className="row">
          <span className="label" id="truth-finish">Finish of your card</span>
          <div className="segmented" role="group" aria-labelledby="truth-finish">
            {["nonfoil", "foil", "etched"].map((f) => <button key={f} type="button" aria-pressed={finish === f} onClick={() => setFinish(f)}>{FINISH_LABEL[f]}</button>)}
          </div>
        </div>
        {!finish && <span className="small muted">Tap the finish first (look for the shine, or ★ vs • on the collector line).</span>}
        {finish && scan?.id && detected?.id && !fits && <span className="small muted">This printing has no {FINISH_LABEL[finish]} version: pick the right printing.</span>}
        <ErrorNotice error={error} />
        {!scan?.id && <div className="notice warn"><div className="grow">This scan was not staged. Pick the right printing to stage it and record the truth.</div></div>}
        <div className="row">
          {scan?.id && detected?.id && <button type="button" className="btn primary" disabled={busy || !fits} onClick={() => confirm(detected.id)}><Icon.check /> Correct</button>}
          <button type="button" className="btn" disabled={busy || !finish} onClick={() => onPickNeeded(finish)}>Wrong: pick the printing</button>
        </div>
        <div className="row">
          {scan?.id && onDiscard && <button type="button" className="btn danger" disabled={busy} onClick={() => onDiscard(scan)}><Icon.trash /> Not a card / discard</button>}
          <button type="button" className="btn ghost" onClick={onClose} title="Keep the scan unconfirmed">Later</button>
        </div>
        <p className="small muted" style={{ margin: 0 }}>Pick the exact printing <b>in the language printed on the card</b>. The scores and OCR output of this scan are kept to tune the scanner thresholds.</p>
      </div>
    </Sheet>
  );
}
