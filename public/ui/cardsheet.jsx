"use strict";

// ===========================================================================
// Card detail sheet
// ===========================================================================

/** "owned 1 · used in 3 decks (2 built) · 1 short" */
function CardUsage({ usage }) {
  if (!usage || typeof usage !== "object" || usage.owned == null) return null;
  const decks = asList(usage.decks);
  const ids = new Set(decks.map((d) => d.id));
  const built = new Set(decks.filter((d) => d.status === "built").map((d) => d.id));
  const { available } = usage;
  return (
    <div className="usage-line" aria-label="Copies and decks">
      <span>owned <b>{fmtInt(usage.owned)}</b></span>
      {ids.size > 0 && <span className="muted">· used in {plural(ids.size, "deck")}{built.size ? ` (${fmtInt(built.size)} built)` : ""}</span>}
      {usage.boxed > 0 && <span className="muted">· 🔒 {fmtInt(usage.boxed)} in locked binders</span>}
      {available < 0
        ? <span className="badge bad">{fmtInt(-available)} short</span>
        : (usage.built_demand > 0 || usage.boxed > 0) && <span className="badge ok">{fmtInt(available)} free</span>}
    </div>
  );
}

const LEGAL_FORMATS = [
  ["commander", "Commander"], ["standard", "Standard"], ["pioneer", "Pioneer"], ["modern", "Modern"],
  ["legacy", "Legacy"], ["vintage", "Vintage"], ["pauper", "Pauper"], ["brawl", "Brawl"],
];
const PRICE_KEYS = [
  ["eur", "EUR", "€"], ["eur_foil", "EUR foil", "€"], ["eur_etched", "EUR etched", "€"],
  ["usd", "USD", "$"], ["usd_foil", "USD foil", "$"], ["usd_etched", "USD etched", "$"],
];

// Own price, else (EUR only) the English twin's `*_en` key the server copies in.
const priceOf = (prices, k) => prices?.[k] ?? (k.startsWith("eur") ? prices?.[`${k}_en`] : null) ?? null;

