"use strict";

// ---------------------------------------------------------------------------
// Staged scan row

function ScanRow({ s, status, selected, onSelect, onPatch, onDelete, onIncrement, onPick, onConfirm }) {
  const p = normPrinting({ ...s, id: s.store_printing_id || s.printing_id });
  const fins = scanFinishes(s);
  const finish = normFinish(s.finish);
  const nextFinish = fins[(fins.indexOf(finish) + 1) % fins.length];
  const variants = jsonArr(s.variants);
  const qty = s.quantity ?? 1;
  const thumb = scanThumb(s);
  const ld = (s.lang_detected || "").toUpperCase(), ls = (s.store_lang || "").toUpperCase();
  return (
    <div className={`scan-row st-${status}`} aria-selected={selected}>
      <label className="sel"><input type="checkbox" checked={selected} onChange={(e) => onSelect(e.target.checked)} aria-label={`Select ${s.name || "scan"}`} /></label>
      <button type="button" className="thb" onClick={onPick} aria-label={`Change printing of ${s.name || "scan"}`}>
        {thumb ? <img className="th" src={thumb} alt="" loading="lazy" decoding="async" /> : <span className="th" />}
      </button>
      <div className="info">
        <div className="top">
          <span className="nm" title={s.name}>{s.name || "Unidentified card"}</span>
          <span className={`badge st-chip ${status}`}>{status === "auto" && s.match_status === "confirmed" ? "✓ confirmed" : STATUS_LABEL[status] || status}</span>
        </div>
        <div className="sub">
          {s.set_code && <span>{String(s.set_code).toUpperCase()} #{s.collector_number}</span>}
          {ld && ls && ld !== ls
            ? <span className="badge" title="Detected language → stored language">{`${ld}→${ls}`}</span>
            : <LangTag lang={ls || ld} />}
          {s.method && <span className="muted">{s.method}{typeof s.confidence === "number" ? ` ${Math.round(s.confidence * 100)}%` : ""}</span>}
          {"price_eur" in s && <span className="scan-price" title="EUR price of the stored printing and finish (each copy)">{s.price_eur == null ? "no price" : fmtEur(s.price_eur)}</span>}
        </div>
      </div>
      <div className="ctrls">
        <Stepper label="Quantity" value={qty} onChange={(n) => (n > qty ? onIncrement() : onPatch({ quantity: n }))} />
        <button type="button" className={`btn sm finish-btn ${finish}${finishGuessed(s) ? " finish-q" : ""}`} disabled={fins.length < 2}
          title={fins.length < 2 ? `Only printed ${FINISH_LABEL[finish] || finish}` : `${finishGuessed(s) ? "Not read from the card (session setting). " : ""}Switch to ${FINISH_LABEL[nextFinish]}`}
          onClick={() => onPatch({ finish: nextFinish })}>{finish !== "nonfoil" && "✦ "}{FINISH_LABEL[finish] || finish}{finishGuessed(s) ? "?" : ""}</button>
        <select className="select" aria-label="Condition" value={s.condition || "near_mint"} onChange={(e) => onPatch({ condition: e.target.value })}>
          {CONDITIONS.map(([k, , short]) => <option key={k} value={k}>{short}</option>)}
        </select>
        <select className="select" aria-label="Store as language" value={s.store_lang || "en"} onChange={(e) => onPatch({ store_lang: e.target.value })}>
          {SCAN_LANGS.map(([k]) => <option key={k} value={k}>{k.toUpperCase()}</option>)}
        </select>
        {status === "suggest" && <button type="button" className="btn sm" onClick={onConfirm}><Icon.check /> Confirm</button>}
        {(status === "review" || status === "failed") && <button type="button" className="btn sm danger" onClick={onPick}>Pick printing</button>}
        {variants.length > 0 && <button type="button" className="chip" onClick={onPick} title="Promo / List / other printings share this collector number">variant?</button>}
        <button type="button" className="btn ghost icon sm" aria-label={`Delete ${s.name || "scan"}`} onClick={onDelete} style={{ marginLeft: "auto" }}><Icon.trash /></button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Scan tab

// A discarded scan stays restorable this long ("Undo" in the toast); then it is deleted.
const DISCARD_UNDO_MS = 6000;
// A probe answer that takes longer is given up (the next still frame probes again).
const PROBE_TIMEOUT_MS = 30000;
const newProbeSession = () => `p-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

function ScanTab({ active, health, onCommitted }) {
  const [lib, setLib] = useState(null);
  const [libError, setLibError] = useState(null);
  const [settings, setSettings] = useState(() => ({ ...SCAN_DEFAULTS, ...(store.get("mtg.scan.settings", {}) || {}) }));
  // One-time notice for users whose saved setting is the old default "Store as English".
  const [langNotice, setLangNotice] = useState(() => (store.get("mtg.scan.settings", {}) || {}).storageLang === "en" && !store.get("mtg.scan.langNoticeSeen", false));
  const closeLangNotice = () => { store.set("mtg.scan.langNoticeSeen", true); setLangNotice(false); };
  const [scans, setScans] = useState(null);
  const [scanTotals, setScanTotals] = useState(null); // GET /api/scans totals.staged (fallback for rows without price_eur)
  const [listError, setListError] = useState(null);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const cancelRef = useRef(null); // aborts the scan request in flight
  // A scan that takes long: {since, warming} (warming = the server's fingerprint matcher is still loading).
  const [slow, setSlow] = useState(null);
  const [last, setLast] = useState(null); // {kind, scan, result, payload, preview, error, timeout, probe}
  const [sheet, setSheet] = useState(null);
  const [selected, setSelected] = useState(() => new Set());
  const [toast, setToast] = useState(null);
  const [flash, setFlash] = useState(null);
  const [statusById, setStatusById] = useState({});
  const settingsRef = useRef(settings);
  settingsRef.current = settings;
  const replaceRef = useRef(null);
  // Scanner: capture.js module, the ProbeController (shared with CameraView), the detector
  // analyzer, the upload queue (shutter scans and resends), the probe session id.
  const [capMod, setCapMod] = useState(null);
  const probeRef = useRef(null);
  const detRef = useRef(null);
  const queueRef = useRef(null);
  const probeSessionRef = useRef(newProbeSession());
  const handlers = useRef({}); // the queue's callbacks, refreshed every render
  const [queued, setQueued] = useState(0);
  const [busyPreview, setBusyPreview] = useState(null);
  const [sound, setSoundState] = useState(loadSoundSettings);
  const soundRef = useRef(sound);
  soundRef.current = sound;
  const soundsRef = useRef(null); // scanlib createScanSounds()
  const priceRef = useRef(new Map()); // scan id → price_eur (sound for +1)
  const [rec, setRec] = useState(null); // record session {session, startedAt}
  const recStatsRef = useRef(null); // {session, frames, bytes, errors, full}: RecordStatus polls it (no tab re-render per frame)
  // Discarded rows waiting for their delete: id → timer (hidden from the list until then).
  const discardsRef = useRef(new Map());
  const [discarding, setDiscarding] = useState(() => new Set());
  // Auto-ask Claude for hard cards (public/autoask.js): per-device setting autoClaude; off when the
  // server has no Claude or SCAN_CLAUDE_PER_HOUR is 0 (/healthz scanner.vision).
  const autoAskRef = useRef(null);
  const visionOkRef = useRef(true);
  visionOkRef.current = health?.claude_configured !== false && health?.scanner?.vision?.configured !== false && health?.scanner?.vision?.per_hour !== 0;

  useEffect(() => {
    if (!active || lib) return;
    let alive = true;
    Promise.all([import("./scanlib.js"), import("./capture.js")])
      .then(([m, c]) => {
        if (!alive) return;
        try { soundsRef.current = m.createScanSounds ? m.createScanSounds() : null; } catch { soundsRef.current = null; }
        setCapMod(c);
        setLib(m);
      })
      .catch((e) => { if (alive) setLibError(`Could not load the scanner: ${e.message}`); });
    // The auto-ask module is optional: without it the scanner works as before (shutter only).
    import("./autoask.js")
      .then((a) => {
        if (autoAskRef.current) return;
        autoAskRef.current = new a.AutoAsk({ enabled: () => settingsRef.current.autoClaude !== false && visionOkRef.current });
      })
      .catch(() => {});
    return () => { alive = false; };
  }, [active, lib]);

  const pushItem = useCallback((item) => {
    const q = queueRef.current;
    if (!item || !q) return;
    q.push(item);
    setQueued(q.length);
  }, []);

  useEffect(() => {
    if (!capMod) return;
    const q = new capMod.UploadQueue({
      send: (item) => handlers.current.send(item),
      onResult: (item, res) => handlers.current.onResult(item, res),
      onError: (item, err) => handlers.current.onError(item, err),
      onGiveUp: (item, err) => handlers.current.onGiveUp(item, err),
    });
    queueRef.current = q;
    return () => { if (queueRef.current === q) queueRef.current = null; };
  }, [capMod]);

  // One probe controller; field-test overrides from mtg.scan.capture / ?scancfg= (validated by probeConfig).
  useEffect(() => {
    if (!capMod?.ProbeController) return;
    const pc = new capMod.ProbeController({ cfg: readCaptureOverrides() });
    if (pc.ignored?.length) console.warn(`Scanner: ignored probe overrides ${pc.ignored.join(", ")}`);
    probeRef.current = pc;
  }, [capMod]);

  // Record session: auto-off after RECORD_MAX_MS (the elapsed time ticks inside RecordStatus).
  useEffect(() => {
    if (!rec) return;
    const t = setTimeout(() => {
      setRec(null);
      setToast({ text: "Recording stopped after 15 minutes." });
    }, Math.max(0, rec.startedAt + RECORD_MAX_MS - Date.now()));
    return () => clearTimeout(t);
  }, [rec?.session, rec?.startedAt]); // eslint-disable-line react-hooks/exhaustive-deps

  const setSetting = (k, v) => setSettings((s) => { const n = { ...s, [k]: v }; store.set("mtg.scan.settings", n); return n; });
  const setSound = (k, v) => setSoundState((s) => { const n = { ...s, [k]: v }; store.set("mtg.scan.sound", n); return n; });
  const unlockSounds = () => { try { soundsRef.current?.unlock?.()?.catch?.(() => {}); } catch { /* no audio */ } };

  const loadScans = useCallback(async () => {
    try {
      const d = await api("/api/scans?status=staged");
      const list = asList(d, "scans").slice().sort((a, b) => (b.id ?? 0) - (a.id ?? 0));
      setScans(list);
      setScanTotals(d.totals?.staged ?? null);
      setListError(null);
      setSelected((sel) => new Set([...sel].filter((id) => list.some((s) => s.id === id))));
    } catch (e) {
      setListError(e.status === 404 ? "The scanner is not available on this server (update the app)." : `Could not load scans: ${e.message}`);
      setScans((s) => s || []);
    }
  }, []);
  useEffect(() => { if (active) loadScans(); }, [active, loadScans]);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), toast.ms || 4000);
    return () => clearTimeout(t);
  }, [toast]);

  const statusOf = useCallback((s) => {
    if (!s) return "failed";
    if (statusById[s.id]) return statusById[s.id];
    const raw = s.result_status || s.identify_status || s.decision || s.status;
    if (["auto", "suggest", "review", "failed"].includes(raw)) return raw;
    if (!s.printing_id && !s.store_printing_id) return "review";
    return "auto";
  }, [statusById]);
  const markStatus = (id, st) => setStatusById((m) => ({ ...m, [id]: st }));
  // Scanning on settles the session's earlier "? confirm" rows (server: lib/scans.js confirmImplicitly);
  // their chips turn "✓ confirmed", a short toast says so (never over another toast). No extra taps.
  const noteConfirmed = (list) => {
    if (!Array.isArray(list) || !list.length) return;
    setStatusById((m) => { const n = { ...m }; for (const c of list) if (c?.id) n[c.id] = "auto"; return n; });
    setToast((t) => t || { text: list.length === 1 ? `✓ ${list[0].name || "Previous card"} confirmed` : `✓ ${list.length} cards confirmed`, ms: 2500 });
  };

  // kind: a scan status (auto|suggest|review|failed|duplicate|error) or "increment" (+1);
  // res: the /api/scan answer {scan, duplicate, result}, or {increment:true, price_eur} for +1.
  // scanlib's chooseScanSound picks success, cash (price ≥ threshold) or nothing.
  const feedback = (kind, res = null) => {
    try {
      const snd = res ? lib?.chooseScanSound?.(res, soundRef.current) : null;
      if (snd) soundsRef.current?.play?.(snd);
    } catch { /* never block scanning on audio */ }
    vibrate(kind);
    setFlash({ color: STATUS_COLOR[kind === "increment" ? "auto" : kind] || "#ffffff", until: Date.now() + 900 });
  };

  const showError = (msg) => setToast({ text: msg, ms: 5000 });

  // ifIdle: opened by an arriving result (queued shutter / auto-ask scans can take up to 90 s), not by a
  // tap: never replace a sheet the user has open (a pick, Add by name, the commit sheet); the row
  // stays in the list with its pick action.
  function openPickerFor(scan, result, { truthFinish = null, payload = null, ifIdle = false } = {}) {
    // The user's own collector line: the server's stored strip, else the local capture.
    const strips = [];
    if (scan?.id && scan.has_strip !== false) strips.push(scanFileUrl(scan, "strip"));
    if (payload?.strip) strips.push(`data:image/jpeg;base64,${payload.strip}`);
    const cands = [...candidatesOf(result, scan), ...jsonArr(result?.variants || scan?.variants).map(normPrinting)]
      .filter((p, i, a) => p && p.id && a.findIndex((x) => x.id === p.id) === i);
    const pick = {
      type: "pick", scan, candidates: cands, truthFinish, strips,
      oracleId: scan?.oracle_id || result?.printing?.oracle_id || cands[0]?.oracle_id || null,
      lang: scan?.lang_detected || result?.lang_detected || "",
    };
    setSheet((sh) => (ifIdle && sh ? sh : pick));
  }

  // Discard (result card, calibration sheet, staged list): the row disappears at once and is deleted
  // after DISCARD_UNDO_MS unless the toast's Undo brings it back. Leaving the tab or committing deletes
  // it right away. A row that was the Rescan target is never replaced afterwards.
  // The DELETE names the row's created_at: scan ids are reused (an undo can remove the hidden row and a
  // new scan then gets its id), and the deferred delete must never hit that new card (409 then).
  const deleteNow = useCallback(async (id) => {
    const m = discardsRef.current;
    if (!m.has(id)) return;
    const { timer, createdAt } = m.get(id);
    clearTimeout(timer);
    m.delete(id);
    try { await api(`/api/scans/${id}${createdAt ? `?created_at=${encodeURIComponent(createdAt)}` : ""}`, { method: "DELETE" }); }
    catch (e) { if (e.status !== 404 && e.status !== 409) showError(`Discard failed: ${e.message}`); }
    setDiscarding((d) => { const n = new Set(d); n.delete(id); return n; });
    loadScans();
  }, [loadScans]); // eslint-disable-line react-hooks/exhaustive-deps
  const flushDiscards = useCallback(() => Promise.all([...discardsRef.current.keys()].map(deleteNow)), [deleteNow]);
  useEffect(() => { if (!active) flushDiscards(); }, [active, flushDiscards]);
  useEffect(() => () => { flushDiscards(); }, [flushDiscards]);
  const discard = (s) => {
    const id = s?.id;
    if (!id || discardsRef.current.has(id)) return;
    discardsRef.current.set(id, { timer: setTimeout(() => deleteNow(id), DISCARD_UNDO_MS), createdAt: s.created_at ?? null });
    setDiscarding((d) => new Set(d).add(id));
    setSelected((sel) => { const n = new Set(sel); n.delete(id); return n; });
    if (replaceRef.current === id) { replaceRef.current = null; probeRef.current?.endRescan?.(); }
    setLast((l) => (l?.scan?.id === id ? null : l));
    setSheet((sh) => (sh?.entry?.scan?.id === id || sh?.scan?.id === id ? null : sh));
    setToast({
      text: `Discarded ${s.name || "scan"}`, ms: DISCARD_UNDO_MS,
      action: {
        label: "Undo",
        run: () => {
          const m = discardsRef.current;
          if (!m.has(id)) return;
          clearTimeout(m.get(id).timer);
          m.delete(id);
          setDiscarding((d) => { const n = new Set(d); n.delete(id); return n; });
        },
      },
    });
  };

  async function handleResult(res, payload, preview) {
    const r = res?.result || {};
    const scan = res?.scan || null;
    if (scan?.id && r.price_eur != null) priceRef.current.set(scan.id, r.price_eur);
    if (res?.duplicate) {
      setLast({ kind: "duplicate", scan, result: r, payload, preview });
      feedback("duplicate", res);
      return;
    }
    const status = ["auto", "suggest", "review", "failed"].includes(r.status) ? r.status : scan ? statusOf(scan) : "failed";
    if (scan?.id) markStatus(scan.id, status);
    noteConfirmed(res?.implicitly_confirmed);
    setLast({ kind: status, scan, result: r, payload, preview });
    feedback(status, res);
    loadScans();
    if (settingsRef.current.calibration) setSheet((sh) => sh || { type: "truth", entry: { scan, result: r, preview, payload } });
    else if (status === "review" || status === "failed") {
      if (candidatesOf(r, scan).length) openPickerFor(scan, r, { payload, ifIdle: true });
    }
  }

  // One POST /api/scan with the busy/slow/cancel UI. Resolves with the answer; throws the
  // ApiError (status kept: the upload queue retries 429) or an Error with timeout:true when
  // cancelled/timed out.
  async function requestScan(payload, preview) {
    busyRef.current = true;
    setBusy(true);
    setSlow(null);
    setBusyPreview(preview || null);
    // After a server start the first scan waits for the scanner's warm-up
    // (fingerprints loading): say so instead of looking hung. After
    // SCAN_CANCEL_MS the user may cancel (with a retry); SCAN_TIMEOUT_MS is
    // above the server's own bound (warm-up wait + OCR + Claude), so a slow
    // but working scan is never cut off. A cancelled request is dropped by
    // the server (nothing staged), so Retry can't add the card twice.
    const ctl = new AbortController();
    cancelRef.current = () => ctl.abort(new DOMException("Cancelled", "AbortError"));
    const since = Date.now();
    const checkWarm = async () => {
      let warming = null;
      try {
        const h = await api("/healthz", { signal: ctl.signal });
        const st = h?.scanner?.matcher?.state;
        warming = st === "loading" || st === "idle";
      } catch { warming = null; }
      if (!ctl.signal.aborted) setSlow({ since, warming, cancellable: Date.now() - since >= SCAN_CANCEL_MS });
    };
    const slowTimer = setTimeout(checkWarm, SCAN_SLOW_MS);
    const pollTimer = setInterval(checkWarm, SCAN_SLOW_MS * 2);
    const cancelTimer = setTimeout(() => { if (!ctl.signal.aborted) setSlow((s) => ({ since, warming: s?.warming ?? null, cancellable: true })); }, SCAN_CANCEL_MS);
    const abortTimer = setTimeout(() => ctl.abort(), SCAN_TIMEOUT_MS);
    try {
      return await api("/api/scan", { method: "POST", json: payload, signal: ctl.signal });
    } catch (e) {
      if (e.name !== "AbortError") throw e;
      const error = Date.now() - since < SCAN_TIMEOUT_MS - 1000
        ? `Cancelled after ${Math.round((Date.now() - since) / 1000)} s; nothing was added. The scanner may still be warming up after a server start; try again in a moment.`
        : `No answer after ${Math.round(SCAN_TIMEOUT_MS / 1000)} s; nothing was added. Try again in a moment.`;
      throw Object.assign(new Error(error), { timeout: true });
    } finally {
      clearTimeout(slowTimer);
      clearInterval(pollTimer);
      clearTimeout(cancelTimer);
      clearTimeout(abortTimer);
      ctl.abort();
      cancelRef.current = null;
      busyRef.current = false;
      setBusy(false);
      setSlow(null);
      setBusyPreview(null);
    }
  }

  /** The scan request body for a capture (settings at capture time). */
  const scanBody = (shot, consumeReplace = true, precise = false) => {
    const s = settingsRef.current;
    // A Rescan target is only replaced while its card is still the one in view (the probe
    // controller's rescan track); once that card left or changed, the shutter adds a new row.
    if (consumeReplace && replaceRef.current && !probeRef.current?.rescan) replaceRef.current = null;
    const body = {
      card: shot.card,
      strip: shot.strip,
      settings: { storageLang: s.storageLang, foil: s.foil, condition: s.condition, ...(s.setHint.trim() ? { setHint: s.setHint.trim().toLowerCase() } : {}), ...(precise ? { precise: true } : {}) },
      ...(s.calibration ? { calibration: true } : {}),
      ...(replaceRef.current ? { replace_id: replaceRef.current } : {}),
      // shutter scans carry the probe session, so the next probe doesn't stage the same card again
      probe_session: probeSessionRef.current,
    };
    if (consumeReplace) { replaceRef.current = null; probeRef.current?.endRescan?.(); }
    return body;
  };

  // Shutter: a normal scan (Claude allowed) through the upload queue.
  // Auto-ask (autoask.js): one normal scan, Claude allowed, staged like a shutter scan; the answer
  // goes back to the AutoAsk (an hourly-cap answer pauses it and changes the hint).
  const onAutoAsk = (shot, capture, { precise = false } = {}) => {
    pushItem({ id: null, payload: { body: scanBody(shot, true, precise), preview: shot.cardPreview }, capture, allowClaude: true, force: false, autoAsk: true });
  };

  const onManual = (shot, capture, { precise = false } = {}) => {
    pushItem({ id: null, payload: { body: scanBody(shot, true, precise), preview: shot.cardPreview }, capture, allowClaude: true, force: false });
  };

  // From photo (0.9.0): image files → scanlib.capturePhotoFile (detector A2 on the still, else the whole
  // photo) → the shutter's queue (a normal scan, Claude allowed). No camera needed.
  const PHOTO_MAX = 20;
  const [photoBusy, setPhotoBusy] = useState(null); // "2 / 5" while cutting
  const onPhotoFiles = async (e) => {
    const all = [...(e.target.files || [])];
    e.target.value = "";
    if (!lib?.capturePhotoFile || !all.length || photoBusy) return;
    const files = all.slice(0, PHOTO_MAX);
    let missed = 0, failed = 0;
    for (let i = 0; i < files.length; i++) {
      setPhotoBusy(`${i + 1} / ${files.length}`);
      let bmp = null;
      try {
        bmp = await createImageBitmap(files[i], { imageOrientation: "from-image" });
        const shot = await lib.capturePhotoFile(bmp);
        if (!shot.found) missed++;
        onManual(shot, {
          kind: "manual", det: "v2", source: "photo", quad_source: shot.found ? "photo" : "default", fallback: !shot.found,
          allow_claude: true, shot: "file", strip_w: shot.stripSize?.[0] ?? null, t: Date.now(),
        });
      } catch (err) {
        failed++;
        console.warn(`[scan] photo ${files[i].name}: ${err.message}`);
      } finally {
        bmp?.close?.();
      }
    }
    setPhotoBusy(null);
    const notes = [];
    if (all.length > PHOTO_MAX) notes.push(`Only the first ${PHOTO_MAX} photos were taken.`);
    if (missed) notes.push(`${plural(missed, "photo")} without a clear card outline: the whole photo was sent.`);
    if (failed) notes.push(`${plural(failed, "photo")} could not be read.`);
    if (notes.length) setToast({ text: notes.join(" "), ms: 8000 });
  };

  // Probe: POST mode 'probe' (no busy card: probes are silent unless something is staged).
  // Resolves with the server answer; throws on network/HTTP errors and timeouts.
  // rescan: the probe controller's rescan track id at probe time (null = not the card a Rescan was for).
  const sendProbe = async ({ shot, rec: capture, precise, rescan = null }) => {
    // calibration stays: a probe-staged row in calibration mode keeps its images for the truth sheet
    const { replace_id: _r, ...base } = scanBody(shot, false, precise);
    const body = { ...base, mode: "probe", probe_session: probeSessionRef.current, capture };
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), PROBE_TIMEOUT_MS);
    let res;
    try { res = await api("/api/scan", { method: "POST", json: body, signal: ctl.signal }); }
    finally { clearTimeout(t); }
    // A rescanned card answered 'same' (it is the last staged card): nothing to replace.
    if (res?.outcome === "same" && rescan != null && probeRef.current?.rescan?.id === rescan) replaceRef.current = null;
    if (res?.outcome === "staged" && res.scan?.id) await handleProbeStaged(res, base, shot.cardPreview, rescan);
    else if (res?.outcome === "same" && res.finish_upgraded && res.scan?.id) {
      // A later ★/• read fixed the staged row's finish (it was only the session setting).
      const sc = res.scan;
      setLast((l) => (l?.scan?.id === sc.id ? { ...l, scan: { ...l.scan, ...sc }, result: { ...l.result, finish: sc.finish, finish_source: sc.finish_source } } : l));
      loadScans();
    }
    return res;
  };

  // A probe staged a card: result card + sound + flash (calibration: the truth sheet).
  async function handleProbeStaged(res, body, preview, rescan = null) {
    const scan = res.scan, r = res.result || {};
    const status = r.status === "suggest" ? "suggest" : "auto";
    if (r.price_eur != null) priceRef.current.set(scan.id, r.price_eur);
    markStatus(scan.id, status);
    // A Rescan of a review row: the identified card replaces it, but only when this probe came from
    // the rescan track still in view (the same card). A probe of any other card keeps the review row.
    const replaced = replaceRef.current;
    if (replaced) {
      const sameTrack = rescan != null && probeRef.current?.rescan?.id === rescan;
      replaceRef.current = null;
      if (sameTrack && replaced !== scan.id) api(`/api/scans/${replaced}`, { method: "DELETE" }).catch(() => {}).finally(loadScans);
    }
    noteConfirmed(res.implicitly_confirmed);
    setLast({ kind: status, scan, result: r, payload: { ...body, allowClaude: false }, preview, probe: true });
    feedback(status, res);
    loadScans();
    if (settingsRef.current.calibration) setSheet((sh) => sh || { type: "truth", entry: { scan, result: r, preview, payload: body } });
  }

  // Re-send a body already sent once (Send again, Retry, Different card, Ask Claude).
  const resend = (body, preview, extra = {}) => {
    const b = { ...body, ...extra };
    for (const k of Object.keys(b)) if (b[k] == null) delete b[k];
    delete b.mode;
    if (!queueRef.current) return;
    const { capture, allowClaude, force, ...rest } = b;
    pushItem({ id: null, payload: { body: rest, preview }, capture: capture || null, allowClaude: allowClaude !== false, force: Boolean(force) });
  };

  // The upload queue's callbacks (latest closures).
  handlers.current = {
    send: (item) => {
      const { capture: _c, allowClaude: _a, force: _f, ...rest } = item.payload?.body || {};
      const body = { ...rest, allowClaude: item.allowClaude !== false };
      if (item.capture) body.capture = item.capture;
      if (item.force) body.force = true;
      item.sent = body;
      return requestScan(body, item.payload?.preview);
    },
    onResult: (item, res) => {
      setQueued(queueRef.current?.length ?? 0);
      if (item.autoAsk && autoAskRef.current?.scanned(res?.result ?? null) === "hourly cap reached") {
        setToast({ text: "Claude limit for this hour reached: tap the shutter for hard cards.", ms: 6000 });
      }
      handleResult(res, item.sent, item.payload?.preview);
    },
    onError: (item, err) => {
      setQueued(queueRef.current?.length ?? 0);
      if (item.autoAsk) autoAskRef.current?.scanned(null);
      setLast({ kind: "error", error: err?.message || "Scan failed", timeout: Boolean(err?.timeout), payload: item.sent, preview: item.payload?.preview });
      feedback("error");
    },
    onGiveUp: () => {
      setQueued(queueRef.current?.length ?? 0);
      setToast({ text: "The server is busy, scans are waiting.", ms: 600000, action: { label: "Retry", run: () => queueRef.current?.retry() } });
    },
  };

  const patchScan = async (id, body, { status } = {}) => {
    try {
      const updated = await api(`/api/scans/${id}`, { method: "PATCH", json: body });
      if (status) markStatus(id, status);
      await loadScans();
      const row = updated?.scan || (updated?.id ? updated : null);
      setLast((l) => (l?.scan?.id === id ? { ...l, kind: status || l.kind, scan: { ...l.scan, ...body, ...(row || {}) } } : l));
    } catch (e) { showError(e.message); }
  };
  const increment = async (id) => {
    try {
      const res = await api(`/api/scans/${id}/increment`, { method: "POST", json: {} });
      setToast({ text: "+1 copy" });
      noteConfirmed(res?.implicitly_confirmed);
      feedback("increment", { increment: true, price_eur: priceRef.current.get(id) ?? null });
      await loadScans();
    } catch (e) { showError(e.message); }
  };
  const undo = async () => {
    try {
      // Discarded rows go first: Undo then acts on the newest VISIBLE scan, not on a hidden one.
      await flushDiscards();
      const r = await api("/api/scans/undo", { method: "POST", json: {} });
      // an undone stage / +1 takes back the implicit confirmations it caused
      for (const id of r?.unconfirmed || []) markStatus(id, "suggest");
      setLast(null);
      setToast({ text: r?.scan?.name || r?.name ? `Removed ${r.scan?.name || r.name}` : "Last scan undone" });
      await loadScans();
    } catch (e) { showError(e.status === 404 ? "Nothing to undo." : e.message); }
  };
  const forceAdd = () => {
    if (!last?.payload) return;
    resend(last.payload, last.preview, { force: true });
  };
  // "Ask Claude" on a review/failed card: the same photo again, Claude allowed, replacing the review row.
  const askClaude = () => {
    if (!last?.payload) return;
    const replace = last.scan?.id && last.kind === "review" ? { replace_id: last.scan.id } : {};
    const { replace_id: _r, ...body } = last.payload;
    resend(body, last.preview, { allowClaude: true, force: false, ...replace });
  };

  async function onPicked(p) {
    const sh = sheet;
    setSheet(null);
    if (!sh) return;
    const s = settingsRef.current;
    const singleFinish = p.finishes?.length === 1 ? p.finishes[0] : null;
    try {
      if (sh.type === "manual" || !sh.scan?.id) {
        const finish = sh.truthFinish || singleFinish || (s.foil === "foil" ? "foil" : "nonfoil");
        const res = await api("/api/scans/manual", { method: "POST", json: { printing_id: p.id, finish, quantity: 1, storageLang: s.storageLang, condition: s.condition } });
        const scan = res?.scan || (res?.id ? res : null);
        if (scan?.id) markStatus(scan.id, "auto");
        if (sh.truthFinish && scan?.id) {
          await api(`/api/scans/${scan.id}/truth`, { method: "POST", json: { printing_id: p.id, finish } }).catch(() => {});
        }
        setToast({ text: `Added ${p.name}` });
        feedback("auto");
      } else {
        const updated = await api(`/api/scans/${sh.scan.id}`, { method: "PATCH", json: { printing_id: p.id } });
        markStatus(sh.scan.id, "auto");
        if (sh.truthFinish) {
          await api(`/api/scans/${sh.scan.id}/truth`, { method: "POST", json: { printing_id: p.id, finish: sh.truthFinish } });
          setToast({ text: "Truth saved" });
        }
        // the row as the server has it now (finish included: the old printing's finish may not apply)
        const row = updated?.scan || (updated?.id ? updated : null);
        setLast((l) => (l?.scan?.id === sh.scan.id
          ? { ...l, kind: "auto", result: { ...l.result, finish: undefined, finishSource: undefined }, scan: { ...l.scan, printing_id: p.id, name: p.name, set_code: p.set, collector_number: p.cn, image_normal: p.img, ...(row || {}) } }
          : l));
      }
      await loadScans();
    } catch (e) { showError(e.message); }
  }

  const list = (scans || []).filter((s) => !discarding.has(s.id));
  const committable = list.filter((s) => (s.printing_id || s.store_printing_id) && !["review", "failed"].includes(statusOf(s)));
  const selIds = [...selected].filter((id) => list.some((s) => s.id === id));
  // Review/failed rows can't be committed (the server refuses the whole batch): leave them out of a selection too.
  const committableIds = new Set(committable.map((s) => s.id));
  const selCommit = selIds.filter((id) => committableIds.has(id));
  const commitIds = selIds.length ? selCommit : committable.map((s) => s.id);
  const copies = list.reduce((a, s) => a + (s.quantity ?? 1), 0);
  const allSelected = list.length > 0 && selIds.length === list.length;
  const scanner = health?.scanner;
  const [settingsOpen, setSettingsOpen] = useState(false);
  const photoInputRef = useRef(null);
  const sheetOpen = Boolean(sheet) || settingsOpen;
  // Money (beta.3): the staged list's value and the last card's unit price. The staged row is
  // fresher than the scan answer (a finish switch re-prices it); undefined = no priced last card.
  const totals = stagedValue(list, scanTotals);
  const lastRow = last?.scan?.id ? list.find((s) => s.id === last.scan.id) || null : null;
  const lastPrice = !last || !["auto", "suggest", "duplicate"].includes(last.kind) || (!lastRow && !last.scan) ? undefined
    : lastRow && "price_eur" in lastRow ? lastRow.price_eur ?? null
      : last.result?.price_eur !== undefined ? last.result.price_eur ?? null : undefined;
  const resultProps = {
    busy, slow, last, busyPreview, queued, row: lastRow, price: lastPrice,
    onFinish: (f) => last?.scan?.id && patchScan(last.scan.id, { finish: f }),
    onCancel: () => cancelRef.current?.(),
    onPick: () => openPickerFor(last?.scan, last?.result, { payload: last?.payload }),
    onConfirm: () => last?.scan?.id && patchScan(last.scan.id, { printing_id: last.scan.printing_id }, { status: "auto" }),
    onIncrement: () => last?.scan?.id && increment(last.scan.id), onForce: forceAdd, onUndo: undo,
    onDiscard: () => last?.scan?.id && discard(last.scan),
    onResend: () => last?.payload && resend(last.payload, last.preview),
    onAskClaude: askClaude,
    onRetry: () => {
      // A rescan replaces the open review row of this card instead of adding a second one.
      replaceRef.current = last?.scan?.id && ["review", "failed"].includes(last.kind) ? last.scan.id : null;
      setLast(null);
      probeRef.current?.rearm({ rescan: Boolean(replaceRef.current) });
    },
    onSearch: () => setSheet({ type: "manual" }),
  };

  return (
    <div className="scan">
      <div className="scan-main">
        {libError && <ErrorNotice error={libError} />}
        {scanner && scanner.index_ready === false && (
          <div className="notice warn" role="status"><span aria-hidden="true">⏳</span><div className="grow">The card index is still being built. Scanning works once it's ready (see Settings → Scanner &amp; data).</div></div>
        )}
        {scanner && (scanner.tesseract === false || scanner.djpeg === false) && (
          <div className="notice warn" role="status"><div className="grow">Text recognition is not installed on the server{scanner.tesseract === false ? " (tesseract missing)" : ""}{scanner.djpeg === false ? " (djpeg missing)" : ""}. Scans will be less accurate.</div></div>
        )}
        <CameraBoundary recording={Boolean(rec?.session)}>
        <CameraView lib={lib} active={active} settings={settings} busy={busy} paused={sheetOpen} flash={flash}
          onError={showError} onUnlock={unlockSounds}
          probeRef={probeRef} detRef={detRef} queued={queued} record={rec} sendProbe={sendProbe} onManual={onManual}
          plusOne={Boolean(last?.scan?.id && !discarding.has(last.scan.id))}
          autoAskRef={autoAskRef} onAutoAsk={onAutoAsk}
          onFoil={(f) => setSetting("foil", f)} onStart={() => { probeSessionRef.current = newProbeSession(); }}
          onRecorded={(p) => { recStatsRef.current = p; }}
          overlay={(busy || last) && !sheetOpen ? <ResultCard {...resultProps} compact /> : null}
          valuePill={<CamValue last={lastPrice} total={totals} />}
          onPhoto={() => photoInputRef.current?.click()} onSettings={() => setSettingsOpen(true)} photoBusy={photoBusy} />
        </CameraBoundary>
        {(busy || last) && <ResultCard {...resultProps} />}

        <input ref={photoInputRef} type="file" accept="image/*" multiple className="sr-only" tabIndex={-1} aria-hidden="true" disabled={Boolean(photoBusy) || !lib} onChange={onPhotoFiles} />
        {photoBusy && <div className="notice photo-status" role="status"><Spinner label="" /> Reading photo {photoBusy}…</div>}
        {langNotice && settings.storageLang !== "scanned" && (
          <div className="notice" role="status">
            <span aria-hidden="true">✦</span>
            <div className="grow stack" style={{ gap: 8 }}>
              <span><b>New: store cards in the language they were scanned in.</b> An Italian card stays Italian in your collection (names stay English; a small “IT” shows the language). Right now every scan is stored as {LANG_NAME[settings.storageLang] || settings.storageLang}.</span>
              <div className="row">
                <button type="button" className="btn sm primary" onClick={() => { setSetting("storageLang", "scanned"); closeLangNotice(); }}>Store as scanned</button>
                <button type="button" className="btn sm ghost" onClick={closeLangNotice}>Keep {LANG_NAME[settings.storageLang] || settings.storageLang}</button>
              </div>
            </div>
          </div>
        )}
        {settingsOpen && (
          <Sheet title="Scan settings" onClose={() => setSettingsOpen(false)}>
          <div className="settings-grid">
            <div className="field" style={{ gridColumn: "1 / -1" }}>
              <span className="label" id="scan-finish-l">Finish when the card doesn't show it</span>
              <div className="segmented" role="group" aria-labelledby="scan-finish-l">
                {[["auto", "Auto"], ["nonfoil", "Non-foil"], ["foil", "✦ Foil"]].map(([k, l]) => (
                  <button key={k} type="button" aria-pressed={settings.foil === k} onClick={() => setSetting("foil", k)}>{l}</button>
                ))}
              </div>
            </div>
            <div className="field">
              <label htmlFor="scan-lang">Store cards as</label>
              <select id="scan-lang" className="select" value={settings.storageLang} onChange={(e) => { setSetting("storageLang", e.target.value); if (langNotice) closeLangNotice(); }}>
                <option value="scanned">Scanned language</option>
                {SCAN_LANGS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
              </select>
            </div>
            <label className="switch"><input type="checkbox" checked={settings.auto} onChange={(e) => setSetting("auto", e.target.checked)} /> Auto-scan (recognise cards without the shutter)</label>

            <div className="field">
              <label htmlFor="scan-cond">Condition for new scans</label>
              <select id="scan-cond" className="select" value={settings.condition} onChange={(e) => setSetting("condition", e.target.value)}>
                {CONDITIONS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
              </select>
            </div>
            <div className="field">
              <label htmlFor="scan-set">Set hint (optional)</label>
              <input id="scan-set" className="input" placeholder="e.g. dmu" maxLength={8} autoCapitalize="off" autoCorrect="off" spellCheck="false"
                value={settings.setHint} onChange={(e) => setSetting("setHint", e.target.value.replace(/[^a-z0-9]/gi, ""))} />
            </div>
            <label className="switch"><input type="checkbox" checked={sound.enabled} onChange={(e) => setSound("enabled", e.target.checked)} /> Scan sounds</label>
            <div className="field">
              <label htmlFor="scan-cash">Cash sound from (€)</label>
              <input id="scan-cash" className="input num-input" type="number" inputMode="decimal" min="0" step="0.5" disabled={!sound.enabled}
                defaultValue={sound.threshold} onChange={(e) => { const v = parseFloat(e.target.value); if (Number.isFinite(v) && v >= 0) setSound("threshold", v); }} />
            </div>
            <label className="switch"><input type="checkbox" checked={settings.photo} onChange={(e) => setSetting("photo", e.target.checked)} /> Full-resolution photo for the shutter (Android)</label>
            <div className="field" style={{ gridColumn: "1 / -1" }}>
              <label className="switch"><input type="checkbox" checked={settings.autoClaude !== false} onChange={(e) => setSetting("autoClaude", e.target.checked)} /> Ask Claude automatically for hard cards</label>
              <span className="small muted">
                {health?.claude_configured === false ? "Claude is not set up on the server, so this does nothing."
                  : health?.scanner?.vision?.per_hour === 0 ? "Claude scans are turned off on the server (SCAN_CLAUDE_PER_HOUR=0)."
                    : `When a card lies still and isn't recognised after a few tries, Claude is asked once.${health?.scanner?.vision?.per_hour ? ` Counts towards the ${health.scanner.vision.per_hour} Claude scans per hour.` : ""}`}
              </span>
            </div>
            <label className="switch" style={{ gridColumn: "1 / -1" }}><input type="checkbox" checked={settings.calibration} onChange={(e) => setSetting("calibration", e.target.checked)} /> Calibration mode: confirm the true printing after each scan</label>
            <div className="field" style={{ gridColumn: "1 / -1" }}>
              <label className="switch"><input type="checkbox" checked={Boolean(rec)}
                onChange={(e) => { recStatsRef.current = null; setRec(e.target.checked ? { session: newRecordSession(), startedAt: Date.now() } : null); }} /> Record session</label>
              <span className="small muted">Sends small camera frames and scanner states to your server to tune the scanner. Stops by itself after 15 minutes.</span>
              {rec && <RecordStatus rec={rec} statsRef={recStatsRef} />}
            </div>
            <RecordedSessions recording={rec?.session ?? null} />
          </div>
          </Sheet>
        )}
      </div>

      <div className="scan-side">

        <div className="list-head">
          <h2 style={{ fontSize: "1.1rem" }}>Scanned {list.length > 0 && <span className="muted small">{plural(list.length, "card")} · {plural(copies, "copy", "copies")}{totals.value != null && <> · <b style={{ color: "var(--text)" }}>{fmtEur(totals.value)}</b>{totals.unpriced ? ` (${totals.unpriced} unpriced)` : ""}</>}</span>}</h2>
          <div className="row">
            <IconBtn icon={Icon.undo} label="Undo the last scan action" onClick={undo} disabled={!list.length} />
            <IconBtn icon={Icon.plus} label="Add a card by name" onClick={() => setSheet({ type: "manual" })} />
          </div>
        </div>
        <ErrorNotice error={listError} onRetry={loadScans} />
        {!scans && !listError && <Spinner />}
        {scans && list.length === 0 && !listError && (
          <div className="empty card"><h3>No scans yet</h3><p style={{ margin: 0 }}>Scanned cards collect here. Check them, then add them to a binder or a deck.</p></div>
        )}
        {list.length > 0 && (
          <>
            <label className="switch"><input type="checkbox" checked={allSelected} onChange={(e) => setSelected(e.target.checked ? new Set(list.map((s) => s.id)) : new Set())} /> Select all</label>
            <div className="scan-list">
              {list.map((s) => (
                <ScanRow key={s.id} s={s} status={statusOf(s)} selected={selected.has(s.id)}
                  onSelect={(on) => setSelected((sel) => { const n = new Set(sel); if (on) n.add(s.id); else n.delete(s.id); return n; })}
                  onPatch={(body) => patchScan(s.id, body)} onDelete={() => discard(s)} onIncrement={() => increment(s.id)}
                  onPick={() => openPickerFor(s, null, { payload: last?.scan?.id === s.id ? last.payload : null })} onConfirm={() => patchScan(s.id, { printing_id: s.printing_id }, { status: "auto" })} />
              ))}
            </div>
            <div className="commit-bar">
              <span className="grow small">{selIds.length ? `${plural(selIds.length, "scan")} selected` : `${plural(committable.length, "scan")} ready`}
                {!selIds.length && committable.length < list.length && <span className="muted"> · {list.length - committable.length} need a pick</span>}
                {selIds.length > selCommit.length && <span className="muted"> · {selIds.length - selCommit.length} need a pick first</span>}</span>
              <button type="button" className="btn primary" disabled={!commitIds.length} onClick={() => { flushDiscards(); setSheet({ type: "commit", ids: commitIds }); }}>
                Add {selIds.length ? "selected" : "all"} to…
              </button>
            </div>
          </>
        )}
      </div>

      {sheet?.type === "pick" && (
        <PrintingPicker title={sheet.scan?.name ? `Which printing? ${sheet.scan.name}` : "Which card is it?"} candidates={sheet.candidates}
          oracleId={sheet.oracleId} lang={sheet.lang} currentId={sheet.scan?.printing_id} strips={sheet.strips} onPick={onPicked} onClose={() => setSheet(null)} />
      )}
      {sheet?.type === "manual" && (
        <PrintingPicker title="Add a card by name" startInSearch lang="" onPick={onPicked} onClose={() => setSheet(null)} />
      )}
      {sheet?.type === "commit" && (
        <CommitSheet ids={sheet.ids} onClose={() => setSheet(null)} onDone={(res, label) => {
          setSheet(null);
          setSelected(new Set());
          const n = res?.committed ?? sheet.ids.length;
          setToast({ text: `Added ${typeof n === "number" ? plural(n, "scan") : "scans"} to ${label}` });
          setLast(null);
          loadScans();
          onCommitted?.();
        }} />
      )}
      {sheet?.type === "truth" && (
        <TruthSheet entry={sheet.entry} onClose={() => setSheet(null)}
          onDone={(msg) => { setSheet(null); setToast({ text: msg }); }}
          onDiscard={(s) => discard(s)}
          onPickNeeded={(finish) => openPickerFor(sheet.entry.scan, sheet.entry.result, { truthFinish: finish, payload: sheet.entry.payload })} />
      )}
      {toast && (
        <div className="toast" role="status" aria-live="polite">
          <span>{toast.text}</span>
          {toast.action && <button type="button" className="btn ghost sm" onClick={() => { const a = toast.action; setToast(null); a.run(); }}>{toast.action.label}</button>}
          <button type="button" className="btn ghost icon sm" aria-label="Dismiss" onClick={() => setToast(null)} style={{ textDecoration: "none" }}><Icon.close /></button>
        </div>
      )}
    </div>
  );
}

