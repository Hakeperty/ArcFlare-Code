// Resident generation workers: the model stays loaded between jobs.
//
// The one-shot worker pays the model load on every job — for Qwen3-TTS that
// was ~35 s of a 43 s run. A long-lived app (the desktop app, a server) runs
// `worker.py --serve` instead: one process per Python environment, jobs sent
// as JSON lines, the last model kept in memory.
//
// Memory is the cost, so it is bounded twice: the worker itself holds only one
// model (a different one evicts it), and an idle worker is told to unload after
// `unloadAfterMs` and is stopped after `exitAfterMs`. VRAM a person is not
// using comes back on its own.

const { spawn } = require("child_process");
const path = require("path");

const WORKER = path.join(__dirname, "worker.py");

class ResidentWorker {
  constructor(python, env, opts = {}) {
    this.python = python;
    this.env = env;
    this.opts = { unloadAfterMs: 10 * 60 * 1000, exitAfterMs: 30 * 60 * 1000, worker: WORKER, ...opts };
    this.child = null;
    this.ready = null;
    this.queue = [];
    this.current = null;
    this.seq = 0;
    this.errTail = [];
    this.idleTimers = [];
  }

  _start() {
    if (this.child) return this.ready;
    const child = spawn(this.python, [this.opts.worker, "--serve"], {
      env: this.env, windowsHide: true, stdio: ["pipe", "pipe", "pipe"],
    });
    this.child = child;
    let out = "";
    this.ready = new Promise((resolve, reject) => {
      this._readyResolve = resolve;
      this._readyReject = reject;
    });
    child.stdout.on("data", (d) => {
      out += d.toString("utf8");
      let i;
      while ((i = out.indexOf("\n")) >= 0) {
        const line = out.slice(0, i).trim();
        out = out.slice(i + 1);
        if (!line.startsWith("{")) continue;
        let ev;
        try { ev = JSON.parse(line); } catch { continue; }
        this._event(ev);
      }
    });
    child.stderr.on("data", (d) => {
      this.errTail = this.errTail.concat(d.toString("utf8").split(/\r?\n|\r/).filter((l) => l.trim())).slice(-40);
    });
    const died = (why) => {
      this.child = null;
      if (this._readyReject) { this._readyReject(new Error(why)); this._readyReject = null; }
      const err = new Error(why);
      err.stderr = this.errTail.join("\n");
      if (this.current) { this.current.reject(err); this.current = null; }
      for (const j of this.queue.splice(0)) j.reject(err);
    };
    child.on("error", (e) => died(e.message));
    child.on("exit", (code) => died(`generation worker exited (code ${code})`));
    return this.ready;
  }

  _event(ev) {
    if (ev.event === "ready" && !ev.job) {
      if (this._readyResolve) { this._readyResolve(); this._readyResolve = null; this._readyReject = null; }
      return;
    }
    const job = this.current;
    if (!job || ev.job !== job.id) return;
    if (ev.event === "done") { this.current = null; job.resolve(ev); this._next(); return; }
    if (ev.event === "error") {
      this.current = null;
      const err = new Error(ev.message || "generation failed");
      err.stderr = this.errTail.join("\n");
      job.reject(err);
      this._next();
      return;
    }
    if (job.onEvent) job.onEvent(ev);
  }

  _armIdle() {
    this.idleTimers.forEach(clearTimeout);
    this.idleTimers = [
      setTimeout(() => { if (!this.current && this.child) this._send({ id: `u${++this.seq}`, cmd: "unload" }); }, this.opts.unloadAfterMs),
      setTimeout(() => { if (!this.current) this.stop(); }, this.opts.exitAfterMs),
    ];
    this.idleTimers.forEach((t) => t.unref && t.unref());
  }

  _send(msg) {
    if (this.child) this.child.stdin.write(JSON.stringify(msg) + "\n");
  }

  async _next() {
    if (this.current || !this.queue.length) { if (!this.current) this._armIdle(); return; }
    const job = this.queue.shift();
    this.current = job;
    try {
      await this._start();
    } catch (e) {
      this.current = null;
      job.reject(e);
      return this._next();
    }
    this._send({ id: job.id, spec: job.spec });
  }

  /** Run one job. Same contract as runWorker: resolves to the done event. */
  run(spec, { onEvent, signal } = {}) {
    this.idleTimers.forEach(clearTimeout);
    return new Promise((resolve, reject) => {
      const job = { id: `j${++this.seq}`, spec, onEvent, resolve, reject };
      if (signal) {
        signal.addEventListener("abort", () => {
          // A running job cannot be interrupted mid-tensor; stopping the process
          // is the only real cancel, and the next job starts a fresh one.
          if (this.current === job) this.stop();
          else {
            this.queue = this.queue.filter((j) => j !== job);
            reject(new Error("cancelled"));
          }
        }, { once: true });
      }
      this.queue.push(job);
      this._next();
    });
  }

  /** Free the model now, keeping the process. */
  unload() { if (this.child && !this.current) this._send({ id: `u${++this.seq}`, cmd: "unload" }); }

  stop() {
    this.idleTimers.forEach(clearTimeout);
    if (this.child) {
      try { this.child.stdin.end(); } catch { /* already closed */ }
      try { this.child.kill(); } catch { /* already gone */ }
    }
    this.child = null;
  }
}

/** One resident worker per (python, import path) — envs cannot share a process. */
class ResidentPool {
  constructor(opts = {}) { this.opts = opts; this.workers = new Map(); }

  /** A drop-in for gen.runWorker: `(python, spec, {env, onEvent, signal})`. */
  runner() {
    return (python, spec, o = {}) => {
      const key = `${python}|${(o.env && o.env.PYTHONPATH) || ""}`;
      let w = this.workers.get(key);
      if (!w) { w = new ResidentWorker(python, o.env, this.opts); this.workers.set(key, w); }
      return w.run(spec, { onEvent: o.onEvent, signal: o.signal });
    };
  }

  unloadAll() { for (const w of this.workers.values()) w.unload(); }
  stopAll() { for (const w of this.workers.values()) w.stop(); this.workers.clear(); }
}

module.exports = { ResidentWorker, ResidentPool, WORKER };
