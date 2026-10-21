"use strict";

// ===========================================================================
// Planner (chat) tab
// ===========================================================================

const SUGGESTIONS = [
  "Build a Commander deck from cards I own around my best legendary creature",
  "Which of my cards are worth more than €10?",
  "Suggest 10 upgrades under €2 for my deck …",
  "Find me all blue counterspells I own",
  "Build a deck only from free cards, without breaking my built decks",
];

function toolIcon(name = "") {
  if (/search|find|check_owned|alternatives|staples|synerg/.test(name)) return "🔍";
  if (/deck|mana_base|brawl/.test(name)) return "🃏";
  if (/price/.test(name)) return "💶";
  if (/rules/.test(name)) return "📖";
  if (/overview|get_card|batch|random|sets/.test(name)) return "📋";
  return "🔧";
}
function ToolChip({ tool }) {
  const label = `${tool.name}${tool.input ? `: ${tool.input}` : ""}`;
  return (
    <span className="tool-chip" title={label}>
      <span aria-hidden="true">{toolIcon(tool.name)}</span>
      <span><b>{tool.name}</b>{tool.input ? `: ${tool.input}` : ""}</span>
    </span>
  );
}

function Message({ msg }) {
  if (msg.role === "user") {
    return <div className="msg user"><div className="bubble">{msg.content}</div></div>;
  }
  const tools = msg.tools || [];
  return (
    <div className="msg assistant">
      {tools.length > 0 && (
        <details className="disclosure">
          <summary>Used {plural(tools.length, "tool")}</summary>
          <div className="tools" style={{ marginTop: 6 }}>{tools.map((t, i) => <ToolChip key={i} tool={t} />)}</div>
        </details>
      )}
      <div className="bubble"><Markdown text={msg.content || "_(no answer)_"} /></div>
      <div className="meta">
        {msg.created_at && <span>{fmtDate(msg.created_at)}</span>}
      </div>
    </div>
  );
}

function SetupHint() {
  return (
    <div className="notice warn" role="alert">
      <span aria-hidden="true">🔑</span>
      <div className="grow">
        <b>Claude is not configured on the server.</b> On a machine with Claude Code, run <code>claude setup-token</code>,
        put the token into the app's <code>.env</code> as <code>CLAUDE_CODE_OAUTH_TOKEN=…</code>, then recreate the container.
      </div>
    </div>
  );
}

/** Height of what the user actually sees (excludes an on-screen keyboard). */
/**
 * Pixels of the chat below what the user can read: the end of the conversation
 * minus the top of the fixed composer (phones, also while the keyboard lifts it),
 * else the plain document gap (desktop). <= 0 means the newest line is visible.
 */
function chatGap(endEl, composerEl) {
  if (endEl && composerEl && getComputedStyle(composerEl).position === "fixed") {
    return endEl.getBoundingClientRect().bottom - composerEl.getBoundingClientRect().top;
  }
  const el = document.documentElement;
  return el.scrollHeight - (window.scrollY + window.innerHeight);
}

/**
 * Pixels the on-screen keyboard covers at the bottom of the layout viewport
 * (iOS Safari and Chrome on Android resize only the visual viewport), 0 when
 * it is closed. Used to keep the composer right above the keyboard.
 */
function useKeyboardInset(active) {
  const [kb, setKb] = useState(0);
  useEffect(() => {
    const vv = window.visualViewport;
    if (!active || !vv) { setKb(0); return; }
    const update = () => {
      const covered = Math.max(0, Math.round(window.innerHeight - vv.height - vv.offsetTop));
      setKb(covered > 80 ? covered : 0);
    };
    update();
    vv.addEventListener("resize", update);
    vv.addEventListener("scroll", update);
    return () => { vv.removeEventListener("resize", update); vv.removeEventListener("scroll", update); };
  }, [active]);
  return kb;
}

