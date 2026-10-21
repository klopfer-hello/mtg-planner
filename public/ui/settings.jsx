"use strict";

// ===========================================================================
// Import tab
// ===========================================================================

function Collapsible({ label, children }) {
  return (
    <details className="disclosure">
      <summary>{label}</summary>
      <div style={{ marginTop: 6 }}>{children}</div>
    </details>
  );
}

const IMPORT_MODE_LABEL = { delta: "Only new copies (delta)", add: "Add everything", replace: "Replace (sync)" };
// Import target choices that aren't binder names ('' = Unsorted is a real value).
const IMPORT_AS_FILE = "\u0000file";
const IMPORT_NEW_BINDER = "\u0000new";

/**
 * Delta import lists (lib/manabox.js): {name, set_code, collector_number, finish, binder, quantity}
 * (negative for a decrease).
 */
function deltaEntries(list) {
  return asList(list).map((x, i) => {
    const where = [x.set_code ? `${String(x.set_code).toUpperCase()}${x.collector_number ? ` #${x.collector_number}` : ""}` : null,
      x.finish && x.finish !== "normal" ? x.finish : null, x.binder ? `in ${x.binder}` : null].filter(Boolean).join(" · ");
    return { key: i, name: x.name, n: Math.abs(x.quantity), where };
  });
}

function DeltaLists({ s }) {
  const added = deltaEntries(s.added);
  const fewer = deltaEntries(s.decreased);
  if (!added.length && !fewer.length) {
    return s.mode === "delta" ? <p className="small muted" style={{ margin: 0 }}>Nothing new since the last ManaBox export.</p> : null;
  }
  return (
    <>
      {added.length > 0 && (
        <Collapsible label={`Added: ${plural(added.length, "row")}`}>
          <ul className="delta-list">
            {added.map((a) => <li key={a.key}><b>+{a.n}</b> {a.name}{a.where && <span className="muted"> · {a.where}</span>}</li>)}
          {s.added_truncated > 0 && <li className="muted">… and {fmtInt(s.added_truncated)} more</li>}
          </ul>
        </Collapsible>
      )}
      {fewer.length > 0 && (
        <div className="notice warn" role="status">
          <span aria-hidden="true">⚠️</span>
          <div className="grow stack" style={{ gap: 6 }}>
            <span><b>ManaBox has fewer copies of {plural(fewer.length, "card")}.</b> Nothing was removed here; delete them yourself if they are really gone.</span>
            <ul className="delta-list">
              {fewer.map((f) => <li key={f.key}>ManaBox has fewer copies of <b>{f.name}</b> (−{f.n}){f.where && <span> · {f.where}</span>}</li>)}
            {s.decreased_truncated > 0 && <li>… and {fmtInt(s.decreased_truncated)} more</li>}
            </ul>
          </div>
        </div>
      )}
    </>
  );
}

function ImportSummary({ s }) {
  if (!s) return null;
  const delta = (s.total_cards_after ?? 0) - (s.total_cards_before ?? 0);
  const stats = [
    s.total_cards_before != null || s.total_cards_after != null
      ? [`${fmtInt(s.total_cards_before)} → ${fmtInt(s.total_cards_after)}`, `Copies (${delta >= 0 ? "+" : ""}${fmtInt(delta)})`] : null,
    s.added_copies != null && s.mode === "delta" ? [`+${fmtInt(s.added_copies)}`, "Copies added"] : null,
    s.printings_added != null && s.mode !== "delta" ? [`+${fmtInt(s.printings_added)}`, "Printings added"] : null,
    s.kept_app_copies ? [fmtInt(s.kept_app_copies), "Already sorted here"] : null,
    s.matched_edit_copies ? [fmtInt(s.matched_edit_copies), "Already edited here"] : null,
    s.deleted_in_app_copies ? [fmtInt(s.deleted_in_app_copies), "Deleted here"] : null,
    s.printings_removed != null && s.mode !== "delta" ? [`−${fmtInt(s.printings_removed)}`, "Printings removed"] : null,
    s.printings_changed != null && s.mode !== "delta" ? [fmtInt(s.printings_changed), "Qty changed"] : null,
    s.decreased_copies ? [`−${fmtInt(s.decreased_copies)}`, "Fewer in ManaBox"] : null,
  ].filter(Boolean);
  return (
    <div className="stack">
      {stats.length > 0 && (
        <div className="summary-grid">
          {stats.map(([v, k]) => <div key={k} className="stat"><div className="v">{v}</div><div className="k">{k}</div></div>)}
        </div>
      )}
      <DeltaLists s={s} />
      <dl className="kv">
        <dt>Mode</dt><dd>{IMPORT_MODE_LABEL[s.mode] || s.mode || "—"}</dd>
        {s.rows != null && (<><dt>Rows</dt><dd>{fmtInt(s.imported_rows)} imported of {fmtInt(s.rows)}</dd></>)}
        {s.printings != null && (<><dt>Printings</dt><dd>{fmtInt(s.printings)} owned</dd></>)}
        {s.decks_from_binders?.length > 0 && (<><dt>Decks</dt><dd>{s.decks_from_binders.join(", ")}</dd></>)}
        {s.skipped_wishlist_rows > 0 && (<><dt>Skipped</dt><dd>{plural(s.skipped_wishlist_rows, "wish-list row")}</dd></>)}
      </dl>
      {s.unresolved?.length > 0 && (
        <Collapsible label={`${plural(s.unresolved.length, "row")} could not be matched on Scryfall`}>
          <ul className="small" style={{ margin: 0, paddingLeft: 18 }}>
            {s.unresolved.map((u, i) => <li key={i}>{u}</li>)}
          </ul>
        </Collapsible>
      )}
    </div>
  );
}

