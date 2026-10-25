// ArcFlare app shell controller. No secrets are logged, put in URLs or put in Web Storage:
// the pairing link only lives in a local variable until pairing finishes or is cancelled.
//
// The WebView only ever shows the bundled app (https://localhost). This page decides, on every launch, how the
// bundled UI reaches the hub: through the tunnel over the home network ("home"), or through the internet relay
// ("relay"); see mode.js and connector.js. It never navigates anywhere else.
(function () {
  "use strict";

  var Link = window.ArcFlareLink, Mode = window.ArcFlareMode, Store = window.ArcFlareStore;
  var FP = window.ArcFlareFingerprint, Native = window.ArcFlareNative, Connector = window.ArcFlareConnector;
  var LanFetch = window.ArcFlareLanFetch, LinkGate = window.ArcFlareLinkGate;
  var CFG = window.ARCFLARE_CONFIG || {};
  var $ = function (id) { return document.getElementById(id); };
  var now = function () { return Date.now(); };

  // The pairing in progress, from "link accepted" until it is confirmed on the computer, cancelled or failed:
  //   { raw, stage: "starting"|"confirm"|"pairing"|"code"|"failed", value, canonical, fp, oldFp, hadPairing,
  //     enableAt, device }
  // `raw` is the exact link text that started it: the pending pairing is bound to it. The NEW device only exists in
  // memory (`device`); the stored pairing (if any) is untouched until the computer has approved the new one.
  var flow = null;
  var record = null;         // stored pairing record while the status screen is up
  var busy = false;
  var bootGen = 0;           // a newer boot or a pairing flow cancels an older boot before it navigates
  var unsupported = false;   // WebView without X25519
  var held = null;           // { url, at }: a link that arrived while the app was in the background
  var gate = LinkGate.create({ now: now });

  var deps = {
    get Tunnel() { return window.ArcFlareTunnel; },
    // The ONLY use of the native HTTP stack: a fetch that refuses everything except the stored LAN base's mailbox.
    lanFetch: function (lanBase, o) { return LanFetch.create({ http: Native.nativeHttp(), lanBase: lanBase, refuse: o && o.refuse }); },
  };

  function show(id) {
    var all = document.querySelectorAll("[data-view]");
    for (var i = 0; i < all.length; i++) all[i].hidden = all[i].id !== id;
    var v = $(id);
    if (v) v.scrollTop = 0;
  }
  function setError(id, msg) { var e = $(id); e.textContent = msg || ""; e.hidden = !msg; }
  function setNotice(id, msg) { var e = $(id); e.textContent = msg || ""; e.hidden = !msg; }
  function hostOf(url) { try { return new URL(url).host; } catch (e) { return ""; } }

  var TOO_OLD = "This phone's Android System WebView is too old for the secure tunnel (it needs version 133 or newer). Update it in Google Play and try again.";
  // A record from a build before the home network had its own token: relay only until the phone is paired again.
  var REPAIR = "This phone was paired before the home network had its own key, so it cannot use the home network yet. Re-pair to use the home network. (Through the relay it still works.)";
  var repairAck = false;     // the person chose to continue via the relay for this launch
  var statusAck = false;     // the status screen on show is that notice (its main button continues via the relay)
  var IGNORED = "Another pairing link arrived while this one was open and was ignored. Finish or cancel this one first.";

  // ---------------------------------------------------------------- pairing

  function showPairScreen(error) {
    flow = null;
    $("pair-link").value = "";
    setError("pair-error", error);
    show("v-pair");
  }

  /** Back to where the person was: their existing pairing's settings screen, or the pairing screen. */
  async function leaveFlow() {
    var had = flow && flow.hadPairing;
    flow = null;
    if (had) await boot({ settings: true }); else showPairScreen("");
  }

  async function onLinkText(text) {
    if (flow) return;                                          // one pairing at a time
    flow = { raw: text, stage: "starting" };                   // claimed synchronously: the same link twice is one flow
    bootGen++;                                                 // an unfinished boot must not navigate away from this
    var mine = flow;
    var r = Link.validateLink(text, { dev: !!CFG.allowLoopbackDev });
    if (!r.ok) { showPairScreen(r.error); return; }            // nothing stored, nothing sent
    var fp, oldFp = "", had = false;
    try { fp = await FP.fingerprint(r.value.hubKey); } catch (e) { showPairScreen("The link is damaged (computer key)."); return; }
    try {
      var existing = await Store.load();
      if (Mode.isPairedRecord(existing)) { had = true; oldFp = await FP.fingerprint(existing.hubKey).catch(function () { return ""; }); }
    } catch (e) { /* no readable pairing: treat as a first pairing */ }
    if (flow !== mine) return;
    flow = { raw: text, stage: "confirm", value: r.value, canonical: r.canonical, fp: fp, oldFp: oldFp, hadPairing: had, enableAt: 0, device: null };
    renderConfirm();
  }

  function renderConfirm() {
    var f = flow, v = f.value;
    $("cf-fp").textContent = f.fp;
    $("cf-relay").textContent = v.relayIsLan ? "Not used (the internet relay is off)" : v.relayHost;
    $("cf-lan").textContent = v.lan || "";
    $("cf-lan-row").hidden = !v.lan;
    $("cf-old-row").hidden = !f.hadPairing;
    $("cf-old-fp").textContent = f.oldFp;
    if (f.hadPairing) {
      $("cf-title").textContent = "Replace this computer?";
      $("cf-lead").textContent = "Replace the computer " + f.oldFp + " with " + f.fp + "? Only continue if you just scanned this on your own computer. Your current pairing stays as it is until the computer has approved the new one.";
    } else {
      $("cf-title").textContent = "Pair with this computer?";
      $("cf-lead").textContent = "Pair with the computer showing fingerprint " + f.fp.split(" ")[0] + "…? Only continue if you just scanned this on your own computer.";
    }
    setNotice("cf-notice", "");
    // Replacing an existing pairing takes a deliberate act: type the first 4 characters of the OLD fingerprint. A
    // phishing link cannot do that for the person, and having to read the old fingerprint makes "Replace" register.
    $("cf-type-row").hidden = !f.hadPairing;
    $("cf-type").value = "";
    // The Pair button stays off for a moment after the content (re)renders, so a tap meant for something else cannot land on it.
    var delay = typeof CFG.pairDelayMs === "number" ? CFG.pairDelayMs : 1500;
    f.enableAt = now() + delay;
    $("cf-pair").disabled = true;
    setTimeout(function () { if (flow === f && f.stage === "confirm") refreshPairButton(); }, delay);
    show("v-confirm");
  }

  /** Has the person typed the first 4 hex characters of the fingerprint being replaced? (Always true for a first pairing.) */
  function typedOldOk(f) {
    if (!f.hadPairing) return true;
    var want = String(f.oldFp || "").replace(/\s/g, "").toLowerCase().slice(0, 4);
    return want.length === 4 && $("cf-type").value.replace(/\s/g, "").toLowerCase() === want;
  }
  function refreshPairButton() {
    var f = flow;
    if (!f || f.stage !== "confirm") return;
    $("cf-pair").disabled = !(now() >= f.enableAt && typedOldOk(f));
  }

  function pairErrorText(e) {
    switch (e && e.code) {
      case "TIMEOUT": return "The computer did not answer in time. Check that it is on and that arcflare phone is running, then run arcflare phone pair again for a new code.";
      case "OFFLINE": return "The computer is offline. Start arcflare phone on it, then run arcflare phone pair again.";
      case "REFUSED": return "The computer refused this pairing. The link may have expired (they last 10 minutes) or been used already. Run arcflare phone pair again.";
      case "HANDSHAKE": return "The answer did not match this computer's key. Do not continue. Run arcflare phone pair again and make sure you scan the code on your own screen.";
      default: return "Pairing did not work. Run arcflare phone pair again for a new code.";
    }
  }

  async function startPairing() {
    var f = flow;
    if (busy || !f || f.stage !== "confirm") return;
    if ($("cf-pair").disabled || now() < f.enableAt) return;   // the button is still locked after a re-render
    if (!typedOldOk(f)) { setNotice("cf-notice", "Type the first 4 characters of the current computer's fingerprint to replace it."); return; }
    // The pending pairing is bound to the link that started it: check that this screen still shows it.
    var again = Link.validateLink(f.raw, { dev: !!CFG.allowLoopbackDev });
    if (!again.ok || again.canonical !== f.canonical || $("cf-fp").textContent !== f.fp) {
      showPairScreen("The pairing details changed. Scan the code on your computer again.");
      return;
    }
    busy = true;
    f.stage = "pairing";
    $("code-title").textContent = "Pairing...";
    $("code-wait").hidden = false; $("code-box").hidden = true; $("code-done").hidden = true;
    setError("code-error", ""); setNotice("code-notice", ""); $("code-cancel").textContent = "Cancel";
    show("v-code");
    try {
      if (!(await Native.supportsX25519())) throw Object.assign(new Error("x25519"), { code: "NO_X25519" });
      var res = await Connector.pairBest(deps, f.value, "Android phone");
      if (flow !== f) return;
      // NOT stored yet: the new device lives in memory until the computer has approved it (checkConfirmed).
      f.device = res.device; f.stage = "code";
      $("code-title").textContent = "Compare the code";
      $("code-wait").hidden = true; $("code-box").hidden = false; $("code-done").hidden = false;
      $("code-digits").textContent = res.sas;
      $("code-cancel").textContent = f.hadPairing ? "Cancel (keep the current computer)" : "Cancel";
    } catch (e) {
      if (flow !== f) return;
      f.stage = "failed";
      $("code-title").textContent = "Pairing failed";
      $("code-wait").hidden = true;
      setError("code-error", e && e.code === "NO_X25519" ? TOO_OLD : pairErrorText(e));
      $("code-cancel").textContent = "Back";
    } finally {
      busy = false;
    }
  }

  async function checkConfirmed() {
    var f = flow;
    if (busy || !f || f.stage !== "code" || !f.device) return;
    busy = true; setError("code-error", "");
    try {
      var cand = Object.assign({}, f.device, { relay: f.value.relay, lan: f.value.lan });
      try {
        var c = await Connector.connectBest(deps, cand);          // PENDING until the person approves it on the computer
        try { c.tunnel.close(); } catch (e) { /* closing */ }
      } catch (e) {
        setError("code-error", e && e.code === "PENDING"
          ? "The computer has not confirmed this phone yet. Compare the code, then confirm it on the computer."
          : "Could not check yet. Make sure the computer is on and running arcflare phone, then try again.");
        return;
      }
      if (flow !== f) return;
      try { await Store.save(f.device, { relay: f.value.relay, lan: f.value.lan }); }   // only now does the old pairing go
      catch (e) { setError("code-error", "The approval worked but this app could not save it. Pair again."); return; }
      flow = null;
    } finally {
      busy = false;
    }
    await boot();
  }

  async function cancelCode() {
    if (busy) return;
    if (!flow) { showPairScreen(""); return; }
    await leaveFlow();                       // discards the in-memory device; the stored pairing was never touched
  }

  // ----------------------------------------------------------------- launch

  function shortFp(rec) { return FP.fingerprint(rec.hubKey).catch(function () { return ""; }); }

  async function showStatus(rec, opts) {
    record = rec;
    opts = opts || {};
    statusAck = !!opts.ack;
    $("st-title").textContent = opts.title || "Can't reach your computer";
    $("st-msg").textContent = opts.msg || problemText({}, {}, rec);
    $("st-retry").textContent = opts.retryLabel || "Retry";
    var has = !!rec;
    $("st-info").hidden = !has;
    $("st-repair").hidden = !has;
    $("st-forget").hidden = !has;
    if (has) {
      $("st-fp").textContent = await shortFp(rec);
      var onlyLan = rec.relay === rec.lan;
      $("st-relay").textContent = onlyLan ? "Not set up (home network only)" : hostOf(rec.relay);
      $("st-lan").textContent = rec.lan || "";
      $("st-lan-row").hidden = !rec.lan;
    }
    show("v-status");
  }

  /** Was this page reached with the Back button from the hub UI? Then show settings, do not bounce forward again. */
  function cameBack() {
    try { var n = performance.getEntriesByType("navigation")[0]; return !!n && n.type === "back_forward"; } catch (e) { return false; }
  }

  async function boot(opts) {
    opts = opts || {};
    var gen = ++bootGen;
    var stale = function () { return gen !== bootGen || !!flow; };
    show("v-boot"); $("boot-text").textContent = "Looking for your computer...";
    var rec;
    try { rec = await Store.load(); } catch (e) { showPairScreen("This app's storage is not available."); return; }
    if (stale()) return;
    if (!Mode.isPairedRecord(rec)) { showPairScreen(""); return; }
    if (opts.settings) {
      await showStatus(rec, { title: "This computer", msg: "Paired. Use Open to connect again.", retryLabel: "Open" });
      return;
    }
    var t = Mode.targets(rec);
    var hasHome = t.some(function (x) { return x.kind === "home"; });
    var hasRelay = t.some(function (x) { return x.kind === "relay"; });
    var home = null, relay = null;
    if (hasHome) {
      $("boot-text").textContent = "Looking on your home network...";
      home = await Connector.check(deps, rec, "home");
      if (stale()) return;
    }
    // The relay is contacted only when the home handshake did not succeed (and PENDING already proved the hub).
    if (!(home && (home.ok || home.code === "PENDING")) && hasRelay) {
      $("boot-text").textContent = "Trying the relay...";
      relay = await Connector.check(deps, rec, "relay");
      if (stale()) return;
    }
    var mode = Mode.decideMode({ record: rec, home: home, relay: relay });
    if (mode === "home") { Native.navigate("ui/index.html?via=home"); return; }
    if (mode === "relay") {
      if (Mode.needsHomeRepair(rec) && !repairAck) {
        await showStatus(rec, { title: "Re-pair to use the home network", msg: REPAIR, retryLabel: "Continue via the relay", ack: true });
        return;
      }
      Native.navigate("ui/index.html?via=relay"); return;
    }
    await showStatus(rec, { msg: problemText(home, relay, rec) });
  }

  function problemText(home, relay, rec) {
    var codes = [home && home.code, relay && relay.code];
    if (codes.indexOf("PENDING") !== -1) return "This phone is paired but the computer has not confirmed it yet. Compare the code and confirm it on the computer (arcflare phone devices).";
    if (relay && relay.code === "REFUSED") return "The relay no longer accepts this phone. It may have been removed on the computer. Pair again to use it.";
    if (relay && relay.code === "HANDSHAKE") return "The answer from the relay did not match your computer's key, so it was refused. Try again later, or pair again.";
    if (Mode.needsHomeRepair(rec) && rec.relay === rec.lan) return REPAIR + " The internet relay is not set up, so there is nothing else to connect through.";
    if (rec && rec.relay === rec.lan) return "Your computer did not answer on your home network. Check that this phone is on the same Wi-Fi, that the computer is on and that arcflare phone is running, then try again. The internet relay is not set up.";
    return "Your computer did not answer on your home network or through the relay. Check that it is on and that arcflare phone is running with the relay on, then try again." + (Mode.needsHomeRepair(rec) ? " " + REPAIR : "");
  }

  function showUnsupported() {
    unsupported = true;
    return showStatus(null, { title: "Update Android System WebView", msg: TOO_OLD, retryLabel: "Check again" });
  }

  async function forgetAll() {
    show("v-boot"); $("boot-text").textContent = "Forgetting this computer...";
    var res;
    try { res = await Store.wipeAll({ clearCookies: Native.clearCookies }); }
    catch (e) { res = { ok: false, failed: ["unexpected error"] }; }
    if (!res.ok) {
      // Never claim success after an error: say what is left and let the person try again.
      setError("fg-error", "Not everything could be removed (" + res.failed.join(", ") + "). The computer is NOT fully forgotten. Try again, or clear this app's data in Android Settings > Apps > ArcFlare > Storage.");
      show("v-forget");
      return;
    }
    record = null; flow = null;
    setError("fg-error", "");
    showPairScreen("");
  }

  // ------------------------------------------------------------------ wiring

  /** A link from outside the app (QR scan / intent). `at` = when the shell got it. */
  function onDeepLink(url, at) {
    if (unsupported) return null;
    if (document.hidden) { held = { url: url, at: at }; return null; }  // retained: judged when the app is foregrounded
    return deliver(url, at);
  }

  /** Returns the promise of the flow it started, or null when the link was dropped or ignored. */
  function deliver(url, at) {
    if (gate.judge(at) !== "ok") return null;                          // older than 5 minutes / from before the foreground
    if (flow) {
      // A pairing screen is up: nothing may replace what the person is looking at.
      if (url !== flow.raw) { setNotice("cf-notice", IGNORED); setNotice("code-notice", IGNORED); }
      return null;
    }
    return onLinkText(url);
  }

  function onForeground() {
    gate.foreground();
    var h = held; held = null;
    if (h) deliver(h.url, h.at);
  }

  // A phone that ran an earlier build may hold a session cookie (arcflare_sid) for the hub's home address in Android's
  // native cookie jar, which Capacitor's default Java cookie handler would send in clear to that address. This build never
  // asks for one, but it clears the jar ONCE on its first start, before any request to the LAN. The "done" marker is in
  // IndexedDB and is only written after the clear succeeded (a failure is retried at the next start).
  var COOKIE_FLAG = "cookies-wiped-v1";
  async function firstRunCookieWipe() {
    try {
      if (await Store.getFlag(COOKIE_FLAG)) return;
      await Native.clearCookies();
      await Store.setFlag(COOKIE_FLAG);
    } catch (e) { /* not fatal; tried again next start */ }
  }

  async function start() {
    await firstRunCookieWipe();
    $("pair-form").addEventListener("submit", function (ev) {
      ev.preventDefault();
      var text = $("pair-link").value;
      $("pair-link").value = "";
      try { if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText("").catch(function () {}); } catch (e) { /* best effort */ }
      onLinkText(text);
    });
    $("cf-cancel").addEventListener("click", function () { if (flow && flow.stage === "confirm") leaveFlow(); });
    $("cf-pair").addEventListener("click", startPairing);
    $("cf-type").addEventListener("input", refreshPairButton);
    $("code-done").addEventListener("click", checkConfirmed);
    $("code-cancel").addEventListener("click", cancelCode);
    $("st-retry").addEventListener("click", function () {
      if (statusAck) { repairAck = true; statusAck = false; }
      if (unsupported) { unsupported = false; start2(); } else boot();
    });
    $("st-repair").addEventListener("click", function () { showPairScreen(""); });
    $("st-forget").addEventListener("click", function () { setError("fg-error", ""); show("v-forget"); });
    $("fg-cancel").addEventListener("click", function () { boot({ settings: true }); });
    $("fg-go").addEventListener("click", forgetAll);
    document.addEventListener("visibilitychange", function () { if (!document.hidden) onForeground(); });
    Native.onForeground(onForeground);
    Native.onAppUrl(function (url) { onDeepLink(url, now()); });
    await start2();
  }

  async function start2() {
    // Never fall back to anything weaker than X25519 (TUNNEL.md section 2): no WebView support, no app.
    if (!(await Native.supportsX25519())) { await showUnsupported(); return; }
    var launch = await Native.getLaunchUrl();
    if (launch && launch.indexOf("arcflare://") === 0 && !cameBack()) {
      var started = onDeepLink(launch, now());
      if (started) { await started; return; }
    }
    await boot({ settings: cameBack() });
  }

  start();
})();
