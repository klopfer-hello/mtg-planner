"use strict";

// Deck guide (0.9.0): plain text with {G}-style mana symbols as images (escaped first: safe).
function SymText({ text }) {
  const html = useMemo(() => escapeHtml(text || "").replace(MD_SYMBOL_RE, (m, sym) => `<img class="sym" src="${symbolUrl(sym)}" alt="${m}" title="${m}">`), [text]);
  return <span dangerouslySetInnerHTML={{ __html: html }} />;
}
const Bullets = ({ items }) => (items?.length ? <ul className="guide-ul">{items.map((t, i) => <li key={i}><SymText text={t} /></li>)}</ul> : null);

/**
 * Deck page → Guide: GET /api/decks/:id/guide; Write/Regenerate = POST (Claude in the background, the sheet
 * polls every 4 s while pending; facts only without a Claude token). Shows the whole guide.
 */
function GuideSheet({ deck, onClose }) {
  const { data: state, error: loadError, reload, setData: setState } = useApi(`/api/decks/${deck.id}/guide`);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (state?.status !== "pending") return undefined;
    const t = setTimeout(reload, 4000);
    return () => clearTimeout(t);
  }, [state, reload]);
  const write = async (factsOnly = false) => {
    setBusy(true); setError(null);
    try { setState(await api(`/api/decks/${deck.id}/guide`, { method: "POST", json: factsOnly ? { facts_only: true } : {} })); }
    catch (e) { setError(e.message); }
    finally { setBusy(false); }
  };
  const row = state?.guide;
  const g = row?.guide;
  const pending = state?.status === "pending";
  const s = g?.strategy;
  return (
    <Sheet title={`Guide: ${deck.name}`} onClose={onClose}>
      <div className="stack guide">
        <ErrorNotice error={error} onDismiss={() => setError(null)} />
        <ErrorNotice error={loadError} onRetry={reload} />
        {!state && !error && !loadError && <Spinner />}
        {pending && (
          <div className="notice" role="status"><Spinner label="" /><div className="grow">Claude is writing your guide. This takes about half a minute; you can close this and come back.</div></div>
        )}
        {state?.error && !pending && <div className="notice warn" role="status"><div className="grow">The strategy part failed: {state.error}. {g ? "Below is the guide without it." : ""}</div></div>}
        {state && state.status === "none" && !pending && (
          <div className="stack">
            <p style={{ margin: 0 }}>A short guide to this deck for learning it: what it does, how it wins, what to do each turn, when to mulligan, its key cards and the techniques it uses, with a glossary.</p>
            {!state.claude && <p className="small muted" style={{ margin: 0 }}>Claude is not connected, so the guide has the facts and techniques but no strategy part.</p>}
            <div className="row"><button type="button" className="btn primary" disabled={busy} onClick={() => write(false)}><Icon.sparkle /> Write the guide</button></div>
          </div>
        )}
        {g && (
          <>
            {row.stale && !pending && <div className="notice warn" role="status"><div className="grow">The deck changed since this guide was written.</div></div>}
            <section className="card stack guide-glance" aria-label="At a glance">
              <div className="guide-head">
                {g.commander?.[0]?.image && <img src={g.commander[0].image} alt={g.commander[0].name} loading="lazy" />}
                <div className="stack" style={{ gap: 4, minWidth: 0 }}>
                  {g.commander?.length > 0 && <b>{g.commander.map((c) => c.name).join(" + ")}</b>}
                  <span className="small">{[g.deck.format && cap(g.deck.format), g.colours?.names?.length ? g.colours.names.join(" / ") : "colourless"].filter(Boolean).join(" · ")}</span>
                  <span className="small">{g.counts.cards} cards · {g.counts.lands ?? "?"} lands · average mana value {g.counts.avg_mv ?? "?"}</span>
                  {g.power && <span className="small">Bracket {g.power.bracket} ({g.power.bracket_label}) · power {g.power.score}/10</span>}
                  {g.value_eur != null && <span className="small muted">Worth about {fmtEur(g.value_eur)}</span>}
                </div>
              </div>
              {s?.summary && <p style={{ margin: 0 }}><SymText text={s.summary} /></p>}
            </section>
            {s && (
              <>
                <section className="stack"><h3>How it wins</h3><Bullets items={s.how_it_wins} /></section>
                <section className="stack"><h3>Turn by turn</h3>
                  <h4>Early (turns 1-3)</h4><Bullets items={s.game_plan.early} />
                  <h4>Middle (turns 4-6)</h4><Bullets items={s.game_plan.mid} />
                  <h4>Late (turn 7+)</h4><Bullets items={s.game_plan.late} />
                </section>
                <section className="stack"><h3>Mulligan</h3>
                  <h4>Keep</h4><Bullets items={s.mulligan.keep} />
                  <h4>Shuffle away</h4><Bullets items={s.mulligan.ship} />
                </section>
              </>
            )}
            {g.key_cards?.length > 0 && (
              <section className="stack"><h3>Key cards</h3>
                <div className="guide-keys">
                  {g.key_cards.map((k) => (
                    <div key={k.name} className="guide-key">
                      {k.image ? <img src={k.image} alt={k.name} loading="lazy" /> : <span className="guide-noimg" />}
                      <div className="stack small" style={{ gap: 2, minWidth: 0 }}><b>{k.name}</b><span><SymText text={k.why} /></span></div>
                    </div>
                  ))}
                </div>
              </section>
            )}
            {g.techniques?.length > 0 && (
              <section className="stack"><h3>Techniques this deck uses</h3>
                {g.techniques.map((t) => (
                  <div key={t.key} className="card stack guide-tech" style={{ gap: 6 }}>
                    <b>{t.name} <span className="muted small">· {plural(t.count, "card")}</span></b>
                    <span className="small">{t.what}</span>
                    {t.tip && <span className="small"><b>Here:</b> <SymText text={t.tip} /></span>}
                    <span className="small muted">{t.cards.join(", ")}{t.count > t.cards.length ? ", …" : ""}</span>
                  </div>
                ))}
              </section>
            )}
            {s?.pitfalls?.length > 0 && <section className="stack"><h3>Watch out</h3><Bullets items={s.pitfalls} /></section>}
            {s?.practice?.length > 0 && <section className="stack"><h3>Learn it</h3><Bullets items={s.practice} /></section>}
            {g.tokens?.length > 0 && (
              <section className="stack"><h3>Tokens you need</h3>
                <Bullets items={g.tokens.map((t) => `${t.name}${t.pt ? ` ${t.pt}` : ""}${t.estimate ? ` (about ${t.estimate})` : ""}`)} />
              </section>
            )}
            {g.glossary?.length > 0 && (
              <section className="stack"><h3>Words to know</h3>
                <dl className="guide-dl">{g.glossary.map((x) => <React.Fragment key={x.term}><dt>{x.term}</dt><dd><SymText text={x.meaning} /></dd></React.Fragment>)}</dl>
              </section>
            )}
            <p className="small muted" style={{ margin: 0 }}>Written {fmtAgo(row.created_at)}{row.kind === "facts" ? " · facts only (no Claude)" : ""}.</p>
            <div className="row">
              <a className="btn primary" href={`/api/decks/${deck.id}/guide.pdf`} download><Icon.download /> Download PDF</a>
              <button type="button" className="btn" disabled={busy || pending} onClick={() => write(false)}><Icon.refresh /> {busy ? "Starting…" : "Write it again"}</button>
            </div>
          </>
        )}
      </div>
    </Sheet>
  );
}