function PlannerTab({ active, health, request, onRequestHandled, onChanged }) {
  const [chats, setChats] = useState(null);
  const [chatsError, setChatsError] = useState(null);
  const [chatId, setChatId] = useState(() => store.get("mtg.chat", null));
  const chatIdRef = useRef(chatId);
  const [messages, setMessages] = useState([]);
  const [chatLoading, setChatLoading] = useState(false);
  const [serverBusy, setServerBusy] = useState(false);
  const [stream, setStream] = useState(null); // {text, tools} while this tab streams an answer
  const streamCtl = useRef(null);
  const sending = useRef(false); // set synchronously: blocks a double submit while the chat is created
  const [error, setError] = useState(null); // {message, status}
  const [input, setInput] = useState("");
  const [drawer, setDrawer] = useState(false);
  const drawerRef = useRef(null);
  const inputRef = useRef(null);
  const atBottom = useRef(true);

  const loadChats = useCallback(async () => {
    try {
      setChats(await api("/api/chats"));
      setChatsError(null);
    } catch (e) {
      setChatsError(`Could not load chats: ${e.message}`);
    }
  }, []);

  // Plain functions on purpose: they only touch refs and state setters.
  async function loadChat(id, { quiet = false } = {}) {
    if (!quiet) setChatLoading(true);
    try {
      const d = await api(`/api/chats/${id}`);
      if (chatIdRef.current !== id) return;
      setMessages(d.messages);
      setServerBusy(d.busy);
    } catch (e) {
      if (chatIdRef.current !== id) return;
      if (e.status === 404) selectChat(null);
      else setError({ message: `Could not load the chat: ${e.message}` });
    } finally {
      if (!quiet && chatIdRef.current === id) setChatLoading(false);
    }
  }

  function selectChat(id, { load = true } = {}) {
    // Leaving a streaming chat only detaches this browser: the server keeps
    // running the turn and stores the answer.
    if (streamCtl.current) { streamCtl.current.abort(); streamCtl.current = null; }
    chatIdRef.current = id;
    setChatId(id);
    store.set("mtg.chat", id);
    setMessages([]);
    setStream(null);
    setServerBusy(false);
    setError(null);
    setChatLoading(false);
    setDrawer(false);
    atBottom.current = true;
    if (id && load) loadChat(id);
  }

  useEffect(() => {
    loadChats();
    if (chatIdRef.current) loadChat(chatIdRef.current);
    return () => streamCtl.current?.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Another tab/device (or a detached stream) is still answering: poll.
  useEffect(() => {
    if (!serverBusy || stream || !chatId) return;
    const t = setInterval(() => loadChat(chatId, { quiet: true }), 3000);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [serverBusy, stream, chatId]);
  // ...and refresh the list once it finishes (title/updated_at). The turn may
  // have saved a deck (save_deck), so the Decks tab refetches too.
  const wasBusy = useRef(false);
  useEffect(() => {
    if (wasBusy.current && !serverBusy) { loadChats(); onChanged?.(); }
    wasBusy.current = serverBusy;
  }, [serverBusy, loadChats, onChanged]);

  async function send(textArg, targetId) {
    const fromInput = textArg == null;
    const text = (fromInput ? input : textArg).trim();
    // An explicit target chat (deck prompt) was just created, so a stale busy flag doesn't apply.
    if (!text || sending.current || streamCtl.current || (serverBusy && targetId == null)) return;
    sending.current = true;
    try {
      await sendTurn(text, fromInput, targetId);
    } finally {
      sending.current = false;
    }
  }

  async function sendTurn(text, fromInput, targetId) {
    setError(null);
    let id = targetId ?? chatIdRef.current;
    if (!id) {
      try {
        const chat = await api("/api/chats", { method: "POST", json: {} });
        setChats((cs) => [chat, ...(cs || [])]);
        id = chat.id;
        selectChat(id, { load: false });
      } catch (e) {
        setError({ message: `Could not create a chat: ${e.message}` });
        return;
      }
    }
    const ctl = new AbortController();
    streamCtl.current = ctl;
    const tmpId = `tmp-${Date.now()}`;
    setMessages((m) => [...m, { id: tmpId, role: "user", content: text, tools: [], created_at: null }]);
    setStream({ text: "", tools: [] });
    if (fromInput) setInput("");
    atBottom.current = true;

    const undo = (message, status) => {
      if (streamCtl.current === ctl) streamCtl.current = null;
      if (chatIdRef.current !== id) return;
      setStream(null);
      setMessages((m) => m.filter((x) => x.id !== tmpId));
      setInput((cur) => cur || text); // keep the prompt so it can be re-sent
      setError({ message, status });
    };

    let res;
    try {
      res = await fetch(`/api/chats/${id}/messages`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text }), signal: ctl.signal,
      });
    } catch (e) {
      if (!ctl.signal.aborted) undo(`Network error: ${e.message}`);
      return;
    }
    if (!res.ok) {
      let message = `Request failed: HTTP ${res.status}`;
      try { const d = await res.json(); if (d?.error) message = d.error; } catch { /* not JSON */ }
      undo(message, res.status);
      if (res.status === 409) loadChat(id, { quiet: true }); // shows the running answer as busy
      return;
    }

    try {
      for await (const ev of readSse(res.body)) {
        if (chatIdRef.current !== id || ctl.signal.aborted) break;
        if (ev.type === "text") setStream((s) => s && { ...s, text: s.text + ev.text });
        else if (ev.type === "tool") setStream((s) => s && { ...s, tools: [...s.tools, { name: ev.name, input: ev.input }] });
        else if (ev.type === "done") { setMessages((m) => [...m, ev.message]); setStream(null); onChanged?.(); }
        else if (ev.type === "error") setError({ message: ev.error });
      }
    } catch (e) {
      if (!ctl.signal.aborted && chatIdRef.current === id) setError({ message: `Connection lost: ${e.message}. The answer may still arrive — reopen the chat in a moment.` });
    }
    if (streamCtl.current === ctl) streamCtl.current = null;
    if (chatIdRef.current === id) {
      setStream(null);
      loadChat(id, { quiet: true }); // sync stored ids, stored error text, busy flag
    }
    loadChats();
  }

  // "Ask the planner about this deck": start a fresh chat and send the prompt.
  useEffect(() => {
    if (!request) return;
    onRequestHandled();
    (async () => {
      if (streamCtl.current) { setError({ message: "Wait for the current answer to finish first." }); setInput(request.prompt); return; }
      try {
        const chat = await api("/api/chats", { method: "POST", json: { title: request.title } });
        setChats((cs) => [chat, ...(cs || [])]);
        selectChat(chat.id, { load: false });
        send(request.prompt, chat.id);
      } catch (e) {
        setError({ message: `Could not create a chat: ${e.message}` });
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [request]);

  async function deleteChat(id) {
    const chat = chats?.find((c) => c.id === id);
    if (!window.confirm(`Delete the chat "${chat?.title || "this chat"}"?`)) return;
    try {
      await api(`/api/chats/${id}`, { method: "DELETE" });
      setChats((cs) => (cs || []).filter((c) => c.id !== id));
      if (chatIdRef.current === id) selectChat(null);
    } catch (e) {
      setChatsError(`Could not delete the chat: ${e.message}`);
    }
  }

  // Stick to the bottom while an answer streams, unless the user scrolled up
  // (any upward scroll, a finger on the screen, or the wheel turned up stops
  // following); a "Latest" button jumps back down. Following re-arms once the
  // newest line is visible again.
  const [showLatest, setShowLatest] = useState(false);
  const chatEndRef = useRef(null);
  const lastY = useRef(0);
  const touching = useRef(false);
  const measureBottom = useCallback(() => {
    const gap = chatGap(chatEndRef.current, composerRef.current);
    const y = window.scrollY;
    if (y < lastY.current - 1) atBottom.current = gap <= 0;
    else if (gap <= 24 && !touching.current) atBottom.current = true;
    lastY.current = y;
    setShowLatest(gap > 120);
  }, []);
  useEffect(() => {
    if (!active) return;
    measureBottom();
    const vv = window.visualViewport;
    const onTouchStart = () => { touching.current = true; };
    const onTouchEnd = () => { touching.current = false; measureBottom(); };
    const onWheel = (e) => { if (e.deltaY < 0) atBottom.current = false; };
    window.addEventListener("scroll", measureBottom, { passive: true });
    window.addEventListener("touchstart", onTouchStart, { passive: true });
    window.addEventListener("touchend", onTouchEnd, { passive: true });
    window.addEventListener("touchcancel", onTouchEnd, { passive: true });
    window.addEventListener("wheel", onWheel, { passive: true });
    vv?.addEventListener("resize", measureBottom);
    return () => {
      window.removeEventListener("scroll", measureBottom);
      window.removeEventListener("touchstart", onTouchStart);
      window.removeEventListener("touchend", onTouchEnd);
      window.removeEventListener("touchcancel", onTouchEnd);
      window.removeEventListener("wheel", onWheel);
      vv?.removeEventListener("resize", measureBottom);
    };
  }, [active, measureBottom]);
  const scrollToEnd = (behavior = "auto") => {
    // The planner's bottom padding includes the keyboard inset, so the document end
    // sits right above the (lifted) composer.
    window.scrollTo({ top: document.documentElement.scrollHeight, behavior });
  };
  useLayoutEffect(() => {
    if (!active) return;
    if (atBottom.current && !touching.current) scrollToEnd();
    measureBottom();
  }, [messages, stream, serverBusy, active, measureBottom]);
  const jumpToLatest = () => {
    atBottom.current = true;
    setShowLatest(false);
    const smooth = !window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    scrollToEnd(smooth ? "smooth" : "auto");
  };

  // Phones: the composer is fixed above the tab bar, or right above the
  // on-screen keyboard (visual viewport) while it is open.
  const kb = useKeyboardInset(active);
  // Keyboard opened/closed while following: keep the newest line above the composer.
  useLayoutEffect(() => {
    if (active && atBottom.current && !touching.current) scrollToEnd();
  }, [kb]); // eslint-disable-line react-hooks/exhaustive-deps
  const composerRef = useRef(null);
  const [composerH, setComposerH] = useState(64);
  useLayoutEffect(() => {
    const el = composerRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => setComposerH(Math.round(el.offsetHeight)));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Auto-grow composer.
  useLayoutEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, window.innerHeight * 0.4)}px`;
  }, [input]);

  const coarse = useMemo(() => window.matchMedia?.("(pointer: coarse)").matches, []);
  // Mobile chat drawer behaves like a modal: focus moves in, Tab is trapped,
  // Escape closes it and focus returns to the toggle (as in Sheet).
  useEffect(() => {
    if (!drawer) return;
    const prevFocus = document.activeElement;
    const focusables = () => drawerRef.current
      ? [...drawerRef.current.querySelectorAll(FOCUSABLE)]
      : [];
    focusables()[0]?.focus();
    const onKey = (e) => {
      if (e.key === "Escape") { e.stopPropagation(); setDrawer(false); }
      if (e.key === "Tab") {
        const f = focusables();
        if (!f.length) return;
        const first = f[0], last = f[f.length - 1];
        const inside = drawerRef.current.contains(document.activeElement);
        if (e.shiftKey && (!inside || document.activeElement === first)) { e.preventDefault(); last.focus(); }
        else if (!e.shiftKey && (!inside || document.activeElement === last)) { e.preventDefault(); first.focus(); }
      }
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      if (prevFocus && prevFocus.focus && document.contains(prevFocus)) prevFocus.focus({ preventScroll: true });
    };
  }, [drawer]);

  const busy = Boolean(stream) || serverBusy;
  const chat = chats?.find((c) => c.id === chatId);
  const notConfigured = health && !health.claude_configured;

  const newChat = () => { selectChat(null); window.scrollTo(0, 0); setTimeout(() => inputRef.current?.focus({ preventScroll: true }), 0); };
  const sidebar = (
    <>
      {drawer && <div className="drawer-backdrop" onClick={() => setDrawer(false)} aria-hidden="true" />}
      <aside ref={drawerRef} className={`chat-side${drawer ? " open" : ""}`} aria-label="Chats"
        role={drawer ? "dialog" : undefined} aria-modal={drawer ? "true" : undefined}>
        <div className="row between">
          <h2 style={{ fontSize: "1.05rem" }}>Chats</h2>
          <button type="button" className="btn ghost icon drawer-toggle" aria-label="Close chat list" onClick={() => setDrawer(false)}><Icon.close /></button>
        </div>
        <button type="button" className="btn primary" onClick={() => newChat()}><Icon.plus /> New chat</button>
        <ErrorNotice error={chatsError} onRetry={loadChats} />
        {!chats && !chatsError && <Spinner />}
        {chats && chats.length === 0 && <p className="muted small">No chats yet.</p>}
        {chats?.map((c) => (
          <div key={c.id} className="chat-link" aria-current={c.id === chatId ? "true" : undefined}>
            <button type="button" onClick={() => selectChat(c.id)}>
              <span>{c.title}</span>
              <span className="muted small">{fmtAgo(c.updated_at)}</span>
            </button>
            <button type="button" className="btn ghost icon" aria-label={`Delete chat ${c.title}`} onClick={() => deleteChat(c.id)}><Icon.trash /></button>
          </div>
        ))}
      </aside>
    </>
  );

  const plannerStyle = { "--composer-h": `${composerH}px`, "--kb": `${kb}px` };

  return (
    <div className={`planner${kb ? " kb-open" : ""}`} style={plannerStyle}>
      {sidebar}
      <section className="chat-main" aria-label="Conversation" ref={chatEndRef}>
        <div className="planner-bar">
          <button type="button" className="btn ghost drawer-toggle" aria-label="Show chats" aria-expanded={drawer} onClick={() => setDrawer(true)}><Icon.menu /> Chats</button>
          <h2 title={chatId ? chat?.title || "Chat" : "New chat"}>{chatId ? chat?.title || "Chat" : "New chat"}</h2>
          <button type="button" className="btn ghost" onClick={newChat} disabled={!chatId && !messages.length} aria-label="New chat"><Icon.plus /> New chat</button>
        </div>

        {notConfigured && <SetupHint />}

        {chatLoading && <Spinner label="Loading chat…" />}

        {!chatId && messages.length === 0 && !stream && (
          <div className="stack">
            <div className="empty" style={{ paddingBottom: 8 }}>
              <h3>Ask the planner</h3>
              <p style={{ margin: 0, maxWidth: 520 }}>Claude can search your collection, look cards up on Scryfall, check rules and prices, and save decks you'll find in the Decks tab.</p>
            </div>
            <div className="suggestions">
              {SUGGESTIONS.map((s) => (
                <button key={s} type="button" className="suggestion" onClick={() => { setInput(s); setTimeout(() => { const el = inputRef.current; if (el) { el.focus(); el.setSelectionRange(s.length, s.length); } }, 0); }}>{s}</button>
              ))}
            </div>
          </div>
        )}

        {chatId && !chatLoading && messages.length === 0 && !stream && !serverBusy && (
          <p className="muted">No messages yet — say hello.</p>
        )}

        <div className="messages" aria-live="off">
          {messages.map((m) => <Message key={m.id} msg={m} />)}
          {stream && (
            <div className="msg assistant" aria-busy="true">
              {stream.tools.length > 0 && <div className="tools">{stream.tools.map((t, i) => <ToolChip key={i} tool={t} />)}</div>}
              <div className="bubble">
                {stream.text ? <Markdown text={stream.text} /> : null}
                <span className="typing" role="status" aria-label="Claude is working"><span /><span /><span /></span>
              </div>
            </div>
          )}
          {!stream && serverBusy && (
            <div className="notice" role="status"><span className="spinner" aria-hidden="true" /><div className="grow">Claude is still working on an answer in this chat. It will appear here when it's done.</div></div>
          )}
        </div>

        {error && (error.status === 503
          ? (!notConfigured && <SetupHint />)
          : <ErrorNotice error={error.message} onDismiss={() => setError(null)} />)}

        {showLatest && (messages.length > 0 || stream) && (
          <button type="button" className="btn primary to-latest" onClick={jumpToLatest}><Icon.down /> Latest</button>
        )}

        <div className="composer" ref={composerRef}>
          <form onSubmit={(e) => { e.preventDefault(); atBottom.current = true; send(); }}>
            <label htmlFor="chat-input" className="sr-only">Message</label>
            <textarea id="chat-input" ref={inputRef} rows={1} value={input} maxLength={20000}
              placeholder={busy ? "Claude is answering…" : "Ask the planner…"}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey && !coarse && !e.nativeEvent.isComposing) { e.preventDefault(); send(); }
              }} />
            <button type="submit" className="btn primary" aria-label="Send" disabled={busy || !input.trim()}>
              {busy ? <span className="spinner" aria-hidden="true" style={{ borderTopColor: "var(--accent-ink)" }} /> : <Icon.send />}
            </button>
          </form>
        </div>
      </section>
    </div>
  );
}
