"use strict";

// ===========================================================================
// Shared UI pieces
// ===========================================================================

function Spinner({ label = "Loading…", large }) {
  return (
    <div className="loading" role="status" aria-live="polite">
      <span className={`spinner${large ? " lg" : ""}`} aria-hidden="true" />
      <span>{label}</span>
    </div>
  );
}

function ErrorNotice({ error, onRetry, onDismiss }) {
  if (!error) return null;
  const message = typeof error === "string" ? error : error.message;
  return (
    <div className="notice error" role="alert">
      <span aria-hidden="true">⚠️</span>
      <div className="grow">{message}</div>
      {onRetry && <button type="button" className="btn ghost sm" onClick={onRetry}>Retry</button>}
      {onDismiss && <button type="button" className="btn ghost icon sm" aria-label="Dismiss" onClick={onDismiss}><Icon.close /></button>}
    </div>
  );
}

/**
 * −/+ stepper (a group named `label`; + stops at `max`). `big`: a sheet form row with the label shown and
 * 44 px buttons; else only the buttons (list rows, menus).
 */
function Stepper({ label, value, min = 1, max = Infinity, disabled = false, onChange, big = false }) {
  const size = big ? { width: 44, height: 44 } : undefined;
  const group = (
    <div className="stepper" role="group" aria-label={label}>
      <button type="button" aria-label="One less" disabled={disabled || value <= min} onClick={() => onChange(value - 1)} style={size}><Icon.minus /></button>
      <output aria-live="polite">{value}</output>
      <button type="button" aria-label="One more" disabled={disabled || value >= max} onClick={() => onChange(value + 1)} style={size}><Icon.plus /></button>
    </div>
  );
  return big ? <div className="row between"><span className="label">{label}</span>{group}</div> : group;
}

const SOURCE_BADGE ={ manabox: "warn", claude: "accent", manual: "", scan: "ok", app: "accent" };
function SourceBadge({ source }) {
  return <span className={`badge ${SOURCE_BADGE[source] ?? ""}`}>{source === "claude" ? "✦ claude" : source}</span>;
}

/** Small "IT" / "DE" tag for a copy printed in another language than English (names stay English). */
function LangTag({ lang, title }) {
  const l = String(lang || "").toLowerCase();
  if (!l || l === "en") return null;
  return <span className="lang-tag" title={title || `Printed in ${LANG_NAME[l] || l.toUpperCase()}`}>{l.toUpperCase()}</span>;
}
/** Distinct non-English languages of a GET /api/collection row (`languages`, "en,it"). */
const rowLangs = (r) => {
  const v = r?.languages ?? "";
  return [...new Set((Array.isArray(v) ? v : String(v).split(",")).map((x) => String(x).trim().toLowerCase()).filter((x) => x && x !== "en"))];
};

/**
 * Toast for collection edits/deletes with Undo (POST /api/collection/edits/:id/undo).
 * show({text, editId?}); onUndone runs after a successful undo. `portal` renders it on
 * document.body above open sheets.
 */
function useEditToast(onUndone, { portal = false } = {}) {
  const [t, setT] = useState(null); // {text, editId, ms}
  const cb = useRef(onUndone);
  cb.current = onUndone;
  useEffect(() => {
    if (!t) return;
    const h = setTimeout(() => setT(null), t.ms || (t.editId ? 10000 : 4000));
    return () => clearTimeout(h);
  }, [t]);
  const undo = async () => {
    const id = t?.editId;
    if (id == null) return;
    setT({ text: "Undoing…", ms: 30000 });
    try {
      await api(`/api/collection/edits/${encodeURIComponent(id)}/undo`, { method: "POST" });
      setT({ text: "Undone" });
      cb.current?.();
    } catch (e) {
      setT({ text: e.data?.code === "conflict" ? "Can't undo: these copies changed since." : `Undo failed: ${e.message}`, ms: 6000 });
    }
  };
  const el = t ? (
    <div className={`toast${portal ? " over" : ""}`} role="status" aria-live="polite">
      <span>{t.text}</span>
      {t.editId != null && <button type="button" className="btn ghost sm" onClick={undo}><Icon.undo /> Undo</button>}
      <button type="button" className="btn ghost icon sm" aria-label="Dismiss" onClick={() => setT(null)} style={{ textDecoration: "none" }}><Icon.close /></button>
    </div>
  ) : null;
  return [setT, portal && el ? ReactDOM.createPortal(el, document.body) : el];
}

/** Elements a focus trap cycles through (Sheet, the planner's chat drawer); disabled controls can't take focus. */
const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * Modal sheet: bottom sheet on phones, centered dialog on desktop.
 * Handles Escape, focus trap, focus restore and background scroll lock.
 */
function Sheet({ title, onClose, children, actions, pinned }) {
  const ref = useRef(null);
  const titleId = `sheet${useId()}`;
  // The key handler is registered once: it calls the latest onClose (a guarded close, e.g. "not while busy").
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    const prevFocus = document.activeElement;
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    ref.current?.focus();
    const onKey = (e) => {
      if (e.key === "Escape") {
        // Sheets stack (the card sheet opens above the build list): only the top one closes.
        const overlays = document.querySelectorAll(".overlay");
        if (ref.current && overlays[overlays.length - 1] !== ref.current.parentElement) return;
        e.stopPropagation(); closeRef.current();
      }
      if (e.key === "Tab" && ref.current) {
        const f = ref.current.querySelectorAll(FOCUSABLE);
        if (!f.length) return;
        const first = f[0], last = f[f.length - 1];
        if (e.shiftKey && (document.activeElement === first || document.activeElement === ref.current)) { e.preventDefault(); last.focus(); }
        else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
      }
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = prevOverflow;
      if (prevFocus && prevFocus.focus) prevFocus.focus({ preventScroll: true });
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return (
    <div className="overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="sheet" role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1} ref={ref}>
        <div className={`sheet-head${pinned ? " has-pin" : ""}`}>
          <h2 id={titleId}>{title}</h2>
          {actions}
          <button type="button" className="btn ghost icon" aria-label="Close" onClick={onClose}><Icon.close /></button>
          {pinned && <div className="sheet-pin">{pinned}</div>}
        </div>
        {children}
      </div>
    </div>
  );
}

/** Copy text: the async clipboard API (secure contexts), else a hidden textarea + execCommand. */
async function copyText(text) {
  try {
    if (navigator.clipboard?.writeText) { await navigator.clipboard.writeText(text); return true; }
  } catch { /* fall through */ }
  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.setAttribute("readonly", "");
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand("copy");
    ta.remove();
    return ok;
  } catch { return false; }
}

/** Link to a view of this server (same host the user opened, e.g. #decks/6 or #collection/binder/Trade). */
const shareUrl = (hash) => `${location.origin}${location.pathname}${hash}`;

/**
 * Share a deep link to a deck or binder with someone on the same network: the share
 * sheet on phones (navigator.share), else the link goes to the clipboard ("Link copied").
 */
function ShareButton({ title, hash }) {
  const [toast, toastEl] = useEditToast(null);
  const run = async () => {
    const url = shareUrl(hash);
    if (typeof navigator.share === "function") {
      try { await navigator.share({ title, url }); return; } catch (e) { if (e?.name === "AbortError") return; }
    }
    if (await copyText(url)) toast({ text: "Link copied" });
    else window.prompt("Copy this link:", url);
  };
  return (
    <>
      <button type="button" className="btn ghost icon share-btn" aria-label={`Share a link to ${title}`} title="Share link" onClick={run}><Icon.share /></button>
      {toastEl}
    </>
  );
}
