"use strict";

// ===========================================================================
// Edit / delete owned copies (card sheet, collection Select mode) and the
// edit log (Settings → Collection → Recent changes). Every edit and delete is
// logged on the server and can be undone (POST /api/collection/edits/:id/undo).
// ===========================================================================

const COPY_FINISH_LABEL = { normal: "Non-foil", foil: "Foil", etched: "Etched" };
// Index printings say "nonfoil", collection rows "normal".
const collFinish = (f) => (f === "nonfoil" || !f ? "normal" : f);
const FINISH_PRICE_KEY = { normal: "eur", foil: "eur_foil", etched: "eur_etched" };
const copyLabel = (r) => `${(r.set_code || "").toUpperCase()} #${r.collector_number}`;

/** EUR price of one copy of an owned row: the row's own price_eur, else the open card's price when it is that printing. */
function rowUnitEur(card, r) {
  if (typeof r.price_eur === "number" && Number.isFinite(r.price_eur)) return r.price_eur;
  const prices = r.prices && typeof r.prices === "object" ? r.prices : card && r.scryfall_id === card.scryfall_id ? card.prices : null;
  const v = prices?.[FINISH_PRICE_KEY[collFinish(r.finish)] || "eur"];
  return v != null && Number.isFinite(Number(v)) ? Number(v) : null;
}
/** The row key the edit/delete/move endpoints take, plus the quantity. */
const rowItem = (r, quantity) => ({
  scryfall_id: r.scryfall_id, finish: r.finish, language: r.language, condition: r.condition, binder: r.binder ?? "",
  ...(r.source ? { source: r.source } : {}), quantity,
});
/** Move/delete items for a Select-mode selection: whole cards (oracle_id) or printings, only from `binder` when set. */
const selectionItems = (items, group, binder = null) => items.map((i) => {
  const from = binder != null ? { from_binder: binder } : {};
  return group === "card" && i.oracle_id ? { oracle_id: i.oracle_id, ...from } : { printing_id: i.scryfall_id, ...from };
});
/** "A, B, C and 4 more": the first six names of a selection. */
const selectionNames = (items) => `${items.slice(0, 6).map((i) => i.name).join(", ")}${items.length > 6 ? ` and ${items.length - 6} more` : ""}`;

/** One owned row: "MOM #12 · IT · Foil · Near Mint · in Trade binder". */
function CopyLine({ row, extra = null }) {
  return (
    <span className="small muted" style={{ overflowWrap: "anywhere" }}>
      {copyLabel(row)} {row.language && row.language !== "en" ? <LangTag lang={row.language} /> : "· EN"} · {COPY_FINISH_LABEL[collFinish(row.finish)] || row.finish} · {conditionLabel(row.condition)} · in <b>{row.binder || UNSORTED}</b>
      {row.source && <> <SourceBadge source={row.source} /></>}{extra}
    </span>
  );
}

/**
 * Edit owned copies: language, printing (same card, picker with images), finish (only
 * the printing's finishes), condition, and how many copies (a smaller number splits the row).
 * ManaBox copies become app copies (confirm_master once, like a move).
 */
