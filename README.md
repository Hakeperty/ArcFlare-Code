# ArcFlare CLI

> Upload, share, and **run** open AI models from your terminal — `arcflare run <model>`.

This is the command-line tool for [ArcFlare](https://github.com/Hakeperty/ArcFlare)
(the model hub website lives in that repo; this repo is the `arcflare` command).

```
❯ arcflare run qwen2.5
  Pulling manifest...
  Downloading weights ██████████████████████ 100%
  Loading into memory...
  ✓ qwen2.5 is ready  (Alibaba Qwen · Apache-2.0)
```

## Install

No published package yet — run it straight from the repo:

```bash
git clone https://github.com/Hakeperty/ArcFlare-Code.git
cd ArcFlare-Code
npm link        # makes `arcflare` available globally
# or just:
node bin/arcflare.js <command>
```

Requires Node.js 18+. No dependencies.

## Commands

| Command | What it does |
| --- | --- |
| `arcflare run <model>` | Pull (if needed) and run a model |
| `arcflare pull <model>` | Download a model |
| `arcflare list` | List available models |
| `arcflare search <query>` | Search the registry |
| `arcflare show <model>` | Show model details |
| `arcflare push <model>` | Publish a model (coming soon) |
| `arcflare help` | Show help |
| `arcflare version` | Print the version |

## How `run` works

1. Resolves the model from the bundled registry (real open-weight models such as
   `qwen2.5`, `llama3.2`, `mistral`, `deepseek-r1`, `gemma2`, …).
2. Shows the pull/load progress.
3. **If [Ollama](https://ollama.com) is installed**, it hands off to
   `ollama run <model>` for real local inference (the registry uses matching
   names). **Otherwise** it drops into a small demo chat so you can see the flow.

> Image/audio models (FLUX, Stable Diffusion, Whisper) are listed for discovery
> and run in demo mode here — they aren't text-chat models.

## Registry

The model list lives in [`lib/registry.js`](lib/registry.js). It's public
metadata only (name, author, license, sizes) — no weights are bundled.

## License

MIT
