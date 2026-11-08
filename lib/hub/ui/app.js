// ArcFlare Hub phone UI: sign-in, the agent list, one agent's live conversation,
// and the list of signed-in devices.
//
// Why plain DOM code: the hub serves this page from the computer itself, often
// with no internet, and its CSP allows only same-origin scripts. So there is
// no framework and no build step, just this file.
//
// Why textContent everywhere: agent output, file names and device labels come
// from the model and the disk. Nodes are built with createElement and
// textContent, so none of that text can be read as markup. The markdown-lite
// renderer below follows the same rule: it only ever creates elements itself
// and puts text into them with textContent.
//
// Why no style changes from here: the CSP forbids inline styles. This file only
// toggles classes and attributes; textareas grow through CSS field-sizing.
//
// Why the CSRF token is a variable: it goes back on every write request and
// dies with the page. A reload asks /api/me for a fresh one. The session itself
// is an HttpOnly cookie that this script cannot read.
//
// Why the transcript resumes by seq: the stream replays everything after the
// last seq we rendered, so a dropped connection (a phone moving between Wi-Fi
// and mobile data, say) loses nothing and shows nothing twice.
//
// Why all network access goes through `transport`: the same bundle runs in two
// places. In a browser tab it talks to the hub it was served from. Inside the
// Android app, away from home, the app shell talks to the hub through the
// encrypted relay tunnel (lib/hub/ui/tunnel-client.js, lib/hub/TUNNEL.md). The
// shell sets window.ArcFlareTransport before this script runs; with none, the
// page's own fetch and EventSource are used and nothing changes. It is read
// once, at startup, and never again, so a script that loads later cannot swap
// the transport in the middle of a session.
//
// The adapter contract (all paths are /api/... exactly as used below):
//   fetch(path, init)  resolves to { ok, status, headers.get(name), json(), text() }.
//                      init is { method, headers, body, credentials }. Over the
//                      tunnel only these headers reach the hub: Accept,
//                      Content-Type and X-CSRF-Token (TUNNEL.md section 8), and
//                      `credentials` is meaningless there. This file sends
//                      nothing else and never relies on a cookie: the hub keeps
//                      the session cookie itself, and the CSRF token from /api/me
//                      goes back as X-CSRF-Token like on the LAN.
//   eventSource(path)  returns an EventSource look-alike: addEventListener(type,
//                      fn) (optional; the hub only sends unnamed events), onmessage,
//                      onerror, onopen (optional), readyState, close(). Events
//                      carry data and, when the hub sent one, lastEventId.
//                      Reconnecting is this file's job (openStream, with
//                      ?after=<seq>), so the adapter must not reconnect itself.
//   After the shell switches path it calls window.arcflareSetConnection("home" |
//   "relay") so the chip shows how the phone is connected.

"use strict";

const transport = window.ArcFlareTransport || {
  fetch: (p, i) => fetch(p, i),
  eventSource: (p) => new EventSource(p),
};

const STREAM_TYPES = ["status", "user", "delta", "tool", "tool_result", "approval", "approval_resolved", "turn_end", "error", "yolo"];
let loggingOut = false; // set while an explicit log out is in flight
const STATUS_TEXT = {
  stopped: "Stopped", starting: "Starting", idle: "Ready", busy: "Working", running: "Working",
  waiting_approval: "Needs approval", error: "Error",
};
const CONN = { home: "Home network", relay: "Internet" };

const state = {
  user: null, csrf: null, streams: {}, agent: null, listTimer: 0, focusCompose: false,
  agentsLoaded: false, sessionsLoaded: false, menuAgent: null, conn: "home",
};

const $ = (id) => document.getElementById(id);
const enc = (s) => encodeURIComponent(String(s));
const reduceMotion = () => window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

// Builds an element. Text goes in with textContent; kids may be nodes or strings.
function el(tag, opts, ...kids) {
  const node = document.createElement(tag);
  if (opts) {
    if (opts.cls) node.className = opts.cls;
    if (opts.text != null) node.textContent = String(opts.text);
    if (opts.attrs) for (const k of Object.keys(opts.attrs)) node.setAttribute(k, opts.attrs[k]);
    if (opts.on) for (const k of Object.keys(opts.on)) node.addEventListener(k, opts.on[k]);
  }
  for (const kid of kids) if (kid != null && kid !== false) node.append(kid);
  return node;
}

function setText(id, msg) {
  const node = $(id);
  node.textContent = msg || "";
  node.hidden = !msg;
}

// ---- Icons: 24px grid, 2px stroke, one set (paths are constants) -----------

const SVG_NS = "http://www.w3.org/2000/svg";
const ICONS = {
  terminal: ["M4 17l6-6-6-6", "M12 19h8"],
  chat: ["M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"],
  file: ["M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z", "M14 2v6h6"],
  search: ["M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16z", "M21 21l-4.3-4.3"],
  wrench: ["M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94z"],
  spark: ["M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9z"],
  chevron: ["M6 9l6 6 6-6"],
  check: ["M20 6L9 17l-5-5"],
  alert: ["M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20z", "M12 8v4", "M12 16h.01"],
  more: ["M12 5h.01", "M12 12h.01", "M12 19h.01"],
  phone: ["M7 2h10a2 2 0 0 1 2 2v16a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2z", "M12 18h.01"],
  monitor: ["M4 4h16a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2z", "M8 21h8", "M12 17v4"],
  copy: ["M10 9h9a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2h-9a2 2 0 0 1-2-2v-9a2 2 0 0 1 2-2z", "M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"],
};

function icon(name, cls) {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("class", "ico" + (cls ? " " + cls : ""));
  svg.setAttribute("aria-hidden", "true");
  for (const d of ICONS[name] || ICONS.wrench) {
    const p = document.createElementNS(SVG_NS, "path");
    p.setAttribute("d", d);
    svg.append(p);
  }
  return svg;
}

function toolIcon(name) {
  const n = String(name || "").toLowerCase();
  if (/bash|shell|exec|command|run|terminal/.test(n)) return "terminal";
  if (/grep|glob|search|find|list/.test(n)) return "search";
  if (/file|read|write|edit|patch|cat/.test(n)) return "file";
  return "wrench";
}

class ApiError extends Error {
  constructor(status, message, body) {
    super(message);
    this.status = status;
    this.body = body || {};
  }
}

// Every request goes through here: the session cookie, JSON, and the CSRF
// header on anything that is not a GET. A 401 from anywhere except sign-in
// (and the boot check) sends the user back to the sign-in screen.
async function api(method, path, body) {
  const opts = { method, credentials: "same-origin", headers: { Accept: "application/json" } };
  if (method !== "GET") {
    opts.headers["Content-Type"] = "application/json";
    opts.headers["X-CSRF-Token"] = state.csrf || "";
    opts.body = JSON.stringify(body || {});
  }
  let res;
  try { res = await transport.fetch(path, opts); }
  catch (e) { throw new ApiError(0, "Cannot reach the hub. Check the connection."); }
  let data = null;
  try { data = await res.json(); } catch (e) { data = null; }
  // A deliberate log out also makes open streams and requests fail with 401;
  // that must not overwrite "Signed out." with "Your session ended."
  if (res.status === 401 && path !== "/api/login" && path !== "/api/me" && !loggingOut) {
    signedOut("Your session ended. Sign in again.");
  }
  if (!res.ok) throw new ApiError(res.status, (data && data.error) || "Request failed (" + res.status + ").", data);
  return data;
}

// EventSource with our own reconnect. On error we ask /api/me first, because a
// 401 means signed out, not a network blip. Otherwise we retry with backoff.
// urlFn runs on every connect, so the agent stream always resumes from lastSeq.
function openStream(key, urlFn, onEvent) {
  const s = { es: null, timer: 0, delay: 1000, closed: false };
  const schedule = () => {
    if (s.closed) return;
    clearTimeout(s.timer);
    s.timer = setTimeout(connect, s.delay);
    s.delay = Math.min(s.delay * 2, 15000);
  };
  const handle = (ev) => {
    let data;
    try { data = JSON.parse(ev.data); } catch (e) { return; }
    if (!data || typeof data !== "object") return;
    if (data.seq == null && ev.lastEventId) data.seq = Number(ev.lastEventId);
    onEvent(data);
  };
  const connect = () => {
    if (s.closed) return;
    s.es = transport.eventSource(urlFn());
    s.es.onopen = () => { s.delay = 1000; };
    s.es.onmessage = handle;
    if (typeof s.es.addEventListener === "function") for (const t of STREAM_TYPES) s.es.addEventListener(t, handle);
    s.es.onerror = () => {
      s.es.close();
      s.es = null;
      api("GET", "/api/me").then(
        (me) => { if (!s.closed) { state.csrf = me.csrf; schedule(); } },
        (e) => {
          if (e.status === 401 && !loggingOut) signedOut("Your session ended. Sign in again.");
          else schedule();
        });
    };
  };
  s.close = () => {
    s.closed = true;
    clearTimeout(s.timer);
    if (s.es) s.es.close();
    s.es = null;
  };
  state.streams[key] = s;
  connect();
  return s;
}

// ---- Connection chip --------------------------------------------------------

// "home" while the phone talks to the hub over the local network. The app shell
// calls arcflareSetConnection("relay") when it uses the tunnel and the chip
// follows. Signing in must not reset it, so the choice is kept in state.conn.
function setConnection(kind) {
  const k = Object.prototype.hasOwnProperty.call(CONN, kind) ? kind : "home";
  state.conn = k;
  $("conn-chip").dataset.kind = k;
  $("conn-text").textContent = CONN[k];
}
window.arcflareSetConnection = setConnection;

// ---- Sheets (modal bottom sheets) ------------------------------------------
//
// One modal at a time. While one is open the whole app behind it is inert, so
// nothing behind it can be tapped, focused or read out. Focus moves into the
// sheet and Tab stays inside it. Esc closes the dismissable sheets; the
// approval sheet ignores it, because Esc must never approve (or skip) anything.

let modal = null; // { id, dismissable, opener }
const FOCUSABLE = "button:not(:disabled), input:not(:disabled), textarea:not(:disabled), a[href], summary, [tabindex=\"0\"]";

function openSheet(id, dismissable, focusId) {
  if (modal && modal.id !== id) closeSheet(modal.id, false, true);
  const wrap = $(id);
  clearTimeout(wrap._t);
  wrap.classList.remove("closing");
  wrap.hidden = false;
  modal = { id, dismissable, opener: document.activeElement };
  $("app").setAttribute("inert", "");
  const sheet = wrap.querySelector(".sheet");
  const target = focusId ? $(focusId) : sheet;
  (target || sheet).focus({ preventScroll: true });
}

function isTextEntry(n) {
  return !!n && (n.tagName === "TEXTAREA" || (n.tagName === "INPUT" && !["radio", "checkbox", "button", "submit"].includes(n.type)));
}

