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
    OpenCode
    Hermes
    Hermes Desktop
    Codex CLI      not installed

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
  ✓ device memory 45.4 GB free
  ✓ models        3 found
  ✓ ArcFlare chat  built in
  ✓ OpenCode       ...\hermes\node\opencode
  ✓ Hermes         ...\hermes\bin\hermes.exe
  ✓ Hermes Desktop ...\hermes\bin\hermes.exe
  · Codex CLI      not installed
  · server        stopped
```

## Commands

| Command | What it does |
| --- | --- |
| `arcflare` | The menu: harness → model → context |
| `arcflare ls` | List discovered GGUF models |
| `arcflare pull <repo>[:Q]` | Download a GGUF from Hugging Face |
| `arcflare run <model>` | Start the server and chat |
| `arcflare use <harness> [model]` | Configure and launch a harness |
| `arcflare serve [--port N]` | Start the server only |
| `arcflare ps` | Server status and loaded models |
| `arcflare stop` | Stop the server |
| `arcflare logs [-n N]` | Tail the server log |
| `arcflare backend [kind]` | List or select a llama.cpp backend (vulkan/rocm/cuda) |
| `arcflare memory [profile]` | `lean` \| `balanced` \| `max` |
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

## Tests

```bash
npm test
```

20 tests covering the places where being wrong is silent and expensive: the KV
cache maths, model id parsing, and the harness config writers - including that
they preserve unrelated settings, back files up, and refuse to overwrite a
config they cannot parse.

## Harnesses

ArcFlare serves the OpenAI API on **port 11434** — Ollama's port — so tools
already pointed at a local Ollama work with no config change.

When it does need to write config, it backs the file up first
(`<file>.arcflare-bak`) and only touches the keys it owns.

| Harness | How it's wired |
| --- | --- |
| **ArcFlare chat** | Built-in streaming REPL |
| **OpenCode** | Adds an `arcflare` provider to `opencode.json(c)` with the real context limit |
| **Hermes** | Uses `hermes config set` — its own tool, never hand-edited YAML |
| **Hermes Desktop** | Same config, launched via `hermes desktop` |
| **Codex CLI** | `[model_providers.arcflare]` in `~/.codex/config.toml`, `wire_api = "chat"` |

```bash
arcflare use opencode qwen3.6-35b-a3b     # configure and launch
arcflare use hermes                       # last model, or pick one
```

## Layout

```
bin/arcflare.js   CLI and the interactive menu
lib/ui.js         colours, arrow-key select, spinner
lib/gguf.js       GGUF metadata reader + KV cache maths
lib/models.js     model discovery
lib/engine.js     llama-server supervision
lib/harness.js    harness detection, config wiring, launch
```

## Licence

MIT