// A scan slower than SCAN_SLOW_MS shows the warm-up state; from SCAN_CANCEL_MS on it can be
// cancelled (then retried); SCAN_TIMEOUT_MS (above the server's 30 s warm-up wait + OCR + 90 s
// Claude) aborts it for good.
const SCAN_SLOW_MS = 4000;
const SCAN_CANCEL_MS = 60000;
const SCAN_TIMEOUT_MS = 180000;

/** Seconds since `since`, ticking once a second. */
function ScanElapsed({ since }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  return <span className="small muted">{Math.max(0, Math.round((now - since) / 1000))} s</span>;
}

/**
 * The last scan's result. Below the camera (full, with explanations) and, with `compact`, as the
 * overlay at the bottom of the camera view (beta.3: visible without scrolling on a phone).
 * row: the staged list row of last.scan (fresher finish/price after a toggle), price: its EUR unit
 * price (undefined = unknown), onFinish(next): tap the finish to switch it (staged rows only).
 */
function ResultCard({ busy, slow, last, busyPreview, queued = 0, compact = false, row = null, price, onFinish, onCancel, onPick, onConfirm, onIncrement, onForce, onResend, onUndo, onDiscard, onRetry, onSearch, onAskClaude }) {
  const cls = compact ? "result cam-result" : "result";
  // Only the full card below the camera announces results (the overlay repeats them).
  const live = compact ? {} : { role: "status", "aria-live": "polite" };
  if (busy) {
    // slow.warming: true = the matcher is loading, false = it is ready (just slow), null = /healthz unknown.
    const title = !slow ? "Identifying…" : slow.warming === false ? "Still identifying…" : compact ? "Identifying… (warming up)" : "Identifying… (warming up the scanner)";
    const detail = !slow ? "Reading the collector line and matching the art."
      : slow.warming === false ? "The server is busy; this is taking longer than usual."
        : "The first scan after a server start waits for the card fingerprints to load. This can take up to a minute.";
    return (
      <div className={`${cls} st-busy`} {...live}>
        {busyPreview || last?.preview ? <img className="th" src={busyPreview || last.preview} alt="" /> : <span className="th" />}
        <div className="body"><span className="nm">{title}</span>{!compact && <span className="small muted">{detail}</span>}
          {queued > 1 && <span className="small muted">{plural(queued - 1, "more card")} waiting</span>}
          {slow && <ScanElapsed since={slow.since} />}
          <div className="progress" aria-hidden="true" /></div>
        {slow?.cancellable && onCancel && (
          <div className="actions"><button type="button" className="btn sm" onClick={onCancel}><Icon.close /> Cancel</button></div>
        )}
      </div>
    );
  }
  if (!last) return null;
  const { kind, scan, result: r = {} } = last;
  if (kind === "error") {
    return (
      <div className={`${cls} st-error`} {...(compact ? {} : { role: "alert" })}>
        {last.preview ? <img className="th" src={last.preview} alt="" /> : <span className="th" />}
        <div className="body"><span className="nm">{last.timeout ? "Scan stopped" : "Scan failed"}</span><span className="small err-text">{last.error}</span></div>
        <div className="actions">
          {last.payload && <button type="button" className={`btn sm${last.timeout ? " primary" : ""}`} onClick={onResend}>{last.timeout ? <><Icon.refresh /> Retry</> : "Send again"}</button>}
          <button type="button" className="btn sm" onClick={onRetry}><Icon.camera /> Rescan</button>
        </div>
      </div>
    );
  }
  const cur = row ? { ...scan, ...row } : scan;
  const store_ = normPrinting(r.store || r.printing) || (cur ? normPrinting({ ...cur, id: cur.store_printing_id || cur.printing_id }) : null);
  const name = cur?.name || store_?.name || "Unknown card";
  const thumb = (cur && scanThumb(cur)) || store_?.imgSmall || last.preview;
  const ld = (r.lang_detected || cur?.lang_detected || "").toUpperCase(), ls = (cur?.store_lang || r.store?.lang || "").toUpperCase();
  // The staged row knows the current finish (a tap may have switched it); else the scan answer's.
  const finish = normFinish(row?.finish || r.finish || scan?.finish);
  const guessed = row ? finishGuessed(row) : scan ? finishGuessed(scan) : r.finishSource === "toggle";
  const fins = cur ? scanFinishes(cur) : [];
  const nextFinish = fins.length > 1 ? fins[(fins.indexOf(finish) + 1) % fins.length] : null;
  const canToggle = Boolean(onFinish && scan?.id && row && nextFinish && kind !== "duplicate");
  const finishText = <>{finish !== "nonfoil" && "✦ "}{FINISH_LABEL[finish] || finish}{guessed && "?"}</>;
  const finishEl = canToggle
    ? <button type="button" className={`finish-tag ${finish}${guessed ? " finish-q" : ""}`} onClick={() => onFinish(nextFinish)}
      aria-label={`Finish ${FINISH_LABEL[finish] || finish}${guessed ? " (not read from the card)" : ""}. Switch to ${FINISH_LABEL[nextFinish]}`}>{finishText}</button>
    : <span className={`finish-tag static ${finish}`} title={guessed ? "Not read from the card: the session's finish setting. Tap the finish in the list to change it." : undefined}>{finishText}</span>;
  const showPrinting = store_ && (scan || kind !== "failed");
  const priceEl = price !== undefined && showPrinting ? <span className="price">{price == null ? "no price" : fmtEur(price)}</span> : null;
  const title = kind === "failed" && !scan ? "Card not recognised" : name;
  return (
    <div className={`${cls} st-${kind}`} {...live}>
      {thumb ? <img className="th" src={thumb} alt="" /> : <span className="th" />}
      <div className="body">
        {compact ? (
          <span className="head"><span className={`badge st-chip ${kind}`} title={STATUS_LABEL[kind] || kind}>{(STATUS_LABEL[kind] || kind).split(" ")[0]}</span><span className="nm" title={title}>{title}</span>{showPrinting && <LangTag lang={ls || ld} />}</span>
        ) : (
          <>
            <span className="row" style={{ gap: 6 }}><span className={`badge st-chip ${kind}`}>{STATUS_LABEL[kind] || kind}</span>{r.claude_used && <span className="badge accent">✦ Claude</span>}</span>
            <span className="nm">{title} {showPrinting && <LangTag lang={ls || ld} />}</span>
          </>
        )}
        {showPrinting && (
          <span className="small sub">
            <span className={compact ? "" : "muted"}>{printingLabel(store_)}{ld && ls && ld !== ls ? (compact ? ` · ${ld}→${ls}` : ` · read ${ld}, stored ${ls}`) : ""}</span>
            {finishEl}{priceEl}{compact && r.claude_used && <span>✦ Claude</span>}
          </span>
        )}
        {!compact && kind === "duplicate" && <span className="small">Same printing as your last scan, so it was not added again.</span>}
        {!compact && kind === "suggest" && <span className="small">Probably right: please confirm.</span>}
        {!compact && kind === "review" && <span className="small">Not sure: pick the right printing.</span>}
        {!compact && kind === "failed" && last.payload?.capture?.fallback && <span className="small">Couldn't identify – adjust the card and retry.</span>}
      </div>
      <div className="actions">
        {kind === "duplicate" && scan?.id && <button type="button" className="btn sm primary" onClick={onIncrement}><Icon.plus /> +1 copy</button>}
        {kind === "duplicate" && last.payload && <button type="button" className="btn sm" onClick={onForce}>{compact ? "Different card" : "Different card, add it"}</button>}
        {kind === "suggest" && scan?.id && <button type="button" className="btn sm primary" onClick={onConfirm}><Icon.check /> Confirm</button>}
        {(kind === "suggest" || kind === "review" || ((kind === "auto") && jsonArr(r.variants || scan?.variants).length > 0)) && (
          <button type="button" className={`btn sm${kind === "review" ? " primary" : ""}`} onClick={onPick}>{kind === "auto" ? "variant?" : compact ? "Pick" : "Pick printing"}</button>
        )}
        {kind === "failed" && <button type="button" className="btn sm primary" onClick={onSearch}><Icon.search /> {compact ? "Find" : "Find by name"}</button>}
        {(kind === "failed" || kind === "review") && <button type="button" className="btn sm" onClick={onRetry}><Icon.camera /> Rescan</button>}
        {(kind === "failed" || kind === "review") && onAskClaude && last.payload?.allowClaude === false && !r.claude_used && (
          <button type="button" className="btn sm" onClick={onAskClaude}><Icon.sparkle /> {compact ? "Claude" : "Ask Claude"}</button>
        )}
        {(kind === "auto" || kind === "suggest") && scan?.id && <button type="button" className="btn sm" onClick={onIncrement} aria-label={compact ? "One more copy" : undefined}>{compact ? "+1" : <><Icon.plus /> +1</>}</button>}
        {scan?.id && kind !== "duplicate" && (onDiscard
          ? <button type="button" className="btn sm danger undo-btn" onClick={onDiscard} style={{ marginLeft: "auto" }} title="Not this card / not a card: remove it from the scanned list"
            aria-label={compact ? `Discard ${name}` : undefined}><Icon.trash />{compact ? null : " Discard"}</button>
          : <button type="button" className="btn sm danger undo-btn" onClick={onUndo} style={{ marginLeft: "auto" }}><Icon.undo /> Undo</button>)}
      </div>
    </div>
  );
}

/**
 * Top-right camera pill: the last card's EUR price and the staged list's value (scan session sum).
 * last: unit price (null = unpriced, undefined = no last card), total: {value, copies, unpriced}.
 */
function CamValue({ last, total }) {
  if (last === undefined && !total?.copies) return null;
  const label = [
    last !== undefined ? `Last card ${last == null ? "no price" : fmtEur(last)}` : null,
    total?.copies ? `scanned ${plural(total.copies, "copy", "copies")}${total.value == null ? "" : ` worth ${fmtEur(total.value)}`}${total.unpriced ? `, ${total.unpriced} without a price` : ""}` : null,
  ].filter(Boolean).join(", ");
  return (
    <div className="cam-value" role="status" aria-label={label} title={label}>
      {last !== undefined && <span className="v-last">{last == null ? "–" : fmtEur(last)}</span>}
      {total?.copies > 0 && <span className="v-sum">Σ {total.value == null ? "—" : fmtEur(total.value)}{total.unpriced ? "+" : ""} · {fmtInt(total.copies)}</span>}
    </div>
  );
}

/**
 * Value of the staged list: Σ quantity × price_eur (GET /api/scans rows, store printing + finish).
 * Computed from the visible rows (pending discards left out); an older server without per-row
 * prices falls back to its totals.staged. unpriced = rows without a price.
 */
function stagedValue(list, serverTotals = null) {
  let value = 0, copies = 0, unpriced = 0, priced = false;
  for (const s of list) {
    const q = s.quantity ?? 1;
    copies += q;
    if (typeof s.price_eur === "number" && Number.isFinite(s.price_eur)) { value += q * s.price_eur; priced = true; }
    else unpriced += 1;
  }
  const hasField = list.some((s) => "price_eur" in s);
  if (!hasField && serverTotals) return { value: serverTotals.value_eur ?? null, copies, unpriced: serverTotals.unpriced ?? 0 };
  return { value: priced || !unpriced ? Math.round(value * 100) / 100 : null, copies, unpriced };
}
