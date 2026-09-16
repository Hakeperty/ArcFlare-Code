// The tool surface: what a harness sees when it connects to `arcflare mcp`.
//
// Five groups. Run things (run/start/logs/input/stop/ps), open things
// (open/launch/apps/sysinfo), see and touch the screen (screenshot/mouse/type/
// key/windows/focus/clipboard), check that what was built actually works
// (project/build/test/smoke/http), and get Blender into a state where the
// Blender MCP server can be used at all (blender/launch/run/render).
//
// The last group is the one that pays for this server. A harness can already
// run a shell command; what it cannot do is read 900 lines of test output on a
// small context budget. So build and test return a verdict, then the failures,
// then the log — and `smoke` goes further, starting an app, waiting for it to
// answer, asking it for a page, and shutting it down again, so "it works" is a
// measurement rather than an assumption.

const fs = require("fs");
const os = require("os");
const path = require("path");
const { URL } = require("url");

const { Server } = require("./server");
const { Supervisor, resolveShell, IS_WIN } = require("./procs");
const projectmod = require("./project");
const probe = require("./probe");
const apps = require("./apps");
const desktop = require("./desktop");
const blender = require("./blender");
const { Bridge } = require("./bridge");
const { describeTool } = require("../agent/mcp");
const { FORBIDDEN } = require("../agent/tools");

const VERSION = require("../../package.json").version;

const INSTRUCTIONS = `ArcFlare's machine server: this runs things on the user's own computer,
and what it starts keeps running until you stop it.

RUNNING
  * run     — a command that finishes (a build, a script, git). Blocks, returns output.
  * start   — a command that does not finish (a server, a watcher, a GUI app).
              Returns an id; come back with logs, input and stop.
  * ps/stop — what you left running, and how to end it. Stop what you start.

TESTING WHAT YOU BUILT
  Do not report software as working because a build exited 0.
  * project — read the directory first: what it is, and its real build/test/run commands.
  * build   — build it. Failures come back as parsed diagnostics, not a wall of log.
  * test    — run its tests. You get "2 of 56 failed" and the failing names first.
  * smoke   — for anything that serves or runs: starts it, waits until it answers,
              fetches a URL, checks the body, stops it, and reports a verdict.
  * http    — one request against something already running.

OPENING
  * open    — a file, folder or URL, exactly as a double-click would.
  * launch  — an application by name (PATH, then the start menu). apps searches names.

SEEING AND TOUCHING
  Opening a window is not seeing it, and a tool returning success is not proof
  the UI did anything. Work in a loop: screenshot, decide, ONE action,
  screenshot again.
  * screenshot — the whole desktop, one monitor, one window, or a region.
                 It comes back scaled; the result gives you the scale factor,
                 and every coordinate you send is a real screen pixel.
  * mouse      — move, click, double, right-click, drag, scroll at a point.
  * type / key — text into whatever has focus; key takes chords like ctrl+s.
                 Focus follows the window, not the screenshot: call focus first.
  * windows / focus — what is open, and bringing one to the front.
  * clipboard  — read it, or set it and paste with key ctrl+v. Long or awkward
                 text lands intact this way; typing it can be mangled.

BLENDER
  The Blender MCP server models, sculpts and renders through a running
  Blender; every one of its tools needs that Blender open with the bridge
  addon answering. These four are the machine underneath it.
  * blender        — where it is, what version, and whether a live one is reachable.
                     Call it first when a Blender tool fails to connect.
  * blender_launch — start it and wait until the bridge actually answers.
  * blender_run    — Python with no GUI and no bridge: read a .blend, convert,
                     batch-edit. Seconds, and it works with Blender closed.
  * blender_render — render headlessly and report the files that appeared.
  A script that raises still exits 0, so these read the log, not the code.

MANNERS
  Prefer the project's own commands over invented ones. Keep cwd inside the
  project you were asked about. Long output is truncated, so grep logs rather
  than asking for everything. And say what actually happened — a failed test is
  a finding, not something to work around.`;

const BRIDGE_INSTRUCTIONS = `

BRIDGED SERVERS
  Other MCP servers are reachable through this one — bridge_servers lists them,
  bridge_search finds a tool and returns its schema, bridge_call runs it. Their
  schemas are not loaded up front, so search before you call rather than
  guessing an argument shape.`;

const MAX_BODY = 4000;

// ------------------------------------------------------------------ policy --

function makePolicy(opts = {}) {
  const roots = (opts.roots || []).map((r) => path.resolve(r));
  return {
    roots,
    allowOpen: opts.allowOpen !== false,
    dir(p) {
      const abs = path.resolve(p || opts.cwd || process.cwd());
      if (roots.length && !roots.some((r) => abs === r || abs.startsWith(r + path.sep))) {
        throw new Error(`${abs} is outside the allowed roots (${roots.join(", ")})`);
      }
      return abs;
    },
    command(cmd) {
      const s = String(cmd || "");
      for (const re of FORBIDDEN) {
        if (re.test(s)) throw new Error(`refused — this command looks unrecoverable: ${s}`);
      }
      return s;
    },
  };
}

// ----------------------------------------------------------------- render ----

function fmtMs(ms) {
  if (ms == null) return "?";
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;
}

function tail(text, n) {
  const lines = String(text || "").split(/\r?\n/);
  if (lines.length <= n) return String(text || "");
  return `… ${lines.length - n} earlier lines\n` + lines.slice(-n).join("\n");
}

function block(title, body) {
  return body && String(body).trim() ? `\n--- ${title} ---\n${String(body).trimEnd()}` : "";
}

