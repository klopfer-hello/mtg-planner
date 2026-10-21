"use strict";

// ===========================================================================
// Decks tab
// ===========================================================================

const FORMATS = ["commander", "standard", "modern", "pioneer", "pauper", "legacy", "vintage", "brawl", "other"];
const BOARD_LABEL = { commander: "Commander", main: "Main deck", side: "Sideboard", maybe: "Maybeboard" };

function DeckImportForm({ onCreated, onCancel }) {
  const [name, setName] = useState("");
  const [format, setFormat] = useState("commander");
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  // "I own these cards" (a deck you bought): the cards also go into the collection, in one binder.
  const [owned, setOwned] = useState(false);
  const [binder, setBinder] = useState(null); // null = follows the name ("Deck box: <name>")
  const [language, setLanguage] = useState("en");
  const [condition, setCondition] = useState("near_mint");
  const boxName = binder ?? (name.trim() ? `Deck box: ${name.trim()}`.slice(0, 100) : "");

  const pickFile = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      setText(await file.text());
      if (!name) setName(file.name.replace(/\.[^.]+$/, ""));
    } catch (err) {
      setError(`Could not read the file: ${err.message}`);
    }
    e.target.value = "";
  };

  const submit = async (e) => {
    e.preventDefault();
    if (!name.trim() || !text.trim() || busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = owned
        ? await api("/api/collection/import-list", { method: "POST", json: {
          text, binder: boxName.trim(), language, condition, deck: { name: name.trim(), format } } })
          .then((r) => ({ ...r, id: r.deck_id }))
        : await api("/api/decks", { method: "POST", json: { name: name.trim(), format, text } });
      onCreated(res);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="card stack" onSubmit={submit} aria-labelledby="deck-import-title">
      <div className="row between">
        <h2 id="deck-import-title">Import decklist</h2>
        <button type="button" className="btn ghost icon" aria-label="Close import form" onClick={onCancel}><Icon.close /></button>
      </div>
      <div className="row" style={{ alignItems: "flex-end" }}>
        <div className="field grow" style={{ flexBasis: 200 }}>
          <label htmlFor="deck-name">Name</label>
          <input id="deck-name" className="input" required maxLength={200} value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Elves tribal" />
        </div>
        <div className="field" style={{ flexBasis: 150, flexGrow: 1 }}>
          <label htmlFor="deck-format">Format</label>
          <select id="deck-format" className="select" value={format} onChange={(e) => setFormat(e.target.value)}>
            {FORMATS.map((f) => <option key={f} value={f}>{cap(f)}</option>)}
          </select>
        </div>
      </div>
      <div className="field">
        <div className="row between">
          <label htmlFor="deck-text">Decklist</label>
          <label className="btn sm">
            <Icon.file /> Load .txt
            <input type="file" accept=".txt,.dec,.dek,text/plain" className="sr-only" onChange={pickFile} />
          </label>
        </div>
        <textarea id="deck-text" className="textarea" required value={text} onChange={(e) => setText(e.target.value)}
          placeholder={"Commander\n1 Lathril, Blade of the Elves\n\nDeck\n1 Sol Ring\n1x Llanowar Elves (M19) 314\n36 Forest"} />
        <span className="muted small">One card per line: <code>1 Sol Ring</code>, <code>1x Name (SET) 123</code>, <code>*F*</code> for foil. Section headers like Commander / Deck / Sideboard / Maybeboard are recognised. {owned ? "Lines without a set get a current printing." : "Cards you own are matched to your printings."}</span>
      </div>
      <label className="radio-card">
        <input type="checkbox" checked={owned} onChange={(e) => setOwned(e.target.checked)} />
        <span><b>I own these cards</b> (a deck I bought)<br />
          <span className="small muted">The cards are also added to your collection, the deck is marked as built and the binder becomes its deck box. The maybeboard isn't added.</span></span>
      </label>
      {owned && (
        <div className="settings-grid">
          <div className="field" style={{ gridColumn: "1 / -1" }}>
            <label htmlFor="deck-own-binder">Binder (deck box)</label>
            <input id="deck-own-binder" className="input" maxLength={100} value={boxName} onChange={(e) => setBinder(e.target.value)} placeholder="Deck box: …" />
          </div>
          <div className="field">
            <label htmlFor="deck-own-lang">Language</label>
            <select id="deck-own-lang" className="select" value={language} onChange={(e) => setLanguage(e.target.value)}>
              {SCAN_LANGS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
            </select>
          </div>
          <div className="field">
            <label htmlFor="deck-own-cond">Condition</label>
            <select id="deck-own-cond" className="select" value={condition} onChange={(e) => setCondition(e.target.value)}>
              {CONDITIONS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
            </select>
          </div>
        </div>
      )}
      <ErrorNotice error={error} />
      <div className="row">
        <button type="submit" className="btn primary" disabled={busy || !name.trim() || !text.trim() || (owned && !boxName.trim())}>
          {busy ? <><span className="spinner" aria-hidden="true" /> Importing…</> : owned ? "Import deck and add the cards" : "Import deck"}
        </button>
        <button type="button" className="btn ghost" onClick={onCancel}>Cancel</button>
      </div>
    </form>
  );
}

/** Compact "✗ 80 to buy" / "⇄ 8 in use" for list rows. */
function DeckNeedBadges({ d }) {
  const { toBuy, inUse } = deckCounts(d);
  return (
    <>
      {toBuy > 0 && <span className="badge bad" title={`${toBuy} cards you don't own`}>✗ {fmtInt(toBuy)} to buy</span>}
      {inUse > 0 && (d.status === "built"
        ? !(d.conflict_count > 0) && <span className="badge bad" title={`${inUse} owned cards are shared with other built decks`}>⚠ {fmtInt(inUse)} shared</span>
        : <span className="badge warn" title={`${inUse} owned cards are in other built decks (can be moved)`}>⇄ {fmtInt(inUse)} in use</span>)}
    </>
  );
}

/**
 * Deck cover (GET /api/decks cover): the commander, else the most expensive card. Phones: a card
 * thumb; desktop list tiles: the art crop (`banner`). No card image → a deck icon.
 */
function DeckCover({ cover, banner = true }) {
  const small = cover?.image_small || cover?.image_normal;
  return (
    <span className="cover" aria-hidden="true" title={cover ? `${cover.source === "commander" ? "Commander" : "Most valuable card"}: ${cover.name}` : undefined}>
      {small ? (
        <picture>
          {banner && cover.image_art && <source media="(min-width: 768px)" srcSet={cover.image_art} />}
          <img src={small} alt="" loading="lazy" decoding="async" width="146" height="204" className={banner && cover.image_art ? "art" : undefined} />
        </picture>
      ) : <span className="ph"><Icon.decks /></span>}
    </span>
  );
}

/** Colour chips of the deck and binder filters: [symbol, label, collection query term]. */
const COLOUR_CHIPS = [["W", "White", "c:w"], ["U", "Blue", "c:u"], ["B", "Black", "c:b"], ["R", "Red", "c:r"], ["G", "Green", "c:g"], ["C", "Colourless", "c:c"]];

/** Star toggle (favourite) on a deck or binder header. */
function FavButton({ on, busy = false, label, onToggle }) {
  return (
    <button type="button" className={`btn ghost icon fav-btn${on ? " on" : ""}`} aria-pressed={on} disabled={busy}
      aria-label={on ? `Remove ${label} from favourites` : `Add ${label} to favourites`}
      title={on ? "Favourite. Tap to remove" : "Add to favourites"} onClick={onToggle}><span aria-hidden="true">{on ? "★" : "☆"}</span></button>
  );
}

/** A deck's colour identity as mana symbols ('' = colourless). */
function DeckColours({ colors }) {
  const cs = String(colors ?? "").split("").filter((c) => "WUBRG".includes(c));
  return (
    <span className="deck-colours" aria-label={`Colours: ${cs.length ? cs.join("") : "colourless"}`}>
      {(cs.length ? cs : ["C"]).map((c) => <img key={c} className="sym" src={symbolUrl(c)} alt="" loading="lazy" decoding="async" />)}
    </span>
  );
}

// Deck list filters, remembered per device: {fav, status idea|built|null, formats[], colors[]}.
const DECK_FILTER_KEY = "mtg.decks.filter";
const NO_DECK_FILTER = { fav: false, status: null, formats: [], colors: [] };
function loadDeckFilter() {
  const f = store.get(DECK_FILTER_KEY, null) || {};
  return {
    fav: f.fav === true,
    status: f.status === "idea" || f.status === "built" ? f.status : null,
    formats: asList(f.formats).filter((x) => typeof x === "string"),
    colors: asList(f.colors).filter((x) => typeof x === "string" && "WUBRGC".includes(x) && x.length === 1),
  };
}
const deckFormatKey = (d) => String(d.format || "").trim().toLowerCase();
const formatLabel = (f) => f.replace(/\b\w/g, (m) => m.toUpperCase());
/** Colours: the deck's identity holds every picked colour (like c:wu in a search); C = colourless only. */
function deckMatches(d, f) {
  if (f.fav && !d.favorite) return false;
  if (f.status && d.status !== f.status) return false;
  if (f.formats.length && !f.formats.includes(deckFormatKey(d))) return false;
  const id = String(d.colors ?? "");
  for (const c of f.colors) if (c === "C" ? id !== "" : !id.includes(c)) return false;
  return true;
}

function DeckList({ dataVersion, onOpen, refreshKey, notice = null, onCollectionChanged = null }) {
  const [hideNotice, setHideNotice] = useState(false);
  const [filter, setFilter] = useState(loadDeckFilter);
  useEffect(() => { store.set(DECK_FILTER_KEY, filter); }, [filter]);
  useEffect(() => setHideNotice(false), [notice]);
  const { data: decks, error, reload: load } = useApi("/api/decks", [dataVersion, refreshKey], { error: (e) => `Could not load decks: ${e.message}` });
  const [showForm, setShowForm] = useState(false);
  const all = decks || [];
  const formats = [...new Set(all.map(deckFormatKey).filter(Boolean))].sort();
  // A remembered format that no deck has any more is dropped from the filter.
  const f = { ...filter, formats: filter.formats.filter((x) => formats.includes(x)) };
  const active = f.fav || f.status || f.formats.length > 0 || f.colors.length > 0;
  const shown = all.filter((d) => deckMatches(d, f));
  const toggleIn = (key, v) => setFilter((cur) => ({ ...cur, [key]: cur[key].includes(v) ? cur[key].filter((x) => x !== v) : [...cur[key], v] }));
  // Colourless excludes the colours and the other way round.
  const toggleColour = (c) => setFilter((cur) => {
    if (cur.colors.includes(c)) return { ...cur, colors: cur.colors.filter((x) => x !== c) };
    return { ...cur, colors: c === "C" ? ["C"] : [...cur.colors.filter((x) => x !== "C"), c] };
  });
  const favCount = all.filter((d) => d.favorite).length;

  return (
    <div className="stack-lg">
      <div className="page-title">
        <h1>Decks</h1>
        <div className="row">
          {!showForm && <button type="button" className="btn primary" onClick={() => setShowForm(true)}><Icon.plus /> Import decklist</button>}
        </div>
      </div>
      {showForm && (
        <DeckImportForm onCancel={() => setShowForm(false)}
          onCreated={(res) => {
            setShowForm(false);
            const issues = [];
            if (res.unresolved?.length) issues.push(`Not found on Scryfall: ${res.unresolved.join(", ")}`);
            if (res.parse_errors?.length) issues.push(`Skipped lines: ${res.parse_errors.join(" | ")}`);
            if (res.added_copies) {
              issues.unshift(`Added ${res.added_copies} cards to ${res.binder || UNSORTED} (undo: Settings → Collection → Recent changes)`);
              onCollectionChanged?.();
            }
            onOpen(res.id, issues.length ? issues.join(" — ") : null);
          }} />
      )}
      {notice && !hideNotice && (
        <div className="notice warn" role="status"><div className="grow">{notice}</div>
          <button type="button" className="btn ghost icon sm" aria-label="Dismiss" onClick={() => setHideNotice(true)}><Icon.close /></button></div>
      )}
      <ErrorNotice error={error} onRetry={load} />
      {!decks && !error && <Spinner label="Loading decks…" />}
      {decks && decks.length === 0 && !showForm && (
        <div className="empty card">
          <h3>No decks yet</h3>
          <p style={{ margin: 0, maxWidth: 460 }}>Paste a decklist, import ManaBox deck binders with your collection CSV, or ask the planner to build one from your cards.</p>
          <button type="button" className="btn primary" onClick={() => setShowForm(true)}><Icon.plus /> Import decklist</button>
        </div>
      )}
      {decks && decks.length > 0 && (
        <div className="stack">
          <div className="chips" role="group" aria-label="Filter decks">
            <button type="button" className="chip" aria-pressed={f.fav} onClick={() => setFilter((cur) => ({ ...cur, fav: !cur.fav }))}>
              ★ Favourites{favCount ? <span className="cnt"> {favCount}</span> : null}</button>
            <button type="button" className="chip" aria-pressed={f.status === "built"} onClick={() => setFilter((cur) => ({ ...cur, status: cur.status === "built" ? null : "built" }))}>Built</button>
            <button type="button" className="chip" aria-pressed={f.status === "idea"} onClick={() => setFilter((cur) => ({ ...cur, status: cur.status === "idea" ? null : "idea" }))}>Ideas</button>
            {formats.map((x) => (
              <button key={x} type="button" className="chip" aria-pressed={f.formats.includes(x)} onClick={() => toggleIn("formats", x)}>{formatLabel(x)}</button>
            ))}
          </div>
          <div className="chips" role="group" aria-label="Filter decks by colour">
            {COLOUR_CHIPS.map(([c, label]) => (
              <button key={c} type="button" className="chip sym-chip" aria-pressed={f.colors.includes(c)} aria-label={label} title={label}
                onClick={() => toggleColour(c)}><img className="sym" src={symbolUrl(c)} alt="" /></button>
            ))}
          </div>
          {active && (
            <div className="filter-summary small" aria-live="polite">
              <span className="muted">{shown.length} of {plural(all.length, "deck")}</span>
              <button type="button" className="btn ghost sm" onClick={() => setFilter(NO_DECK_FILTER)}>Clear filters</button>
            </div>
          )}
          {shown.length === 0 && (
            <p className="small muted" style={{ margin: 0 }}>{f.fav && !favCount
              ? <>No favourite decks yet. Open a deck and tap <b>☆</b>.</>
              : "No deck matches these filters."}</p>
          )}
        </div>
      )}
      {decks && shown.length > 0 && (
        <div className="deck-list">
          {shown.map((d) => (
            <button key={d.id} type="button" className="deck-item" onClick={() => onOpen(d.id)}>
              <DeckCover cover={d.cover} />
              <span className="body">
              <span className="t">{d.favorite && <span className="fav-star" aria-label="Favourite">★ </span>}{d.name}</span>
              <span className="row small">
                <DeckColours colors={d.colors} />
                <StatusBadge status={d.status} />
                <PowerListBadge d={d} />
                {d.conflict_count > 0 && <span className="badge bad" title="Cards this deck shares with another built deck, without enough copies">⚠ {plural(d.conflict_count, "conflict")}</span>}
                <DeckNeedBadges d={d} />
                {d.format && <span className="badge">{d.format}</span>}
                <SourceBadge source={d.source} />
                <span className="muted">{plural(d.card_count, "card")}</span>
                {d.value_eur != null && <span className="muted" title="Value of main deck, commander and sideboard (EUR prices)">· <b style={{ color: "var(--text)" }}>{fmtEur(d.value_eur)}</b></span>}
                <span className="muted">· updated {fmtAgo(d.updated_at)}</span>
              </span>
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// Allocation per deck row (v0.3.1): to_buy = copies you don't own at all;
// in_use = owned copies claimed by other built decks (can be moved).
const cardToBuy = (c) => (c && !c.basic ? Math.max(0, Number(c.to_buy) || 0) : 0);
const cardInUse = (c) => (c && !c.basic ? Math.max(0, Number(c.in_use) || 0) : 0);
/** Other BUILT decks that use this card (names for the visible in-use line). */
const builtElsewhereOf = (c) => asList(c?.used_elsewhere).filter((u) => u.status === "built");
const deckNames = (list) => list.map((d) => d.name).filter((n, i, a) => a.indexOf(n) === i).join(", ");
/** Locked binders holding this card (kept for another deck or for all): "X, Y". */
const boxNames = (c) => asList(c?.in_locked).map((b) => b.binder).filter((n, i, a) => a.indexOf(n) === i).join(", ");
/** Copies of a deck row that lie in locked binders (part of in_use). */
const cardInLocked = (c) => (c && !c.basic ? Math.max(0, Number(c.in_use_locked) || 0) : 0);
/** Deck-level counts of a deck detail, a deck list row or a shopping-list per_deck row. */
const deckCounts = (deck) => ({
  toBuy: Number(deck?.to_buy_count) || 0,
  inUse: Number(deck?.in_use_count) || 0,
  toBuyEur: deck?.to_buy_eur ?? null,
  inUseEur: deck?.in_use_eur ?? null,
});

function DeckCardRow({ card, onOpenCard, onActions, selecting = false, selected = false, onToggle }) {
  const [peek, setPeek] = useState(false);
  const elsewhere = asList(card.used_elsewhere);
  const free = card.available_for_this;
  const hasFree = !card.basic && typeof free === "number";
  const freeText = hasFree ? `own ${card.owned ?? 0} · ${Math.max(0, free)} free` : null;
  const toBuy = cardToBuy(card);
  const inUse = cardInUse(card);
  const builtElsewhere = card.basic ? [] : builtElsewhereOf(card);
  const decksWhere = deckNames(builtElsewhere) || "another built deck";
  // In use = claimed by other built decks and/or lying in locked binders (kept for another deck).
  const inBox = cardInLocked(card);
  const inDecks = inUse - inBox;
  const where = [inDecks > 0 ? deckNames(builtElsewhere) : "", inBox > 0 ? `locked binder ${boxNames(card)}` : ""].filter(Boolean).join(", ") || decksWhere;
  // Built deck + contested copies = conflict (red); idea deck = in use (amber).
  const conflict = Boolean(card.conflict) && !card.basic;
  const badges = [];
  if (card.basic) badges.push(<span key="b" className="badge" title="Basic land">basic</span>);
  else {
    if (inUse > 0) {
      const t = conflict
        ? `Conflict: ${inUse} of your copies ${inUse === 1 ? "is" : "are"} also in ${where} (own ${card.owned ?? 0})`
        : `In use: ${inUse} owned ${inUse === 1 ? "copy is" : "copies are"} in ${where}. You can move ${inUse === 1 ? "it" : "them"} to this deck.`;
      badges.push(<span key="u" className={`badge ${conflict ? "bad" : "warn"}`} role="img" aria-label={t} title={t}>{conflict ? "⚠" : inBox >= inUse ? "🔒" : "⇄"} {inUse}</span>);
    }
    if (conflict && !inUse) {
      // Shared with another built deck but no owned copy to contest: still a conflict.
      const t = `Conflict: also in ${decksWhere} (own ${card.owned ?? 0})`;
      badges.push(<span key="c" className="badge bad" role="img" aria-label={t} title={t}>⚠</span>);
    }
    if (toBuy > 0) {
      const t = `To buy: ${toBuy} (${freeText || `you own ${card.owned ?? 0}`})`;
      badges.push(<span key="m" className="badge bad" role="img" aria-label={t} title={t}>✗ {toBuy}</span>);
    }
    if (!inUse && !toBuy) {
      // Covered. Another built deck also using it (enough copies) stays a hint.
      const sharedTitle = builtElsewhere.length
        ? `${conflict ? `Not enough copies (own ${card.owned ?? 0}). ` : ""}Also used in: ${builtElsewhere.map((u) => `${u.name}${u.quantity ? ` (${u.quantity}×)` : ""}`).join(", ")}`
        : null;
      if (sharedTitle && !conflict) badges.push(<span key="s" className={`badge ${conflict ? "bad" : "warn"}`} role="img" aria-label={sharedTitle} title={sharedTitle}>⚠</span>);
      badges.push(<span key="ok" className="badge ok" aria-label={`Owned (${card.owned})`} title={`You own ${card.owned}`}>✓</span>);
    }
  }
  // Visible on phones (no hover): where the copies are and that they can move.
  const lockedLine = inBox > 0 ? <>🔒 in {boxNames(card)} · locked</> : null;
  const useLine = conflict
    ? <span className="use conf">conflict: also in {decksWhere}{lockedLine && <> · {lockedLine}</>}</span>
    : inUse > 0
      ? <span className="use inuse">{inDecks > 0 && <>in {deckNames(builtElsewhere) || decksWhere} · can be moved</>}{inDecks > 0 && lockedLine && " · "}{lockedLine}</span>
      : null;
  const unresolved = !card.scryfall_id;
  return (
    <>
      <div className="deck-line">
      <button type="button" className="deck-row" disabled={unresolved && !selecting}
        aria-expanded={unresolved || selecting ? undefined : peek} aria-pressed={selecting ? selected : undefined}
        aria-label={selecting ? `Select ${card.quantity}× ${card.name}` : undefined}
        onClick={() => (selecting ? onToggle?.() : setPeek((p) => !p))} title={unresolved && !selecting ? "Not found on Scryfall" : undefined}>
        {selecting
          ? <span className="sel-mark" aria-hidden="true">{selected && <Icon.check />}</span>
          : <span className="q">{card.quantity}</span>}
        <span className="nm">
          <b>{selecting ? `${card.quantity}× ` : ""}{card.name}</b>
          <ManaCost cost={card.mana_cost} />
          {unresolved && <span className="badge warn">unresolved</span>}
          {!useLine && hasFree && free < (card.owned ?? 0) && <span className="free">{freeText}</span>}
        </span>
        <span className="end">
          <span className="price">{fmtPrice(card.price)}</span>
          {badges}
        </span>
        {useLine}
      </button>
      {onActions && !selecting && (
        <button type="button" className="btn ghost icon row-more" aria-label={`Actions for ${card.name}`} title="Board, quantity, commander" onClick={(e) => onActions(card, e.currentTarget)}><Icon.more /></button>
      )}
      </div>
      {peek && !unresolved && !selecting && (
        <div className="peek">
          {card.image_small ? <img src={card.image_small} alt={card.name} loading="lazy" /> : <span />}
          <div className="stack small" style={{ gap: 6, alignContent: "start" }}>
            <span>{card.type_line}</span>
            <span className="muted">{setNumberOf(card)} · {freeText || `own ${card.owned}`}</span>
            {asList(card.binders).length > 0 && (
              <span>In {asList(card.binders).length === 1 ? "binder" : "binders"}: {asList(card.binders).map((b) => `${b.binder || "Unsorted"} (${b.quantity})`).join(", ")}</span>
            )}
            {elsewhere.length > 0 && (
              <span className="muted">Also in: {elsewhere.map((u) => `${u.name}${u.status ? ` (${u.status})` : ""}${u.quantity ? ` ${u.quantity}×` : ""}`).join(", ")}</span>
            )}
            <button type="button" className="btn sm" style={{ justifySelf: "start" }} onClick={() => onOpenCard(card.scryfall_id)}>Card details</button>
          </div>
        </div>
      )}
    </>
  );
}

const MOVE_BOARDS = ["main", "side", "maybe"];
/** commander_suggestions: card objects, one per name (lib/decks.js commanderSuggestions). */
const commanderSuggestions = (deck) => asList(deck?.commander_suggestions);
// Same rule as the server (lib/decks.js isCommanderFormat): trimmed, case-insensitive.
const isCommanderFormat = (deck) => String(deck?.format || "").trim().toLowerCase() === "commander";
const hasCommander = (deck) => (deck?.counts?.commander ?? 0) > 0 || (deck?.cards || []).some((c) => c.board === "commander");

/** Per-card actions: commander, board moves, quantity, remove. */
/**
 * A small dropdown menu at a button (`anchor`, a DOM element): fixed position below it, flipped above near
 * the bottom; follows scrolling and closes once the button leaves the screen; Escape and a tap outside
 * close it. `deps` re-place it when its content changes size.
 */
function PopMenu({ anchor, onClose, label, className = "", deps = [], children }) {
  const ref = useRef(null);
  const [pos, setPos] = useState(null);
  const place = useCallback(() => {
    const el = ref.current;
    if (!el || !anchor || !anchor.isConnected) return false;
    const r = anchor.getBoundingClientRect(), vw = window.innerWidth, vh = window.innerHeight;
    if (r.bottom < 0 || r.top > vh) return false;
    const w = Math.min(280, vw - 16), h = el.offsetHeight;
    const left = Math.min(Math.max(8, r.right - w), vw - w - 8);
    let top = r.bottom + 4;
    if (top + h > vh - 8) top = r.top - h - 4 >= 8 ? r.top - h - 4 : Math.max(8, vh - h - 8);
    setPos({ left, top, width: w });
    return true;
  }, [anchor]);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useLayoutEffect(() => { place(); }, [place, ...deps]);
  useEffect(() => {
    ref.current?.querySelector("[role=menuitem]:not(:disabled), [role=menuitemradio]:not(:disabled)")?.focus({ preventScroll: true });
    const away = (e) => { if (ref.current && !ref.current.contains(e.target) && !anchor?.contains(e.target)) onClose(); };
    const key = (e) => { if (e.key === "Escape") { e.stopPropagation(); onClose(); anchor?.focus?.(); } };
    // Scrolling moves the menu with its button; it closes once the button is off screen.
    const moved = (e) => { if (ref.current?.contains(e.target)) return; if (!place()) onClose(); };
    document.addEventListener("pointerdown", away, true);
    document.addEventListener("keydown", key, true);
    window.addEventListener("scroll", moved, true);
    window.addEventListener("resize", moved);
    return () => {
      document.removeEventListener("pointerdown", away, true);
      document.removeEventListener("keydown", key, true);
      window.removeEventListener("scroll", moved, true);
      window.removeEventListener("resize", moved);
    };
  }, [anchor, onClose, place]);
  return (
    <div ref={ref} className={`card-menu ${className}`} role="menu" aria-label={label}
      style={pos ? { left: pos.left, top: pos.top, width: pos.width } : { visibility: "hidden", left: 0, top: 0 }}>
      {children}
    </div>
  );
}

/** A square icon button: the label is its accessible name and tooltip. `dot` marks it (e.g. a guide exists). */
function IconBtn({ icon: I, label, onClick, primary = false, danger = false, pressed, dot = false, disabled = false, href, download }) {
  const cls = `icon-btn${primary ? " primary" : ""}${danger ? " danger" : ""}`;
  if (href) return <a className={cls} href={href} download={download} aria-label={label} title={label}><I />{dot && <span className="dot" aria-hidden="true" />}</a>;
  return (
    <button type="button" className={cls} aria-label={label} title={label} onClick={onClick} disabled={disabled}
      aria-pressed={pressed === undefined ? undefined : Boolean(pressed)}>
      <I />{dot && <span className="dot" aria-hidden="true" />}
    </button>
  );
}

/** Deck page: cards per board and the deck's value (the old tiles), as a pop-up. */
function DeckValueSheet({ deck, onClose }) {
  return (
    <Sheet title="Cards and value" onClose={onClose}>
      <div className="stack">
        <div className="stats">
          {["commander", "main", "side", "maybe"].filter((b) => b === "main" || deck.counts?.[b]).map((b) => (
            <div className="stat" key={b}><div className="v">{deck.counts?.[b] ?? 0}</div><div className="k">{BOARD_LABEL[b]}</div></div>
          ))}
        </div>
        <DeckValue value={deck.value} />
      </div>
    </Sheet>
  );
}

/**
 * The ⋯ next to a deck card: a PopMenu with card details, set as commander (replace one of several),
 * move to another board, copies −/+ (the menu stays open) and remove.
 */
function CardActionsMenu({ deck, card, anchor, busy, error, onRun, onOpenCard, onClose }) {
  const qty = card.quantity ?? 1;
  const isCmd = card.board === "commander";
  const commanders = (deck.cards || []).filter((c) => c.board === "commander");
  const patch = (body, label) => onRun(`/api/decks/${deck.id}/cards`, "PATCH", { name: card.name, board: card.board, ...body }, label);
  const remove = () => {
    if (!window.confirm(`Remove ${card.name} from the ${(BOARD_LABEL[card.board] || card.board).toLowerCase()}?`)) return;
    patch({ quantity: 0 }, "remove");
  };
  const item = (label, onClick, { icon = null, danger = false, disabled = false } = {}) => (
    <button type="button" role="menuitem" className={`menu-item${danger ? " danger" : ""}`} disabled={busy || disabled} onClick={onClick}>{icon}{label}</button>
  );
  return (
    <PopMenu anchor={anchor} onClose={onClose} label={`Actions for ${card.name}`} deps={[card, error, commanders.length]}>
      <div className="menu-head small"><b>{card.name}</b><span className="muted">{qty}× · {BOARD_LABEL[card.board] || card.board}</span></div>
      {card.scryfall_id && item("Card details", () => { onClose(); onOpenCard(card.scryfall_id); }, { icon: <Icon.search /> })}
      {!isCmd && commanders.length <= 1 && item(commanders.length ? "Make commander" : "Set as commander",
        () => onRun(`/api/decks/${deck.id}/commander`, "POST", { name: card.name }, "commander"), { icon: <Icon.crown /> })}
      {!isCmd && commanders.length > 1 && commanders.map((c) => (
        <React.Fragment key={c.name}>{item(`Commander instead of ${c.name}`,
          () => onRun(`/api/decks/${deck.id}/commander`, "POST", { name: card.name, replace: c.name }, "commander"), { icon: <Icon.crown /> })}</React.Fragment>
      ))}
      {MOVE_BOARDS.filter((b) => b !== card.board).map((b) => (
        <React.Fragment key={b}>{item(`Move to ${BOARD_LABEL[b]}`, () => patch({ to_board: b }, "move"), { icon: <Icon.up /> })}</React.Fragment>
      ))}
      <div className="menu-qty">
        <span>Copies</span>
        <Stepper label="Copies" value={qty} disabled={busy} onChange={(n) => patch({ quantity: n }, "qty")} />
      </div>
      {item("Remove from deck", remove, { icon: <Icon.trash />, danger: true })}
      {error && <div className="menu-error small" role="alert">{typeof error === "string" ? error : error.message}</div>}
    </PopMenu>
  );
}

function DeckValue({ value }) {
  if (!value || typeof value !== "object") return null;
  const items = [
    ["total", "Deck value", value.total_eur],
    ["", "Owned", value.owned_eur],
    ["", "To buy", value.to_buy_eur],
    ["", "Maybeboard", value.maybe_eur],
  ].filter(([, , v]) => v != null);
  if (!items.length && !value.no_eur_price) return null;
  return (
    <div className="stack" style={{ gap: 6 }} aria-label="Deck value">
      <div className="value-grid">
        {items.map(([cls, k, v]) => <div key={k} className={`stat ${cls}`}><div className="v">{fmtEur(v)}</div><div className="k">{k}</div></div>)}
      </div>
      {value.no_eur_price > 0 && (
        <span className="small muted">{plural(value.no_eur_price, "card")} without € price (not counted)</span>
      )}
    </div>
  );
}
