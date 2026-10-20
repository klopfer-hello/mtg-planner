"use strict";

// ===========================================================================
// App shell
// ===========================================================================

const TABS = [
  { id: "scan", label: "Scan", icon: Icon.scan },
  // Labels vs ids: "Binders" keeps the id "collection" and "Market" the id "value" (saved tabs, #links).
  { id: "collection", label: "Binders", icon: Icon.collection },
  { id: "decks", label: "Decks", icon: Icon.decks },
  // Market: collection value over time, the wishlist, the global To buy list (lib/finance.js, lib/wishlist.js).
  { id: "value", label: "Market", icon: Icon.chart },
  { id: "planner", label: "Planner", icon: Icon.planner },
  // Settings (beta.4: was "Import"); the id stays "import" for saved tabs and #import links.
  { id: "import", label: "Settings", icon: Icon.gear },
];
const isTab = (t) => TABS.some((x) => x.id === t);
// The tab is the hash's first segment; the rest is the tab's own route (#collection/binder/<name>).
const hashTab = () => location.hash.slice(1).split("/")[0];
// Deck links: #decks = the list, #decks/<id> = one deck (shareable, the back button works).
const deckIdOf = (hash) => { const m = /^#decks\/(\d+)$/.exec(hash || ""); return m ? Number(m[1]) : null; };
const deckHash = (id) => (id ? `#decks/${id}` : "#decks");

function App() {
  const [tab, setTab] = useState(() => {
    const h = hashTab();
    return isTab(h) ? h : store.get("mtg.tab", "collection");
  });
  const [visited, setVisited] = useState(() => new Set([isTab(tab) ? tab : "collection"]));
  // Collection data (imports, prices) and deck data (deck edits, planner
  // save_deck) are versioned separately so a deck rename doesn't reset the
  // collection list. An import changes both.
  const [dataVersion, bumpData] = useReducer((x) => x + 1, 0);
  const [deckVersion, bumpDecks] = useReducer((x) => x + 1, 0);
  const onImported = useCallback(() => { bumpData(); bumpDecks(); }, []);
  // After a restore every tab remounts (epoch key) and reloads its data.
  const [epoch, bumpEpoch] = useReducer((x) => x + 1, 0);
  const [restored, setRestored] = useState(null);
  const [cardId, setCardId] = useState(null);
  const [deck, setDeck] = useState(() => ({ id: hashTab() === "decks" ? deckIdOf(location.hash) : null, notice: null }));
  const [plannerRequest, setPlannerRequest] = useState(null);
  const [health, setHealth] = useState(null);
  const scrollPos = useRef({});
  const tabRefs = useRef({});
  // Last full hash per tab, so switching back restores e.g. #collection/binder/Trade.
  const tabHash = useRef(isTab(hashTab()) ? { [hashTab()]: location.hash } : {});

  useEffect(() => {
    api("/healthz").then(setHealth).catch(() => setHealth(null));
  }, []);

  const switchTab = useCallback((next) => {
    if (!isTab(next)) return;
    setTab((cur) => {
      if (cur !== next) scrollPos.current[cur] = window.scrollY;
      return next;
    });
  }, []);

  useLayoutEffect(() => {
    store.set("mtg.tab", tab);
    if (hashTab() !== tab) history.replaceState(null, "", tabHash.current[tab] || `#${tab}`);
    setVisited((v) => (v.has(tab) ? v : new Set([...v, tab])));
    window.scrollTo(0, scrollPos.current[tab] || 0);
  }, [tab]);

  useEffect(() => {
    const onHash = () => {
      const h = hashTab();
      if (!isTab(h)) return;
      tabHash.current[h] = location.hash;
      if (h === "decks") {
        const id = deckIdOf(location.hash);
        setDeck((d) => (d.id === id ? d : { id, notice: null }));
      }
      const v = marketViewOf(location.hash);
      if (v) setValueView(v);
      switchTab(h);
    };
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, [switchTab]);

  // Market tab sub-view (overview | wishlist | buy): #value/<view> wins over the saved one.
  const [valueView, setValueView] = useState(() => {
    const v = marketViewOf(location.hash) || store.get("mtg.value.view", "overview");
    return MARKET_VIEWS.includes(v) ? v : "overview";
  });
  useEffect(() => {
    store.set("mtg.value.view", valueView);
    tabHash.current.value = marketHash(valueView);
    if (hashTab() === "value" && location.hash !== marketHash(valueView)) history.replaceState(null, "", marketHash(valueView));
  }, [valueView]);
  // wishVersion bumps after wishlist adds elsewhere.
  const [wishVersion, bumpWish] = useReducer((x) => x + 1, 0);
  // Tapping the active Collection tab returns to the binder overview.
  const [collectionHome, goCollectionHome] = useReducer((x) => x + 1, 0);
  const openDeck = useCallback((id, notice = null, { replace = false } = {}) => {
    setDeck({ id, notice });
    setCardId(null);
    scrollPos.current.decks = 0;
    // The deck is in the URL (#decks/<id>) while the Decks tab shows it or opens for it.
    if (id || hashTab() === "decks") goHash(deckHash(id), { replace });
    else tabHash.current.decks = deckHash(null);
    if (id) switchTab("decks");
    window.scrollTo(0, 0);
  }, [switchTab]);

  const askAboutDeck = useCallback((d) => {
    const prompt = `Let's work on my deck #${d.id} "${d.name}"${d.format ? ` (${d.format})` : ""}. `
      + `Load it with get_deck and give me a short analysis: mana curve, card-type balance, key synergies, weak spots, `
      + `and which of the missing cards matter most (read the deck notes too). Suggest improvements, preferring cards I already own.`;
    setPlannerRequest({ prompt, title: `Deck: ${d.name}`.slice(0, 60), nonce: Date.now() });
    switchTab("planner");
  }, [switchTab]);

  const onTabKey = (e) => {
    const i = TABS.findIndex((t) => t.id === tab);
    let j = null;
    if (e.key === "ArrowRight") j = (i + 1) % TABS.length;
    else if (e.key === "ArrowLeft") j = (i - 1 + TABS.length) % TABS.length;
    else if (e.key === "Home") j = 0;
    else if (e.key === "End") j = TABS.length - 1;
    if (j == null) return;
    e.preventDefault();
    switchTab(TABS[j].id);
    tabRefs.current[TABS[j].id]?.focus();
  };

  const panel = (id, content) => (
    <section key={id} id={`panel-${id}`} role="tabpanel" aria-labelledby={`tab-${id}`} hidden={tab !== id}>
      {visited.has(id) && <React.Fragment key={epoch}>{content}</React.Fragment>}
    </section>
  );

  return (
    <>
      <header className="app-header">
        <div className="brand"><img src="icon.svg" alt="" width="28" height="28" /> MTG Planner</div>
        <nav className="tabbar" role="tablist" aria-label="Sections" onKeyDown={onTabKey}>
          {TABS.map((t) => (
            <button key={t.id} id={`tab-${t.id}`} ref={(el) => { tabRefs.current[t.id] = el; }} type="button" role="tab" className="tab"
              aria-selected={tab === t.id} aria-controls={`panel-${t.id}`} tabIndex={tab === t.id ? 0 : -1}
              onClick={() => {
                if (t.id === "decks" && tab === "decks" && deck.id) openDeck(null);
                if (t.id === "collection" && tab === "collection") goCollectionHome();
                switchTab(t.id);
              }}>
              <t.icon />
              <span className="tab-l">{t.label}</span>
            </button>
          ))}
        </nav>
      </header>
      <main>
        {panel("scan", <ScanTab active={tab === "scan"} health={health} onCommitted={onImported} />)}
        {panel("collection", <CollectionTab dataVersion={dataVersion} homeKey={collectionHome} onOpenCard={setCardId} onOpenDeck={(id) => openDeck(id)} onGoImport={() => switchTab("import")}
          onGoScan={() => switchTab("scan")} onChanged={onImported} />)}
        {panel("decks", <DecksTab dataVersion={deckVersion} deckId={deck.id} deckNotice={deck.notice} onOpenDeck={openDeck}
          onOpenCard={setCardId} onAsk={askAboutDeck} onChanged={bumpDecks} onCollectionChanged={onImported}
          onWishChanged={bumpWish} />)}
        {panel("value", <FinanceTab dataVersion={dataVersion + wishVersion} buyVersion={dataVersion + deckVersion + wishVersion} view={valueView}
          onView={(v) => { setValueView(v); window.scrollTo(0, 0); }} onOpenCard={setCardId} onOpenDeck={(id) => openDeck(id)} onChanged={bumpWish} />)}
        {panel("planner", <PlannerTab active={tab === "planner"} health={health} request={plannerRequest}
          onRequestHandled={() => setPlannerRequest(null)} onChanged={bumpDecks} />)}
        {panel("import", <ImportTab dataVersion={dataVersion} health={health} onImported={onImported} restored={restored}
          onDismissRestored={() => setRestored(null)}
          onRestored={(r) => { setRestored(r); setCardId(null); openDeck(null); bumpEpoch(); onImported(); window.scrollTo(0, 0); }} />)}
      </main>
      {cardId && <CardSheet id={cardId} onClose={() => setCardId(null)} onOpenCard={setCardId} onOpenDeck={(id) => openDeck(id)} onChanged={onImported}
        onWishChanged={bumpWish} />}
    </>
  );
}

ReactDOM.createRoot(document.getElementById("root")).render(<App />);
