# ArcFlare CLI

> Upload, share, and **run** open AI models from your terminal — `arcflare run <model>`.
> Inspired by Ollama, but self-contained: ArcFlare runs models **itself** with an
> embedded [llama.cpp](https://github.com/ggml-org/llama.cpp) engine — no external
> app or server to install.

This is the command-line tool for [ArcFlare](https://github.com/Hakeperty/ArcFlare)
(the model-hub website lives in that repo; this repo is the `arcflare` command).

```
❯ arcflare run qwen2.5
  pulling qwen2.5 (qwen2.5-0.5b-instruct-q4_k_m.gguf)
  ████████████████████ 100%  468.6MB/468.6MB
  loading qwen2.5 — first load can take a few seconds...
  qwen2.5: Pandas are fascinating and adorable animals!
```

## Install

No published package yet — run it straight from the repo:

```bash
git clone https://github.com/Hakeperty/ArcFlare-Code.git
cd ArcFlare-Code
npm install         # fetches the prebuilt llama.cpp engine
npm link            # makes `arcflare` available globally
# or just:
node bin/arcflare.js <command>
```

Requires Node.js 18+. The only dependency is
[`node-llama-cpp`](https://github.com/withcatai/node-llama-cpp), which embeds the
llama.cpp inference engine (CPU by default; GPU when a prebuilt is available).
Models download as GGUF to `~/.arcflare/models` on first run.

## Commands

| Command | What it does |
| --- | --- |
| `arcflare run <model> [prompt]` | Run a model (auto-pulls if needed) |
| `arcflare pull <model>` | Download a model into the local store |
| `arcflare list` | List installed models |
| `arcflare search <query>` | Search the model registry |
| `arcflare show <model>` | Show model details + config |
| `arcflare edit <model>` | Edit a model's Modelfile (system, params) |
| `arcflare create <name> --from <base> [--system "…"]` | Make a custom model |
| `arcflare create <name> -f Modelfile` | Make a custom model from a Modelfile |
| `arcflare cp <src> <dst>` | Copy an installed model |
| `arcflare rm <model>` | Remove an installed model |
| `arcflare serve` | Start the local HTTP API (default `:11435`) |
| `arcflare ps` | Show the running server and its models |
| `arcflare stop` | (models run on demand — nothing stays loaded) |
| `arcflare push <model>` | Publish a model (coming soon) |
| `arcflare path` | Print the local store directory |
| `arcflare help` / `version` | Help / version |

## Local store & custom models

ArcFlare keeps a small on-disk store at `~/.arcflare/store.json` (override with
`ARCFLARE_HOME`). `pull`/`create` install models there; `list`/`edit`/`rm` work
against it; `run` records last-used. Custom models keep a `base` and a `SYSTEM`
prompt — define them with a Modelfile, just like Ollama:

```bash
arcflare create captain --from qwen2.5 --system "You are a sea captain."
arcflare edit captain         # opens a Modelfile in $EDITOR
arcflare run captain "ahoy!"
```

```
# Modelfile
FROM qwen2.5
SYSTEM You are a sea captain.
PARAMETER temperature 0.7
```

## HTTP API (`arcflare serve`)

Start a small local server (zero deps, Node `http`) for apps and scripts:

```bash
arcflare serve            # http://127.0.0.1:11435  (override with --port / ARCFLARE_PORT)
arcflare ps               # in another terminal: see the server + its models
```

| Method & path | Body | Returns |
| --- | --- | --- |
| `GET /` | — | `ArcFlare is running` |
| `GET /api/tags` | — | installed models |
| `GET /api/registry` | — | all available models |
| `POST /api/pull` | `{ name }` | installs the model |
| `POST /api/show` | `{ name }` | model details + config |
| `POST /api/create` | `{ name, from, system }` | makes a custom model |
| `POST /api/generate` | `{ model, prompt }` | a completion (real once the model is pulled) |
| `POST /api/chat` | `{ model, messages }` | a chat reply (applies the model's SYSTEM) |
| `DELETE /api/delete` | `{ name }` | removes a model |

```bash
curl http://127.0.0.1:11435/api/tags
curl -X POST http://127.0.0.1:11435/api/pull -d '{"name":"qwen2.5"}'
curl -X POST http://127.0.0.1:11435/api/generate -d '{"model":"qwen2.5","prompt":"hi"}'
```

## How `run` works

1. Resolves the model from the bundled registry of real open-weight models.
2. Downloads its GGUF (with a live progress bar) to `~/.arcflare/models` if it
   isn't there yet.
3. Loads it with the embedded llama.cpp engine and **streams a real chat** —
   applying the model's `SYSTEM` prompt and keeping conversation history.

**Runnable today** (have a bundled GGUF build): `qwen2.5`, `qwen2.5-coder`,
`llama3.2`, `gemma2`, `mistral`, `deepseek-r1`. Other registry entries are listed
for discovery and fall back to a demo until a build is added.

> Image/audio models (FLUX, Stable Diffusion, Whisper) are listed for discovery
> and aren't text-chat models.

## Design

A flat JSON store (`~/.arcflare/store.json`), GGUF models in `~/.arcflare/models`,
and lazy work (nothing loads until you run a model). Inference is handled in-process
by the embedded llama.cpp engine — ArcFlare is a single self-contained tool, not a
front-end for another app.

## License

MIT
