// The model-loading backend of `arcflare phone` (makeBackend in lib/hub/cli.js): which model an agent gets for a
// tier, and when it must refuse to swap models under a running agent. The model loader and the model list are
// stubbed, so no llama-server and no model files are needed.

const test = require("node:test");
const assert = require("node:assert");

const serve = require("../lib/serve");
const models = require("../lib/models");
const { makeBackend } = require("../lib/hub/cli");

const orig = {
  loadConfig: serve.loadConfig, planningBudget: serve.planningBudget, contextChoices: serve.contextChoices,
  prepareModel: serve.prepareModel, discover: models.discover, resolve: models.resolve, loadMeta: models.loadMeta,
};
test.after(() => { Object.assign(serve, orig, {}); models.discover = orig.discover; models.resolve = orig.resolve; models.loadMeta = orig.loadMeta; });

/** A fresh world: installed models, hub config, a recording loader that can be told to fail, a server that can die. */
function world({ installed = ["small:q4", "big:q4"], tiers = { light: "small:q4", standard: "small:q4", hard: "big:q4" } } = {}) {
  const w = { loads: [], inflight: 0, maxInflight: 0, failFor: new Set(), up: true, agents: [] };
  serve.loadConfig = () => ({ hub: { tiers } });
  serve.planningBudget = async () => 1e12;
  serve.contextChoices = () => ({ best: { ctx: 8192, cacheType: "f16" } });
  serve.prepareModel = async (cfg, model) => {
    w.inflight++; w.maxInflight = Math.max(w.maxInflight, w.inflight);
    await new Promise((r) => setTimeout(r, 5));
    w.inflight--;
    w.loads.push(model.id);
    if (w.failFor.has(model.id)) return { failed: true, error: "out of memory" };
    return { port: 4321, servedId: "served-" + model.id, ctx: 8192 };
  };
  models.discover = () => installed.map((id) => ({ id }));
  models.resolve = (all, ref) => all.find((m) => m.id === ref) || null;
  models.loadMeta = () => ({ sampling: { temperature: 0.7 } });
  w.backend = makeBackend(() => ({ list: () => w.agents }), { engine: { status: async () => ({ running: w.up }) } });
  return w;
}

test("a tier gets its configured model, and asking again for the same model does not reload it", async () => {
  const w = world();
  const light = await w.backend("light");
  assert.deepStrictEqual([light.modelRef, light.model, light.port, light.nCtx], ["small:q4", "served-small:q4", 4321, 8192]);
  assert.deepStrictEqual(light.sampling, { temperature: 0.7 });
  const standard = await w.backend("standard");           // same model as light
  assert.strictEqual(standard.modelRef, "small:q4");
  assert.deepStrictEqual(w.loads, ["small:q4"], "loaded once");
});

test("a tier with nothing at or below it installed is refused, never given a stronger model", async () => {
  const w = world({ tiers: { hard: "big:q4" } });
  await assert.rejects(() => w.backend("light"), { code: "NO_MODEL" });
  assert.deepStrictEqual(w.loads, [], "nothing was loaded");
  const none = world({ installed: [] });
  await assert.rejects(() => none.backend("hard"), { code: "NO_MODEL" });
});

test("swapping models is refused while ANY live agent holds the loaded one, idle included", async () => {
  const w = world();
  await w.backend("light");
  for (const status of ["idle", "running", "starting", "waiting_approval"]) {
    w.agents = [{ id: "a", status, modelRef: "small:q4" }];
    await assert.rejects(() => w.backend("hard"), { code: "MODEL_BUSY" }, status);
  }
  assert.deepStrictEqual(w.loads, ["small:q4"], "the loaded model was never disturbed");
  w.agents = [{ id: "a", status: "stopped", modelRef: "small:q4" }, { id: "b", status: "error", modelRef: "small:q4" }];
  assert.strictEqual((await w.backend("hard")).modelRef, "big:q4", "stopped and failed agents do not block a swap");
});

test("two agents booting at once cannot swap under each other; one booting agent (the caller) can", async () => {
  const w = world();
  await w.backend("light");
  w.agents = [{ id: "me", status: "starting", modelRef: null }];
  assert.strictEqual((await w.backend("hard")).modelRef, "big:q4", "the caller itself is not a blocker");
  w.agents = [{ id: "me", status: "starting", modelRef: null }, { id: "other", status: "starting", modelRef: null }];
  await assert.rejects(() => w.backend("light"), { code: "MODEL_BUSY" });
});

test("a failed load leaves nothing cached: the next request loads again instead of using a dead server", async () => {
  const w = world();
  await w.backend("light");
  w.failFor.add("big:q4");
  await assert.rejects(() => w.backend("hard"), /out of memory/);
  assert.deepStrictEqual(w.loads, ["small:q4", "big:q4"]);
  const again = await w.backend("light");                // the loader had already stopped the old server
  assert.strictEqual(again.modelRef, "small:q4");
  assert.deepStrictEqual(w.loads, ["small:q4", "big:q4", "small:q4"], "small was loaded again, not served from the cache");
});

test("a server that has died since it was loaded is loaded again, not handed out", async () => {
  const w = world();
  await w.backend("light");
  w.up = false;                                          // crashed, or `arcflare stop`
  await w.backend("light");
  assert.deepStrictEqual(w.loads, ["small:q4", "small:q4"]);
  w.up = true;
  await w.backend("light");
  assert.deepStrictEqual(w.loads, ["small:q4", "small:q4"], "and a healthy server is reused");
});

test("loads never overlap, however many agents start at once, and one failure does not wedge the queue", async () => {
  const w = world();
  w.failFor.add("big:q4");
  const results = await Promise.allSettled([w.backend("hard"), w.backend("light"), w.backend("hard"), w.backend("standard")]);
  assert.strictEqual(w.maxInflight, 1, "one model load at a time");
  assert.strictEqual(results[0].status, "rejected");
  assert.strictEqual(results[1].status, "fulfilled", "the queue kept going after a failed load");
});
