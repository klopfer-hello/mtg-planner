"use strict";

// ===========================================================================
// Deck power (v0.7.0): bracket + score badges, PowerSheet, stats charts.
// The server computes everything (lib/power.js, lib/deckstats.js); this only
// shows it. High brackets are not "bad": B4/B5 use the accent colour, warn/bad
// colours are kept for real problems (declared below the rules, not legal,
// combos not checked).
// ===========================================================================

const SOURCE_LABEL = { scryfall: "Scryfall", spellbook: "Spellbook", list: "list", regex: "text", name: "name", rules: "rules" };
const SPELLBOOK_SITE = "https://commanderspellbook.com";
const comboHref = (id) => `${SPELLBOOK_SITE}/combo/${encodeURIComponent(id)}/`;
const halfStep = (n) => Math.round(Number(n) * 2) / 2;
/** Score in UI half steps: 6.5, 7. */
const fmtScore = (n) => { const h = halfStep(n); return Number.isInteger(h) ? String(h) : h.toFixed(1); };
const fmtPct = (x) => (x == null ? "—" : `${Math.round(x * 100)}%`);
const fmtNum1 = (n) => (n == null ? "—" : String(Math.round(n * 10) / 10));
const fmtNum2 = (n) => (n == null ? "—" : String(Math.round(n * 100) / 100));
const BRACKET_LABEL = { 1: "Exhibition", 2: "Core", 3: "Upgraded", 4: "Optimized", 5: "cEDH" };

/** {bracket, score, legality, combos} of a deck detail; all null for a non-commander deck. */
function deckPowerOf(deck) {
  const p = deck?.power || {};
  const bracket = p.bracket ?? null;
  return { bracket, score: p.score ?? null, legality: p.legality ?? bracket?.legality ?? null, combos: deck?.combos ?? null };
}
const declaredBelow = (b) => Boolean(b?.reasons?.some((r) => r.rule === "declared_below"));
const comboItems = (c) => asList(c?.items).length ? c.items : asList(c?.result?.combos);
const comboUnresolved = (c) => asList(c?.unresolved).length ? c.unresolved : asList(c?.result?.unresolved);

/** Header badges: "B3 Upgraded", "6.5/10" and a "Not legal" badge; tapping any opens the PowerSheet. */
function PowerBadges({ deck, onOpen }) {
  const { bracket: b, score: s, legality } = deckPowerOf(deck);
  if (!b && !s) return null;
  // Plan §8: warn for a declared bracket below the rules and for an auto bracket that is
  // only a lower bound (combos / Game Changer flags / cards not checked yet).
  const tone = declaredBelow(b) ? "warn" : b && b.partial && b.declared == null ? "warn" : b && b.value >= 4 ? "accent" : "";
  return (
    <div className="row power-badges">
      {b && (
        <button type="button" className={`power-chip ${tone}`} onClick={onOpen}
          aria-label={`Bracket ${b.display} ${b.label}${b.declared != null ? ", set by you" : ""}${b.partial && b.declared == null ? ", combos not checked yet" : ""}. Show details`}>
          B{b.display} <span className="lbl">{b.label}</span>{b.declared != null && <span aria-hidden="true"> ✎</span>}
        </button>
      )}
      {s && (
        <button type="button" className="power-chip" onClick={onOpen} aria-label={`Power score ${s.partial ? "at least " : ""}${fmtScore(s.value)} of 10. Show details`}>
          {s.partial ? "≥ " : ""}{fmtScore(s.value)}/10
        </button>
      )}
      {legality && legality.ok === false && (
        <button type="button" className="power-chip bad" onClick={onOpen} aria-label="Not Commander-legal. Show details">✗ Not legal</button>
      )}
    </div>
  );
}

