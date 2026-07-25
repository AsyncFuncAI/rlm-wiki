# rlm-wiki

Generate interactive repository wikis with agentic code investigation. Point at a GitHub URL, get a multi-page technical wiki plus chat, coding, and PR-review surfaces. There is no embedding index or RAG pipeline; the active runtime clones the repository and investigates the code directly.

This started as a `deepwiki-open` rewrite. The **JCODE** runtime drives Agent mode and is the preferred path for Code Anything, while the vendored `rlm-bun` runtime remains available as the legacy RLM mode and is still the default for several wiki, chat, and review entry points.

## Scope

- GitHub public repos by URL or `owner/repo` shorthand
- Multiple model channels routed through JCODE providers in Agent mode, with legacy RLM-compatible clients for RLM mode
- Web UI, CLI, SSE process streaming, local JSON storage, and optional Postgres persistence
- Wiki generation, repo chat, multi-repo chat, Code Anything, and Review Anything
- Public share surfaces for wikis and asks

## Architecture

```text
GitHub URL
    |
    v
Structure agent
    |
    v
<wiki_structure> XML
    |
    v
parallel page agents
    |
    v
~/.rlm-wiki/wikis/{owner}_{repo}.json
    |
    v
Web UI + chat/review/code surfaces
```

Chat and review requests launch fresh agent runs with the cloned repository or workspace as context. Depending on the selected runtime, those runs use either JCODE's native tool runtime or the legacy `rlm-bun` JavaScript sandbox.

## Quickstart

```bash
# 1. Install JCODE
curl -fsSL https://raw.githubusercontent.com/1jehuang/jcode/master/scripts/install.sh | bash
jcode --version

# 2. Configure at least one provider
export GEMINI_API_KEY=...
export OPENAI_API_KEY=...
export ANTHROPIC_API_KEY=...
# or use JCODE's interactive provider setup
jcode login --provider openai

# 3. Install app dependencies
bun install

# 4. Run the server
bun run server
# then open http://127.0.0.1:3141
```

Copy `.env.example` to `.env` for local configuration. Bun auto-loads `.env` when you run the server.

## CLI

```bash
# Generate a wiki
bun ./bin/rlm-wiki.ts generate https://github.com/expressjs/express
bun ./bin/rlm-wiki.ts generate expressjs/express --channel gpt-5.5

# Ask a question about a repo
bun ./bin/rlm-wiki.ts ask expressjs/express "How does routing work?"

# List saved wikis
bun ./bin/rlm-wiki.ts list

# Serve the web UI
bun ./bin/rlm-wiki.ts serve --port 3141
```

## Agent runtimes

rlm-wiki supports two agent runtimes:

- **Agent mode (`agent`)** — uses the external JCODE CLI. rlm-wiki prepares a cloned repo or temporary workspace, writes any MCP config into `.jcode/mcp.json`, starts `jcode run --ndjson`, streams tool/text/token events into the UI, and extracts the final `<ANSWER>...</ANSWER>` response.
- **RLM mode** — uses the vendored `rlm-bun` JavaScript sandbox for legacy wiki/chat/review paths.

## Repository layout

```text
rlm-wiki/
├── bin/rlm-wiki.ts         CLI entry
├── src/                    Server, generator, persistence, agents
│   └── ui/                 Shared public reader markdown/wiki UI
├── public/                 Marketing site + public wiki/ask pages
├── api/                    Vercel serverless public routes
├── vendor/rlm-bun/         Vendored legacy RLM runtime
├── Dockerfile              Container image for Railway / Fly / Docker
├── railway.json            Railway web service
├── railway.worker.json     Railway worker service
└── vercel.json             Static + serverless public surface
```

## Deploy

### Railway (full app server)

The checked-in `railway.json` uses the Dockerfile builder, starts `bun run ./bin/rlm-wiki.ts serve`, and healthchecks `/api/health`. The server binds to `0.0.0.0:$PORT` when Railway injects `PORT`.

Worker mode:

```bash
bun run ./bin/rlm-wiki.ts worker
```

### Docker

```bash
docker build -t rlm-wiki .
docker run --rm -p 3141:3141 \
  -e GEMINI_API_KEY=... \
  rlm-wiki
```

### Vercel (public site + serverless pages)

```bash
bun run build:web
```

`vercel.json` deploys the static marketing/public pages under `dist/public` and the `api/` serverless routes for public wiki/ask surfaces.

## Auth modes

- `AUTH_MODE=off` — local open access
- `AUTH_MODE=dev` — uses `RLM_WIKI_DEV_USER_EMAIL` or `x-rlm-wiki-dev-user`
- `AUTH_MODE=cloudflare_access` — production behind Cloudflare Access

Web user runs are BYOK by design: users supply provider credentials through the app. Server env keys are for local CLI/dev workflows unless you intentionally change that policy.

## Documentation

Long-form notes live under [docs/](docs/README.md).

## License

MIT. See [LICENSE](LICENSE).

## Related

A separate closed-source desktop shell (Grok-Wiki) exists for native local workflows. This repository is the open-source **web app, CLI, and server** only.
