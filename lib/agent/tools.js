// Built-in tools for the agent loop.
//
// The tool list is deliberately small and, more importantly, *stable*. Tool
// schemas sit at the front of the prompt, so llama.cpp can reuse its prompt
// cache across turns only while they do not change. Growing the tool array as
// MCP tools are discovered would invalidate that prefix and force a full
// reprocess of the conversation — at ~250 tok/s prefill, re-reading a 20k-token
// session costs about 80 seconds. So MCP tools are reached through one stable
// `mcp_call` entry point instead, and their schemas arrive as tool *results*.

const fs = require("fs");
const path = require("path");
const { spawn, spawnSync } = require("child_process");

const MAX_OUT = 30000;

function clip(text, limit = MAX_OUT) {
  const s = String(text ?? "");
  if (s.length <= limit) return s;
  return s.slice(0, limit) + `\n… [truncated, ${s.length - limit} more characters]`;
}

function def(name, description, properties, required = []) {
  return {
    type: "function",
    function: { name, description, parameters: { type: "object", properties, required } },
  };
}

const SCHEMAS = [
  def("read_file", "Read a text file. Use offset/limit for large files.", {
    path: { type: "string", description: "File path" },
    offset: { type: "integer", description: "First line (1-based)" },
    limit: { type: "integer", description: "How many lines" },
  }, ["path"]),

  def("write_file", "Create or overwrite a file with the given content.", {
    path: { type: "string" },
    content: { type: "string" },
  }, ["path", "content"]),

  def("edit_file", "Replace an exact string in a file. Fails if not found or ambiguous.", {
    path: { type: "string" },
    old_string: { type: "string", description: "Exact text to replace" },
    new_string: { type: "string" },
    replace_all: { type: "boolean" },
  }, ["path", "old_string", "new_string"]),

  def("list_dir", "List the entries of a directory.", {
    path: { type: "string" },
  }, ["path"]),

  def("glob", "Find files matching a glob pattern, newest first.", {
    pattern: { type: "string", description: "e.g. src/**/*.js" },
    path: { type: "string", description: "Directory to search from" },
  }, ["pattern"]),

  def("grep", "Search file contents with a regular expression.", {
    pattern: { type: "string" },
    path: { type: "string" },
    glob: { type: "string", description: "Restrict to matching files" },
  }, ["pattern"]),

  def("bash", "Run a shell command and return its output.", {
    command: { type: "string" },
    cwd: { type: "string" },
    timeout_ms: { type: "integer" },
  }, ["command"]),

  def("skill_load", "Load the full instructions for a named skill from the skill index.", {
    name: { type: "string" },
  }, ["name"]),

  def("tool_search",
    "Search connected MCP servers for tools. Returns each match with its full " +
    "argument schema, which you then pass to mcp_call.", {
    query: { type: "string", description: "Keywords, e.g. 'blender render'" },
  }, ["query"]),

  def("mcp_call", "Call an MCP tool found via tool_search.", {
    tool: { type: "string", description: "Namespaced id, e.g. blender__screenshot_viewport" },
    arguments: { type: "object", description: "Arguments matching that tool's schema" },
  }, ["tool"]),
];

// Commands we refuse outright. Not a security boundary — a guard against a
// small model confidently doing something unrecoverable.
const FORBIDDEN = [
  /\brm\s+-rf\s+[\/~]\s*$/,
  /\brm\s+-rf\s+\/(?:\s|$)/,
  /\bmkfs\b/,
  /\bdd\s+.*of=\/dev\/(sd|nvme|hd)/,
  /:\(\)\s*\{.*\}\s*;\s*:/,           // fork bomb
  /\bformat\s+[a-z]:/i,
  /Remove-Item\s+.*-Recurse.*[Cc]:\\\s*$/,
];

function globToRe(pattern) {
  let re = "";
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i];
    if (ch === "*") {
      if (pattern[i + 1] === "*") { re += ".*"; i++; if (pattern[i + 1] === "/") i++; }
      else re += "[^/\\\\]*";
    } else if (ch === "?") re += "[^/\\\\]";
    else if ("\\^$+.()|{}[]".includes(ch)) re += "\\" + ch;
    else if (ch === "/") re += "[/\\\\]";
    else re += ch;
  }
  return new RegExp("^" + re + "$", "i");
}

