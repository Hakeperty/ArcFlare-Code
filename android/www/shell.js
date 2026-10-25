// ArcFlare app shell controller. No secrets are logged, put in URLs or put in Web Storage:
// the pairing link only lives in a local variable until pairing finishes or is cancelled.
(function () {
  "use strict";

  var Link = window.ArcFlareLink, Mode = window.ArcFlareMode, Store = window.ArcFlareStore;
  var FP = window.ArcFlareFingerprint, Native = window.ArcFlareNative;
  var CFG = window.ARCFLARE_CONFIG || {};
  var $ = function (id) { return document.getElementById(id); };

  var pending = null;        // { value, canonical, fp } between "link accepted" and "paired"
  var record = null;         // stored pairing record while the status screen is up
  var lastLink = null;       // dedupe: a cold start delivers the same link twice
  var busy = false;

  function show(id) {
    var all = document.querySelectorAll("[data-view]");
    for (var i = 0; i < all.length; i++) all[i].hidden = all[i].id !== id;
    var v = $(id);
    if (v) v.scrollTop = 0;
  }
  function setError(id, msg) { var e = $(id); e.textContent = msg || ""; e.hidden = !msg; }
  function hostOf(url) { try { return new URL(url).host; } catch (e) { return ""; } }

  // ---------------------------------------------------------------- pairing

  function showPairScreen(error) {
    pending = null;
    $("pair-link").value = "";
    setError("pair-error", error);
    show("v-pair");
  }

  async function onLinkText(text) {
    var r = Link.validateLink(text, { dev: !!CFG.allowLoopbackDev });
    if (!r.ok) { showPairScreen(r.error); return; }          // nothing stored, nothing sent
    var fp;
    try { fp = await FP.fingerprint(r.value.hubKey); } catch (e) { showPairScreen("The link is damaged (computer key)."); return; }
    pending = { value: r.value, canonical: r.canonical, fp: fp };
    $("cf-fp").textContent = fp;
    $("cf-fp-inline").textContent = fp.split(" ")[0] + "…";
    $("cf-relay").textContent = r.value.relayHost;
    $("cf-lan").textContent = r.value.lan || "";
    $("cf-lan-row").hidden = !r.value.lan;
    show("v-confirm");
  }

  function pairErrorText(e) {
    switch (e && e.code) {
      case "TIMEOUT": return "The computer did not answer in time. Check that it is on and that arcflare phone is running with the relay on, then run arcflare phone pair again for a new code.";
      case "OFFLINE": return "The computer is offline. Start arcflare phone on it, then run arcflare phone pair again.";
      case "REFUSED": return "The relay refused this pairing. The link may have expired (they last 10 minutes) or been used already. Run arcflare phone pair again.";
      case "HANDSHAKE": return "The answer did not match this computer's key. Do not continue. Run arcflare phone pair again and make sure you scan the code on your own screen.";
      default: return "Pairing did not work. Run arcflare phone pair again for a new code.";
    }
  }

  async function startPairing() {
    if (busy || !pending) return;
    busy = true;
    var p = pending;
    $("code-title").textContent = "Pairing...";
    $("code-wait").hidden = false; $("code-box").hidden = true; $("code-done").hidden = true;
    setError("code-error", ""); $("code-cancel").textContent = "Cancel";
    show("v-code");
    try {
      if (!(await Native.supportsX25519())) {
        throw Object.assign(new Error("x25519"), { code: "NO_X25519" });
      }
      var res = await window.ArcFlareTunnel.pair({ link: p.canonical, label: "Android phone" });
      // The LAN URL stored is the one our validator accepted, not whatever tunnel-client parsed.
      await Store.save(res.device, p.value.lan);
      pending = null;
      $("code-title").textContent = "Compare the code";
      $("code-wait").hidden = true; $("code-box").hidden = false; $("code-done").hidden = false;
      $("code-digits").textContent = res.sas;
      $("code-cancel").textContent = "Cancel and forget";
    } catch (e) {
      $("code-title").textContent = "Pairing failed";
      $("code-wait").hidden = true;
      setError("code-error", e && e.code === "NO_X25519"
        ? "This phone's Android System WebView is too old for the secure tunnel (it needs version 133 or newer). Update it in Google Play and try again."
        : pairErrorText(e));
      $("code-cancel").textContent = "Back";
    } finally {
      busy = false;
    }
  }

  async function checkConfirmed() {
    if (busy) return;
    busy = true; setError("code-error", "");
    try {
      var rec = await Store.load();
      var t = await window.ArcFlareTunnel.connect(rec);
      try { t.close(); } catch (e) { /* closing */ }
      busy = false;
      await boot();
    } catch (e) {
      busy = false;
      setError("code-error", e && e.code === "PENDING"
        ? "The computer has not confirmed this phone yet. Compare the code, then confirm it on the computer."
        : "Could not check yet. Make sure the computer is on and running arcflare phone, then try again.");
    }
  }

  async function cancelCode() {
    if (busy) return;
    var rec = null;
    try { rec = await Store.load(); } catch (e) { /* none */ }
    if (rec && $("code-box").hidden === false) await forgetAll();   // pairing finished but not confirmed: undo it
    else showPairScreen("");
  }

  // ----------------------------------------------------------------- launch

  function shortFp(rec) { return FP.fingerprint(rec.hubKey).catch(function () { return ""; }); }

  async function showStatus(rec, opts) {
    record = rec;
    opts = opts || {};
    $("st-title").textContent = opts.title || "Can't reach your computer";
    $("st-msg").textContent = opts.msg || relayProblemText("");
    $("st-retry").textContent = opts.retryLabel || "Retry";
    $("st-fp").textContent = await shortFp(rec);
    $("st-relay").textContent = hostOf(rec.relay);
    $("st-lan").textContent = rec.lan || "";
    $("st-lan-row").hidden = !rec.lan;
    $("st-info").hidden = false;
    show("v-status");
  }

  /** Was this page reached with the Back button from the hub UI? Then show settings, do not bounce forward again. */
  function cameBack() {
    try { var n = performance.getEntriesByType("navigation")[0]; return !!n && n.type === "back_forward"; } catch (e) { return false; }
  }

  async function boot(opts) {
    opts = opts || {};
    show("v-boot"); $("boot-text").textContent = "Looking for your computer...";
    var rec;
    try { rec = await Store.load(); } catch (e) { showPairScreen("This app's storage is not available."); return; }
    if (!Mode.isPairedRecord(rec)) { showPairScreen(""); return; }
    if (opts.settings) {
      await showStatus(rec, { title: "This computer", msg: "Paired. Use Open to connect again.", retryLabel: "Open" });
      return;
    }
    var probe = { ok: false };
    if (rec.lan) {
      probe = await Mode.probeLan(function (o) { return Native.httpGet(o); }, rec.lan, CFG.probeTimeoutMs || 2000);
      if (probe.ok) {
        try { await Native.setLan(rec.lan); } catch (e) { probe = { ok: false }; }   // the WebView would refuse the navigation anyway
      }
    }
    var relay = { ok: true };
    if (!probe.ok) {
      try { await Native.setLan(null); } catch (e) { /* guard stays closed */ }
      $("boot-text").textContent = "Trying the relay...";
      relay = await relayCheck(rec);
    }
    var mode = Mode.decideMode({ record: rec, probe: probe, relayUsable: relay.ok });
    if (mode === "home") { Native.navigate(rec.lan); return; }
    if (mode === "relay") { Native.navigate("ui/index.html"); return; }
    await showStatus(rec, { msg: relayProblemText(relay.code) });
  }

  /**
   * Can the relay session be opened right now? (A real handshake with the computer, closed again at once;
   * the bundled UI opens its own. This is what makes "neither works" a visible state instead of an empty UI.)
   */
  async function relayCheck(rec) {
    if (!(await Native.supportsX25519())) return { ok: false, code: "NO_X25519" };
    try {
      var t = await window.ArcFlareTunnel.connect(rec, { handshakeTimeoutMs: 10000 });
      try { t.close(); } catch (e) { /* closing */ }
      return { ok: true };
    } catch (e) {
      return { ok: false, code: (e && e.code) || "FAILED" };
    }
  }

  function relayProblemText(code) {
    switch (code) {
      case "NO_X25519": return "Your computer is not on the home network, and this phone's Android System WebView is too old for the relay (it needs version 133 or newer). Update it in Google Play.";
      case "PENDING": return "This phone is paired but the computer has not confirmed it yet. Compare the code and confirm it on the computer (arcflare phone devices).";
      case "REFUSED": return "The relay no longer accepts this phone. It may have been removed on the computer. Pair again to use it.";
      case "HANDSHAKE": return "The answer from the relay did not match your computer's key, so it was refused. Try again later, or pair again.";
      default: return "Your computer did not answer on your home network or through the relay. Check that it is on and that arcflare phone is running with the relay on, then try again.";
    }
  }

  async function forgetAll() {
    show("v-boot"); $("boot-text").textContent = "Forgetting this computer...";
    await Store.wipeAll({ setLan: Native.setLan, clearCookies: Native.clearCookies });
    record = null; pending = null; lastLink = null;
    showPairScreen("");
  }

  // ------------------------------------------------------------------ wiring

  function onDeepLink(url) {
    if (url === lastLink) return;
    lastLink = url;
    onLinkText(url);
  }

  async function start() {
    $("pair-form").addEventListener("submit", function (ev) {
      ev.preventDefault();
      var text = $("pair-link").value;
      $("pair-link").value = "";
      try { if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText("").catch(function () {}); } catch (e) { /* best effort */ }
      onLinkText(text);
    });
    $("cf-cancel").addEventListener("click", function () { showPairScreen(""); });
    $("cf-pair").addEventListener("click", startPairing);
    $("code-done").addEventListener("click", checkConfirmed);
    $("code-cancel").addEventListener("click", cancelCode);
    $("st-retry").addEventListener("click", function () { boot(); });
    $("st-repair").addEventListener("click", function () { showPairScreen(""); });
    $("st-forget").addEventListener("click", function () { show("v-forget"); });
    $("fg-cancel").addEventListener("click", function () { if (record) showStatus(record); else showPairScreen(""); });
    $("fg-go").addEventListener("click", forgetAll);
    Native.onAppUrl(onDeepLink);
    var launch = await Native.getLaunchUrl();
    if (launch && launch.indexOf("arcflare://") === 0 && !cameBack()) { lastLink = launch; await onLinkText(launch); return; }
    await boot({ settings: cameBack() });
  }

  start();
})();
