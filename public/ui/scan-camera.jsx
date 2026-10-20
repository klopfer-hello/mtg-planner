"use strict";

// ===========================================================================
// Scan tab: camera scanner, staging list, commit to binder / deck
// ===========================================================================

const SCAN_LANGS = [
  ["en", "English"], ["de", "Deutsch"], ["fr", "Français"], ["it", "Italiano"], ["es", "Español"], ["pt", "Português"],
  ["ja", "日本語"], ["ko", "한국어"], ["ru", "Русский"], ["zhs", "简体中文"], ["zht", "繁體中文"],
];
// Every language code Scryfall uses (owned copies can be any of them; the scanner reads SCAN_LANGS).
const CARD_LANGS = [
  ...SCAN_LANGS, ["he", "עברית"], ["la", "Latina"], ["grc", "Ancient Greek"], ["ar", "العربية"], ["sa", "Sanskrit"],
  ["ph", "Phyrexian"], ["qya", "Quenya"],
];
const LANG_NAME = Object.fromEntries(CARD_LANGS);
const CONDITIONS = [
  ["mint", "Mint", "M"], ["near_mint", "Near Mint", "NM"], ["excellent", "Excellent", "EX"], ["good", "Good", "GD"],
  ["light_played", "Light Played", "LP"], ["played", "Played", "PL"], ["poor", "Poor", "PR"],
];
const BOARDS = [["main", "Main deck"], ["side", "Sideboard"], ["commander", "Commander"], ["maybe", "Maybeboard"]];
const FINISH_LABEL = { nonfoil: "Non-foil", foil: "Foil", etched: "Etched" };
const STATUS_LABEL = { auto: "✓ matched", suggest: "? confirm", review: "✗ pick", failed: "✗ unknown", duplicate: "= same as last" };
const STATUS_COLOR = { auto: "#62d18d", suggest: "#f0c062", duplicate: "#f0c062", review: "#ff8274", failed: "#ff8274", error: "#ff8274" };
// (Sound settings moved to mtg.scan.sound, see loadSoundSettings.)
// storageLang "scanned" (beta.4 default): the collection keeps the detected printing and its language.
// autoClaude (beta.5): ask Claude once for a card that repeated probes can't recognise (public/autoask.js).
const SCAN_DEFAULTS = { storageLang: "scanned", foil: "auto", condition: "near_mint", setHint: "", auto: true, photo: true, calibration: false, autoClaude: true };

/** Array from an API answer that may be a bare array or wrap it in a key. */
const asList = (d, ...keys) => (Array.isArray(d) ? d : keys.map((k) => d?.[k]).find(Array.isArray) || []);
const jsonArr = (v) => {
  if (Array.isArray(v)) return v;
  if (typeof v === "string" && v.trim().startsWith("[")) { try { const a = JSON.parse(v); return Array.isArray(a) ? a : []; } catch { return []; } }
  return [];
};
const normFinish = (f) => (f === "normal" || !f ? "nonfoil" : f);

/** One printing shape for index rows, candidates and scan rows. */
function normPrinting(p) {
  if (!p) return null;
  const face = jsonArr(p.faces)[0] || {};
  return {
    id: p.id ?? p.printing_id ?? p.scryfall_id ?? null,
    oracle_id: p.oracle_id ?? null,
    name: p.printed_name && p.lang && p.lang !== "en" ? p.printed_name : (p.name ?? face.name ?? "?"),
    en_name: p.name ?? face.name ?? "",
    set: String(p.set_code ?? p.set ?? "").toLowerCase(),
    set_name: p.set_name ?? "",
    cn: p.collector_number ?? p.number ?? "",
    lang: p.lang ?? p.language ?? "",
    frame: p.frame != null ? String(p.frame) : null,
    img: p.image_normal ?? face.image_normal ?? p.image_small ?? face.image_small ?? null,
    imgSmall: p.image_small ?? face.image_small ?? p.image_normal ?? face.image_normal ?? null,
    finishes: jsonArr(p.finishes).map(normFinish),
    score: typeof p.score === "number" ? p.score : null,
    // What tells near-identical printings apart (promo stamps, frames, borders).
    tags: [...new Set([
      ...jsonArr(p.promo_types), ...jsonArr(p.frame_effects).filter((f) => f !== "legendary"),
      p.full_art ? "full art" : null, p.textless ? "textless" : null,
      p.border_color && p.border_color !== "black" ? `${p.border_color} border` : null,
      p.frame && !["2015", "2003"].includes(String(p.frame)) ? `${p.frame} frame` : null,
    ].filter(Boolean).map(String))],
  };
}
const printingLabel = (p) => (p ? `${p.set.toUpperCase()} #${p.cn}${p.lang ? ` · ${p.lang.toUpperCase()}` : ""}` : "");

// Scan ids can be reused (Rescan/Undo delete the newest row, SQLite hands its id
// out again), so the URL carries the scan's created_at: a new capture never hits
// the browser's cached JPEG of the old one.
const scanFileUrl = (s, kind) => `/api/scans/${s.id}/${kind}${s.created_at ? `?v=${encodeURIComponent(s.created_at)}` : ""}`;
function scanThumb(s) {
  const st = s.store || s.store_printing || s.printing || {};
  return s.image_small || s.image_normal || st.image_small || st.image_normal || jsonArr(st.faces)[0]?.image_small || (s.image_path || s.has_image ? scanFileUrl(s, "image") : null);
}
function scanFinishes(s) {
  const st = s.store || s.store_printing || s.printing || {};
  const f = jsonArr(s.finishes).length ? jsonArr(s.finishes) : jsonArr(st.finishes);
  const list = [...new Set(f.map(normFinish))].filter((x) => FINISH_LABEL[x]);
  return list.length ? list : ["nonfoil", "foil"];
}
/**
 * The finish was not read from the card: it came from the session's foil
 * setting on a printing that exists in more than one finish (shown as "finish?").
 */
const finishGuessed = (s) => Boolean(s) && (s.finish_source ?? s.finishSource) === "toggle" && scanFinishes(s).length > 1;
const candidatesOf = (result, scan) => {
  const r = jsonArr(result?.candidates);
  return (r.length ? r : jsonArr(scan?.candidates)).map(normPrinting).filter((p) => p && p.id);
};

// ---------------------------------------------------------------------------
// Feedback: scan sounds (scanlib createScanSounds, Web Audio unlocked on the
// "Start camera" tap) + vibration. Sound settings are per device in
// localStorage mtg.scan.sound {enabled, threshold}: a staged scan plays the
// success blip, or the cash sound when its EUR price is >= threshold.