function closeSheet(id, restoreFocus, immediate) {
  const wrap = $(id);
  if (!wrap) return;
  const m = modal && modal.id === id ? modal : null;
  if (m) {
    modal = null;
    $("app").removeAttribute("inert");
  }
  if (m && restoreFocus !== false && m.opener && m.opener.isConnected && !isTextEntry(m.opener)) {
    m.opener.focus({ preventScroll: true });
  }
  clearTimeout(wrap._t);
  if (immediate || reduceMotion() || wrap.hidden) {
    wrap.hidden = true;
    wrap.classList.remove("closing");
    return;
  }
  wrap.classList.add("closing");
  wrap._t = setTimeout(() => { wrap.hidden = true; wrap.classList.remove("closing"); }, 170);
}

function closeModalNow() {
  if (modal) closeSheet(modal.id, false, true);
}

document.addEventListener("keydown", (ev) => {
  if (!modal) return;
  if (ev.key === "Escape") {
    ev.preventDefault();
    if (modal.dismissable) closeSheet(modal.id);
    return;
  }
  if (ev.key === "Tab") {
    const sheet = $(modal.id).querySelector(".sheet");
    const items = [...sheet.querySelectorAll(FOCUSABLE)].filter((n) => n.getClientRects().length > 0);
    if (!items.length) { ev.preventDefault(); return; }
    const first = items[0], last = items[items.length - 1];
    const cur = document.activeElement;
    if (ev.shiftKey && (cur === first || cur === sheet)) { ev.preventDefault(); last.focus(); }
    else if (!ev.shiftKey && cur === last) { ev.preventDefault(); first.focus(); }
    else if (!sheet.contains(cur)) { ev.preventDefault(); first.focus(); }
  }
});

document.addEventListener("click", (ev) => {
  const t = ev.target.closest && ev.target.closest("[data-dismiss]");
  if (t && modal && modal.id === t.getAttribute("data-dismiss") && modal.dismissable) closeSheet(modal.id);
});

// ---- Screens ----------------------------------------------------------------

function show(name) {
  for (const v of ["login", "dashboard", "agent", "chats", "chat", "tools", "devices"]) $("view-" + v).hidden = v !== name;
  const inApp = name !== "login";
  const inner = name === "agent" || name === "chat"; // back arrow + title instead of the brand
  $("topbar").hidden = !inApp;
  $("bottomnav").hidden = !inApp;
  $("fab-new").hidden = name !== "dashboard";
  $("tb-brand").hidden = inner;
  $("tb-agent").hidden = !inner;
  $("conn-chip").hidden = inner;
  $("agent-back").setAttribute("href", name === "chat" ? "#/chats" : "#/");
  const tab = name === "devices" ? "tab-devices" : name === "tools" ? "tab-tools" : name === "chats" || name === "chat" ? "tab-chats" : "tab-agents";
  for (const id of ["tab-agents", "tab-chats", "tab-tools", "tab-devices"]) {
    if (id === tab) $(id).setAttribute("aria-current", "page");
    else $(id).removeAttribute("aria-current");
  }
}

function stopAgent() {
  if (state.streams.agent) {
    state.streams.agent.close();
    delete state.streams.agent;
  }
  state.agent = null;
}

function stopStreams() {
  for (const key of Object.keys(state.streams)) state.streams[key].close();
  state.streams = {};
  state.agent = null;
  clearTimeout(state.listTimer);
}

function signedOut(message) {
  stopStreams();
  closeModalNow();
  state.user = null;
  state.csrf = null;
  state.agentsLoaded = false;
  state.sessionsLoaded = false;
  $("agent-list").replaceChildren();
  $("session-list").replaceChildren();
  $("login-fields").hidden = false;
  $("login-note").hidden = true;
  setText("login-error", message);
  show("login");
}

function signIn(me) {
  state.user = me.user;
  state.csrf = me.csrf;
  setConnection(state.conn);
  if (!state.streams.dash) openStream("dash", () => "/api/events", (ev) => { scheduleList(); onHubEvent(ev); });
  loadQuestions();
  askNotifications();
}

function route() {
  closeModalNow();
  if (!state.user) return show("login");
  const m = /^#\/agent\/([^/]+)$/.exec(location.hash);
  if (m) { stopChat(); return openAgent(decodeURIComponent(m[1])); }
  stopAgent();
  const c = /^#\/chat\/([0-9a-f]{16})$/.exec(location.hash);
  if (c) return openChat(c[1]);
  stopChat();
  if (location.hash === "#/chats") return openChats();
  if (location.hash === "#/devices") return openDevices();
  if (location.hash === "#/tools") return openTools();
  return openDashboard();
}

// Follow new output only if the reader is already near the bottom, so reading
// older messages is not interrupted.
function nearBottom() {
  const t = $("transcript");
  return t.scrollHeight - t.scrollTop - t.clientHeight < 120;
}
function pin(near) {
  const t = $("transcript");
  if (near) t.scrollTop = t.scrollHeight;
}

function statusLabel(status, pending) {
  if (pending) return "Needs approval";
  return STATUS_TEXT[status] || status || "Unknown";
}

function dotClass(status, pending) {
  if (pending) return "dot-wait";
  if (status === "error") return "dot-error";
  if (!status || status === "stopped") return "dot-off";
  return status === "idle" ? "dot-idle" : "dot-busy";
}

function lastLine(text) {
  const lines = String(text || "").split("\n").map((s) => s.trim()).filter(Boolean);
  return lines.length ? lines[lines.length - 1] : "";
}

function asList(data, key) {
  if (Array.isArray(data)) return data;
  return (data && Array.isArray(data[key])) ? data[key] : [];
}

function ago(v) {
  if (!v) return "unknown";
  const d = new Date(v);
  const t = d.getTime();
  if (isNaN(t)) return String(v);
  const s = Math.max(0, Math.round((Date.now() - t) / 1000));
  if (s < 45) return "just now";
  if (s < 3600) return Math.round(s / 60) + " min ago";
  if (s < 86400) return Math.round(s / 3600) + " h ago";
  if (s < 7 * 86400) return Math.round(s / 86400) + " d ago";
  return d.toLocaleDateString();
}

// Runs a supervisor action on an agent and reports any error in errId.
async function act(id, action, body, errId) {
  try {
    await api("POST", "/api/agents/" + enc(id) + "/" + action, body || {});
    setText(errId, "");
  } catch (e) {
    setText(errId, e.message);
  }
}

// ---- Agents screen ----------------------------------------------------------

function openDashboard() {
  show("dashboard");
  $("dash-skeleton").hidden = state.agentsLoaded;
  loadAgents();
}

// ---- Notifications (phone app only) ------------------------------------------
// Shown while the app is in the background (the page is hidden): a chat answer is ready, an agent needs
// approval, an agent finished. Local only (NotifierPlugin); nothing comes from a push service.

const agentNames = new Map(); // id -> name, from the agent list
let notifyId = 0;

function notifier() {
  const n = window.ArcFlareNative;
  return n && typeof n.notifier === "function" ? n.notifier() : null;
}

async function askNotifications() {
  const n = notifier();
  if (!n) return;
  try {
    let asked = null;
    try { asked = localStorage.getItem("arcflare.notifyAsked"); } catch (e) { /* storage off */ }
    const st = await n.state();
    if (st && st.granted) return;
    if (asked) return; // asked once; Android remembers the answer, Settings can change it
    try { localStorage.setItem("arcflare.notifyAsked", "1"); } catch (e) { /* storage off */ }
    await n.request();
  } catch (e) { /* not available */ }
}

function pushNotice(title, body) {
  const n = notifier();
  if (!n || !document.hidden) return; // in front: the screen already shows it
  notifyId = (notifyId + 1) % 1000;
  n.notify({ id: notifyId, title: String(title).slice(0, 80), body: String(body || "").slice(0, 300) }).catch(() => {});
}

// ---- Questions from agents on the computer (ask_phone) and notices (notify_phone) ----

const questionState = { queue: [], current: null };

function onHubEvent(ev) {
  if (!ev) return;
  if (ev.type === "question" && ev.id) {
    if (!questionState.queue.some((q) => q.id === ev.id) && (!questionState.current || questionState.current.id !== ev.id)) questionState.queue.push(ev);
    pushNotice("Question from " + (ev.from || "your computer"), ev.question);
    nextQuestion();
  } else if (ev.type === "question_resolved") {
    questionState.queue = questionState.queue.filter((q) => q.id !== ev.id);
    if (questionState.current && questionState.current.id === ev.id) { questionState.current = null; closeSheet("sheet-question"); nextQuestion(); }
  } else if (ev.type === "notice") {
    pushNotice(ev.title || "ArcFlare", ev.body || "");
  } else {
    notifyAgentEvent(ev);
  }
}

async function loadQuestions() {
  try {
    for (const q of asList(await api("GET", "/api/questions"), "questions")) onHubEvent({ type: "question", ...q, quiet: true });
  } catch (e) { /* an older hub: no questions */ }
}

function nextQuestion() {
  // Dismissed by tapping outside: it stays open on the hub and comes back on the next load.
  if (questionState.current && $("sheet-question").hidden) questionState.current = null;
  if (questionState.current || !questionState.queue.length || modal) return;
  const q = questionState.current = questionState.queue.shift();
  $("question-title").textContent = "Question from " + (q.from || "your computer");
  $("question-text").textContent = q.question;
  $("question-answer").value = "";
  setText("question-error", "");
  $("question-options").replaceChildren(...(q.options || []).map((o) =>
    el("button", { cls: "btn outline block", text: o, attrs: { type: "button" }, on: { click: () => answerQuestion(o) } })));
  openSheet("sheet-question", true, "question-answer");
}

async function answerQuestion(text) {
  const q = questionState.current;
  if (!q || !String(text || "").trim()) return;
  try {
    await api("POST", "/api/questions/" + enc(q.id) + "/answer", { answer: String(text).trim() });
    questionState.current = null;
    closeSheet("sheet-question");
    setTimeout(nextQuestion, 300);
  } catch (e) {
    setText("question-error", e.message);
  }
}

$("question-send").addEventListener("click", () => answerQuestion($("question-answer").value));
$("question-later").addEventListener("click", () => { questionState.current = null; closeSheet("sheet-question"); });

function notifyAgentEvent(ev) {
  if (!ev || !ev.agentId) return;
  const name = agentNames.get(ev.agentId) || "Agent";
  if (ev.type === "approval") pushNotice(name + " needs your approval", (ev.kind ? ev.kind + ": " : "") + (ev.detail || ""));
  else if (ev.type === "turn_end") pushNotice(name + " finished", "Tap to see what it did.");
  else if (ev.type === "error") pushNotice(name + " hit an error", ev.error || ev.message || "");
}

function scheduleList() {
  clearTimeout(state.listTimer);
  state.listTimer = setTimeout(() => { if (!$("view-dashboard").hidden) loadAgents(); }, 250);
}

async function loadAgents() {
  try {
    const list = asList(await api("GET", "/api/agents"), "agents");
    state.agentsLoaded = true;
    $("dash-skeleton").hidden = true;
    for (const a of list) agentNames.set(a.id, a.name);
    $("agent-list").replaceChildren(...list.map(agentCard));
    $("dash-empty").hidden = list.length > 0;
    setText("dash-error", "");
  } catch (e) {
    $("dash-skeleton").hidden = true;
    setText("dash-error", e.message);
  }
}

