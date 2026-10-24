// ArcFlare Hub phone UI: sign-in, the agent list, one agent's live transcript,
// and the list of signed-in devices.
//
// Why plain DOM code: the hub serves this page from the computer itself, often
// with no internet, and its CSP allows only same-origin scripts. So there is
// no framework and no build step, just this file.
//
// Why textContent everywhere: agent output, file names and device labels come
// from the model and the disk. Nodes are built with createElement and
// textContent, so none of that text can be read as markup.
//
// Why the CSRF token is a variable: it goes back on every write request and
// dies with the page. A reload asks /api/me for a fresh one. The session itself
// is an HttpOnly cookie that this script cannot read.
//
// Why the transcript resumes by seq: the stream replays everything after the
// last seq we rendered, so a dropped connection (a phone moving between Wi-Fi
// and mobile data, say) loses nothing and shows nothing twice.

"use strict";

const TIERS = ["light", "standard", "hard"];
const STREAM_TYPES = ["status", "delta", "tool", "tool_result", "approval", "approval_resolved", "turn_end", "error"];
let loggingOut = false; // set while an explicit log out is in flight
const STATUS_TEXT = {
  stopped: "Stopped", starting: "Starting", idle: "Ready", busy: "Working", running: "Working",
  waiting_approval: "Needs approval", error: "Error",
};

const state = { user: null, csrf: null, streams: {}, agent: null, listTimer: 0, focusCompose: false };

const $ = (id) => document.getElementById(id);
const enc = (s) => encodeURIComponent(String(s));

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

function show(name) {
  for (const v of ["login", "dashboard", "agent", "devices"]) $("view-" + v).hidden = v !== name;
  $("topbar").hidden = name === "login";
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
  state.user = null;
  state.csrf = null;
  $("login-fields").hidden = false;
  setText("login-note", "");
  setText("login-error", message);
  show("login");
}

function signIn(me) {
  state.user = me.user;
  state.csrf = me.csrf;
  if (!state.streams.dash) openStream("dash", () => "/api/events", scheduleList);
}

function route() {
  if (!state.user) return show("login");
  const m = /^#\/agent\/([^/]+)$/.exec(location.hash);
  if (m) return openAgent(decodeURIComponent(m[1]));
  stopAgent();
  if (location.hash === "#/devices") return openDevices();
  return openDashboard();
}