function walkFiles(dir, depth, out, limit) {
  if (depth < 0 || out.length >= limit) return;
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    if (out.length >= limit) return;
    if (e.name === "node_modules" || e.name === ".git") continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walkFiles(full, depth - 1, out, limit);
    else out.push(full);
  }
}

/**
 * Real path of `f`, following symlinks; for a path that does not exist yet,
 * the real path of its nearest existing ancestor plus the rest.
 */
function realish(f) {
  let rest = [];
  let cur = f;
  for (;;) {
    try { return path.join(fs.realpathSync.native(cur), ...rest); }
    catch {
      const up = path.dirname(cur);
      if (up === cur) return f;
      rest.unshift(path.basename(cur));
      cur = up;
    }
  }
}

function inside(child, root) {
  const norm = (p) => (process.platform === "win32" ? p.toLowerCase() : p);
  const rel = path.relative(norm(root), norm(child));
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

/**
 * What an approver said, as `{ action, command?, reason? }`.
 *
 * Approvers used to answer true/false; they still may. Newer ones answer an
 * object: allow, deny, skip (don't run it, let the model carry on) or edit
 * (run `command` instead — shell commands only).
 */
function decision(v) {
  if (v === true) return { action: "allow" };
  if (v && typeof v === "object" && typeof v.action === "string") return v;
  return { action: "deny" };
}

const SKIPPED = (what, reason) =>
  `SKIPPED: the user chose not to ${what}${reason ? ` ("${String(reason).slice(0, 500)}")` : ""}. ` +
  "Nothing was changed. Carry on with the task without it, or say what you need it for.";

/** A short plain-text form of a write, for approvers that only take a string. */
function writeDetail(rel, oldText, newText) {
  const { lineDiff, diffStat, capRows, splitLines } = require("./diff");
  if (oldText == null) {
    const lines = splitLines(newText);
    return `${rel} (new file, ${lines.length} line${lines.length === 1 ? "" : "s"})\n` +
      lines.slice(0, 12).map((l) => `+ ${l}`).join("\n") +
      (lines.length > 12 ? `\n… ${lines.length - 12} more lines` : "");
  }
  const rows = lineDiff(oldText, newText);
  const { del, add } = diffStat(rows);
  return `${rel} (-${del} +${add})\n` +
    capRows(rows.filter((r) => r.sign !== " "), 16).map((r) => `${r.sign} ${r.text}`).join("\n");
}

/** Build the executor. `ctx` supplies skills, the MCP registry and policy. */
function makeExecutor(ctx) {
  const cwd = () => ctx.cwd || process.cwd();
  // Folders this agent may touch. The hub passes its allowlist, so a file tool
  // cannot read ~/.ssh or write outside the project the way a path like
  // "../../x" or "C:/Users/me/.ssh/id_ed25519" otherwise would. Shell commands
  // are a separate boundary: they go through approval.
  const roots = Array.isArray(ctx.roots) && ctx.roots.length ? ctx.roots.map((r) => realish(path.resolve(r))) : null;
  const allowed = (f) => !roots || roots.some((r) => inside(realish(f), r));
  const outside = (f) => Object.assign(new Error(`${f} is outside the folders this agent may use`), { code: "OUTSIDE_ROOTS" });
  const resolve = (p) => {
    // A model that leaves the path out must hear that, not "no such file: <cwd>/undefined".
    if (typeof p !== "string" || !p) throw new Error("path is required (a string)");
    const f = path.resolve(cwd(), p);
    if (!roots) return f;
    // A network path is refused before anything touches it: even a stat of \\host\share makes Windows open an
    // SMB session and send the person's NTLM hash, and a file the agent reads can ask for exactly that.
    // (\\?\ and \\.\ device paths are refused the same way.)
    if (/^[\\/]{2}/.test(String(p)) || /^[\\/]{2}/.test(f)) throw outside(String(p));
    // A dangling symlink has no real path, so realish() would judge it by its
    // parent folder, and a write would then follow it out of the roots and
    // create the target (~/.bash_profile, a Startup script). Links must resolve.
    let link = false;
    try { link = fs.lstatSync(f).isSymbolicLink(); } catch { /* does not exist: fine */ }
    if (link) {
      let real;
      try { real = fs.realpathSync.native(f); } catch { throw outside(f); }
      if (!roots.some((r) => inside(real, r))) throw outside(f);
    }
    if (!allowed(f)) throw outside(f);
    return f;
  };
  const rel = (f) => path.relative(cwd(), f) || f;

  // Ask the approver, passing the full call as a third argument; old
  // (kind, detail) approvers simply ignore it.
  const ask = async (kind, detail, call) => decision(await ctx.approve(kind, detail, call));

  /** Approve a file change, with a preview of what it does. null = go ahead. */
  async function approveWrite(tool, f, oldText, newText) {
    if (!ctx.approve || ctx.approveWrites === false) return null;
    const d = await ask("write", writeDetail(rel(f), oldText, newText),
      { tool, kind: "write", path: f, rel: rel(f), oldText, newText, isNew: oldText == null });
    if (d.action === "allow") return null;
    if (d.action === "skip" || d.action === "edit") return SKIPPED(`write ${rel(f)}`, d.reason);
    return `ERROR: the user declined this change to ${rel(f)}. Don't retry it; ask what they want instead.`;
  }

  /** A file's text as it is now, or null if it doesn't exist. */
  function current(f) {
    try {
      const st = fs.statSync(f);
      if (!st.isFile()) return null;
      if (st.size > 2e6) return "";
      return fs.readFileSync(f, "utf8");
    } catch { return null; }
  }

  const impl = {
    async read_file({ path: p, offset, limit }) {
      const f = resolve(p);
      if (!fs.existsSync(f)) return `ERROR: no such file: ${f}`;
      const st = fs.statSync(f);
      if (st.isDirectory()) return `ERROR: ${f} is a directory`;
      const text = fs.readFileSync(f, "utf8");
      const lines = text.split(/\r?\n/);
      const start = Math.max(0, (offset || 1) - 1);
      const end = limit ? start + limit : Math.min(lines.length, start + 2000);
      const slice = lines.slice(start, end);
      const numbered = slice.map((l, i) => `${start + i + 1}\t${l}`).join("\n");
      const more = end < lines.length ? `\n… ${lines.length - end} more lines` : "";
      return clip(numbered + more);
    },

    async write_file({ path: p, content }) {
      const f = resolve(p);
      if (content != null && typeof content !== "string") return "ERROR: content must be a string (for JSON, send the text of the file).";
      const stop = await approveWrite("write_file", f, current(f), content ?? "");
      if (stop) return stop;
      // Checked again after the wait for approval: a folder swapped for a link meanwhile is not followed out.
      if (resolve(p) !== f) throw outside(f);
      if (ctx.onBeforeWrite) ctx.onBeforeWrite(f);
      fs.mkdirSync(path.dirname(f), { recursive: true });
      fs.writeFileSync(f, content ?? "");
      return `wrote ${f} (${Buffer.byteLength(content ?? "")} bytes)`;
    },

    async edit_file({ path: p, old_string, new_string, replace_all }) {
      const f = resolve(p);
      if (!fs.existsSync(f)) return `ERROR: no such file: ${f}`;
      // An empty old_string "matches" between every two characters: with replace_all it would scatter
      // new_string through the whole file. A missing new_string means "delete", not the word "undefined".
      if (typeof old_string !== "string" || !old_string) {
        return "ERROR: old_string must be the exact text to replace, and not empty. To write a whole file use write_file.";
      }
      if (new_string == null) new_string = "";
      if (typeof new_string !== "string") return "ERROR: new_string must be a string.";
      const text = fs.readFileSync(f, "utf8");
      if (!text.includes(old_string)) {
        return "ERROR: old_string not found. Read the file first and copy the text exactly.";
      }
      const count = text.split(old_string).length - 1;
      if (count > 1 && !replace_all) {
        return `ERROR: old_string appears ${count} times. Add more context or set replace_all.`;
      }
      const out = replace_all
        ? text.split(old_string).join(new_string)
        : text.replace(old_string, () => new_string);
      const stop = await approveWrite("edit_file", f, text, out);
      if (stop) return stop;
      if (resolve(p) !== f) throw outside(f);
      if (ctx.onBeforeWrite) ctx.onBeforeWrite(f);
      fs.writeFileSync(f, out);
      return `edited ${f} (${count} replacement${count === 1 ? "" : "s"})`;
    },

    async list_dir({ path: p }) {
      const d = resolve(p || ".");
      let entries;
      try { entries = fs.readdirSync(d, { withFileTypes: true }); }
      catch (e) { return `ERROR: ${e.message}`; }
      return clip(entries
        .map((e) => (e.isDirectory() ? e.name + "/" : e.name))
        .sort()
        .join("\n") || "(empty)");
    },

    async glob({ pattern, path: p }) {
      if (typeof pattern !== "string" || !pattern) return "ERROR: pattern is required, e.g. src/**/*.js";
      const root = resolve(p || ".");
      const out = [];
      walkFiles(root, 8, out, 5000);
      const re = globToRe(pattern.replace(/^\.\//, ""));
      const hits = out
        .map((f) => ({ f, rel: path.relative(root, f).replace(/\\/g, "/") }))
        .filter((x) => re.test(x.rel) || re.test(path.basename(x.f)))
        .sort((a, b) => {
          try { return fs.statSync(b.f).mtimeMs - fs.statSync(a.f).mtimeMs; }
          catch { return 0; }
        })
        .slice(0, 200)
        .map((x) => x.rel);
      return hits.length ? clip(hits.join("\n")) : "(no matches)";
    },

    async grep({ pattern, path: p, glob: g }) {
      if (typeof pattern !== "string" || !pattern) return "ERROR: pattern is required (a regular expression)";
      const root = resolve(p || ".");
      let re;
      try { re = new RegExp(pattern, "i"); }
      catch (e) { return `ERROR: bad regex: ${e.message}`; }
      const files = [];
      walkFiles(root, 8, files, 5000);
      const gre = g ? globToRe(g) : null;
      const out = [];
      for (const f of files) {
        const rel = path.relative(root, f).replace(/\\/g, "/");
        if (gre && !gre.test(rel) && !gre.test(path.basename(f))) continue;
        if (!allowed(f)) continue;
        let text;
        try {
          if (fs.statSync(f).size > 2e6) continue;
          text = fs.readFileSync(f, "utf8");
        } catch { continue; }
        const lines = text.split(/\r?\n/);
        for (let i = 0; i < lines.length; i++) {
          if (re.test(lines[i])) {
            out.push(`${rel}:${i + 1}: ${lines[i].trim().slice(0, 200)}`);
            if (out.length >= 200) return clip(out.join("\n"));
          }
        }
      }
      return out.length ? clip(out.join("\n")) : "(no matches)";
    },

    async bash({ command, cwd: c, timeout_ms }, signal) {
      const refused = (cmd) => FORBIDDEN.some((re) => re.test(cmd));
      if (refused(command)) return `ERROR: refused — this command looks destructive: ${command}`;
      let note = "";
      if (ctx.approve) {
        const d = await ask("bash", command, { tool: "bash", kind: "bash", command, cwd: c ? resolve(c) : cwd() });
        if (d.action === "skip") return SKIPPED("run this command", d.reason);
        if (d.action === "edit") {
          const edited = String(d.command || "").trim();
          if (!edited) return SKIPPED("run this command", d.reason);
          if (edited !== command.trim()) {
            if (refused(edited)) return `ERROR: refused — the edited command looks destructive: ${edited}`;
            // The model has to know: its next step builds on what actually ran.
            note = `NOTE: the user edited the command before it ran. What ran instead:\n${edited}\n\n`;
            command = edited;
          }
        } else if (d.action !== "allow") {
          return "ERROR: the user declined to run this command.";
        }
      }
      if (signal && signal.aborted) return INTERRUPTED;
      const r = await runShell(command, { cwd: c ? resolve(c) : cwd(), timeoutMs: timeout_ms || 120000, signal });
      if (r.error) return note + `ERROR: ${r.error}`;
      const body = ((r.stdout || "") + (r.stderr ? "\n[stderr]\n" + r.stderr : "")).trim();
      if (r.aborted) return note + (body ? clip(body) + "\n" : "") + INTERRUPTED;
      if (r.timedOut) return note + (body ? clip(body) + "\n" : "") + `[timed out after ${Math.round((timeout_ms || 120000) / 1000)} s]`;
      return note + clip(body || `(no output, exit ${r.status})`) +
        (r.status ? `\n[exit ${r.status}]` : "");
    },

    async skill_load({ name }) {
      const s = ctx.skills && require("./skills").load(ctx.skills, name);
      if (!s) return `ERROR: no skill named "${name}"`;
      const extra = s.files && s.files.length
        ? `\n\nFiles in this skill's directory (${s.dir}):\n` + s.files.join("\n")
        : "";
      return clip(`# Skill: ${s.name}\n\n${s.body}${extra}`, 40000);
    },

    async tool_search({ query }) {
      if (!ctx.mcp) return "No MCP servers are connected.";
      const hits = ctx.mcp.search(query, 6);
      if (!hits.length) {
        const servers = [...ctx.mcp.servers.keys()].join(", ");
        return `No MCP tools matched "${query}". Connected servers: ${servers}. ` +
          `Search with one word naming the server and one naming the action.`;
      }
      return clip(hits.map((t) => ctx.mcp.describe(t)).join("\n\n"), 12000);
    },

    async mcp_call({ tool, arguments: args }) {
      if (!ctx.mcp) return "ERROR: no MCP servers are connected.";
      if (ctx.approve) {
        const d = await ask("mcp", `${tool} ${JSON.stringify(args || {})}`,
          { tool: "mcp_call", kind: "mcp", name: tool, args: args || {} });
        if (d.action === "skip") return SKIPPED(`call ${tool}`, d.reason);
        if (d.action !== "allow") return "ERROR: the user declined this tool call.";
      }
      try {
        const res = await ctx.mcp.call(tool, args || {});
        return clip(require("./mcp").resultToText(res));
      } catch (e) {
        return `ERROR: ${e.message}`;
      }
    },
  };

  // `opts.signal` interrupts a running shell command (Ctrl+C in the agent).
  return async function execute(name, args, opts = {}) {
    const fn = impl[name];
    if (!fn) return `ERROR: unknown tool "${name}"`;
    if (opts.signal && opts.signal.aborted) return INTERRUPTED;
    try {
      return await fn(args || {}, opts.signal);
    } catch (e) {
      return `ERROR: ${e && e.message ? e.message : String(e)}`;
    }
  };
}

const INTERRUPTED = "ERROR: interrupted by the user";

/**
 * Run a shell command without blocking the event loop, so Ctrl+C can stop it.
 * Stopping kills the whole process tree: a build or a dev server started by
 * the command must not outlive it.
 */
function runShell(command, { cwd, timeoutMs = 120000, signal } = {}) {
  return new Promise((done) => {
    const isWin = process.platform === "win32";
    let child;
    try {
      child = spawn(isWin ? "bash" : "/bin/sh", ["-c", command], {
        cwd, windowsHide: true, detached: !isWin, stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (e) {
      return done({ error: e.message });
    }
    const LIMIT = 16 * 1024 * 1024;
    let stdout = "", stderr = "", finished = false, aborted = false, timedOut = false;
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (d) => { if (stdout.length < LIMIT) stdout += d; });
    child.stderr.on("data", (d) => { if (stderr.length < LIMIT) stderr += d; });
    const timer = setTimeout(() => { timedOut = true; killTree(child); }, timeoutMs);
    const onAbort = () => { aborted = true; killTree(child); };
    if (signal) signal.addEventListener("abort", onAbort, { once: true });
    const finish = (res) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      if (signal) signal.removeEventListener("abort", onAbort);
      done(res);
    };
    child.on("error", (e) => finish({ error: e.message }));
    child.on("close", (status) => finish({ stdout, stderr, status, aborted, timedOut }));
  });
}

function killTree(child) {
  if (!child || child.exitCode !== null) return;
  try {
    if (process.platform === "win32") {
      spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
    } else {
      process.kill(-child.pid, "SIGKILL");
    }
  } catch {
    try { child.kill("SIGKILL"); } catch {}
  }
}

module.exports = { SCHEMAS, makeExecutor, clip, globToRe, FORBIDDEN, runShell, INTERRUPTED, decision };