function agentCard(a) {
  const tier = ["light", "standard", "hard"].includes(a.tier) ? a.tier : "standard";
  const id = enc(a.id);
  const stopped = a.status === "stopped";
  const pending = !!a.pendingApproval;
  const last = lastLine(a.lastText);
  const statusCls = pending ? " attn" : (a.status === "error" ? " bad" : "");
  return el("li", { cls: "card agent" },
    el("div", { cls: "agent-top" },
      el("a", { cls: "agent-name", text: a.name, attrs: { href: "#/agent/" + id } }),
      el("span", { cls: "tier tier-" + tier, text: tier })),
    el("p", { cls: "last" + (last ? "" : " none"), text: last || "No messages yet." }),
    el("p", { cls: "folder", text: a.cwd }),
    a.yolo ? el("p", { cls: "yolo-line", text: "YOLO: runs without asking" }) : null,
    el("p", { cls: "agent-model-line" }, icon("spark"),
      el("span", { text: a.model ? a.model : a.modelRef ? "Auto · " + a.modelRef : "Auto · picked by tier" })),
    el("div", { cls: "agent-foot" },
      el("span", { cls: "status" + statusCls },
        el("span", { cls: "dot " + dotClass(a.status, pending), attrs: { "aria-hidden": "true" } }),
        el("span", { cls: "t", text: statusLabel(a.status, pending) })),
      stopped
        ? el("button", { cls: "btn primary", text: "Start", attrs: { type: "button" },
            on: { click: async (ev) => {
              ev.currentTarget.disabled = true;
              ev.currentTarget.textContent = "Starting...";
              await act(a.id, "start", {}, "dash-error");
              loadAgents();
            } } })
        : el("a", { cls: "btn tonal", text: "Open", attrs: { href: "#/agent/" + id } }),
      el("button", { cls: "icon-btn", attrs: { type: "button", "aria-label": "More actions for " + a.name, "aria-haspopup": "dialog" },
        on: { click: (ev) => openMenu(a, ev.currentTarget) } }, icon("more"))));
}

// ---- YOLO mode: one agent runs without asking. Off is one tap; on is behind a warning and a checkbox.

function showYolo(on) {
  if (state.agent) state.agent.yolo = on;
  const b = $("agent-yolo");
  b.setAttribute("aria-pressed", String(on));
  b.title = on ? "YOLO mode is on: tap to make the agent ask again" : "YOLO mode: run without asking";
  $("agent-statusbar").classList.toggle("is-yolo", on);
}

async function setYolo(on) {
  const view = state.agent;
  if (!view) return;
  try {
    await api("POST", "/api/agents/" + enc(view.id) + "/yolo", { on });
    showYolo(on);
    return true;
  } catch (e) {
    if (on) setText("yolo-error", e.message);
    else setText("agent-error", e.message);
    return false;
  }
}

$("agent-yolo").addEventListener("click", () => {
  const view = state.agent;
  if (!view) return;
  if (view.yolo) { setYolo(false); return; }
  $("yolo-sure").checked = false;
  $("yolo-ok").disabled = true;
  setText("yolo-error", "");
  $("yolo-folder").textContent = view.cwd || "this agent's folder";
  openSheet("sheet-yolo", true);
});
$("yolo-sure").addEventListener("change", () => { $("yolo-ok").disabled = !$("yolo-sure").checked; });
$("yolo-cancel").addEventListener("click", () => closeSheet("sheet-yolo"));
$("yolo-ok").addEventListener("click", async () => {
  if (!$("yolo-sure").checked) return;
  $("yolo-ok").disabled = true;
  if (await setYolo(true)) closeSheet("sheet-yolo");
  else $("yolo-ok").disabled = false;
});

function openMenu(a) {
  state.menuAgent = a;
  $("menu-title").textContent = a.name;
  $("menu-stop").parentElement.hidden = a.status === "stopped";
  openSheet("sheet-menu", true);
}

$("menu-cancel").addEventListener("click", () => closeSheet("sheet-menu"));
$("menu-wake").addEventListener("click", () => {
  const a = state.menuAgent;
  closeSheet("sheet-menu", false);
  if (!a) return;
  state.focusCompose = true;
  location.hash = "#/agent/" + enc(a.id);
});
$("menu-stop").addEventListener("click", async () => {
  const a = state.menuAgent;
  closeSheet("sheet-menu", false);
  if (!a) return;
  await act(a.id, "stop", {}, "dash-error");
  loadAgents();
});

// New agent sheet
$("fab-new").addEventListener("click", async () => {
  setText("new-error", "");
  openSheet("sheet-new", true);
  loadWorkspace();
  const models = chatView.models.length ? chatView.models : await loadModels();
  fillModelSelect($("new-model"), models, $("new-model").value || "", "Automatic: the tier picks it");
  syncNewTier();
});

// The workspace: an empty project field means the workspace itself, a name makes a folder in it, and the
// newest projects are one tap away, so nobody has to remember a path on the computer.
async function loadWorkspace() {
  const box = $("new-folders");
  try {
    const w = await api("GET", "/api/workspace");
    if (!w || !w.path) { box.hidden = true; return; }
    $("cwd-hint").textContent = "Empty: " + w.path + ". A name: a new folder in it.";
    const pick = (value) => { $("new-cwd").value = value; for (const b of box.children) b.setAttribute("aria-pressed", String(b.dataset.v === value)); };
    const chip = (label, value) => {
      const b = el("button", { cls: "folder-chip", text: label, attrs: { type: "button", "aria-pressed": "false", "data-v": value } });
      b.addEventListener("click", () => pick(value));
      return b;
    };
    const chips = (w.folders || []).map((f) => chip(f.name, f.name));
    // Other allowed folders, by their last part, with the full path as the value.
    for (const r of w.roots || []) if (r !== w.path) chips.push(chip(r.split(/[\\/]/).filter(Boolean).pop() || r, r));
    box.replaceChildren(...chips);
    box.hidden = !chips.length;
  } catch (e) {
    box.hidden = true; // an older hub: the field still takes a full path
    $("cwd-hint").textContent = "The full path of a folder on the computer.";
  }
}
$("new-cwd").addEventListener("input", () => {
  for (const b of $("new-folders").children) b.setAttribute("aria-pressed", String(b.dataset.v === $("new-cwd").value));
});

/** Fill a model <select>: an "automatic" first option (value ""), then every installed model with its size. */
function fillModelSelect(sel, models, current, autoLabel) {
  const opts = [el("option", { text: autoLabel, attrs: { value: "" } })];
  for (const m of models) opts.push(el("option", { text: fmtModel(m), attrs: { value: m.id } }));
  if (current && !models.some((m) => m.id === current)) opts.push(el("option", { text: current + " (not installed)", attrs: { value: current } }));
  sel.replaceChildren(...opts);
  sel.value = current || "";
}

// A picked model replaces the tier's choice, so the tier buttons step aside.
function syncNewTier() {
  const pinned = !!$("new-model").value;
  $("new-tier").disabled = pinned;
  $("new-tier").classList.toggle("muted-off", pinned);
  $("tier-hint").textContent = pinned ? "The model you picked is used instead of the tier's." : "Hard is reserved for the toughest tasks.";
}
$("new-model").addEventListener("change", syncNewTier);

$("new-form").addEventListener("submit", async (ev) => {
  ev.preventDefault();
  const name = $("new-name").value.trim();
  const cwd = $("new-cwd").value.trim();
  const task = $("new-task").value.trim();
  if (!name) return setText("new-error", "Give the agent a name.");
  const tierInput = $("new-form").querySelector("input[name=tier]:checked");
  const body = { name, tier: tierInput ? tierInput.value : "standard" };
  if (cwd) body.cwd = cwd;
  if (task) body.task = task;
  if ($("new-model").value) body.model = $("new-model").value;
  const submit = $("new-submit");
  submit.disabled = true;
  setText("new-error", "");
  try {
    const agent = await api("POST", "/api/agents", body);
    ev.target.reset();
    syncNewTier();
    closeSheet("sheet-new");
    if (task && agent && agent.id) location.hash = "#/agent/" + enc(agent.id);
    else loadAgents();
  } catch (e) {
    setText("new-error", e.message);
  } finally {
    submit.disabled = false;
  }
});

// ---- Conversation -----------------------------------------------------------

function openAgent(id) {
  stopAgent();
  show("agent");
  const view = {
    id, lastSeq: 0, approvalId: null, turnText: false, live: false, raw: "", rendering: false,
    msg: null, bubble: null, thinking: null, thinkingText: null, tools: [], sent: [],
  };
  state.agent = view;
  $("transcript").replaceChildren();
  $("agent-name").textContent = "Agent";
  $("agent-status").textContent = "Connecting";
  $("agent-dot").className = "dot dot-off";
  $("agent-start").hidden = true;
  $("agent-stop").hidden = true;
  $("agent-statusbar").className = "statusbar";
  setText("agent-error", "");
  showApproval(null);
  updateSend();
  openStream("agent", () => "/api/agents/" + enc(id) + "/events?after=" + view.lastSeq,
    (ev) => onAgentEvent(view, ev));
  loadAgent(view);
  // Replayed history appears at once; only messages that arrive after the
  // screen has settled animate in.
  setTimeout(() => { view.live = true; }, 700);
  if (state.focusCompose) {
    state.focusCompose = false;
    $("compose-text").focus();
  }
}

async function loadAgent(view) {
  try {
    const a = await api("GET", "/api/agents/" + enc(view.id));
    if (state.agent !== view) return;
    $("agent-name").textContent = a.name;
    const models = chatView.models.length ? chatView.models : await loadModels();
    if (state.agent !== view) return;
    fillModelSelect($("agent-model"), models, a.model || "", a.modelRef && !a.model ? "Auto (" + a.modelRef + ")" : "Auto: by tier");
    view.model = a.model || "";
    view.cwd = a.cwd || "";
    showYolo(!!a.yolo);
    setStatus(a.status, !!a.pendingApproval);
    showApproval(a.pendingApproval || null);
  } catch (e) {
    if (state.agent === view) {
      setText("agent-error", e.status === 404 ? "This agent no longer exists." : e.message);
    }
  }
}

function setStatus(status, pending) {
  $("agent-dot").className = "dot " + dotClass(status, pending);
  $("agent-status").textContent = statusLabel(status, pending);
  const bar = $("agent-statusbar");
  const working = !pending && !!status && !["stopped", "idle", "error"].includes(status);
  bar.className = "statusbar" + (working ? " is-working" : "") + (pending ? " is-wait" : "") + (status === "error" ? " is-bad" : "");
  const live = !!status && status !== "stopped" && status !== "error";
  // The model can change while the agent waits for a message, not mid-turn.
  $("agent-model").disabled = working || !!pending || status === "starting";
  $("agent-stop").hidden = !live;
  $("agent-start").hidden = live;
}