/** Who owns the collection: ManaBox (imports replace) or mtg-planner (imports add). */
function MasterPanel({ master, busy, error, onSwitch }) {
  return (
    <section className="card stack" aria-labelledby="master-title">
      <div className="row between">
        <h2 id="master-title">Collection master</h2>
        {master && <span className={`badge ${master === "app" ? "accent" : "warn"}`}>{master === "app" ? "mtg-planner" : "ManaBox"}</span>}
      </div>
      {!master && !error && <Spinner />}
      {master === "manabox" && (
        <p className="small" style={{ margin: 0 }}>
          <b>ManaBox is the master.</b> A ManaBox import replaces every card that came from ManaBox (cards you scanned stay).
          The first time you move ManaBox cards into another binder here, mtg-planner takes over.
        </p>
      )}
      {master === "app" && (
        <p className="small" style={{ margin: 0 }}>
          <b>mtg-planner is the master.</b> Binders you organise here win: a ManaBox import only <b>adds the copies that are new</b> since
          the last export, nothing is deleted. Cards you moved, scanned or sorted here are never touched by an import.
        </p>
      )}
      {master && <span className="small">Default import mode: <b>{IMPORT_MODE_LABEL[master === "app" ? "delta" : "replace"]}</b></span>}
      <ErrorNotice error={error} />
      {master && (
        <div className="row">
          <button type="button" className="btn" style={{ whiteSpace: "normal", textAlign: "center" }} disabled={busy} onClick={() => onSwitch(master === "app" ? "manabox" : "app")}>
            {master === "app" ? "Switch back: ManaBox is the master" : "Make mtg-planner the master"}
          </button>
        </div>
      )}
      {master === "app" && (
        <span className="small muted">Switching back only changes the default import mode to Replace. Cards organised or edited here stay where they are and are not counted twice; copies you deleted here stay deleted.</span>
      )}
    </section>
  );
}

const fmtBytes = (n) => (n == null ? "—" : n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);
const backupCounts = (c) => (c ? `${plural(c.copies, "copy", "copies")} · ${plural(c.decks, "deck")} · ${plural(c.binders, "binder")} · ${plural(c.chats, "chat")}` : "contents unknown");

/** Asks before a restore and says exactly what gets replaced. `target` = {kind:'stored', backup} | {kind:'upload', file}. */
function RestoreConfirmSheet({ target, current, busy, onConfirm, onCancel }) {
  const b = target.kind === "stored" ? target.backup : null;
  return (
    <Sheet title="Restore this backup?" onClose={() => { if (!busy) onCancel(); }}>
      <div className="stack">
        <p style={{ margin: 0 }}>
          {b ? <>Backup from <b>{fmtDate(b.created_at)}</b>{b.app_version ? <> (app {b.app_version})</> : null}</> : <>File <b style={{ overflowWrap: "anywhere" }}>{target.file.name}</b> ({fmtBytes(target.file.size)})</>}
        </p>
        <div className="notice warn" role="alert">
          <span aria-hidden="true">⚠️</span>
          <div className="grow">
            <b>All app data is replaced</b> by the backup: your whole collection and binders, decks, the scan list (incl. calibration
            data), planner chats and settings (collection master). Changes made since the backup are lost.
          </div>
        </div>
        <ul className="small" style={{ margin: 0, paddingLeft: 20, display: "grid", gap: 4 }}>
          <li>Now: {current ? `${plural(current.total_cards, "copy", "copies")} · ${plural(current.decks, "deck")}` : "…"}</li>
          <li>Backup: {b ? backupCounts(b.counts) : "checked on upload"}</li>
          <li>A <b>safety backup</b> of the current data is taken first; you can restore it from the list if needed.</li>
          <li>Not affected: the scanner's card index, fingerprints and scan photos.</li>
        </ul>
        <div className="row">
          <button type="button" className="btn primary grow" disabled={busy} onClick={onConfirm}>
            {busy ? <><span className="spinner" aria-hidden="true" style={{ borderTopColor: "var(--accent-ink)" }} /> Restoring…</> : <><Icon.undo /> Replace everything</>}
          </button>
          <button type="button" className="btn ghost" disabled={busy} onClick={onCancel}>Cancel</button>
        </div>
      </div>
    </Sheet>
  );
}

