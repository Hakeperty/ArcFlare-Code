// Local AI: a small chat model that runs on the phone itself (the app's LocalAI plugin, llama.cpp). Shared by the app's
// pairing screen (android/www) and the "On phone" tab of this UI; does nothing in a browser.
//
// window.ArcFlareLocalAI = { CHIPS, profile(info), mount(root, native, files, mcp), SYSTEM }
(function () {
  "use strict";

  // Phone chips we tune for (the phones people use: Samsung Galaxy S22 and later, Google Pixel, OnePlus, Xiaomi, vivo,
  // Motorola, Nothing, and Huawei phones that still run Android apps). `re` is matched against Android's SOC_MODEL,
  // HARDWARE and BOARD. tier: 4 newest flagship .. 1 mid-range. threads: the performance cores worth using; more only
  // adds heat. A chip that is not listed gets settings from its RAM and core speeds instead.
  // shortcut: tiers and thread counts come from each chip's core layout, not from measurements, upgrade after the phone test (NEXT.md 8.1).
  var CHIPS = [
    { re: /SM8850|canoe/i, name: "Snapdragon 8 Elite Gen 5", tier: 4, threads: 6 },
    { re: /SM8750|^sun$/i, name: "Snapdragon 8 Elite", tier: 4, threads: 6 },
    { re: /SM8650|pineapple/i, name: "Snapdragon 8 Gen 3", tier: 4, threads: 5 },
    { re: /SM8735/i, name: "Snapdragon 8s Gen 4", tier: 3, threads: 4 },
    { re: /SM8635|cliffs/i, name: "Snapdragon 8s Gen 3", tier: 3, threads: 4 },
    { re: /SM8550|kalama/i, name: "Snapdragon 8 Gen 2", tier: 3, threads: 4 },
    { re: /SM8475|cape/i, name: "Snapdragon 8+ Gen 1", tier: 3, threads: 4 },
    { re: /SM8450|taro/i, name: "Snapdragon 8 Gen 1", tier: 2, threads: 4 },
    { re: /SM7675|SM7635|SM7550|SM7475|SM7450|SM7435/i, name: "Snapdragon 7 series", tier: 2, threads: 4 },
    { re: /SM7[0-3]\d\d|SM6\d\d\d|SM4\d\d\d/i, name: "Snapdragon 4/6/7 series", tier: 1, threads: 4 },
    { re: /s5e9955|exynos ?2500/i, name: "Exynos 2500", tier: 4, threads: 6 },
    { re: /s5e9945|exynos ?2400/i, name: "Exynos 2400", tier: 3, threads: 6 },
    { re: /s5e9925|exynos ?2200/i, name: "Exynos 2200", tier: 2, threads: 4 },
    { re: /s5e8855|s5e8845|s5e8835|exynos ?1[345]80/i, name: "Exynos 1380/1480/1580", tier: 1, threads: 4 },
    { re: /laguna|tensor ?g5/i, name: "Google Tensor G5", tier: 4, threads: 6 },
    { re: /zumapro|tensor ?g4/i, name: "Google Tensor G4", tier: 3, threads: 4 },
    { re: /^zuma$|tensor ?g3/i, name: "Google Tensor G3", tier: 3, threads: 4 },
    { re: /gs201|tensor ?g2/i, name: "Google Tensor G2", tier: 2, threads: 4 },
    { re: /gs101|^tensor$/i, name: "Google Tensor", tier: 2, threads: 4 },
    { re: /MT6991|dimensity ?94/i, name: "Dimensity 9400", tier: 4, threads: 6 },
    { re: /MT6989|dimensity ?93/i, name: "Dimensity 9300", tier: 4, threads: 6 },
    { re: /MT6985|dimensity ?92/i, name: "Dimensity 9200", tier: 3, threads: 4 },
    { re: /MT6983|dimensity ?90/i, name: "Dimensity 9000", tier: 3, threads: 4 },
    { re: /MT6899|MT6897|MT6896|MT6895|dimensity ?8[1-4]/i, name: "Dimensity 8000 series", tier: 2, threads: 4 },
    { re: /dimensity/i, name: "Dimensity", tier: 1, threads: 4 },
    { re: /^MT6\d\d\d/i, name: "MediaTek", tier: 1, threads: 4 },
    { re: /kirin ?90[0-3]0|kirin9000/i, name: "Kirin 9000 series", tier: 2, threads: 4 },
    { re: /kirin/i, name: "Kirin", tier: 1, threads: 4 },
  ];

  /** The settings this phone gets. info: what LocalAI.info() returned. */
  function profile(info) {
    var i = info || {};
    var ram = Number(i.ramMb) || 0;
    var keys = [i.socModel, i.hardware, i.board].filter(function (s) { return typeof s === "string" && s; });
    var chip = null;
    for (var c = 0; c < CHIPS.length && !chip; c++) {
      for (var k = 0; k < keys.length; k++) if (CHIPS[c].re.test(keys[k])) { chip = CHIPS[c]; break; }
    }
    var freqs = Array.isArray(i.maxFreqsKHz) ? i.maxFreqsKHz.map(Number).filter(function (f) { return f > 0; }) : [];
    var top = freqs.length ? Math.max.apply(null, freqs) : 0;
    var fast = freqs.filter(function (f) { return f >= top * 0.75; }).length;
    var tier = chip ? chip.tier : ram >= 8000 ? 2 : ram >= 5500 ? 1 : 0;
    var threads = chip ? chip.threads : Math.max(2, Math.min(4, fast || 4));
    var models = (i.models || []).filter(function (m) { return ram >= m.minRamMb; });
    var wantBig = tier >= 3 && ram >= 7000;
    var rec = (wantBig && models.filter(function (m) { return m.id === "qwen3-1.7b"; })[0]) || models.filter(function (m) { return m.id === "qwen3-0.6b"; })[0] || null;
    var out = {
      chip: chip ? chip.name : "a chip we have no settings for",
      known: !!chip,
      tier: tier,
      threads: threads,
      ctx: tier >= 3 && ram >= 7000 ? 4096 : 2048,
      maxTokens: tier >= 3 ? 512 : 384,
      models: models,
      recommended: rec ? rec.id : null,
      problem: null,
    };
    if (i.failed) out.problem = "Could not check this phone (" + i.failed + "). Open On phone again to try again.";   // not proof it is unsupported
    else if (!i.available) out.problem = "This phone cannot run Local AI: it needs a 64-bit ARM processor.";
    else if (!models.length) out.problem = "This phone has too little memory for the smallest model (it needs about 3 GB of RAM).";
    return out;
  }

  var GB = function (bytes) { return (bytes / 1e9).toFixed(bytes < 1e9 ? 2 : 1) + " GB"; };
  var ACCEPT_KEY = "arcflare-localai-accepted-v1";
  // Arc Pocket's instructions, word for word from lib/arcs/arc-pocket.Modelfile (localai.test.js keeps them equal).
  var SYSTEM = "You are Arc Pocket, ArcFlare's assistant on a phone. You run on the phone itself, with no internet, so you cannot look anything up.\n\n" +
    "Answer in a few short sentences unless asked for more: the screen is small and every word costs battery. Lead with the answer. If you are not sure, say so plainly; never invent facts, numbers, names or sources. For medical, legal, money or safety questions, give general information only and say to check with a qualified person.";

  function el(tag, cls, text, attrs) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = String(text);
    if (attrs) for (var a in attrs) n.setAttribute(a, attrs[a]);
    return n;
  }
  function btn(text, cls, onClick) {
    var b = el("button", "btn " + (cls || "outline"), text, { type: "button" });
    b.addEventListener("click", onClick);
    return b;
  }
  function accepted() { try { return localStorage.getItem(ACCEPT_KEY) === "1"; } catch (e) { return false; } }
  function setAccepted(v) { try { if (v) localStorage.setItem(ACCEPT_KEY, "1"); else localStorage.removeItem(ACCEPT_KEY); } catch (e) { /* the notice shows again */ } }

  /**
   * Draws Local AI into `root`. native: ArcFlareNative.localAI() (or a fake in tests). files: ArcFlareNative.phoneFiles()
   * in the agent build, else null. mcp: { tools(), call(server, tool, args) }, the computer's switched-on MCP tools through
   * the hub (an owner signed in to it), else null. Returns { refresh() }.
   * Nothing is downloaded or loaded until the person asks; the notice comes before the first download.
   */
  function mount(root, native, files, mcp) {
    var PA = window.ArcFlarePhoneAgent;
    var canTools = !!(files && PA);
    var st = { info: null, prof: null, view: "home", chat: [], busy: false, progress: null, error: "", loadedId: null, pick: null, draft: "", skip: 0, folders: [], mcpTools: [], pending: null, stopped: false };

    native.on("progress", function (p) { st.progress = p; if (st.view === "download") draw(); });

    async function refresh() {
      try { st.info = await native.info(); } catch (e) { st.info = { available: false, models: [], failed: e.message || String(e) }; }
      st.prof = profile(st.info);
      st.loadedId = st.info.loaded || null;
      if (!st.pick) st.pick = st.prof.recommended;
      if (canTools) {
        try { st.folders = (await files.folders()).folders || []; } catch (e) { st.folders = []; }
      }
      // Not signed in as an owner, or no server switched on: no computer tools, the chat still works.
      if (mcp && PA) {
        try { st.mcpTools = (await mcp.tools()) || []; } catch (e) { st.mcpTools = []; }
      }
      draw();
    }

    // The model the chat uses: the one in memory, else the suggested one, else any downloaded one. With a folder
    // shared, a model that can use tools comes first (PA.MODELS: the smallest one cannot).
    function useModel() {
      var have = downloaded();
      if (!have.length) return null;
      var able = wantTools() ? have.filter(function (m) { return PA.MODELS.indexOf(m.id) !== -1; })[0] : null;
      if (able) return able.id;
      if (st.loadedId && model(st.loadedId) && model(st.loadedId).downloaded) return st.loadedId;
      return have.some(function (m) { return m.id === st.prof.recommended; }) ? st.prof.recommended : have[0].id;
    }
    // Something for tools to work on: a shared folder, or a computer tool through the hub.
    function wantTools() { return (canTools && st.folders.length > 0) || (!!PA && st.mcpTools.length > 0); }
    function toolsOn() { return wantTools() && PA.MODELS.indexOf(useModel()) !== -1; }
    // Why shared folders cannot be used right now, or "".
    function toolsProblem() {
      if (!canTools || toolsOn()) return "";
      var need = (st.info.models || []).filter(function (m) { return PA.MODELS.indexOf(m.id) !== -1; })[0];
      if (!need) return "";
      if (!st.prof.models.some(function (m) { return m.id === need.id; })) return "This phone has too little memory for " + need.name + ", the model that can use files, so Arc Pocket cannot use files here.";
      return "Arc Pocket can only use files with " + need.name + ": in our tests the smaller model could not read or list them. Download it in Models and storage.";
    }

    function downloaded() { return ((st.info && st.info.models) || []).filter(function (m) { return m.downloaded; }); }
    function model(id) { return ((st.info && st.info.models) || []).filter(function (m) { return m.id === id; })[0]; }

    function settingsLine() {
      var p = st.prof;
      return "Picked for this phone (" + p.chip + (st.info.ramMb ? ", " + Math.round(st.info.ramMb / 1024) + " GB RAM" : "") + "): " +
        p.threads + " processor threads, a " + p.ctx.toLocaleString("en") + "-token memory.";
    }

    function draw() {
      root.replaceChildren();
      if (!st.info) { root.append(el("p", "dev-meta", "Looking at this phone...")); return; }
      var head = el("div", "local-head");
      head.append(el("img", "panda", null, { src: (root.dataset.assets || "assets/") + "panda-phone.png", alt: "", width: "96", height: "75" }));
      head.append(el("h2", "dev-name", "AI on this phone"));
      root.append(head);
      if (st.error) { root.append(el("p", "banner error", st.error, { role: "alert" })); }
      if (st.prof.problem) { root.append(el("p", "dev-meta", st.prof.problem)); return; }
      if (st.view === "download") return drawDownload();
      if (st.view === "manage") return drawManage();
      if (st.view === "files") return drawFiles();
      if (!downloaded().length || st.view === "notice") return drawNotice();
      drawChat();
    }

    // ---- the notice: what it costs, before anything is downloaded
    function drawNotice() {
      var box = el("div", "card local-card");
      box.append(el("p", "", "Chat with Arc Pocket, ArcFlare's small assistant, running on this phone. It works with no computer and no internet once its model is downloaded. Nothing you type leaves the phone."));
      box.append(el("p", "dev-name", "Before you download"));
      var m = model(st.pick) || model(st.prof.recommended);
      var ul = el("ul", "local-warn");
      [
        "Size: " + (m ? m.name + " is a " + GB(m.size) + " download" : "the model is a large download") + " and takes that much storage until you delete it here (Models and storage). The engine that runs it is part of the app (about 17 MB) and goes when you uninstall ArcFlare." + " Use Wi-Fi if you pay for mobile data.",
        "Heat and battery: while it answers, the model keeps the processor fully busy. The phone gets warm, the battery drains faster, and Android may slow the phone down to cool it. Long answers and long chats make this worse. Do not use it while the phone is charging in a hot place.",
        "Speed: answers come a few words at a time, slower on older phones, and other apps can feel slower while it runs. We have not measured speeds on real phones yet.",
        "Memory: the model stays in memory while you chat; Android may close other apps to make room.",
        "Mistakes: small models get facts wrong and make things up with confidence. Do not rely on them for medical, legal, money or safety questions.",
      ].forEach(function (t) { ul.append(el("li", "", t)); });
      box.append(ul);
      if (st.prof.models.length > 1) {
        var group = el("div", "local-models");
        st.prof.models.forEach(function (x) {
          var id = "lm-" + x.id;
          var row = el("label", "local-model", null, { for: id });
          var r = el("input", "", null, { type: "radio", name: "lm-pick", id: id, value: x.id });
          r.checked = x.id === st.pick;
          r.addEventListener("change", function () { st.pick = x.id; draw(); });
          row.append(r, el("span", "", "Arc Pocket on " + x.name + " (" + GB(x.size) + ")" + (x.id === st.prof.recommended ? ", suggested for this phone" : "") + ". Licence: " + x.license + "."));
          group.append(row);
        });
        box.append(group);
      }
      box.append(el("p", "dev-meta sub", settingsLine()));
      var agree = el("label", "local-agree");
      var cb = el("input", "", null, { type: "checkbox", id: "lm-agree" });
      cb.checked = accepted();
      agree.append(cb, el("span", "", "I understand the size, heat, battery and accuracy limits above."));
      box.append(agree);
      var go = btn(m ? "Download " + m.name + " (" + GB(m.size) + ")" : "Download", "primary block", async function () {
        if (!cb.checked) { st.error = "Tick the box first: the download is large."; draw(); return; }
        setAccepted(true);
        await startDownload(st.pick);
      });
      box.append(go);
      if (downloaded().length) box.append(btn("Back to the chat", "outline block", function () { st.view = "home"; draw(); }));
      box.append(btn("Models and storage", "outline block", function () { st.view = "manage"; refresh(); }));
      root.append(box);
    }

    async function startDownload(id) {
      st.error = ""; st.view = "download"; st.progress = { id: id, done: 0, total: (model(id) || {}).size || 1 }; draw();
      try { await native.download(id); st.view = "home"; }
      catch (e) { st.error = e.message || String(e); st.view = "notice"; }
      await refresh();
    }

    function drawDownload() {
      var p = st.progress || { done: 0, total: 1 };
      var box = el("div", "card local-card");
      var pct = Math.floor((p.done / p.total) * 100);
      box.append(el("p", "dev-name", "Downloading " + ((model(p.id) || {}).name || "the model") + ": " + pct + "%"));
      var bar = el("progress", "load-bar", null, { max: "100" });
      bar.value = pct;
      box.append(bar);
      box.append(el("p", "dev-meta", GB(p.done) + " of " + GB(p.total) + ", from the model's own page on Hugging Face. Keep the app open."));
      box.append(btn("Cancel", "outline block", function () { native.cancelDownload(); }));
      root.append(box);
    }

    // ---- models and storage: see what is on the phone, delete any of it
    function drawManage() {
      var box = el("div", "card local-card");
      box.append(el("p", "dev-name", "Models and storage"));
      box.append(el("p", "dev-meta", "Models are kept in this app's own storage. Deleting one frees its space at once. Free space on the phone: " + GB((st.info.freeDiskMb || 0) * 1048576) + "."));
      (st.info.models || []).forEach(function (x) {
        var row = el("div", "local-row");
        row.append(el("span", "", x.name + ", " + GB(x.size) + (x.downloaded ? " on this phone" : x.partial ? ", part of a stopped download" : ", not downloaded") + (x.id === st.loadedId ? ", in use" : "")));
        if (x.downloaded || x.partial) row.append(btn("Delete", "danger sm", async function () {
          try { await native.remove(x.id); if (st.loadedId === x.id) { st.chat = []; st.skip = 0; } } catch (e) { st.error = e.message || String(e); }
          await refresh();
        }));
        else if (st.prof.models.some(function (m) { return m.id === x.id; })) row.append(btn("Download", "outline sm", function () { st.pick = x.id; st.view = "notice"; draw(); }));
        box.append(row);
      });
      if (downloaded().length || (st.info.models || []).some(function (x) { return x.partial; })) {
        box.append(btn("Delete all Local AI data", "danger block", async function () {
          try {
            await native.unload();
            for (var d = st.info.models || [], j = 0; j < d.length; j++) await native.remove(d[j].id);
            st.chat = []; st.skip = 0; setAccepted(false);
          } catch (e) { st.error = e.message || String(e); }
          await refresh();
        }));
      }
      box.append(el("p", "dev-meta sub", "To remove everything, including the engine, uninstall ArcFlare in Android's settings."));
      box.append(btn("Back", "outline block", function () { st.view = "home"; draw(); }));
      root.append(box);
    }

    // ---- the files Arc Pocket may use (agent build only): the warning comes before any folder is shared
    function drawFiles() {
      var box = el("div", "card local-card");
      box.append(el("p", "dev-name", "Files Arc Pocket may use"));
      box.append(el("p", "", "Share a folder and Arc Pocket can work with the text files in it. It asks you before every single step."));
      if (toolsProblem()) box.append(el("p", "banner", toolsProblem()));
      box.append(el("p", "dev-name", "Before you share a folder"));
      var ul = el("ul", "local-warn");
      [
        "It can list and read every file in the folder you pick, and in the folders inside it. What it reads becomes part of this chat, on this phone. Nothing is sent anywhere.",
        "It can create files there and replace files that exist. You are shown the new text first. A replaced file cannot be brought back.",
        "Small models misread things and make mistakes. Read what it wants to write before you allow it.",
        "Pick a folder made for this. Do not share Downloads, Documents, or a folder with private papers.",
        "You can stop sharing a folder here at any time. Android may also list it under this app's permissions.",
      ].forEach(function (t) { ul.append(el("li", "", t)); });
      box.append(ul);
      st.folders.forEach(function (f) {
        var row = el("div", "local-row");
        row.append(el("span", "", f.name));
        row.append(btn("Stop sharing", "danger sm", async function () {
          try { await files.forget(f.id); } catch (e) { st.error = e.message || String(e); }
          await refresh();
        }));
        box.append(row);
      });
      if (!st.folders.length) box.append(el("p", "dev-meta", "No folder is shared."));
      var agree = el("label", "local-agree");
      var cb = el("input", "", null, { type: "checkbox", id: "lf-agree" });
      agree.append(cb, el("span", "", "I understand what Arc Pocket can do in a folder I share."));
      box.append(agree);
      box.append(btn("Choose a folder", "primary block", async function () {
        if (!cb.checked) { st.error = "Tick the box first."; draw(); return; }
        st.error = "";
        try { await files.pickFolder(); } catch (e) { st.error = e.message || String(e); }
        await refresh();
      }));
      box.append(btn("Back to the chat", "outline block", function () { st.view = "home"; draw(); }));
      root.append(box);
    }

    // The card that asks the person before a tool call runs. p: { d, done }.
    function approveCard(p) {
      var d = p.d;
      var card = el("div", "card local-approve", null, { role: "group", "aria-label": "Arc Pocket asks to use a tool" });
      card.append(el("p", "dev-name", "Arc Pocket wants to:"));
      card.append(el("p", "", d.title));
      if (d.detail) card.append(el("p", "dev-meta", d.detail));
      if (d.body) card.append(el("pre", "local-pre", d.body));
      function decide(ok) { st.pending = null; draw(); p.done(ok); }
      var choices = el("div", "local-send");
      choices.append(btn("Allow", "primary", function () { decide(true); }), btn("Do not allow", "outline", function () { decide(false); }));
      card.append(choices);
      return card;
    }

    // ---- the chat
    function drawChat() {
      var useId = useModel();
      var box = el("div", "local-chat");
      if (st.skip > 0) box.append(el("p", "dev-meta", "Older messages no longer fit in the model's memory, so Arc Pocket has forgotten them. Start a new chat to begin again."));
      var log = el("div", "local-log", null, { "aria-live": "polite" });
      if (!st.chat.length) log.append(el("p", "dev-meta", "Ask anything. Arc Pocket (" + model(useId).name + ") answers on this phone; the first answer takes longer while it loads."));
      st.chat.forEach(function (m) {
        if (m.kind === "tool") { log.append(el("p", "local-msg tool", m.note)); return; }
        if (m.role === "assistant" && !m.content && m.raw) return;   // only a tool call: the steps above say what happened
        log.append(el("p", "local-msg " + m.role, m.content || "..."));
      });
      box.append(log);
      var ta = el("textarea", "local-input", null, { rows: "2", placeholder: "Message", "aria-label": "Message" });
      ta.disabled = st.busy;
      ta.value = st.draft;
      var send = btn(st.busy ? "Stop" : "Send", st.busy ? "outline" : "primary", function () {
        if (st.busy) { st.stopped = true; native.stop(); return; }   // ends the whole answer, tool rounds included
        var text = ta.value.trim();
        if (text) ask(useId, text);
      });
      var row = el("div", "local-send");
      row.append(ta, send);
      box.append(st.pending ? approveCard(st.pending) : row);
      var tools = el("div", "local-tools");
      tools.append(btn("New chat", "outline sm", function () { if (!st.busy) { st.chat = []; st.skip = 0; draw(); } }));
      tools.append(btn("Models and storage", "outline sm", function () { if (!st.busy) { st.view = "manage"; refresh(); } }));
      if (canTools) {
        tools.append(btn(st.folders.length ? "Files: " + st.folders.length + " shared" : "Files: share a folder", "outline sm", function () { if (!st.busy) { st.view = "files"; refresh(); } }));
      }
      box.append(tools);
      box.append(el("p", "dev-meta sub", settingsLine() + " Answers can be wrong." + (toolsOn() ? " Arc Pocket asks before it reads or changes a file" + (st.mcpTools.length ? " or uses a computer tool." : ".") : st.folders.length ? " " + toolsProblem() : "")));
      root.append(box);
      log.scrollTop = log.scrollHeight;
    }

    // Tokens the messages may use: the window less the answer's room and a small reserve for the template.
    function budget() { return st.prof.ctx - st.prof.maxTokens - 64; }

    // The messages for the model: the system message, then the chat from st.skip up to `end`.
    function messages(end) {
      var msgs = [{ role: "system", content: toolsOn() ? PA.prompt(st.folders, st.prof.ctx, st.mcpTools) : SYSTEM }];
      st.chat.slice(st.skip, end).forEach(function (m) { msgs.push({ role: m.role, content: m.raw || m.content }); });
      return msgs;
    }

    // Most characters of a file one read gives the model: the room left in the window (3 characters a token, the same
    // estimate as PA.tokens, less the tool_response wrapping and the line that tells the model where the next part
    // starts, about 30 tokens), never less than the old fixed limits. At a 2048 window the floor can be more than the
    // room left; then the next send stubs or drops older content, as before.
    function room() { return budget() - PA.size(PA.fit(messages(), budget()).messages) - 32; }
    function readLimit() { return Math.max(st.prof.ctx >= 4096 ? 6000 : 2500, room() * 3); }
    // A computer tool's output has no next part to read, so it gets only the room left (a little at least).
    function toolLimit() { return Math.max(300, room() * 3); }

    // Asks the person before a tool call runs. Resolves true when allowed.
    function approve(d) {
      return new Promise(function (resolve) { st.pending = { d: d, done: resolve }; draw(); });
    }

    // Takes one tool call: asks, runs it, and adds the result to the chat as a tool entry.
    async function runCall(call) {
      var d = PA.describe(call, st.folders, st.mcpTools);
      var result, note;
      if (!d.ok) { result = "Error: " + d.error; note = "Could not use a tool: " + d.error; }
      else if (!(await approve(d))) { result = "The person did not allow this."; note = "Not allowed: " + d.title; }
      else {
        result = await PA.run(call, st.folders, files, d.mcp ? toolLimit() : readLimit(), mcp && { list: st.mcpTools, call: mcp.call });
        note = d.title + (/^Error(: | from )/.test(result) ? ": failed" : "");   // "Error from": the computer tool said it failed
      }
      st.chat.push({ role: "user", kind: "tool", content: PA.response(result), note: note });
      draw();
    }

    // The question, the answers and any tool steps are one unit: if the answer fails, all of them are removed.
    async function ask(id, text) {
      st.busy = true; st.stopped = false; st.error = ""; st.draft = "";
      var start = st.chat.length;
      st.chat.push({ role: "user", content: text });
      var answer = { role: "assistant", content: "" };
      st.chat.push(answer);
      draw();
      var off = native.on("token", function (t) {
        answer.content += t.text;   // `answer` is reassigned for each tool round; this listener reads the current one
        var shown = toolsOn() ? (PA.parse(answer.content).text || "...") : answer.content;
        var last = root.querySelector(".local-msg.assistant:last-of-type");
        if (last) last.textContent = shown; else draw();
      });
      // Sends the conversation, made to fit the model's memory first: old file texts, then the oldest turns go.
      // The plugin's TOO_LONG answer stays as a safety net, since the fit only estimates tokens.
      async function request() {
        for (;;) {
          var history = st.chat.slice(st.skip, -1);
          var msgs = messages(-1);
          if (PA) { var f = PA.fit(msgs, budget()); msgs = f.messages; st.skip += f.dropped; if (f.dropped) draw(); }
          var r = await native.chat({ messages: msgs, maxTokens: st.prof.maxTokens });
          if (r && r.error === "TOO_LONG" && history.length > 1) { st.skip += 2; answer.content = ""; continue; }
          if (r && r.error) throw new Error(r.error === "TOO_LONG" ? "That message is too long for the model's memory." : r.error);
          return;
        }
      }
      try {
        if (st.loadedId !== id) {
          answer.content = "Loading the model...";
          draw();
          await native.load({ id: id, threads: st.prof.threads, ctx: st.prof.ctx });
          st.loadedId = id;
          answer.content = "";
          draw();
        }
        await request();
        if (!toolsOn()) {
          if (!answer.content.trim()) answer.content = "(no answer)";
        } else {
          for (var step = 0; ; step++) {
            var p = PA.parse(answer.content);
            answer.raw = answer.content;
            answer.content = p.text;
            if (st.stopped) { delete answer.raw; break; }   // Stop: its calls are not run, nor kept without a result
            if (!p.calls.length) break;
            // Its unanswered calls are not kept, or the next question would start from a call with no result.
            if (step >= PA.MAX_STEPS) { answer.content = p.text || "I stopped here: too many steps for one question."; delete answer.raw; break; }
            // Each call gets a result, or the next round starts from a call that never came back.
            for (var i = 0; i < p.calls.length; i++) {
              // Stop during the batch: the calls after it are not run (their approval is never asked), but get a result.
              if (st.stopped) st.chat.push({ role: "user", kind: "tool", content: PA.response("Error: not run. The person pressed Stop."), note: "Not run: Stop was pressed" });
              else if (i < PA.MAX_CALLS) await runCall(p.calls[i]);
              else st.chat.push({ role: "user", kind: "tool", content: PA.response("Error: not run. At most " + PA.MAX_CALLS + " tool calls are taken from one answer."), note: "Not run: more than " + PA.MAX_CALLS + " tool calls in one answer" });
            }
            if (st.stopped) break;
            answer = { role: "assistant", content: "" };
            st.chat.push(answer);
            draw();
            await request();
          }
          if (!answer.content.trim()) answer.content = "(no answer)";
        }
      } catch (e) {
        st.chat.length = start;
        st.draft = text;
        st.skip = Math.min(st.skip, st.chat.length);
        st.error = e.message || String(e);
      } finally {
        if (off) off();
        st.busy = false;
        st.pending = null;
        draw();
      }
    }

    refresh();
    return { refresh: refresh };
  }

  window.ArcFlareLocalAI = { CHIPS: CHIPS, profile: profile, mount: mount, SYSTEM: SYSTEM };
})();