$("agent-model").addEventListener("change", async () => {
  const view = state.agent;
  if (!view) return;
  const sel = $("agent-model");
  const want = sel.value || null;
  sel.disabled = true;
  setText("agent-error", "");
  try {
    const a = await api("POST", "/api/agents/" + enc(view.id) + "/model", { model: want });
    view.model = a.model || "";
    setStatus(a.status, !!a.pendingApproval);
    const note = (want ? "Model set to " + want : "Model set to automatic (by tier)") + ". The next message starts the agent on it.";
    $("transcript").append(el("p", { cls: "notice ok", text: note }));
  } catch (e) {
    sel.value = view.model || "";
    setText("agent-error", e.message);
  }
  sel.disabled = false;
});

// The approval sheet is the one thing on this screen that must not be missed:
// a modal bottom sheet over a dimmed backdrop. It stays until it is answered
// (or the hub times it out); Esc and the scrim do nothing.
function showApproval(p) {
  if (state.agent) state.agent.approvalId = p ? p.id : null;
  setApprovalBusy(false);
  if (!p) {
    if (modal && modal.id === "approval") closeSheet("approval", false);
    else $("approval").hidden = true;
    return;
  }
  const kind = p.kind || "Action";
  const isMcp = kind === "mcp";
  $("approval-title").textContent = isMcp ? "Allow this tool call?" : /bash|shell|exec|command|run/i.test(kind) ? "Allow this command?" : "Allow this action?";
  $("approval-kind").textContent = isMcp ? "MCP tool" : kind;
  $("approval-detail").textContent = isMcp ? mcpDetail(p.detail) : p.detail || "";
  $("approval-detail").scrollTop = 0;
  if (!modal || modal.id !== "approval") openSheet("approval", false);
  $("agent-status").textContent = "Needs approval";
  $("agent-dot").className = "dot dot-wait";
  $("agent-statusbar").className = "statusbar is-wait";
}

// "server__tool {json}" → "server › tool" and the arguments laid out one per line. Lossless: anything
// that does not parse is shown exactly as sent.
function mcpDetail(detail) {
  const s = String(detail || "");
  const m = /^([A-Za-z0-9._-]+?)__(\S+) ([\s\S]*)$/.exec(s);
  if (!m) return s;
  let args;
  try { args = JSON.stringify(JSON.parse(m[3]), null, 2); } catch { return s; }
  return m[1] + " › " + m[2] + "\n" + args;
}

function setApprovalBusy(busy) {
  $("approve-allow").disabled = busy;
  $("approve-deny").disabled = busy;
}

async function decide(allow) {
  const view = state.agent;
  if (!view || !view.approvalId) return;
  setApprovalBusy(true);
  try {
    await api("POST", "/api/agents/" + enc(view.id) + "/approve", { approvalId: view.approvalId, allow });
  } catch (e) {
    setText("agent-error", e.message);
  } finally {
    setApprovalBusy(false);
    if (state.agent === view) loadAgent(view);
  }
}

// ---- Markdown-lite ----------------------------------------------------------
//
// Paragraphs, `inline code` and ``` fenced code ```. Nothing else is
// interpreted, and the output is built from elements this function creates, so
// model text can never turn into markup.

