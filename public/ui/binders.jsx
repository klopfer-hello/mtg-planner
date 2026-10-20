"use strict";

// ===========================================================================
// Binders: filter bar, create / manage, move copies (collection tab, card sheet)
// ===========================================================================

const UNSORTED = "Unsorted";
const sameName = (a, b) => a != null && b != null && String(a).toLowerCase() === String(b).toLowerCase();

/** GET /api/binders → {binders, unsorted, master}; reloads with dataVersion. */
const binderListOf = (d) => ({ binders: d.binders.filter((b) => b.name), unsorted: d.unsorted, master: d.collection_master });
function useBinderList(dataVersion = 0) {
  const { data, error, reload } = useApi("/api/binders", [dataVersion], { map: binderListOf });
  return { data, error, reload };
}

/**
 * Moves and edits that touch ManaBox copies need the user's one-time OK (the server
 * answers 409 {code:'confirm_master'}). guarded(run) calls run(false), asks on
 * that 409, then calls run(true); it resolves null when the user cancels.
 * Deletes answer 409 {code:'manabox_rows'} while ManaBox is the master: the same
 * question; the retry's confirm_master flips the master to the app on the server
 * (imports then leave the deleted copies out, see lib/editlog.js deleteMoves).
 */
function useMasterConfirm() {
  const [ask, setAsk] = useState(null); // {copies, resolve}
  const guarded = useCallback(async (run) => {
    try {
      return await run(false);
    } catch (e) {
      const code = e instanceof ApiError && e.status === 409 ? e.data?.code : null;
      if (code !== "confirm_master" && code !== "manabox_rows") throw e;
      const ok = await new Promise((resolve) => setAsk({ copies: e.data.manabox_copies ?? e.data.copies, resolve }));
      setAsk(null);
      return ok ? run(true) : null;
    }
  }, []);
  const dialog = ask ? <MasterConfirmSheet copies={ask.copies} onAnswer={ask.resolve} /> : null;
  return [guarded, dialog];
}

function MasterConfirmSheet({ copies, onAnswer }) {
  return (
    <Sheet title="Organise ManaBox cards here?" onClose={() => onAnswer(false)}>
      <div className="stack">
        <p style={{ margin: 0 }}>This changes {copies ? plural(copies, "copy", "copies") : "cards"} imported from ManaBox. From now on <b>mtg-planner is the master of your collection</b>:</p>
        <ul className="small" style={{ margin: 0, paddingLeft: 20, display: "grid", gap: 4 }}>
          <li>Cards you move here stay where you put them. A ManaBox import can't move them back.</li>
          <li>ManaBox imports only <b>add new copies</b> (compared with the last export) instead of replacing the collection.</li>
          <li>A full replace stays possible in <b>Settings → Import</b>, behind a warning. You can switch back in <b>Settings → Collection</b>.</li>
        </ul>
        <p className="small muted" style={{ margin: 0 }}>You are only asked once.</p>
        <div className="row">
          <button type="button" className="btn primary grow" onClick={() => onAnswer(true)}><Icon.check /> Yes, organise here</button>
          <button type="button" className="btn ghost" onClick={() => onAnswer(false)}>Cancel</button>
        </div>
      </div>
    </Sheet>
  );
}

/** localStorage: lower-cased binder names whose "Looks like the box of <deck>?" was answered No. */
const BOX_SUGGEST_KEY = "mtg.box.suggestNo";
// Binder types (GET /api/binders type / type_auto / type_set / type_suggest): [key, one, group heading].
const BINDER_TYPES = [["binder", "Binder", "Binders"], ["deck_box", "Deck box", "Deck boxes"], ["bulk", "Bulk", "Bulk"], ["trade", "Trade", "Trade"], ["other", "Other", "Other"]];
const binderTypeLabel = (t) => BINDER_TYPES.find(([k]) => k === t)?.[1] ?? "Binder";
const copiesValue = (copies, eur) => `${plural(copies ?? 0, "copy", "copies")}${copies ? ` · ${fmtEur(eur)}` : ""}`;

/** Cover thumbnail of a binder entry: the chosen or most valuable card, else an icon. */
function BinderCover({ cover, icon = <Icon.collection /> }) {
  const small = cover?.image_small || cover?.image;
  return (
    <span className="cover" aria-hidden="true">
      {small
        ? <img src={small} srcSet={cover.image && cover.image !== small ? `${small} 146w, ${cover.image} 488w` : undefined}
            sizes="(min-width: 768px) 240px, 40px" alt="" loading="lazy" decoding="async" width="146" height="204" />
        : <span className="ph">{icon}</span>}
    </span>
  );
}

function BinderEntry({ name, label = name, cover, copies, value, badge = null, locked = false, favorite = false, dashed = false, icon, sub = null, onClick }) {
  const line = sub ?? copiesValue(copies, value);
  return (
    <button type="button" className={`binder-entry${dashed ? " dashed" : ""}`} onClick={onClick}
      aria-label={`${label}${favorite ? ", favourite" : ""}${locked ? ", locked" : ""}, ${line}`}>
      <BinderCover cover={cover} icon={icon} />
      <span className="info" aria-hidden="true">
        <span className="nm"><span className="t">{favorite && <span className="fav-star">★ </span>}{label}</span>{badge}</span>
        <span className="sub">{line}</span>
      </span>
      <span className="go" aria-hidden="true"><Icon.back /></span>
    </button>
  );
}

/**
 * Collection tab start page: All cards, Unsorted (when it holds copies) and one entry per
 * binder (cover, copies · value), grouped by type. Phones: a compact list; desktop: tiles.
 */
const SET_SORTS = [["new", "Newest"], ["pct", "Most complete"], ["name", "Name"], ["cost", "Cheapest to finish"]];
const RARITY_LETTER = { common: "C", uncommon: "U", rare: "R", mythic: "M", special: "S", bonus: "B" };