/** Import tab: manual backups of the app data (create, download, delete) and restore from a stored or uploaded one. */
function BackupPanel({ dataVersion, onRestored, onBusy }) {
  const { data: list, error: listError, reload: load } = useApi("/api/backups", [dataVersion],
    { map: (d) => d.backups, error: (e) => `Could not load backups: ${e.message}` });
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState(null);
  const [fresh, setFresh] = useState(null); // name of the backup just made
  const [confirm, setConfirm] = useState(null); // RestoreConfirmSheet target
  // What the restore replaces: the current counts, fetched again each time the confirm opens.
  const stats = useApi(confirm ? "/api/stats" : null, [confirm]);
  const current = stats.loading || stats.error ? null : stats.data;
  const [restoring, setRestoring] = useState(false);
  const fileInput = useRef(null);

  const create = async () => {
    setCreating(true); setError(null);
    try {
      const b = await api("/api/backups", { method: "POST" });
      setFresh(b.name);
      load();
    } catch (e) { setError(e.message); } finally { setCreating(false); }
  };
  const remove = async (b) => {
    if (!window.confirm(`Delete the backup from ${fmtDate(b.created_at)}? This cannot be undone.`)) return;
    setError(null);
    try { await api(`/api/backups/${encodeURIComponent(b.name)}`, { method: "DELETE" }); load(); } catch (e) { setError(e.message); }
  };
  const askRestore = (t) => {
    setError(null);
    setConfirm(t);
  };
  const restore = async () => {
    setRestoring(true); setError(null);
    try {
      const r = confirm.kind === "stored"
        ? await api(`/api/backups/${encodeURIComponent(confirm.backup.name)}/restore`, { method: "POST", json: { confirm: true } })
        : await api("/api/backups/restore-upload?confirm=1", { method: "POST", body: confirm.file, headers: { "Content-Type": "application/gzip" } });
      setConfirm(null);
      onRestored(r);
    } catch (e) {
      setError(`Restore failed: ${e.message}`);
      setConfirm(null);
      load();
    } finally {
      setRestoring(false);
      if (fileInput.current) fileInput.current.value = "";
    }
  };
  const busy = creating || restoring;
  // The sheet holding this panel stays open while a request runs: closing it would drop the answer (and its error).
  useEffect(() => { onBusy?.(busy); }, [busy]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <section className="card stack" aria-labelledby="backup-title" aria-busy={busy}>
      <h2 id="backup-title">Backup &amp; restore</h2>
      <p className="small muted" style={{ margin: 0 }}>
        A backup holds all app data: collection, binders, decks, scan list, planner chats and settings. The scanner's card index and photos
        are not included (they are rebuilt). Download one to keep a copy off this server.
      </p>
      <div className="row">
        <button type="button" className="btn primary" onClick={create} disabled={busy}>
          {creating ? <><span className="spinner" aria-hidden="true" style={{ borderTopColor: "var(--accent-ink)" }} /> Creating…</> : <><Icon.box /> Create backup</>}
        </button>
        <label className={`btn${busy ? " disabled" : ""}`} aria-disabled={busy}>
          <Icon.file /> Restore from file
          <input ref={fileInput} type="file" accept=".gz,application/gzip" disabled={busy} className="sr-only"
            onChange={(e) => { const f = e.target.files?.[0]; if (f) askRestore({ kind: "upload", file: f }); }} />
        </label>
      </div>
      <ErrorNotice error={error} onDismiss={() => setError(null)} />
      <ErrorNotice error={listError} onRetry={load} />
      {!list && !listError && <Spinner />}
      {list && list.length === 0 && <p className="muted small" style={{ margin: 0 }}>No backups yet.</p>}
      {list && list.length > 0 && (
        <div>
          {list.map((b) => (
            <div key={b.name} className="history-item backup-item">
              <div className="row between">
                <b>{fmtDate(b.created_at)}</b>
                <span className="row small" style={{ gap: 6 }}>
                  {b.name === fresh && <span className="badge accent">new</span>}
                  {b.kind === "pre-restore" && <span className="badge warn" title="Taken automatically right before a restore">before restore</span>}
                  <span className="muted nowrap">{fmtBytes(b.size)}</span>
                </span>
              </div>
              <span className="small muted">{backupCounts(b.counts)}{b.app_version ? ` · app ${b.app_version}` : ""}</span>
              <div className="row" style={{ gap: 6 }}>
                <a className="btn sm" href={`/api/backups/${encodeURIComponent(b.name)}/download`} download={b.name}><Icon.download /> Download</a>
                <button type="button" className="btn sm" disabled={busy} onClick={() => askRestore({ kind: "stored", backup: b })}><Icon.undo /> Restore</button>
                <button type="button" className="btn sm ghost danger" style={{ marginLeft: "auto", paddingInline: 8 }} disabled={busy} onClick={() => remove(b)}
                  aria-label={`Delete backup from ${fmtDate(b.created_at)}`} title="Delete"><Icon.trash /></button>
              </div>
            </div>
          ))}
        </div>
      )}
      {confirm && <RestoreConfirmSheet target={confirm} current={current} busy={restoring} onConfirm={restore}
        onCancel={() => { setConfirm(null); if (fileInput.current) fileInput.current.value = ""; }} />}
    </section>
  );
}

