#!/usr/bin/env node
// A stand-in for llama-server, for tests that load models without a GPU.
//
// It speaks the parts of llama-server that ArcFlare drives: --version,
// --list-devices, the router preset, /health, /v1/models, /tokenize and a
// streamed /v1/chat/completions with `timings`. How fast it claims to read a
// prompt depends on the preset's batch size and thread count, so a test can
// check that tuning finds the setting this "machine" is fastest with.
//
//   FAKE_LOG       append one JSON line per server start (to count loads)
//   FAKE_BEST_UB   the batch size that reads fastest (default 1024)
//   FAKE_BEST_T    the thread count that reads fastest (default: none)
//   FAKE_MAX_UB    batches above this fail to load, as out of device memory
//   FAKE_DEVICE    the --list-devices line ("" prints none)
//   FAKE_SPEED     multiplies every rate (a faster or slower "backend")

const fs = require("fs");
const path = require("path");
const http = require("http");

// Settings in a fake.json beside the binary override the environment, so two
// "builds" in one test can differ.
try { Object.assign(process.env, JSON.parse(fs.readFileSync(path.join(path.dirname(process.argv[1]), "fake.json"), "utf8"))); } catch { /* none */ }

const argv = process.argv.slice(2);
const arg = (name) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : null; };

if (argv.includes("--version")) { console.log("version: 9999 (fake)"); process.exit(0); }
if (argv.includes("--list-devices")) {
  const dev = process.env.FAKE_DEVICE;
  console.log("Available devices:");
  if (dev !== "") console.log(dev || "  Vulkan0: Fake GPU (16384 MiB, 16000 MiB free)");
  process.exit(0);
}

const port = Number(arg("--port"));
const sections = {};
const preset = arg("--models-preset");
if (preset && fs.existsSync(preset)) {
  let cur = null;
  for (const line of fs.readFileSync(preset, "utf8").split(/\r?\n/)) {
    const sec = /^\[(.+)\]$/.exec(line.trim());
    if (sec) { cur = sec[1] === "*" ? null : (sections[sec[1]] = {}); continue; }
    const kv = /^([^=]+?)\s*=\s*(.*)$/.exec(line);
    if (kv && cur) cur[kv[1].trim()] = kv[2].trim();
  }
}
if (process.env.FAKE_LOG) {
  fs.appendFileSync(process.env.FAKE_LOG, JSON.stringify({ pid: process.pid, port, sections }) + "\n");
}

const bestUb = Number(process.env.FAKE_BEST_UB || 1024);
const bestT = Number(process.env.FAKE_BEST_T || 0);
const maxUb = Number(process.env.FAKE_MAX_UB || Infinity);

function rates(opts) {
  let prefill = 1000;
  if (Number(opts.ub) === bestUb) prefill *= 1.5;
  if (bestT && Number(opts.threads) === bestT) prefill *= 1.4;
  const k = Number(process.env.FAKE_SPEED || 1);
  return { prefill: prefill * k, gen: 50 * k };
}

const send = (res, code, obj) => {
  const body = JSON.stringify(obj);
  res.writeHead(code, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) });
  res.end(body);
};

http.createServer((req, res) => {
  let body = "";
  req.on("data", (d) => (body += d));
  req.on("end", () => {
    if (req.url === "/health") return send(res, 200, { status: "ok" });
    if (req.url === "/v1/models") {
      return send(res, 200, { data: Object.entries(sections).map(([id, o]) => ({
        id, status: { value: "loaded", args: ["--model", o.model] },
      })) });
    }
    if (req.url === "/tokenize") {
      const j = JSON.parse(body || "{}");
      return send(res, 200, { tokens: new Array(Math.ceil(String(j.content || "").length / 4)).fill(1) });
    }
    if (req.url === "/v1/chat/completions") {
      const j = JSON.parse(body || "{}");
      const opts = sections[j.model];
      if (!opts) return send(res, 404, { error: { message: "model not found" } });
      if (Number(opts.ub) > maxUb) {
        console.log("ErrorOutOfDeviceMemory");
        return send(res, 500, { error: { message: "failed to load model" } });
      }
      const r = rates(opts);
      const promptN = Math.ceil(JSON.stringify(j.messages || []).length / 4);
      const timings = { prompt_n: promptN, prompt_per_second: r.prefill, predicted_n: 8, predicted_per_second: r.gen };
      if (!j.stream) {
        return send(res, 200, { choices: [{ message: { role: "assistant", content: "OK" }, finish_reason: "stop" }], timings });
      }
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "OK" } }] })}\n\n`);
      res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }], timings })}\n\n`);
      return res.end("data: [DONE]\n\n");
    }
    send(res, 404, { error: { message: "not found" } });
  });
}).listen(port, "127.0.0.1");

process.on("SIGTERM", () => process.exit(0));