// Inline markdown as DOM nodes (never innerHTML): `code`, **bold**, __bold__, *italic*, _italic_.
// Code wins: nothing inside backticks is styled. Bold and italic may hold code and each other.
const INLINE_RE = /`([^`\n]+)`|\*\*(?=\S)([^\n]*?\S)\*\*|__(?=\S)([^\n]*?\S)__|(?<![\w*])\*(?=[^\s*])([^*\n]*?[^\s*])\*(?![\w*])|(?<![\w])_(?=[^\s_])([^_\n]*?[^\s_])_(?![\w])/g;

function inlineNodes(text, depth) {
  const out = [];
  const re = new RegExp(INLINE_RE.source, "g");
  let last = 0, m;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(document.createTextNode(text.slice(last, m.index)));
    const inner = (s) => ((depth || 0) < 3 ? inlineNodes(s, (depth || 0) + 1) : [document.createTextNode(s)]);
    if (m[1] != null) out.push(el("code", { text: m[1] }));
    else if (m[2] != null || m[3] != null) out.push(el("strong", null, ...inner(m[2] != null ? m[2] : m[3])));
    else out.push(el("em", null, ...inner(m[4] != null ? m[4] : m[5])));
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push(document.createTextNode(text.slice(last)));
  return out;
}

function renderMarkdown(container, text) {
  const nodes = [];
  const lines = String(text).split("\n");
  let para = [];
  const flush = () => {
    if (!para.length) return;
    nodes.push(el("p", null, ...inlineNodes(para.join("\n"))));
    para = [];
  };
  let i = 0;
  while (i < lines.length) {
    const fence = /^\s*```\s*([\w+#.-]*)\s*$/.exec(lines[i]);
    if (fence) {
      flush();
      const code = [];
      i++;
      while (i < lines.length && !/^\s*```\s*$/.test(lines[i])) code.push(lines[i++]);
      i++; // the closing fence (or the end, while the block is still streaming)
      nodes.push(el("div", { cls: "codeblock" },
        fence[1] ? el("div", { cls: "lang", text: fence[1] }) : null,
        el("pre", { attrs: { tabindex: "0" } }, el("code", { text: code.join("\n") }))));
      continue;
    }
    const head = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/.exec(lines[i]);
    if (head) {
      flush();
      nodes.push(el("p", { cls: "md-h md-h" + Math.min(head[1].length, 3) }, ...inlineNodes(head[2])));
      i++;
      continue;
    }
    // A list: consecutive "- item" / "1. item" lines (a line that does not start a new item continues the last one).
    const bullet = /^\s*([-*+]|\d{1,3}[.)])\s+(.*)$/;
    const first = bullet.exec(lines[i]);
    if (first && !/^\s*([-*_])(\s*\1){2,}\s*$/.test(lines[i])) {
      flush();
      const ordered = /\d/.test(first[1]);
      const items = [];
      while (i < lines.length && lines[i].trim()) {
        const b = bullet.exec(lines[i]);
        if (b && /\d/.test(b[1]) === ordered) items.push(b[2]);
        else if (b || !items.length) break;
        else items[items.length - 1] += "\n" + lines[i].trim();
        i++;
      }
      const start = ordered ? parseInt(first[1], 10) : 1;
      nodes.push(el(ordered ? "ol" : "ul", { cls: "md-list", attrs: ordered && start !== 1 ? { start: String(start) } : null },
        ...items.map((t) => el("li", null, ...inlineNodes(t)))));
      continue;
    }
    if (/^\s*>/.test(lines[i])) {
      flush();
      const q = [];
      while (i < lines.length && /^\s*>/.test(lines[i])) q.push(lines[i++].replace(/^\s*>\s?/, ""));
      nodes.push(el("blockquote", { cls: "md-quote" }, ...inlineNodes(q.join("\n"))));
      continue;
    }
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(lines[i])) { flush(); nodes.push(el("hr", { cls: "md-hr" })); i++; continue; }
    if (!lines[i].trim()) flush(); else para.push(lines[i]);
    i++;
  }
  flush();
  container.replaceChildren(...nodes);
}

// ---- Conversation rendering -------------------------------------------------
//
// A content delta streams into the open agent bubble; a tool chip or a turn end
// closes it, so text after a tool call starts a new bubble below the chip.

function popCls(view) { return view.live ? " pop" : ""; }

function startMessage(view) {
  const near = nearBottom();
  view.thinkingText = el("div", { cls: "thinking-text" });
  view.thinking = el("details", { cls: "thinking", attrs: { hidden: "" } },
    el("summary", null, icon("spark"), el("span", { text: "Thinking" }), icon("chevron", "chev")),
    view.thinkingText);
  view.bubble = el("div", { cls: "bubble agent", attrs: { hidden: "" } });
  view.msg = el("div", { cls: "msg" + popCls(view) }, view.thinking, view.bubble);
  view.raw = "";
  $("transcript").append(view.msg);
  pin(near);
}

function endMessage(view) {
  const near = nearBottom();   // measured before the flush grows the bubble
  flushRender(view);
  pin(near);
  view.msg = view.bubble = view.thinking = view.thinkingText = null;
  view.raw = "";
}

function flushRender(view) {
  view.rendering = false;
  if (view.bubble && view.raw) {
    renderMarkdown(view.bubble, view.raw);
    view.bubble.hidden = false;
  }
}

function scheduleRender(view) {
  if (view.rendering) return;
  view.rendering = true;
  requestAnimationFrame(() => {
    if (!view.rendering) return;
    const near = nearBottom();
    flushRender(view);
    pin(near);
  });
}

function appendDelta(view, kind, text) {
  if (!text) return;
  const near = nearBottom();
  if (!view.msg) startMessage(view);
  if (kind === "reasoning") {
    view.thinking.hidden = false;
    view.thinkingText.append(text);
  } else {
    view.turnText = true;
    view.raw += text;
    scheduleRender(view);
  }
  pin(near);
}

// A message the person sent. The composer shows it at once (optimistically);
// when the hub echoes it back as a "user" event that echo adopts the bubble
// instead of adding a second one. Replayed history has no optimistic bubble,
// so the echo creates it and a reopened agent shows both sides.
function addUser(view, text) {
  const t = String(text || "");
  const i = view.sent.findIndex((x) => x.text === t.trim() || x.text === t);
  if (i >= 0) { view.sent.splice(i, 1); return; }
  endMessage(view);
  const near = nearBottom();
  $("transcript").append(el("div", { cls: "bubble user" + popCls(view), text: t }));
  pin(near);
}

function addNotice(view, cls, text) {
  endMessage(view);
  const near = nearBottom();
  $("transcript").append(el("div", { cls: "notice " + cls + popCls(view), text }));
  pin(near);
}

function addError(view, text) {
  endMessage(view);
  const near = nearBottom();
  $("transcript").append(el("div", { cls: "bubble error" + popCls(view), text }));
  pin(near);
}

function makeTool(view, name, detail) {
  const result = el("div", { cls: "tool-result", text: "Running..." });
  const state_ = el("span", { cls: "tstate" });
  const node = el("details", { cls: "tool pending" + popCls(view) },
    el("summary", null,
      icon(toolIcon(name)),
      el("span", { cls: "tname", text: name || "tool" }),
      " ",
      detail ? el("span", { cls: "tdetail", text: detail }) : null,
      state_,
      icon("chevron", "chev")),
    result);
  const tool = { node, name, result, state: state_, done: false };
  view.tools.push(tool);
  return tool;
}

function finishTool(tool, error, text) {
  tool.done = true;
  tool.node.classList.remove("pending");
  tool.node.classList.add(error ? "err" : "ok");
  tool.result.textContent = text || (error ? "Failed." : "Done.");
  tool.state.replaceChildren(icon(error ? "alert" : "check"));
  if (error) tool.node.open = true;
}

function addTool(view, ev) {
  endMessage(view);
  const near = nearBottom();
  const tool = makeTool(view, ev.name, ev.detail);
  $("transcript").append(tool.node);
  pin(near);
}

function addToolResult(view, ev) {
  const error = !!ev.error;
  let text = typeof ev.error === "string" ? ev.error : (ev.line || "");
  if (Number(ev.lines) > 1) text += "\n+" + (Number(ev.lines) - 1) + " more lines";
  let tool = view.tools.find((t) => !t.done && t.name === ev.name);
  const near = nearBottom();
  if (!tool) {
    endMessage(view);
    tool = makeTool(view, ev.name, "");
    $("transcript").append(tool.node);
  }
  finishTool(tool, error, text);
  pin(near);
}

function settleTools(view) {
  for (const t of view.tools) if (!t.done) {
    t.done = true;
    t.node.classList.remove("pending");
    t.result.textContent = "No output reported.";
  }
  view.tools = [];
}

function onAgentEvent(view, ev) {
  if (state.agent !== view) return;
  if (typeof ev.seq === "number") {
    if (ev.seq <= view.lastSeq) return;
    view.lastSeq = ev.seq;
  }
  switch (ev.type) {
    case "status":
      setStatus(ev.status, !!view.approvalId);
      break;
    case "user":
      addUser(view, ev.text);
      break;
    case "delta":
      appendDelta(view, ev.kind, ev.text);
      break;
    case "tool":
      addTool(view, ev);
      break;
    case "tool_result":
      addToolResult(view, ev);
      break;
    case "approval":
      showApproval(ev);
      addNotice(view, "", "Waiting for approval: " + (ev.kind || "action"));
      break;
    case "approval_resolved":
      if (view.approvalId === ev.id) showApproval(null);
      if (ev.auto) addNotice(view, "yolo", "Ran without asking (YOLO): " + (ev.kind === "mcp" ? mcpDetail(ev.detail) : String(ev.detail || ev.kind || "")).slice(0, 300));
      else addNotice(view, ev.allow ? "ok" : "no", (ev.allow ? "Allowed" : "Denied") + (ev.reason ? " (" + ev.reason + ")" : ""));
      break;
    case "yolo":
      showYolo(!!ev.on);
      addNotice(view, ev.on ? "yolo" : "ok", ev.on ? "YOLO mode on: this agent no longer asks before it acts" : "YOLO mode off: the agent asks again");
      break;
    case "turn_end":
      endMessage(view);
      settleTools(view);
      if (ev.ok === false) {
        addError(view, ev.text || "The turn failed.");
      } else if (ev.text && !view.turnText) {
        startMessage(view);
        view.raw = ev.text;
        endMessage(view);
      }
      view.turnText = false;
      break;
    case "error":
      addError(view, ev.text || "Something went wrong.");
      break;
    default:
      break; // unknown types are ignored, so the server can add more
  }
}

// Composer: the send button is a round icon that stays disabled while empty.
function updateSend() {
  $("compose-send").disabled = !$("compose-text").value.trim();
}
$("compose-text").addEventListener("input", updateSend);
$("compose-text").addEventListener("keydown", (ev) => {
  if (ev.key === "Enter" && (ev.ctrlKey || ev.metaKey)) { ev.preventDefault(); $("compose").requestSubmit(); }
});

$("compose").addEventListener("submit", async (ev) => {
  ev.preventDefault();
  const view = state.agent;
  const box = $("compose-text");
  const text = box.value.trim();
  if (!view || !text) return;
  box.value = "";
  updateSend();
  setText("agent-error", "");
  endMessage(view);
  const bubble = el("div", { cls: "bubble user pop", text });
  const mine = { text, node: bubble };
  view.sent.push(mine);
  $("transcript").append(bubble);
  pin(true);
  try {
    await api("POST", "/api/agents/" + enc(view.id) + "/wake", { text });
  } catch (e) {
    view.sent.splice(view.sent.indexOf(mine), 1);
    bubble.remove();
    box.value = text;
    updateSend();
    setText("agent-error", e.message);
  }
});

$("approve-allow").addEventListener("click", () => decide(true));
$("approve-deny").addEventListener("click", () => decide(false));
$("agent-stop").addEventListener("click", () => {
  const view = state.agent;
  if (view) act(view.id, "stop", {}, "agent-error").then(() => loadAgent(view));
});
$("agent-start").addEventListener("click", () => {
  const view = state.agent;
  if (view) act(view.id, "start", {}, "agent-error").then(() => loadAgent(view));
});

// ---- Chat -------------------------------------------------------------------
// Plain conversations with a model on the computer (lib/hub/chat.js). The answer streams in as events:
// start, reasoning (shown under "Thinking"), delta, then done / stopped / error.

const chatView = { id: null, live: null, generating: false, models: [], aiArmed: 0 };

function stopChat() {
  if (state.streams.chat) { state.streams.chat.close(); delete state.streams.chat; }
  chatView.id = null;
  chatView.live = null;
}

function fmtModel(m) {
  const gb = m.size ? " · " + (m.size / 1e9).toFixed(1) + " GB" : "";
  return m.id + gb;
}

async function loadModels() {
  try { chatView.models = asList(await api("GET", "/api/models"), "models"); } catch (e) { chatView.models = []; }
  return chatView.models;
}

async function refreshAiStatus() {
  try {
    const s = await api("GET", "/api/ai/status");
    $("ai-status").textContent = s.running && s.modelRef ? "Loaded: " + s.modelRef : "Not running. It starts by itself when you send a message.";
  } catch (e) {
    $("ai-status").textContent = "Unknown (" + e.message + ")";
  }
}

async function openChats() {
  show("chats");
  setText("chats-error", "");
  refreshAiStatus();
  try {
    const list = asList(await api("GET", "/api/chats"), "chats");
    $("chat-list").replaceChildren(...list.map(chatRow));
    filterChats();
  } catch (e) {
    setText("chats-error", e.message);
  }
}

function chatRow(c) {
  const title = el("span", { text: c.title || "Chat" });
  const del = el("button", { cls: "btn danger", text: "Delete", attrs: { type: "button" } });
  // Deleting is final, so it takes a second tap within 4 seconds.
  let armed = 0;
  del.addEventListener("click", () => {
    if (Date.now() - armed > 4000) {
      armed = Date.now();
      del.textContent = "Tap again to delete";
      setTimeout(() => { if (Date.now() - armed >= 4000) del.textContent = "Delete"; }, 4100);
      return;
    }
    del.disabled = true;
    deleteChat(c.id);
  });
  const ren = el("button", { cls: "btn outline", text: "Rename", attrs: { type: "button" } });
  const li = el("li", { cls: "card dev", attrs: { "data-title": c.title || "Chat" } },
    el("a", { cls: "dev-top", attrs: { href: "#/chat/" + enc(c.id) } },
      el("span", { cls: "dev-ico" }, icon("chat")),
      el("div", { cls: "dev-body" },
        el("p", { cls: "dev-name" }, title,
          c.status === "generating" ? el("span", { cls: "badge", text: "Answering" }) : null),
        el("p", { cls: "dev-meta", text: (c.model || "default model") + " · " + ago(c.updatedAt) }))),
    el("div", { cls: "dev-foot chat-foot" }, ren, del));
  ren.addEventListener("click", () => startRename(li, c, title));
  return li;
}

// Rename in place: the card's footer becomes a text field with Save and Cancel.
function startRename(li, c, titleNode) {
  const foot = li.querySelector(".chat-foot");
  const old = [...foot.childNodes];
  const input = el("input", { cls: "chat-rename", attrs: { type: "text", maxlength: "80", "aria-label": "New name", enterkeyhint: "done" } });
  input.value = titleNode.textContent;
  const done = () => foot.replaceChildren(...old);
  const save = async () => {
    const t = input.value.trim();
    if (!t || t === titleNode.textContent) return done();
    try {
      const r = await api("PATCH", "/api/chats/" + enc(c.id), { title: t });
      titleNode.textContent = (r && r.title) || t;
      li.dataset.title = titleNode.textContent;
      setText("chats-error", "");
      done();
    } catch (e) { setText("chats-error", e.message); }
  };
  input.addEventListener("keydown", (ev) => {
    if (ev.key === "Enter") { ev.preventDefault(); save(); }
    else if (ev.key === "Escape") done();
  });
  foot.replaceChildren(input,
    el("button", { cls: "btn outline", text: "Cancel", attrs: { type: "button" }, on: { click: done } }),
    el("button", { cls: "btn primary", text: "Save", attrs: { type: "button" }, on: { click: save } }));
  input.focus();
  input.select();
}

// Search: filter the list by title as you type (the list is already all here).
function filterChats() {
  const q = $("chat-search").value.trim().toLowerCase();
  let shown = 0;
  for (const li of $("chat-list").children) {
    const hit = !q || String(li.dataset.title || "").toLowerCase().includes(q);
    li.hidden = !hit;
    if (hit) shown++;
  }
  $("chat-nomatch").hidden = !q || shown > 0;
}
$("chat-search").addEventListener("input", filterChats);

async function deleteChat(id) {
  try { await api("DELETE", "/api/chats/" + enc(id)); openChats(); } catch (e) { setText("chats-error", e.message); }
}

$("chat-new").addEventListener("click", async () => {
  setText("chats-error", "");
  try {
    const models = chatView.models.length ? chatView.models : await loadModels();
    let last = null;
    try { last = localStorage.getItem("arcflare.chatModel"); } catch (e) { /* storage off */ }
    const model = models.some((m) => m.id === last) ? last : (models[0] && models[0].id) || null;
    const c = await api("POST", "/api/chats", { model });
    location.hash = "#/chat/" + enc(c.id);
  } catch (e) {
    setText("chats-error", e.message);
  }
});

// "Stop AI server": every answer, every agent, and the model server (frees the GPU). Tap twice within 4 s.
$("ai-stop").addEventListener("click", async () => {
  const btn = $("ai-stop");
  if (Date.now() - chatView.aiArmed > 4000) {
    chatView.aiArmed = Date.now();
    btn.textContent = "Tap again: stops all chats, agents and the model";
    setTimeout(() => { if (Date.now() - chatView.aiArmed >= 4000) btn.textContent = "Stop AI server"; }, 4100);
    return;
  }
  chatView.aiArmed = 0;
  btn.disabled = true;
  btn.textContent = "Stopping…";
  try {
    const r = await api("POST", "/api/ai/stop", {});
    $("ai-status").textContent = "Stopped" + (r.model ? " " + r.model : "") + ". Chats stopped: " + (r.chats || 0) + ", agents: " + (r.agents || 0) + ".";
  } catch (e) {
    setText("chats-error", e.message);
  } finally {
    btn.disabled = false;
    btn.textContent = "Stop AI server";
  }
});

function chatPin(near) { const t = $("chat-transcript"); if (near) t.scrollTop = t.scrollHeight; }
function chatNearBottom() { const t = $("chat-transcript"); return t.scrollHeight - t.scrollTop - t.clientHeight < 120; }

function chatMessageNode(m) {
  if (m.role === "user") return el("div", { cls: "bubble user", text: m.content });
  const bubble = el("div", { cls: "bubble agent" });
  renderMarkdown(bubble, m.content || (m.stopped ? "(stopped)" : ""));
  const thinking = m.reasoning ? el("details", { cls: "thinking" },
    el("summary", null, icon("spark"), el("span", { text: "Thinking" }), icon("chevron", "chev")),
    el("div", { cls: "thinking-text", text: m.reasoning })) : null;
  return el("div", { cls: "msg" }, thinking, bubble, statsMeta(m.model, m.stats, m.stopped), msgActions(m.content || ""));
}

// Under every answer: Copy. Regenerate shows on the last answer only (CSS), and not while answering.
function msgActions(text) {
  const copy = el("button", { cls: "msg-act", attrs: { type: "button", "aria-label": "Copy answer" } }, icon("copy"), el("span", { text: "Copy" }));
  copy.addEventListener("click", async () => {
    const ok = await copyText(text);
    copy.lastChild.textContent = ok ? "Copied" : "Copy failed";
    setTimeout(() => { copy.lastChild.textContent = "Copy"; }, 1500);
  });
  const again = el("button", { cls: "msg-act msg-regen", attrs: { type: "button", "aria-label": "Answer again" } }, icon("spark"), el("span", { text: "Regenerate" }));
  again.addEventListener("click", regenerateChat);
  return el("div", { cls: "msg-actions" }, copy, again);
}

async function copyText(text) {
  try { await navigator.clipboard.writeText(text); return true; } catch (e) { /* fall back below */ }
  try {
    const t = el("textarea", { attrs: { readonly: "", style: "position:fixed;opacity:0" } });
    t.value = text;
    document.body.append(t);
    t.select();
    const ok = document.execCommand("copy");
    t.remove();
    return ok;
  } catch (e) { return false; }
}

async function regenerateChat() {
  const id = chatView.id;
  if (!id || chatView.generating) return;
  setText("chat-error", "");
  setGenerating(true);
  try {
    await api("POST", "/api/chats/" + enc(id) + "/regenerate", { model: $("chat-model").value || null });
  } catch (e) {
    setGenerating(false);
    setText("chat-error", e.message);
  }
}

// The answers after the last question: what a regenerate replaces.
function dropTrailingAnswers() {
  const t = $("chat-transcript");
  while (t.lastElementChild && t.lastElementChild.classList.contains("msg")) t.lastElementChild.remove();
}

// ---- Chat instructions (its system prompt) ----------------------------------

function showSystem(text) {
  $("chat-sys-text").value = text || "";
  $("chat-sys-badge").hidden = !text;
  $("chat-sys-note").textContent = "";
  $("chat-sys").open = false;
}

$("chat-sys-save").addEventListener("click", async () => {
  const id = chatView.id;
  if (!id) return;
  const btn = $("chat-sys-save");
  btn.disabled = true;
  try {
    const c = await api("PATCH", "/api/chats/" + enc(id), { system: $("chat-sys-text").value });
    $("chat-sys-badge").hidden = !(c && c.system);
    $("chat-sys-note").textContent = c && c.system ? "Saved. Used from the next answer." : "Cleared.";
  } catch (e) {
    $("chat-sys-note").textContent = e.message;
  } finally {
    btn.disabled = false;
  }
});

// ---- Chat details: load progress, speed, GPU ---------------------------------

function fmtSecs(ms) {
  if (!(ms >= 0)) return "";
  return ms < 10000 ? (ms / 1000).toFixed(1) + " s" : Math.round(ms / 1000) + " s";
}
function fmtCtx(n) { return n >= 1024 ? Math.round(n / 1024) + "K" : String(n || ""); }
function fmtGB(b) { return b ? (b / 1e9).toFixed(1) + " GB" : ""; }

/** The line under an answer: model · speed · tokens · first word · load time. */
function statsMeta(model, st, stopped) {
  const parts = [];
  if (model) parts.push(el("span", { cls: "meta-model", text: model }));
  if (st && st.tps) parts.push(el("span", { cls: "meta-speed", text: st.tps + " tok/s" }));
  if (st && st.tokens) parts.push(el("span", { text: st.tokens + " tokens" }));
  if (st && st.ttftMs != null) parts.push(el("span", { text: "first word " + fmtSecs(st.ttftMs) }));
  if (st && st.loadMs) parts.push(el("span", { text: "loaded in " + fmtSecs(st.loadMs) }));
  if (stopped) parts.push(el("span", { cls: "meta-stopped", text: "stopped" }));
  return parts.length ? el("p", { cls: "msg-meta" }, ...parts) : null;
}

const LOAD_STAGE = {
  starting: "Starting the engine",
  weights: "Loading weights into GPU memory",
};

function loadCard() {
  const title = el("span", { cls: "load-title" });
  const pct = el("span", { cls: "load-pct" });
  const bar = el("progress", { cls: "load-bar", attrs: { max: "100", value: "0" } });
  const sub = el("p", { cls: "load-sub" });
  const node = el("div", { cls: "loadcard pop", attrs: { role: "status" } },
    el("div", { cls: "load-top" }, el("span", { cls: "spin", attrs: { "aria-hidden": "true" } }), title, pct), bar, sub);
  return { node, title, pct, bar, sub };
}

function showLoad(v, ev) {
  if (ev.phase === "loaded") {
    if (v.load) { v.load.node.remove(); v.load = null; }
    setGpu(true, ev.model);
    showTyping(v, true);
    return;
  }
  if (!v.load) { v.load = loadCard(); v.msg.prepend(v.load.node); }
  showTyping(v, false);
  setGpu(false, null, true);
  const L = v.load;
  const pct = Math.max(0, Math.min(99, Math.round(ev.pct || 0)));
  L.title.textContent = "Loading " + (ev.model || "the model");
  L.pct.textContent = pct + "%";
  L.bar.value = pct;
  let stage = LOAD_STAGE[ev.stage] || "Loading";
  if (ev.stage === "retry") stage = ev.reason === "context" ? "Did not fit, trying a smaller context" : "Did not fit, trying a smaller batch";
  const left = (ev.estMs || 0) - (ev.elapsedMs || 0);
  const bits = [stage, fmtGB(ev.size), ev.ctx ? fmtCtx(ev.ctx) + " context" : "",
    left > 1500 ? "about " + fmtSecs(left) + " left" : "almost there"];
  L.sub.textContent = bits.filter(Boolean).join(" · ");
}

/** Three dots in the answer bubble while waiting for the first word. */
function showTyping(v, on) {
  if (v.raw) { v.bubble.classList.remove("typing"); v.bubble.hidden = false; return; }
  if (on) {
    v.bubble.classList.add("typing");
    v.bubble.replaceChildren(el("span"), el("span"), el("span"));
    v.bubble.hidden = false;
  } else {
    v.bubble.classList.remove("typing");
    v.bubble.replaceChildren();
    v.bubble.hidden = true;
  }
}

/** Live speed while the answer streams (about one event per token). */
function tickSpeed(v) {
  const now = Date.now();
  v.count++;
  if (!v.first) v.first = now;
  if (now - v.shown < 300) return;
  v.shown = now;
  const secs = (now - v.first) / 1000;
  const tps = secs > 0.5 ? (v.count - 1) / secs : 0;
  v.live.textContent = (tps ? tps.toFixed(1) + " tok/s · " : "") + v.count + " tokens";
}

function setGpu(on, model, loading) {
  const pill = $("chat-gpu");
  pill.classList.toggle("on", !!on);
  pill.classList.toggle("loading", !!loading);
  $("chat-gpu-text").textContent = loading ? "Loading" : on ? "On GPU" : "Not loaded";
  pill.title = on && model ? model + " is in GPU memory" : loading ? "Loading a model into GPU memory" : "No model in GPU memory. It loads when you send a message.";
}

async function refreshChatGpu() {
  try { const s = await api("GET", "/api/ai/status"); setGpu(s.running && s.modelRef, s.modelRef); } catch (e) { /* leave it as it is */ }
}

function setGenerating(on) {
  chatView.generating = on;
  if (on) setText("chat-note", "");
  $("chat-stop").hidden = false;
  $("chat-stop-label").textContent = on ? "Stop" : "Unload";
  $("chat-stop").title = on ? "Stop the answer and unload the model from the GPU" : "Unload the model from the GPU";
  $("chat-model").disabled = on;
  $("chat-bar").classList.toggle("is-working", on);
  updateChatSend();
}

function updateChatSend() {
  $("chat-send").disabled = chatView.generating || !$("chat-text").value.trim();
}

async function openChat(id) {
  if (chatView.id === id && state.streams.chat) { show("chat"); return; }
  stopChat();
  chatView.id = id;
  show("chat");
  setText("chat-error", "");
  $("chat-transcript").replaceChildren();
  $("agent-name").textContent = "Chat";
  try {
    const [c, models] = await Promise.all([api("GET", "/api/chats/" + enc(id)), chatView.models.length ? chatView.models : loadModels()]);
    if (chatView.id !== id) return;
    $("agent-name").textContent = c.title || "Chat";
    showSystem(c.system || "");
    const sel = $("chat-model");
    const opts = models.map((m) => el("option", { text: fmtModel(m), attrs: { value: m.id } }));
    if (c.model && !models.some((m) => m.id === c.model)) opts.unshift(el("option", { text: c.model + " (not installed)", attrs: { value: c.model } }));
    sel.replaceChildren(...opts);
    if (c.model) sel.value = c.model;
    $("chat-transcript").replaceChildren(...c.messages.map(chatMessageNode));
    chatPin(true);
    setGenerating(c.status === "generating");
    refreshChatGpu();
    const after = c.status === "generating" ? Math.max(0, (c.startSeq || 1) - 1) : c.seq || 0;
    let since = after;
    openStream("chat", () => "/api/chats/" + enc(id) + "/events?after=" + since, (ev) => {
      if (ev.seq) since = Math.max(since, ev.seq);
      onChatEvent(ev);
    });
  } catch (e) {
    setText("chat-error", e.message);
  }
}

function liveMessage() {
  if (chatView.live) return chatView.live;
  const near = chatNearBottom();
  const thinkingText = el("div", { cls: "thinking-text" });
  const thinking = el("details", { cls: "thinking", attrs: { hidden: "" } },
    el("summary", null, icon("spark"), el("span", { text: "Thinking" }), icon("chevron", "chev")), thinkingText);
  const bubble = el("div", { cls: "bubble agent" });
  const live = el("p", { cls: "msg-meta live", attrs: { "aria-hidden": "true" } });
  const msg = el("div", { cls: "msg pop" }, thinking, bubble, live);
  $("chat-transcript").append(msg);
  chatPin(near);
  chatView.live = { msg, bubble, thinking, thinkingText, live, raw: "", reasoning: "", count: 0, first: 0, shown: 0, load: null };
  showTyping(chatView.live, true);
  return chatView.live;
}

function onChatEvent(ev) {
  if (!ev || ev.type !== "chat" || ev.chatId !== chatView.id) return;
  const near = chatNearBottom();
  if (ev.kind === "start") {
    if (ev.regenerate) dropTrailingAnswers();
    chatView.live = null; chatView.liveModel = ev.model || null; liveMessage(); setGenerating(true);
  }
  else if (ev.kind === "load") showLoad(liveMessage(), ev);
  else if (ev.kind === "reasoning") {
    const v = liveMessage();
    tickSpeed(v);
    v.reasoning += ev.text || "";
    v.thinking.hidden = false;
    v.thinkingText.textContent = v.reasoning;
  } else if (ev.kind === "delta") {
    const v = liveMessage();
    tickSpeed(v);
    v.raw += ev.text || "";
    showTyping(v, false);
    renderMarkdown(v.bubble, v.raw);
  } else if (ev.kind === "done" || ev.kind === "stopped" || ev.kind === "error") {
    const v = chatView.live;
    if (v) {
      if (v.load) { v.load.node.remove(); v.load = null; }
      if (!v.raw) showTyping(v, false);
      v.live.remove();
      const meta = statsMeta(chatView.liveModel || $("chat-model").value, ev.stats, ev.kind === "stopped");
      if (meta && (v.raw || v.reasoning)) v.msg.append(meta);
      if (v.raw || v.reasoning) v.msg.append(msgActions(v.raw));
    }
    if (v && !v.raw && !v.reasoning) v.msg.remove();
    if (ev.kind !== "error") refreshChatGpu();
    if (ev.kind === "error") setText("chat-error", ev.error || "The model failed.");
    if (ev.kind === "done") pushNotice("Answer ready: " + ($("agent-name").textContent || "Chat"), v ? v.raw.slice(0, 200) : "");
    else if (ev.kind === "error") pushNotice("Chat failed", ev.error || "");
    chatView.live = null;
    setGenerating(false);
  }
  chatPin(near);
}

$("chat-text").addEventListener("input", updateChatSend);
$("chat-text").addEventListener("keydown", (ev) => {
  if (ev.key === "Enter" && (ev.ctrlKey || ev.metaKey)) { ev.preventDefault(); $("chat-compose").requestSubmit(); }
});
$("chat-model").addEventListener("change", () => {
  try { localStorage.setItem("arcflare.chatModel", $("chat-model").value); } catch (e) { /* storage off */ }
});

$("chat-compose").addEventListener("submit", async (ev) => {
  ev.preventDefault();
  const id = chatView.id;
  const box = $("chat-text");
  const text = box.value.trim();
  if (!id || !text || chatView.generating) return;
  box.value = "";
  setText("chat-error", "");
  const node = el("div", { cls: "bubble user pop", text });
  $("chat-transcript").append(node);
  chatPin(true);
  setGenerating(true);
  try {
    const model = $("chat-model").value || null;
    const c = await api("POST", "/api/chats/" + enc(id) + "/send", { text, model });
    if (c && c.title) $("agent-name").textContent = c.title;
  } catch (e) {
    node.remove();
    box.value = text;
    setGenerating(false);
    setText("chat-error", e.message);
  }
});

$("chat-stop").addEventListener("click", async () => {
  if (!chatView.id) return;
  const btn = $("chat-stop");
  const label = $("chat-stop-label");
  btn.disabled = true;
  label.textContent = chatView.generating ? "Stopping…" : "Unloading…";
  $("chat-bar").classList.add("is-working");
  setText("chat-error", "");
  try {
    const r = await api("POST", "/api/chats/" + enc(chatView.id) + "/stop", { unload: true });
    setText("chat-note", r.unloaded ? "Model unloaded" + (r.model ? ": " + r.model : "") + ". GPU memory freed." : "No model was loaded.");
    setGpu(false);
  } catch (e) { setText("chat-error", e.message); }
  btn.disabled = false;
  label.textContent = chatView.generating ? "Stop" : "Unload";
  $("chat-bar").classList.toggle("is-working", chatView.generating);
});

// ---- Devices screen ---------------------------------------------------------

// ---- Tools: the computer's MCP servers ---------------------------------------
// One switch per server. On means agents started from now on get its tools; each tool call is still an
// approval. Only an owner account can flip a switch (it starts a program on the computer).

const mcpView = { loaded: false, timer: 0, open: new Set() };

function openTools() {
  show("tools");
  $("tools-skeleton").hidden = mcpView.loaded;
  loadMcp();
}

async function loadMcp() {
  clearTimeout(mcpView.timer);
  try {
    const r = await api("GET", "/api/mcp");
    const list = (r && Array.isArray(r.servers)) ? r.servers : [];
    mcpView.loaded = true;
    $("tools-skeleton").hidden = true;
    $("tools-empty").hidden = list.length > 0;
    setText("tools-error", "");
    setText("tools-note", r && r.canEdit === false ? "Only an owner account can switch servers on or off." : "");
    $("mcp-list").replaceChildren(...list.map((s) => mcpRow(s, !!(r && r.canEdit))));
    // A server that is still connecting: look again shortly, while this screen is open.
    if (list.some((s) => s.status === "connecting") && !$("view-tools").hidden) mcpView.timer = setTimeout(loadMcp, 1500);
  } catch (e) {
    $("tools-skeleton").hidden = true;
    setText("tools-error", e.status === 404 ? "This hub is too old for MCP. Update ArcFlare on the computer." : e.message);
  }
}

const MCP_STATUS = { on: "Connected", connecting: "Connecting\u2026", error: "Failed", off: "Off" };

function mcpRow(s, canEdit) {
  const sw = el("input", { attrs: { type: "checkbox", role: "switch", "aria-label": "Use " + s.name } });
  sw.checked = !!s.enabled;
  sw.disabled = !canEdit || s.status === "connecting";
  sw.addEventListener("change", () => toggleMcp(s.name, sw.checked, sw));
  const meta = s.status === "on" ? s.tools + (s.tools === 1 ? " tool" : " tools") : MCP_STATUS[s.status] || s.status;
  const tools = el("ul", { cls: "mcp-tools" });
  const more = el("details", { cls: "mcp-more" }, el("summary", { text: "Show tools" }), tools);
  if (mcpView.open.has(s.name)) { more.open = true; loadMcpTools(s.name, tools); }
  more.addEventListener("toggle", () => {
    if (more.open) { mcpView.open.add(s.name); loadMcpTools(s.name, tools); } else mcpView.open.delete(s.name);
  });
  const retry = s.enabled && canEdit && (s.status === "error" || s.status === "on")
    ? el("button", { cls: "btn outline sm", text: s.status === "error" ? "Retry" : "Restart", attrs: { type: "button" },
        on: { click: (e) => restartMcp(s.name, e.currentTarget) } })
    : null;
  return el("li", { cls: "card dev mcp" },
    el("div", { cls: "dev-top" },
      el("span", { cls: "dev-ico" }, icon("wrench")),
      el("div", { cls: "dev-body" },
        el("p", { cls: "dev-name" }, el("span", { text: s.name }), el("span", { cls: "tier", text: s.transport === "http" ? "hosted" : "local" })),
        el("p", { cls: "dev-meta mcp-st mcp-" + s.status, text: meta }),
        s.error ? el("p", { cls: "dev-meta sub", text: s.error }) : null),
      el("label", { cls: "switch" }, sw, el("span", { cls: "switch-ui", attrs: { "aria-hidden": "true" } }))),
    s.status === "on" || retry ? el("div", { cls: "mcp-foot" }, s.status === "on" ? more : el("span"), retry) : null);
}

async function toggleMcp(name, on, sw) {
  sw.disabled = true;
  setText("tools-error", "");
  try {
    await api("POST", "/api/mcp/" + encodeURIComponent(name), { enabled: on });
  } catch (e) {
    setText("tools-error", e.message);
  }
  loadMcp();
}

async function restartMcp(name, btn) {
  btn.disabled = true;
  btn.textContent = "Connecting\u2026";
  setText("tools-error", "");
  try { await api("POST", "/api/mcp/" + encodeURIComponent(name) + "/restart", {}); } catch (e) { setText("tools-error", e.message); }
  loadMcp();
}

async function loadMcpTools(name, ul) {
  if (ul.dataset.loaded) return;
  ul.replaceChildren(el("li", { cls: "dev-meta sub", text: "Loading\u2026" }));
  try {
    const list = await api("GET", "/api/mcp/" + encodeURIComponent(name) + "/tools");
    ul.dataset.loaded = "1";
    ul.replaceChildren(...(Array.isArray(list) ? list : []).map((t) =>
      el("li", { cls: "mcp-tool" }, el("code", { text: t.name }), t.description ? el("span", { cls: "dev-meta sub", text: t.description }) : null)));
    if (!ul.children.length) ul.append(el("li", { cls: "dev-meta sub", text: "No tools." }));
  } catch (e) {
    ul.replaceChildren(el("li", { cls: "dev-meta sub", text: e.message }));
  }
}

function openDevices() {
  show("devices");
  $("dev-skeleton").hidden = state.sessionsLoaded;
  loadSessions();
  loadAccount();
  checkAppUpdate();
}

// ---- App update (phone app only) -------------------------------------------
// The hub offers the newest build of the phone app (`arcflare phone app publish`). The app downloads it in
// parts over the same connection as everything else; the native side checks size and SHA-256, and Android
// installs it only if it is signed with the installed app's key, after the user confirms.

const appUpdate = { offer: null, busy: false };

function updater() {
  const n = window.ArcFlareNative;
  return n && typeof n.appUpdater === "function" ? n.appUpdater() : null;
}

async function checkAppUpdate() {
  const u = updater();
  const box = $("app-update");
  if (!u || appUpdate.busy) return;
  try {
    const [mine, offer] = await Promise.all([u.info(), api("GET", "/api/app/version")]);
    if (!offer || !offer.available || !(Number(offer.versionCode) > Number(mine.versionCode))) { box.hidden = true; return; }
    appUpdate.offer = offer;
    setText("app-update-error", "");
    $("app-update-text").textContent = "Version " + offer.versionName + " is ready (" + (offer.size / 1048576).toFixed(1) +
      " MB). You have " + mine.versionName + "." + (mine.canInstall ? "" : " First allow ArcFlare to install apps: the button opens that setting.");
    $("app-update-btn").textContent = mine.canInstall ? "Install update" : "Allow installs";
    $("app-update-btn").dataset.allow = mine.canInstall ? "" : "1";
    box.hidden = false;
  } catch (e) {
    box.hidden = true; // an old hub without /api/app/version, or offline: nothing to offer
  }
}

async function installAppUpdate() {
  const u = updater();
  const offer = appUpdate.offer;
  if (!u || !offer || appUpdate.busy) return;
  const btn = $("app-update-btn");
  if (btn.dataset.allow) { await u.openInstallSettings(); return; }
  appUpdate.busy = true;
  btn.disabled = true;
  setText("app-update-error", "");
  try {
    if (!/^[0-9a-f]{64}$/.test(String(offer.sha256)) || !(offer.parts > 0) || offer.parts > 1000) throw new Error("The hub sent a malformed update.");
    await u.begin({ size: offer.size, sha256: offer.sha256 });
    for (let i = 0; i < offer.parts; i++) {
      btn.textContent = "Downloading " + Math.round((i / offer.parts) * 100) + "%";
      const p = await api("GET", "/api/app/apk?part=" + i);
      // The file must not change under us: every part names the hash of the file it came from.
      if (!p || p.part !== i || p.sha256 !== offer.sha256 || typeof p.data !== "string") throw new Error("The update changed on the hub while downloading. Try again.");
      await u.write(p.data);
    }
    btn.textContent = "Installing…";
    const r = await u.commit(); // Android shows its own confirmation; this resolves when it is done
    if (!r || r.status !== "installed") throw new Error("The update was not installed" + (r && r.message ? ": " + r.message : "."));
  } catch (e) {
    try { await u.abort(); } catch (x) { /* nothing to abandon */ }
    setText("app-update-error", e.message || String(e));
    btn.textContent = "Install update";
  } finally {
    appUpdate.busy = false;
    btn.disabled = false;
  }
}

$("app-update-btn").addEventListener("click", installAppUpdate);

async function loadSessions() {
  try {
    const list = asList(await api("GET", "/api/sessions"), "sessions");
    state.sessionsLoaded = true;
    $("dev-skeleton").hidden = true;
    $("session-list").replaceChildren(...list.map(sessionRow));
    setText("dev-error", "");
  } catch (e) {
    $("dev-skeleton").hidden = true;
    setText("dev-error", e.message);
  }
}

// "Chrome on Android" instead of the raw user-agent string.
function friendlyDevice(ua) {
  const s = String(ua || "");
  if (!s) return "Unknown device";
  const os = /Android/i.test(s) ? "Android" : /iPhone|iPad|iOS/i.test(s) ? "iOS" : /Windows/i.test(s) ? "Windows"
    : /Mac OS X|Macintosh/i.test(s) ? "macOS" : /CrOS/.test(s) ? "ChromeOS" : /Linux/i.test(s) ? "Linux" : "";
  const br = /Edg\//.test(s) ? "Edge" : /OPR\/|Opera/.test(s) ? "Opera" : /Firefox\/|FxiOS/.test(s) ? "Firefox"
    : /SamsungBrowser/.test(s) ? "Samsung Internet" : /Chrome\/|CriOS/.test(s) ? "Chrome" : /Safari\//.test(s) ? "Safari" : "";
  // Android user agents carry the model: "(Linux; Android 14; Pixel 7)".
  const model = (/Android[^;)]*;\s*([^;)]+)\)/.exec(s) || [])[1];
  const name = model && model.replace(/\s*Build\/.*$/, "").trim();
  if (name && !/^(K|Mobile)$/.test(name)) return name + (br || os ? " \u00b7 " + (br || os) : "");
  if (br && os) return br + " on " + os;
  return br || os || s.slice(0, 48);
}

function sessionRow(s) {
  const phone = /Android|iPhone|iPad|Mobile/i.test(String(s.device || ""));
  return el("li", { cls: "card dev" },
    el("div", { cls: "dev-top" },
      el("span", { cls: "dev-ico" }, icon(phone ? "phone" : "monitor")),
      el("div", { cls: "dev-body" },
        el("p", { cls: "dev-name" },
          el("span", { text: friendlyDevice(s.device) }),
          s.current ? el("span", { cls: "badge", text: "This device" }) : null),
        el("p", { cls: "dev-meta", text: "Last seen " + ago(s.lastSeen) }),
        el("p", { cls: "dev-meta sub", text: (s.ip || "unknown address") + " · signed in " + ago(s.created) }))),
    s.current ? null : el("div", { cls: "dev-foot" },
      el("button", { cls: "btn danger", text: "Revoke", attrs: { type: "button" }, on: { click: () => revoke(s.id) } })));
}

async function revoke(id) {
  try {
    await api("DELETE", "/api/sessions/" + enc(id));
    loadSessions();
  } catch (e) {
    setText("dev-error", e.message);
  }
}

$("revoke-others").addEventListener("click", () => openSheet("sheet-confirm", true, "confirm-cancel"));
$("confirm-cancel").addEventListener("click", () => closeSheet("sheet-confirm"));
$("confirm-ok").addEventListener("click", async () => {
  closeSheet("sheet-confirm");
  try {
    await api("POST", "/api/sessions/revoke-others", {});
    setText("dev-error", "");
  } catch (e) {
    setText("dev-error", e.message);
  }
  loadSessions();
});

async function logout() {
  loggingOut = true;
  try { await api("POST", "/api/logout", {}); }
  catch (e) { /* signed out locally either way */ }
  signedOut("Signed out.");
  loggingOut = false;
}

$("logout").addEventListener("click", logout);

// ---- Account ------------------------------------------------------------------

function acctMsg(err, note) { setText("acct-error", err || ""); setText("acct-note", note || ""); }

async function loadAccount() {
  try {
    const a = await api("GET", "/api/account");
    $("acct-name").textContent = a.username;
    $("acct-role").textContent = a.role || "";
    $("acct-role").className = "tier tier-" + (a.role === "owner" ? "hard" : "light");
    $("acct-meta").textContent = a.created ? "Created " + new Date(a.created).toLocaleDateString() : "";
    const others = Array.isArray(a.others) ? a.others : null;
    $("acct-others").hidden = !others;
    if (others) {
      $("acct-list").replaceChildren(...(others.length ? others.map(accountRow) : [el("li", { cls: "dev-meta", text: "No other accounts." })]));
    }
  } catch (e) { acctMsg(e.message); }
}

function accountRow(u) {
  let armed = 0;
  const btn = el("button", { cls: "btn danger sm", text: "Remove", attrs: { type: "button" } });
  btn.addEventListener("click", async () => {
    acctMsg();
    const pw = $("acct-owner-pw").value;
    if (!pw) { $("acct-owner-pw").focus(); return acctMsg("Enter your password first."); }
    if (Date.now() - armed > 4000) { armed = Date.now(); btn.textContent = "Tap again to remove"; return; }
    btn.disabled = true;
    try {
      await api("POST", "/api/accounts/" + enc(u.username) + "/delete", { password: pw });
      $("acct-owner-pw").value = "";
      acctMsg("", u.username + " was removed and signed out everywhere.");
      loadAccount();
    } catch (e) { acctMsg(e.message); btn.disabled = false; btn.textContent = "Remove"; }
  });
  return el("li", { cls: "acct-row" },
    el("span", { cls: "acct-row-name", text: u.username }),
    el("span", { cls: "tier tier-" + (u.role === "owner" ? "hard" : "light"), text: u.role || "user" }), btn);
}

$("acct-pw-form").addEventListener("submit", async (ev) => {
  ev.preventDefault();
  acctMsg();
  const cur = $("acct-pw-cur").value, next = $("acct-pw-new").value;
  if (next !== $("acct-pw-new2").value) return acctMsg("The new passwords do not match.");
  if (next.length < 8) return acctMsg("Use at least 8 characters.");
  $("acct-pw-btn").disabled = true;
  try {
    await api("POST", "/api/account/password", { password: cur, next });
    ev.target.reset();
    signedOut("Password changed. Sign in with the new one.");
  } catch (e) { acctMsg(e.message); }
  $("acct-pw-btn").disabled = false;
});

$("acct-del-form").addEventListener("submit", async (ev) => {
  ev.preventDefault();
  acctMsg();
  if (!$("acct-del-sure").checked) return acctMsg("Tick the box to confirm.");
  $("acct-del-btn").disabled = true;
  try {
    await api("POST", "/api/account/delete", { password: $("acct-del-pw").value });
    ev.target.reset();
    signedOut("Your account was deleted.");
  } catch (e) { acctMsg(e.message); }
  $("acct-del-btn").disabled = false;
});

// ---- Sign-in and boot -------------------------------------------------------

$("login-form").addEventListener("submit", async (ev) => {
  ev.preventDefault();
  setText("login-error", "");
  try {
    const me = await api("POST", "/api/login", {
      username: $("login-user").value.trim().toLowerCase(),
      password: $("login-pass").value,
      device: (navigator.userAgent || "Browser").slice(0, 120),
    });
    $("login-pass").value = "";
    signIn(me);
    route();
  } catch (e) {
    const secs = e.body && e.body.retryAfterSec;
    setText("login-error", e.status === 429 && secs
      ? "Too many attempts. Try again in " + secs + (secs === 1 ? " second." : " seconds.")
      : e.message);
  }
});

// Copy the setup command. clipboard needs a secure context, which a plain-http
// LAN address is not, so fall back to a hidden textarea and execCommand; if that
// fails too the command is selected so a long press can copy it.
$("copy-cmd").addEventListener("click", async () => {
  const text = $("login-cmd").textContent;
  let ok = false;
  try { await navigator.clipboard.writeText(text); ok = true; } catch (e) { ok = false; }
  if (!ok) {
    try {
      const ta = el("textarea", { cls: "sr-only", attrs: { readonly: "", "aria-hidden": "true", tabindex: "-1" }, text });
      document.body.append(ta);
      ta.select();
      ok = document.execCommand("copy");
      ta.remove();
    } catch (e) { ok = false; }
  }
  if (!ok) {
    const r = document.createRange();
    r.selectNodeContents($("login-cmd"));
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(r);
  }
  const btn = $("copy-cmd");
  btn.setAttribute("aria-label", ok ? "Copied" : "Press and hold to copy");
  btn.replaceChildren(icon(ok ? "check" : "copy"));
  setTimeout(() => { btn.setAttribute("aria-label", "Copy command"); btn.replaceChildren(icon("copy")); }, 1800);
});

async function checkSetup() {
  try {
    const st = await api("GET", "/api/status");
    if (!st.setup) {
      $("login-fields").hidden = true;
      $("login-note").hidden = false;
    }
  } catch (e) {
    setText("login-error", e.message);
  }
}

// When the on-screen keyboard is up, give the conversation the room: hide the
// bottom bar and the FAB. (A visualViewport much shorter than the screen.)
if (window.visualViewport) {
  window.visualViewport.addEventListener("resize", () => {
    const small = window.visualViewport.height < window.screen.height * 0.7 && window.innerWidth <= window.screen.width;
    document.body.classList.toggle("kbd", small);
  });
}

async function boot() {
  try {
    signIn(await api("GET", "/api/me"));
  } catch (e) {
    if (e.status === 401) await checkSetup();
    else setText("login-error", e.message);
  }
  route();
}

window.addEventListener("hashchange", route);
boot();

// ---- Open-source licenses ----------------------------------------------------
$("open-licenses").addEventListener("click", async () => {
  openSheet("sheet-licenses", true, "licenses-close");
  try {
    const r = await fetch("assets/LICENSES.txt", { cache: "no-store" });
    $("licenses-text").textContent = r.ok ? await r.text() : "Could not load the licence texts.";
  } catch (e) {
    $("licenses-text").textContent = "Could not load the licence texts.";
  }
});
$("licenses-close").addEventListener("click", () => closeSheet("sheet-licenses"));