/** Binders → Sets: every set you own cards of, how complete it is and what the rest would cost (GET /api/sets). */
// Last /api/sets answer per "all" switch (the count takes ~1 s on the server): Back shows it at once, a fresh one replaces it.
const setsCache = new Map();
function SetsView({ dataVersion, onOpen, onBack }) {
  const [all, setAll] = useState(false);
  const key = all ? 1 : 0;
  const { data: fresh, error, reload } = useApi(`/api/sets${all ? "?all=1" : ""}`, [dataVersion], { map: (d) => ({ key, sets: d }) });
  useEffect(() => { if (fresh) setsCache.set(fresh.key, fresh.sets); }, [fresh]);
  const data = (fresh?.key === key ? fresh.sets : setsCache.get(key) ?? fresh?.sets) ?? null;
  const [q, setQ] = useState("");
  const [sort, setSort] = useState(() => String(store.get("mtg.sets.sort", "new")));
  useEffect(() => { store.set("mtg.sets.sort", sort); }, [sort]);
  const needle = q.trim().toLowerCase();
  const sets = asList(data?.sets).filter((x) => !needle || x.name.toLowerCase().includes(needle) || x.code === needle);
  const sorted = [...sets].sort(sort === "pct" ? (a, b) => b.pct - a.pct || b.owned - a.owned
    : sort === "name" ? (a, b) => a.name.localeCompare(b.name)
    : sort === "cost" ? (a, b) => (a.missing_eur - b.missing_eur) || b.pct - a.pct
    : () => 0);
  return (
    <div className="stack-lg">
      <div>
        <button type="button" className="btn ghost" onClick={onBack} style={{ marginLeft: -8 }}><Icon.back /> Binders</button>
      </div>
      <div className="row between">
        <h2>Sets</h2>
        <ShareButton title="Sets" hash="#collection/sets" />
      </div>
      <p className="small muted" style={{ margin: 0 }}>How many different cards of each set you own, in any printing or language of that set. Tokens and art cards don't count.</p>
      <div className="row" style={{ gap: 8 }}>
        <div className="search grow" style={{ flexBasis: 180 }}>
          <Icon.search />
          <input className="input" type="search" placeholder="Find a set…" aria-label="Find a set" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
        <label className="sr-only" htmlFor="sets-sort">Sort sets</label>
        <select id="sets-sort" className="select" style={{ width: "auto" }} value={sort} onChange={(e) => setSort(e.target.value)}>
          {SET_SORTS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
        </select>
      </div>
      {error && <ErrorNotice error={`Could not load the sets: ${error}`} onRetry={reload} />}
      {!data && !error && <Spinner label="Counting your sets…" />}
      {data && !sorted.length && <div className="empty"><h3>{needle ? "No set matches" : "No sets yet"}</h3></div>}
      {sorted.length > 0 && (
        <div className="set-list">
          {sorted.map((x) => (
            <button key={x.code} type="button" className="set-row" onClick={() => onOpen({ view: "set", code: x.code })}
              aria-label={`${x.name}: ${x.owned} of ${x.cards} cards`}>
              <span className="nm">{x.name}</span>
              <span className="pct">{x.owned}/{x.cards}</span>
              <span className={`set-bar${x.owned === x.cards ? " done" : ""}`} aria-hidden="true"><span style={{ width: `${Math.min(100, x.pct)}%` }} /></span>
              <span className="sub">{x.code.toUpperCase()}{x.released_at ? ` · ${x.released_at.slice(0, 4)}` : ""} · {x.pct}%{x.missing ? ` · ~${fmtEur(x.missing_eur)} to complete${x.unpriced ? ` (+${x.unpriced} unpriced)` : ""}` : " · complete ✓"}</span>
            </button>
          ))}
        </div>
      )}
      {data?.hidden > 0 && !all && (
        <button type="button" className="btn ghost" style={{ justifySelf: "start" }} onClick={() => setAll(true)}>Show {plural(data.hidden, "special set")} too</button>
      )}
    </div>
  );
}

/** One set's checklist (GET /api/sets/:code): owned cards open the card sheet, missing ones show a peek with ♡ / Add to deck. */
function SetView({ code, dataVersion, onBack, onOpenCard, onChanged }) {
  const { data, error } = useApi(`/api/sets/${encodeURIComponent(code)}`, [dataVersion],
    { error: (e) => (e.status === 404 ? "This set is not in the card index." : e.message) });
  const [filter, setFilter] = useState(() => String(store.get("mtg.set.filter", "all")));
  const [peek, setPeek] = useState(null); // oracle_id
  const [sheet, setSheet] = useState(null); // {kind: wish|deck, card}
  const [note, setNote] = useState(null);
  useEffect(() => { store.set("mtg.set.filter", filter); }, [filter]);
  const back = <div><button type="button" className="btn ghost" onClick={onBack} style={{ marginLeft: -8 }}><Icon.back /> Sets</button></div>;
  if (error) return <div className="stack-lg">{back}<ErrorNotice error={error} /></div>;
  if (!data) return <div className="stack-lg">{back}<Spinner /></div>;
  const t = data.totals;
  const cards = data.cards.filter((c) => (filter === "missing" ? !c.owned : filter === "owned" ? c.owned > 0 : true));
  const asCard = (c) => ({ scryfall_id: c.id, oracle_id: c.oracle_id, name: c.name, set_code: data.set.code, collector_number: c.collector_number });
  return (
    <div className="stack-lg">
      {back}
      <div className="row between" style={{ alignItems: "flex-start" }}>
        <div className="grow" style={{ minWidth: 0 }}>
          <h2 style={{ overflowWrap: "anywhere" }}>{data.set.name}</h2>
          <span className="small muted">{data.set.code.toUpperCase()}{data.set.released_at ? ` · ${data.set.released_at.slice(0, 4)}` : ""}</span>
        </div>
        <ShareButton title={data.set.name} hash={`#collection/set/${data.set.code}`} />
      </div>
      <div className="card stack set-sum" style={{ gap: 8 }}>
        <div className="row between"><b>{t.owned} of {t.cards} cards</b><span className="pct">{t.pct}%</span></div>
        <div className={`set-bar${t.owned === t.cards ? " done" : ""}`} aria-hidden="true"><span style={{ width: `${Math.min(100, t.pct)}%` }} /></div>
        <span className="small muted">{t.missing
          ? `${plural(t.missing, "card")} missing · ~${fmtEur(t.missing_eur)} to complete (cheapest printings)${t.unpriced ? ` · ${t.unpriced} without a price` : ""}`
          : "Complete ✓"}</span>
      </div>
      <div className="segmented" role="group" aria-label="Show">
        {[["all", `All ${t.cards}`], ["missing", `Missing ${t.missing}`], ["owned", `Owned ${t.owned}`]].map(([k, l]) => (
          <button key={k} type="button" aria-pressed={filter === k} onClick={() => setFilter(k)}>{l}</button>
        ))}
      </div>
      {note && <div className="notice ok" role="status"><div className="grow">{note}</div><button type="button" className="btn ghost icon sm" aria-label="Dismiss" onClick={() => setNote(null)}><Icon.close /></button></div>}
      {cards.length === 0 ? <div className="empty"><h3>{filter === "missing" ? "Nothing missing" : "No cards here"}</h3></div> : (
        <div className="set-list">
          {cards.map((c) => {
            const have = c.owned > 0;
            const open = peek === c.oracle_id;
            return (
              <React.Fragment key={c.oracle_id}>
                <button type="button" className={`set-card${have ? "" : " missing"}`} aria-expanded={have ? undefined : open}
                  onClick={() => (have ? onOpenCard(c.owned_id) : setPeek(open ? null : c.oracle_id))}>
                  <span className="cn">{c.collector_number}</span>
                  <span className="nm"><b>{c.name}</b>{c.rarity && <span className="badge" title={c.rarity}>{RARITY_LETTER[c.rarity] || c.rarity[0].toUpperCase()}</span>}
                    {have && c.langs.filter((l) => l !== "en").map((l) => <LangTag key={l} lang={l} />)}</span>
                  <span className="end">{have ? <span className="badge ok">✓ {c.owned}</span> : <span className="muted">{c.eur != null ? fmtEur(c.eur) : "—"}</span>}</span>
                  {!have && c.elsewhere > 0 && <span className="note">You own {c.elsewhere} from other sets</span>}
                </button>
                {open && (
                  <div className="set-peek">
                    {c.image_small ? <img src={c.image_small} alt={c.name} loading="lazy" /> : <span />}
                    <div className="stack small" style={{ gap: 8, alignContent: "start" }}>
                      <span>#{c.collector_number}{c.printings > 1 ? ` · ${c.printings} printings in this set` : ""}</span>
                      <span className="muted">{c.eur != null ? `From ${fmtEur(c.eur)}` : "No € price"}{c.elsewhere > 0 ? ` · you own ${c.elsewhere} from other sets` : ""}</span>
                      <div className="row" style={{ gap: 6 }}>
                        <button type="button" className="btn sm" onClick={() => setSheet({ kind: "wish", card: asCard(c) })}><Icon.heart /> Wishlist</button>
                        <button type="button" className="btn sm" onClick={() => setSheet({ kind: "deck", card: asCard(c) })}><Icon.plus /> Add to deck</button>
                      </div>
                    </div>
                  </div>
                )}
              </React.Fragment>
            );
          })}
        </div>
      )}
      {sheet?.kind === "wish" && <WishSheet card={sheet.card} onClose={() => setSheet(null)}
        onDone={(res) => { setSheet(null); setNote(res?.merged ? `On your wishlist: ${res.item.quantity} wanted` : `${sheet.card.name} added to your wishlist`); }} />}
      {sheet?.kind === "deck" && <AddToDeckSheet card={sheet.card} onClose={() => setSheet(null)}
        onDone={(res, deck) => { setSheet(null); setNote(`${sheet.card.name} added to ${deck.name}`); onChanged?.(); }} />}
    </div>
  );
}

function BinderOverview({ list, onOpen, onGoImport, onGoScan, onChanged }) {
  const { data, error, reload } = list;
  const [sheet, setSheet] = useState(null); // "new" | "manage"
  const [showToast, toastEl] = useEditToast(() => { reload(); onChanged?.(); });
  // Search: which binders hold matching cards (GET /api/binders/search); the cards themselves show
  // only after opening a binder, which gets the same search (#collection/binder/<n>?q=).
  const [q, setQ] = useState(() => String(store.get("mtg.binders.q", "") || ""));
  const [favOnly, setFavOnly] = useState(() => store.get("mtg.binders.fav", false) === true);
  useEffect(() => { store.set("mtg.binders.q", q); }, [q]);
  useEffect(() => { store.set("mtg.binders.fav", favOnly); }, [favOnly]);
  const dq = useDebounced(q.trim(), 300);
  const [found, setFound] = useState(null); // {q, cards, binders} | {q, error}
  const searchId = useRef(0);
  useEffect(() => {
    if (!dq) { setFound(null); return; }
    const id = ++searchId.current;
    api(`/api/binders/search?q=${encodeURIComponent(dq)}`)
      .then((r) => { if (id === searchId.current) setFound(r); })
      .catch((e) => { if (id === searchId.current) setFound({ q: dq, error: e.status === 400 ? `Search error: ${e.message}` : e.message }); });
  }, [dq, data]);
  const tokens = tokenize(q);
  const hasToken = (term) => tokens.some((t) => t.toLowerCase() === term.toLowerCase());
  const toggleTerm = (term) => setQ(hasToken(term) ? tokens.filter((t) => t.toLowerCase() !== term.toLowerCase()).join(" ") : appendTerm(q, term));
  // A cleared field stops filtering at once (the debounced value lags 300 ms).
  const searching = Boolean(dq) && Boolean(q.trim());
  const ready = !searching || (found && found.q === dq);
  const hits = new Map(ready && searching && !found?.error ? asList(found?.binders).map((b) => [b.name.toLowerCase(), b]) : []);
  const allBinders = data?.binders || [];
  const binders = allBinders.filter((b) => (!favOnly || b.favorite) && (!searching || hits.has(b.name.toLowerCase())));
  const unsortedAll = data?.unsorted;
  const unsorted = favOnly ? null : searching ? (hits.has("") ? unsortedAll : null) : unsortedAll;
  const totalCopies = allBinders.reduce((a, b) => a + (b.copies || 0), 0) + (unsortedAll?.copies || 0);
  const totalValue = allBinders.reduce((a, b) => a + (b.value_eur || 0), 0) + (unsortedAll?.value_eur || 0);
  const best = [...allBinders, unsortedAll].filter(Boolean).map((b) => b.top).filter(Boolean).sort((a, b) => b.price_eur - a.price_eur)[0];
  const groups = BINDER_TYPES.map(([t, , heading]) => [t, heading, binders.filter((b) => (b.type || "binder") === t)]).filter(([, , l]) => l.length);
  const changed = () => { reload(); onChanged?.(); };
  const hitLine = (name) => { const h = hits.get(String(name).toLowerCase()); return h ? `${plural(h.cards, "card")} match · ${plural(h.copies, "copy", "copies")}` : null; };
  const withQ = (r) => (searching ? { ...r, q: dq } : r);
  const favCount = allBinders.filter((b) => b.favorite).length;
  const filtered = searching || favOnly;
  const hasCards = data && (totalCopies > 0 || allBinders.length > 0);
  return (
    <div className="stack-lg">
      <div className="row between">
        <h2>Binders</h2>
        <div className="row" style={{ gap: 6 }}>
          <button type="button" className="btn" onClick={() => onOpen({ view: "sets" })} disabled={!hasCards}><Icon.grid /> Sets</button>
          <button type="button" className="btn" onClick={() => setSheet("new")}><Icon.plus /> New binder</button>
          <button type="button" className="btn ghost" onClick={() => setSheet("manage")} disabled={!data || !binders.length}><Icon.edit /> Manage</button>
        </div>
      </div>
      {error && <ErrorNotice error={`Could not load binders: ${error}`} onRetry={reload} />}
      {!data && !error && <Spinner />}
      {hasCards && (
        <div className="stack">
          <form className="search" role="search" onSubmit={(e) => { e.preventDefault(); e.currentTarget.querySelector("input")?.blur(); }}>
            <Icon.search />
            <label htmlFor="binders-q" className="sr-only">Find binders by the cards they hold</label>
            <input id="binders-q" className="input" type="search" inputMode="search" enterKeyHint="search"
              autoComplete="off" autoCorrect="off" autoCapitalize="off" spellCheck="false"
              placeholder="Find binders with… e.g. sol ring, t:dragon c:r" value={q} onChange={(e) => setQ(e.target.value)} />
            {q && <button type="button" className="btn ghost icon clear" aria-label="Clear search" onClick={() => setQ("")}><Icon.close /></button>}
          </form>
          <div className="chips" role="group" aria-label="Filter binders">
            <button type="button" className="chip" aria-pressed={favOnly} onClick={() => setFavOnly(!favOnly)}>★ Favourites{favCount ? <span className="cnt"> {favCount}</span> : null}</button>
            {COLOUR_CHIPS.map(([c, label, term]) => (
              <button key={c} type="button" className="chip sym-chip" aria-pressed={hasToken(term)} aria-label={`${label} cards`} title={`${label} cards (${term})`}
                onClick={() => toggleTerm(term)}><img className="sym" src={symbolUrl(c)} alt="" /></button>
            ))}
          </div>
          <QueryHelp />
          {filtered && (
            <div className="filter-summary small" aria-live="polite">
              <span className="muted">
                {searching && !ready && "Searching…"}
                {searching && ready && found?.error && <span style={{ color: "var(--bad)" }}>{found.error}</span>}
                {ready && !found?.error && (searching
                  ? `${plural(found?.cards ?? 0, "card")} in ${plural(binders.length + (unsorted ? 1 : 0), "binder")}`
                  : `${plural(binders.length, "favourite binder")}`)}
              </span>
              <button type="button" className="btn ghost sm" onClick={() => { setQ(""); setFavOnly(false); }}>Clear filters</button>
            </div>
          )}
          {ready && filtered && !found?.error && binders.length === 0 && !unsorted && (
            <p className="small muted" style={{ margin: 0 }}>{favOnly && !favCount
              ? <>No favourite binders yet. Open a binder and tap <b>☆</b>.</>
              : searching ? <>No {favOnly ? "favourite " : ""}binder holds cards matching <code>{dq}</code>.</> : "No binders match."}</p>
          )}
        </div>
      )}
      {data && totalCopies === 0 && !allBinders.length && (
        <div className="empty card">
          <h3>Your collection is empty</h3>
          <p style={{ margin: 0 }}>Scan your cards with the camera, or export your collection from ManaBox as CSV and import it here.</p>
          <div className="row" style={{ justifyContent: "center" }}>
            <button type="button" className="btn primary" onClick={onGoScan}><Icon.scan /> Scan cards</button>
            <button type="button" className="btn" onClick={onGoImport}><Icon.import /> Import from ManaBox</button>
          </div>
        </div>
      )}
      {hasCards && (
        <div className="binder-grid top">
          <BinderEntry name="All cards" cover={best ? { ...best, image: best.image_normal, image_small: best.image_small } : null}
            icon={<Icon.search />} copies={totalCopies} value={totalValue}
            sub={searching && ready && !found?.error ? `${plural(found?.cards ?? 0, "card")} match` : null}
            onClick={() => onOpen(withQ({ view: "all" }))} />
          {unsorted?.copies > 0 && (
            <BinderEntry name={UNSORTED} cover={unsorted.cover} copies={unsorted.copies} value={unsorted.value_eur} dashed
              sub={searching ? hitLine("") : null} onClick={() => onOpen(withQ({ view: "binder", binder: "" }))} />
          )}
        </div>
      )}
      {groups.map(([t, heading, items]) => (
        <section key={t} className="stack" style={{ gap: 8 }} aria-label={heading}>
          <h3 className="binder-group-h">{heading} <span className="muted">{items.length}</span></h3>
          <div className="binder-grid">
            {items.map((b) => (
              <BinderEntry key={b.name} name={b.name} cover={b.cover} copies={b.copies} value={b.value_eur} locked={Boolean(b.locked)}
                favorite={Boolean(b.favorite)} sub={searching ? hitLine(b.name) : null}
                badge={<>
                  {b.locked && <span className="badge lock" role="img" aria-label="Locked" title="Locked: these cards are kept for their own deck">🔒</span>}
                  {b.type_suggest === "bulk" && <span className="badge warn">bulk?</span>}
                </>}
                onClick={() => onOpen(withQ({ view: "binder", binder: b.name }))} />
            ))}
          </div>
        </section>
      ))}
      {data && allBinders.length === 0 && totalCopies > 0 && (
        <p className="small muted" style={{ margin: 0 }}>No binders yet. Create one, open <b>All cards</b>, tap <b>Select</b> and move cards into it.</p>
      )}
      {sheet === "new" && (
        <NewBinderSheet onClose={() => setSheet(null)} onCreated={(name) => {
          setSheet(null);
          showToast({ text: `Created “${name}”. Open All cards and tap Select to move cards into it.` });
          changed();
        }} />
      )}
      {sheet === "manage" && <ManageBindersSheet data={data} onClose={() => setSheet(null)} onChanged={changed} />}
      {toastEl}
    </div>
  );
}

/**
 * Binder detail header: back, a binder switcher (select) as the title, type · copies · value,
 * the decks it holds, the ⋯ menu, and the one-time "Looks like bulk?" question.
 */
function BinderHeader({ binder, entry, list, onBack, onOpen, onOpenDeck, onMenu, onChanged }) {
  const all = binder == null;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [toast, toastEl] = useEditToast(null);
  const locked = Boolean(entry?.locked);
  const toggleLock = async () => {
    setBusy(true); setError(null);
    try {
      await api(`/api/binders/${encodeURIComponent(binder)}`, { method: "PATCH", json: { locked: !locked } });
      toast({ text: locked ? "Unlocked" : "Locked: these cards won’t be used for other decks" });
      onChanged();
    } catch (e) { setError(e.message); } finally { setBusy(false); }
  };
  const value = all ? "*all" : binder === "" ? "*unsorted" : binder;
  const binders = list?.binders || [];
  const switchTo = (v) => onOpen(v === "*all" ? { view: "all" } : { view: "binder", binder: v === "*unsorted" ? "" : v }, { replace: true });
  const patchBinder = async (json) => {
    setBusy(true); setError(null);
    try { await api(`/api/binders/${encodeURIComponent(binder)}`, { method: "PATCH", json }); onChanged(); } catch (e) { setError(e.message); } finally { setBusy(false); }
  };
  const setType = (type) => patchBinder({ type });
  const decks = asList(entry?.decks);
  // "Looks like the box of <deck>?" is asked once per binder (No = never again on this device).
  const [noSuggest, setNoSuggest] = useState(() => asList(store.get(BOX_SUGGEST_KEY, [])));
  const suggest = binder && entry?.deck_suggest && !noSuggest.includes(String(binder).toLowerCase()) ? entry.deck_suggest : null;
  const dismissSuggest = () => {
    const next = [...noSuggest, String(binder).toLowerCase()].slice(-200);
    store.set(BOX_SUGGEST_KEY, next);
    setNoSuggest(next);
  };
  return (
    <div className="stack" style={{ gap: 8 }}>
      <div className="binder-head">
        <button type="button" className="btn ghost icon" aria-label="Back to binders" onClick={onBack}><Icon.back /></button>
        <div className="grow binder-title">
          <label htmlFor="binder-switch" className="sr-only">Show binder</label>
          {/* The select is invisible on top of the title: a native select is as wide as its longest option. */}
          <span className="switch">
            <span className="t" aria-hidden="true">{all ? "All cards" : binder || UNSORTED}</span>
            <span className="caret" aria-hidden="true">▾</span>
          <select id="binder-switch" value={value} onChange={(e) => switchTo(e.target.value)}>
            <option value="*all">All cards</option>
            {binders.map((b) => <option key={b.name} value={b.name}>{b.name}</option>)}
            {(list?.unsorted?.copies > 0 || binder === "") && <option value="*unsorted">{UNSORTED}</option>}
          </select>
          </span>
          <span className="small muted">{all ? "Every copy you own" : binder ? binderTypeLabel(entry?.type) : "Copies without a binder"}</span>
        </div>
        <ShareButton title={all ? "All cards" : binder || UNSORTED} hash={collectionHash(all ? { view: "all" } : { view: "binder", binder })} />
        {binder && entry && (
          <FavButton on={Boolean(entry.favorite)} busy={busy} label={binder} onToggle={() => patchBinder({ favorite: !entry.favorite })} />
        )}
        {binder && entry && (
          <button type="button" className="btn ghost icon lock-btn" aria-pressed={locked} disabled={busy}
            aria-label={locked ? `${binder} is locked. Unlock` : `Lock ${binder}`}
            title={locked ? "Locked: only its own deck uses these cards. Tap to unlock" : "Lock: keep these cards out of other decks"}
            onClick={toggleLock}>{locked ? <Icon.lock /> : <Icon.unlock />}</button>
        )}
        {binder && <button type="button" className="btn ghost icon" aria-label={`Options for ${binder}`} title="Rename, type, cover, delete" onClick={onMenu}><Icon.more /></button>}
      </div>
      {decks.length > 0 && onOpenDeck && !entry?.box_deck && (
        <p className="small muted" style={{ margin: 0 }}>Holds {decks.map((d, i) => (
          <React.Fragment key={d.id}>{i ? ", " : ""}<button type="button" className="link-btn" onClick={() => onOpenDeck(d.id)}>{d.name}</button></React.Fragment>
        ))}</p>
      )}
      {binder && locked && (
        <p className="small muted" style={{ margin: 0 }}>🔒 {entry.box_deck
          ? <>Locked for {onOpenDeck ? <button type="button" className="link-btn" onClick={() => onOpenDeck(entry.box_deck.id)}>{entry.box_deck.name}</button> : <b>{entry.box_deck.name}</b>}: other decks don’t use these cards.</>
          : <>Locked: no deck uses these cards. {entry.type === "deck_box" ? <>Link its deck in <b>⋯</b>.</> : null}</>}</p>
      )}
      {suggest && (
        <div className="notice box-ask" role="status">
          <span className="grow">Looks like the box of <b>{suggest.name}</b>?</span>
          <span className="row" style={{ gap: 6 }}>
            <button type="button" className="btn sm" disabled={busy} onClick={() => patchBinder({ deck_id: suggest.id })}>Link</button>
            <button type="button" className="btn ghost sm" disabled={busy} onClick={dismissSuggest}>No</button>
          </span>
        </div>
      )}
      {binder && entry?.type_suggest === "bulk" && (
        <div className="notice bulk-ask" role="status">
          <span className="grow">Looks like bulk ({plural(entry.copies, "copy", "copies")}). Mark it as <b>Bulk</b>?</span>
          <span className="row" style={{ gap: 6 }}>
            <button type="button" className="btn sm" disabled={busy} onClick={() => setType("bulk")}>Yes, Bulk</button>
            <button type="button" className="btn ghost sm" disabled={busy} onClick={() => setType("binder")}>No, keep as binder</button>
          </span>
        </div>
      )}
      <ErrorNotice error={error} onDismiss={() => setError(null)} />
      {toastEl}
    </div>
  );
}

/**
 * The binder's ⋯ menu: type, cover, rename (merge), delete. Same server calls and
 * MasterConfirmSheet flows as ManageBindersSheet.
 */
function BinderMenuSheet({ entry, list, onClose, onChanged, onRenamed, onDeleted }) {
  const [guarded, masterDialog] = useMasterConfirm();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [name, setName] = useState(entry.name);
  const [picking, setPicking] = useState(false);
  const [deleting, setDeleting] = useState(null); // "unsort" | "delete"
  const locked = Boolean(entry.locked);
  const isBox = entry.type === "deck_box" || locked;
  const { data: decks, error: decksError } = useApi(isBox ? "/api/decks" : null, [], { error: (e) => `Could not load decks: ${e.message}` });
  const url = `/api/binders/${encodeURIComponent(entry.name)}`;
  const run = async (fn) => {
    setBusy(true); setError(null);
    try { return await fn(); } catch (e) { setError(e.message); return null; } finally { setBusy(false); }
  };
  const patch = (json) => run(async () => { const r = await api(url, { method: "PATCH", json }); onChanged(); return r; });
  const rename = (e) => {
    e.preventDefault();
    const to = name.trim();
    if (!to || to === entry.name) return;
    const exists = (list?.binders || []).find((b) => sameName(b.name, to) && !sameName(b.name, entry.name));
    if (exists && !window.confirm(`“${exists.name}” already exists. Merge “${entry.name}” into it?`)) return;
    run(async () => {
      const r = await guarded((confirm) => api(url, { method: "PATCH", json: { name: to, confirm_master: confirm } }));
      if (r) onRenamed(r.name || to);
    });
  };
  const remove = (cards) => run(async () => {
    const r = await guarded((confirm) => api(`${url}?cards=${cards}${confirm ? "&confirm_master=1" : ""}`, { method: "DELETE" }));
    if (r) onDeleted(r.edit_id != null ? `Deleted “${entry.name}” and ${plural(r.deleted_copies ?? 0, "copy", "copies")}` : `Deleted “${entry.name}”`, r.edit_id ?? null);
  });
  return (
    <Sheet title={entry.name} onClose={onClose}>
      <div className="stack-lg">
        {error && <ErrorNotice error={error} onDismiss={() => setError(null)} />}
        {decksError && <ErrorNotice error={decksError} />}
        <fieldset className="stack" style={{ border: 0, padding: 0, margin: 0, minWidth: 0, gap: 8 }}>
          <legend className="label" style={{ marginBottom: 8 }}>Type</legend>
          <div className="chips" role="group" aria-label="Binder type">
            {BINDER_TYPES.map(([t, label]) => (
              <button key={t} type="button" className="chip lg" aria-pressed={entry.type === t} disabled={busy}
                onClick={() => patch({ type: t })}>{label}</button>
            ))}
          </div>
          <span className="small muted">{entry.type_set
            ? <>You picked this type. <button type="button" className="link-btn" disabled={busy} onClick={() => patch({ type: null })}>Back to automatic ({binderTypeLabel(entry.type_auto)})</button></>
            : "Set automatically (deck boxes are found by name and by their deck)."}</span>
        </fieldset>

        <fieldset className="stack" style={{ border: 0, padding: 0, margin: 0, minWidth: 0, gap: 8 }}>
          <legend className="label" style={{ marginBottom: 8 }}>Lock</legend>
          <div className="chips" role="group" aria-label="Lock or unlock">
            <button type="button" className="chip lg" aria-pressed={locked} disabled={busy} onClick={() => patch({ locked: true })}><Icon.lock /> Locked</button>
            <button type="button" className="chip lg" aria-pressed={!locked} disabled={busy} onClick={() => patch({ locked: false })}><Icon.unlock /> Unlocked</button>
          </div>
          <span className="small muted">{locked ? "Locked: only its own deck uses these cards; other decks see them as in use." : "Unlocked: any deck can use these cards."}
            {" "}{entry.locked_set
              ? <button type="button" className="link-btn" disabled={busy} onClick={() => patch({ locked: null })}>Back to automatic ({entry.locked_auto ? "locked" : "unlocked"})</button>
              : "Set automatically (deck boxes are locked)."}</span>
        </fieldset>

        {isBox && (
          <div className="stack" style={{ gap: 8 }}>
            <label className="label" htmlFor="binder-deck">Belongs to deck</label>
            <select id="binder-deck" className="input" style={{ fontSize: 16, maxWidth: "100%" }} disabled={busy || !decks}
              value={entry.box_deck?.id ?? ""}
              onChange={(e) => patch({ deck_id: e.target.value === "" ? null : Number(e.target.value) })}>
              <option value="">{decks ? "None" : "Loading decks…"}</option>
              {(decks || []).slice().sort((a, b) => a.name.localeCompare(b.name)).map((d) => (
                <option key={d.id} value={d.id}>{d.name}{d.status === "built" ? " (built)" : ""}</option>
              ))}
            </select>
            <span className="small muted">{entry.box_deck
              ? <>{locked ? <>The cards here are free for <b>{entry.box_deck.name}</b> and in use for every other deck.</> : <>Holds <b>{entry.box_deck.name}</b>. Unlocked: every deck can use the cards.</>}</>
              : locked ? "No deck: the cards here are locked for every deck." : "No deck linked."}
              {entry.box_deck?.via === "name" ? " (Found by its name.)" : entry.box_deck?.via === "manabox" ? " (Its ManaBox deck binder.)" : ""}</span>
          </div>
        )}

        <div className="stack" style={{ gap: 8 }}>
          <span className="label">Cover card</span>
          <div className="row">
            <BinderCover cover={entry.cover} />
            <span className="grow small">{entry.cover ? <><b>{entry.cover.name}</b><br /><span className="muted">{entry.cover.chosen ? "Picked by you" : "Most valuable card (automatic)"}</span></> : <span className="muted">No card yet</span>}</span>
          </div>
          <div className="row">
            <button type="button" className="btn" disabled={busy || !entry.copies} onClick={() => setPicking((p) => !p)} aria-expanded={picking}>{picking ? "Close" : "Choose cover…"}</button>
            {entry.cover?.chosen && <button type="button" className="btn ghost" disabled={busy} onClick={() => patch({ cover_scryfall_id: null })}>Use most valuable</button>}
          </div>
          {picking && <CoverPicker binder={entry.name} current={entry.cover?.scryfall_id} busy={busy}
            onPick={async (id) => { if (await patch({ cover_scryfall_id: id })) setPicking(false); }} />}
        </div>

        <form className="stack" style={{ gap: 8 }} onSubmit={rename}>
          <label className="label" htmlFor="binder-rename">Name</label>
          <div className="row">
            <input id="binder-rename" className="input grow" style={{ flexBasis: 160, fontSize: 16 }} maxLength={100} value={name} onChange={(e) => setName(e.target.value)} />
            <button type="submit" className="btn primary" disabled={busy || !name.trim() || name.trim() === entry.name}>Rename</button>
          </div>
        </form>

        <div className="stack" style={{ gap: 8 }}>
          <span className="label">Export</span>
          <div className="row">
            <a className="btn" href={`/api/collection/export?format=manabox&binder=${encodeURIComponent(entry.name)}`} download><Icon.download /> ManaBox CSV</a>
            <a className="btn" href={`/api/collection/export?format=csv&binder=${encodeURIComponent(entry.name)}`} download><Icon.download /> Spreadsheet CSV</a>
          </div>
        </div>

        <div className="stack" style={{ gap: 8 }}>
          <span className="label">Delete</span>
          {deleting
            ? <BinderDeleteChoice binder={entry} master={list?.master} cards={deleting} busy={busy} onCards={setDeleting}
                onDelete={() => remove(deleting)} onCancel={() => setDeleting(null)} />
            : <button type="button" className="btn danger" style={{ justifySelf: "start" }} onClick={() => setDeleting("unsort")}><Icon.trash /> Delete binder…</button>}
        </div>
      </div>
      {masterDialog}
    </Sheet>
  );
}

/** Pick a binder's cover among its printings (most valuable first, searchable). */
function CoverPicker({ binder, current, busy, onPick }) {
  const [q, setQ] = useState("");
  const dq = useDebounced(q.trim(), 300);
  const { data: rows, error } = useApi(`/api/collection?${new URLSearchParams({ binder, q: dq, group: "printing", sort: "price", dir: "desc", limit: "24" })}`,
    [], { map: (d) => d.rows });
  return (
    <div className="stack" style={{ gap: 8 }}>
      <input className="input" type="search" style={{ fontSize: 16 }} aria-label="Search cards for the cover" placeholder="Search this binder…" value={q} onChange={(e) => setQ(e.target.value)} />
      <ErrorNotice error={error} />
      {!rows && !error && <Spinner />}
      {rows && !rows.length && <p className="small muted" style={{ margin: 0 }}>No cards found.</p>}
      {rows && rows.length > 0 && (
        <div className="grid cover-grid">
          {rows.map((r) => (
            <button key={r.scryfall_id} type="button" className="tile" disabled={busy} aria-pressed={r.scryfall_id === current}
              aria-label={`Use ${r.name} (${(r.set_code || "").toUpperCase()} #${r.collector_number}) as cover`} onClick={() => onPick(r.scryfall_id)}>
              <div className="img">{r.image_small ? <img src={r.image_small} alt="" loading="lazy" decoding="async" width="146" height="204" /> : <div className="ph">{r.name}</div>}</div>
              <div className="cap" aria-hidden="true"><span className="n">{r.name}</span><span className="p">{fmtPrice(r.price)}</span></div>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/** "Keep the cards" (→ Unsorted) or "Delete the cards too" for deleting one binder. */
function BinderDeleteChoice({ binder, master, cards, busy, onCards, onDelete, onCancel }) {
  const mb = binder.by_source?.manabox?.copies ?? 0;
  const asksMaster = mb > 0 && master !== "app";
  const group = useMemo(() => `del-cards-${Math.random().toString(36).slice(2)}`, []);
  return (
    <div className="stack" style={{ gap: 8 }}>
      <b>Delete “{binder.name}”?</b>
      {binder.copies > 0 ? (
        <div className="stack" style={{ gap: 8 }} role="radiogroup" aria-label="What happens to the cards">
          <label className="radio-card">
            <input type="radio" name={group} checked={cards === "unsort"} onChange={() => onCards("unsort")} />
            <span><b>Keep the cards</b><br /><span className="small muted">Its {plural(binder.copies, "copy", "copies")} move to {UNSORTED}.</span></span>
          </label>
          <label className="radio-card">
            <input type="radio" name={group} checked={cards === "delete"} onChange={() => onCards("delete")} />
            <span><b>Delete the cards too</b><br /><span className="small muted">
              Removes {plural(binder.copies, "copy", "copies")} from your collection (undo in Settings → Collection → Recent changes).
              {asksMaster && ` ${plural(mb, "copy is", "copies are")} from ManaBox: mtg-planner becomes the master of your collection (you'll be asked first).`}
            </span></span>
          </label>
        </div>
      ) : <span className="small muted">The binder is empty.</span>}
      <div className="row">
        <button type="button" className={`btn ${cards === "delete" ? "danger" : "primary"}`} disabled={busy} onClick={onDelete}>
          <Icon.trash /> {cards === "delete" && binder.copies ? `Delete binder and ${plural(binder.copies, "copy", "copies")}` : "Delete binder"}
        </button>
        <button type="button" className="btn ghost" onClick={onCancel}>Cancel</button>
      </div>
    </div>
  );
}

function NewBinderSheet({ onClose, onCreated }) {
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const submit = async (e) => {
    e.preventDefault();
    if (!name.trim() || busy) return;
    setBusy(true); setError(null);
    try {
      const b = await api("/api/binders", { method: "POST", json: { name: name.trim() } });
      onCreated(b?.name || name.trim());
    } catch (err) { setError(err.message); } finally { setBusy(false); }
  };
  return (
    <Sheet title="New binder" onClose={onClose}>
      <form className="stack" onSubmit={submit}>
        <div className="field">
          <label htmlFor="new-binder-name">Name</label>
          <input id="new-binder-name" className="input" style={{ fontSize: 16 }} autoFocus maxLength={100} required placeholder="e.g. Trade binder"
            value={name} onChange={(e) => setName(e.target.value)} />
        </div>
        <ErrorNotice error={error} />
        <button type="submit" className="btn primary" disabled={!name.trim() || busy}>{busy ? "Creating…" : <><Icon.plus /> Create binder</>}</button>
      </form>
    </Sheet>
  );
}

/**
 * Rename, retype and delete binders. Delete asks what happens to the cards (Unsorted or delete).
 * Deleting ManaBox copies while ManaBox is the master asks once (useMasterConfirm on the
 * 409 manabox_rows) and retries with confirm_master=1: mtg-planner becomes the master.
 */
function ManageBindersSheet({ data, onClose, onChanged }) {
  const [guarded, masterDialog] = useMasterConfirm();
  const [toast, toastEl] = useEditToast(onChanged, { portal: true });
  const [editing, setEditing] = useState(null); // {name, value}
  const [deleting, setDeleting] = useState(null); // {binder, cards}
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const list = data?.binders || [];
  const master = data?.master || "manabox";

  const run = async (fn) => {
    setBusy(true); setError(null);
    try { const r = await fn(); if (r) { setEditing(null); setDeleting(null); onChanged(); } } catch (err) { setError(err.message); } finally { setBusy(false); }
  };
  const rename = (e) => {
    e.preventDefault();
    const to = editing.value.trim();
    if (!to || to === editing.name) { setEditing(null); return; }
    const exists = list.find((b) => sameName(b.name, to) && !sameName(b.name, editing.name));
    if (exists && !window.confirm(`“${exists.name}” already exists. Merge “${editing.name}” into it?`)) return;
    run(() => guarded((confirm) => api(`/api/binders/${encodeURIComponent(editing.name)}`, { method: "PATCH", json: { name: to, confirm_master: confirm } })));
  };
  const remove = () => {
    const { binder, cards } = deleting;
    run(async () => {
      const r = await guarded((confirm) => api(`/api/binders/${encodeURIComponent(binder.name)}?cards=${cards}${confirm ? "&confirm_master=1" : ""}`, { method: "DELETE" }));
      if (r?.edit_id != null) toast({ text: `Deleted “${binder.name}” and ${plural(r.deleted_copies ?? 0, "copy", "copies")}`, editId: r.edit_id });
      return r;
    });
  };

  return (
    <Sheet title="Manage binders" onClose={onClose}>
      <div className="stack">
        {error && <ErrorNotice error={error} onDismiss={() => setError(null)} />}
        {list.length === 0 && <p className="muted" style={{ margin: 0 }}>No binders yet.</p>}
        <div>
          {list.map((b) => {
            if (deleting && sameName(deleting.binder.name, b.name)) {
              return (
                <div key={b.name} className="binder-row" style={{ display: "grid" }}>
                  <BinderDeleteChoice binder={b} master={master} cards={deleting.cards} busy={busy}
                    onCards={(cards) => setDeleting({ ...deleting, cards })} onDelete={remove} onCancel={() => setDeleting(null)} />
                </div>
              );
            }
            return (
              <div key={b.name} className="binder-row">
                {editing && sameName(editing.name, b.name) ? (
                  <form className="row grow" onSubmit={rename}>
                    <input className="input grow" style={{ flexBasis: 160, fontSize: 16 }} aria-label={`New name for ${b.name}`} autoFocus maxLength={100}
                      value={editing.value} onChange={(e) => setEditing({ ...editing, value: e.target.value })} />
                    <button type="submit" className="btn primary" disabled={busy || !editing.value.trim()}>Save</button>
                    <button type="button" className="btn ghost" onClick={() => setEditing(null)}>Cancel</button>
                  </form>
                ) : (
                  <>
                    <span className="grow" style={{ minWidth: 0, overflowWrap: "anywhere" }}><b>{b.name}</b><br />
                      <span className="muted small">{b.copies ? `${plural(b.copies, "copy", "copies")} · ${plural(b.unique_cards ?? b.cards ?? 0, "card")}` : "empty"}</span></span>
                    {(b.sources || []).map((s) => <SourceBadge key={s} source={s} />)}
                    <select className="select type-select" aria-label={`Type of ${b.name}`} value={b.type || "binder"} disabled={busy}
                      onChange={(e) => run(() => api(`/api/binders/${encodeURIComponent(b.name)}`, { method: "PATCH", json: { type: e.target.value } }))}>
                      {BINDER_TYPES.map(([t, label]) => <option key={t} value={t}>{label}</option>)}
                    </select>
                    <button type="button" className="btn ghost icon" aria-label={`Rename ${b.name}`} title="Rename" disabled={busy}
                      onClick={() => { setDeleting(null); setEditing({ name: b.name, value: b.name }); }}><Icon.edit /></button>
                    <button type="button" className="btn ghost icon danger" aria-label={`Delete ${b.name}`} title="Delete" disabled={busy}
                      onClick={() => { setEditing(null); setDeleting({ binder: b, cards: "unsort" }); }}><Icon.trash /></button>
                  </>
                )}
              </div>
            );
          })}
        </div>
        <p className="small muted" style={{ margin: 0 }}>
          {master === "app"
            ? "mtg-planner is the master of your collection: binders you organise here win over ManaBox."
            : "Renaming or emptying a binder with ManaBox cards makes mtg-planner the master of your collection (you'll be asked first)."}
        </p>
      </div>
      {masterDialog}
      {toastEl}
    </Sheet>
  );
}

/**
 * Pick a target binder (+ quantity when maxQty is set) and run onMove({quantity,
 * to_binder, create}); onMove resolves false when the user cancelled.
 */
function MoveSheet({ title, intro, maxQty = null, exclude = null, children, submitLabel, onMove, onClose }) {
  const { data, error: listError, reload } = useBinderList();
  const last = store.get("mtg.move.target", null);
  const [qty, setQty] = useState(maxQty ?? 1);
  const [target, setTarget] = useState(null); // binder name | "" (Unsorted) | "__new"
  const [newName, setNewName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const options = data ? [...data.binders.map((b) => ({ name: b.name, copies: b.copies })), { name: "", copies: data.unsorted?.copies ?? 0 }]
    .filter((o) => exclude == null || !sameName(o.name, exclude)) : null;
  useEffect(() => {
    if (!options || target != null) return;
    const pick = last != null && options.find((o) => sameName(o.name, last) || (last === "" && o.name === ""));
    setTarget(pick ? pick.name : (options.find((o) => o.name) ?? options[0])?.name ?? "__new");
  }, [options, target, last]);

  const to = target === "__new" ? newName.trim() : target;
  const ready = target != null && (target !== "__new" || to);
  const submit = async (e) => {
    e.preventDefault();
    if (!ready || busy) return;
    setBusy(true); setError(null);
    try {
      const ok = await onMove({ quantity: qty, to_binder: to, create: target === "__new" });
      if (ok !== false) store.set("mtg.move.target", to);
    } catch (err) { setError(err.message); } finally { setBusy(false); }
  };
  const targetLabel = target === "__new" ? (to ? `new binder “${to}”` : "a new binder") : target === "" ? UNSORTED : target ? `“${target}”` : "…";
  return (
    <Sheet title={title} onClose={onClose}>
      <form className="stack" onSubmit={submit}>
        {intro}
        {maxQty != null && maxQty > 1 && (
          <Stepper big label="Copies to move" value={qty} max={maxQty} onChange={setQty} />
        )}
        {children}
        <fieldset className="stack" style={{ border: 0, padding: 0, margin: 0, minWidth: 0 }}>
          <legend className="label" style={{ marginBottom: 8 }}>Move to</legend>
          {listError && <ErrorNotice error={listError} onRetry={reload} />}
          {!options && !listError && <Spinner />}
          <div className="radio-list">
            {options?.map((o) => (
              <label key={o.name || "__unsorted"} className="radio-card">
                <input type="radio" name="move-target" checked={target === o.name} onChange={() => setTarget(o.name)} />
                <span className="grow" style={{ minWidth: 0, overflowWrap: "anywhere" }}><b>{o.name || UNSORTED}</b> <span className="small muted">{o.copies ? plural(o.copies, "copy", "copies") : "empty"}</span></span>
              </label>
            ))}
            <label className="radio-card">
              <input type="radio" name="move-target" checked={target === "__new"} onChange={() => setTarget("__new")} />
              <span className="grow"><b>New binder…</b></span>
            </label>
          </div>
          {target === "__new" && (
            <input className="input" style={{ fontSize: 16 }} aria-label="New binder name" placeholder="New binder name, e.g. Trade binder" maxLength={100} autoFocus
              value={newName} onChange={(e) => setNewName(e.target.value)} />
          )}
        </fieldset>
        <ErrorNotice error={error} />
        <button type="submit" className="btn primary" disabled={!ready || busy}>
          {busy ? "Moving…" : <>{submitLabel || `Move ${maxQty != null ? plural(qty, "copy", "copies") : ""}`} to {targetLabel}</>}
        </button>
      </form>
    </Sheet>
  );
}