/** The Settings tab's sections (each opens as a pop-up sheet). */
const SETTINGS_SECTIONS = [
  { id: "import", title: "Import", sub: "ManaBox collection CSV, decklists", icon: Icon.import },
  { id: "collection", title: "Collection", sub: "ManaBox or app in charge, export, recent changes", icon: Icon.collection },
  { id: "backups", title: "Backups", sub: "Create, download, restore", icon: Icon.box },
  { id: "online", title: "Online services", sub: "Combo check (Commander Spellbook)", icon: Icon.external },
  { id: "data", title: "Scanner & data", sub: "Card index, fingerprints, prices", icon: Icon.scan },
];

function PhoneAppPanel({ dataVersion }) {
  const { data: list } = useApi("/api/downloads", [dataVersion], { map: (d) => d.downloads });
  if (!list || list.length === 0) return null;
  return (
    <>
      <h2 className="settings-h" id="settings-phone">Phone app</h2>
      <section className="card stack" aria-labelledby="phone-app-title">
        <h2 id="phone-app-title">Android app</h2>
        <p className="small muted" style={{ margin: 0 }}>
          Open this page on the phone and tap Download. Then open the file and allow installing from this browser once.
          A newer version installs over the old one.
        </p>
        {list.map((f) => (
          <div key={f.name} className="history-item stack" style={{ gap: 4 }}>
            <div className="row between">
              <b>{f.title || f.name}{f.version ? ` ${f.version}` : ""}</b>
              <span className="muted small nowrap">{fmtBytes(f.size)}</span>
            </div>
            <span className="small muted">{fmtDate(f.modified_at)}{f.notes ? ` · ${f.notes}` : ""}</span>
            <div className="row">
              <a className="btn sm primary" href={`/api/downloads/${encodeURIComponent(f.name)}`} download={f.name}><Icon.download /> Download</a>
            </div>
            <span className="small muted" style={{ overflowWrap: "anywhere" }}>SHA-256 {f.sha256}</span>
          </div>
        ))}
      </section>
    </>
  );
}

const IMPORT_MODE_HELP = {
  delta: "Compares the file with your last ManaBox export and adds only the copies that are new (into their ManaBox binder). Fewer copies in ManaBox are listed, never deleted. Importing the same file twice changes nothing.",
  add: "Adds every copy in the file on top of what's already here.",
  replace: "Cards imported from ManaBox become exactly what's in the file. Scanned cards and cards organised here are kept.",
};

