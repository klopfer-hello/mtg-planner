"use strict";

// ===========================================================================
// Build checklist + deck history (v10)
// ===========================================================================

const BUILD_GROUP_HINT = {
  other: "Owned, but another built deck or a locked binder holds them.",
  basics: "Not enough in the collection: take them from your basic lands.",
  buy: "You don't own these.",
  box: "Already where the deck lives.",
  tokens: "Tokens and markers to bring. Not counted in the progress.",
};

/**
 * Build checklist: the deck's cards grouped by the binder to pick them from, a tick per line
 * (stored on the server, so it works across devices), then "Put into deck box" / "Mark as built".
 */
function BuildSheet({ deck, onClose, onSetBuilt, onCollectionChanged, onOpenCard }) {
  const { data: list, error: loadError, reload: load, setData: setList } = useApi(`/api/decks/${deck.id}/build`);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(null); // line id being saved
  const [hidePicked, setHidePicked] = useState(false);
  const [boxing, setBoxing] = useState(false);
  const [statusBusy, setStatusBusy] = useState(false);

  const lineId = (l) => `${l.key}\u0000${l.source}`;
  const toggle = async (l) => {
    if (l.source === "box" || busy) return;
    const quantity = l.picked >= l.quantity ? 0 : l.quantity;
    const id = lineId(l);
    setBusy(id);
    setError(null);
    // Optimistic: tick at once, the server's list replaces it.
    setList((cur) => cur && patchPick(cur, id, quantity));
    try {
      setList(await api(`/api/decks/${deck.id}/build/picks`, { method: "PUT", json: { key: l.key, source: l.source, quantity } }));
    } catch (err) {
      setError(err.message);
      load();
    } finally {
      setBusy(null);
    }
  };
  const clearAll = async () => {
    if (!window.confirm("Untick every card on this list?")) return;
    try { setList(await api(`/api/decks/${deck.id}/build/picks`, { method: "DELETE" })); } catch (err) { setError(err.message); }
  };
  const markBuilt = async () => {
    setStatusBusy(true);
    try { await onSetBuilt(); load(); } finally { setStatusBusy(false); }
  };

  if (boxing && list) {
    return (
      <DeckBoxSheet deck={{ ...deck, box_binder: list.box_binder }} pickedOnly
        onClose={() => { setBoxing(false); load(); }} onDone={() => onCollectionChanged?.()} />
    );
  }
  const total = list?.total ?? 0;
  const picked = list?.picked ?? 0;
  const pct = total ? Math.round((picked / total) * 100) : 0;
  const progress = list && (
    <div className="build-progress" aria-live="polite">
      <div className="row between small"><b>{fmtInt(picked)} / {fmtInt(total)} picked</b>
        {list.complete ? <span className="badge ok">✓ all picked</span> : <span className="muted">{pct}%</span>}</div>
      <div className="bar" role="progressbar" aria-valuemin={0} aria-valuemax={total} aria-valuenow={picked} aria-label="Picked cards">
        <span style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
  return (
    <Sheet title={`Build: ${deck.name}`} onClose={onClose} pinned={progress}>
      {!list && !loadError && <Spinner label="Loading the list…" />}
      <ErrorNotice error={error ?? loadError} onRetry={list ? null : load} onDismiss={list && error ? () => setError(null) : null} />
      {list && (
        <div className="stack">
          {total === 0 && <div className="empty"><h3>Nothing to pick</h3><span>This deck has no cards yet.</span></div>}
          {total > 0 && (
            <div className="row between">
              <label className="row small" style={{ minHeight: 44, cursor: "pointer" }}>
                <input type="checkbox" checked={hidePicked} onChange={(e) => setHidePicked(e.target.checked)} style={{ width: 20, height: 20, accentColor: "var(--accent)" }} />
                Hide picked
              </label>
              {picked > 0 && <button type="button" className="btn ghost sm" onClick={clearAll}>Untick all</button>}
            </div>
          )}
          {list.groups.map((g) => {
            const lines = hidePicked ? g.lines.filter((l) => l.picked < l.quantity) : g.lines;
            const done = g.picked >= g.quantity;
            return (
              <details key={g.key} className="build-group" open={g.kind !== "box" && !done}>
                <summary>
                  <span className="grow gname">{g.kind === "binder" ? <Icon.collection /> : g.kind === "buy" ? <Icon.cart /> : g.kind === "box" ? <Icon.box /> : null}
                    <span>{g.title}</span></span>
                  <span className={`badge ${done ? "ok" : ""}`}>{fmtInt(g.picked)}/{fmtInt(g.quantity)}</span>
                </summary>
                {BUILD_GROUP_HINT[g.kind] && <p className="small muted" style={{ margin: "0 0 4px" }}>{BUILD_GROUP_HINT[g.kind]}</p>}
                {lines.length === 0 && <p className="small muted" style={{ margin: 0 }}>All picked.</p>}
                <div className="build-lines">
                  {lines.map((l) => {
                    const on = l.picked >= l.quantity;
                    const id = lineId(l);
                    return (
                      <div key={id} className={`build-line${on ? " on" : ""}`}>
                      <button type="button" role="checkbox" aria-checked={on ? "true" : l.picked > 0 ? "mixed" : "false"}
                        className="pick" disabled={l.source === "box" || busy === id} onClick={() => toggle(l)}>
                        <span className="tick" aria-hidden="true">{on ? <Icon.check /> : null}</span>
                        <span className="q">{l.quantity}×</span>
                        <span className="nm"><b>{l.name}</b>
                          {l.local_name && l.local_name !== l.name && <span className="de">({l.local_name})</span>}
                          {l.mana_cost ? <ManaCost cost={l.mana_cost} /> : null}
                          {l.commander && <span className="badge accent">commander</span>}
                          {g.kind === "other" && <span className="small muted">{l.locked ? "🔒 " : ""}in {l.binder || UNSORTED}{l.locked && !asList(l.decks).length ? " · locked" : ""}{asList(l.decks).length ? ` · ${asList(l.decks).join(", ")}` : ""}</span>}
                          {l.token && l.pt && <span className="badge">{l.pt}</span>}
                          {l.token && <span className="small muted">{l.need ? `need · you own none${l.estimate_note ? ` · ${l.estimate_note}` : ""}` : `in ${l.binder || UNSORTED}`}</span>}
                          {l.marker && asList(l.from).length > 0 && <span className="small muted">{asList(l.from).join(", ")}</span>}
                        </span>
                        {g.kind === "buy" && <span className="p small muted">{l.price_eur == null ? "" : fmtEur(l.price_eur * l.quantity)}</span>}
                      </button>
                      {l.scryfall_id && onOpenCard && (
                        <button type="button" className="peek" aria-label={`Show ${l.name}`} title="Show card" onClick={() => onOpenCard(l.scryfall_id)}>
                          {l.image_small ? <img src={l.image_small} alt="" loading="lazy" decoding="async" /> : <Icon.search />}
                        </button>
                      )}
                      </div>
                    );
                  })}
                </div>
              </details>
            );
          })}
          {total > 0 && (
            <div className="stack build-end">
              {list.movable_picked > 0 && (
                <button type="button" className="btn primary" onClick={() => setBoxing(true)}><Icon.box /> Put picked cards into deck box</button>
              )}
              {deck.status !== "built" && (
                <button type="button" className={`btn${list.complete ? " primary" : ""}`} disabled={statusBusy} onClick={markBuilt}>
                  <Icon.check /> {statusBusy ? "Saving…" : "Mark deck as built"}
                </button>
              )}
              {deck.status === "built" && <span className="small muted">This deck is built. Ticks only help you collect; they don't move cards.</span>}
            </div>
          )}
        </div>
      )}
    </Sheet>
  );
}

/** Checklist with one line's ticks set (optimistic update before the server answers). */
function patchPick(list, id, quantity) {
  let delta = 0, movable = 0;
  const groups = list.groups.map((g) => {
    let gd = 0;
    const lines = g.lines.map((l) => {
      if (`${l.key}\u0000${l.source}` !== id) return l;
      const n = Math.min(quantity, l.quantity);
      gd += n - l.picked;
      return { ...l, picked: n };
    });
    if (g.kind !== "tokens") delta += gd;
    if (g.kind === "binder") movable += gd;
    return gd ? { ...g, lines, picked: g.picked + gd } : g;
  });
  const picked = list.picked + delta;
  return { ...list, groups, picked, movable_picked: list.movable_picked + movable, complete: list.total > 0 && picked >= list.total };
}

const ACTOR_LABEL = { app: "You", claude: "✦ Claude", import: "ManaBox import", scan: "Scanner", system: "Before history" };

/** Added / removed / changed cards per board (and renamed, format, bracket). */
function DeckDiff({ diff, empty = "No card changes." }) {
  if (!diff) return null;
  const boards = asList(diff.boards);
  const meta = asList(diff.meta);
  const metaLabel = { name: "Name", format: "Format", description: "Description", status: "Status", bracket_declared: "Bracket" };
  const val = (f, v) => (v == null || v === "" ? "—" : f === "bracket_declared" ? `B${v}` : f === "description" ? "…" : String(v));
  return (
    <div className="stack" style={{ gap: 8 }}>
      {meta.map((m) => <div key={m.field} className="small">{metaLabel[m.field] ?? m.field}: <s className="muted">{val(m.field, m.from)}</s> → <b>{val(m.field, m.to)}</b></div>)}
      {boards.length === 0 && meta.length === 0 && <span className="small muted">{empty}</span>}
      {boards.map((b) => (
        <div key={b.board} className="diff-board">
          <h4>{BOARD_LABEL[b.board] ?? b.board}</h4>
          <ul className="diff-list">
            {asList(b.added).map((c) => <li key={`a${c.name}`} className="add"><span className="sym" aria-label="added">+</span>{c.quantity}× {c.name}</li>)}
            {asList(b.removed).map((c) => <li key={`r${c.name}`} className="rem"><span className="sym" aria-label="removed">−</span>{c.quantity}× {c.name}</li>)}
            {asList(b.changed).map((c) => <li key={`c${c.name}`} className="chg"><span className="sym" aria-label="changed">~</span>{c.name}: {c.from === c.to ? `${c.to}×` : `${c.from} → ${c.to}`}{c.printing ? " (other printing)" : ""}</li>)}
          </ul>
        </div>
      ))}
    </div>
  );
}

/** Deck history: versions newest first; tap one for its changes and "Restore this version". */
function HistorySheet({ deck, onClose, onRestored }) {
  const { data, error: loadError, reload: load } = useApi(`/api/decks/${deck.id}/history`);
  const [error, setError] = useState(null);
  const [open, setOpen] = useState(null); // version detail
  const [busy, setBusy] = useState(false);
  const show = async (v) => {
    setError(null);
    setBusy(true);
    try { setOpen({ ...(await api(`/api/decks/${deck.id}/history/${v.id}`)), current: v.current }); } catch (err) { setError(err.message); } finally { setBusy(false); }
  };
  const restore = async () => {
    const v = open.version;
    const what = open.restore?.summary && open.restore.summary !== "No changes" ? `\n\nChanges: ${open.restore.summary}.` : "";
    if (!window.confirm(`Restore the version from ${fmtDate(v.at)}?${what}\n\nIt is saved as a new version, so nothing is lost. The status (idea/built) stays.`)) return;
    setBusy(true);
    setError(null);
    try {
      const res = await api(`/api/decks/${deck.id}/history/${v.id}/restore`, { method: "POST", json: { confirm: true } });
      onRestored?.(res);
      setOpen(null);
      load();
    } catch (err) { setError(err.message); } finally { setBusy(false); }
  };
  const versions = asList(data?.versions);
  return (
    <Sheet title={open ? "Version" : `History: ${deck.name}`} onClose={onClose}
      actions={open ? <button type="button" className="btn ghost sm" onClick={() => setOpen(null)}><Icon.back /> List</button> : null}>
      <ErrorNotice error={error} onDismiss={() => setError(null)} />
      <ErrorNotice error={loadError} onRetry={load} />
      {!open && !data && !loadError && <Spinner label="Loading history…" />}
      {!open && data && (
        <div className="stack" style={{ gap: 8 }}>
          <p className="small muted" style={{ margin: 0 }}>Every change is saved. Tap a version to see what changed. The newest {fmtInt(data.keep)} are kept.</p>
          {versions.length === 0 && <div className="empty"><h3>No history yet</h3></div>}
          {versions.map((v) => (
            <button key={v.id} type="button" className="version-row" disabled={busy} onClick={() => show(v)}>
              <span className="grow vbody">
                <span className="row small" style={{ gap: 6 }}>
                  <b>{fmtDate(v.at)}</b>
                  <span className={`badge ${v.actor === "claude" ? "accent" : ""}`}>{ACTOR_LABEL[v.actor] ?? v.actor}</span>
                  {v.current && <span className="badge ok">current</span>}
                </span>
                <span className="small">{v.summary}</span>
              </span>
              <span className="small muted">{plural(v.card_count, "card")}</span>
            </button>
          ))}
        </div>
      )}
      {open && (
        <div className="stack">
          <div className="row small" style={{ gap: 6 }}>
            <b>{fmtDate(open.version.at)}</b>
            <span className="badge">{ACTOR_LABEL[open.version.actor] ?? open.version.actor}</span>
            <span className="muted">{plural(open.version.card_count, "card")}</span>
          </div>
          <div className="small">{open.version.summary}</div>
          <h3 className="diff-h">What changed here</h3>
          {open.diff ? <DeckDiff diff={open.diff} /> : <span className="small muted">The oldest saved version: nothing earlier to compare with.</span>}
          {!open.current && (
            <>
              <h3 className="diff-h">If you restore it</h3>
              <DeckDiff diff={open.restore} empty="Same cards as now." />
              <button type="button" className="btn primary" disabled={busy} onClick={restore}><Icon.undo /> {busy ? "Restoring…" : "Restore this version"}</button>
            </>
          )}
          {open.current && <span className="badge ok" style={{ justifySelf: "start" }}>This is the deck as it is now</span>}
        </div>
      )}
    </Sheet>
  );
}

/** Market → To buy: everything short across all BUILT decks, plus what each deck still misses. */
function ShoppingListView({ dataVersion, onOpenDeck, onOpenWishlist, onWishChanged }) {
  const { data, error, reload: load } = useApi("/api/shopping-list", [dataVersion], { error: (e) => `Could not load the shopping list: ${e.message}` });
  const items = asList(data?.built?.items);
  const perDeck = asList(data?.per_deck);
  const wishItems = asList(data?.wishlist?.items);
  const wish = useWishAdd(() => { onWishChanged?.(); load(); });
  return (
    <div className="stack-lg">
      <ErrorNotice error={error} onRetry={load} />
      {!data && !error && <Spinner label="Loading the to-buy list…" />}
      {data && (
        <>
          <section className="stack" aria-labelledby="shop-built-title">
            <h2 id="shop-built-title">For your built decks</h2>
            {items.length === 0
              ? <div className="notice ok"><span aria-hidden="true">✓</span><div className="grow">You own enough copies for every built deck.</div></div>
              : (
                <>
                  <span className="small muted">Cards your built decks need together, minus what you own.</span>
                  <BuyList items={items} qtyKey="short" total={data.built?.total_eur}
                    onWish={(it) => wish.add([{ ...it, qty: it.short }])} isWished={wish.isAdded}
                    sub={(it) => asList(it.decks).length > 0 && <span className="sub">{asList(it.decks).map((d) => d.name).join(", ")}</span>} />
                  <div className="list-actions">
                    <a className="btn sm" href="/api/shopping-list/export" download="To buy.txt"><Icon.download /> Export list</a>
                  </div>
                  {wish.el}
                </>
              )}
          </section>
          {wishItems.length > 0 && onOpenWishlist && (
            <div className="row between" style={{ gap: 8 }}>
              <span className="small muted">Plus {plural(wishItems.length, "card")} on your wishlist{data.wishlist?.total_eur ? ` (${fmtEur(data.wishlist.total_eur)})` : ""}.</span>
              <button type="button" className="btn sm" onClick={onOpenWishlist}><Icon.heart /> Wishlist</button>
            </div>
          )}
          {perDeck.length > 0 && (
            <section className="stack" aria-labelledby="shop-deck-title">
              <h2 id="shop-deck-title">Per deck</h2>
              <span className="small muted">Cards to buy per deck (copies you don't own). Owned cards sitting in other built decks are counted separately: you can move them.</span>
              <div className="list">
                {perDeck.map((d) => {
                  const { toBuy, inUse, toBuyEur } = deckCounts(d);
                  const sub = [toBuy ? `${fmtInt(toBuy)} to buy` : null, inUse ? `${fmtInt(inUse)} in other decks` : null].filter(Boolean).join(" · ");
                  return (
                    <button key={d.id} type="button" className="list-row" style={{ gridTemplateColumns: "minmax(0, 1fr) auto" }} onClick={() => onOpenDeck(d.id)}>
                      <span className="main">
                        <span className="nm"><b>{d.name}</b> <StatusBadge status={d.status} /></span>
                        <span className="sub">{sub || "complete"}</span>
                      </span>
                      <span className="end">{toBuy ? fmtEur(toBuyEur) : inUse ? <span className="badge warn" title="Owned, in other decks">⇄ {fmtInt(inUse)}</span> : <span className="badge ok">✓</span>}</span>
                    </button>
                  );
                })}
              </div>
            </section>
          )}
        </>
      )}
    </div>
  );
}