function runReport(r, { lines = 80, label } = {}) {
  if (r.error && r.code == null) return { text: `ERROR: ${r.error}`, isError: true };
  const verdict = r.timedOut ? "TIMED OUT" : r.ok ? "ok" : `exit ${r.code}`;
  const head = `${label ? label + ": " : ""}${verdict} · ${fmtMs(r.durationMs)} · ${r.shell} · ${r.cwd}\n$ ${r.command}`;
  const problems = r.ok ? [] : projectmod.diagnostics(r.output, 12);
  const probText = problems.length ? `\nproblems:\n` + problems.map((p) => "  " + p).join("\n") : "";
  const body = tail(r.output, lines) || "(no output)";
  return {
    text: head + probText + block("output", body) +
      (r.dropped ? `\n[${r.dropped} bytes of earlier output dropped]` : ""),
    isError: !r.ok,
  };
}

// ------------------------------------------------------------------ server ----

function createServer(opts = {}) {
  const policy = makePolicy(opts);
  const procs = new Supervisor();
  // Bridging is opt-in: the agent already connects every server itself, so
  // switching it on by default would give it each tool twice.
  const bridge = opts.bridge
    ? new Bridge({ cwd: opts.cwd || process.cwd(), include: opts.bridgeOnly || [] })
    : null;
  const server = new Server({
    name: "arcflare",
    version: VERSION,
    instructions: INSTRUCTIONS + (bridge ? BRIDGE_INSTRUCTIONS : ""),
    onClose: () => { procs.stopAll(); if (bridge) bridge.stopAll(); },
  });

  const S = (props, required) => ({ type: "object", properties: props, required: required || [] });
  const str = (description) => ({ type: "string", description });
  const int = (description) => ({ type: "integer", description });
  const bool = (description) => ({ type: "boolean", description });
  const shellProp = {
    type: "string",
    enum: ["auto", "bash", "cmd", "powershell", "pwsh", "none"],
    description: "Shell to run through. auto picks bash on Windows when present, " +
      "because PowerShell 5.1 has no && operator.",
  };

  // ------------------------------------------------------------- running ----

  server.tool("run",
    "Run a command and wait for it to finish. For anything that exits: builds, " +
    "scripts, git, installers. Use start instead for servers and GUI apps.",
    S({
      command: str("The command line, e.g. 'npm ci' or 'git status'"),
      cwd: str("Directory to run in (default: the server's working directory)"),
      shell: shellProp,
      timeout_ms: int("Give up after this long (default 180000, max 1800000)"),
      input: str("Text written to the command's stdin"),
      env: { type: "object", description: "Extra environment variables" },
      lines: int("How many lines of output to return (default 80)"),
    }, ["command"]),
    async (a) => {
      const cwd = policy.dir(a.cwd);
      const command = policy.command(a.command);
      const r = await procs.run({ ...a, command, cwd });
      return runReport(r, { lines: a.lines || 80 });
    });

  server.tool("start",
    "Start a long-running process in the background and return its id. For dev " +
    "servers, watchers, REPLs and GUI apps. It keeps running until you stop it.",
    S({
      command: str("The command line, e.g. 'npm run dev'"),
      cwd: str("Directory to run in"),
      shell: shellProp,
      name: str("A label for ps output"),
      env: { type: "object", description: "Extra environment variables" },
      wait_ms: int("Wait this long before returning, so early output and crashes show up (default 700)"),
    }, ["command"]),
    async (a) => {
      const cwd = policy.dir(a.cwd);
      const command = policy.command(a.command);
      procs.sweep();
      const rec = procs.start({ command, cwd, shell: a.shell, env: a.env, name: a.name });
      // A process that dies instantly is the common failure, and reporting
      // "started" for it would send the caller off to poll a corpse.
      await new Promise((r) => setTimeout(r, Math.min(Math.max(Number(a.wait_ms) || 700, 0), 15000)));
      const early = procs.logs(rec.id, { tail: 30 });
      if (rec.exitedAt != null) {
        return {
          text: `${rec.id} exited immediately (exit ${rec.code})\n$ ${rec.command}` +
            block("output", early.text || "(no output)"),
          isError: true,
        };
      }
      return `${rec.id} running · pid ${rec.pid} · ${rec.shell} · ${rec.cwd}\n$ ${rec.command}` +
        block("output so far", early.text || "(nothing yet)") +
        `\n\nstop it with: stop ${rec.id}`;
    });

  server.tool("logs",
    "Read the output of a background process started with start.",
    S({
      id: str("Process id, e.g. p1"),
      tail: int("Last N lines (default 120)"),
      grep: str("Only lines matching this regular expression"),
      stream: { type: "string", enum: ["merged", "stdout", "stderr"] },
    }, ["id"]),
    async (a) => {
      const { rec, text, dropped } = procs.logs(a.id, {
        tail: a.tail || 120, grep: a.grep, stream: a.stream || "merged",
      });
      const state = rec.exitedAt == null
        ? `running · pid ${rec.pid} · up ${fmtMs(Date.now() - rec.startedAt)}`
        : `exited ${rec.code} after ${fmtMs(rec.exitedAt - rec.startedAt)}`;
      return `${rec.id} ${state}\n$ ${rec.command}` +
        block("logs", text || "(no output)") +
        (dropped ? `\n[${dropped} bytes of earlier output dropped]` : "");
    });

  server.tool("input",
    "Write a line to a background process's stdin. For REPLs, prompts and " +
    "anything waiting on the keyboard.",
    S({
      id: str("Process id"),
      text: str("Text to send"),
      newline: bool("Append a newline (default true)"),
      wait_ms: int("Wait this long for a reply, then return the new output (default 500)"),
    }, ["id", "text"]),
    async (a) => {
      const before = procs.get(a.id).ring.bytes;
      procs.write(a.id, a.text, { newline: a.newline !== false });
      await new Promise((r) => setTimeout(r, Math.min(Math.max(Number(a.wait_ms) || 500, 0), 30000)));
      const { text } = procs.logs(a.id, { tail: 40 });
      return `sent to ${a.id} (${before} bytes buffered before)` + block("output", text);
    });

  server.tool("stop",
    "Stop a background process and everything it started.",
    S({ id: str("Process id, or 'all'") }, ["id"]),
    async (a) => {
      if (String(a.id).toLowerCase() === "all") {
        const live = procs.list().filter((p) => p.running);
        procs.stopAll();
        return live.length ? `stopped ${live.length}: ${live.map((p) => p.id).join(", ")}` : "nothing was running";
      }
      const { rec, alreadyExited } = procs.stop(a.id);
      if (alreadyExited) return `${rec.id} had already exited (${rec.code})`;
      // taskkill and a signal both return before the process is actually gone,
      // and "stopped" has to mean stopped — the next thing anyone does is bind
      // the port it was holding.
      const gone = await procs.waitFor(rec.id, (r) => r.exitedAt != null, 5000);
      return `${gone ? "stopped" : "signalled (still exiting)"} ${rec.id} ` +
        `(pid ${rec.pid}) · ${rec.command}`;
    });

  server.tool("ps",
    "List the processes this server has started, running and finished.",
    S({}),
    async () => {
      const list = procs.list();
      if (!list.length) return "nothing started yet";
      return list.map((p) =>
        `${p.running ? "●" : "·"} ${p.id.padEnd(4)} ${p.running ? "running" : "exit " + p.code}` +
        `  ${fmtMs(p.uptimeMs).padStart(7)}  pid ${String(p.pid || "-").padEnd(7)} ${p.command.slice(0, 70)}`
      ).join("\n");
    });

  // ------------------------------------------------------------- opening ----

  server.tool("open",
    "Open a file, folder or URL with whatever the OS uses for it — the same as " +
    "double-clicking it. Returns as soon as it is handed over.",
    S({
      target: str("A path or a URL"),
      args: { type: "array", items: { type: "string" }, description: "Extra arguments" },
    }, ["target"]),
    async (a) => {
      if (!policy.allowOpen) throw new Error("opening is disabled on this server (--no-open)");
      const t = String(a.target);
      const isUrl = /^[a-z][a-z0-9+.-]*:\/\//i.test(t) || /^(mailto|ms-settings):/i.test(t);
      const target = isUrl ? t : policy.dir(t);
      if (!isUrl && !fs.existsSync(target)) throw new Error(`no such file or folder: ${target}`);
      const r = apps.openWith(target, a.args || []);
      return `opened ${target} via ${r.launcher}`;
    });

  server.tool("launch",
    "Launch an application by name or path — PATH first, then the start menu. " +
    "Use apps to see what the name would match.",
    S({
      name: str("Application name or full path, e.g. 'blender' or 'Visual Studio Code'"),
      args: { type: "array", items: { type: "string" }, description: "Command-line arguments" },
    }, ["name"]),
    async (a) => {
      if (!policy.allowOpen) throw new Error("launching is disabled on this server (--no-open)");
      const r = await apps.launch(a.name, a.args || []);
      const alt = r.alternatives && r.alternatives.length
        ? `\nother matches: ${r.alternatives.join(", ")}` : "";
      return `launched ${r.name || a.name} via ${r.launcher} (${r.how})\n${r.target}` +
        (r.pid ? `\npid ${r.pid}` : "") +
        (r.fallback ? `\n${r.fallback}, so the OS was asked to open it instead` : "") + alt;
    });

  server.tool("apps",
    "Search the applications installed on this machine by name.",
    S({ query: str("Part of a name; omit to list everything"), limit: int("Default 20") }),
    async (a) => {
      const hits = apps.search(a.query || "", Math.min(Number(a.limit) || 20, 100));
      if (!hits.length) return `nothing matching "${a.query || ""}"`;
      return hits.map((h) => `${h.name}\n    ${h.path}`).join("\n");
    });

  server.tool("sysinfo",
    "What this machine is: OS, CPU, memory, disk, and which toolchains are on PATH.",
    S({ which: { type: "array", items: { type: "string" }, description: "Extra executables to look for" } }),
    async (a) => {
      const want = ["node", "npm", "git", "python", "cargo", "go", "dotnet", "java", "docker",
        ...(a.which || [])];
      const found = want.map((w) => {
        const p = apps.onPath(w);
        return `  ${p ? "✓" : "·"} ${w.padEnd(8)} ${p || "not on PATH"}`;
      });
      const gb = (n) => (n / 1024 / 1024 / 1024).toFixed(1) + " GB";
      return [
        `${os.type()} ${os.release()} · ${os.arch()} · host ${os.hostname()}`,
        `${os.cpus().length} cpus · ${os.cpus()[0] ? os.cpus()[0].model.trim() : "?"}`,
        `memory ${gb(os.totalmem() - os.freemem())} used of ${gb(os.totalmem())}`,
        `user ${os.userInfo().username} · home ${os.homedir()}`,
        `cwd ${process.cwd()}`,
        `shell for auto: ${resolveShell("auto", "").label}`,
        "toolchains:",
        ...found,
      ].join("\n");
    });

  // --------------------------------------------------- seeing and touching --

  const needsDesktop = () => {
    const s = desktop.support();
    if (!s.ok) throw new Error(s.how);
    if (!policy.allowOpen) throw new Error("desktop control is disabled on this server (--no-open)");
  };

  server.tool("screenshot",
    "Look at the screen: the whole desktop, one monitor, one window by title, " +
    "or a region. Returns the image plus the scale it was shrunk by.",
    S({
      window: str("Capture the window whose title contains this"),
      monitor: int("Capture monitor N (0 is primary)"),
      region: {
        type: "object",
        description: "Capture this rectangle in screen pixels",
        properties: { x: int(), y: int(), width: int(), height: int() },
      },
      max_width: int("Shrink to at most this wide (default 1400; 0 for full size)"),
      format: { type: "string", enum: ["png", "jpeg"] },
    }),
    async (a) => {
      needsDesktop();
      const shot = await desktop.screenshot(a);
      const note = shot.scale < 1
        ? `scaled ${shot.scale.toFixed(3)}× — a point (ix, iy) in this image is ` +
          `(${shot.x} + ix/${shot.scale.toFixed(3)}, ${shot.y} + iy/${shot.scale.toFixed(3)}) on screen`
        : "full size — image coordinates are screen coordinates";
      return {
        content: [
          {
            type: "text",
            text: `captured ${shot.width}×${shot.height} at (${shot.x}, ${shot.y})\n` +
              `image ${shot.shotWidth}×${shot.shotHeight} · ${Math.round(shot.bytes / 1024)} KB\n` +
              `${note}\nsaved: ${shot.file}`,
          },
          { type: "image", data: shot.base64, mimeType: shot.mimeType },
        ],
      };
    });

  server.tool("mouse",
    "Move, click, double-click, right-click, drag or scroll. Coordinates are " +
    "real screen pixels — convert from a scaled screenshot before clicking.",
    S({
      action: { type: "string", enum: ["move", "click", "double", "right", "down", "up", "drag", "scroll"] },
      x: int("Screen x"),
      y: int("Screen y"),
      to_x: int("Drag destination x"),
      to_y: int("Drag destination y"),
      button: { type: "string", enum: ["left", "right", "middle"] },
      amount: int("Scroll notches: positive scrolls up, negative down"),
    }, ["action"]),
    async (a) => {
      needsDesktop();
      // "right" is the action a caller reaches for; it is the left-button path
      // with a different button, and translating it here saves a wrong guess.
      const action = a.action === "right" ? "click" : a.action;
      const button = a.action === "right" ? "right" : (a.button || "left");
      const at = await desktop.mouse({ ...a, action, button });
      return `${a.action}${a.x != null ? ` at (${a.x}, ${a.y})` : ""}` +
        (action === "drag" ? ` → (${a.to_x}, ${a.to_y})` : "") +
        ` · cursor now (${at.x}, ${at.y})`;
    });

  server.tool("type",
    "Type text into whatever window has keyboard focus. Focus it first — " +
    "typing goes where the focus is, not where you last looked.",
    S({ text: str("The text to type; newlines are pressed as Enter") }, ["text"]),
    async (a) => {
      needsDesktop();
      const r = await desktop.typeText(a.text);
      return `typed ${r.sent} characters`;
    });

  server.tool("key",
    "Press a key or a chord, e.g. 'enter', 'ctrl+s', 'alt+f4', 'ctrl+shift+p'. " +
    "Pass several to press them in order.",
    S({
      keys: { description: "One chord, or a list of them",
        anyOf: [{ type: "string" }, { type: "array", items: { type: "string" } }] },
    }, ["keys"]),
    async (a) => {
      needsDesktop();
      const r = await desktop.pressKeys(a.keys);
      return `pressed ${r.pressed.join(" ")}`;
    });

  server.tool("windows",
    "List the open windows with their titles, owning process and position.",
    S({ match: str("Only titles containing this") }),
    async (a) => {
      needsDesktop();
      let list = await desktop.listWindows();
      if (a.match) {
        const q = String(a.match).toLowerCase();
        list = list.filter((w) => String(w.title).toLowerCase().includes(q));
      }
      if (!list.length) return a.match ? `no window matching "${a.match}"` : "no windows with titles";
      return list.map((w) =>
        `${String(w.title).slice(0, 60).padEnd(60)} ${w.name} (pid ${w.pid}) ` +
        `${w.width}×${w.height} at (${w.x}, ${w.y})`).join("\n");
    });

  server.tool("focus",
    "Bring a window to the front by title, restoring it if minimised. Do this " +
    "before typing.",
    S({ title: str("Part of the window title") }, ["title"]),
    async (a) => {
      needsDesktop();
      const w = await desktop.focusWindow(a.title);
      const others = [].concat(w.others || []).filter(Boolean);
      return `focused ${w.title} (${w.name}, pid ${w.pid})` +
        (w.focused === false ? "\nWindows refused to bring it to the front — click it first" : "") +
        (others.length
          ? `\n${others.length} other window(s) also matched "${a.title}": ${others.slice(0, 5).join(" · ")}` +
            `\nbe sure this is the one you meant before typing`
          : "");
    });

  server.tool("clipboard",
    "Read the clipboard, or set it. Setting it and pressing ctrl+v is the " +
    "reliable way to enter long or awkward text.",
    S({ set: str("Text to put on the clipboard; omit to read it") }),
    async (a) => {
      needsDesktop();
      if (a.set == null) {
        const text = await desktop.clipboardGet();
        return text ? `clipboard (${text.length} chars):\n${text.slice(0, 8000)}` : "clipboard is empty";
      }
      const r = await desktop.clipboardSet(a.set);
      return `clipboard set (${r.bytes} bytes)`;
    });

  // -------------------------------------------------------------- bridge ----

  if (bridge) {
    server.tool("bridge_servers",
      "List the other MCP servers bridged through this one — what they are, " +
      "whether they connected, and how many tools each brought.",
      S({ connect: bool("Connect them now if they are not connected yet") }),
      async (a) => {
        if (a.connect) await bridge.connect();
        const rows = bridge.status();
        if (!rows.length) return "no servers configured to bridge";
        const lines = rows.map((s) => {
          const mark = s.status === "connected" ? "✓" : s.status === "failed" ? "✗" : "·";
          const detail = s.status === "connected"
            ? `${s.tools} tools in ${fmtMs(s.ms)}`
            : s.status === "failed" ? s.error : "not connected yet";
          return `${mark} ${s.name.padEnd(18)} ${s.kind.padEnd(5)} ${detail}\n    ${String(s.target).slice(0, 100)}`;
        });
        return lines.join("\n") +
          `\n\nSearch their tools with bridge_search, then run one with bridge_call.`;
      });

    server.tool("bridge_search",
      "Search every bridged server's tools by keyword. Returns each match with " +
      "its full argument schema, ready to pass to bridge_call.",
      S({
        query: str("Keywords, e.g. 'blender render' or 'screenshot'"),
        limit: int("How many matches (default 8)"),
      }, ["query"]),
      async (a) => {
        const hits = await bridge.search(a.query, Math.min(Number(a.limit) || 8, 25));
        if (!hits.length) {
          const connected = bridge.status().filter((s) => s.status === "connected");
          return `nothing matched "${a.query}" across ${connected.length} connected server(s). ` +
            `Call bridge_servers to see what is available.`;
        }
        return hits.map((t) => describeTool(t)).join("\n\n");
      });

    server.tool("bridge_call",
      "Call a tool on a bridged server, using the namespaced id and schema that " +
      "bridge_search returned.",
      S({
        tool: str("Namespaced id, e.g. blender__screenshot_viewport"),
        arguments: { type: "object", description: "Arguments matching that tool's schema" },
        timeout_ms: int("Default 300000"),
      }, ["tool"]),
      async (a) => {
        const r = await bridge.call(a.tool, a.arguments || {}, a.timeout_ms);
        // Images and other non-text parts are worth passing straight through:
        // a render nobody can look at is not a render.
        const parts = ((r.raw && r.raw.content) || []).filter((c) => c.type !== "text");
        if (!parts.length) return { text: r.text, isError: !!(r.raw && r.raw.isError) };
        return {
          content: [{ type: "text", text: r.text || `(${parts.length} non-text result(s))` }, ...parts],
          isError: !!(r.raw && r.raw.isError),
        };
      });
  }

  // ------------------------------------------------------------- testing ----

  server.tool("project",
    "Read a directory and report what kind of project it is, plus its real " +
    "install, build, test and run commands. Call this before build or test.",
    S({ dir: str("Project directory (default: working directory)") }),
    async (a) => {
      const dir = policy.dir(a.dir);
      const info = projectmod.detect(dir);
      if (!info.types.length) {
        const ls = fs.readdirSync(dir).slice(0, 40).join(", ");
        return `${dir}\nno known project type here.\ncontents: ${ls}`;
      }
      const lines = [`${dir}`, `type: ${info.types.map((t) => t.label).join(", ")}`];
      const p = info.primary;
      if (p.name) lines.push(`name: ${p.name}${p.version ? " " + p.version : ""}`);
      for (const phase of ["install", "build", "test", "start", "lint"]) {
        const c = projectmod.commandFor(info, phase);
        if (c) lines.push(`${phase.padEnd(8)} ${c.command}${info.types.length > 1 ? `   (${c.from})` : ""}`);
      }
      if (info.scripts && Object.keys(info.scripts).length) {
        lines.push("scripts: " + Object.keys(info.scripts).join(", "));
      }
      if (p.targets && p.targets.length) lines.push("make targets: " + p.targets.slice(0, 20).join(", "));
      return lines.join("\n");
    });

  server.tool("build",
    "Build a project. Uses the project's own build command unless you pass one. " +
    "A failure comes back as parsed compiler diagnostics first, log second.",
    S({
      dir: str("Project directory"),
      command: str("Override the detected build command"),
      shell: shellProp,
      timeout_ms: int("Default 600000"),
      lines: int("Log lines to return (default 60)"),
    }),
    async (a) => {
      const dir = policy.dir(a.dir);
      const info = projectmod.detect(dir);
      const chosen = a.command || (projectmod.commandFor(info, "build") || {}).command;
      if (!chosen) {
        return {
          text: `no build command for ${dir} (${info.types.map((t) => t.label).join(", ") || "unknown project"}).\n` +
            `Pass command: explicitly, or call project to see what is available.`,
          isError: true,
        };
      }
      const r = await procs.run({
        command: policy.command(chosen), cwd: dir, shell: a.shell,
        timeout_ms: a.timeout_ms || 600000,
      });
      const rep = runReport(r, { lines: a.lines || 60, label: "build" });
      return rep;
    });

  server.tool("test",
    "Run a project's tests and report a verdict: how many passed, which ones " +
    "failed, and the relevant output. Understands node:test, jest, vitest, " +
    "pytest, cargo, go test, dotnet and mocha.",
    S({
      dir: str("Project directory"),
      command: str("Override the detected test command"),
      shell: shellProp,
      timeout_ms: int("Default 600000"),
      lines: int("Log lines to return (default 60)"),
    }),
    async (a) => {
      const dir = policy.dir(a.dir);
      const info = projectmod.detect(dir);
      const chosen = a.command || (projectmod.commandFor(info, "test") || {}).command;
      if (!chosen) {
        return {
          text: `no test command for ${dir} (${info.types.map((t) => t.label).join(", ") || "unknown project"}).\n` +
            `Pass command: explicitly, or call project to see what is available.`,
          isError: true,
        };
      }
      const r = await procs.run({
        command: policy.command(chosen), cwd: dir, shell: a.shell,
        timeout_ms: a.timeout_ms || 600000,
      });
      const sum = projectmod.summarizeTests(r.output);
      const head = sum
        ? `tests ${sum.ok && r.ok ? "PASSED" : "FAILED"} · ${sum.failed} of ${sum.total} failed` +
          `${sum.skipped ? ` · ${sum.skipped} skipped` : ""} · ${sum.framework} · ${fmtMs(r.durationMs)}`
        : `tests ${r.ok ? "PASSED" : "FAILED"} · exit ${r.code} · ${fmtMs(r.durationMs)} · (no summary line recognised)`;
      const failing = sum && sum.failing.length
        ? "\nfailing:\n" + sum.failing.map((f) => "  - " + f).join("\n") : "";
      const problems = (!r.ok && (!sum || !sum.failing.length))
        ? (() => {
            const d = projectmod.diagnostics(r.output, 10);
            return d.length ? "\nproblems:\n" + d.map((x) => "  " + x).join("\n") : "";
          })()
        : "";
      return {
        text: `${head}\n$ ${chosen}   (${dir})` + failing + problems +
          block("output", tail(r.output, a.lines || 60) || "(no output)"),
        isError: !r.ok || !!(sum && !sum.ok),
      };
    });

  server.tool("http",
    "Make one HTTP request — to check that something already running answers.",
    S({
      url: str("e.g. http://127.0.0.1:3000/health"),
      method: str("GET, POST, …"),
      body: str("Request body"),
      headers: { type: "object", description: "Request headers" },
      wait_ms: int("Keep retrying for this long while the connection is refused"),
      timeout_ms: int("Per-request timeout (default 10000)"),
    }, ["url"]),
    async (a) => {
      const res = await probe.httpProbe(a.url, a);
      if (res.error) return { text: `${a.url}\n${probe.describe(res)}`, isError: true };
      return `${a.method || "GET"} ${a.url}\n${probe.describe(res)}` +
        block("body", res.body.slice(0, MAX_BODY));
    });

  server.tool("smoke",
    "Test software you just built, end to end: start it, wait until it answers, " +
    "fetch a URL, check the response, stop it, and report a verdict. The honest " +
    "way to claim a web app or server works.",
    S({
      command: str("How to start it, e.g. 'npm run dev'. Defaults to the project's own start command."),
      dir: str("Project directory"),
      url: str("What to fetch once it is up. Defaults to http://127.0.0.1:<port>/"),
      port: int("Port to wait for. Inferred from url when omitted."),
      ready_log: str("Regular expression: treat the app as ready when its output matches this"),
      expect_status: int("Fail unless the response has this status"),
      expect_text: str("Fail unless the response body contains this"),
      ready_timeout_ms: int("How long to wait for it to come up (default 45000)"),
      keep_running: bool("Leave it running afterwards (default false)"),
      shell: shellProp,
    })
    , async (a) => {
      const dir = policy.dir(a.dir);
      const info = projectmod.detect(dir);
      const chosen = a.command || (projectmod.commandFor(info, "start") || {}).command;
      if (!chosen) {
        return {
          text: `no run command for ${dir}. Pass command: explicitly, or call project first.`,
          isError: true,
        };
      }
      let url = a.url || null;
      let port = a.port || null;
      if (!port && url) { try { port = Number(new URL(url).port) || null; } catch {} }
      if (!url && port) url = `http://127.0.0.1:${port}/`;

      const readyTimeout = Math.min(Math.max(Number(a.ready_timeout_ms) || 45000, 1000), 300000);
      procs.sweep();
      const rec = procs.start({
        command: policy.command(chosen), cwd: dir, shell: a.shell, name: "smoke",
      });
      const started = Date.now();
      const notes = [`started ${rec.id} (pid ${rec.pid}) · $ ${rec.command}`];

      let ready = false;
      let readyBy = "";
      if (a.ready_log) {
        let re;
        try { re = new RegExp(a.ready_log, "i"); } catch (e) { throw new Error(`bad ready_log: ${e.message}`); }
        ready = await procs.waitFor(rec.id, (r) => re.test(r.ring.text("merged")), readyTimeout);
        readyBy = ready ? `output matched /${a.ready_log}/` : `output never matched /${a.ready_log}/`;
      } else if (port) {
        const w = await probe.waitUntil(() => probe.portOpen("127.0.0.1", port),
          { timeoutMs: readyTimeout, intervalMs: 250 });
        ready = w.ok;
        readyBy = ready ? `port ${port} open` : `port ${port} never opened`;
      } else {
        // Nothing to wait on: give it a moment and judge it by whether it is
        // still alive, which is all the information there is.
        await new Promise((r) => setTimeout(r, 1500));
        ready = rec.exitedAt == null;
        readyBy = ready ? "still running (no port or pattern given to wait for)" : "exited";
      }
      notes.push(`ready: ${readyBy} after ${fmtMs(Date.now() - started)}`);

      const died = rec.exitedAt != null;
      let res = null;
      if (ready && !died && url) {
        res = await probe.httpProbe(url, { wait_ms: 4000, timeout_ms: 10000 });
        notes.push(`GET ${url} → ${probe.describe(res)}`);
      }

      const checks = [];
      if (died) checks.push(`process exited early (exit ${rec.code})`);
      if (!ready) checks.push("never became ready");
      if (url && res && res.error) checks.push(`no HTTP answer (${res.error})`);
      if (res && res.status && a.expect_status && res.status !== a.expect_status) {
        checks.push(`expected status ${a.expect_status}, got ${res.status}`);
      }
      if (res && res.body != null && a.expect_text && !res.body.includes(a.expect_text)) {
        checks.push(`response body does not contain "${a.expect_text}"`);
      }
      if (res && res.status >= 500) checks.push(`server error ${res.status}`);

      if (!a.keep_running) {
        try {
          procs.stop(rec.id);
          const gone = await procs.waitFor(rec.id, (r) => r.exitedAt != null, 5000);
          notes.push(gone ? "stopped it again" : "asked it to stop; still exiting");
        } catch {}
      } else {
        notes.push(`left running as ${rec.id} — stop it when you are done`);
      }

      const pass = checks.length === 0;
      const logs = procs.logs(rec.id, { tail: 40 }).text;
      return {
        text: `smoke: ${pass ? "PASS" : "FAIL"}\n` + notes.map((n) => "  " + n).join("\n") +
          (checks.length ? "\nproblems:\n" + checks.map((c) => "  - " + c).join("\n") : "") +
          (res && res.body ? block("response body", res.body.slice(0, 1200)) : "") +
          block("logs", logs || "(no output)"),
        isError: !pass,
      };
    });

  // ------------------------------------------------------------- blender ----
  //
  // Four machine-level tools, not a modelling suite. Everything an artist
  // actually wants to do lives in the Blender MCP server; all of it needs a
  // running Blender with the bridge addon answering, and these are what get
  // you there and tell you whether you are.

  server.tool("blender",
    "Where Blender is, what version, and whether a live one is reachable for " +
    "the Blender MCP tools. Call this first when anything Blender-related fails.",
    S({ all: bool("List every install found, not just the one that would be used") }),
    async (a) => {
      const installs = blender.installations();
      if (!installs.length) {
        return {
          text: "no Blender found\n" +
            `  looked in: ${blender.searchRoots().join(", ")}\n` +
            "  set BLENDER=/path/to/blender if it lives somewhere else",
          isError: true,
        };
      }
      const chosen = installs[0];

      // The folder name is not the version — an in-place upgrade leaves
      // "Blender 4.2" holding 5.2 — so ask the binary.
      let version = null;
      const v = await procs.run({
        exe: chosen.path, args: ["--version"], shell: "none", timeout_ms: 20000,
      });
      version = blender.parseVersion(v.output);

      const live = await blender.bridgeStatus();
      const lines = [
        `blender  ${version || "(version unknown)"}`,
        `  exe    ${chosen.path}`,
      ];
      if (a.all && installs.length > 1) {
        for (const i of installs.slice(1)) lines.push(`  also   ${i.path}`);
      } else if (installs.length > 1) {
        lines.push(`  also   ${installs.length - 1} other install(s) — pass all:true`);
      }

      if (live.reachable) {
        lines.push(`  bridge answering on port ${live.port}`);
        const st = live.status;
        if (st && typeof st === "object") {
          const bits = Object.entries(st)
            .filter(([, val]) => val != null && typeof val !== "object")
            .slice(0, 8)
            .map(([k, val]) => `${k}=${val}`);
          if (bits.length) lines.push(`  scene  ${bits.join(" · ")}`);
        }
        lines.push("", "A live Blender is reachable: the Blender MCP tools will work.");
      } else {
        lines.push(`  bridge port ${live.port}: ${live.error}`);
        lines.push(`         ${live.likely}`);
        lines.push("", "For GUI work, start it with blender_launch. For anything that " +
          "does not need a window — reading a .blend, converting, batch rendering — " +
          "blender_run and blender_render are faster and need no bridge at all.");
      }
      return lines.join("\n");
    });

  server.tool("blender_launch",
    "Start Blender and wait until its MCP bridge addon actually answers, so " +
    "the Blender tools are usable. Returns once it is ready, or says why not.",
    S({
      blend: str("A .blend file to open"),
      wait_ms: int("How long to wait for the bridge to answer (default 90000)"),
      no_wait: bool("Return as soon as it is spawned, without waiting for the bridge"),
    }),
    async (a) => {
      if (!policy.allowOpen) throw new Error("launching is disabled on this server (--no-open)");
      const chosen = blender.find();
      if (!chosen) throw new Error("no Blender found — set BLENDER=/path/to/blender");

      const already = await blender.bridgeStatus();
      if (already.reachable) {
        return `Blender is already running and its bridge answers on port ${already.port}. ` +
          `Nothing to do.`;
      }

      const args = a.blend ? [policy.dir(a.blend)] : [];
      const rec = procs.start({
        exe: chosen.path, args, shell: "none", name: "blender",
        cwd: opts.cwd || process.cwd(),
      });

      if (a.no_wait) {
        return `${rec.id} starting · pid ${rec.pid} · ${chosen.path}\n` +
          `Not waiting for the bridge. Check it with blender.`;
      }

      // Blender opens its window long before the addon registers its socket,
      // so the window appearing is not the thing to wait for.
      const waitMs = Math.min(Math.max(Number(a.wait_ms) || 90000, 2000), 300000);
      const deadline = Date.now() + waitMs;
      let last = already;
      while (Date.now() < deadline) {
        if (rec.exitedAt != null) {
          return {
            text: `Blender exited while starting (exit ${rec.code})` +
              block("output", procs.logs(rec.id, { tail: 30 }).text || "(no output)"),
            isError: true,
          };
        }
        await new Promise((r) => setTimeout(r, 1000));
        last = await blender.bridgeStatus();
        if (last.reachable) {
          return `Blender is up and the bridge answers on port ${last.port} ` +
            `(${fmtMs(waitMs - (deadline - Date.now()))}) · ${rec.id} pid ${rec.pid}\n` +
            `The Blender MCP tools will work now.`;
        }
      }
      return {
        text: `Blender started (${rec.id} pid ${rec.pid}) but the bridge never answered ` +
          `on port ${last.port} within ${fmtMs(waitMs)}.\n` +
          `The window is probably open — the MCP bridge addon is most likely not enabled ` +
          `(Edit ▸ Preferences ▸ Add-ons). Headless work does not need it: see blender_run.` +
          block("output", procs.logs(rec.id, { tail: 20 }).text || "(no output)"),
        isError: true,
      };
    });

  server.tool("blender_run",
    "Run Python inside Blender with no GUI and no bridge — reading a .blend, " +
    "converting formats, batch edits. Seconds, and it works with Blender closed.",
    S({
      expr: str("Python source to run, e.g. \"import bpy; print(len(bpy.data.objects))\""),
      script: str("A .py file to run instead of expr"),
      blend: str("A .blend file to open first"),
      args: { type: "array", items: { type: "string" }, description: "Passed to the script after --" },
      user_startup: bool("Load the user's addons and preferences (default false: faster and reproducible)"),
      timeout_ms: int("Default 300000"),
    }),
    async (a) => {
      const chosen = blender.find();
      if (!chosen) throw new Error("no Blender found — set BLENDER=/path/to/blender");
      if (!a.expr && !a.script) throw new Error("pass expr or script");

      const args = blender.headlessArgs({
        blend: a.blend ? policy.dir(a.blend) : null,
        expr: a.expr,
        script: a.script ? policy.dir(a.script) : null,
        factoryStartup: !a.user_startup,
        args: a.args || [],
      });
      const started = Date.now();
      const r = await procs.run({
        exe: chosen.path, args, shell: "none",
        cwd: opts.cwd || process.cwd(),
        timeout_ms: Math.min(Math.max(Number(a.timeout_ms) || 300000, 5000), 1800000),
      });

      // Blender prints a traceback and then exits 0. Reading the exit code
      // alone would report a script that raised as a clean run.
      const err = blender.pythonError(r.output);
      const clean = blender.cleanOutput(r.output);
      const verdict = r.timedOut ? "TIMED OUT" : err.failed ? "FAILED" : r.ok ? "ok" : `exit ${r.code}`;
      const head = `blender_run: ${verdict} · ${fmtMs(Date.now() - started)} · ${chosen.path}`;

      if (err.failed) {
        // Whatever the script printed before it died is worth keeping, but the
        // traceback already has its own block and printing it twice just costs
        // context.
        const extra = clean.text.split("\n")
          .filter((l) => !err.detail.includes(l.replace(/^\[stderr\]\s?/, "").trim()))
          .join("\n").trim();
        return {
          text: `${head}\n${err.summary}` + block("traceback", err.detail) +
            block("printed before it failed", extra),
          isError: true,
        };
      }
      return {
        text: head +
          (clean.notes.length ? "\n" + clean.notes.map((n) => "  " + n).join("\n") : "") +
          block("output", clean.text || "(the script printed nothing)"),
        isError: !r.ok || r.timedOut,
      };
    });

  server.tool("blender_render",
    "Render a .blend headlessly and report the image files it actually wrote. " +
    "No GUI, no bridge; for final frames and batches rather than look iteration.",
    S({
      blend: str("The .blend file to render"),
      output: str("Output path prefix — Blender appends the frame number and extension"),
      frame: int("Frame to render (default 1)"),
      engine: { type: "string", enum: ["CYCLES", "BLENDER_EEVEE_NEXT", "BLENDER_WORKBENCH"],
        description: "Override the engine saved in the file" },
      format: str("PNG, JPEG, OPEN_EXR, …"),
      samples: int("Override the sample count"),
      timeout_ms: int("Default 1800000 — renders are slow"),
    }, ["blend"]),
    async (a) => {
      const chosen = blender.find();
      if (!chosen) throw new Error("no Blender found — set BLENDER=/path/to/blender");
      const blend = policy.dir(a.blend);
      if (!fs.existsSync(blend)) throw new Error(`no such file: ${blend}`);

      // Somewhere to put it, if nobody said. Rendering into the .blend's own
      // folder is what Blender does by default and it surprises people.
      const output = a.output
        ? policy.dir(a.output)
        : path.join(os.tmpdir(), "arcflare-render", path.basename(blend, ".blend") + "_");
      fs.mkdirSync(path.dirname(output), { recursive: true });

      const started = Date.now();
      const r = await procs.run({
        exe: chosen.path, shell: "none",
        cwd: opts.cwd || process.cwd(),
        args: blender.renderArgs({
          blend, output, frame: a.frame, engine: a.engine,
          format: a.format, samples: a.samples,
        }),
        timeout_ms: Math.min(Math.max(Number(a.timeout_ms) || 1800000, 10000), 7200000),
      });

      const err = blender.pythonError(r.output);
      const files = blender.renderedFiles(output, started);
      const ms = Date.now() - started;

      // A render that wrote no file did not render, whatever it exited with.
      if (!files.length) {
        return {
          text: `render FAILED · ${fmtMs(ms)} · no output file appeared at ${output}*\n` +
            (err.failed ? err.summary + "\n" : "") +
            (r.timedOut ? "the render timed out\n" : "") +
            block("output", tail(r.output, 40)),
          isError: true,
        };
      }
      const list = files.slice(0, 8)
        .map((f) => `  ${f.path}  ${(f.bytes / 1024).toFixed(0)} KB`).join("\n");
      return `render ok · ${fmtMs(ms)} · ${files.length} file(s)\n${list}\n` +
        `  engine ${a.engine || "(as saved in the file)"} · frame ${a.frame == null ? 1 : a.frame}`;
    });

  server.procs = procs;
  server.bridge = bridge;
  return server;
}

module.exports = { createServer, makePolicy, INSTRUCTIONS, runReport, fmtMs, tail };
