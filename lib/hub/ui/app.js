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

"use strict";

const STREAM_TYPES = ["status", "user", "delta", "tool", "tool_result", "approval", "approval_resolved", "turn_end", "error"];
let loggingOut = false; // set while an explicit log out is in flight
const STATUS_TEXT = {
  stopped: "Stopped", starting: "Starting", idle: "Ready", busy: "Working", running: "Working",
  waiting_approval: "Needs approval", error: "Error",
};
const CONN = { home: "Home network", relay: "Relay" };

const state = {
  user: null, csrf: null, streams: {}, agent: null, listTimer: 0, focusCompose: false,
  agentsLoaded: false, sessionsLoaded: false, menuAgent: null,
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
  try { res = await fetch(path, opts); }
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
    s.es = new EventSource(urlFn());
    s.es.onopen = () => { s.delay = 1000; };
    s.es.onmessage = handle;
    for (const t of STREAM_TYPES) s.es.addEventListener(t, handle);
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

// "home" while the phone talks to the hub over the local network. The tunnel
// can later call arcflareSetConnection("relay") and the chip follows.
function setConnection(kind) {
  const k = Object.prototype.hasOwnProperty.call(CONN, kind) ? kind : "home";
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
  for (const v of ["login", "dashboard", "agent", "devices"]) $("view-" + v).hidden = v !== name;
  const inApp = name !== "login";
  $("topbar").hidden = !inApp;
  $("bottomnav").hidden = !inApp;
  $("fab-new").hidden = name !== "dashboard";
  $("tb-brand").hidden = name === "agent";
  $("tb-agent").hidden = name !== "agent";
  $("conn-chip").hidden = name === "agent";
  const tab = name === "devices" ? "tab-devices" : "tab-agents";
  for (const id of ["tab-agents", "tab-devices"]) {
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
  setConnection("home");
  if (!state.streams.dash) openStream("dash", () => "/api/events", scheduleList);
}

function route() {
  closeModalNow();
  if (!state.user) return show("login");
  const m = /^#\/agent\/([^/]+)$/.exec(location.hash);
  if (m) return openAgent(decodeURIComponent(m[1]));
  stopAgent();
  if (location.hash === "#/devices") return openDevices();
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

function scheduleList() {
  clearTimeout(state.listTimer);
  state.listTimer = setTimeout(() => { if (!$("view-dashboard").hidden) loadAgents(); }, 250);
}

async function loadAgents() {
  try {
    const list = asList(await api("GET", "/api/agents"), "agents");
    state.agentsLoaded = true;
    $("dash-skeleton").hidden = true;
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
$("fab-new").addEventListener("click", () => {
  setText("new-error", "");
  openSheet("sheet-new", true);
});

$("new-form").addEventListener("submit", async (ev) => {
  ev.preventDefault();
  const name = $("new-name").value.trim();
  const cwd = $("new-cwd").value.trim();
  const task = $("new-task").value.trim();
  if (!name || !cwd) return setText("new-error", "Give the agent a name and a folder.");
  const tierInput = $("new-form").querySelector("input[name=tier]:checked");
  const body = { name, cwd, tier: tierInput ? tierInput.value : "standard" };
  if (task) body.task = task;
  const submit = $("new-submit");
  submit.disabled = true;
  setText("new-error", "");
  try {
    const agent = await api("POST", "/api/agents", body);
    ev.target.reset();
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
  $("agent-stop").hidden = !live;
  $("agent-start").hidden = live;
}

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
  $("approval-title").textContent = /bash|shell|exec|command|run/i.test(kind) ? "Allow this command?" : "Allow this action?";
  $("approval-kind").textContent = kind;
  $("approval-detail").textContent = p.detail || "";
  $("approval-detail").scrollTop = 0;
  if (!modal || modal.id !== "approval") openSheet("approval", false);
  $("agent-status").textContent = "Needs approval";
  $("agent-dot").className = "dot dot-wait";
  $("agent-statusbar").className = "statusbar is-wait";
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

function inlineNodes(text) {
  const out = [];
  const re = /`([^`\n]+)`/g;
  let last = 0, m;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(document.createTextNode(text.slice(last, m.index)));
    out.push(el("code", { text: m[1] }));
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
      addNotice(view, ev.allow ? "ok" : "no", (ev.allow ? "Allowed" : "Denied") + (ev.reason ? " (" + ev.reason + ")" : ""));
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

// ---- Devices screen ---------------------------------------------------------

function openDevices() {
  show("devices");
  $("dev-skeleton").hidden = state.sessionsLoaded;
  loadSessions();
}

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
      ? "Too many attempts. Try again in " + secs + " seconds."
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
