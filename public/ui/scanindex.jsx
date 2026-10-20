"use strict";

// ===========================================================================
// Scanner index (Settings tab)
// ===========================================================================

function JobLine({ label, job }) {
  if (!job || typeof job !== "object") return null;
  const state = job.state || job.status || (job.running ? "running" : job.error ? "error" : job.finished_at || job.done_at ? "done" : "idle");
  const done = job.done ?? job.processed ?? job.progress ?? null, total = job.total ?? null;
  const pct = total ? Math.min(100, Math.round((Number(done) || 0) * 100 / total)) : null;
  return (
    <div className="stack" style={{ gap: 4 }}>
      <div className="row between small">
        <span><b>{label}</b> <span className={`badge ${state === "running" || state === "queued" ? "accent" : state === "error" || state === "failed" ? "bad" : state === "done" ? "ok" : ""}`}>{state}</span></span>
        {total ? <span className="muted">{fmtInt(done)} / {fmtInt(total)}{job.phase ? ` · ${job.phase}` : ""}</span> : job.phase ? <span className="muted">{job.phase}</span> : null}
      </div>
      {pct != null && <div className="meter" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct} aria-label={`${label} progress`}><span style={{ width: `${pct}%` }} /></div>}
      {job.error && <span className="small" style={{ color: "var(--bad)" }}>{String(job.error)}</span>}
    </div>
  );
}

/** Short text for a scheduler step result ({ran}, {skipped}, {error}, ...). */
function schedResult(x) {
  if (x == null) return null;
  if (typeof x !== "object") return String(x);
  if (x.error) return `error: ${x.error}`;
  if (x.skipped) return `skipped (${x.skipped})`;
  if (x.ran || x.started) return "ran";
  if (x.status) return String(x.status);
  return null;
}

/**
 * Scheduler block of /api/index/status: {enabled, hour, next_run,
 * last_index_refresh, last_index_check, last_index_result, last_price_refresh,
 * last_run: {at, index, prices}, running}. Read defensively: missing fields hide.
 */
function readScheduler(st) {
  const sch = st?.scheduler;
  if (!sch || typeof sch !== "object") return null;
  const lasts = [];
  const add = (label, at, note = null) => { if (at != null && at !== "") lasts.push({ label, at, note }); };
  add("Card data refreshed", sch.last_index_refresh);
  add("Scryfall bulk data checked", sch.last_index_check, schedResult(sch.last_index_result));
  add("Prices refreshed", sch.last_price_refresh);
  const lr = sch.last_run && typeof sch.last_run === "object" ? sch.last_run : null;
  if (lr) {
    const parts = [["card data", lr.index], ["prices", lr.prices]].map(([k, v]) => (schedResult(v) ? `${k}: ${schedResult(v)}` : null)).filter(Boolean);
    add("Last nightly run", lr.at, parts.join(" · ") || null);
  }
  return {
    enabled: sch.enabled !== false, hour: sch.hour ?? null, next: sch.next_run ?? null,
    running: typeof sch.running === "string" ? sch.running : sch.running ? "running" : null, lasts,
  };
}

function SchedulerInfo({ st }) {
  const sc = readScheduler(st);
  if (!sc) return null;
  return (
    <div className="sched" aria-label="Automatic refresh">
      <div className="row">
        <b>Automatic refresh</b>
        <span className={`badge ${sc.enabled ? "ok" : ""}`}>{sc.enabled ? "on" : "off"}</span>
        {sc.running && <span className="badge accent">running: {sc.running}</span>}
        {sc.enabled && sc.hour != null && <span className="muted small">nightly at {String(sc.hour).padStart(2, "0")}:00 server time</span>}
      </div>
      {sc.enabled && sc.next && (
        <div className="row"><span className="muted">Next scheduled check</span> <b title={fmtDate(sc.next)}>{fmtAgo(sc.next)}</b></div>
      )}
      {sc.lasts.map((l) => (
        <div key={l.label} className="row">
          <span className="muted">{l.label}</span>
          <b title={fmtDate(l.at)}>{fmtAgo(l.at)}</b>
          {l.note && <span className={`small ${/^error|error:/.test(l.note) ? "" : "muted"}`} style={{ overflowWrap: "anywhere", color: /error/.test(l.note) ? "var(--bad)" : undefined }}>{l.note}</span>}
        </div>
      ))}
      {!sc.enabled && <span className="small muted">The nightly index and price refresh is turned off on the server (SCHEDULER_ENABLED=false).</span>}
    </div>
  );
}

// GET /api/scans/learning (lib/learning.js): plain words for what kept a confirmed card below "sure".
const LEARN_REASON = {
  titleAuto: "the title read was not clear enough", collectorConf: "the collector line was hard to read",
  fpVerify: "the art match was not close enough", fpAuto: "the art fingerprint was not sure", fpGap: "the art looked like another card too",
  "no title read": "no title could be read", "no collector line": "no collector line was found", "no fingerprint": "the art was not compared",
  "competing card": "another card scored almost as high", "printings share this art": "several printings share this art",
  "collector read uncertain": "the collector line was uncertain", "same number in another set": "the number exists in another set too",
};