/** "B3 · 6.5" for the deck list (commander decks only). Accepts numbers or objects. */
function PowerListBadge({ d }) {
  const bObj = d.bracket && typeof d.bracket === "object" ? d.bracket : null;
  const b = bObj ? bObj.value : d.bracket;
  const sObj = d.score && typeof d.score === "object" ? d.score : null;
  const s = sObj ? sObj.value : d.score;
  if (b == null && s == null) return null;
  const declared = bObj ? bObj.declared != null : d.bracket_declared != null;
  const bp = !declared && Boolean(bObj ? bObj.partial : d.bracket_partial);
  const sp = Boolean(sObj ? sObj.partial : d.score_partial);
  const title = `${b != null ? `Bracket ${bp ? "≥" : ""}${b} ${BRACKET_LABEL[b] || ""}${declared ? " (set by you)" : ""}` : ""}${s != null ? ` · power score ${sp ? "≥ " : ""}${fmtScore(s)}/10` : ""}${bp || sp ? " · combos not checked yet" : ""}`;
  return (
    <span className={`badge ${b >= 4 ? "accent" : ""}`} title={title.replace(/^ · /, "")}>
      {b != null && <>B{bp ? "≥" : ""}{b}{declared ? "✎" : ""}</>}{b != null && s != null && " · "}{s != null && <>{sp ? "≥" : ""}{fmtScore(s)}</>}
    </span>
  );
}

const REASON_SHORT = {
  game_changers: (r) => plural(asList(r.cards).length || 1, "Game Changer"),
  mld: () => "mass land denial",
  extra_turns: (r) => plural(asList(r.cards).length || 3, "extra-turn card"),
  combo: (r) => (r.floor >= 4 ? "a fast two-card combo" : "a two-card combo"),
  extra_turn_combo: (r) => (r.floor >= 4 ? "a fast extra-turn combo" : "an extra-turn combo"),
};
const CAT_WORDS = {
  speed: ["a low curve", "a high curve"],
  fast_mana: ["lots of fast mana", "little fast mana"],
  tutors: ["many tutors", "few tutors"],
  combos: ["strong combos", "no fast combos"],
  interaction: ["good interaction", "little interaction"],
  draw: ["good card draw", "little card draw"],
  ramp: ["good ramp", "little ramp"],
  mana_base: ["a strong mana base", "a weak mana base"],
};

/** "Bracket 3 because of 2 Game Changers. Score 6.5: good ramp, few tutors." */
function powerSentence(b, s) {
  const out = [];
  if (b) {
    const floors = asList(b.reasons).filter((r) => r.floor > 2);
    const auto = `${b.partial ? "≥" : ""}${b.auto}`;
    let lead;
    if (b.declared != null) lead = `Bracket ${b.declared}, set by you${b.declared !== b.auto ? ` (the rules say ${auto})` : ""}`;
    else if (!floors.length) lead = `Bracket ${auto}: nothing pushes it higher`;
    else {
      const f = floors[0];
      const why = REASON_SHORT[f.rule]?.(f) ?? "the rules";
      lead = `Bracket ${auto} because of ${why}${floors.length > 1 ? ` and ${plural(floors.length - 1, "more reason")}` : ""}`;
    }
    out.push(`${lead}.`);
  }
  if (s) {
    const cats = asList(s.breakdown).filter((c) => c.max > 0 && !(s.partial && c.key === "combos"));
    const ratio = (c) => c.points / c.max;
    const strong = [...cats].sort((x, y) => ratio(y) - ratio(x)).filter((c) => ratio(c) >= 0.6)[0];
    const weak = [...cats].sort((x, y) => ratio(x) - ratio(y)).filter((c) => ratio(c) <= 0.3 && c !== strong)[0];
    const parts = [strong && CAT_WORDS[strong.key]?.[0], weak && CAT_WORDS[weak.key]?.[1]].filter(Boolean);
    out.push(`Score ${s.partial ? "≥ " : ""}${fmtScore(s.value)}${parts.length ? `: ${parts.join(", ")}` : ""}.`);
  }
  return out.join(" ");
}

function ReasonItem({ r }) {
  const level = r.level === "bad" ? "bad" : r.level === "warn" ? "warn" : "";
  return (
    <li className="pw-reason">
      <span className={`badge fl ${level}`}>{level === "bad" ? "✗" : level === "warn" ? "⚠" : r.floor != null ? `≥${r.floor}` : "i"}</span>
      <span className="tx">
        {r.text}{r.borderline && !/borderline/i.test(r.text || "") ? " (borderline)" : ""}
        {r.url && <> · <a href={r.url} target="_blank" rel="noopener noreferrer">combo</a></>}
      </span>
      {asList(r.cards).length > 0 && !r.url && (
        <span className="cards">
          {r.cards.map((c, i) => (
            <span key={`${c.name}|${i}`} className="pw-card" title={c.why ? `why: ${c.why}` : undefined}>
              {c.name}{c.source && <span className="src">{SOURCE_LABEL[c.source] || c.source}</span>}
            </span>
          ))}
        </span>
      )}
    </li>
  );
}

