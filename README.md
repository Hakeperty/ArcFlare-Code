# ArcFlare

> Run local GGUF models and point any coding harness at them — `arcflare`, pick a
> harness, pick a model, go.

ArcFlare is a thin, zero-dependency front end for
[llama.cpp](https://github.com/ggml-org/llama.cpp). It finds the models you
already have, starts `llama-server` with sane settings for your GPU, and wires
up whichever coding agent you want to use — OpenCode, Hermes, Codex — so they
talk to your local model instead of a cloud API.

```
❯ arcflare

  ArcFlare · local models, any harness

  Choose a harness
  ArcFlare will point it at your local model

  ❯ ArcFlare chat   built in
    ArcFlare agent  built in
    OpenCode
    Hermes
    Hermes Desktop
    Codex CLI

  ↑/↓ move · enter select · esc cancel
```

## What changed in 1.0

ArcFlare 0.x embedded llama.cpp in-process through `node-llama-cpp`. 1.0 drives
the stock `llama-server` binary as a child process instead. That one change
does most of the work:

| | 0.x | 1.0 |
| --- | --- | --- |
| npm dependencies | `node-llama-cpp` (bundled native engine) | **none** |
| CLI resident memory | Node + native engine + model allocator | **~28 MB RSS** |
| Engine build | whatever ships with the binding | **your own tuned llama.cpp** |
| Multiple models | one at a time, in-process | router serves many, loads on demand |
| Context sizing | fixed 2048 default | **model max, auto-fitted to free VRAM** |

The model is mapped once, by the engine that owns it. ArcFlare just supervises.

## Install

```bash
git clone https://github.com/Hakeperty/ArcFlare-Code.git
cd ArcFlare-Code
npm link          # no install step — there are no dependencies
```

Requires Node 18+ and a llama.cpp build. ArcFlare looks for `llama-server` on
`PATH`, then in `~/llamacpp/{vulkan,cuda,rocm}` and the usual places. If it
lives somewhere else:

```bash
arcflare set-engine /path/to/llama-server
```

Check everything at once:

```bash
arcflare doctor
```

```
  ✓ llama-server  C:\Users\harry\llamacpp\vulkan\llama-server.exe
  ✓ backend       vulkan  AMD Radeon(TM) 8060S Graphics (active)
  · backend       rocm    build loads but enumerates no device (driver or runtime)
  ✓ memory        balanced profile
  ✓ device memory 45.4 GB free
  ✓ models        4 found
  ✓ ArcFlare chat  built in
  ✓ OpenCode       ...\hermes\node\opencode
  ✓ Hermes         ...\hermes\bin\hermes.exe
  ✓ Hermes Desktop ...\hermes\bin\hermes.exe
  ✓ Codex CLI      ...\hermes\node\codex
  ✓ mcp server    26 tools · arcflare mcp
  ✓ blender       C:\Program Files\Blender Foundation\Blender 5.2\blender.exe
  · blender bridge port 9886 — not running (headless still works)
  · server        stopped
```

## Commands

| Command | What it does |
| --- | --- |
| `arcflare` | The menu: harness → model → context |
| `arcflare ls` | List discovered GGUF models |
| `arcflare pull <repo>[:Q]` | Download a GGUF from Hugging Face |
| `arcflare run <model>` | Start the server and chat |
| `arcflare agent [model]` | Coding agent: tools, MCP, skills |
| `arcflare mcp` | Run the machine server on stdio (for any MCP client) |
| `arcflare mcp --install` | Register it in `~/.arcflare/mcp.json` |
| `arcflare use <harness> [model]` | Configure and launch a harness |
| `arcflare use <harness> --no-launch` | Configure it and stop there |
| `arcflare use <harness> --yolo` | `--ask` | Launch it with approvals off, or on |
| `arcflare serve [--port N]` | Start the server only |
| `arcflare ps` | Server status and loaded models |
| `arcflare stop` | Stop the server |
| `arcflare logs [-n N]` | Tail the server log |
| `arcflare backend [kind]` | List or select a llama.cpp backend (vulkan/rocm/cuda) |
| `arcflare memory [profile]` | `lean` \| `balanced` \| `max` |
| `arcflare batch [size]` | Physical batch: prefill speed against VRAM |
| `arcflare fit [model]` | What fits, and with `--run` what actually runs best |
| `arcflare doctor` | Check engine, GPU and harnesses |
| `arcflare set-engine <path>` | Remember where `llama-server` lives |

`arcflare <model>` is shorthand for `arcflare run <model>`.

## Models

ArcFlare doesn't keep its own model store. It reads the GGUFs you already have,
searching in order:

1. `$ARCFLARE_MODELS`
2. `$LLAMA_CACHE` — the llama.cpp download cache
3. `~/.arcflare/models`
4. `~/llamacpp/models`
5. the platform llama.cpp cache

It understands the Hugging Face cache layout, groups multi-part shards, and
picks up `mmproj-*.gguf` (vision) and `mtp-*.gguf` (speculative decoding)
sidecars sitting next to a model.

Drafts are also matched across repos. The HF cache splits one model over two of
them - the Qwen3.8-27B draft ships from `ggml-org` while the weights come from
`unsloth` - so a strictly same-directory scan finds no draft and speculative
decoding stays off without ever saying so. A draft is matched to any model of
the same family in any search root. Vision projectors are deliberately *not*:
an `mmproj` is repo-local, and pairing one with another model's weights would
be a real mistake rather than a missed optimisation.

```
❯ arcflare ls
  qwen3.6-35b-a3b:ud-q6_k_xl  Q6_K · 30.4 GB · 256K ctx · MoE 8/256
  qwen3.6-35b-a3b:ud-q5_k_xl  Q5_K_M · 25.3 GB · 256K ctx · MoE 8/256
  qwen3.8-27b:ud-q5_k_m       Q5_K_M · 18.4 GB · 256K ctx
```

## Context sizing

ArcFlare reads each model's GGUF header and works out what a given context
actually costs, then offers the largest size that fits your free VRAM — with
the model's trained maximum first in the list.

It accounts for **hybrid attention**. On Qwen3.5/3.6/3.8-class models only every
Nth layer keeps a growing KV cache; the rest are linear-attention layers with
fixed-size state. Assuming every layer attends overestimates the cache by 4× and
makes max context look impossible when it isn't:

| model | layers | attending | KV/token (f16) | 256K context |
| --- | --- | --- | --- | --- |
| Qwen3.8-27B | 65 | 16 | 64 KiB | 17.2 GB |
| Qwen3.6-35B-A3B | 41 | 10 | 20 KiB | 5.4 GB |

MLA models (DeepSeek, GLM-lite) are handled too — there the cache is one
compressed latent per layer rather than separate K and V.

On top of that, ArcFlare **verifies rather than predicts**. Reported free memory
is a budget, not a promise: llama.cpp printed "46522 MiB free" both while a 30 GB
model was resident and immediately after that process exited. So ArcFlare
cross-checks against what the OS reports as in use, then loads the model and
halves the context if the device still refuses it:

```
  loading Qwen3.6-35B-A3B @ 256K ctx...
  . did not fit - retrying at 128K
  + loaded at 128K context  (reduced from 256K - device could not fit it)
```

You get the largest context that genuinely works, rather than a confident number
and an `ErrorOutOfDeviceMemory` at first request.

## Backends

Shipping kernels for your GPU is not the same as being able to use it. ArcFlare
finds every llama.cpp build on the machine and asks each one what devices it can
actually see:

```
> arcflare backend
  OK  vulkan:vulkan        ~/llamacpp/vulkan  <- active
      Vulkan0  AMD Radeon(TM) 8060S Graphics (47.8 GB, 45.4 GB free)
  --  rocm:rocm            ~/llamacpp/rocm
      build loads but enumerates no device (driver or runtime)
      kernels present: gfx1010 ... gfx1151 ... gfx1250
      the build is fine - the driver is not exposing the GPU to HIP.
      update the AMD driver, or stay on Vulkan.
```

That distinction is the useful part: the ROCm build above *does* contain gfx1151
kernels, so the build is not the problem and reinstalling it will not help.

Probing runs with the working directory set to each build's own folder. On
Windows the DLL search path includes the current directory, so probing a ROCm
build from inside a Vulkan build's folder silently loads the Vulkan backend and
reports a device the ROCm build cannot use.

## Memory

llama-server's stock defaults assume RAM to spare - an 8192 MiB host prompt
cache and up to four models resident. On a machine whose RAM is mostly carved
out for VRAM, that is the biggest avoidable cost.

```
> arcflare memory
    lean       prompt cache 512 MiB - 1 model resident - sleeps after 5 min idle
  > balanced   prompt cache 2048 MiB - 1 model resident - sleeps after 15 min idle
    max        prompt cache 8192 MiB - 4 models resident - never sleeps
```

## Batch size

Physical batch (`-ub`) trades VRAM for prefill speed, and the trade is not
one-sided. Measured on a 35B-A3B at Q5, at the full 262144 context, three runs
each with under 1% spread:

| model | ubatch | ~1.4k prompt | ~8k prompt |
| --- | --- | --- | --- |
| 35B-A3B Q5 | 512 | 251 tok/s | 736 tok/s |
| 35B-A3B Q5 | 2048 | **349 tok/s** (+39%) | 657 tok/s (-10.7%) |
| 35B-A3B Q6 | 512 | 321 tok/s | 814 tok/s |
| 35B-A3B Q6 | 2048 | **471 tok/s** (+47%) | 613 tok/s (-25%) |

How much the long prompt loses depends on the model, so this is a real trade
rather than a free win. Agent turns skew short - a cached session re-prefills
only the tokens that changed - so the default takes the gain, and
`arcflare batch 512` reverses it if your work is long single prefills.

Because the batch also costs VRAM, it is the first thing given up when a model
does not fit: ArcFlare shrinks the batch and retries at the *same* context
before it considers halving the window. A few percent of prefill is worth far
less than the context it would otherwise buy.

## What runs best

Two questions, and they cost wildly different amounts to answer.

**What fits** is arithmetic over the GGUF header and your free VRAM. Every
model, instantly, nothing loaded:

```
> arcflare fit

  What fits  45.4 GB free on device

  + qwen3.6-35b-a3b:ud-q8_k_xl         36.4 GB  20 KiB/tok  256K  full 256K context - 5.0 GB of cache, 2.6 GB left over
  + qwen3.6-35b-a3b:ud-q6_k_xl         30.4 GB  20 KiB/tok  256K  full 256K context - 5.0 GB of cache, 8.7 GB left over
  + qwen3.6-35b-a3b:ud-q5_k_xl         25.3 GB  20 KiB/tok  256K  full 256K context - 5.0 GB of cache, 13.7 GB left over
  + tiel-coder-35b-a3b-mtp:ud-q5_k_xl  25.1 GB  20 KiB/tok  256K  full 256K context - 5.0 GB of cache, 13.9 GB left over
  + qwen3.8-27b:ud-q5_k_m              18.4 GB  64 KiB/tok  256K  full 256K context - 16.0 GB of cache, 9.6 GB left over
```

"Left over" is what remains *after* the cache that line just promised, not
before it. The 27B is the interesting row: the smallest file on the list, and
the only one whose cache costs more than a third of the device, because it is
dense - every layer attends, at 64 KiB a token against the MoE's 20.

**What runs best** cannot be computed. `arcflare fit --run` loads each model in
turn, at the context it would really use, and times it:

```
> arcflare fit --run

  qwen3.6-35b-a3b:ud-q5_k_xl         23.6 s  610 tok/s  57.5 tok/s  5/5 probes  256K ctx
  tiel-coder-35b-a3b-mtp:ud-q5_k_xl  24.8 s  509 tok/s  57.4 tok/s  5/5 probes  256K ctx
  qwen3.6-35b-a3b:ud-q6_k_xl         28.3 s  514 tok/s  53.6 tok/s  4/5 probes  256K ctx
    missed: code (hit the cap, still thinking)
  qwen3.6-35b-a3b:ud-q8_k_xl         32.1 s  551 tok/s  46.4 tok/s  5/5 probes  256K ctx
  qwen3.8-27b:ud-q5_k_m              31.8 s  176 tok/s  19.4 tok/s  5/5 probes  256K ctx

  Verdict

  fastest       qwen3.6-35b-a3b:ud-q5_k_xl  57.5 tok/s generating
  best prefill  qwen3.6-35b-a3b:ud-q5_k_xl  610 tok/s reading a prompt
  most context  qwen3.6-35b-a3b:ud-q8_k_xl  256K loaded
  most capable  qwen3.6-35b-a3b:ud-q5_k_xl  5 of 5 probes

  > use         qwen3.6-35b-a3b:ud-q5_k_xl
    fastest of the 4 that answered every probe
```

The headline on this machine: **a smaller model is not a faster model.** The
dense 27B is the smallest file here and generates at a third the speed of a 35B
that is twice its size, because the 35B is a MoE running 8 experts of 256. File
size predicts whether a model *fits*. It predicts nothing about how it runs.

### Which of these numbers to believe

Run the same measurement twice and the three columns behave completely
differently, so they are worth different amounts:

| | run 1 | run 2 | |
| --- | --- | --- | --- |
| generation, Q5 | 57.5 | 57.5 | **reproducible** - trust it |
| generation, 27B | 21.1 | 19.4 | ~8% |
| prefill, Q8 | 622 | 551 | ~11% - do not rank quants on this |
| load, Q8 | 1m 19s | 32.1 s | **meaningless** - the first run read 36 GB off a cold disk |

Generation is the number that holds still, which is lucky, because it is also
the one you feel. Prefill moves enough between runs that a 10% gap between two
quants is not a finding. Load time mostly measures your page cache.

### The probes

Five, run after the timings, checking that a model still does the things a
harness needs of it: obey an exact output format, emit clean JSON, do
arithmetic it cannot pattern-match, write a function that *actually runs* (in a
fresh V8 context with no `require`, no `process` and a timeout), and recall one
planted line from 4k tokens back.

Five probes cannot rank models on how well they write code, and this does not
pretend to. They catch something narrower: a model that has stopped being
usable as a tool-caller. That is why the recommendation is **gated** on them
rather than scored against them - of the models that answered every probe, the
fastest. A single blended score would look authoritative, encode nothing but
whichever weights got picked, and cheerfully recommend a model that cannot emit
JSON on the grounds that it cannot emit JSON quickly.

These models think before they answer, and thinking is charged to the same
budget as the answer. The first version of this scored three Qwen3.6 quants
4 of 5, all missing the same probe - not because they cannot write `add(a, b)`
but because they were still reasoning about it when the tokens ran out. A cap
that decides the verdict is measuring the cap, so running out of room now buys
one retry at triple the budget, which moved two of those three to 5 of 5. The
one that still misses it was still going after 4,608 tokens, and that is a fact
about the model rather than about the cap.

| flag | |
| --- | --- |
| `--run [model]` | load and measure - everything, or one model |
| `--quick` | a 2k prefill and a shorter sample |
| `--no-probes` | timings only |
| `--json` | the same data, machine-readable |
| `--clear` | forget every measurement |

Results are kept in `~/.arcflare/fit.json` and saved after each model, so a
twenty-minute run interrupted at model four keeps the three it paid for. They
also show up in `arcflare ls`, because a measured number beats anything a
header can tell you:

```
> arcflare ls
  qwen3.6-35b-a3b:ud-q8_k_xl         Q8_0 - 36.4 GB - 256K ctx - MoE 8/256    46.4 tok/s
  qwen3.6-35b-a3b:ud-q5_k_xl         Q5_K_M - 25.3 GB - 256K ctx - MoE 8/256  57.5 tok/s
```

A measurement of a file that has changed size since is flagged rather than
trusted - the same name over different weights is a different model.

## The agent

`arcflare agent` is a coding agent built for a model on your own GPU. Everything
about it follows from two facts: generation runs at tens of tokens a second, and
llama.cpp reuses its prompt cache only for the longest *unchanged* prefix.

So the prompt is append-only. The system message and the tool array are fixed
for the whole session. Discovered MCP tools and skill bodies arrive as tool
*results* rather than being spliced into the prefix - editing the prefix throws
the cache away and re-reads the session, and at ~250 tok/s prefill a 20k-token
session costs about 80 seconds to re-read.

```
> arcflare agent

  + 1 skill greet
  + mcp blender 67 tools
  + mcp desktop 23 tools
  + mcp ollama-subagents 9 tools
  + mcp ollama-research 8 tools
  prefix 1064 tok - window 256K - 107 mcp tools indexed (schemas on demand)

> widget.js has a bug in add(). Fix it and verify with node.

  * read_file widget.js
  * edit_file widget.js
  * bash node -e "const {add}=require('./widget.js'); console.log(add(2,3));"
    5

  Fixed. The bug was `a - b` instead of `a + b`.
```

**MCP.** Servers are connected over stdio and their tools namespaced
`server__tool`. The model sees a one-line index, then calls `tool_search` to
pull the schemas it actually needs and `mcp_call` to run one. For 120 tools that
is 1,072 tokens instead of 7,573 - about 7x cheaper - and because the tool array
never changes, the cache survives every turn.

**Finding the right tool is part of the budget.** A miss costs two turns, which
on a local model is seconds of prefill and generation rather than milliseconds.
So `tool_search` ranks whole words in a tool's *name* far above the same word in
its prose, drops the words that match everything, and orders by how much of the
query a tool actually covers. The scorer this replaced gave every tool a point
for "the" in `render the scene`, and ties fell to whichever server was
registered first - the one with the most tools. Measured over 303 tools from six
real servers:

| | old | new |
| --- | --- | --- |
| right tool ranked first | 6 of 12 | **10 of 12** |
| right tool in the top five | 11 of 12 | **12 of 12** |
| tokens per search | 1,188 | **597** |

Half of that saving is the ranking and half is how a hit is written down. A
Pydantic-generated schema spends about forty characters on
`anyOf: [{"type":"string"},{"type":"null"}], "title": "Camera"` to say
"optional string", so results are rendered as a signature instead:

```
## blender__screenshot_render
Run a real render and return the image. engine: 'EEVEE' (seconds) or 'CYCLES'
(much slower, photoreal) - system_status lists what this Blender build has.
(engine?: string="EEVEE", samples?: integer=64, resolution?: integer[], camera?: string)
```

Per-argument documentation survives, because a wrong call costs a round trip and
the note explaining the argument is cheaper than the retry.

**Skills.** A skill is a directory with `SKILL.md` and YAML frontmatter.
Discovery reads only the first 4 KB of each file, so the index costs ~15 tokens
per skill and a body (often 1000+) loads only when the model asks for it.
`~/.arcflare/skills`, `.arcflare/skills`, and existing `.claude/skills` are all
picked up.

**Context.** Compaction trims the oldest tool results first, then drops whole
early turns - never the system prompt and never recent turns, so the cached
prefix stays intact. A dropped tool call takes the results answering it with
it: a `tool` message with nothing it answers is context spent on something the
model cannot interpret, during the one operation that only runs because context
is already scarce.

**Sampling.** Qwen3-class GGUFs publish the sampling they were tuned for under
`general.sampling.*`, and their thinking and non-thinking presets differ -
top_p 0.95 against 0.8. These models think, so the agent reads what the file
declares rather than assuming, and falls back to its own defaults only when a
model declares nothing.

**Tools.** `read_file`, `write_file`, `edit_file`, `list_dir`, `glob`, `grep`,
`bash`, plus `skill_load`, `tool_search` and `mcp_call`. Edits fail loudly on an
ambiguous or missing match rather than guessing. Shell commands go through an
approval prompt and a refusal list for unrecoverable ones.

**Auto mode.** The menu asks once, after the model and the context, whether
tools may run without stopping to ask - and remembers the answer, so the next
run starts the way the last one did. `--yolo` and `--ask` override it for a
single run, on `arcflare agent` and on `arcflare use` alike.

Every harness that runs tools is asked, not just the agent, because every one of
them can be started with its approvals off - and each is told in its own
language at launch, never by writing an approval setting into its config file:

| Harness | Auto mode is |
| --- | --- |
| **ArcFlare agent** | its own mode: no approval prompts; the refusal list for unrecoverable commands still applies |
| **OpenCode** | `--auto` - approves every permission it has not been told to deny |
| **Hermes** | `--yolo` - skips the approval prompts; the hardline blocklist still refuses what it refuses |
| **Hermes Desktop** | `HERMES_YOLO_MODE=1` - no flag exists, so the switch is thrown in the environment Electron hands its backend |
| **Codex CLI** | `--dangerously-bypass-approvals-and-sandbox` - `-a never` alone would still run everything sandboxed |

An approval argument you type yourself wins: `arcflare use codex --yolo -s
read-only` passes your sandbox choice through and adds nothing of its own. The
plain chat is never asked - it has no tools to approve.

**The machine server.** [`arcflare mcp`](#the-machine-server) is connected
automatically, so the agent can open applications, supervise background
processes, drive the desktop and smoke-test what it builds without any
configuration. Its twenty-six
tools cost 498 tokens of index instead of 3,106 of schemas, and `--no-machine`
or `ARCFLARE_NO_MACHINE=1` turns it off.

## The machine server

`arcflare mcp` is an MCP server for the computer it runs on: it opens things,
runs things, looks at the screen, clicks and types, and tests the software an
agent just built. The agent connects it automatically; any other client takes
one line.

```bash
claude mcp add arcflare -- arcflare mcp      # Claude Code
arcflare mcp --install                       # or ~/.arcflare/mcp.json
```

Twenty-six tools in five groups:

| Group | Tools | |
| --- | --- | --- |
| Run | `run` `start` `logs` `input` `stop` `ps` | a command that finishes, or one that does not |
| Open | `open` `launch` `apps` `sysinfo` | a file or URL, an app by name, what the machine has |
| See and touch | `screenshot` `mouse` `type` `key` `windows` `focus` `clipboard` | eyes and hands on the desktop |
| Test | `project` `build` `test` `smoke` `http` | what a directory is, and whether what it built works |
| Blender | `blender` `blender_launch` `blender_run` `blender_render` | find it, start it, and work without a window |

**A verdict, then the evidence.** Any harness can already run `npm test`. What
it cannot do is read the result on a small context budget: 900 lines of TAP, of
which the answer is one number. So `test` runs the project's own command and
parses what came back - node:test, jest, vitest, pytest, cargo, go, dotnet and
mocha - and leads with the thing you needed:

```
tests FAILED - 1 of 3 failed - node:test - 216ms
$ node --test   (C:\Users\harry\demo)
failing:
  - this one is broken
--- output ---
...
```

`build` does the same for compilers, pulling the error lines out of the log and
deduplicating them - a broken header in a C++ project prints the same error 400
times, and reading it 400 times helps nobody. When nothing recognisable was
printed, both say so rather than inventing a green run: a wrong summary is worse
than no summary.

**`smoke` is the honest end of "it works".** A build exiting 0 says nothing
about whether the thing runs, and a process still being alive says nothing about
whether it answers. So: start it, wait until the port opens (or the log matches,
or the process proves it is alive), fetch a URL, check the body, stop it again.

```
smoke: PASS
  started p1 (pid 7984) - $ npm start
  ready: port 8781 open after 2.8s
  GET http://127.0.0.1:8781/ -> HTTP 200 OK - text/html - 13ms
  stopped it again
--- response body ---
<h1>demo app is alive</h1>
```

**Processes are supervised, not fired off.** `start` returns an id, buffers the
output in a ring, and lets you read it, grep it, write to its stdin and kill it.
Killing means the whole tree - `npm start` is a shell that spawns node that
spawns a bundler, and killing the shell leaves the port bound so the next run
dies with EADDRINUSE. And "stopped" means stopped: `exit` and `close` are not
the same event, and a killed server whose grandchild still holds the stdout
handle would otherwise be reported as running forever.

**It picks a shell that can run what you wrote.** `auto` prefers Git Bash on
Windows, because a model writing `npm ci && npm test` is writing POSIX and
PowerShell 5.1 has no `&&` at all - it fails with a parser error that reads like
a broken build. `cmd`, `powershell`, `pwsh` and `bash` are all selectable per
call, and the answer says which one ran it.

**Opening.** `launch` resolves a name through PATH first, then the start menu,
so "blender" or "Visual Studio Code" works without anyone knowing the path;
`open` hands a file, folder or URL to the OS exactly as a double-click would.
Opening a window is not seeing it - for eyes and hands on the GUI, that is a
desktop automation server's job, and the instructions this server sends on
connect say so.

**Eyes and hands, without a native module.** Windows already ships everything
needed - GDI+ for the screen grab, user32 for synthetic input, WinForms for
SendKeys - so `screenshot`, `mouse`, `type` and `key` drive those through
PowerShell rather than binding a native addon. The install stays `git clone`.

Three details decide whether this works in practice. Screenshots are scaled on
the way out (a 4K grab is 8 MB of PNG and the answer to "where is the button"
does not need it), so every capture reports the scale factor and the conversion
back to screen pixels. The scripts call `SetProcessDPIAware` first - without it
a scaled display reports virtual coordinates, and every click lands in the wrong
place, consistently. And typed text is escaped for SendKeys, where `+^%~(){}[]`
are operators: type `100%` raw and you have pressed Alt. Anything long or
awkward is better set on the clipboard and pasted.

`focus` reports every other window that matched the title you gave it, because
focusing the wrong one and then typing puts real text somewhere real.

**Blender.** There is already a good MCP server for *driving* Blender - it
models, sculpts, lights and renders through the running application, and
ArcFlare reaches it like any other server. These four tools are deliberately not
that. They cover the part that has to be true before it can answer at all.

```
> blender
  blender  5.2.1
    exe    C:\Program Files\Blender Foundation\Blender 5.2\blender.exe
    bridge port 9886: ECONNREFUSED
           nothing is listening - Blender is closed, or the MCP bridge addon is disabled
```

That distinction is the whole point. Every tool on the driving server fails with
the same connection error whether Blender is shut, open with the addon off, or
busy in a modal operator, and only one of those is fixed by starting it. So
`blender` asks the addon a real question - `system_status`, over its
length-prefixed TCP protocol - rather than checking whether the port is open,
because something else can hold the port and a busy Blender accepts the
connection and never replies. The port itself is read from the driving server's
own config: 9876 is the documented default, and on this machine that file moves
it to 9886 so two Blender addons can coexist. Hardcoding the default would have
talked to the wrong one.

`blender_launch` starts it and waits for the addon to answer, not for the window
to appear - Blender is on screen for several seconds before its sockets are up.

**Headless is usually the right answer anyway.** `blender_run` and
`blender_render` need no GUI, no addon and no port. Reading a `.blend` takes
about 2.5 seconds with Blender closed, and driving the GUI to do the same thing
is slower and less reliable:

```
> blender_run  expr: import bpy; print('objects:', [o.name for o in bpy.data.objects])
  blender_run: ok · 2.4s
  --- output ---
  objects: ['Camera', 'Cube', 'Light']
```

Both read the log rather than the exit code, because **Blender exits 0 after a
script raises**. It prints the traceback, finishes shutting down and reports
success, so anything trusting `$?` calls a failed render a good one:

```
> blender_run  expr: import bpy; bpy.data.objects['NoSuchThing']
  blender_run: FAILED · 1.4s
  KeyError: 'bpy_prop_collection[key]: key "NoSuchThing" not found'
```

`blender_render` applies the same rule to its output. Blender picks the real
filename itself - it appends the frame number and the format's extension to
whatever prefix it was given - so the only honest way to report where a render
went is to look for what appeared, and a render that wrote no file is a failure
whatever it exited with.

```
> blender_render  blend: scene.blend, engine: BLENDER_WORKBENCH
  render ok · 9.2s · 1 file(s)
    C:\...\arcblend-KwyZW3\frame_0001.png  1314 KB
```

**Limits.** The refusal list the agent uses applies here too, so `rm -rf /` and
friends are rejected before they are spawned. `--root <dir>` confines commands
to a directory, `--no-open` removes the tools that open, launch or touch the
desktop, output is capped per process, and nothing the server started outlives
the client that connected to it.

## Tests

```bash
npm test
```

189 tests covering the places where being wrong is silent and expensive: the KV
cache maths, model id parsing, and the harness config writers - including that
they preserve unrelated settings, back files up, and refuse to overwrite a
config they cannot parse. The machine server adds its own: the JSON-RPC
handshake, process supervision, project detection, the test-output parsers, and
one end-to-end test that spawns the real server over stdio with ArcFlare's own
MCP client and has it build, test and smoke-test a throwaway project.

`arcflare fit` is tested without a GPU, by injecting the chat call: what gets
asked, in what order, with what token budget, and how the answers are judged.
That covers the parts a benchmark can be confidently wrong about in silence -
that prefill is measured on a prompt the cache has never seen, that generation
excludes prefill rather than blaming the model for a long prompt, that probe
code runs sealed off from the machine grading it, and that the recommendation
stays gated on the probes instead of trading them against tokens per second.

The Blender group is tested against the failures that look like successes -
a traceback under a zero exit code, a render whose output file never appeared,
a stale frame left over from the previous run - plus a stand-in addon that
speaks the real length-prefixed frame protocol over a loopback socket, so a
wrong header byte order fails here rather than only against a live Blender.

## Harnesses

ArcFlare serves the OpenAI API on **port 11434** — Ollama's port — so tools
already pointed at a local Ollama work with no config change.

When it does need to write config, it backs the file up first
(`<file>.arcflare-bak`) and only touches the keys it owns.

| Harness | How it's wired |
| --- | --- |
| **ArcFlare chat** | Built-in streaming REPL |
| **ArcFlare agent** | Built in: tools, MCP and skills, no config to write |
| **OpenCode** | Adds an `arcflare` provider to `opencode.json(c)` with the real context limit |
| **Hermes** | Uses `hermes config set` — its own tool, never hand-edited YAML. Also sets `terminal.cwd`, or its tools run in your home directory |
| **Hermes Desktop** | Same config, launched via `hermes desktop --skip-build` when the packaged app already exists |
| **Codex CLI** | `[model_providers.arcflare]` in `~/.codex/config.toml`, `wire_api = "responses"` |

```bash
arcflare use opencode qwen3.6-35b-a3b     # configure and launch
arcflare use hermes                       # last model, or pick one
```

## Layout

```
bin/arcflare.js   CLI and the interactive menu
lib/ui.js         colours, arrow-key select, spinner
lib/gguf.js       GGUF metadata reader + KV cache maths
lib/fit.js        what fits, and what measurably runs best
lib/models.js     model discovery
lib/engine.js     llama-server supervision
lib/harness.js    harness detection, config wiring, launch
lib/agent/        the agent: loop, tools, MCP client, skills, context
lib/mcp/          the machine server: transport, processes, projects, probes,
                  desktop control, Blender
bin/arcflare-mcp.js  stdio entry point for the machine server
```

## Licence

MIT