const SOUND_DEFAULTS = { enabled: true, threshold: 5 };
function loadSoundSettings() {
  const s = store.get("mtg.scan.sound", null);
  // Before v0.5.0 the on/off switch lived in mtg.scan.settings.sound ("Beep on scan").
  const legacy = store.get("mtg.scan.settings", {})?.sound;
  const enabled = typeof s?.enabled === "boolean" ? s.enabled : legacy !== false;
  const t = Number(s?.threshold);
  return { enabled, threshold: Number.isFinite(t) && t >= 0 ? t : SOUND_DEFAULTS.threshold };
}
function vibrate(kind) {
  try { navigator.vibrate?.(kind === "auto" || kind === "increment" ? 40 : kind === "suggest" || kind === "duplicate" ? [30, 60, 30] : [120, 60, 120]); } catch { /* ignore */ }
}

// Record session (scanner tuning data): small frames + capture decision
// records go to POST /api/debug/frames. Off by default, auto-off after 15 min.
const RECORD_MAX_MS = 15 * 60 * 1000;
const RECORD_EVERY_MS = 500;
const RECORD_MAX_B64 = 300 * 1024;
function newRecordSession() {
  const d = new Date(), p = (n) => String(n).padStart(2, "0");
  const rnd = Math.random().toString(36).slice(2, 6).padEnd(4, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}-${rnd}`;
}
/**
 * Probe policy overrides for field tests (ProbeController cfg, e.g. {"stillMad":10}): localStorage
 * mtg.scan.capture (JSON object), then ?scancfg=<JSON> in the URL on top.
 * capture.js validates them and ignores unknown keys / wrong types.
 */
function readCaptureOverrides() {
  let over = {};
  const saved = store.get("mtg.scan.capture", null);
  if (saved && typeof saved === "object" && !Array.isArray(saved)) over = { ...saved };
  try {
    const q = new URLSearchParams(window.location.search).get("scancfg");
    const u = q ? JSON.parse(q) : null;
    if (u && typeof u === "object" && !Array.isArray(u)) over = { ...over, ...u };
  } catch { /* malformed ?scancfg */ }
  return over;
}
const fmtElapsed = (ms) => { const s = Math.max(0, Math.floor(ms / 1000)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`; };

/**
 * Recorded sessions on the server (GET/DELETE /api/debug/sessions), shown in
 * the scan settings so old recordings can be cleaned up from the phone.
 * `recording` = the session being recorded now (not deletable, list reloads when it stops).
 */