/** A 0-10 bar as inline SVG (scales with its column). */
function TenBar({ value, color = "var(--accent)" }) {
  const v = Math.max(0, Math.min(10, Number(value) || 0));
  return (
    <svg viewBox="0 0 100 10" preserveAspectRatio="none" aria-hidden="true" focusable="false">
      <rect x="0" y="0" width="100" height="10" rx="3" fill="var(--surface-3)" />
      {v > 0 && <rect x="0" y="0" width={v * 10} height="10" rx="3" fill={color} />}
    </svg>
  );
}

function ScoreBreakdown({ score }) {
  const [open, setOpen] = useState(null);
  return (
    <div className="pw-cats">
      {asList(score.breakdown).map((c) => {
        const expanded = open === c.key;
        const cards = asList(c.cards);
        return (
          <React.Fragment key={c.key}>
            <button type="button" className="pw-cat" aria-expanded={cards.length ? expanded : undefined}
              onClick={() => cards.length && setOpen(expanded ? null : c.key)} style={cards.length ? null : { cursor: "default" }}>
              <span className="nm">{c.label}{cards.length > 0 && <span className="muted" aria-hidden="true"> {expanded ? "▾" : "▸"}</span>}</span>
              <TenBar value={c.bar} />
              <span className="pt">{fmtNum2(c.points)}/{fmtNum2(c.max)}</span>
              <span className="wd">{c.words}{c.note ? ` · ${c.note}` : ""}</span>
            </button>
            {expanded && <ul className="pw-cat-cards">{cards.map((n) => <li key={n}>{n}</li>)}</ul>}
          </React.Fragment>
        );
      })}
    </div>
  );
}

function comboStatus(c) {
  if (!c) return { text: "Combos not checked", tone: "warn" };
  switch (c.status) {
    case "ok": return { text: `Combos checked ${fmtAgo(c.fetched_at)}`, tone: "" };
    case "stale": return { text: `Combos from ${fmtDate(c.fetched_at)} (an update is due)`, tone: "" };
    case "pending": return { text: "Checking combos…", tone: "", busy: true };
    case "offline": return { text: `Offline: combos not checked${c.fetched_at ? ` (last try ${fmtAgo(c.fetched_at)})` : ""}`, tone: "warn" };
    case "disabled": return { text: "Combos: off (Settings → Online services)", tone: "" };
    default: return { text: "Combos not checked", tone: "warn" };
  }
}

