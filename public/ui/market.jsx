"use strict";

// ===========================================================================
// Value tab: collection value over time (GET /api/finance/*) and the wishlist
// (/api/wishlist). The server keeps one snapshot per day (lib/finance.js); the
// tab only shows it. EUR only. Gains/losses use the ok/bad colours AND a +/−
// sign, never colour alone.
// ===========================================================================

const fmtSigned = (n) => (n == null ? "—" : `${n > 0 ? "+" : n < 0 ? "−" : "±"}${fmtEur(Math.abs(n))}`);
const signClass = (n) => (n > 0 ? "gain" : n < 0 ? "loss" : "");
const fmtDay = (day) => {
  const [y, m, d] = String(day).split("-").map(Number);
  try { return new Date(y, m - 1, d).toLocaleDateString(undefined, { day: "numeric", month: "short" }); } catch { return day; }
};
const WISH_FINISH = [["", "Any finish"], ["normal", "Non-foil"], ["foil", "Foil"], ["etched", "Etched"]];
const WISH_PRIORITY = [["high", "High"], ["normal", "Normal"], ["low", "Low"]];

/** Value over time: area + 2 px line, crosshair on hover/tap; the readout line above names the picked day. */
function ValueChart({ points }) {
  const [pick, setPick] = useState(null);
  const pts = asList(points);
  if (pts.length < 2) return null;
  const W = 320, H = 150, top = 10, bottom = 128;
  const vals = pts.map((p) => Number(p.value_eur) || 0);
  let lo = Math.min(...vals), hi = Math.max(...vals);
  if (hi - lo < 1) { lo -= 0.5; hi += 0.5; }
  const pad = (hi - lo) * 0.08;
  lo = Math.max(0, lo - pad); hi += pad;
  const x = (i) => (i / (pts.length - 1)) * W;
  const y = (v) => bottom - ((v - lo) / (hi - lo)) * (bottom - top);
  const line = pts.map((p, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(vals[i]).toFixed(1)}`).join("");
  const area = `${line}L${W},${bottom}L0,${bottom}Z`;
  const i = pick ?? pts.length - 1;
  const onMove = (e) => {
    const r = e.currentTarget.getBoundingClientRect();
    if (!r.width) return;
    setPick(Math.max(0, Math.min(pts.length - 1, Math.round(((e.clientX - r.left) / r.width) * (pts.length - 1)))));
  };
  return (
    <figure className="stack value-chart" style={{ margin: 0, gap: 6 }}>
      <div className="row between small" aria-live="polite">
        <span className="muted">{fmtDay(pts[i].day)}{i === pts.length - 1 ? " (now)" : ""}</span>
        <b>{fmtEur(vals[i])}</b>
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`Collection value from ${fmtDay(pts[0].day)} (${fmtEur(vals[0])}) to ${fmtDay(pts.at(-1).day)} (${fmtEur(vals.at(-1))})`}
        onPointerMove={onMove} onPointerDown={onMove} onPointerLeave={() => setPick(null)}>
        <line x1="0" x2={W} y1={top + 0.5} y2={top + 0.5} stroke="var(--border)" strokeDasharray="2 4" />
        <line x1="0" x2={W} y1={bottom + 0.5} y2={bottom + 0.5} stroke="var(--border)" />
        <path d={area} fill="var(--accent-soft)" />
        <path d={line} fill="none" stroke="var(--accent)" strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />
        <line x1={x(i)} x2={x(i)} y1={top} y2={bottom} stroke="var(--muted)" strokeWidth="1" />
        <circle cx={x(i)} cy={y(vals[i])} r="4.5" fill="var(--accent)" stroke="var(--surface)" strokeWidth="2" />
        <text x="2" y={top + 13} fontSize="11" fill="var(--muted)">{fmtEur(hi)}</text>
        <text x="2" y={bottom - 4} fontSize="11" fill="var(--muted)">{fmtEur(lo)}</text>
        <text x="0" y={H - 4} fontSize="11" fill="var(--muted)">{fmtDay(pts[0].day)}</text>
        <text x={W} y={H - 4} fontSize="11" fill="var(--muted)" textAnchor="end">{fmtDay(pts.at(-1).day)}</text>
      </svg>
    </figure>
  );
}

/** Horizontal bar list (binders, rarities): one colour, value at the end. */
function BarList({ rows, label }) {
  const max = Math.max(0, ...rows.map((r) => r.value));
  if (!rows.length) return <p className="small muted" style={{ margin: 0 }}>Nothing yet.</p>;
  return (
    <div className="bar-list" role="list" aria-label={label}>
      {rows.map((r) => (
        <div key={r.key} className="bar-row" role="listitem">
          <div className="row between"><span className="nm">{r.name}</span><span className="v">{fmtEur(r.value)}</span></div>
          <div className="bar" aria-hidden="true"><span style={{ width: `${max ? Math.max(1, (r.value / max) * 100) : 0}%` }} /></div>
          {r.sub && <span className="small muted">{r.sub}</span>}
        </div>
      ))}
    </div>
  );
}

const CHANGE_PERIODS = [["today", "Today"], ["d7", "7 days"], ["d30", "30 days"]];

function ValueOverview({ dataVersion, onOpenCard }) {
  const valueError = (e) => `Could not load the collection value: ${e.message}`;
  const sumQ = useApi("/api/finance/summary", [dataVersion], { error: valueError });
  const topQ = useApi("/api/finance/top?limit=20", [dataVersion], { error: valueError });
  const [range, setRange] = useState(() => store.get("mtg.value.range", 90));
  const [period, setPeriod] = useState(null);
  const [moverDays, setMoverDays] = useState(7);
  useEffect(() => { store.set("mtg.value.range", range); }, [range]);
  const histQ = useApi(`/api/finance/history?days=${range}`, [dataVersion]);
  const moversQ = useApi(`/api/finance/movers?days=${moverDays}&limit=8`, [dataVersion]);
  const sum = sumQ.data, top = topQ.data;
  const hist = histQ.error ? null : histQ.data;
  const movers = moversQ.error ? null : moversQ.data;

  const error = sumQ.error ?? topQ.error;
  if (error) return <ErrorNotice error={error} onRetry={() => { sumQ.reload(); topQ.reload(); }} />;
  if (!sum || !top) return <Spinner label="Loading value…" />;
  const ch = sum.changes || {};
  const sel = period && ch[period] ? period : CHANGE_PERIODS.map(([k]) => k).find((k) => ch[k]) || null;
  const c = sel ? ch[sel] : null;
  const pts = asList(hist?.points);
  const noHistory = !CHANGE_PERIODS.some(([k]) => ch[k]);
  return (
    <div className="stack-lg">
      <section className="stack" aria-labelledby="value-total">
        <div className="value-hero">
          <span className="k" id="value-total">Collection value</span>
          <span className="v">{fmtEur(sum.value_eur)}</span>
          <span className="small muted">{plural(sum.copies, "copy", "copies")}{sum.unpriced_copies ? ` · ${plural(sum.unpriced_copies, "copy", "copies")} without € price` : ""}</span>
        </div>
        <div className="change-tiles" role="group" aria-label="Value change">
          {CHANGE_PERIODS.map(([k, label]) => (
            <button key={k} type="button" className="stat change-tile" aria-pressed={sel === k} disabled={!ch[k]} onClick={() => setPeriod(k)}>
              <div className={`v ${ch[k] ? signClass(ch[k].change_eur) : ""}`}>{ch[k] ? fmtSigned(ch[k].change_eur) : "—"}</div>
              <div className="k">{label}</div>
            </button>
          ))}
        </div>
        {noHistory && (
          <div className="notice ok"><span aria-hidden="true">📈</span><div className="grow">
            <b>History starts {sum.history_start && sum.history_start !== sum.today ? fmtDay(sum.history_start) : "today"}.</b> The app saves your collection value once a day. Come back tomorrow to see what changed.
          </div></div>
        )}
        {c && (
          <div className="deck-section change-split" aria-label={`What changed since ${fmtDay(c.from_day)}`}>
            <span className="small muted">Since {fmtDay(c.from_day)} ({fmtEur(c.value_from_eur)})</span>
            <div className="row between"><span>Added cards <span className="muted small">({plural(c.added_copies, "copy", "copies")})</span></span><b className={signClass(c.added_eur)}>{fmtSigned(c.added_eur)}</b></div>
            <div className="row between"><span>Removed cards <span className="muted small">({plural(c.removed_copies, "copy", "copies")})</span></span><b className={signClass(-c.removed_eur)}>{fmtSigned(-c.removed_eur)}</b></div>
            <div className="row between"><span>Price changes <span className="muted small">(cards you kept)</span></span><b className={signClass(c.price_eur)}>{fmtSigned(c.price_eur)}</b></div>
          </div>
        )}
      </section>

      {pts.length >= 2 && (
        <section className="stack" aria-labelledby="value-chart-title">
          <div className="row between">
            <h2 id="value-chart-title">Over time</h2>
            <div className="segmented" role="group" aria-label="Time range">
              {[[30, "30d"], [90, "90d"], [365, "1y"], [3650, "All"]].map(([d, l]) => (
                <button key={d} type="button" aria-pressed={range === d} onClick={() => setRange(d)}>{l}</button>
              ))}
            </div>
          </div>
          <ValueChart points={pts} />
        </section>
      )}

      {movers?.available && (movers.risers.length > 0 || movers.fallers.length > 0) && (
        <section className="stack" aria-labelledby="movers-title">
          <div className="row between">
            <h2 id="movers-title">Price moves</h2>
            <div className="segmented" role="group" aria-label="Period">
              {[[7, "7 days"], [30, "30 days"]].map(([d, l]) => <button key={d} type="button" aria-pressed={moverDays === d} onClick={() => setMoverDays(d)}>{l}</button>)}
            </div>
          </div>
          {[["Risers", movers.risers], ["Fallers", movers.fallers]].filter(([, l]) => l.length).map(([title, list]) => (
            <div key={title} className="stack" style={{ gap: 6 }}>
              <h3>{title}</h3>
              <div className="list">
                {list.map((m) => (
                  <button key={`${m.scryfall_id}-${m.finish}`} type="button" className="list-row" onClick={() => onOpenCard(m.scryfall_id)}>
                    <span className="q">{m.held}×</span>
                    <span className="main">
                      <span className="nm"><b>{m.name}</b>{m.finish !== "normal" && <span className="badge accent">✦ {m.finish}</span>}</span>
                      <span className="sub">{(m.set_code || "").toUpperCase()} #{m.collector_number} · {fmtEur(m.from_eur)} → {fmtEur(m.to_eur)}</span>
                    </span>
                    <span className="end">
                      <b className={signClass(m.change_total_eur)}>{fmtSigned(m.change_total_eur)}</b>
                      {m.change_pct != null && <span className="muted">{m.change_pct > 0 ? "+" : "−"}{Math.abs(m.change_pct).toFixed(0)}%</span>}
                    </span>
                  </button>
                ))}
              </div>
            </div>
          ))}
        </section>
      )}

      <section className="stack" aria-labelledby="top-title">
        <h2 id="top-title">Most valuable</h2>
        {asList(top?.cards).length === 0
          ? <p className="small muted" style={{ margin: 0 }}>No priced cards yet.</p>
          : (
            <div className="list">
              {top.cards.map((t, i) => (
                <button key={`${t.scryfall_id}-${t.finish}`} type="button" className="list-row" onClick={() => onOpenCard(t.scryfall_id)}>
                  <span className="q">{i + 1}</span>
                  <span className="main">
                    <span className="nm"><b>{t.name}</b>{t.finish !== "normal" && <span className="badge accent">✦ {t.finish}</span>}</span>
                    <span className="sub">{(t.set_code || "").toUpperCase()} #{t.collector_number} · {asList(t.binders).map((b) => `${b.binder || UNSORTED}${t.binders.length > 1 ? ` ${b.quantity}×` : ""}`).join(", ")}</span>
                  </span>
                  <span className="end">
                    <b>{fmtEur(t.price_eur)}</b>
                    {t.quantity > 1 && <span className="muted">{t.quantity}× = {fmtEur(t.value_eur)}</span>}
                  </span>
                </button>
              ))}
            </div>
          )}
      </section>

      <section className="stack" aria-labelledby="binder-value-title">
        <h2 id="binder-value-title">Value per binder</h2>
        <BarList label="Value per binder" rows={asList(sum.binders).map((b) => ({ key: `b:${b.binder}`, name: b.binder || UNSORTED, value: b.value_eur, sub: plural(b.copies, "copy", "copies") }))} />
      </section>
      {asList(sum.rarities).length > 1 && (
        <section className="stack" aria-labelledby="rarity-value-title">
          <h2 id="rarity-value-title">Value per rarity</h2>
          <BarList label="Value per rarity" rows={sum.rarities.map((r) => ({ key: `r:${r.rarity}`, name: cap(r.rarity), value: r.value_eur, sub: plural(r.copies, "copy", "copies") }))} />
        </section>
      )}
    </div>
  );
}

/**
 * Add or edit a wishlist item. `card` = {scryfall_id?, oracle_id?, name, set_code?, collector_number?} for a new
 * item (no scryfall_id = any printing only), `item` = an existing item (GET /api/wishlist row).
 */
const ADD_BOARDS = ["main", "side", "maybe", "commander"];

/**
 * Add a card to a deck: board + copies. With `deck` the deck is fixed (deck page → Add card), else a deck
 * picker (card sheet → Add to deck; newest first, last choice remembered in mtg.addToDeck.last).
 * POST /api/decks/:id/cards; onDone(res) gets the deck detail + change.
 */
function AddToDeckSheet({ card, deck: fixedDeck = null, onClose, onDone }) {
  const { data: loaded, error: decksError } = useApi(fixedDeck ? null : "/api/decks", [], {
    map: (d) => d.slice().sort((a, b) => String(b.updated_at || "").localeCompare(String(a.updated_at || ""))),
    error: (e) => `Could not load decks: ${e.message}`,
  });
  const decks = fixedDeck ? [fixedDeck] : loaded;
  const [deckId, setDeckId] = useState(fixedDeck?.id ?? null);
  const [board, setBoard] = useState("main");
  const [qty, setQty] = useState(1);
  const [busy, setBusy] = useState(false);
  const [actionError, setError] = useState(null);
  const error = actionError ?? decksError;
  // The last deck used, else the newest one.
  useEffect(() => {
    if (!loaded) return;
    const last = Number(store.get("mtg.addToDeck.last", 0));
    setDeckId(loaded.some((x) => x.id === last) ? last : loaded[0]?.id ?? null);
  }, [loaded]);
  const target = decks?.find((d) => d.id === deckId) ?? null;
  const submit = async (e) => {
    e.preventDefault();
    if (busy || !target) return;
    setBusy(true); setError(null);
    try {
      const res = await api(`/api/decks/${target.id}/cards`, { method: "POST", json: card.scryfall_id
        ? { scryfall_id: card.scryfall_id, board, quantity: qty } : { name: card.name, board, quantity: qty } });
      if (!fixedDeck) store.set("mtg.addToDeck.last", target.id);
      onDone?.(res, target);
    } catch (err) { setError(err.message); setBusy(false); }
  };
  const printing = card.set_code ? ` (${String(card.set_code).toUpperCase()} #${card.collector_number})` : "";
  return (
    <Sheet title={`Add ${card.name}`} onClose={onClose}>
      <form className="stack" onSubmit={submit}>
        {!fixedDeck && (
          <div className="field">
            <label htmlFor="add-deck">Deck</label>
            {decks == null && !error ? <span className="muted small">Loading decks…</span>
              : decks?.length ? (
                <select id="add-deck" className="select" value={deckId ?? ""} onChange={(e) => setDeckId(Number(e.target.value))}>
                  {decks.map((d) => <option key={d.id} value={d.id}>{d.name}{d.status === "built" ? " (built)" : ""}</option>)}
                </select>
              ) : <span className="muted small">No decks yet. Create one in the Decks tab first.</span>}
          </div>
        )}
        {target?.source === "manabox" && (
          <div className="notice warn small">This deck comes from ManaBox: the next ManaBox import rebuilds it and drops cards added here.</div>
        )}
        <div className="field">
          <span className="label" id="add-board">Board</span>
          <div className="segmented wrap" role="group" aria-labelledby="add-board">
            {ADD_BOARDS.map((b) => <button key={b} type="button" aria-pressed={board === b} onClick={() => setBoard(b)}>{BOARD_LABEL[b]}</button>)}
          </div>
        </div>
        <QtyStepper label="Copies" value={qty} max={99} onChange={setQty} />
        <span className="small muted">Printing: {card.scryfall_id ? `this one${printing}` : "one you own, else a current one"}.</span>
        <ErrorNotice error={error} onDismiss={() => setError(null)} />
        <div className="row">
          <button type="submit" className="btn primary" disabled={busy || !target}><Icon.plus /> {busy ? "Adding…" : fixedDeck ? "Add to deck" : `Add to ${target ? target.name : "deck"}`}</button>
          <button type="button" className="btn ghost" onClick={onClose}>Cancel</button>
        </div>
      </form>
    </Sheet>
  );
}

/** Move the selected deck rows to another board (deck page Select → Move to…). */
function DeckMoveSheet({ count, onPick, onClose, busy }) {
  return (
    <Sheet title={`Move ${plural(count, "card")} to…`} onClose={onClose}>
      <div className="stack">
        {ADD_BOARDS.map((b) => (
          <button key={b} type="button" className="btn" disabled={busy} onClick={() => onPick(b)} style={{ justifyContent: "flex-start" }}>{BOARD_LABEL[b]}</button>
        ))}
      </div>
    </Sheet>
  );
}

function WishSheet({ card = null, item = null, onClose, onDone }) {
  const editing = Boolean(item);
  const exactLabel = item ? `${(item.set_code || "").toUpperCase()} #${item.collector_number}` : card?.set_code ? `${String(card.set_code).toUpperCase()} #${card.collector_number}` : null;
  const canExact = editing || Boolean(card?.scryfall_id);
  const [any, setAny] = useState(item ? item.any_printing : true);
  const [qty, setQty] = useState(item?.quantity ?? card?.quantity ?? 1);
  const [finish, setFinish] = useState(item?.finish ?? "");
  const [maxPrice, setMaxPrice] = useState(item?.max_price_eur != null ? String(item.max_price_eur) : "");
  const [priority, setPriority] = useState(item?.priority ?? "normal");
  const [note, setNote] = useState(item?.note ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const priceNum = maxPrice.trim() === "" ? null : Number(maxPrice.replace(",", "."));
  const priceBad = priceNum != null && !(priceNum >= 0);
  const submit = async (e) => {
    e.preventDefault();
    if (busy || priceBad) return;
    setBusy(true); setError(null);
    const fields = { quantity: qty, finish: finish || null, max_price_eur: priceNum, priority, note: note.trim() || null, any_printing: any };
    try {
      const res = editing
        ? await api(`/api/wishlist/${item.id}`, { method: "PATCH", json: fields })
        : await api("/api/wishlist", { method: "POST", json: { ...fields, ...(card.scryfall_id ? { scryfall_id: card.scryfall_id } : { oracle_id: card.oracle_id, name: card.name }) } });
      onDone?.(editing ? { item: res } : res);
    } catch (err) { setError(err.message); setBusy(false); }
  };
  const remove = async () => {
    setBusy(true); setError(null);
    try { await api(`/api/wishlist/${item.id}`, { method: "DELETE" }); onDone?.({ removed: item }); }
    catch (err) { setError(err.message); setBusy(false); }
  };
  return (
    <Sheet title={editing ? item.name : `Wishlist: ${card.name}`} onClose={onClose}>
      <form className="stack" onSubmit={submit}>
        {canExact && (
          <fieldset className="stack" style={{ border: 0, padding: 0, margin: 0, gap: 6 }}>
            <legend className="label">Which printing?</legend>
            <label className="radio-row"><input type="radio" name="wish-any" checked={any} onChange={() => setAny(true)} /> Any printing <span className="small muted">(cheapest)</span></label>
            <label className="radio-row"><input type="radio" name="wish-any" checked={!any} onChange={() => setAny(false)} /> Only {exactLabel || "this printing"}</label>
          </fieldset>
        )}
        <QtyStepper label="Copies wanted" value={qty} max={99} onChange={setQty} />
        <div className="field">
          <label htmlFor="wish-finish">Finish</label>
          <select id="wish-finish" className="select" value={finish} onChange={(e) => setFinish(e.target.value)}>
            {WISH_FINISH.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
          </select>
        </div>
        <div className="field">
          <label htmlFor="wish-max">Max price per copy (€, optional)</label>
          <input id="wish-max" className="input" style={{ fontSize: 16 }} inputMode="decimal" autoComplete="off" placeholder="e.g. 5" value={maxPrice}
            aria-invalid={priceBad || undefined} onChange={(e) => setMaxPrice(e.target.value)} />
          {priceBad && <span className="small" style={{ color: "var(--bad)" }}>Enter a price like 4.50</span>}
        </div>
        <div className="field">
          <span className="label" id="wish-prio">Priority</span>
          <div className="segmented" role="group" aria-labelledby="wish-prio">
            {WISH_PRIORITY.map(([k, l]) => <button key={k} type="button" aria-pressed={priority === k} onClick={() => setPriority(k)}>{l}</button>)}
          </div>
        </div>
        <div className="field">
          <label htmlFor="wish-note">Note (optional)</label>
          <input id="wish-note" className="input" style={{ fontSize: 16 }} maxLength={500} value={note} onChange={(e) => setNote(e.target.value)} placeholder="for which deck, where to buy…" />
        </div>
        <ErrorNotice error={error} />
        <button type="submit" className="btn primary" disabled={busy || priceBad}>{busy ? "Saving…" : editing ? <><Icon.check /> Save</> : <><Icon.heart /> Add to wishlist</>}</button>
        {editing && <button type="button" className="btn danger" disabled={busy} onClick={remove}><Icon.trash /> Remove from wishlist</button>}
      </form>
    </Sheet>
  );
}

function WishRow({ it, onEdit, onRemove, selecting = false, selected = false, onToggle = null }) {
  const printing = it.any_printing ? "any printing" : `${(it.set_code || "").toUpperCase()} #${it.collector_number}`;
  const bits = [printing, it.finish ? (it.finish === "normal" ? "non-foil" : it.finish) : null, `own ${it.owned}`,
    it.max_price_eur != null ? `max ${fmtEur(it.max_price_eur)}` : null].filter(Boolean);
  return (
    <div className={`wish-row${it.got_it ? " done" : ""}${selected ? " selected" : ""}`}>
      <button type="button" className={`list-row${selecting ? " picking" : ""}`} onClick={() => (selecting ? onToggle?.(it) : onEdit(it))}
        {...(selecting ? { role: "checkbox", "aria-checked": selected, "aria-label": `Select ${it.name}` } : { "aria-label": `Edit ${it.name} on the wishlist` })}>
        {selecting && <span className="sel-tick" aria-hidden="true">{selected ? <Icon.check /> : null}</span>}
        {it.image_small ? <img className="wish-thumb" src={it.image_small} alt="" loading="lazy" /> : <span className="q">{it.quantity}×</span>}
        <span className="main">
          <span className="nm"><b>{it.image_small ? `${it.quantity}× ` : ""}{it.name}</b></span>
          <span className="sub">{bits.join(" · ")}</span>
          <span className="row" style={{ gap: 4 }}>
            {it.got_it && <span className="badge ok">✓ got it</span>}
            {!it.got_it && it.below_max && <span className="badge ok">✓ below your max</span>}
            {it.priority === "high" && <span className="badge accent">high</span>}
            {it.priority === "low" && <span className="badge">low</span>}
            {it.source === "claude" && <span className="badge accent">✦ claude</span>}
          </span>
          {it.note && <span className="sub">{it.note}</span>}
        </span>
        <span className="end">
          {it.price_eur == null ? <span className="muted">no €</span> : <b>{fmtEur(it.price_eur)}</b>}
          {!it.got_it && it.to_buy > 1 && it.cost_eur != null && <span className="muted">{it.to_buy}× = {fmtEur(it.cost_eur)}</span>}
        </span>
      </button>
      {it.got_it && !selecting && <button type="button" className="btn sm" onClick={() => onRemove(it)}><Icon.check /> Remove, I have it</button>}
    </div>
  );
}

function WishlistView({ dataVersion, onChanged }) {
  const { data, error: loadError, reload } = useApi("/api/wishlist", [dataVersion], { error: (e) => `Could not load the wishlist: ${e.message}` });
  const [actionError, setError] = useState(null);
  const error = actionError ?? loadError;
  const load = () => { setError(null); reload(); };
  const [picking, setPicking] = useState(false);
  const [sheet, setSheet] = useState(null); // {card} | {item}
  const [notice, setNotice] = useState(null);
  const done = (res) => {
    setSheet(null);
    setNotice(res?.removed ? `Removed ${res.removed.name}.` : res?.merged ? `${res.item.name}: now ${res.item.quantity} wanted.` : res?.item ? `Saved ${res.item.name}.` : null);
    load();
    onChanged?.();
  };
  const remove = async (it) => {
    try { await api(`/api/wishlist/${it.id}`, { method: "DELETE" }); done({ removed: it }); } catch (e) { setError(e.message); }
  };
  // Select mode: tick rows, then remove them in one go (POST /api/wishlist/delete).
  const [selecting, setSelecting] = useState(false);
  const [selected, setSelected] = useState(() => new Set());
  const [removing, setRemoving] = useState(false);
  const toggleSel = (it) => setSelected((cur) => { const n = new Set(cur); if (n.has(it.id)) n.delete(it.id); else n.add(it.id); return n; });
  const stopSelecting = () => { setSelecting(false); setSelected(new Set()); };
  const removeSelected = async () => {
    const ids = [...selected];
    if (!ids.length || removing) return;
    if (!window.confirm(`Remove ${plural(ids.length, "card")} from your wishlist?`)) return;
    setRemoving(true); setError(null);
    try {
      const r = await api("/api/wishlist/delete", { method: "POST", json: { ids } });
      stopSelecting();
      setNotice(`Removed ${plural(r.removed ?? ids.length, "card")} from your wishlist.`);
      load();
      onChanged?.();
    } catch (e) { setError(e.message); } finally { setRemoving(false); }
  };
  const items = asList(data?.items);
  // Rows that left the list (removed elsewhere) drop out of the selection.
  useEffect(() => { setSelected((cur) => { const ids = new Set(items.map((i) => i.id)); const n = new Set([...cur].filter((id) => ids.has(id))); return n.size === cur.size ? cur : n; }); }, [data]);
  const allSel = items.length > 0 && selected.size >= items.length;
  const open = items.filter((i) => !i.got_it);
  const got = items.filter((i) => i.got_it);
  const t = data?.totals;
  return (
    <div className="stack-lg">
      <div className="row between">
        <h2>Wishlist</h2>
        <button type="button" className="btn primary" onClick={() => { setNotice(null); setPicking(true); }}><Icon.plus /> Add card</button>
      </div>
      {items.length > 0 && (
        <div className="list-actions">
          <button type="button" className={`btn${selecting ? " primary" : ""}`} aria-pressed={selecting} onClick={() => (selecting ? stopSelecting() : (setNotice(null), setSelecting(true)))}>
            <Icon.check /> {selecting ? "Done" : "Select"}</button>
          {open.length > 0 && <a className="btn" href="/api/wishlist/export" download="Wishlist.txt"><Icon.download /> Export list</a>}
        </div>
      )}
      <ErrorNotice error={error} onRetry={load} />
      {notice && <div className="notice ok" role="status"><span aria-hidden="true">✓</span><div className="grow">{notice}</div></div>}
      {!data && !error && <Spinner label="Loading wishlist…" />}
      {data && items.length === 0 && (
        <div className="empty">
          <h3>Nothing on your wishlist</h3>
          <span>Add cards here, from a card's page (♡ Wishlist) or from a deck's To-buy list.</span>
        </div>
      )}
      {t && items.length > 0 && (
        <div className="summary-grid">
          <div className="stat"><div className="v">{fmtEur(t.to_buy_eur)}</div><div className="k">To buy ({fmtInt(t.to_buy)})</div></div>
          <div className="stat"><div className="v">{fmtInt(t.below_max)}</div><div className="k">Below your max</div></div>
        </div>
      )}
      {open.length > 0 && <div className="stack" style={{ gap: 6 }}>
        {t?.unpriced > 0 && <span className="small muted">{plural(t.unpriced, "card")} without a € price (not in the total).</span>}
        <div className="list">{open.map((it) => <WishRow key={it.id} it={it} onEdit={(x) => setSheet({ item: x })} onRemove={remove}
          selecting={selecting} selected={selected.has(it.id)} onToggle={toggleSel} />)}</div>
      </div>}
      {got.length > 0 && (
        <section className="stack" style={{ gap: 6 }} aria-labelledby="wish-got">
          <h3 id="wish-got">Got it <span className="muted small">(you own enough copies now)</span></h3>
          <div className="list">{got.map((it) => <WishRow key={it.id} it={it} onEdit={(x) => setSheet({ item: x })} onRemove={remove}
            selecting={selecting} selected={selected.has(it.id)} onToggle={toggleSel} />)}</div>
        </section>
      )}
      {selecting && (
        <div className="commit-bar" role="region" aria-label="Selection">
          <span className="grow small">{selected.size ? `${plural(selected.size, "card")} selected` : "Tap cards to select"}</span>
          <button type="button" className="btn ghost" onClick={() => setSelected(allSel ? new Set() : new Set(items.map((i) => i.id)))}>{allSel ? "None" : "All"}</button>
          <button type="button" className="btn danger" disabled={!selected.size || removing} onClick={removeSelected}>
            <Icon.trash /> {removing ? "Removing…" : "Remove"}</button>
        </div>
      )}
      {picking && (
        <PrintingPicker title="Add to wishlist" startInSearch onClose={() => setPicking(false)}
          onPick={(p) => { setPicking(false); setSheet({ card: { scryfall_id: p.id, oracle_id: p.oracle_id, name: p.en_name || p.name, set_code: p.set, collector_number: p.cn } }); }} />
      )}
      {sheet && <WishSheet card={sheet.card} item={sheet.item} onClose={() => setSheet(null)} onDone={done} />}
    </div>
  );
}

/** Market tab sub-views; the hash is #value[/wishlist|/buy] (the tab id stays "value"). */
const MARKET_VIEWS = ["overview", "wishlist", "buy"];
const marketViewOf = (hash) => { const s = String(hash || "").replace(/^#/, "").split("/"); return s[0] === "value" && MARKET_VIEWS.includes(s[1]) ? s[1] : null; };
const marketHash = (v) => (v === "overview" ? "#value" : `#value/${v}`);

/** Market tab: collection value, the wishlist and the global To buy list (built decks). */
function FinanceTab({ dataVersion, buyVersion, view, onView, onOpenCard, onOpenDeck, onChanged }) {
  return (
    <div className="stack-lg">
      <div className="page-title">
        <h1>Market</h1>
        <div className="segmented market-views" role="group" aria-label="Show">
          <button type="button" aria-pressed={view === "overview"} onClick={() => onView("overview")}><Icon.chart /> Value</button>
          <button type="button" aria-pressed={view === "wishlist"} onClick={() => onView("wishlist")}><Icon.heart /> Wishlist</button>
          <button type="button" aria-pressed={view === "buy"} onClick={() => onView("buy")}><Icon.cart /> To buy</button>
        </div>
      </div>
      {view === "wishlist"
        ? <WishlistView dataVersion={dataVersion} onChanged={onChanged} />
        : view === "buy"
          ? <ShoppingListView dataVersion={buyVersion} onOpenDeck={onOpenDeck} onOpenWishlist={() => onView("wishlist")} onWishChanged={onChanged} />
          : <ValueOverview dataVersion={dataVersion} onOpenCard={onOpenCard} />}
    </div>
  );
}
