# rlm-wiki

I built this on nights and weekends for myself. After it started working, I left the repo open.

Paste a GitHub URL. An agent clones the repo, opens files, follows imports and callers, and comes back with a wiki, an answer, a patch, or a PR review. It works from the tree in front of it — the same slow way you would if you had an afternoon free and enough patience to click around.

I started writing it after too many evenings of five tabs, a half-remembered grep, and a summary I still didn’t trust. The loop I wanted was smaller: read the tree, follow the callers, only write claims you can point at.

You can try it if that sounds useful.

## What it looks like

A few shots from a live local run:

### Home

![rlm-wiki home](docs/screenshots/01-home.png)

### Ask a repo anything

![ask surface](docs/screenshots/03-ask.png)

### Code Anything

![code surface](docs/screenshots/04-code.png)

### Review

![review surface](docs/screenshots/05-review.png)

Wiki is the same family: paste a repo, get pages written from the real tree.

## What it does

- **Wiki** — multi-page technical wiki from a repo URL  
- **Ask** — questions with code-backed answers  
- **Code** — give it a task, get a patch from a temporary worktree  
- **Review** — pull request review / investigation  

Bring your own model keys. They live in your browser storage and go out only with the run request, so the model can answer.

Live demo (when I’m keeping it up): [rlmwiki.deepascii.com](https://rlmwiki.deepascii.com)

## Run it yourself

You’ll need [Bun](https://bun.sh) and, for Agent mode, [JCODE](https://github.com/1jehuang/jcode).

```bash
# optional agent runtime
curl -fsSL https://raw.githubusercontent.com/1jehuang/jcode/master/scripts/install.sh | bash
jcode --version

bun install
cp .env.example .env
# put a key in the UI under Keys, or export one for local CLI:
# export GEMINI_API_KEY=...
# export OPENAI_API_KEY=...

bun run server
# open http://127.0.0.1:3141
```

CLI if you prefer a terminal:

```bash
bun ./bin/rlm-wiki.ts generate expressjs/express
bun ./bin/rlm-wiki.ts ask expressjs/express "How does routing work?"
bun ./bin/rlm-wiki.ts list
bun ./bin/rlm-wiki.ts serve --port 3141
```

## How it works (short version)

```text
GitHub URL
    → clone / open workspace
    → agent reads real files
    → wiki / answer / patch / review
```

Under the hood there are two runtimes:

- **Agent** — [JCODE](https://github.com/1jehuang/jcode) (preferred for Code)  
- **RLM** — vendored `rlm-bun` (still used in some wiki / ask / review paths)

You don’t have to care about that on day one. Pick a model, paste a repo, press the button.

## Keys

Open **Keys** in the top bar. Paste a provider key. Save.

Local browser storage only. Clear anytime. Env vars on the machine still help for CLI experiments; the web UI expects keys from the Keys panel.

## Layout

```text
rlm-wiki/
├── bin/rlm-wiki.ts      CLI
├── src/                 server + generators + runtimes
├── public/              web UI
├── vendor/rlm-bun/      legacy RLM runtime
├── docs/screenshots/    the pictures above
└── Dockerfile           one-box deploy
```

Longer notes live in [docs/](docs/README.md). Changelog in [CHANGELOG.md](CHANGELOG.md).

## Deploy (if you want a public box)

I run mine on Railway with the Dockerfile in this repo. Rough shape:

```bash
railway link
# BYOK in the browser for user runs
# optional: Cloudflare Access in front
railway up
```

Health check: `GET /api/health`.

Docker:

```bash
docker build -t rlm-wiki .
docker run --rm -p 3141:3141 rlm-wiki
```

## Limits

- GitHub is the main path.  
- Agent mode needs JCODE on the machine that runs the server.  
- A single wiki page can fail while the rest of the run keeps going.  
- Hobby project. Sharp edges are normal. Issues and PRs help when something is broken for real.

## Why the repo is open

I wanted a quieter coding loop — one that ends with a file path, not a vibe. Building that for myself was enough. Putting the code here is so you can fork it, host it, or steal one idea and put it somewhere better.

If you make something with it, tell me.

—
MIT. Use it kindly.