/** Details of the bracket and score: one sentence, ≤3 reasons, picker, breakdown, combos. */
function PowerSheet({ deck, onClose, onChanged }) {
  const { bracket: b, score: s, legality, combos } = deckPowerOf(deck);
  const [showAll, setShowAll] = useState(false);
  const [allCombos, setAllCombos] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [msg, setMsg] = useState(null);
  const timer = useRef(null);
  useEffect(() => () => clearTimeout(timer.current), []);

  const reasons = asList(b?.reasons);
  const shown = showAll ? reasons : reasons.slice(0, 3);
  const info = asList(b?.info);
  const hidden = reasons.length - shown.length + (showAll ? 0 : info.length);
  const items = comboItems(combos);
  const unresolved = comboUnresolved(combos);
  const st = comboStatus(combos);
  const disabled = combos?.status === "disabled";

  const declare = async (v) => {
    if (!b || busy || (b.declared ?? null) === v) return;
    setBusy(true); setError(null);
    try {
      await api(`/api/decks/${deck.id}`, { method: "PATCH", json: { bracket_declared: v } });
      onChanged();
    } catch (e) { setError(e.message); } finally { setBusy(false); }
  };
  const refresh = async () => {
    setBusy(true); setError(null); setMsg(null);
    try {
      await api(`/api/decks/${deck.id}/combos`, { method: "POST" });
      setMsg("Checking combos…");
      clearTimeout(timer.current);
      timer.current = setTimeout(() => { setMsg(null); onChanged(); }, 4000);
    } catch (e) {
      if (e.status === 409) setMsg(`The combo check is paused (Commander Spellbook was unreachable or asked us to wait). Try again ${e.data?.retry_at ? fmtAgo(e.data.retry_at) : "in a few minutes"}.`);
      else if (e.status === 503) setMsg("The combo check is off. Turn it on in Settings → Online services.");
      else setError(e.message);
    } finally { setBusy(false); }
  };

  const sentence = powerSentence(b, s);
  return (
    <Sheet title="Power level" onClose={onClose}>
      <div className="pw">
        <div className="stack" style={{ gap: 6 }}>
          <p className="pw-lead">{sentence}</p>
          {b && <p className="pw-sub small muted">Bracket {b.value} {b.label}: {b.meaning}.</p>}
          {b?.cedh_hint && <p className="pw-sub small">Looks cEDH-like. Set 5 below if that is the intent.</p>}
        </div>

        {b && (
          <section className="stack" style={{ gap: 8 }} aria-labelledby="pw-why">
            <h3 id="pw-why">Why</h3>
            <ul className="pw-reasons">{shown.map((r, i) => <ReasonItem key={`${r.rule}|${i}`} r={r} />)}</ul>
            {showAll && info.length > 0 && <ul className="pw-info">{info.map((t) => <li key={t}>{t}</li>)}</ul>}
            {showAll && legality?.notes?.length > 0 && <ul className="pw-info">{legality.notes.map((t) => <li key={t}>{t}</li>)}</ul>}
            {(hidden > 0 || showAll) && (
              <div><button type="button" className="btn ghost sm" onClick={() => setShowAll(!showAll)} aria-expanded={showAll}>
                {showAll ? "Show less" : `Show all (${hidden} more)`}
              </button></div>
            )}
          </section>
        )}

        {b && (
          <section className="stack" style={{ gap: 8 }} aria-labelledby="pw-pick">
            <h3 id="pw-pick">Your bracket</h3>
            <div className="bracket-pick" role="group" aria-labelledby="pw-pick">
              <button type="button" aria-pressed={b.declared == null} disabled={busy} onClick={() => declare(null)}>Auto {b.partial ? "≥" : ""}{b.auto}</button>
              {[1, 2, 3, 4, 5].map((n) => (
                <button key={n} type="button" aria-pressed={b.declared === n} disabled={busy} onClick={() => declare(n)} title={`${n} ${BRACKET_LABEL[n]}`}>{n}</button>
              ))}
            </div>
            <p className="small muted" style={{ margin: 0 }}>Brackets 1 (Exhibition) and 5 (cEDH) are about intent, so only you set them. The app never picks them.</p>
          </section>
        )}

        {s && (
          <section className="stack" style={{ gap: 6 }} aria-labelledby="pw-score">
            <h3 id="pw-score">Score {s.partial ? "≥ " : ""}{fmtScore(s.value)}/10</h3>
            {s.note && <p className="small muted" style={{ margin: 0 }}>{s.note}.</p>}
            {s.unknown > 0 && <p className="small muted" style={{ margin: 0 }}>{plural(s.unknown, "card")} not known yet: they add nothing.</p>}
            <ScoreBreakdown score={s} />
            <p className="small muted" style={{ margin: 0 }}>Score bands follow the <a href="https://playgroup.gg/commander/bracket-calculator" target="_blank" rel="noopener noreferrer">playgroup.gg</a> calculator. Tap a row for its cards.</p>
          </section>
        )}

        <section className="stack" style={{ gap: 8 }} aria-labelledby="pw-combos">
          <h3 id="pw-combos">Combos</h3>
          {disabled ? <p className="small muted" style={{ margin: 0 }}>Combos: off. Turn on the combo check in Settings → Online services.</p> : (
            <>
              {items.length > 0 ? (
                <ul className="pw-combos">
                  {(allCombos ? items : items.slice(0, 5)).map((c) => (
                    <li key={c.id}>
                      <a href={comboHref(c.id)} target="_blank" rel="noopener noreferrer">{asList(c.cards).join(" + ")}</a>
                      <span className="small muted">
                        {c.assembly_mv != null && ` · ${c.assembly_mv} mana`}
                        {asList(c.produces).length > 0 && ` · ${c.produces.slice(0, 2).join(", ")}`}
                      </span>
                    </li>
                  ))}
                </ul>
              ) : combos?.status === "ok" || combos?.status === "stale" ? <p className="small muted" style={{ margin: 0 }}>No combos found.</p> : null}
              {items.length > 5 && <div><button type="button" className="btn ghost sm" onClick={() => setAllCombos(!allCombos)}>{allCombos ? "Show fewer" : `Show all ${items.length} combos`}</button></div>}
              {unresolved.length > 0 && <p className="small muted" style={{ margin: 0 }} title={unresolved.join(", ")}>{plural(unresolved.length, "card")} not checked (Commander Spellbook doesn't know {unresolved.length === 1 ? "it" : "them"}).</p>}
              <p className="small muted" style={{ margin: 0 }}>Combos by <a href={SPELLBOOK_SITE} target="_blank" rel="noopener noreferrer">Commander Spellbook</a>.</p>
            </>
          )}
          <div className={`pw-status ${st.tone === "warn" ? "notice warn" : ""}`} role="status">
            {st.busy && <span className="spinner" aria-hidden="true" />}
            <span className="grow">{msg || st.text}</span>
            {!disabled && (
              <button type="button" className="btn sm" onClick={refresh} disabled={busy || combos?.status === "pending"}><Icon.refresh /> Refresh</button>
            )}
          </div>
          <ErrorNotice error={error} onDismiss={() => setError(null)} />
        </section>
      </div>
    </Sheet>
  );
}

/** X spells per curve bucket from the deck cards (main board, nonland, not the commander). */
function xSpellsPerBucket(cards) {
  const out = Array(8).fill(0);
  for (const c of asList(cards)) {
    if (c.board !== "main" || c.companion || c.cmc == null) continue;
    const front = String(c.type_line || "").split(" // ")[0];
    if (/\bLand\b/.test(front)) continue;
    if (!/\{X\}/i.test(String(c.mana_cost || "").split(" // ")[0])) continue;
    out[Math.min(7, Math.max(0, Math.floor(Number(c.cmc))))] += Number(c.quantity) || 1;
  }
  return out;
}

/** Mana curve: 8 stacked columns (creatures / other spells), counts above, MV below. */
function CurveChart({ curve, cards }) {
  const cr = asList(curve?.creature), ot = asList(curve?.other);
  const buckets = asList(curve?.buckets).length === 8 ? curve.buckets : ["0", "1", "2", "3", "4", "5", "6", "7+"];
  const totals = buckets.map((_, i) => (cr[i] || 0) + (ot[i] || 0));
  const max = Math.max(0, ...totals);
  if (!max) return <p className="small muted" style={{ margin: 0 }}>No spells to chart yet.</p>;
  const xs = xSpellsPerBucket(cards);
  const W = 320, top = 22, base = 124, colW = W / 8, barW = 24;
  const scale = (base - top) / max;
  const summary = buckets.map((b, i) => `${b}: ${totals[i]}`).join(", ");
  return (
    <figure style={{ margin: 0 }} className="stack">
      <svg className="curve-chart" viewBox="0 0 320 150" role="img" aria-label={`Mana curve. Mana value: count. ${summary}`}>
        <line x1="0" x2={W} y1={base + 0.5} y2={base + 0.5} stroke="var(--border)" strokeWidth="1" />
        {buckets.map((b, i) => {
          const x = i * colW + (colW - barW) / 2;
          const hc = (cr[i] || 0) * scale, ho = (ot[i] || 0) * scale;
          const gap = hc > 0 && ho > 0 ? 2 : 0;
          const tip = `Mana value ${b}: ${cr[i] || 0} creatures, ${ot[i] || 0} other${xs[i] ? `, ${xs[i]} with X` : ""}`;
          return (
            <g key={b}>
              <title>{tip}</title>
              <rect x={i * colW} y={top - 20} width={colW} height={150 - top + 20} fill="transparent" />
              {hc > 0 && <rect x={x} y={base - hc} width={barW} height={hc} rx="3" fill="var(--chart-creature)" />}
              {ho > 0 && <rect x={x} y={base - hc - ho} width={barW} height={Math.max(1, ho - gap)} rx="3" fill="var(--chart-other)" />}
              {totals[i] > 0 && (
                <text x={x + barW / 2} y={base - hc - ho - 6} textAnchor="middle" fontSize="13" fontWeight="700" fill="var(--text)">
                  {totals[i]}{xs[i] > 0 && <tspan fill="var(--muted)" fontWeight="600"> X</tspan>}
                </text>
              )}
              <text x={x + barW / 2} y="143" textAnchor="middle" fontSize="13" fill="var(--muted)">{b}</text>
            </g>
          );
        })}
      </svg>
      <figcaption className="chart-legend">
        <span><span className="sw" style={{ background: "var(--chart-creature)" }} />Creatures</span>
        <span><span className="sw" style={{ background: "var(--chart-other)" }} />Other spells</span>
        <span>Mana value below, count above</span>
        {xs.some(Boolean) && <span>X = spells with X in the cost</span>}
      </figcaption>
    </figure>
  );
}

/** One identity colour: pips share vs land-source share, warn when sources lag by >10 points. */
function ColourSplit({ colours }) {
  const per = asList(colours?.per);
  if (!per.length) return <p className="small muted" style={{ margin: 0 }}>Colourless deck: no coloured pips to match.</p>;
  return (
    <div className="cs" role="list" aria-label="Colour split: pips against land sources">
      {per.map((c) => {
        const col = `var(--mana-${String(c.c).toLowerCase()})`;
        const lag = c.pip_share != null && c.source_share != null ? Math.round((c.pip_share - c.source_share) * 100) : null;
        return (
          <div key={c.c} className="cs-row" role="listitem">
            <SymbolText text={`{${c.c}}`} />
            <div className="stack" style={{ gap: 4, minWidth: 0 }}>
              <div className="cs-line">
                <span className="k">Pips</span>
                <svg viewBox="0 0 100 10" preserveAspectRatio="none" aria-hidden="true" focusable="false">
                  <rect width="100" height="10" rx="3" fill="var(--surface-3)" />
                  {c.pip_share > 0 && <rect width={c.pip_share * 100} height="10" rx="3" fill={col} />}
                </svg>
                <span className="v">{fmtPct(c.pip_share)} · {fmtNum1(c.pips)}</span>
              </div>
              <div className="cs-line">
                <span className="k">Sources</span>
                <svg viewBox="0 0 100 10" preserveAspectRatio="none" aria-hidden="true" focusable="false">
                  <rect width="100" height="10" rx="3" fill="var(--surface-3)" />
                  {c.source_share > 0 && <rect x="0.5" y="0.5" width={Math.max(0, c.source_share * 100 - 1)} height="9" rx="3" fill={col} fillOpacity="0.45" stroke={col} strokeWidth="1" vectorEffect="non-scaling-stroke" />}
                </svg>
                <span className="v">{fmtPct(c.source_share)} · {fmtNum1(c.sources)}</span>
              </div>
              {c.warn && <span className="cs-warn">⚠ Lands make {lag} points less {c.c} than the spells ask for</span>}
            </div>
          </div>
        );
      })}
    </div>
  );
}

const STAT_TYPES = ["Creature", "Instant", "Sorcery", "Artifact", "Enchantment", "Planeswalker", "Battle", "Land"];

/** Collapsed "Stats" disclosure: curve, colour split, facts, types (all formats). */
function DeckStats({ deck, onClose }) {
  const s = deck?.stats;
  if (!s) return null;
  const commanders = asList(s.curve?.commander);
  // deckStats keys are lowercase ("creature"); accept capitalised keys too.
  const t0 = s.types || {};
  const types = Object.fromEntries(STAT_TYPES.map((t) => [t, Number(t0[t.toLowerCase()] ?? t0[t]) || 0]));
  const spells = types.Instant + types.Sorcery;
  const excl = s.excluded || {};
  return (
    <Sheet title={`Stats · ${plural(s.total ?? 0, "card")}${s.avg_mv != null ? ` · avg MV ${s.avg_mv}` : ""}`} onClose={onClose}>
      <div className="stack deck-stats">
        {(commanders.length > 0 || s.companion) && (
          <div className="type-chips">
            {commanders.map((c) => <span key={c.name} className="badge"><Icon.crown /> {c.name}{c.mv != null ? ` · MV ${c.mv}` : ""}</span>)}
            {s.companion && <span className="badge">Companion: {s.companion.name}</span>}
          </div>
        )}
        <CurveChart curve={s.curve} cards={deck.cards} />
        <ColourSplit colours={s.colours} />
        <div className="stats">
          <div className="stat"><div className="v">{fmtInt(s.lands)}{s.mdfc_lands > 0 ? ` + ${fmtNum1(s.mdfc_lands)}` : ""}</div><div className="k">Lands{s.mdfc_lands > 0 ? " + MDFC" : ""}</div></div>
          <div className="stat"><div className="v">{s.avg_mv ?? "—"}</div><div className="k">Avg MV</div></div>
          <div className="stat"><div className="v">{fmtInt(types.Creature || 0)}</div><div className="k">Creatures</div></div>
          <div className="stat"><div className="v">{fmtInt(spells)}</div><div className="k">Instants + sorceries</div></div>
          {s.unknown?.count > 0 && <div className="stat"><div className="v">{fmtInt(s.unknown.count)}</div><div className="k">Unknown</div></div>}
        </div>
        <div className="type-chips">
          {STAT_TYPES.filter((t) => types[t] > 0).map((t) => <span key={t} className="badge">{t} {fmtInt(types[t])}</span>)}
        </div>
        {s.unknown?.count > 0 && <p className="small muted" style={{ margin: 0 }}>Not counted (card data missing): {s.unknown.names.slice(0, 8).join(", ")}{s.unknown.names.length > 8 ? ", …" : ""}</p>}
        {s.x_spells?.count > 0 && <p className="small muted" style={{ margin: 0 }}>{plural(s.x_spells.count, "X spell")} counted at their base cost: {s.x_spells.names.slice(0, 6).join(", ")}{s.x_spells.names.length > 6 ? ", …" : ""}</p>}
        {(excl.side > 0 || excl.maybe > 0) && <p className="small muted" style={{ margin: 0 }}>Not in the stats: {[excl.side > 0 && `${excl.side} sideboard`, excl.maybe > 0 && `${excl.maybe} maybe`].filter(Boolean).join(", ")}.</p>}
      </div>
    </Sheet>
  );
}

const COLOUR_NAMES = { W: "white", U: "blue", B: "black", R: "red", G: "green" };
const colourWords = (c) => (c ? c.split("").map((x) => COLOUR_NAMES[x] ?? x).join(" ") : "colorless");
const fromCards = (from) => asList(from).map((f) => `${f.name}${f.quantity > 1 ? ` ×${f.quantity}` : ""}${f.side ? " (side)" : ""}`).join(", ");

/**
 * Collapsed "Tokens & extras" disclosure (deck.accessories): token tiles (image, P/T, which cards
 * make them, how many to have ready, how many you own and where), then counters/dice/markers.
 */
/** Chip text for Tokens & extras ("2 tokens · 1 extra"), null when there is nothing. */
const extrasSummary = (deck) => {
  const a = deck?.accessories;
  if (!a) return null;
  const t = asList(a.tokens).length, m = asList(a.markers).length;
  if (!t && !m) return a.status === "pending" ? "Tokens…" : null;
  return [t && plural(t, "token"), m && plural(m, "extra", "extras")].filter(Boolean).join(" · ");
};

function DeckExtras({ deck, onClose }) {
  const a = deck?.accessories;
  if (!a) return null;
  const tokens = asList(a.tokens);
  const markers = asList(a.markers);
  if (!tokens.length && !markers.length && a.status !== "pending") return null;
  const sum = [tokens.length && plural(tokens.length, "token"), markers.length && plural(markers.length, "extra", "extras")].filter(Boolean).join(" · ");
  return (
    <Sheet title={`Tokens & extras${sum ? ` · ${sum}` : ""}`} onClose={onClose}>
      <div className="stack deck-extras">
        {a.status === "pending" && <p className="small muted" role="status" style={{ margin: 0 }}>Checking token details…</p>}
        {a.status === "unavailable" && <p className="small muted" style={{ margin: 0 }}>Token details aren't available right now: names come from the card text.</p>}
        {tokens.length > 0 && (
          <div className="token-grid">
            {tokens.map((t) => {
              const own = t.owned?.quantity ?? 0;
              const where = asList(t.owned?.binders).map((b) => `${b.binder || UNSORTED}${asList(t.owned?.binders).length > 1 ? ` ${b.quantity}` : ""}`).join(", ");
              return (
                <div key={t.key} className="token-tile">
                  <span className="cover" aria-hidden="true">
                    {t.image_small ? <img src={t.image_small} alt="" loading="lazy" decoding="async" width="146" height="204" /> : <span className="ph">{t.pt || "T"}</span>}
                  </span>
                  <div className="info">
                    <div className="nm"><b>{t.name}</b>{t.pt && <span className="badge">{t.pt}</span>}{t.side_only && <span className="badge">side</span>}</div>
                    <span className="small muted">{t.pt ? `${colourWords(t.colors)} · ` : ""}{t.type_line || "Token"}</span>
                    <span className="small">from {fromCards(t.from)}</span>
                    <span className="small"><b>Have ~{t.estimate}{t.estimate >= 20 ? "+" : ""}</b> ready{t.estimate_note ? <span className="muted"> ({t.estimate_note})</span> : null}</span>
                    <span className={`small ${own >= t.estimate ? "ok-text" : "muted"}`}>{own ? `You own ${own}${where ? ` (${where})` : ""}` : "You own none"}</span>
                  </div>
                </div>
              );
            })}
          </div>
        )}
        {markers.length > 0 && (
          <ul className="extra-list">
            {markers.map((m) => (
              <li key={m.key}>
                <b>{m.label}</b>{m.side_only && <span className="badge">side</span>}
                <span className="small muted">{fromCards(m.from)}{m.note ? ` · ${m.note}` : ""}</span>
              </li>
            ))}
          </ul>
        )}
        {a.maybe_skipped > 0 && <p className="small muted" style={{ margin: 0 }}>Maybeboard not included.</p>}
      </div>
    </Sheet>
  );
}

/** Settings → Online services: the Commander Spellbook combo check (shared by the server and the planner). */
function SpellbookPanel({ health, dataVersion }) {
  const { data: settings, error: loadError, setData } = useApi("/api/settings", [dataVersion], { error: (e) => `Could not load settings: ${e.message}` });
  const [busy, setBusy] = useState(false);
  const [actionError, setError] = useState(null);
  const error = actionError ?? loadError;
  const enabled = typeof settings?.spellbook_enabled === "boolean" ? settings.spellbook_enabled : null;
  const forced = Boolean(settings?.spellbook?.env_disabled);
  const show = (on, envOff) => setData((d) => ({ ...d, spellbook_enabled: on, spellbook: { ...d?.spellbook, env_disabled: envOff } }));
  const toggle = async (on) => {
    setBusy(true); setError(null); show(enabled, false);
    try {
      const d = await api("/api/settings", { method: "PATCH", json: { spellbook_enabled: on } });
      const now = typeof d?.spellbook_enabled === "boolean" ? d.spellbook_enabled : on;
      show(now, on && !now);
    } catch (e) {
      // 409: SPELLBOOK_ENABLED=false on the server keeps it off.
      if (on && e.status === 409) show(false, true); else setError(e.message);
    } finally { setBusy(false); }
  };
  const sb = health?.spellbook;
  const backoff = sb?.backoff_until && parseTs(sb.backoff_until) > new Date() ? sb.backoff_until : null;
  return (
    <section className="card stack" aria-labelledby="spellbook-title">
      <h2 id="spellbook-title">Combo check (Commander Spellbook)</h2>
      <p className="small muted" style={{ margin: 0 }}>
        Finds combos and a second bracket opinion for commander decks. It sends the card names and quantities of the deck
        (and this server's public IP) to backend.commanderspellbook.com after each deck change. Results are kept for 14 days.
      </p>
      {enabled === null && !error ? <p className="small muted" style={{ margin: 0 }}>Not available on this server version.</p> : (
        <label className="switch"><input type="checkbox" checked={Boolean(enabled)} disabled={busy || enabled === null} onChange={(e) => toggle(e.target.checked)} /> Check combos online</label>
      )}
      {forced && <div className="notice warn" role="status">The server keeps it off (SPELLBOOK_ENABLED=false).</div>}
      {enabled && sb && (
        <p className="small muted" style={{ margin: 0 }}>
          {sb.last_ok ? `Last check ${fmtAgo(sb.last_ok)}` : "No check yet"}
          {sb.cache_entries != null ? ` · ${plural(sb.cache_entries, "result")} cached` : ""}
          {backoff ? ` · paused until ${fmtDate(backoff)}` : ""}
          {sb.last_error && !sb.last_ok ? ` · last error: ${typeof sb.last_error === "object" ? sb.last_error.message ?? `HTTP ${sb.last_error.status}` : sb.last_error}` : ""}
        </p>
      )}
      <ErrorNotice error={error} onDismiss={() => setError(null)} />
    </section>
  );
}