/** Settings → Import → Card list: a text list (e.g. a bought deck or booster pulls) into one binder of the collection. */
function CardListImport({ onDone }) {
  const [text, setText] = useState("");
  const [binder, setBinder] = useState("");
  const [language, setLanguage] = useState("en");
  const [condition, setCondition] = useState("near_mint");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [result, setResult] = useState(null);
  const pickFile = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try { setText(await file.text()); } catch (err) { setError(`Could not read the file: ${err.message}`); }
    e.target.value = "";
  };
  const submit = async (e) => {
    e.preventDefault();
    if (!text.trim() || busy) return;
    setBusy(true); setError(null); setResult(null);
    try {
      const res = await api("/api/collection/import-list", { method: "POST", json: { text, binder: binder.trim(), language, condition } });
      setResult(res);
      setText("");
      onDone?.();
    } catch (err) { setError(err.message); } finally { setBusy(false); }
  };
  return (
    <form className="card stack" onSubmit={submit} aria-labelledby="list-import-title">
      <div className="row between">
        <h2 id="list-import-title">Card list</h2>
        <label className="btn sm"><Icon.file /> Load .txt<input type="file" accept=".txt,.dec,.dek,text/plain" className="sr-only" onChange={pickFile} /></label>
      </div>
      <p className="small muted" style={{ margin: 0 }}>Adds a list of cards you got (a deck, booster pulls) to one binder. Same format as decklists:
        <code> 1 Sol Ring</code>, <code>1 Name (SET) 123</code>, <code>*F*</code> for foil. A deck you bought? Use <b>Decks → Import decklist → I own these cards</b>: it also creates the deck.</p>
      <textarea className="textarea" aria-label="Card list" value={text} onChange={(e) => setText(e.target.value)} placeholder={"4 Lightning Bolt\n1 Sol Ring (CMM) 1015 *F*"} />
      <div className="settings-grid">
        <div className="field" style={{ gridColumn: "1 / -1" }}>
          <label htmlFor="list-binder">Binder</label>
          <input id="list-binder" className="input" maxLength={100} value={binder} onChange={(e) => setBinder(e.target.value)} placeholder={`${UNSORTED} (leave empty) or a binder name`} />
        </div>
        <div className="field">
          <label htmlFor="list-lang">Language</label>
          <select id="list-lang" className="select" value={language} onChange={(e) => setLanguage(e.target.value)}>
            {SCAN_LANGS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
          </select>
        </div>
        <div className="field">
          <label htmlFor="list-cond">Condition</label>
          <select id="list-cond" className="select" value={condition} onChange={(e) => setCondition(e.target.value)}>
            {CONDITIONS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
          </select>
        </div>
      </div>
      <ErrorNotice error={error} onDismiss={() => setError(null)} />
      {result && (
        <div className="notice ok" role="status"><span aria-hidden="true">✓</span><div className="grow">
          <b>Added {plural(result.added_copies, "copy", "copies")}</b> ({plural(result.cards, "card")}) to {result.binder || UNSORTED}. Undo in Collection → Recent changes.
          {result.unresolved?.length > 0 && <div className="small">Not found: {result.unresolved.join(", ")}</div>}
          {result.parse_errors?.length > 0 && <div className="small">Skipped lines: {result.parse_errors.join(" | ")}</div>}
        </div></div>
      )}
      <div className="row">
        <button type="submit" className="btn primary" disabled={busy || !text.trim()}>{busy ? <><span className="spinner" aria-hidden="true" /> Adding…</> : <><Icon.plus /> Add to collection</>}</button>
      </div>
    </form>
  );
}

function ImportTab({ dataVersion, health, onImported, onRestored, restored, onDismissRestored }) {
  const [file, setFile] = useState(null);
  const [mode, setMode] = useState("replace");
  const modeTouched = useRef(false);
  const settings = useApi("/api/settings", [dataVersion], { error: (e) => `Could not load settings: ${e.message}` });
  const [master, setMaster] = useState(null);
  const [masterState, setMasterState] = useState({ busy: false, error: null });
  useEffect(() => {
    if (!settings.data) return;
    const m = settings.data.collection_master === "app" ? "app" : "manabox";
    setMaster(m);
    // The default import mode follows the master until the user picks one.
    if (!modeTouched.current) setMode(m === "app" ? "delta" : "replace");
  }, [settings.data]);
  const switchMaster = async (to) => {
    if (to === "manabox" && !window.confirm("Make ManaBox the master again? The import mode defaults to Replace again, which replaces every card that came from ManaBox. Cards you organised or edited here stay where they are; a replace counts them against the file instead of adding them again. Copies you deleted here stay deleted.")) return;
    setMasterState({ busy: true, error: null });
    try {
      const d = await api("/api/settings", { method: "PATCH", json: { collection_master: to } });
      setMaster(d.collection_master);
      modeTouched.current = false;
      setMode(d.collection_master === "app" ? "delta" : "replace");
      setMasterState({ busy: false, error: null });
    } catch (e) { setMasterState({ busy: false, error: e.message }); }
  };
  const pickMode = (m) => { modeTouched.current = true; setMode(m); };
  // Where the cards go: as in the file (default), Unsorted, one binder or a new one. Picked per import.
  const [target, setTarget] = useState(IMPORT_AS_FILE);
  const [newBinder, setNewBinder] = useState("");
  const binderList = useBinderList(dataVersion);
  const binderNames = (binderList.data?.binders ?? []).map((b) => b.name);
  const [busy, setBusy] = useState(false);
  const [started, setStarted] = useState(null);
  const [elapsed, setElapsed] = useState(0);
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);
  const [refresh, setRefresh] = useState({ busy: false, result: null, error: null });
  const { data: history, error: historyError, reload: loadHistory } = useApi("/api/imports", [dataVersion],
    { error: (e) => `Could not load import history: ${e.message}` });
  const fileInput = useRef(null);

  // Elapsed-time counter while a request runs.
  useEffect(() => {
    if (!started) return;
    const t = setInterval(() => setElapsed(Math.round((Date.now() - started) / 1000)), 1000);
    return () => clearInterval(t);
  }, [started]);
  // Warn before closing the page mid-import.
  useEffect(() => {
    if (!busy) return;
    const h = (e) => { e.preventDefault(); e.returnValue = ""; };
    window.addEventListener("beforeunload", h);
    return () => window.removeEventListener("beforeunload", h);
  }, [busy]);

  const submit = async (e) => {
    e.preventDefault();
    if (!file || busy) return;
    if (target === IMPORT_NEW_BINDER && !newBinder.trim()) { setError("Enter a name for the new binder."); return; }
    const confirmReplace = mode === "replace" && master === "app";
    if (confirmReplace && !window.confirm(
      "Replace your ManaBox cards?\n\nmtg-planner is the master of your collection. A replace import DELETES every card that came from ManaBox " +
      "and loads this file instead. Cards you scanned or moved into binders here stay.\n\nUse Add to keep everything.")) return;
    setBusy(true);
    setError(null);
    setResult(null);
    setElapsed(0);
    setStarted(Date.now());
    try {
      const text = await file.text();
      const params = new URLSearchParams({ mode, filename: file.name });
      if (confirmReplace) params.set("confirm_replace", "1");
      if (target === IMPORT_NEW_BINDER) { params.set("binder", newBinder.trim()); params.set("create_binder", "1"); }
      else if (target !== IMPORT_AS_FILE) params.set("binder", target);
      const summary = await api(`/api/import/manabox?${params}`, { method: "POST", body: text, headers: { "Content-Type": "text/csv" } });
      setResult(summary);
      setFile(null);
      setTarget(IMPORT_AS_FILE);
      setNewBinder("");
      if (fileInput.current) fileInput.current.value = "";
      onImported();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
      setStarted(null);
    }
  };

  const refreshPrices = async () => {
    setRefresh({ busy: true, result: null, error: null });
    try {
      const r = await api("/api/refresh-prices", { method: "POST" });
      setRefresh({ busy: false, result: r, error: null });
      onImported();
    } catch (err) {
      setRefresh({ busy: false, result: null, error: err.message });
    }
  };

  const [section, setSection] = useState(null);
  const openSection = (id) => setSection(id);
  const closeSection = useCallback(() => setSection(null), []);
  const [backupBusy, setBackupBusy] = useState(false); // a backup/restore request runs: the Backups sheet stays open
  return (
    <div className="stack-lg" style={{ maxWidth: 760 }}>
      <div className="page-title"><h1>Settings</h1></div>
      {restored && (
        <div className="notice ok" role="status">
          <span aria-hidden="true">✓</span>
          <div className="grow">
            <b>Backup restored.</b> {backupCounts(restored.restored?.counts)}. Your previous data is kept as the safety backup
            {restored.safety_backup ? ` from ${fmtDate(restored.safety_backup.created_at)}` : ""}.
          </div>
          <button type="button" className="btn ghost sm" onClick={onDismissRestored} aria-label="Dismiss"><Icon.close /></button>
        </div>
      )}

      <nav className="settings-list" aria-label="Settings">
        {SETTINGS_SECTIONS.map((x) => (
          <button key={x.id} type="button" className="settings-row" onClick={() => openSection(x.id)}>
            <span className="settings-row-icon" aria-hidden="true"><x.icon /></span>
            <span className="stack" style={{ gap: 2, minWidth: 0 }}><b>{x.title}</b><span className="small muted">{x.sub}</span></span>
            <span className="settings-row-go" aria-hidden="true">›</span>
          </button>
        ))}
      </nav>
      <PhoneAppPanel dataVersion={dataVersion} />
      {section === "import" && (
        <Sheet title="Import" onClose={closeSection}>
          <div className="stack settings-sheet">
      <form className="card stack" onSubmit={submit} aria-labelledby="import-title" aria-busy={busy}>
        <h2 id="import-title">ManaBox collection CSV</h2>
        <Collapsible label="How to export from ManaBox">
          <ol className="steps small">
            <li>In ManaBox open <b>Collection</b>, tap <b>⋯</b> → <b>Export</b> → <b>CSV</b>.</li>
            <li>Share or save the file (e.g. to Files / Downloads).</li>
            <li>Pick it below and tap <b>Import</b>.</li>
          </ol>
          <p className="small muted" style={{ marginBottom: 0 }}>Deck binders become decks; wish-list binders are skipped.</p>
        </Collapsible>

        <label className={`file-drop${file ? " has-file" : ""}`}>
          <Icon.file />
          <b>{file ? file.name : "Choose CSV file"}</b>
          <span className="muted small">{file ? `${(file.size / 1024).toFixed(0)} KB · tap to change` : "ManaBox export (.csv)"}</span>
          <input ref={fileInput} type="file" accept=".csv,text/csv" disabled={busy}
            onChange={(e) => { setFile(e.target.files?.[0] || null); setError(null); }} />
        </label>

        <fieldset style={{ border: 0, padding: 0, margin: 0 }} className="stack" disabled={busy}>
          <legend className="label" style={{ marginBottom: 8 }}>Mode</legend>
          {(master === "app" ? ["delta", "add", "replace"] : ["replace", "delta", "add"]).map((m) => (
            <label key={m} className="radio-card">
              <input type="radio" name="mode" value={m} checked={mode === m} onChange={() => pickMode(m)} />
              <span>
                <b>{IMPORT_MODE_LABEL[m]}</b>{(master === "app" ? m === "delta" : m === "replace") && <> <span className={`badge${master === "app" ? " accent" : ""}`}>default</span></>}<br />
                <span className="small muted">{IMPORT_MODE_HELP[m]}</span>
              </span>
            </label>
          ))}
          {mode === "add" && (
            <div className="notice warn" role="alert">
              <span aria-hidden="true">⚠️</span>
              <div className="grow"><b>Add duplicates cards you already imported.</b> Every copy in the file is added again, even if it came in with an earlier import. Use <b>Only new copies</b> to add just what changed.</div>
            </div>
          )}
          {master === "app" && mode === "replace" && (
            <div className="notice warn" role="alert">
              <span aria-hidden="true">⚠️</span>
              <div className="grow"><b>This deletes every card that came from ManaBox</b> and loads the file instead. mtg-planner is the master of your collection, so this is rarely what you want: cards you moved or scanned here stay, but ManaBox cards you haven't organised yet are replaced by the file. You'll be asked to confirm.</div>
            </div>
          )}
        </fieldset>

        <div className="stack" style={{ gap: 6 }}>
          <label className="label" htmlFor="import-target">Put the cards into</label>
          <select id="import-target" className="select" value={target} disabled={busy}
            onChange={(e) => { setTarget(e.target.value); setError(null); }}>
            <option value={IMPORT_AS_FILE}>Binders as in ManaBox</option>
            <option value="">Unsorted</option>
            {binderNames.map((n) => <option key={n} value={n}>{n}</option>)}
            <option value={IMPORT_NEW_BINDER}>+ New binder…</option>
          </select>
          {target === IMPORT_NEW_BINDER && (
            <input className="input" type="text" maxLength={100} placeholder="Name of the new binder" value={newBinder}
              disabled={busy} onChange={(e) => setNewBinder(e.target.value)} aria-label="Name of the new binder" />
          )}
          {target !== IMPORT_AS_FILE && (
            <span className="small muted">All cards of this file go there. Deck binders still become decks.</span>
          )}
        </div>

        <button type="submit" className="btn primary" disabled={!file || busy}>
          {busy ? <><span className="spinner" aria-hidden="true" style={{ borderTopColor: "var(--accent-ink)" }} /> Importing…</> : <><Icon.import /> Import</>}
        </button>

        {busy && (
          <div className="stack" role="status" aria-live="polite">
            <div className="progress" aria-hidden="true" />
            <span className="small muted">Matching cards on Scryfall and fetching prices… {elapsed}s. Large collections can take a minute — keep this page open.</span>
          </div>
        )}
        <ErrorNotice error={error} />
        {result && (
          <div className="stack" role="status">
            <div className="notice ok"><span aria-hidden="true">✓</span><div className="grow"><b>Import complete.</b></div></div>
            <ImportSummary s={result} />
          </div>
        )}
      </form>

      <CardListImport onDone={onImported} />

      <section className="card stack" aria-labelledby="history-title">
        <h2 id="history-title">Import history</h2>
        <ErrorNotice error={historyError} onRetry={loadHistory} />
        {!history && !historyError && <Spinner />}
        {history && history.length === 0 && <p className="muted" style={{ margin: 0 }}>No imports yet.</p>}
        {history && history.length > 0 && (
          <div>
            {history.map((h) => {
              const s = h.summary || {};
              return (
                <div key={h.id} className="history-item">
                  <div className="row between">
                    <b style={{ overflowWrap: "anywhere" }}>{h.filename || "ManaBox CSV"}</b>
                    <span className="muted small nowrap">{fmtDate(h.created_at)}</span>
                  </div>
                  <div className="row small">
                    <span className={`badge ${h.mode === "add" ? "warn" : h.mode === "delta" ? "accent" : ""}`}>{h.mode === "delta" ? "new copies" : h.mode || h.kind}</span>
                    <span className="muted">{fmtInt(s.total_cards_before)} → {fmtInt(s.total_cards_after)} copies{h.mode === "delta" || s.mode === "delta"
                      ? `${s.added_copies != null ? ` · +${fmtInt(s.added_copies)} new` : ""}`
                      : ` · +${fmtInt(s.printings_added)} / −${fmtInt(s.printings_removed)} / ~${fmtInt(s.printings_changed)} printings`}</span>
                    {s.unresolved?.length > 0 && <span className="badge warn">{s.unresolved.length} unresolved</span>}
                  </div>
                  <Collapsible label="Details"><ImportSummary s={s} /></Collapsible>
                </div>
              );
            })}
          </div>
        )}
      </section>
          </div>
        </Sheet>
      )}
      {section === "collection" && (
        <Sheet title="Collection" onClose={closeSection}>
          <div className="stack settings-sheet">
      <MasterPanel master={master} busy={masterState.busy} error={masterState.error ?? settings.error} onSwitch={switchMaster} />
      <ExportPanel />
      <RecentChanges dataVersion={dataVersion} onChanged={onImported} />
          </div>
        </Sheet>
      )}
      {section === "backups" && (
        <Sheet title="Backups" onClose={() => { if (!backupBusy) closeSection(); }}>
          <div className="stack settings-sheet">
      <BackupPanel dataVersion={dataVersion} onRestored={onRestored} onBusy={setBackupBusy} />
          </div>
        </Sheet>
      )}
      {section === "online" && (
        <Sheet title="Online services" onClose={closeSection}>
          <div className="stack settings-sheet">
      <SpellbookPanel health={health} dataVersion={dataVersion} />
          </div>
        </Sheet>
      )}
      {section === "data" && (
        <Sheet title="Scanner & data" onClose={closeSection}>
          <div className="stack settings-sheet">
      <ScannerIndexPanel health={health} />
      <section className="card stack" aria-labelledby="prices-title">
        <h2 id="prices-title">Prices</h2>
        <p className="small muted" style={{ margin: 0 }}>Imports already fetch current prices. Refresh in between to update prices and card data for everything you own and every deck card.</p>
        <div className="row">
          <button type="button" className="btn" onClick={refreshPrices} disabled={refresh.busy || busy}>
            {refresh.busy ? <><span className="spinner" aria-hidden="true" /> Refreshing…</> : <><Icon.refresh /> Refresh prices</>}
          </button>
          {refresh.result && <span className="small" role="status">Refreshed {fmtInt(refresh.result.refreshed)} cards{refresh.result.not_found ? `, ${fmtInt(refresh.result.not_found)} not found` : ""}.</span>}
        </div>
        <ErrorNotice error={refresh.error} />
      </section>
          </div>
        </Sheet>
      )}

      <p className="footer-note">mtg-planner {health ? health.version : ""} · card data and images © Scryfall / Wizards of the Coast · unofficial fan tool</p>
    </div>
  );
}