// Helpers for the scroll position: follow new output only if the reader is
// already near the bottom, so reading older lines is not interrupted.
function nearBottom() {
  return window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 160;
}
function pin(near) {
  if (near) window.scrollTo(0, document.documentElement.scrollHeight);
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

function when(v) {
  if (!v) return "unknown";
  const d = new Date(v);
  return isNaN(d.getTime()) ? String(v) : d.toLocaleString();
}

function asList(data, key) {
  if (Array.isArray(data)) return data;
  return (data && Array.isArray(data[key])) ? data[key] : [];
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

// ---- Dashboard ------------------------------------------------------------

function openDashboard() {
  show("dashboard");
  loadAgents();
}

function scheduleList() {
  clearTimeout(state.listTimer);
  state.listTimer = setTimeout(() => { if (!$("view-dashboard").hidden) loadAgents(); }, 250);
}

async function loadAgents() {
  try {
    const list = asList(await api("GET", "/api/agents"), "agents");
    $("agent-list").replaceChildren(...list.map(agentCard));
    $("dash-empty").hidden = list.length > 0;
    setText("dash-error", "");
  } catch (e) {
    setText("dash-error", e.message);
  }
}

function agentCard(a) {
  const tier = TIERS.includes(a.tier) ? a.tier : "standard";
  const id = enc(a.id);
  const running = a.status !== "stopped";
  return el("li", { cls: "card" },
    el("div", { cls: "row between" },
      el("a", { cls: "agent-name", text: a.name, attrs: { href: "#/agent/" + id } }),
      el("span", { cls: "tier tier-" + tier, text: tier })),
    el("p", { cls: "meta" },
      el("span", { cls: "dot " + dotClass(a.status, a.pendingApproval), attrs: { "aria-hidden": "true" } }),
      el("span", { text: statusLabel(a.status, a.pendingApproval) })),
    el("p", { cls: "folder", text: a.cwd }),
    el("p", { cls: "last", text: lastLine(a.lastText) || "No messages yet." }),
    el("div", { cls: "actions" },
      running
        ? el("button", { cls: "btn", text: "Stop", attrs: { type: "button" },
            on: { click: () => act(a.id, "stop", {}, "dash-error").then(loadAgents) } })
        : el("button", { cls: "btn primary", text: "Start", attrs: { type: "button" },
            on: { click: () => act(a.id, "start", {}, "dash-error").then(loadAgents) } }),
      el("a", { cls: "btn", text: "Wake", attrs: { href: "#/agent/" + id },
        on: { click: () => { state.focusCompose = true; } } })));
}

$("new-form").addEventListener("submit", async (ev) => {
  ev.preventDefault();
  const name = $("new-name").value.trim();
  const cwd = $("new-cwd").value.trim();
  const task = $("new-task").value.trim();
  if (!name || !cwd) return setText("new-error", "Give the agent a name and a folder.");
  const body = { name, cwd, tier: $("new-tier").value };
  if (task) body.task = task;
  const submit = $("new-submit");
  submit.disabled = true;
  setText("new-error", "");
  try {
    const agent = await api("POST", "/api/agents", body);
    ev.target.reset();
    if (task && agent && agent.id) location.hash = "#/agent/" + enc(agent.id);
    else loadAgents();
  } catch (e) {
    setText("new-error", e.message);
  } finally {
    submit.disabled = false;
  }
});

// ---- One agent ------------------------------------------------------------

function openAgent(id) {
  stopAgent();
  show("agent");
  const view = {
    id, lastSeq: 0, approvalId: null, turnText: false,
    bubble: null, content: null, reasoning: null, reasoningBox: null,
  };
  state.agent = view;
  $("transcript").replaceChildren();
  $("agent-name").textContent = "Loading...";
  $("agent-status").textContent = "Connecting";
  setText("agent-error", "");
  showApproval(null);
  openStream("agent", () => "/api/agents/" + enc(id) + "/events?after=" + view.lastSeq,
    (ev) => onAgentEvent(view, ev));
  loadAgent(view);
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
}

// The approval card is the one thing on this screen that must not be missed,
// so it stays pinned at the top while the transcript scrolls under it.
function showApproval(p) {
  if (state.agent) state.agent.approvalId = p ? p.id : null;
  $("approval").hidden = !p;
  setApprovalBusy(false);
  if (!p) return;
  $("approval-kind").textContent = p.kind || "Action";
  $("approval-detail").textContent = p.detail || "";
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

// Transcript rendering. A content delta streams into the open assistant
// bubble; a tool line or a turn end closes it, so text after a tool call starts
// a new bubble below the tool line.
function startBubble(view) {
  const near = nearBottom();
  view.reasoning = el("div", { cls: "reasoning-text" });
  view.reasoningBox = el("details", { cls: "reasoning", attrs: { hidden: "" } },
    el("summary", { text: "Thinking" }), view.reasoning);
  view.content = el("div", { cls: "content" });
  view.bubble = el("div", { cls: "bubble assistant" }, view.reasoningBox, view.content);
  $("transcript").append(view.bubble);
  pin(near);
}

function endBubble(view) {
  view.bubble = view.content = view.reasoning = view.reasoningBox = null;
}

function appendDelta(view, kind, text) {
  if (!text) return;
  const near = nearBottom();
  if (!view.bubble) startBubble(view);
  if (kind === "reasoning") {
    view.reasoningBox.hidden = false;
    view.reasoning.append(text);
  } else {
    view.turnText = true;
    view.content.append(text);
  }
  pin(near);
}

function addLine(view, kind, text) {
  endBubble(view);
  const near = nearBottom();
  $("transcript").append(el("div", { cls: "line " + kind, text }));
  pin(near);
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
    case "delta":
      appendDelta(view, ev.kind, ev.text);
      break;
    case "tool":
      addLine(view, "tool", "→ " + ev.name + (ev.detail ? "  " + ev.detail : ""));
      break;
    case "tool_result": {
      const text = typeof ev.error === "string" ? ev.error : (ev.line || "");
      addLine(view, ev.error ? "error" : "result", "← " + ev.name + (text ? ": " + text : ""));
      break;
    }
    case "approval":
      showApproval(ev);
      addLine(view, "notice", "Waiting for approval: " + (ev.kind || "action"));
      break;
    case "approval_resolved":
      if (view.approvalId === ev.id) showApproval(null);
      addLine(view, "notice", (ev.allow ? "Allowed" : "Denied") + (ev.reason ? " (" + ev.reason + ")" : ""));
      break;
    case "turn_end":
      endBubble(view);
      if (ev.ok === false) {
        addLine(view, "error", ev.text || "The turn failed.");
      } else if (ev.text && !view.turnText) {
        startBubble(view);
        view.content.append(ev.text);
        endBubble(view);
      }
      view.turnText = false;
      break;
    case "error":
      addLine(view, "error", ev.text || "Something went wrong.");
      break;
    default:
      break; // unknown types are ignored, so the server can add more
  }
}

$("compose").addEventListener("submit", async (ev) => {
  ev.preventDefault();
  const view = state.agent;
  const box = $("compose-text");
  const text = box.value.trim();
  if (!view || !text) return;
  box.value = "";
  setText("agent-error", "");
  const near = nearBottom();
  endBubble(view);
  const bubble = el("div", { cls: "bubble user", text });
  $("transcript").append(bubble);
  pin(near);
  try {
    await api("POST", "/api/agents/" + enc(view.id) + "/wake", { text });
  } catch (e) {
    bubble.remove();
    box.value = text;
    setText("agent-error", e.message);
  }
});

$("approve-allow").addEventListener("click", () => decide(true));
$("approve-deny").addEventListener("click", () => decide(false));
$("agent-stop").addEventListener("click", () => {
  const view = state.agent;
  if (view) act(view.id, "stop", {}, "agent-error").then(() => loadAgent(view));
});

// ---- Devices --------------------------------------------------------------

function openDevices() {
  show("devices");
  loadSessions();
}

async function loadSessions() {
  try {
    const list = asList(await api("GET", "/api/sessions"), "sessions");
    $("session-list").replaceChildren(...list.map(sessionRow));
    setText("dev-error", "");
  } catch (e) {
    setText("dev-error", e.message);
  }
}

function sessionRow(s) {
  return el("li", { cls: "card row" },
    el("div", { cls: "grow" },
      el("p", { cls: "row-title", text: s.device || "Unknown device" }),
      el("p", { cls: "meta", text: (s.ip || "unknown address") + " · signed in " + when(s.created) }),
      el("p", { cls: "meta", text: "Last seen " + when(s.lastSeen) }),
      s.current ? el("span", { cls: "tier tier-standard", text: "This device" }) : null),
    el("button", { cls: "btn danger", text: s.current ? "Log out" : "Revoke", attrs: { type: "button" },
      on: { click: () => (s.current ? logout() : revoke(s.id)) } }));
}

async function revoke(id) {
  try {
    await api("DELETE", "/api/sessions/" + enc(id));
    loadSessions();
  } catch (e) {
    setText("dev-error", e.message);
  }
}

$("revoke-others").addEventListener("click", async () => {
  if (!window.confirm("Sign out every other device?")) return;
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

// ---- Sign-in and boot -----------------------------------------------------

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

async function checkSetup() {
  try {
    const st = await api("GET", "/api/status");
    if (!st.setup) {
      $("login-fields").hidden = true;
      setText("login-note", "No account yet. On the computer run: arcflare phone user add");
    }
  } catch (e) {
    setText("login-error", e.message);
  }
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