/** Compact learning summary (Settings → Scanner & data). */
function ScannerLearning() {
  const { data: rep, error } = useApi("/api/scans/learning");
  if (error) return <p className="small muted" style={{ margin: 0 }}>{error}</p>;
  if (!rep) return <Spinner />;
  const o = rep.outcomes || {};
  const corrected = (o.auto_corrected || 0) + (o.suggest_corrected || 0) + (o.review_corrected || 0);
  const prec = rep.rates?.auto_precision;
  const top = rep.top_reason;
  return (
    <div className="stack">
      <div className="summary-grid">
        <div className="stat"><div className="v">{fmtInt(rep.labelled)}</div><div className="k">Examples</div></div>
        <div className="stat"><div className="v">{fmtInt(o.suggest_confirmed)}</div><div className="k">Unsure, then right</div></div>
        <div className="stat"><div className="v">{fmtInt(corrected)}</div><div className="k">Fixed by you</div></div>
        <div className="stat"><div className="v">{prec == null ? "–" : `${Math.round(prec * 100)}%`}</div><div className="k">Sure &amp; right</div></div>
      </div>
      <p className="small muted" style={{ margin: 0 }}>
        {top ? `Most common reason a card stayed unsure: ${LEARN_REASON[top.key] || top.key} (${fmtInt(top.count)}×).` : "No unsure card confirmed yet."}
        {rep.enough_data ? "" : ` Tuning needs about ${rep.min_examples} confirmed unsure cards.`}
      </p>
    </div>
  );
}

function ScannerIndexPanel({ health }) {
  const [st, setSt] = useState(null);
  const [error, setError] = useState(null);
  const [missing, setMissing] = useState(false);
  const [busy, setBusy] = useState(null);
  const [learnOpen, setLearnOpen] = useState(false);
  const load = useCallback(async () => {
    try { setSt(await api("/api/index/status")); setError(null); }
    catch (e) { if (e.status === 404) setMissing(true); else setError(e.message); }
  }, []);
  useEffect(() => { load(); }, [load]);
  const jobs = st ? [["Card index", st.refresh_job || st.index_job || st.metadata_job || st.job], ["Fingerprints", st.fingerprint_job]] : [];
  const running = jobs.some(([, j]) => j && (j.running || ["running", "queued"].includes(j.state || j.status)));
  useEffect(() => {
    if (!running) return;
    const t = setInterval(load, 3000);
    return () => clearInterval(t);
  }, [running, load]);
  const start = async (path, label) => {
    setBusy(label); setError(null);
    try { await api(path, { method: "POST", json: {} }); await load(); }
    catch (e) { setError(e.message); } finally { setBusy(null); }
  };
  if (missing) return null;
  const sc = health?.scanner;
  return (
    <section className="card stack" aria-labelledby="index-title">
      <h2 id="index-title">Scanner index</h2>
      <p className="small muted" style={{ margin: 0 }}>The scanner identifies cards against a local copy of Scryfall's card data and art fingerprints. It refreshes on its own at night; use the buttons after a new set comes out.</p>
      <ErrorNotice error={error} onRetry={load} />
      {!st && !error && <Spinner />}
      {st && (
        <>
          <div className="summary-grid">
            <div className="stat"><div className="v">{fmtInt(st.printings)}</div><div className="k">Printings</div></div>
            <div className="stat"><div className="v">{fmtInt(st.sets)}</div><div className="k">Sets</div></div>
            <div className="stat"><div className="v">{fmtInt(typeof st.fingerprints === "object" ? st.fingerprints?.count : st.fingerprints)}</div><div className="k">Fingerprints</div></div>
            <div className="stat"><div className="v" style={{ fontSize: "1rem" }} title={st.last_refresh ? fmtDate(st.last_refresh) : undefined}>{st.last_refresh ? fmtAgo(st.last_refresh) : "never"}</div><div className="k">Last refresh</div></div>
          </div>
          {jobs.map(([label, job]) => <JobLine key={label} label={label} job={job} />)}
          <SchedulerInfo st={st} />
        </>
      )}
      {sc && (
        <div className="kv-inline">
          <span>OCR <span className={`badge ${sc.tesseract ? "ok" : "bad"}`}>{sc.tesseract ? "✓ tesseract" : "✗ tesseract"}</span></span>
          <span>JPEG <span className={`badge ${sc.djpeg ? "ok" : "bad"}`}>{sc.djpeg ? "✓ djpeg" : "✗ djpeg"}</span></span>
        </div>
      )}
      <div className="row">
        <button type="button" className="btn" disabled={Boolean(busy) || running} onClick={() => start("/api/index/refresh", "refresh")}>
          {busy === "refresh" ? <><span className="spinner" aria-hidden="true" /> Starting…</> : <><Icon.refresh /> Refresh index</>}
        </button>
        <button type="button" className="btn" disabled={Boolean(busy) || running} onClick={() => start("/api/index/fingerprints", "fp")}>
          {busy === "fp" ? <><span className="spinner" aria-hidden="true" /> Starting…</> : <><Icon.sparkle /> Build fingerprints</>}
        </button>
      </div>
      <details className="disclosure" onToggle={(e) => setLearnOpen(e.currentTarget.open)}>
        <summary>Scanner learning</summary>
        <div className="stack" style={{ marginTop: 6 }}>
          <p className="small muted" style={{ margin: 0 }}>Every card you confirm, fix or add keeps its scores and OCR output with the right printing. Scanning on past a "? confirm" card confirms it. Export the examples to tune the scanner thresholds.</p>
          {learnOpen && <ScannerLearning />}
          <a className="btn" href="/api/calibration/export" download="mtg-scan-calibration.json" style={{ justifySelf: "start" }}><Icon.download /> Export examples (JSON)</a>
        </div>
      </details>
    </section>
  );
}