function RecordedSessions({ recording }) {
  const [list, setList] = useState(null);
  const [error, setError] = useState(null);
  const [ask, setAsk] = useState(null); // id awaiting the inline "Delete?" confirm
  const [busy, setBusy] = useState(null);
  const load = useCallback(() => {
    api("/api/debug/sessions").then((d) => { setList(d.sessions || []); setError(null); })
      .catch((e) => setError(`Could not load recorded sessions: ${e.message}`));
  }, []);
  useEffect(load, [load, recording]);
  const remove = async (id) => {
    setBusy(id); setError(null);
    try { await api(`/api/debug/sessions/${encodeURIComponent(id)}`, { method: "DELETE" }); setAsk(null); load(); }
    catch (e) { setError(`Delete failed: ${e.message}`); setAsk(null); load(); }
    finally { setBusy(null); }
  };
  return (
    <div className="field rec-sessions" style={{ gridColumn: "1 / -1" }}>
      <span className="small" style={{ fontWeight: 600 }}>Recorded sessions</span>
      {error && <span className="small" style={{ color: "var(--bad)" }} role="alert">{error}</span>}
      {!list && !error && <span className="small muted">Loading…</span>}
      {list && list.length === 0 && <span className="small muted">No recorded sessions.</span>}
      {list && list.length > 0 && (
        <ul className="rec-list">
          {list.map((s) => (
            <li key={s.id}>
              <span className="grow small">
                <b>{fmtDate(s.started_at)}</b>
                <span className="muted"> · {plural(s.frames, "frame")} · {(s.bytes / 1048576).toFixed(1)} MB</span>
                {s.id === recording && <span className="badge accent" style={{ marginLeft: 6 }}>recording</span>}
              </span>
              {ask === s.id ? (
                <span className="row small" style={{ gap: 4 }} role="group" aria-label="Confirm delete">
                  <span>Delete?</span>
                  <button type="button" className="btn sm danger" disabled={busy === s.id} onClick={() => remove(s.id)}>Yes</button>
                  <button type="button" className="btn sm" disabled={busy === s.id} onClick={() => setAsk(null)}>No</button>
                </span>
              ) : (
                <button type="button" className="btn sm ghost danger" style={{ paddingInline: 8 }} disabled={s.id === recording || Boolean(busy)}
                  onClick={() => setAsk(s.id)} aria-label={`Delete recorded session from ${fmtDate(s.started_at)}`} title="Delete"><Icon.trash /></button>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function cameraErrorMessage(e) {
  const n = e?.name;
  if (n === "NotAllowedError" || n === "SecurityError") return "Camera access was denied. Allow the camera for this site in your browser settings, then tap Start camera again.";
  if (n === "NotFoundError" || n === "OverconstrainedError") return "No usable camera was found on this device.";
  if (n === "NotReadableError" || n === "AbortError") return "The camera is busy (another app or tab may be using it). Close it and try again.";
  return e?.message || "Could not start the camera.";
}

/**
 * Record session status line: elapsed time and frame counters, re-rendered once a second on its
 * own (the counters live in a ref the camera loop updates), so recording never re-renders ScanTab.
 */
function RecordStatus({ rec, statsRef }) {
  const [, tick] = useReducer((x) => x + 1, 0);
  useEffect(() => {
    const t = setInterval(tick, 1000);
    return () => clearInterval(t);
  }, []);
  const st = statsRef.current && statsRef.current.session === rec.session ? statsRef.current : { frames: 0, errors: 0, full: null };
  return (
    <span className="small rec-status" role="status">
      <span>● Recording {fmtElapsed(Date.now() - rec.startedAt)}</span>
      <span>{plural(st.frames, "frame")}</span>
      {st.errors > 0 && <span className="muted">{st.errors} not sent</span>}
      {st.full && <span style={{ color: "var(--warn)" }}>{st.full}</span>}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Camera view: stream, analysis loop, overlay, probes and the shutter.

// Pill dot colour per ProbeController state.
const CAM_PHASE = { searching: "searching", tracking: "tracking", probing: "busy", waiting: "tracking", hold: "hold", unrecognised: "unrecognised", paused: "searching" };
const FOIL_CYCLE = { auto: "nonfoil", nonfoil: "foil", foil: "auto" };
const FOIL_SHORT = { auto: "Auto", nonfoil: "Non-foil", foil: "✦ Foil" };

// The camera box's aspect, fixed per viewport orientation: the first started stream's, then kept when the
// video's intrinsic size changes (a camera restart, a device-reported orientation flip: Android once came
// back as 1920x1080 landscape and the view shrank and the UI jumped). The video fills it (object-fit: cover)
// and the overlay maps video px with the same cover scale.
let camBoxLock = null; // {ratio, portrait}
const viewportPortrait = () => { try { return window.innerHeight >= window.innerWidth; } catch { return true; } };
function camBoxRatio(vw, vh) {
  const portrait = viewportPortrait();
  if (vw > 0 && vh > 0 && (!camBoxLock || camBoxLock.portrait !== portrait)) camBoxLock = { ratio: vw / vh, portrait };
  return camBoxLock && camBoxLock.portrait === portrait ? camBoxLock.ratio : 3 / 4;
}

/**
 * Keeps a render error in the camera view inside the camera box: the scan tab (its staged list, the
 * Record session) stays, the box says what happened and offers a restart (beta.1 field report: "it kind
 * of crashed and the recording was cancelled").
 */
class CameraBoundary extends React.Component {
  constructor(props) { super(props); this.state = { error: null, key: 0 }; }
  static getDerivedStateFromError(error) { return { error }; }
  componentDidCatch(error) { try { console.error("Camera view error", error); } catch { /* ignore */ } }
  render() {
    const { error, key } = this.state;
    if (!error) return <React.Fragment key={key}>{this.props.children}</React.Fragment>;
    return (
      <div className="cam" style={{ aspectRatio: `${camBoxRatio(0, 0)}`, width: `min(100%, calc(72dvh * ${camBoxRatio(0, 0).toFixed(4)}))` }}>
        <div className="cam-start">
          <p role="alert" style={{ color: "#ffb4a8" }}>The camera view stopped ({String(error?.message || error).slice(0, 120)}).{this.props.recording ? " Recording is paused." : ""}</p>
          <button type="button" className="btn primary" onClick={() => this.setState({ error: null, key: key + 1 })}><Icon.camera /> Restart camera view</button>
        </div>
      </div>
    );
  }
}

/**
 * Scanner camera, recognition-driven: detector A2 (scanlib
 * createDetAnalyzer) tracks the card; the ProbeController (probeRef, owned by
 * ScanTab) decides when the tracked crop goes to the server as a probe
 * (sendProbe → the server stages it only when identified and not the last
 * card). The shutter sends a normal scan (Claude allowed) through onManual.
 * No guide mask: the card may lie anywhere; a learned box prior is drawn
 * faintly. Also uploads the record-session frames while `record` is set,
 * each with a per-frame state record.
 */
function CameraView({ lib, probeRef, detRef, autoAskRef = null, active, settings, paused, busy, flash, queued, record, plusOne = true, sendProbe, onManual, onAutoAsk = null, onFoil, onRecorded, onError, onUnlock, onStart, overlay = null, valuePill = null, onPhoto = null, onSettings = null, photoBusy = null }) {
  const videoRef = useRef(null);
  const overlayRef = useRef(null);
  const streamRef = useRef(null);
  const trackRef = useRef(null);
  const cloneRef = useRef(null); // hidden <video> of the analysis clone (scanlib createDetAnalyzer cloneVideo)
  const obsRef = useRef(null);
  // false | "probe" (a probe crop: the analysis loop keeps running) | "shot" (shutter / auto-ask: the loop waits)
  const capturingRef = useRef(false);
  const pixelsRef = useRef(null); // scanlib createScanWorker client for the probe crops (null = inline)
  const perfRef = useRef(null); // scanperf PerfMonitor of the running camera (perf beacon)
  const pacerRef = useRef(null); // scanperf FramePacer of the running camera
  const recRef = useRef({ session: null, seq: 0, last: 0, busy: false, events: [], frames: 0, bytes: 0, errors: 0, full: null });
  const live = useRef({});
  live.current = { paused, busy, auto: settings.auto, photo: settings.photo, flash, record, queued, plusOne, sendProbe, onManual, onAutoAsk, onRecorded, onError };
  const [cam, setCam] = useState({ state: "off", error: null, vw: 0, vh: 0 });
  const [status, setStatus] = useState({ phase: "searching", hint: "", state: "searching" });
  const [torch, setTorchState] = useState({ supported: null, on: false });
  const [dbg, setDbg] = useState(null); // ?scandebug=1: detector timing + probe state
  const debugOn = useMemo(() => { try { return new URLSearchParams(window.location.search).get("scandebug") === "1"; } catch { return false; } }, []);
  // camera size + work-frame path, fixed per page load (scanlib cameraPlan: Android 1440p + the <video>
  // path, else 4K + auto; ?scanres=1080|1440|4k and ?scanframes= override); camInfoRef = what opened
  const plan = useMemo(() => {
    let qs = null;
    try { qs = new URLSearchParams(window.location.search); } catch { qs = null; }
    const android = typeof lib?.isAndroid === "function" ? lib.isAndroid() : false;
    return lib?.cameraPlan ? lib.cameraPlan({ android, res: qs?.get("scanres") ?? null, frames: qs?.get("scanframes") ?? null })
      : { android, res: "4k", width: 3840, height: 2160, why: "default", frames: "auto", frames_why: "default" };
  }, [lib]);
  const camInfoRef = useRef({ try: null });
  const genRef = useRef(0);
  const restartAtRef = useRef(0); // last automatic restart after the track ended
  const activeRef = useRef(active);
  activeRef.current = active;

  const stop = useCallback(() => {
    genRef.current++;
    if (lib) lib.stopStream(streamRef.current);
    else streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    trackRef.current = null;
    if (videoRef.current) videoRef.current.srcObject = null;
    setCam((c) => (c.state === "off" || c.state === "error" ? c : { ...c, state: "off" }));
    setTorchState((t) => ({ ...t, on: false }));
  }, [lib]);

  const start = async () => {
    if (!lib || cam.state === "starting") return;
    onUnlock?.();
    const gen = ++genRef.current;
    const stale = () => gen !== genRef.current || !activeRef.current || document.hidden;
    setCam({ state: "starting", error: null, vw: 0, vh: 0 });
    try {
      // the plan's size from the start; the stream's constraints are never changed mid-session (on the
      // Pixel 9 that restarted the camera as landscape 1080p and the view jumped)
      const info = { try: null };
      const stream = await lib.openCamera({ width: plan.width, height: plan.height, info });
      camInfoRef.current = info;
      if (stale()) {
        lib.stopStream(stream);
        if (gen === genRef.current) stop();
        return;
      }
      streamRef.current = stream;
      const track = stream.getVideoTracks()[0];
      trackRef.current = track;
      track?.addEventListener?.("ended", () => {
        // an old track's late event never stops the current stream
        if (trackRef.current !== track) return;
        stop();
        const now = Date.now();
        // one automatic restart per 30 s (a camera hiccup); the Record session goes on with the new stream
        if (activeRef.current && !document.hidden && now - restartAtRef.current > 30000) {
          restartAtRef.current = now;
          setCam({ state: "off", error: null, vw: 0, vh: 0 });
          setTimeout(() => { if (activeRef.current && !document.hidden) startRef.current?.().catch?.(() => {}); }, 300);
          live.current.onError?.(live.current.record?.session ? "The camera stopped; restarting it (the recording goes on)." : "The camera stopped; restarting it.");
          return;
        }
        setCam({ state: "error", error: "The camera stopped (another app may have taken it).", vw: 0, vh: 0 });
      });
      const v = videoRef.current;
      v.muted = true;
      v.setAttribute("playsinline", "");
      v.setAttribute("muted", "");
      v.srcObject = stream;
      await v.play().catch(() => {});
      if (!v.videoWidth) {
        await new Promise((res) => { v.addEventListener("loadedmetadata", res, { once: true }); setTimeout(res, 4000); });
      }
      if (stale()) { if (gen === genRef.current) stop(); return; }
      lib.preferContinuousFocus(track);
      setTorchState({ supported: lib.torchCapability(track), on: false });
      probeRef.current?.reset();
      autoAskRef?.current?.reset();
      onStart?.();
      setCam({ state: "on", error: null, vw: v.videoWidth, vh: v.videoHeight });
    } catch (e) {
      stop();
      setCam({ state: "error", error: cameraErrorMessage(e), vw: 0, vh: 0 });
    }
  };

  const startRef = useRef(null);
  startRef.current = start;
  useEffect(() => { if (!active) stop(); }, [active, stop]);
  useEffect(() => {
    const h = () => { if (document.hidden) stop(); };
    document.addEventListener("visibilitychange", h);
    return () => { document.removeEventListener("visibilitychange", h); stop(); };
  }, [stop]);

  // Record session: a probe answer / shutter event for the next recorded frame.
  const recEvent = (e) => {
    const S = recRef.current;
    if (!live.current.record?.session) return;
    S.events.push({ ...e, t: Date.now() });
    if (S.events.length > 30) S.events.shift();
  };

  // One probe: crop the tracked quad from the full-res video frame (never takePhoto: fast, and the
  // 4K video strip is enough for the ★/• read), POST it, hand the answer to the controller.
  const runProbe = useCallback(async (p, o) => {
    const v = videoRef.current, pc = probeRef.current;
    if (!lib || !v || !v.videoWidth || !pc) { pc?.failed(p.id); return; }
    const gen = genRef.current;
    let shot;
    capturingRef.current = "probe";
    try {
      // the warps, JPEGs and the glare map run in the scan worker when there is one
      shot = await lib.captureCard(v, trackRef.current, p.quad, { preferPhoto: false, pixels: pixelsRef.current, glare: true, crop: detRef.current?.crop });
    } catch {
      pc.failed(p.id);
      perfRef.current?.probe({ error: true });
      return;
    } finally {
      if (capturingRef.current === "probe") capturingRef.current = false;
    }
    const rec = {
      ...p.rec, det: "v2", shot: shot.kind, strip_w: shot.stripSize?.[0] ?? null, prior_learned: Boolean(o?.priorLearned),
      orient_conf: Number.isFinite(o?.orientConf) ? Math.round(o.orientConf * 1000) / 1000 : null,
    };
    // precise: an accepted, stable track (the server may take its faster clean-crop path)
    const precise = Boolean(o?.accepted && o?.stable);
    const t0 = Date.now();
    // the probe's quad geometry for the record session (video px, rounded)
    const geo = { corners: p.quad.map(([x, y]) => [Math.round(x), Math.round(y)]), drift: Number.isFinite(o?.drift) ? Math.round(o.drift * 1e4) / 1e4 : null, jitter: Number.isFinite(o?.jitter) ? Math.round(o.jitter * 1e4) / 1e4 : null };
    try {
      const pending = live.current.sendProbe({ shot, rec, precise, rescan: p.rescan ?? null });
      // glare of the probed card (the uploaded crop), measured while the request is in flight:
      // a failed answer with a reflection makes the controller show the reflection hint
      const glareP = shot.glare ? Promise.race([shot.glare, new Promise((r) => setTimeout(() => r(null), 1500))]).catch(() => null) : Promise.resolve(null);
      const res = await pending;
      perfRef.current?.probe({ rtt: Date.now() - t0, capture: shot.ms?.total, crop: shot.crop ? shot.ms?.crop : null, read: shot.crop ? null : shot.ms?.grab, job: shot.ms?.job });
      const glare = await glareP;
      const outcome = pc.answer(p.id, res, Date.now(), { glare });
      recEvent({ kind: "probe", id: p.id, outcome: res?.outcome ?? null, reason: res?.reason ?? null, ms: Date.now() - t0, status: res?.result?.status ?? null, store_printing_id: res?.result?.store_printing_id ?? null, finish: res?.result?.finish ?? null, scan_id: res?.scan?.id ?? null, ...geo, glare: glare ? { code: glare.code, fraction: glare.fraction, regions: glare.regions } : null });
      // A card staged from an accepted track teaches the box prior (savePrior adds it, then persists).
      if (outcome === "staged" && o?.accepted && gen === genRef.current) {
        try { detRef.current?.savePrior?.(p.quad); } catch { /* storage may be blocked */ }
      }
      // unidentified probes in a row from a box the prior-free detector disagrees with put the box to sleep
      if (gen === genRef.current) {
        try { detRef.current?.noteProbe?.(res?.outcome ?? null, p.quad, { prior: Boolean(o?.priorLearned) }); } catch { /* advisory */ }
      }
    } catch (e) {
      pc.failed(p.id);
      perfRef.current?.probe({ rtt: Date.now() - t0, error: true });
      recEvent({ kind: "probe", id: p.id, outcome: "error", status_code: e?.status ?? null, ms: Date.now() - t0, ...geo });
    }
  }, [lib, probeRef, detRef]);

  // Shutter: a normal scan (Claude allowed) of the tracked quad, else the learned box, else the centre.
  const manualShot = async () => {
    const v = videoRef.current, pc = probeRef.current;
    // a probe crop in flight never swallows the tap (its finally leaves "shot" alone)
    if (!lib || !v || !v.videoWidth || capturingRef.current === "shot") return;
    const o = obsRef.current || { vw: v.videoWidth, vh: v.videoHeight };
    let quad = o.found && o.corners ? o.corners : null, quadSource = "track";
    if (!quad && o.priorQuad) { quad = o.priorQuad; quadSource = "prior"; }
    if (!quad) { quad = lib.defaultCardQuad(v.videoWidth, v.videoHeight); quadSource = "default"; }
    capturingRef.current = "shot";
    try {
      const det = detRef.current;
      const opts = det?.captureOpts ? det.captureOpts() : { preferPhoto: true };
      const shot = await lib.captureCard(v, trackRef.current, quad, { ...opts, preferPhoto: opts.preferPhoto !== false && live.current.photo !== false, pixels: pixelsRef.current, crop: det?.crop });
      const rec = {
        kind: "manual", det: "v2", quad_source: quadSource, fallback: quadSource !== "track", allow_claude: true, shot: shot.kind,
        strip_w: shot.stripSize?.[0] ?? null, sharp: Number.isFinite(o.sharp) ? Math.round(o.sharp) : null, prior_learned: Boolean(o.priorLearned), t: Date.now(),
      };
      pc?.manual({ ...o, now: Date.now() });
      recEvent({ kind: "manual", quad_source: quadSource, shot: shot.kind });
      live.current.onManual(shot, rec, { precise: Boolean(quadSource === "track" && o.accepted && o.stable) });
    } catch (e) {
      live.current.onError?.(`Capture failed: ${e.message}`);
    } finally {
      capturingRef.current = false;
    }
  };

  // Auto-ask (beta.5, public/autoask.js): the still card that repeated probes could not recognise,
  // cropped from the video frame like a probe and sent ONCE as a normal scan with Claude allowed.
  const autoShot = async (o) => {
    const v = videoRef.current, pc = probeRef.current, aa = autoAskRef?.current;
    if (!lib || !v || !v.videoWidth || capturingRef.current === "shot" || !o?.found || !o.corners || !live.current.onAutoAsk) { aa?.cancel(); return; }
    capturingRef.current = "shot";
    // Hold the probe loop on this card right away: a probe started while the shot is taken could
    // stage the card next to the Claude scan.
    pc?.manual({ ...o, now: Date.now() });
    try {
      const shot = await lib.captureCard(v, trackRef.current, o.corners, { preferPhoto: false, pixels: pixelsRef.current, crop: detRef.current?.crop });
      const rec = {
        kind: "auto_claude", det: "v2", quad_source: o.accepted ? "track" : "weak", fallback: false, allow_claude: true, shot: shot.kind,
        strip_w: shot.stripSize?.[0] ?? null, sharp: Number.isFinite(o.sharp) ? Math.round(o.sharp) : null, prior_learned: Boolean(o.priorLearned), t: Date.now(),
      };
      recEvent({ kind: "auto_claude", shot: shot.kind });
      live.current.onAutoAsk(shot, rec, { precise: Boolean(o.accepted && o.stable) });
    } catch {
      aa?.cancel();
    } finally {
      capturingRef.current = false;
    }
  };

  // Record session: one small frame every RECORD_EVERY_MS with the frame's state record and the
  // probe/shutter events since the last one.
  const recordTick = (r, o) => {
    const R = live.current.record, S = recRef.current;
    if (!R?.session) { S.events.length = 0; return; }
    if (S.session !== R.session) Object.assign(S, { session: R.session, seq: 0, last: 0, events: [], frames: 0, bytes: 0, errors: 0, full: null });
    const now = performance.now();
    // a slow phone (frame gap above 250 ms) records every second instead; never while a crop is read
    const every = (pacerRef.current?.gap() ?? 0) > 250 ? RECORD_EVERY_MS * 2 : RECORD_EVERY_MS;
    if (S.busy || capturingRef.current || now - S.last < every) return;
    S.last = now;
    S.busy = true;
    const pc = probeRef.current;
    const n1 = (v) => (Number.isFinite(v) ? Math.round(v * 10) / 10 : null);
    const record = {
      type: "frame", t: Date.now(), state: r?.state ?? null, hint: r?.hint ?? null,
      found: Boolean(o?.found), weak: Boolean(o?.weak), accepted: Boolean(o?.accepted), stable: Boolean(o?.stable),
      cmad: n1(r?.cmad), still: Boolean(r?.still), sharp: n1(o?.sharp), hold: Boolean(r?.hold), mode: o?.mode ?? null,
      prior: Boolean(o?.priorLearned), prior_slept: o?.priorSlept ?? null, probe: pc?.last ? { outcome: pc.last.outcome, reason: pc.last.reason, ms: pc.last.ms } : null,
      events: S.events.splice(0),
    };
    const session = S.session, seq = S.seq++;
    // the analyzer's last 480 px work frame (what the detector saw), encoded off the main thread
    // (toBlob); a too-big q0.7 JPEG is re-encoded at q0.5 from a copy of the SAME frame
    const d = detRef.current;
    const sync = () => { const j = d?.frameJpeg?.(0.7); const k = j && j.length > RECORD_MAX_B64 ? d.frameJpeg(0.5) : j; return k && k.length > RECORD_MAX_B64 ? null : k || null; };
    (d?.frameJpegAsync ? d.frameJpegAsync(0.7, { fallback: 0.5, maxLen: RECORD_MAX_B64 }) : Promise.resolve().then(sync))
      .catch(() => null)
      .then((jpeg) => api("/api/debug/frames", { method: "POST", json: { session, seq, ...(jpeg ? { jpeg } : {}), record } })
        .then(() => { if (S.session === session && jpeg) { S.frames++; S.bytes += Math.floor((jpeg.length * 3) / 4); } }))
      .catch((e) => {
        if (S.session !== session) return;
        S.errors++;
        // 507 = all recordings together are full (nothing is pruned), 413 = this one is full.
        if (e?.status === 507 || e?.status === 413) S.full = e.message;
      })
      .finally(() => {
        S.busy = false;
        if (S.session === session) live.current.onRecorded?.({ session, frames: S.frames, bytes: S.bytes, errors: S.errors, full: S.full });
      });
  };

  // Analysis loop (8 fps at most, slower when the phone can't keep up) + overlay drawing + perf beacon.
  // Field-test knobs: ?scanworker=0 (no workers), ?scangrab=cpu|gpu|auto (main-thread work-frame canvas,
  // default auto), ?scanframes=auto|clone|main|track|bitmap (where the work frame comes from, default
  // auto: a small clone of the camera track on desktop Chrome, else the video; Android: main; track/
  // bitmap = the beta.2 worker paths, experiments only), ?scanres=1080|1440|4k (camera size; default
  // 1440 on Android, else 4k). Both via `plan` (scanlib cameraPlan).
  useEffect(() => {
    if (cam.state !== "on" || !lib) return;
    const v = videoRef.current;
    let qs = null;
    try { qs = new URLSearchParams(window.location.search); } catch { qs = null; }
    const useWorkers = qs?.get("scanworker") !== "0" && typeof lib.createScanWorker === "function";
    const grabMode = ["cpu", "gpu", "auto"].includes(qs?.get("scangrab")) ? qs.get("scangrab") : "auto";
    const detW = useWorkers ? lib.createScanWorker() : null;
    const pxW = useWorkers ? lib.createScanWorker() : null;
    let det = null;
    const frames = plan.frames;
    try { det = lib.createDetAnalyzer(v, { detectWorker: detW, pixels: pxW, grabMode, frames, track: trackRef.current, cloneVideo: cloneRef.current }); } catch (e) {
      detW?.close(); pxW?.close();
      live.current.onError?.(`Could not start the card detector: ${e.message}`);
      return;
    }
    detRef.current = det;
    pixelsRef.current = pxW;
    const pacer = lib.FramePacer ? new lib.FramePacer({ minGapMs: 1000 / (lib.CAPTURE_DEFAULTS?.fps || 8) }) : null;
    const perf = lib.PerfMonitor ? new lib.PerfMonitor() : null;
    pacerRef.current = pacer;
    perfRef.current = perf;
    const hasVfc = typeof v.requestVideoFrameCallback === "function";
    let alive = true, timer = null, fbTimer = null, vfcId = null, frameSeq = 0, analysedSeq = -1, waiting = false, last = 0, lastStart = 0, shown = { phase: "", hint: "", state: "" }, dims = [cam.vw, cam.vh];
    let seenLast = null, probeThumb = null, prevStill = false; // auto-ask: the probe answer (pc.last) seen, the last probe's card thumbnail
    const msHist = [];
    let dbgAt = 0;
    const pct = (a, q) => { const b = [...a].sort((x, y) => x - y); return b.length ? b[Math.min(b.length - 1, Math.floor(q * b.length))] : null; };

    const poly = (ctx, q) => { ctx.beginPath(); q.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y))); ctx.closePath(); ctx.stroke(); };
    const draw = (o, r) => {
      const c = overlayRef.current;
      if (!c) return;
      const cw = c.clientWidth, ch = c.clientHeight, dpr = Math.min(2, window.devicePixelRatio || 1);
      if (!cw || !ch) return;
      if (c.width !== Math.round(cw * dpr) || c.height !== Math.round(ch * dpr)) { c.width = Math.round(cw * dpr); c.height = Math.round(ch * dpr); }
      const ctx = c.getContext("2d");
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, cw, ch);
      const sc = Math.max(cw / o.vw, ch / o.vh), dx = (cw - o.vw * sc) / 2, dy = (ch - o.vh * sc) / 2;
      const map = ([x, y]) => [x * sc + dx, y * sc + dy];
      const fl = live.current.flash;
      const flashOn = fl && Date.now() < fl.until;
      // The learned box prior, faintly.
      if (o.priorLearned && o.priorQuad) {
        ctx.setLineDash([]);
        ctx.lineWidth = 2;
        ctx.strokeStyle = "rgba(255,255,255,.28)";
        poly(ctx, o.priorQuad.map(map));
      }
      const weakOnly = Boolean(o.weak && !o.accepted);
      if (o.corners && o.found) {
        ctx.lineWidth = flashOn ? 6 : 3;
        ctx.setLineDash(weakOnly && !flashOn ? [10, 8] : []);
        ctx.strokeStyle = flashOn ? fl.color
          : r.state === "hold" ? "#62d18d"
            : r.state === "probing" ? "#ffffff"
              : r.state === "unrecognised" ? "#ff8274"
                : weakOnly ? "#f5e050" : r.still ? "#62d18d" : "#a38bff";
        poly(ctx, o.corners.map(map));
      } else if (flashOn) {
        ctx.setLineDash([]);
        ctx.lineWidth = 6;
        ctx.strokeStyle = fl.color;
        ctx.strokeRect(3, 3, cw - 6, ch - 6);
      }
    };

    // Next analysis: pacer.gap() after the last start, and only on a video frame not analysed yet
    // (requestVideoFrameCallback counts presented frames where the browser has it; a due analysis
    // without a new frame waits for the next one, 200 ms at most). One analysis at a time (it awaits
    // the detect worker).
    const onFrame = () => {
      vfcId = null;
      if (!alive) return;
      frameSeq++;
      try { vfcId = v.requestVideoFrameCallback(onFrame); } catch { vfcId = null; }
      if (waiting) { waiting = false; clearTimeout(fbTimer); fbTimer = null; loop(); }
    };
    if (hasVfc) { try { vfcId = v.requestVideoFrameCallback(onFrame); } catch { vfcId = null; } }
    const clearWait = () => { clearTimeout(timer); clearTimeout(fbTimer); timer = fbTimer = null; waiting = false; };
    const next = () => {
      if (!alive) return;
      clearWait();
      const wait = Math.max(0, last + (pacer ? pacer.gap() : 125) - performance.now());
      timer = setTimeout(() => {
        timer = null;
        if (!alive) return;
        if (!hasVfc || vfcId === null || frameSeq !== analysedSeq) { loop(); return; }
        waiting = true;
        fbTimer = setTimeout(() => { fbTimer = null; if (waiting) { waiting = false; loop(); } }, 200);
      }, wait);
    };

    const loop = async () => {
      if (!alive) return;
      const now = performance.now();
      if (v.readyState >= 2 && capturingRef.current !== "shot") {
        last = now;
        analysedSeq = frameSeq;
        if (lastStart) perf?.interval(now - lastStart);
        lastStart = now;
        let o = null;
        try { o = await det.analyzeAsync(now); } catch { o = null; }
        if (!alive) return;
        // a shutter / auto-ask shot started while the detect worker had the frame: no probe from it
        if (capturingRef.current === "shot") { next(); return; }
        const tPost = performance.now();
        const pc = probeRef.current;
        if (o && pc) {
          if (o.vw !== dims[0] || o.vh !== dims[1]) { dims = [o.vw, o.vh]; setCam((c) => ({ ...c, vw: o.vw, vh: o.vh })); }
          obsRef.current = o;
          const L = live.current;
          let r = null;
          const t0 = performance.now();
          // Auto-ask (public/autoask.js) first learns the latest probe answer; a card due for an ask
          // starts no new probe (busy), so the ask never races a probe of the same card.
          const aa = autoAskRef?.current;
          let wants = false;
          if (aa) {
            try {
              if (pc.last && pc.last !== seenLast) { seenLast = pc.last; aa.answer(pc.last.outcome, probeThumb, Date.now()); }
              // still: the previous frame's (the probe loop decides it in step()); blocked as for aa.step
              wants = Boolean(L.auto && !L.paused && aa.wants({ found: o.found, cardThumb: o.cardThumb, still: prevStill, sharp: o.sharp, now: Date.now(),
                blocked: Boolean(L.busy || L.queued > 0 || capturingRef.current) }));
            } catch { wants = false; }
          }
          try { r = pc.step({ ...o, now: Date.now(), paused: L.paused || !L.auto, busy: L.busy || wants, plusOne: L.plusOne }); } catch { r = null; }
          prevStill = r ? r.still : false;
          if (debugOn) {
            msHist.push([o.ms, performance.now() - t0, o.timing?.main ?? o.ms]);
            if (msHist.length > 60) msHist.shift();
            window.__scanDebug = { o: { ...o, thumb: undefined, cardThumb: undefined }, r: r && { ...r, probe: r.probe && { id: r.probe.id } }, stats: pc.stats };
            if (Date.now() - dbgAt > 500) {
              dbgAt = Date.now();
              setDbg({ a50: pct(msHist.map((x) => x[0]), 0.5), a90: pct(msHist.map((x) => x[0]), 0.9), m50: pct(msHist.map((x) => x[2]), 0.5), gap: pacer?.gap(), wk: Boolean(detW?.available()), gm: `${det.grabInfo?.().path ?? "?"}/${det.grabInfo?.().mode ?? det.grabInfo?.().wmode ?? "?"}`, st: r?.state, f: o.found, w: o.weak, a: o.accepted, s: o.stable, cmad: r?.cmad, sharp: o.sharp, mode: o.mode, prior: o.priorLearned, sent: pc.stats.sent, last: pc.last?.outcome, lms: pc.last?.ms });
            }
          }
          if (r) {
            draw(o, r);
            // Auto-ask Claude (public/autoask.js): fed every probe answer (pc.last changes, with the
            // probed frame's card thumbnail) and every frame. Never while a probe is in flight (its
            // answer may still stage the card) or a shot is being taken, nor on a frame that starts one.
            let ask = null;
            if (aa) {
              try {
                ask = aa.step({ found: o.found, cardThumb: o.cardThumb, still: r.still, sharp: o.sharp, now: Date.now(),
                  blocked: Boolean(L.paused || !L.auto || L.busy || L.queued > 0 || r.probe || pc.flight || capturingRef.current || r.state === "hold") });
              } catch { ask = null; }
              if (r.probe) probeThumb = o.cardThumb || null;
            }
            let hint = r.hint, phase = CAM_PHASE[r.state] || "searching";
            if (o.weak && !o.accepted && phase === "tracking") phase = "weak";
            const workW = o.corners && o.found ? lib.quadSize(o.corners).w * (480 / Math.min(o.vw, o.vh)) : null;
            const looking = ["tracking", "waiting", "searching"].includes(r.state);
            if (L.paused) hint = "Paused";
            else if (!L.auto) hint = o.found ? "Card found: tap the shutter" : "Place a card in view";
            else if (o.glare?.advice && looking && o.found) hint = o.glare.advice;
            else if (workW !== null && workW < 100 && looking) hint = "Move closer";
            else if (ask?.hint && r.state === "unrecognised") hint = ask.hint;
            if (L.queued > 1) hint = `${hint} · ${L.queued - 1} waiting`;
            if (hint !== shown.hint || phase !== shown.phase || r.state !== shown.state) { shown = { hint, phase, state: r.state }; setStatus(shown); }
            recordTick(r, o);
            if (r.probe) runProbe(r.probe, o);
            else if (ask?.ask) autoShot(o);
          } else recordTick(null, o);
        }
        if (o?.timing) {
          // main-thread time of this frame: the analyzer's part plus the controller, overlay and React updates
          const main = o.timing.main + (performance.now() - tPost);
          pacer?.note(main);
          perf?.frame({ total: o.ms, main, grab: o.timing.grab, detect: o.timing.detect, sharp: o.timing.sharp, wgrab: o.timing.wgrab });
        }
      } else last = now;
      next();
    };
    loop();

    // Perf beacon: every 5 s while the camera runs AND a Record session runs or ?scandebug=1 is set
    // (POST /api/debug/perf, lib/debugperf.js; opt-in diagnostics, docs/scanner.md).
    const beaconId = `p${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    let longObs = null, rafId = null, rafLast = 0, vq0 = null;
    try {
      longObs = new PerformanceObserver((list) => { for (const e of list.getEntries()) perf?.longTask(e.duration); });
      longObs.observe({ type: "longtask", buffered: false });
    } catch { longObs = null; }
    const rafTick = (t) => {
      if (!alive) return;
      if (rafLast) perf?.raf(t - rafLast);
      rafLast = t;
      rafId = requestAnimationFrame(rafTick);
    };
    rafId = requestAnimationFrame(rafTick);
    const playback = () => { try { const q = v.getVideoPlaybackQuality?.(); return q ? { dropped: q.droppedVideoFrames, total: q.totalVideoFrames } : null; } catch { return null; } };
    vq0 = playback();
    const beacon = setInterval(() => {
      if (!alive || !perf || document.hidden || !(debugOn || live.current.record?.session)) return;
      let st = {};
      try { st = trackRef.current?.getSettings?.() || {}; } catch { st = {}; }
      const vq = playback();
      const nav = navigator;
      const body = perf.snapshot(Date.now(), {
        session: beaconId, ua: nav.userAgent, platform: nav.userAgentData?.platform || nav.platform || null,
        dpr: window.devicePixelRatio || 1, cores: nav.hardwareConcurrency ?? null, memory: nav.deviceMemory ?? null,
        video: { w: st.width ?? null, h: st.height ?? null, fps: st.frameRate ?? null, vw: v.videoWidth, vh: v.videoHeight, resize: st.resizeMode ?? null },
        worker: Boolean(detW?.available()), detect_worker: detW ? detW.state : "none", pixel_worker: pxW ? pxW.state : "none",
        encoder: Boolean(pxW?.available() && pxW.encoder), grab_mode: det.grabInfo ? det.grabInfo() : null, gap: pacer ? pacer.gap() : null,
        frame_path: det.path ?? null,
        // requested vs delivered camera size + the platform decision (try 0 = the requested constraints opened it)
        res: { pref: plan.res, why: plan.why, android: plan.android, frames: plan.frames, frames_why: plan.frames_why,
          ask_w: plan.width, ask_h: plan.height, try: camInfoRef.current?.try ?? null, got_w: st.width ?? null, got_h: st.height ?? null },
        dropped_frames: vq && vq0 ? vq.dropped - vq0.dropped : null, decoded_frames: vq && vq0 ? vq.total - vq0.total : null,
        record: Boolean(live.current.record?.session), visible: !document.hidden,
      });
      vq0 = vq;
      api("/api/debug/perf", { method: "POST", json: body }).catch(() => {});
    }, 5000);

    return () => {
      alive = false;
      clearWait();
      if (vfcId !== null) { try { v.cancelVideoFrameCallback?.(vfcId); } catch { /* ignore */ } vfcId = null; }
      clearInterval(beacon);
      if (rafId !== null) cancelAnimationFrame(rafId);
      try { longObs?.disconnect(); } catch { /* ignore */ }
      try { det.close?.(); } catch { /* ignore */ }
      detW?.close(); pxW?.close();
      if (pixelsRef.current === pxW) pixelsRef.current = null;
      if (perfRef.current === perf) perfRef.current = null;
      if (pacerRef.current === pacer) pacerRef.current = null;
      if (detRef.current === det) detRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cam.state, lib, runProbe]);

  const toggleTorch = async () => {
    const next = !torch.on;
    try {
      await lib.setTorch(trackRef.current, next);
      setTorchState((t) => ({ ...t, on: next, supported: true }));
    } catch {
      setTorchState({ supported: false, on: false });
      onError?.("The torch is not available on this camera.");
    }
  };

  const on = cam.state === "on";
  const ratio = camBoxRatio(cam.state === "on" ? cam.vw : 0, cam.state === "on" ? cam.vh : 0);
  const style = { aspectRatio: `${ratio}`, width: `min(100%, calc(72dvh * ${ratio.toFixed(4)}))` };
  const support = lib ? lib.cameraSupport() : null;
  const foil = settings.foil || "auto";
  const tapToCapture = status.state === "unrecognised" && !paused;

  return (
    <div className="cam" style={style}>
      <video ref={videoRef} playsInline muted autoPlay aria-label="Camera preview" />
      <video ref={cloneRef} className="cam-analysis" playsInline muted aria-hidden="true" tabIndex={-1} />
      <canvas ref={overlayRef} aria-hidden="true" hidden={!on} />
      {!on && (
        <div className="cam-start">
          {cam.state === "starting" ? <Spinner label="Starting camera…" /> : (
            <>
              {cam.error && <p role="alert" style={{ color: "#ffb4a8" }}>{cam.error}</p>}
              {record?.session && <p role="status">Recording is paused until the camera runs again.</p>}
              {support && !support.secure && <p role="alert" style={{ color: "#ffb4a8" }}>The camera only works over HTTPS.</p>}
              <div className="cam-start-actions">
                {onPhoto && <button type="button" className="cam-btn" aria-label="Scan from photos" title="Scan from photos" disabled={!lib || Boolean(photoBusy)} onClick={onPhoto}><Icon.image /></button>}
                <button type="button" className="btn primary" onClick={start} disabled={!lib}><Icon.camera /> {cam.error ? "Try again" : "Start camera"}</button>
                {onSettings && <button type="button" className="cam-btn" aria-label="Scan settings" title="Scan settings" onClick={onSettings}><Icon.gear /></button>}
              </div>
              <p>Lay a card in view and hold it still for a moment – it's added once it's recognised.</p>
            </>
          )}
        </div>
      )}
      {on && (
        <>
          <div className="cam-hud top">
            <span className="pills">
              {tapToCapture ? (
                <button type="button" className={`pill s-${status.phase}`} onClick={manualShot} aria-live="polite"><span className="dot" aria-hidden="true" />{status.hint}</button>
              ) : (
                <span className={`pill s-${status.phase}`} role="status" aria-live="polite"><span className="dot" aria-hidden="true" />{status.hint || "Ready"}</span>
              )}
              {record?.session && <span className="pill s-rec"><span className="dot" aria-hidden="true" />REC</span>}
              {settings?.calibration && <span className="pill" title="Calibration mode is on (Scan settings)">CAL</span>}
              {debugOn && dbg && (
                <span className="pill" style={{ whiteSpace: "normal", fontWeight: 500, fontSize: ".72rem" }}>
                  A2 {dbg.a50?.toFixed(0)}/{dbg.a90?.toFixed(0)} ms (main {dbg.m50?.toFixed(0)}, gap {dbg.gap}, {dbg.wk ? "worker" : "inline"}, {dbg.gm}) · {dbg.st} · {dbg.f ? "F" : "-"}{dbg.w ? "W" : "-"}{dbg.a ? "A" : "-"}{dbg.s ? "S" : "-"} · cmad {dbg.cmad?.toFixed(1) ?? "-"} · sharp {Math.round(dbg.sharp ?? 0)} · {dbg.mode}{dbg.prior ? " prior" : ""} · probes {dbg.sent} · {dbg.last || "-"}{dbg.lms != null ? ` ${dbg.lms} ms` : ""}
                </span>
              )}
            </span>
            <div className="cam-hud-right">
              {valuePill}
              {torch.supported !== false && (
                <button type="button" className="cam-btn" aria-pressed={torch.on} aria-label={torch.on ? "Turn torch off" : "Turn torch on"} onClick={toggleTorch}><Icon.bolt /></button>
              )}
            </div>
          </div>
          {overlay && <div className="cam-overlay">{overlay}</div>}
          <div className="cam-hud bottom">
            <button type="button" className="cam-btn" aria-label="Stop camera" onClick={stop}><Icon.close /></button>
            {onPhoto && <button type="button" className="cam-btn" aria-label="Scan from photos" title="Scan from photos" disabled={Boolean(photoBusy)} onClick={onPhoto}><Icon.image /></button>}
            <button type="button" className="shutter" aria-label="Take scan now" disabled={paused} onClick={manualShot} />
            <button type="button" className={`cam-btn finish ${foil}`} onClick={() => onFoil?.(FOIL_CYCLE[foil] || "auto")}
              aria-label={`Finish: ${FOIL_SHORT[foil] || foil}. Tap to change`} title="Finish when the card doesn't show it (foil pile: ✦ Foil)">{FOIL_SHORT[foil] || foil}</button>
            {onSettings && <button type="button" className="cam-btn" aria-label="Scan settings" title="Scan settings" onClick={onSettings}><Icon.gear /></button>}
          </div>
        </>
      )}
    </div>
  );
}
