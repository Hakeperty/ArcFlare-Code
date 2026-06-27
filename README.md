# ArcFlare CLI

> Upload, share, and **run** open AI models from your terminal — `arcflare run <model>`.
> Works like Ollama, kept lean: zero dependencies and instant startup.

This is the command-line tool for [ArcFlare](https://github.com/Hakeperty/ArcFlare)
(the model-hub website lives in that repo; this repo is the `arcflare` command).

```
❯ arcflare run qwen2.5
  Pulling manifest...
  Downloading weights ██████████████████████ 100%
  Verifying digest...
  ✓ qwen2.5 ready  (Alibaba Qwen · Apache-2.0)
```

## Install

No published package yet — run it straight from the repo:

```bash
git clone https://github.com/Hakeperty/ArcFlare-Code.git
cd ArcFlare-Code
npm link            # makes `arcflare` available globally
# or just:
node bin/arcflare.js <command>
```

Requires Node.js 18+. **No dependencies.**

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
| `arcflare cp <src> <dst>` | Copy an installed model |
| `arcflare rm <model>` | Remove an installed model |
| `arcflare push <model>` | Publish a model (coming soon) |
| `arcflare path` | Print the local store directory |
| `arcflare help` / `version` | Help / version |

## Local backend

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

## How `run` works

1. Resolves the model from the local store, or the bundled registry of real
   open-weight models (`qwen2.5`, `llama3.2`, `mistral`, `deepseek-r1`, …).
2. Auto-pulls it if it isn't installed yet, showing pull/load progress.
3. **If [Ollama](https://ollama.com) is installed**, hands off to
   `ollama run <model>` for real local inference (names match). **Otherwise** it
   drops into a small demo chat so you can see the flow.

> Image/audio models (FLUX, Stable Diffusion, Whisper) are listed for discovery
> and run in demo mode — they aren't text-chat models.

## Why "more efficient"

No runtime dependencies, a flat JSON store, and lazy work (nothing runs until you
ask) keep startup and memory minimal. Heavy inference is delegated to a real
backend (Ollama) rather than reimplemented.

## License

MIT
