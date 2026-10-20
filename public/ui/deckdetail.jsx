"use strict";

function DeckDetail({ id, dataVersion, initialNotice, onBack, onMissing = null, onOpenCard, onOpenDeck, onAsk, onChanged, onCollectionChanged = onChanged, onWishChanged }) {
  const [deck, setDeck] = useState(null);
  const [error, setError] = useState(null);
  const [actionError, setActionError] = useState(null);
  const [notice, setNotice] = useState(initialNotice);
  // The hash router may mount the page a render before openDeck's notice arrives.
  useEffect(() => { if (initialNotice) setNotice(initialNotice); }, [initialNotice]);
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState({ name: "", format: "", description: "" });
  const [saving, setSaving] = useState(false);
  const [onlyMissing, setOnlyMissing] = useState(false);
  const [actionCard, setActionCard] = useState(null); // {board, name}
  const [cardBusy, setCardBusy] = useState(false);
  const [cardError, setCardError] = useState(null);
  const [statusBusy, setStatusBusy] = useState(false);
  const [deckBox, setDeckBox] = useState(false);
  const [powerOpen, setPowerOpen] = useState(false);
  const [buildOpen, setBuildOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [guideOpen, setGuideOpen] = useState(false);
  const [panel, setPanel] = useState(null); // value | stats | extras pop-up
  const [moreAnchor, setMoreAnchor] = useState(null);
  const closeMore = useCallback(() => setMoreAnchor(null), []);
  const [adding, setAdding] = useState(null); // null | "pick" | {card}
  const [selecting, setSelecting] = useState(false);
  const [selected, setSelected] = useState(() => new Set()); // `${board}|${name}`
  const [bulkBusy, setBulkBusy] = useState(false);
  const [moveOpen, setMoveOpen] = useState(false);
  const [toast, setToast] = useState(null);

  const load = useCallback(() => {
    setError(null);
    api(`/api/decks/${id}`).then(setDeck).catch((e) => {
      // A link to a deleted deck (#decks/<id>) lands on the deck list.
      if (e.status === 404 && onMissing) onMissing();
      else setError(e.status === 404 ? "This deck no longer exists." : e.message);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);
  useEffect(load, [load, dataVersion]); // also after the planner saved this deck
  useEffect(() => {
    if (!deck?.guide?.pending || guideOpen) return undefined;
    const t = setTimeout(load, 5000);
    return () => clearTimeout(t);
  }, [deck, guideOpen, load]);
  // Combos still pending (the server fetches them in the background): look again after 4 s, at most twice per deck.
  const pendingTries = useRef({ id, n: 0 });
  const combosPending = deck?.id === id && (deck?.combos?.status === "pending" || deck?.accessories?.status === "pending");
  useEffect(() => {
    if (pendingTries.current.id !== id) pendingTries.current = { id, n: 0 };
    if (!combosPending || pendingTries.current.n >= 2) return undefined;
    pendingTries.current.n += 1;
    const t = setTimeout(load, 4000);
    return () => clearTimeout(t);
  }, [combosPending, deck, id, load]);

  const startEdit = () => {
    setForm({ name: deck.name, format: deck.format || "", description: deck.description || "" });
    setEditing(true);
  };
  const saveEdit = async (e) => {
    e.preventDefault();
    if (!form.name.trim()) return;
    setSaving(true);
    setActionError(null);
    try {
      const updated = await api(`/api/decks/${id}`, { method: "PATCH", json: { name: form.name.trim(), format: form.format || "", description: form.description } });
      setDeck((d) => ({ ...d, ...updated }));
      setEditing(false);
      onChanged();
    } catch (err) {
      setActionError(err.message);
    } finally {
      setSaving(false);
    }
  };
  const [favBusy, setFavBusy] = useState(false);
  const toggleFavorite = async () => {
    if (!deck || favBusy) return;
    const next = !deck.favorite;
    setFavBusy(true);
    setDeck((d) => (d ? { ...d, favorite: next } : d));
    try {
      await api(`/api/decks/${deck.id}`, { method: "PATCH", json: { favorite: next } });
      onChanged?.();
    } catch (e) {
      setDeck((d) => (d ? { ...d, favorite: !next } : d));
      setActionError(e.message);
    } finally { setFavBusy(false); }
  };
  const setStatus = async (status) => {
    if (!deck || deck.status === status || statusBusy) return;
    if (status === "built") {
      // Cards this idea deck shares with built decks turn into conflicts: owned copies in use,
      // and shared cards nobody has enough of (same rule as the server's conflict flag).
      const n = deckCounts(deck).inUse;
      const conflicting = new Map();
      for (const c of asList(deck.cards)) {
        if (!c || c.basic || c.board === "maybe") continue;
        const elsewhere = builtElsewhereOf(c);
        if (elsewhere.length && (cardInUse(c) > 0 || cardToBuy(c) > 0)) conflicting.set(c.name, elsewhere);
      }
      if (n > 0 || conflicting.size > 0) {
        const names = [...conflicting.keys()];
        const list = names.slice(0, 5).join(", ") + (names.length > 5 ? ", …" : "");
        const where = deckNames([...conflicting.values()].flat());
        const k = conflicting.size;
        const head = n > 0
          ? `${n === 1 ? "1 card is" : `${n} cards are`} in use in other built decks${where ? ` (${where})` : ""}.`
          : `This deck shares cards with other built decks${where ? ` (${where})` : ""}.`;
        if (!window.confirm(`${head}\n\nAs a built deck, ${k === 1 ? "1 card" : `${k} cards`} will show as conflicts${list ? ` (${list})` : ""} until you move or buy copies. Set to Built?`)) return;
      }
    }
    setStatusBusy(true);
    setActionError(null);
    try {
      await api(`/api/decks/${id}`, { method: "PATCH", json: { status } });
      setDeck((d) => ({ ...d, status }));
      load(); // conflicts and free copies change with the status
      onCollectionChanged(); // avail:/used: and card usage in the other tabs too
    } catch (err) {
      setActionError(err.message);
    } finally {
      setStatusBusy(false);
    }
  };
  const remove = async () => {
    if (!window.confirm(`Delete the deck "${deck.name}"? This cannot be undone. Your collection is not affected.`)) return;
    setActionError(null);
    try {
      await api(`/api/decks/${id}`, { method: "DELETE" });
      onChanged();
      onBack();
    } catch (err) {
      setActionError(err.message);
    }
  };

  // Free editing (0.9.0): Add card (picker → AddToDeckSheet) and Select → Remove / Move to.
  const rowKey = (c) => `${c.board}|${c.name}`;
  const stopSelecting = () => { setSelecting(false); setSelected(new Set()); setMoveOpen(false); };
  const toggleSelected = (c) => setSelected((cur) => {
    const next = new Set(cur);
    if (next.has(rowKey(c))) next.delete(rowKey(c)); else next.add(rowKey(c));
    return next;
  });
  const showToast = (text) => { setToast(text); setTimeout(() => setToast((t) => (t === text ? null : t)), 4000); };
  const runBulk = async (action, toBoard = null) => {
    const rows = (deck?.cards || []).filter((c) => selected.has(rowKey(c)));
    if (!rows.length) return;
    const copies = rows.reduce((a, c) => a + c.quantity, 0);
    if (action === "remove" && !window.confirm(`Remove ${plural(rows.length, "card")} (${plural(copies, "copy", "copies")}) from "${deck.name}"? History keeps the old list.`)) return;
    setBulkBusy(true);
    setActionError(null);
    try {
      const res = await api(`/api/decks/${id}/cards/bulk`, { method: "POST", json: {
        action, to_board: toBoard, items: rows.map((c) => ({ name: c.name, board: c.board })) } });
      if (res && Array.isArray(res.cards)) setDeck(res); else load();
      stopSelecting();
      showToast(action === "remove"
        ? `Removed ${plural(res?.change?.rows ?? rows.length, "card")}.`
        : `Moved ${plural(res?.change?.rows ?? rows.length, "card")} to ${BOARD_LABEL[toBoard]}.`);
      onChanged();
    } catch (err) {
      setActionError(err.message);
      setMoveOpen(false);
    } finally {
      setBulkBusy(false);
    }
  };
  const afterAdd = (res) => {
    setAdding(null);
    if (res && Array.isArray(res.cards)) setDeck(res); else load();
    const c = res?.change;
    if (c) showToast(`Added ${c.added}× ${c.name} to ${BOARD_LABEL[c.board] || c.board}.`);
    onChanged();
  };

  // Card edits (board moves, quantity, commander). The answer is the updated
  // deck when the server sends one; otherwise the deck is reloaded.
  const runCardAction = async (path, method, json, kind) => {
    setCardBusy(true);
    setCardError(null);
    try {
      const res = await api(path, { method, json });
      const next = res && Array.isArray(res.cards) ? res : res && Array.isArray(res.deck?.cards) ? res.deck : null;
      if (next) setDeck(next);
      else load();
      if (kind !== "qty") setActionCard(null);
      else if (next) {
        const c = next.cards.find((x) => x.board === json.board && x.name === json.name);
        setActionCard(c ? { board: c.board, name: c.name } : null);
      }
      onChanged();
    } catch (err) {
      if (kind === "suggest") setActionError(err.message);
      else setCardError(err.message);
    } finally {
      setCardBusy(false);
    }
  };
  const [actionAnchor, setActionAnchor] = useState(null);
  const openActions = (c, anchor = null) => { setCardError(null); setActionAnchor(anchor); setActionCard({ board: c.board, name: c.name }); };
  const closeActions = useCallback(() => setActionCard(null), []);
  const actionTarget = actionCard && deck?.cards.find((c) => c.board === actionCard.board && c.name === actionCard.name);
  const suggestions = commanderSuggestions(deck);
  const needsCommander = deck && (isCommanderFormat(deck) || Array.isArray(deck.commander_suggestions)) && !hasCommander(deck);

  const grouped = useMemo(() => {
    if (!deck) return [];
    return ["commander", "main", "side", "maybe"].map((board) => {
      const cards = deck.cards.filter((c) => c.board === board && (!onlyMissing || cardToBuy(c) > 0 || cardInUse(c) > 0));
      const byType = DISPLAY_TYPES.map((t) => ({ type: t, cards: cards.filter((c) => mainType(c.type_line) === t) }))
        .filter((g) => g.cards.length);
      return { board, count: deck.counts?.[board] ?? 0, cards, byType };
    }).filter((b) => b.cards.length);
  }, [deck, onlyMissing]);

  const exportHref = `/api/decks/${id}/export`;
  const counts = deckCounts(deck);
  const visibleKeys = grouped.flatMap((b) => b.cards.map(rowKey));
  const allVisibleSelected = visibleKeys.length > 0 && visibleKeys.every((k) => selected.has(k));

  return (
    <div className="stack-lg">
      <div>
        <button type="button" className="btn ghost" onClick={onBack} style={{ marginLeft: -8 }}><Icon.back /> All decks</button>
      </div>
      {error && <ErrorNotice error={error} onRetry={load} />}
      {!deck && !error && <Spinner label="Loading deck…" />}
      {deck && (
        <>
          <header className="deck-head">
            {!editing ? (
              <>
                <div className="deck-title">
                  <DeckCover cover={deck.cover} banner={false} />
                  <h2>{deck.name}</h2>
                  <ShareButton title={deck.name} hash={deckHash(deck.id)} />
                  <FavButton on={Boolean(deck.favorite)} busy={favBusy} label={deck.name} onToggle={toggleFavorite} />
                </div>
                <div className="row small deck-meta">
                  {(deck.status === "idea" || deck.status === "built") && (
                    <div className="segmented status-toggle sm" role="group" aria-label="Deck status"
                      title={deck.status === "built" ? "Built: this deck claims its cards. Other decks see them as used." : "Idea: doesn't claim cards. Shows what you own and what's free."}>
                      <button type="button" aria-pressed={deck.status === "idea"} disabled={statusBusy} onClick={() => setStatus("idea")}>Idea</button>
                      <button type="button" aria-pressed={deck.status === "built"} disabled={statusBusy} onClick={() => setStatus("built")}>Built</button>
                    </div>
                  )}
                  {deck.format && <span className="badge">{deck.format}</span>}
                  <SourceBadge source={deck.source} />
                  <span className="muted">updated {fmtAgo(deck.updated_at)}</span>
                </div>
                <div className="deck-chips">
                  <button type="button" className="chip-btn" onClick={() => setPanel("value")} aria-label="Cards and value: show details">
                    <Icon.cart /> {plural(deck.stats?.total ?? ((deck.counts?.commander ?? 0) + (deck.counts?.main ?? 0)), "card")}{deck.value?.total_eur != null ? ` · ${fmtEur(deck.value.total_eur)}` : ""}{deck.value?.to_buy_eur > 0 ? ` · ${fmtEur(deck.value.to_buy_eur)} to buy` : ""}
                  </button>
                  <PowerBadges deck={deck} onOpen={() => setPowerOpen(true)} />
                  {deck.stats && <button type="button" className="chip-btn" onClick={() => setPanel("stats")}><Icon.chart /> Stats</button>}
                  {deck.box?.binder && (
                    <a className="chip-btn" href={collectionHash({ view: "binder", binder: deck.box.binder })} title={`Deck box: ${deck.box.binder} (its cards are kept for this deck)`}
                      aria-label={`Deck box: ${deck.box.binder}`}><Icon.lock /> Deck box</a>
                  )}
                  {extrasSummary(deck) && <button type="button" className="chip-btn" onClick={() => setPanel("extras")}><Icon.grid /> {extrasSummary(deck)}</button>}
                  {deck.guide?.id && (
                    <span className="chip-pair">
                      <button type="button" className="chip-btn" onClick={() => setGuideOpen(true)}><Icon.file /> Guide{deck.guide.stale ? " ·  old" : ""}</button>
                      <a className="chip-btn icon" href={`/api/decks/${deck.id}/guide.pdf`} download aria-label="Download the guide as PDF" title="Download the guide as PDF"><Icon.download /></a>
                    </span>
                  )}
                  {deck.guide?.pending && <span className="chip-btn static"><Spinner label="" /> Guide…</span>}
                </div>
                {deck.description && <DeckNotes text={deck.description} />}
              </>
            ) : (
              <form className="card stack" onSubmit={saveEdit} aria-label="Edit deck">
                <div className="field">
                  <label htmlFor="edit-name">Name</label>
                  <input id="edit-name" className="input" required maxLength={200} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} autoFocus />
                </div>
                <div className="field">
                  <label htmlFor="edit-format">Format</label>
                  <select id="edit-format" className="select" value={form.format} onChange={(e) => setForm({ ...form, format: e.target.value })}>
                    <option value="">—</option>
                    {[...new Set([...FORMATS, form.format].filter(Boolean))].map((f) => <option key={f} value={f}>{cap(f)}</option>)}
                  </select>
                </div>
                <div className="field">
                  <label htmlFor="edit-desc">Notes</label>
                  <textarea id="edit-desc" className="input" rows={6} maxLength={5000} value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} aria-describedby="edit-desc-hint" />
                  <span id="edit-desc-hint" className="small muted">Markdown: **bold**, - lists, ## headings, {"{G}"} for mana. Claude can update them too.</span>
                </div>
                <div className="row">
                  <button type="submit" className="btn primary" disabled={saving || !form.name.trim()}>{saving ? "Saving…" : "Save"}</button>
                  <button type="button" className="btn ghost" onClick={() => setEditing(false)}>Cancel</button>
                </div>
              </form>
            )}
            <ConflictBanner deck={deck} onOpenDeck={onOpenDeck} />
            {needsCommander && (
              <div className="notice warn" role="status">
                <span aria-hidden="true">♛</span>
                <div className="grow stack" style={{ gap: 8 }}>
                  <b>No commander set</b>
                  {suggestions.length > 0 ? (
                    <>
                      <span className="small">Tap a card from this deck to make it the commander:</span>
                      <div className="chips cmd-suggest">
                        {suggestions.map((sg) => (
                          <button key={sg.name} type="button" className="chip" disabled={cardBusy}
                            onClick={() => runCardAction(`/api/decks/${id}/commander`, "POST", { name: sg.name }, "suggest")}>
                            <Icon.crown /> {sg.name}
                          </button>
                        ))}
                      </div>
                    </>
                  ) : <span className="small">Use the <b>⋯</b> button next to a card to set it as the commander.</span>}
                </div>
              </div>
            )}
            <DeckNeedNotice deck={deck} />
            <div className="icon-bar" role="toolbar" aria-label="Deck actions">
              <IconBtn primary icon={Icon.sparkle} label="Ask the planner about this deck" onClick={() => onAsk(deck)} />
              {deck.cards.length > 0 && <IconBtn icon={Icon.file} label={deck.guide?.id ? "Deck guide" : "Write a deck guide"} dot={Boolean(deck.guide?.id)} onClick={() => setGuideOpen(true)} />}
              {deck.cards.length > 0 && <IconBtn icon={Icon.checklist} label="Build list" onClick={() => setBuildOpen(true)} />}
              <IconBtn icon={Icon.history} label="History" onClick={() => setHistoryOpen(true)} />
              {!editing && <IconBtn icon={Icon.edit} label="Edit name, format and notes" onClick={startEdit} />}
              <IconBtn icon={Icon.more} label="More deck actions" onClick={(e) => setMoreAnchor(moreAnchor ? null : e.currentTarget)} />
            </div>
            {moreAnchor && (
              <PopMenu anchor={moreAnchor} onClose={closeMore} label="More deck actions">
                {deck.status === "built" && <button type="button" role="menuitem" className="menu-item" onClick={() => { closeMore(); setDeckBox(true); }}><Icon.box /> Put into deck box</button>}
                <a role="menuitem" className="menu-item" href={exportHref} download onClick={closeMore}><Icon.download /> Export decklist</a>
                <button type="button" role="menuitem" className="menu-item danger" onClick={() => { closeMore(); remove(); }}><Icon.trash /> Delete deck</button>
              </PopMenu>
            )}
            <ErrorNotice error={actionError} onDismiss={() => setActionError(null)} />
            {notice && <div className="notice warn" role="status"><div className="grow">{notice}</div><button type="button" className="btn ghost icon sm" aria-label="Dismiss" onClick={() => setNotice(null)}><Icon.close /></button></div>}
          </header>

          <DeckShopping deck={deck} onOpenDeck={onOpenDeck} onWishChanged={onWishChanged} />

          <div className="cards-bar" role="toolbar" aria-label="Cards">
            <span className="grow small muted">{plural(deck.cards.reduce((a, c) => a + (c.quantity || 0), 0), "card")}</span>
            {deck.cards.length > 0 && (counts.toBuy > 0 || counts.inUse > 0) && (
              <IconBtn icon={Icon.filter} pressed={onlyMissing} onClick={() => setOnlyMissing(!onlyMissing)}
                label={counts.inUse > 0 ? "Only cards to buy or in other decks" : "Only cards to buy"} />
            )}
            {deck.cards.length > 0 && (
              <IconBtn icon={Icon.check} pressed={selecting} label={selecting ? "Done selecting" : "Select cards"}
                onClick={() => (selecting ? stopSelecting() : setSelecting(true))} />
            )}
            <IconBtn primary icon={Icon.plus} label="Add card" onClick={() => setAdding("pick")} />
          </div>
          {onlyMissing && <p className="small muted" style={{ margin: 0 }}>Showing only cards {counts.inUse > 0 ? "to buy or in other decks" : "to buy"}.</p>}

          {deck.cards.length === 0 && <div className="empty"><h3>This deck is empty</h3></div>}

          {grouped.map((b) => (
            <section key={b.board} className="board" aria-label={BOARD_LABEL[b.board]}>
              <h3>{BOARD_LABEL[b.board]} <span className="muted small">{b.count}</span></h3>
              <div className="deck-section">
                {b.byType.map((g) => (
                  <div key={g.type} className="type-group">
                    <h4>{g.type} ({g.cards.reduce((a, c) => a + c.quantity, 0)})</h4>
                    {g.cards.map((c) => <DeckCardRow key={`${c.board}|${c.name}`} card={c} onOpenCard={onOpenCard} onActions={openActions}
                      selecting={selecting} selected={selected.has(rowKey(c))} onToggle={() => toggleSelected(c)} />)}
                  </div>
                ))}
              </div>
            </section>
          ))}
          {selecting && (
            <div className="commit-bar" role="region" aria-label="Selection">
              <span className="grow small">{selected.size ? `${selected.size} selected` : "Tap cards to select"}</span>
              <button type="button" className="btn ghost" onClick={() => setSelected(allVisibleSelected ? new Set() : new Set(visibleKeys))}>
                {allVisibleSelected ? "None" : "All"}</button>
              <button type="button" className="btn danger" disabled={!selected.size || bulkBusy} onClick={() => runBulk("remove")} aria-label="Remove the selected cards from the deck">
                <Icon.trash /><span className="sel-del-label"> Remove</span></button>
              <button type="button" className="btn primary" disabled={!selected.size || bulkBusy} onClick={() => setMoveOpen(true)} aria-label="Move the selected cards to another board">Move…</button>
            </div>
          )}
          {toast && <div className="toast" role="status">{toast}</div>}
          {moveOpen && <DeckMoveSheet count={selected.size} busy={bulkBusy} onClose={() => setMoveOpen(false)} onPick={(b) => runBulk("move", b)} />}
          {adding === "pick" && (
            <PrintingPicker title={`Add to ${deck.name}`} startInSearch onClose={() => setAdding(null)}
              onPick={(p) => setAdding({ card: { scryfall_id: p.id, name: p.en_name || p.name, set_code: p.set, collector_number: p.cn } })} />
          )}
          {adding?.card && <AddToDeckSheet card={adding.card} deck={deck} onClose={() => setAdding(null)} onDone={afterAdd} />}
          {actionTarget && (
            <CardActionsMenu deck={deck} card={actionTarget} anchor={actionAnchor} busy={cardBusy} error={cardError}
              onRun={runCardAction} onOpenCard={(cid) => { setActionCard(null); onOpenCard(cid); }}
              onClose={closeActions} />
          )}
          {powerOpen && <PowerSheet deck={deck} onClose={() => setPowerOpen(false)} onChanged={() => { load(); onChanged(); }} />}
          {deckBox && <DeckBoxSheet deck={deck} onClose={() => setDeckBox(false)} onDone={() => { load(); onCollectionChanged(); }} />}
          {buildOpen && <BuildSheet deck={deck} onClose={() => { setBuildOpen(false); load(); }} onSetBuilt={() => setStatus("built")}
            onCollectionChanged={() => { load(); onCollectionChanged(); }} onOpenCard={onOpenCard} />}
          {panel === "value" && <DeckValueSheet deck={deck} onClose={() => setPanel(null)} />}
          {panel === "stats" && <DeckStats deck={deck} onClose={() => setPanel(null)} />}
          {panel === "extras" && <DeckExtras deck={deck} onClose={() => setPanel(null)} />}
          {guideOpen && <GuideSheet deck={deck} onClose={() => { setGuideOpen(false); load(); }} />}
          {historyOpen && <HistorySheet deck={deck} onClose={() => setHistoryOpen(false)}
            onRestored={(res) => { if (res && Array.isArray(res.cards)) setDeck(res); else load(); onChanged(); }} />}
        </>
      )}
    </div>
  );
}

function DecksTab({ dataVersion, deckId, deckNotice, onOpenDeck, onOpenCard, onAsk, onChanged, onCollectionChanged, onWishChanged }) {
  const [listKey, bumpList] = useReducer((x) => x + 1, 0);
  if (deckId) {
    return (
      <DeckDetail key={deckId} id={deckId} dataVersion={dataVersion} initialNotice={deckNotice} onBack={() => { onOpenDeck(null); bumpList(); }}
        onMissing={() => onOpenDeck(null, "Deck not found. It may have been deleted.", { replace: true })}
        onOpenCard={onOpenCard} onOpenDeck={onOpenDeck} onAsk={onAsk} onChanged={onChanged} onCollectionChanged={onCollectionChanged} onWishChanged={onWishChanged} />
    );
  }
  return <DeckList dataVersion={dataVersion} refreshKey={listKey} onOpen={onOpenDeck} notice={deckNotice} onCollectionChanged={onCollectionChanged} />;
}
