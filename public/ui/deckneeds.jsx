"use strict";

// ---------------------------------------------------------------------------
// Deck allocation: idea / built status, conflicts, shopping lists, deck boxes

function StatusBadge({ status }) {
  if (status !== "built" && status !== "idea") return null;
  return status === "built"
    ? <span className="badge ok" title="Built: this deck claims its cards">built</span>
    : <span className="badge" title="Idea: doesn't claim cards">idea</span>;
}

/** Line EUR of a shopping-list item: cost_eur (need × unit price_eur), or null when unpriced. */
function lineEurOf(qtyKey) {
  const qty = (it) => Math.max(1, Number(it[qtyKey]) || 1);
  return (it) => (it.cost_eur != null ? Number(it.cost_eur) : it.price_eur == null ? null : Number(it.price_eur) * qty(it));
}

function BuyList({ items, qtyKey, total, sub, label = "Total", onWish = null, isWished = null }) {
  const lineEur = lineEurOf(qtyKey);
  return (
    <div className="deck-section" style={{ padding: 0, gap: 0 }}>
      <div className="buy-list">
        {items.map((it, i) => {
          const eur = lineEur(it);
          const wished = isWished?.(it);
          return (
            <div key={`${it.name}-${i}`} className={`buy-row${onWish ? " has-act" : ""}`}>
              <span className="q">{it[qtyKey] ?? 1}×</span>
              <span className="nm"><b>{it.name}</b>{sub && sub(it)}</span>
              <span className="p">{eur == null ? <span className="muted">no €</span> : fmtEur(eur)}</span>
              {onWish && (
                <button type="button" className="btn ghost icon sm wish-btn" aria-pressed={Boolean(wished)} disabled={wished}
                  aria-label={wished ? `${it.name} is on your wishlist` : `Add ${it.name} to your wishlist`} onClick={() => onWish(it)}>
                  {wished ? <Icon.heartFull /> : <Icon.heart />}
                </button>
              )}
            </div>
          );
        })}
      </div>
      {total != null && <div className="buy-total"><span>{label}</span><span>{fmtEur(total)}</span></div>}
    </div>
  );
}