function CardSheet({ id, onClose, onOpenCard, onOpenDeck, onChanged, onWishChanged }) {
  const [wishing, setWishing] = useState(false); // WishSheet open
  const [wished, setWished] = useState(null); // confirmation text
  const [deckAdding, setDeckAdding] = useState(false); // AddToDeckSheet open
  const [deckAdded, setDeckAdded] = useState(null); // confirmation text
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [attempt, setAttempt] = useState(0);
  const [moveRow, setMoveRow] = useState(null); // an owned row to move
  const [moved, setMoved] = useState(null); // confirmation text
  const [editRow, setEditRow] = useState(null); // an owned row to edit (EditCopySheet)
  const [deleteRow, setDeleteRow] = useState(null); // an owned row to delete (DeleteCopySheet)
  const [guarded, masterDialog] = useMasterConfirm();
  const [showToast, toastEl] = useEditToast(() => { setAttempt((a) => a + 1); onChanged?.(); }, { portal: true });
  const afterEdit = (text, editId) => {
    setEditRow(null); setDeleteRow(null); setMoved(null);
    showToast({ text, editId });
    setAttempt((a) => a + 1);
    onChanged?.();
  };
  useEffect(() => {
    let alive = true;
    setError(null);
    api(`/api/cards/${encodeURIComponent(id)}`)
      .then((d) => { if (alive) setData(d); })
      .catch((e) => { if (alive) setError(e.message); });
    return () => { alive = false; };
  }, [id, attempt]);

  const card = data?.card;
  const loadingOther = Boolean(data && data.card.scryfall_id !== id && !error);
  const totalOwned = data ? data.owned.reduce((a, r) => a + r.quantity, 0) : 0;
  // usage.decks: every deck holding the card, with its status.
  const inDecks = data ? asList(data.usage.decks) : [];

  return (
    <Sheet title={card ? card.name : error ? "Card" : "Loading…"} onClose={onClose}
      actions={card?.scryfall_uri && (
        <a className="btn ghost icon" href={card.scryfall_uri} target="_blank" rel="noopener noreferrer" aria-label="Open on Scryfall" title="Open on Scryfall"><Icon.external /></a>
      )}>
      {error && <ErrorNotice error={error} onRetry={() => setAttempt((a) => a + 1)} />}
      {!data && !error && <Spinner />}
      {card && (
        <div className="card-detail" aria-busy={loadingOther || undefined}>
          <div>
            {card.image_normal
              ? <img className="big" src={card.image_normal} alt={card.name} />
              : <div className="big" role="img" aria-label="No image available" />}
          </div>
          <div className="stack-lg">
            <div className="stack">
              <div className="row between">
                <ManaCost cost={card.mana_cost} />
                <span className="row">
                  {card.rarity && <span className="badge">{card.rarity}</span>}
                  <span className={`badge ${totalOwned ? "ok" : "bad"}`}>{totalOwned ? `✓ own ${totalOwned}` : "✗ not owned"}</span>
                </span>
              </div>
              <div><b>{card.type_line}</b></div>
              <CardUsage usage={data.usage} />
              <div className="oracle"><OracleText text={card.oracle_text} /></div>
              <dl className="kv">
                <dt>Printing</dt>
                <dd>{card.set_name} <span className="muted">({setNumberOf(card)})</span></dd>
                <dt>Mana value</dt><dd>{card.cmc ?? "—"}</dd>
                {card.keywords?.length > 0 && (<><dt>Keywords</dt><dd>{card.keywords.join(", ")}</dd></>)}
              </dl>
            </div>

            <section className="stack" aria-label="Prices">
              <h3>Prices</h3>
              <div className="row">
                {PRICE_KEYS.filter(([k]) => priceOf(card.prices, k) != null).map(([k, label, sym]) => (
                  <span key={k} className="badge accent" title={card.prices?.[k] == null ? "Price of the English printing (same set and number)" : undefined}>
                    {label}{card.prices?.[k] == null ? " (EN)" : ""} {sym}{Number(priceOf(card.prices, k)).toFixed(2)}
                  </span>
                ))}
                {!PRICE_KEYS.some(([k]) => priceOf(card.prices, k) != null) && <span className="muted">No price data.</span>}
              </div>
              <div className="row">
                <button type="button" className="btn sm" onClick={() => { setWished(null); setWishing(true); }}><Icon.heart /> Wishlist</button>
                <button type="button" className="btn sm" onClick={() => { setDeckAdded(null); setDeckAdding(true); }}><Icon.plus /> Add to deck</button>
                {wished && <span className="small" role="status" style={{ color: "var(--ok)" }}>♥ {wished}</span>}
                {deckAdded && <span className="small" role="status" style={{ color: "var(--ok)" }}>✓ {deckAdded}</span>}
              </div>
            </section>

            <section className="stack" aria-label="Format legality">
              <h3>Legality</h3>
              <div className="legal">
                {LEGAL_FORMATS.map(([k, label]) => {
                  const s = card.legalities?.[k];
                  const ok = s === "legal" || s === "restricted";
                  return <span key={k} className={`badge ${ok ? "ok" : ""}`} title={s || "unknown"}>{ok ? "✓" : "✗"} {label}{s === "restricted" ? " (R)" : ""}</span>;
                })}
              </div>
            </section>

            <section className="stack">
              <h3>Owned printings <span className="muted small">({plural(totalOwned, "copy", "copies")})</span></h3>
              {data.owned.length === 0
                ? <p className="muted" style={{ margin: 0 }}>You don't own any printing of this card.</p>
                : (
                  <div className="table-wrap">
                    <table className="t">
                      <thead><tr><th><span className="sr-only">Actions</span></th><th>Set</th><th>Finish</th><th>Lang</th><th>Condition</th><th>Binder</th>{data.owned.some((r) => r.source) && <th>Source</th>}<th className="num">Qty</th></tr></thead>
                      <tbody>
                        {data.owned.map((r, i) => (
                          <tr key={r.id ?? i} aria-current={r.scryfall_id === id || undefined}>
                            <td style={{ paddingRight: 0 }}><div className="row-acts">
                              <button type="button" className="btn sm move-btn" onClick={() => { setMoved(null); setMoveRow(r); }}
                                aria-label={`Move ${r.quantity > 1 ? "copies" : "copy"} of ${setNumberOf(r)} in ${r.binder || "Unsorted"} to another binder`}>Move…</button>
                              <button type="button" className="btn sm" onClick={() => { setMoved(null); setEditRow(r); }}
                                aria-label={`Edit ${r.quantity > 1 ? "copies" : "copy"} of ${setNumberOf(r)} in ${r.binder || "Unsorted"}`}><Icon.edit /> Edit…</button>
                              <button type="button" className="btn sm danger" onClick={() => { setMoved(null); setDeleteRow(r); }}
                                aria-label={`Delete ${r.quantity > 1 ? "copies" : "copy"} of ${setNumberOf(r)} in ${r.binder || "Unsorted"}`}><Icon.trash /> Delete…</button>
                            </div></td>
                            <td>
                              {r.scryfall_id === id
                                ? <b title={r.set_name}>{setNumberOf(r)}</b>
                                : <button type="button" className="linkbtn" title={`Show ${r.set_name}`} onClick={() => onOpenCard(r.scryfall_id)}>{setNumberOf(r)}</button>}
                            </td>
                            <td>{r.finish === "normal" ? "—" : r.finish}</td>
                            <td>{r.language && r.language !== "en" ? <LangTag lang={r.language} /> : <span className="muted">EN</span>}</td>
                            <td>{conditionLabel(r.condition)}</td>
                            <td>{r.binder || <span className="muted">Unsorted</span>}</td>
                            {data.owned.some((x) => x.source) && <td>{r.source ? <SourceBadge source={r.source} /> : "—"}</td>}
                            <td className="num"><b>{r.quantity}</b></td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              {moved && <div className="notice ok" role="status"><span aria-hidden="true">✓</span><div className="grow">{moved}</div></div>}
            </section>

            <section className="stack">
              <h3>In decks</h3>
              {inDecks.length === 0
                ? <p className="muted" style={{ margin: 0 }}>Not in any deck.</p>
                : (
                  <ul style={{ margin: 0, paddingLeft: 18, display: "grid", gap: 2 }}>
                    {inDecks.map((d) => (
                      <li key={`${d.id}-${d.board}`}>
                        <button type="button" className="linkbtn" onClick={() => onOpenDeck(d.id)}>{d.name}</button>
                        <span className="muted"> · {d.quantity}× {d.board}</span>
                        {d.status && <> <StatusBadge status={d.status} /></>}
                      </li>
                    ))}
                  </ul>
                )}
            </section>

            {card.scryfall_uri && (
              <a className="btn" href={card.scryfall_uri} target="_blank" rel="noopener noreferrer"><Icon.external /> View on Scryfall</a>
            )}
          </div>
        </div>
      )}
      {moveRow && card && (
        <MoveSheet title={`Move ${card.name}`} maxQty={moveRow.quantity} exclude={moveRow.binder}
          intro={<span className="small muted">{setNumberOf(moveRow)} · {moveRow.finish === "normal" ? "non-foil" : moveRow.finish} · {(moveRow.language || "").toUpperCase()} · {conditionLabel(moveRow.condition)} · from <b>{moveRow.binder || "Unsorted"}</b></span>}
          onClose={() => setMoveRow(null)}
          onMove={async ({ quantity, to_binder, create }) => {
            const item = { scryfall_id: moveRow.scryfall_id, finish: moveRow.finish, language: moveRow.language, condition: moveRow.condition, binder: moveRow.binder, source: moveRow.source, quantity };
            const res = await guarded((confirm) => api("/api/collection/move", { method: "POST", json: { items: [item], to_binder, create, confirm_master: confirm } }));
            if (!res) return false;
            setMoveRow(null);
            setMoved(`Moved ${plural(res.moved_copies, "copy", "copies")} to ${res.to_binder || "Unsorted"}.`);
            setAttempt((a) => a + 1);
            onChanged?.();
            return true;
          }} />
      )}
      {editRow && card && (
        <EditCopySheet card={card} row={editRow} onClose={() => setEditRow(null)}
          onDone={(res) => afterEdit(`Edited ${plural(res?.edited_copies ?? editRow.quantity, "copy", "copies")}.`, res?.edit_id)} />
      )}
      {deleteRow && card && (
        <DeleteCopySheet card={card} row={deleteRow} onClose={() => setDeleteRow(null)}
          onDone={(res, n) => afterEdit(`Deleted ${plural(res?.deleted_copies ?? n, "copy", "copies")}.`, res?.edit_id)} />
      )}
      {wishing && card && (
        <WishSheet card={{ scryfall_id: card.scryfall_id, oracle_id: card.oracle_id, name: card.name, set_code: card.set_code, collector_number: card.collector_number }}
          onClose={() => setWishing(false)}
          onDone={(res) => { setWishing(false); setWished(res?.merged ? `On your wishlist: ${res.item.quantity} wanted` : "Added to your wishlist"); onWishChanged?.(); }} />
      )}
      {deckAdding && card && (
        <AddToDeckSheet card={{ scryfall_id: card.scryfall_id, name: card.name, set_code: card.set_code, collector_number: card.collector_number }}
          onClose={() => setDeckAdding(false)}
          onDone={(res, deck) => { setDeckAdding(false); setDeckAdded(`Added to ${deck.name}`); onChanged?.(); }} />
      )}
      {masterDialog}
      {toastEl}
    </Sheet>
  );
}