function EditCopySheet({ card, row, onClose, onDone }) {
  const [guarded, masterDialog] = useMasterConfirm();
  const origLang = row.language || "en";
  const [lang, setLang] = useState(origLang);
  const [pid, setPid] = useState(row.scryfall_id);
  const [finish, setFinish] = useState(collFinish(row.finish));
  const [condition, setCondition] = useState(row.condition || "near_mint");
  const [qty, setQty] = useState(row.quantity);
  const [prints, setPrints] = useState(null); // normPrinting[] of this card, every language
  const [printsError, setPrintsError] = useState(null);
  const [picked, setPicked] = useState({}); // printings chosen in the picker: id → normPrinting
  const [picking, setPicking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  useEffect(() => {
    let alive = true;
    api(`/api/printings?${new URLSearchParams({ oracle_id: card.oracle_id })}`)
      .then((d) => { if (alive) setPrints(asList(d).map(normPrinting).filter((p) => p && p.id)); })
      .catch((e) => { if (alive) setPrintsError(e.status === 503 ? "The card index is not ready, so only this printing can be used." : e.message); });
    return () => { alive = false; };
  }, [card.oracle_id]);

  const fromRow = { id: row.scryfall_id, set: String(row.set_code || "").toLowerCase(), cn: row.collector_number, set_name: row.set_name || "", lang: "", imgSmall: row.image_small, finishes: [] };
  const byId = (id) => picked[id] || prints?.find((p) => p.id === id) || (id === row.scryfall_id ? fromRow : null);
  const cur = byId(pid) || fromRow;
  const orig = byId(row.scryfall_id) || fromRow;
  const finishes = cur.finishes?.length ? [...new Set(cur.finishes.map(collFinish))] : [...new Set(["normal", "foil", collFinish(row.finish)])];
  const effFinish = finishes.includes(finish) ? finish : finishes[0];
  const pLabel = (p) => `${String(p.set || "").toUpperCase()} #${p.cn}${p.lang ? ` (${p.lang.toUpperCase()})` : ""}`;

  // A new language switches to the same set + number in that language when the index has it.
  const changeLang = (l) => {
    setLang(l);
    const sib = prints?.find((p) => p.lang === l && p.set === cur.set && String(p.cn) === String(cur.cn));
    if (sib) setPid(sib.id);
  };
  const noSibling = prints && cur.lang && cur.lang !== lang;

  const changes = [];
  if (pid !== row.scryfall_id) changes.push(["Printing", pLabel(orig), pLabel(cur)]);
  if (lang !== origLang) changes.push(["Language", LANG_NAME[origLang] || origLang.toUpperCase(), LANG_NAME[lang] || lang.toUpperCase()]);
  if (effFinish !== collFinish(row.finish)) changes.push(["Finish", COPY_FINISH_LABEL[collFinish(row.finish)] || row.finish, COPY_FINISH_LABEL[effFinish] || effFinish]);
  if (condition !== (row.condition || "near_mint")) changes.push(["Condition", conditionLabel(row.condition), conditionLabel(condition)]);

  const submit = async (e) => {
    e.preventDefault();
    if (!changes.length || busy) return;
    const set = {};
    if (lang !== origLang) set.language = lang;
    if (pid !== row.scryfall_id) set.printing_id = pid;
    if (effFinish !== collFinish(row.finish)) set.finish = effFinish;
    if (condition !== (row.condition || "near_mint")) set.condition = condition;
    setBusy(true); setError(null);
    try {
      const res = await guarded((confirm) => api("/api/collection/edit", { method: "POST", json: { items: [rowItem(row, qty)], set, confirm_master: confirm, actor: "app" } }));
      if (res) onDone(res);
    } catch (err) { setError(err.message); } finally { setBusy(false); }
  };

  return (
    <Sheet title={`Edit ${card.name}`} onClose={onClose}>
      <form className="stack" onSubmit={submit}>
        <CopyLine row={row} extra={<> · {plural(row.quantity, "copy", "copies")}</>} />
        <div className="field">
          <span className="label" id="edit-printing-label">Printing</span>
          <div className="edit-printing" aria-labelledby="edit-printing-label">
            {cur.imgSmall || cur.img ? <img src={cur.imgSmall || cur.img} alt="" /> : <span className="ph" />}
            <span className="grow" style={{ minWidth: 0 }}>
              <b>{pLabel(cur)}</b><br /><span className="small muted" style={{ overflowWrap: "anywhere" }}>{cur.set_name}</span>
            </span>
            <button type="button" className="btn sm" onClick={() => setPicking(true)} disabled={Boolean(printsError)}>Change…</button>
          </div>
          {printsError && <span className="small muted">{printsError}</span>}
        </div>
        <div className="field">
          <label htmlFor="edit-lang">Language</label>
          <select id="edit-lang" className="select" value={lang} onChange={(e) => changeLang(e.target.value)}>
            {CARD_LANGS.map(([k, l]) => <option key={k} value={k}>{l} ({k.toUpperCase()})</option>)}
          </select>
          {noSibling && <span className="small muted">The card index has no {LANG_NAME[lang] || lang} printing of {String(cur.set).toUpperCase()} #{cur.cn}. The copy keeps this printing and is marked {lang.toUpperCase()}.</span>}
        </div>
        <div className="field">
          <span className="label" id="edit-finish-label">Finish</span>
          <div className="segmented" role="group" aria-labelledby="edit-finish-label" style={{ justifySelf: "start" }}>
            {finishes.map((f) => (
              <button key={f} type="button" aria-pressed={effFinish === f} onClick={() => setFinish(f)}>{f !== "normal" && "✦ "}{COPY_FINISH_LABEL[f] || f}</button>
            ))}
          </div>
          {finishes.length === 1 && cur.finishes?.length > 0 && <span className="small muted">This printing only exists as {COPY_FINISH_LABEL[finishes[0]] || finishes[0]}.</span>}
        </div>
        <div className="field">
          <label htmlFor="edit-cond">Condition</label>
          <select id="edit-cond" className="select" value={condition} onChange={(e) => setCondition(e.target.value)}>
            {CONDITIONS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
          </select>
        </div>
        {row.quantity > 1 && (
          <div className="stack" style={{ gap: 4 }}>
            <Stepper big label="Copies to change" value={qty} max={row.quantity} onChange={setQty} />
            {qty < row.quantity && <span className="small muted">The other {plural(row.quantity - qty, "copy", "copies")} stay as they are.</span>}
          </div>
        )}
        {changes.length > 0 && (
          <ul className="edit-diff" aria-label="Changes">
            {changes.map(([k, a, b]) => <li key={k}><b>{k}:</b> {a} → <b>{b}</b></li>)}
          </ul>
        )}
        {row.source === "manabox" && changes.length > 0 && (
          <span className="small muted">These copies came from ManaBox. After the edit they belong to mtg-planner, so a ManaBox import won't change them back.</span>
        )}
        <ErrorNotice error={error} />
        <button type="submit" className="btn primary" disabled={!changes.length || busy}>
          {busy ? "Saving…" : changes.length ? `Save: ${plural(qty, "copy", "copies")}` : "No changes"}
        </button>
      </form>
      {picking && (
        <PrintingPicker title={`Printing of ${card.name}`} oracleId={card.oracle_id} lang={lang} currentId={pid}
          onClose={() => setPicking(false)}
          onPick={(p) => {
            setPicked((m) => ({ ...m, [p.id]: p }));
            setPid(p.id);
            if (p.lang) setLang(p.lang);
            setPicking(false);
          }} />
      )}
      {masterDialog}
    </Sheet>
  );
}

/**
 * The buttons of a two-step delete (`step` 1 | 2, kept by the parent): step 1 "Delete <what>…" + Cancel,
 * step 2 the `warning`, `confirm` (e.g. a typed count; it then takes the focus) and the red "Delete <what>"
 * + Back. Each step's buttons have their own key and step 2's Back gets the focus: a held Enter on step 1's
 * button must not also press the final one.
 */
function TwoStepDelete({ step, what, warning, confirm = null, error, busy, canStart = true, ready = true, onStep, onDelete, onCancel, onBack }) {
  if (step === 1) {
    return (
      <>
        <ErrorNotice error={error} />
        <div key="step1" className="row">
          <button type="button" className="btn danger grow" disabled={!canStart} onClick={() => onStep(2)}><Icon.trash /> Delete {what}…</button>
          <button type="button" className="btn ghost" onClick={onCancel}>Cancel</button>
        </div>
      </>
    );
  }
  return (
    <>
      <div className="notice error" role="alert">
        <span aria-hidden="true">⚠️</span>
        <div className="grow">{warning}</div>
      </div>
      {confirm}
      <ErrorNotice error={error} />
      <div key="step2" className="row">
        <button type="button" className="btn danger-fill grow" disabled={busy || !ready} onClick={onDelete}>
          {busy ? "Deleting…" : <><Icon.trash /> Delete {what}</>}
        </button>
        <button type="button" className="btn ghost" disabled={busy} onClick={onBack} autoFocus={!confirm}>Back</button>
      </div>
    </>
  );
}

/** Delete owned copies of one row: 1st step shows what goes, 2nd a red "Delete N copies". */
function DeleteCopySheet({ card, row, onClose, onDone }) {
  const [guarded, masterDialog] = useMasterConfirm();
  const [step, setStep] = useState(1);
  const [qty, setQty] = useState(row.quantity);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const unit = rowUnitEur(card, row);
  const what = plural(qty, "copy", "copies");
  const run = async () => {
    if (busy) return;
    setBusy(true); setError(null);
    try {
      const res = await guarded((confirm) => api("/api/collection/delete", { method: "POST", json: { items: [rowItem(row, qty)], confirm: true, expected_copies: qty, confirm_master: confirm } }));
      if (res) onDone(res, qty);
    } catch (err) { setError(err.message); } finally { setBusy(false); }
  };
  return (
    <Sheet title={`Delete ${card.name}?`} onClose={onClose}>
      <div className="stack">
        <dl className="kv">
          <dt>Card</dt><dd><b>{card.name}</b></dd>
          <dt>Printing</dt><dd>{copyLabel(row)} {row.language && row.language !== "en" ? <LangTag lang={row.language} /> : "· EN"} · {COPY_FINISH_LABEL[collFinish(row.finish)] || row.finish} · {conditionLabel(row.condition)}</dd>
          <dt>Binder</dt><dd>{row.binder || UNSORTED}{row.source && <> <SourceBadge source={row.source} /></>}</dd>
          <dt>Copies</dt><dd>{step === 1 ? `${qty} of ${row.quantity}` : <b>{what}</b>}</dd>
          <dt>Value</dt><dd>{unit == null ? "no price" : `${fmtEur(unit * qty)}${qty > 1 ? ` (${fmtEur(unit)} each)` : ""}`}</dd>
        </dl>
        {step === 1 && row.quantity > 1 && <Stepper big label="Copies to delete" value={qty} max={row.quantity} onChange={setQty} />}
        {step === 1 && row.source === "manabox" && <span className="small muted">These copies came from ManaBox. If ManaBox is still the master you'll be asked to make mtg-planner the master first; later imports leave them deleted.</span>}
        <TwoStepDelete step={step} what={what} error={error} busy={busy} onStep={setStep} onDelete={run} onCancel={onClose}
          onBack={() => { setStep(1); setError(null); }}
          warning={<><b>{what} of {card.name}</b> leave your collection. You can undo it right after, or later in Settings → Collection → Recent changes.</>} />
      </div>
      {masterDialog}
    </Sheet>
  );
}

/**
 * Delete every copy of the selected cards/printings (only those in `binder` when a binder
 * filter is on). Counts the copies first (GET /api/cards/:id per selection, so copies a search
 * hides are counted too); the 2nd step needs that number typed in.
 */
function BulkDeleteSheet({ items, group, binder, onClose, onDone }) {
  const [guarded, masterDialog] = useMasterConfirm();
  const [step, setStep] = useState(1);
  const [count, setCount] = useState(null); // {copies, value, unpriced, manabox}
  const [countError, setCountError] = useState(null);
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [recount, setRecount] = useState(0);
  const scoped = binder != null;
  const itemsKey = items.map((i) => i.key || i.scryfall_id).join("|");
  useEffect(() => {
    let alive = true;
    (async () => {
      const queue = [...items];
      let copies = 0, value = 0, unpriced = 0, manabox = 0;
      const worker = async () => {
        while (queue.length && alive) {
          const it = queue.shift();
          const d = await api(`/api/cards/${encodeURIComponent(it.scryfall_id)}`);
          for (const r of asList(d?.owned)) {
            if (group !== "card" && r.scryfall_id !== it.scryfall_id) continue;
            if (scoped && !sameName(r.binder || "", binder) && !(binder === "" && !r.binder)) continue;
            copies += r.quantity;
            if (r.source === "manabox") manabox += r.quantity;
            const u = rowUnitEur(d.card, r);
            if (u == null) unpriced += r.quantity; else value += u * r.quantity;
          }
        }
      };
      try {
        await Promise.all(Array.from({ length: Math.min(4, queue.length) }, worker));
        if (alive) setCount({ copies, value: Math.round(value * 100) / 100, unpriced, manabox });
      } catch (e) { if (alive) setCountError(`Could not count the copies: ${e.message}`); }
    })();
    return () => { alive = false; };
    // The parent passes a fresh array each render: count once per selection.
  }, [itemsKey, group, binder, scoped, recount]); // eslint-disable-line react-hooks/exhaustive-deps
  const n = count?.copies ?? 0;
  const run = async () => {
    if (busy || Number(typed) !== n) return;
    setBusy(true); setError(null);
    const list = selectionItems(items, group, binder);
    try {
      const res = await guarded((confirm) => api("/api/collection/delete", { method: "POST", json: { items: list, confirm: true, expected_copies: n, confirm_master: confirm } }));
      if (res) onDone(res, n);
    } catch (err) {
      if (err.data?.code === "changed") {
        // Copies were added or removed since the count: nothing was deleted; count again.
        setError(`The copies changed meanwhile (now ${plural(err.data.copies ?? 0, "copy", "copies")}); nothing was deleted. Check the new count.`);
        setCount(null); setTyped(""); setStep(1); setRecount((x) => x + 1);
      } else setError(err.message);
    } finally { setBusy(false); }
  };
  const what = plural(items.length, group === "card" ? "card" : "printing");
  return (
    <Sheet title={`Delete ${what}?`} onClose={onClose}>
      <div className="stack">
        <span className="small" style={{ overflowWrap: "anywhere" }}>{selectionNames(items)}</span>
        <span className="small muted">{scoped
          ? `Only copies in ${binder || UNSORTED} are deleted.`
          : `Every copy of the selected ${group === "card" ? "cards (all printings)" : "printings"} is deleted, from all binders, also copies your search hides.`}</span>
        <ErrorNotice error={countError} />
        {!count && !countError && <Spinner label="Counting copies…" />}
        {count && (
          <dl className="kv">
            <dt>Copies</dt><dd><b>{fmtInt(n)}</b>{count.manabox ? <span className="muted"> ({fmtInt(count.manabox)} from ManaBox)</span> : null}</dd>
            <dt>Value</dt><dd>{fmtEur(count.value)}{count.unpriced ? <span className="muted"> + {fmtInt(count.unpriced)} without a price</span> : null}</dd>
          </dl>
        )}
        {count && n === 0 && <p className="muted" style={{ margin: 0 }}>Nothing to delete.</p>}
        <TwoStepDelete step={step} what={count ? plural(n, "copy", "copies") : "copies"} error={error} busy={busy}
          canStart={Boolean(count) && n > 0} ready={Boolean(typed) && Number(typed) === n} onStep={setStep} onDelete={run} onCancel={onClose}
          onBack={() => { setStep(1); setTyped(""); setError(null); }}
          warning={<><b>{plural(n, "copy", "copies")} leave your collection.</b> You can undo it right after, or later in Settings → Collection → Recent changes.</>}
          confirm={(
            <div className="field">
              <label htmlFor="bulk-del-count">Type <b>{n}</b> to confirm</label>
              <input id="bulk-del-count" className="input" style={{ fontSize: 16 }} inputMode="numeric" autoComplete="off" autoFocus
                value={typed} onChange={(e) => setTyped(e.target.value.replace(/\D/g, ""))} placeholder={String(n)} />
            </div>
          )} />
      </div>
      {masterDialog}
    </Sheet>
  );
}

const EDIT_KIND_LABEL = { edit: "edit", delete: "delete", relanguage: "language fix", add: "added" };
const EDIT_KIND_BADGE = { edit: "accent", delete: "bad", relanguage: "warn", add: "ok" };
const EDIT_ACTOR_LABEL = { app: "you", claude: "✦ Claude", maintenance: "maintenance" };

/** Settings → Collection: the edit log (GET /api/collection/edits) with Undo per entry. */
/** Settings → Collection: download every owned copy as a ManaBox CSV or a plain spreadsheet CSV. */
function ExportPanel() {
  return (
    <section className="card stack" aria-labelledby="export-h">
      <h3 id="export-h">Export collection</h3>
      <p className="small muted" style={{ margin: 0 }}>Every copy, one line per binder, printing, finish, language and condition.
        <b> ManaBox CSV</b> uses ManaBox's own layout (import it there, or into another mtg-planner). <b>Spreadsheet CSV</b> adds € prices.
        One binder only: its <b>⋯</b> menu.</p>
      <div className="row">
        <a className="btn" href="/api/collection/export?format=manabox" download><Icon.download /> ManaBox CSV</a>
        <a className="btn" href="/api/collection/export?format=csv" download><Icon.download /> Spreadsheet CSV</a>
      </div>
    </section>
  );
}

function RecentChanges({ dataVersion, onChanged }) {
  const { data: edits, error, reload: load } = useApi("/api/collection/edits?limit=50", [dataVersion],
    { map: (d) => d.edits, error: (e) => `Could not load recent changes: ${e.message}` });
  const [busy, setBusy] = useState(null); // edit id being undone
  const [rowError, setRowError] = useState(null); // {id, text}
  const [all, setAll] = useState(false);
  const undo = async (ed) => {
    if (!window.confirm(`Undo this change?\n\n${ed.summary}\n\nAn undo can't be redone.`)) return;
    setBusy(ed.id); setRowError(null);
    try {
      await api(`/api/collection/edits/${encodeURIComponent(ed.id)}/undo`, { method: "POST" });
      onChanged?.();
      load();
    } catch (e) {
      setRowError({ id: ed.id, text: e.data?.code === "conflict" ? "Can't undo: these copies were changed again since. Undo the newer change first." : e.message });
    } finally { setBusy(null); }
  };
  const shown = edits ? (all ? edits : edits.slice(0, 8)) : [];
  return (
    <section className="card stack" aria-labelledby="changes-title">
      <h2 id="changes-title">Recent changes</h2>
      <p className="small muted" style={{ margin: 0 }}>Copies you (or Claude) edited or deleted. Undo puts them back exactly as they were.</p>
      <ErrorNotice error={error} onRetry={load} />
      {!edits && !error && <Spinner />}
      {edits && edits.length === 0 && <p className="muted small" style={{ margin: 0 }}>No changes yet.</p>}
      {shown.length > 0 && (
        <div>
          {shown.map((ed) => (
            <div key={ed.id} className={`change-item${ed.undone_at ? " undone" : ""}`}>
              <div className="row between" style={{ gap: 6 }}>
                <span className="row small" style={{ gap: 6 }}>
                  <span className={`badge ${EDIT_KIND_BADGE[ed.kind] || ""}`}>{EDIT_KIND_LABEL[ed.kind] || ed.kind}</span>
                  <span className="muted">{EDIT_ACTOR_LABEL[ed.actor] || ed.actor}</span>
                  <span className="muted nowrap" title={fmtDate(ed.at)}>{fmtAgo(ed.at)}</span>
                  {ed.copies != null && <span className="muted nowrap">· {plural(ed.copies, "copy", "copies")}</span>}
                </span>
                {ed.undone_at
                  ? <span className="badge" title={fmtDate(ed.undone_at)}>undone</span>
                  : ed.undoable && (
                    <button type="button" className="btn sm" disabled={busy != null} onClick={() => undo(ed)}>
                      {busy === ed.id ? "Undoing…" : <><Icon.undo /> Undo</>}
                    </button>
                  )}
              </div>
              <span className="small sum">{ed.summary}</span>
              {!ed.undone_at && !ed.undoable && ed.reason && <span className="small muted">{ed.reason}</span>}
              {rowError?.id === ed.id && <span className="small" role="alert" style={{ color: "var(--bad)" }}>{rowError.text}</span>}
            </div>
          ))}
        </div>
      )}
      {edits && edits.length > 8 && (
        <button type="button" className="btn ghost sm" style={{ justifySelf: "start" }} onClick={() => setAll(!all)}>{all ? "Show fewer" : `Show all ${edits.length}`}</button>
      )}
    </section>
  );
}