/** "⚠ 2 cards are also in another built deck" + which decks. */
function ConflictBanner({ deck, onOpenDeck }) {
  const list = asList(deck.conflicts);
  const n = deck.conflict_count ?? list.length;
  if (!n) return null;
  return (
    <div className="notice error" role="status">
      <span aria-hidden="true">⚠</span>
      <div className="grow">
        <b>{n === 1 ? "1 card is" : `${fmtInt(n)} cards are`} also in another built deck</b> and you don't own enough copies for all of them.
        {list.length > 0 && (
          <ul className="conflict-list">
            {list.map((c, i) => {
              const others = asList(c.decks).filter((d) => d.deck_id !== deck.id);
              return (
                <li key={`${c.name}-${i}`}>
                  <b>{c.name}</b>: own {c.owned ?? "?"}, built decks need {c.demand ?? "?"}
                  {others.length > 0 && <>{" · "}{others.map((d, j) => (
                    <React.Fragment key={j}>{j > 0 && ", "}
                      {onOpenDeck
                        ? <button type="button" className="linkbtn" onClick={() => onOpenDeck(d.deck_id)}>{d.name}</button>
                        : d.name}
                      {d.quantity ? ` ${d.quantity}×` : ""}
                    </React.Fragment>))}</>}
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}

/** "80 to buy (~€X) · 8 in other decks (€Y to buy instead)" or "you own every card". */
function DeckNeedNotice({ deck }) {
  const { toBuy, inUse, toBuyEur, inUseEur } = deckCounts(deck);
  const built = deck?.status === "built";
  // Copies only free in locked binders (deck boxes, binders the user locked).
  const locked = Math.max(0, Number(deck?.in_use_locked_count) || 0);
  const inDecks = Math.max(0, inUse - locked);
  if (!toBuy && !inUse) {
    return <div className="notice ok"><span aria-hidden="true">✓</span><div className="grow"><b>You own every card in this deck.</b></div></div>;
  }
  return (
    <div className={`notice ${toBuy || built ? "warn" : "ok"} need-notice`} role="status">
      <span aria-hidden="true">{toBuy ? "✗" : built ? "⚠" : "✓"}</span>
      <div className="grow stack" style={{ gap: 2 }}>
        <span>
          {toBuy > 0
            ? <b>{fmtInt(toBuy)} to buy{toBuyEur != null ? ` (~${fmtEur(toBuyEur)})` : ""}</b>
            : <b>You own every card</b>}
          {inDecks > 0 && <>
            {" · "}
            <span className="inuse-count"><span aria-hidden="true">{built ? "⚠" : "⇄"}</span> {fmtInt(inDecks)} in other {built ? "built " : ""}decks{inUseEur != null && inUseEur > 0 && !locked ? ` (${fmtEur(inUseEur)} to buy instead)` : ""}</span>
          </>}
          {locked > 0 && <>
            {" · "}
            <span className="locked-count"><span aria-hidden="true">🔒</span> {plural(locked, "card")} only in locked binders</span>
          </>}
        </span>
        <span className="small">
          {inDecks > 0 && (built ? "Shared copies: move them or buy extra to play both decks. " : "You own those; move them over when you build this deck. ")}
          {locked > 0 && "Locked binders keep their cards for their own deck; unlock the binder or move the cards to use them here. "}
          Maybeboard not counted.
        </span>
      </div>
    </div>
  );
}

/** Deck names as links (tap opens that deck). */
function DeckLinks({ decks, boxes, onOpenDeck, shared = false }) {
  const list = asList(decks);
  const boxList = asList(boxes);
  if (!list.length && !boxList.length) return null;
  return (
    <span className="sub">in {boxList.map((b, j) => (
      <React.Fragment key={`b${j}`}>{j > 0 && ", "}🔒 {b.binder}</React.Fragment>
    ))}{boxList.length > 0 && list.length > 0 && ", "}{list.map((d, j) => (
      <React.Fragment key={j}>{j > 0 && ", "}
        {onOpenDeck
          ? <button type="button" className="linkbtn" onClick={() => onOpenDeck(d.id)}>{d.name}</button>
          : d.name}
      </React.Fragment>
    ))}{shared ? " · conflict" : list.length ? " · can be moved" : " · locked"}</span>
  );
}

/**
 * Add shopping rows ({oracle_id?, name, qty}) to the wishlist: POST /api/wishlist by oracle id + name
 * (the server knows the deck printing's card row). Remembers which rows were added this time.
 */
function useWishAdd(onWishChanged) {
  const [added, setAdded] = useState(() => new Set());
  const [msg, setMsg] = useState(null);
  const keyOf = (it) => it.oracle_id || `name:${it.name}`;
  const add = async (list) => {
    let n = 0;
    const fails = [];
    const done = new Set(added);
    for (const it of list) {
      if (done.has(keyOf(it))) continue;
      try {
        await api("/api/wishlist", { method: "POST", json: { oracle_id: it.oracle_id || undefined, name: it.name, quantity: Math.max(1, Math.min(99, Number(it.qty) || 1)) } });
        done.add(keyOf(it));
        n++;
      } catch (e) { fails.push(`${it.name}: ${e.message}`); }
    }
    setAdded(done);
    setMsg(fails.length ? { error: `Could not add ${fails.join("; ")}` } : { text: n === 1 ? `Added ${list[0].name} to your wishlist.` : `Added ${plural(n, "card")} to your wishlist.` });
    if (n) onWishChanged?.();
  };
  const el = msg ? (msg.error ? <ErrorNotice error={msg.error} onDismiss={() => setMsg(null)} />
    : <div className="notice ok" role="status"><span aria-hidden="true">♥</span><div className="grow">{msg.text}</div>
      <button type="button" className="btn ghost icon sm" aria-label="Dismiss" onClick={() => setMsg(null)}><Icon.close /></button></div>) : null;
  return { add, isAdded: (it) => added.has(keyOf(it)), el };
}

/** What to buy for this deck (copies you don't own), plus the owned copies
 *  that sit in other built decks (move them, or buy extra). */
function DeckShopping({ deck, onOpenDeck, onWishChanged }) {
  const wish = useWishAdd(onWishChanged);
  const shopping = deck?.shopping;
  const items = asList(shopping?.items).map((x) => ({ ...x, qty: x.need }));
  const inUse = asList(shopping?.in_use).map((x) => ({ ...x, qty: x.quantity }));
  if (!items.length && !inUse.length) return null;
  const inUseCards = inUse.reduce((a, x) => a + x.qty, 0);
  const inUseTotal = shopping.in_use_eur;
  const built = deck?.status === "built";
  const anyBoxed = inUse.some((x) => x.in_box > 0);
  const boxedOnly = anyBoxed && inUse.every((x) => x.in_box >= x.quantity);
  return (
    <section className="stack" style={{ gap: 8 }} aria-labelledby="deck-shop-title">
      <h3 id="deck-shop-title" className="row" style={{ gap: 8 }}>To buy <span className="muted small">{items.length ? plural(items.reduce((a, x) => a + x.qty, 0), "card") : "nothing"}</span></h3>
      {items.length > 0
        ? <>
          <BuyList items={items} qtyKey="qty" total={shopping?.total_eur} onWish={(it) => wish.add([it])} isWished={wish.isAdded} />
          <div className="list-actions">
            {items.length > 1 && !items.every(wish.isAdded) && (
              <button type="button" className="btn sm" onClick={() => wish.add(items)}><Icon.heart /> Add all to wishlist</button>
            )}
            <a className="btn sm" href={`/api/decks/${deck.id}/to-buy`} download={`${deck.name} - to buy.txt`}><Icon.download /> Export list</a>
          </div>
          {wish.el}
        </>
        : <span className="small muted">You own every card. {built ? "Some copies are also claimed by other built decks." : "Some copies are in other decks."}</span>}
      {inUse.length > 0 && (
        <details className="disclosure inuse-list">
          <summary>
            <span>{built && !boxedOnly ? "Shared with other built decks" : boxedOnly ? "In locked binders" : anyBoxed ? "In other decks or locked binders" : "In other decks"}: {plural(inUseCards, "card")}{inUseTotal != null ? ` (buy instead: ${fmtEur(inUseTotal)})` : ""}</span>
          </summary>
          <span className="small muted">{built && !boxedOnly
            ? "You own these, but other built decks claim the copies. Move them between decks or buy extra copies to play all at once."
            : anyBoxed
              ? "You own these; they are in your built decks or in locked binders (kept for their own deck). Move them over, unlock the binder, or buy extra copies."
              : "You own these; they are in your built decks now. Move them over when you build this deck, or buy extra copies."}</span>
          <BuyList items={inUse} qtyKey="qty" total={inUseTotal} label="Buy instead"
            sub={(it) => <DeckLinks decks={it.quantity - it.in_box > 0 ? it.decks : []} boxes={it.in_box ? it.boxes : []}
              onOpenDeck={onOpenDeck} shared={it.conflict || (built && it.quantity - it.in_box > 0)} />} />
        </details>
      )}
    </section>
  );
}

/** POST /api/decks/:id/to-binder: gather the deck's owned copies into one binder. */
function DeckBoxSheet({ deck, pickedOnly = false, onClose, onDone }) {
  const [name, setName] = useState(deck.box_binder || `Deck box: ${deck.name}`.slice(0, 100));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [result, setResult] = useState(null);
  const [guarded, masterDialog] = useMasterConfirm();
  const submit = async (e) => {
    e.preventDefault();
    if (!name.trim() || busy) return;
    setBusy(true); setError(null);
    try {
      const res = await guarded((confirm) => api(`/api/decks/${deck.id}/to-binder`, { method: "POST", json: { binder: name.trim(), confirm_master: confirm, ...(pickedOnly ? { picked_only: true } : {}) } }));
      if (res) { setResult(res); onDone?.(res); }
    } catch (err) { setError(err.message); } finally { setBusy(false); }
  };
  const moved = asList(result?.moved);
  const missing = asList(result?.missing);
  return (
    <Sheet title={pickedOnly ? "Put picked cards into deck box" : "Put into deck box"} onClose={onClose}>
      {!result ? (
        <form className="stack" onSubmit={submit}>
          <p className="small" style={{ margin: 0 }}>
            {pickedOnly && <><b>Only the cards you ticked</b> move. </>}Moves the copies <b>{deck.name}</b> needs into one binder: first from {UNSORTED}, then from your other binders.
            Copies already in this binder{deck.source === "manabox" ? " or in the deck's own ManaBox binder" : ""} count as boxed;
            copies in another built deck's box stay where they are.
          </p>
          <div className="field">
            <label htmlFor="deckbox-name">Binder</label>
            <input id="deckbox-name" className="input" style={{ fontSize: 16 }} maxLength={100} required value={name} onChange={(e) => setName(e.target.value)} />
          </div>
          <ErrorNotice error={error} />
          <button type="submit" className="btn primary wrap" disabled={busy || !name.trim()}>{busy ? "Moving…" : <><Icon.box /> Move cards into “{name.trim() || "…"}”</>}</button>
        </form>
      ) : (
        <div className="stack">
          <div className="notice ok" role="status"><span aria-hidden="true">✓</span><div className="grow">
            Moved <b>{plural(result.moved_copies, "copy", "copies")}</b> to {result.binder}.
          </div></div>
          {moved.length > 0 && (
            <Collapsible label={`Moved: ${plural(moved.length, "card")}`}>
              <ul className="delta-list">
                {moved.map((m, i) => <li key={i}><b>{m.quantity}× </b>{m.name}{m.from.length > 0 && <span className="muted"> · from {m.from.map((f) => `${f.binder || UNSORTED}${m.from.length > 1 ? ` ${f.quantity}×` : ""}`).join(", ")}</span>}</li>)}
              </ul>
            </Collapsible>
          )}
          {asList(result?.removed).length > 0 && (
            <div className="notice warn" role="status"><span aria-hidden="true">↩</span><div className="grow">
              <b>Take out of the box: {plural(result.removed_copies, "copy", "copies")}</b>
              <span className="small"> (no longer in the deck, now in {UNSORTED})</span>
              <ul className="delta-list" style={{ marginTop: 4 }}>
                {asList(result.removed).map((m, i) => <li key={i}>{m.quantity}× {m.name}</li>)}
              </ul>
            </div></div>
          )}
          {missing.length > 0 ? (
            <div className="notice warn"><span aria-hidden="true">✗</span><div className="grow">
              <b>Still missing {plural(missing.length, "card")}:</b>
              <ul className="delta-list" style={{ marginTop: 4 }}>
                {missing.map((m, i) => <li key={i}>{m.quantity}× {m.name}</li>)}
              </ul>
            </div></div>
          ) : <span className="small muted">Every owned card the deck needs is in the deck box now.</span>}
          <button type="button" className="btn primary" onClick={onClose}>Done</button>
        </div>
      )}
      {masterDialog}
    </Sheet>
  );
}
