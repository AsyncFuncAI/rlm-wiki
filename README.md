# rlm-wiki (private monorepo)

> **Split:** The open-source webapp lives at [AsyncFuncAI/rlm-wiki](https://github.com/AsyncFuncAI/rlm-wiki).
> This private checkout also contains the closed-source **Grok-Wiki desktop** app under `apps/desktop/`.
> See [docs/repo-split.md](docs/repo-split.md).


Generate interactive repository wikis with agentic code investigation. Point at a GitHub URL, get a multi-page technical wiki plus chat, coding, and PR-review surfaces. There is no embedding index or RAG pipeline; the active runtime clones the repository and investigates the code directly.

This started as a `deepwiki-open` rewrite. The newer **JCODE** runtime drives the Agent mode and is the preferred path for Code Anything, while the vendored `rlm-bun` runtime remains available as the legacy RLM mode and is still the default for several wiki, chat, and review entry points.

## Desktop Download

**Latest release:** [Grok-Wiki 0.0.33](https://github.com/AsyncFuncAI/grok-wiki/releases/latest)

| Platform | Download |
|----------|----------|
| macOS Apple Silicon | [Grok-Wiki_0.0.33_aarch64.dmg](https://github.com/AsyncFuncAI/grok-wiki/releases/download/0.0.33/Grok-Wiki_0.0.33_aarch64.dmg) |

## Scope

- GitHub public repos by URL or `owner/repo` shorthand
- Multiple model channels routed through JCODE providers in Agent mode, with legacy RLM-compatible clients for RLM mode
- Web UI, CLI, SSE process streaming, local JSON storage, and optional Postgres persistence
- Wiki generation, repo chat, multi-repo chat, Code Anything, and Review Anything

## Documentation

Project decisions, runbooks, engineering notes, and reflections live in [docs/](docs/README.md). Keep only conventional entry points like `README.md` and `CHANGELOG.md` in the repository root.

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
# providers include gemini, openai, claude, openrouter, deepseek, minimax

# 3. Install app dependencies
bun install

# 4. Run the server
bun run server
# then open http://127.0.0.1:3141
```

Desktop development:

```bash
bun run desktop:dev
```

The desktop app uses Tauri v2 to start a local loopback RLM-wiki server and
loads the existing web UI inside the native window. See [docs/desktop.md](docs/desktop.md).

Agent mode looks for `jcode` on `PATH`. Override with `JCODE_BIN=/path/to/jcode` or `RLM_WIKI_JCODE_BIN=/path/to/jcode`.

## Runtime Modes

rlm-wiki currently supports two agent runtimes:

- **Agent mode (`agent`)** — uses the external JCODE CLI. rlm-wiki prepares a cloned repo or temporary workspace, writes any MCP config into `.jcode/mcp.json`, starts `jcode run --ndjson`, streams tool/text/token events into the UI, and extracts the final `<ANSWER>...</ANSWER>` response.
- **RLM mode (`rlm`)** — uses the vendored `rlm-bun` runtime and its Bun JavaScript sandbox. This path still exists for compatibility and remains the default in some wiki, chat, and review flows.

Code Anything defaults to Agent mode. Wiki generation, page regeneration, Ask, and Review currently normalize unspecified runtime values to RLM mode in several server/helper paths, though the UI/API can pass `runtime: "agent"` where supported.

## CLI

```bash
# Generate a wiki
bun ./bin/rlm-wiki.ts generate https://github.com/expressjs/express
bun ./bin/rlm-wiki.ts generate expressjs/express --channel gpt-5.5

# Ask a question
bun ./bin/rlm-wiki.ts ask expressjs/express "How does routing work?"
bun ./bin/rlm-wiki.ts ask expressjs/express "How does routing work?" --channel claude-sonnet-4-6

# List generated wikis
bun ./bin/rlm-wiki.ts list

# Run the server
bun ./bin/rlm-wiki.ts serve --port 3141
```

## Model Channels

The app preserves its channel IDs. In Agent mode, channel execution is delegated to JCODE:

- Gemini channels use `GEMINI_API_KEY` through Google's OpenAI-compatible Gemini endpoint, with a local compatibility shim for Gemini 3 tool-call thought signatures, or fall back to JCODE's native Gemini setup when no key is present
- OpenAI channels use `OPENAI_API_KEY` through JCODE/RLM OpenAI-compatible clients
- Claude channels use `ANTHROPIC_API_KEY` and include Opus 4.7, Sonnet 4.6, and Haiku 4.5
- DeepSeek channels use `DEEPSEEK_API_KEY` and include V4 Pro and V4 Flash
- OpenRouter channels use `OPENROUTER_API_KEY` and expose a curated set from OpenRouter's current model catalog, including GPT-5.5, Claude Opus/Sonnet, Gemini 3, DeepSeek V4, Grok, Llama, Qwen, Kimi, and Mistral routes
- Cloudflare Workers AI uses JCODE's OpenAI-compatible provider with Cloudflare API env
- MiniMax and legacy Codex subscription channels remain available where configured

Useful environment variables:

- `GEMINI_API_KEY`
- `OPENAI_API_KEY`
- `ANTHROPIC_API_KEY`
- `CLOUDFLARE_API_TOKEN`
- `CLOUDFLARE_ACCOUNT_ID`
- `OPENROUTER_API_KEY`
- `DEEPSEEK_API_KEY` or `DEEPSEEK_API_KEYS`
- `MINIMAX_API_KEY`
- `ANTHROPIC_API_KEY`

The web app is BYOK-only for user runs. Users open **model access** in the top bar and save provider keys either for this browser session (`sessionStorage`) or for this device (`localStorage`). Browser-saved keys are included only on agent run requests and are redacted before persistence. Server-side model env vars may still be useful for local CLI/dev workflows, but they do not make a production web model runnable for a user.

## Auth Model

The MVP does not implement first-party email/password, magic links, or OAuth app auth. Production auth is delegated to Cloudflare Access:

- `AUTH_MODE=cloudflare_access` requires a valid `Cf-Access-Jwt-Assertion` header.
- `RLM_WIKI_CF_ACCESS_TEAM_DOMAIN=<team>.cloudflareaccess.com`
- `RLM_WIKI_CF_ACCESS_AUD=<Cloudflare Access aud tag>`
- `RLM_WIKI_ALLOWED_ORIGINS=https://app.example.com` is optional; same-origin is the default.
- `AUTH_MODE=dev` uses `RLM_WIKI_DEV_USER_EMAIL=dev@example.com` or `x-rlm-wiki-dev-user` locally.
- `AUTH_MODE=off` is local-only convenience mode.

`GET /api/me` returns the derived `{ userId, email, authMode }`. File storage is scoped under `RLM_WIKI_ROOT/users/{userId}`. Postgres rows use `owner_user_id`, so legacy global data is not automatically exposed to signed-in users.

### Public Read-Only Wikis

Generated wikis can be published from the wiki edit drawer. Publishing creates a separate read-only copy under `/public/wiki/<public-id>` and serves its data from `GET /api/public/wiki/<public-id>` without app authentication. Edit, regeneration, chat, BYOK, and capability endpoints remain authenticated.

If Cloudflare Access protects the domain, configure Access bypass rules for the public read-only surface. Cloudflare blocks requests before they reach rlm-wiki, so the app cannot bypass Access by itself.

Bypass at least:

- `/public/wiki/*`
- `/api/public/wiki/*`
- `/styles.css`
- `/favicon.ico`, `/favicon-16x16.png`, `/favicon-32x32.png`, `/apple-touch-icon.png`, `/site.webmanifest`
- `/ai-icons/*` if public pages reference provider icons

### Invite Links

For a small beta, keep Cloudflare Access as the identity proof and let rlm-wiki enforce app-level invites.

```bash
railway variables set RLM_WIKI_REQUIRE_INVITE=true
railway variables set RLM_WIKI_INVITE_SECRET=$(openssl rand -base64 32)
railway variables set RLM_WIKI_ADMIN_EMAILS=you@example.com
railway variables set RLM_WIKI_ALLOWED_EMAILS=you@example.com
railway variables set RLM_WIKI_PUBLIC_URL=https://app.example.com
```

Then generate signed, email-bound invite links as an admin:

```bash
curl -X POST https://app.example.com/api/admin/invites \
  -H 'content-type: application/json' \
  --cookie '<your authenticated browser cookie>' \
  -d '{"emails":["friend@example.com"],"days":14,"redirectPath":"/code"}'
```

Cloudflare Access must still allow invitees to authenticate before they reach rlm-wiki. Use a broad Access policy such as email OTP for everyone, then rely on rlm-wiki invites for beta authorization.

For subscription-backed OpenAI/Codex channels, configure JCODE with:

```bash
jcode login --provider openai
jcode auth status
```

## Layout

```text
rlm-wiki/
├── bin/rlm-wiki.ts         CLI entry
├── src/
│   ├── jcode-runtime.ts    JCODE adapter, source loading, PR/workspace helpers
│   ├── llm.ts              Channel registry mapped to JCODE providers
│   ├── generator.ts        Structure agent -> parallel page agents
│   ├── chat.ts             Repo and workspace ask flows
│   ├── code-anything.ts    Temporary worktree coding flow
│   ├── review.ts           PR review/investigation flow
│   └── prompts/            JCODE-native prompts
├── public/index.html       Single-file UI
├── vendor/rlm-bun/         Legacy RLM runtime used by RLM mode
├── Dockerfile              Bun + JCODE-capable runtime image
└── storage/                Gitignored per-user cache when self-hosted
```

## Deploy To Railway

Single-container deploy. UI, API, JCODE, and the vendored RLM runtime all live in one image.

```bash
# 1. Link or create the Railway project
railway link <project-id>

# 2. Production web model access is BYOK-only
# Users add provider keys in the browser model access panel.

# 3. Put Cloudflare Access in front of Railway
railway variables set AUTH_MODE=cloudflare_access
railway variables set RLM_WIKI_CF_ACCESS_TEAM_DOMAIN=<team>.cloudflareaccess.com
railway variables set RLM_WIKI_CF_ACCESS_AUD=<audience-tag>
railway variables set RLM_WIKI_ALLOWED_ORIGINS=https://<your-app-domain>

# 4. Keep concurrency conservative on one Railway replica
railway variables set RLM_WIKI_MAX_GENERATE=1
railway variables set RLM_WIKI_MAX_ASK=3
railway variables set RLM_WIKI_MAX_CODE=1
railway variables set RLM_WIKI_MAX_REVIEW=2
railway variables set RLM_WIKI_RUN_MODE=inline

# 5. Recommended: attach Railway Postgres and expose DATABASE_URL to this service.
# Railway reference variables avoid copying database credentials by hand.
railway variables set DATABASE_URL='${{Postgres.DATABASE_URL}}' --skip-deploys

# 6. Optional cache/scratch volume at /data. Do not treat it as the long-term
# source of truth once DATABASE_URL is configured.
railway variables set RLM_WIKI_ROOT=/data

# 7. Deploy
railway up
railway domain
```

The checked-in `railway.json` uses the Dockerfile builder, starts `bun run ./bin/rlm-wiki.ts serve`, and healthchecks `/api/health`. The server binds to `0.0.0.0:$PORT` when Railway injects `PORT`.

Keep `numReplicas=1` for this MVP. Active-run accounting is in memory: one active ask, generate, code, and review run per user, plus global caps from the `RLM_WIKI_MAX_*` variables. Overflow returns a busy response with `Retry-After` instead of queueing.

`RLM_WIKI_RUN_MODE=inline` preserves the original MVP request model: the SSE request owns the agent run. `RLM_WIKI_RUN_MODE=detached` is a reversible bridge toward workers: the run continues in the background and the browser stream replays persisted run events/results. Detached mode requires Postgres; if the product store is file-backed, the server falls back to inline.

`DATABASE_URL` also enables the Postgres-backed job queue. The queue is visible in
`GET /api/health` as `queue.mode`, `queue.queued`, and `queue.running`. Phase 2
uses it as a job boundary for detached runs; production can keep
`RLM_WIKI_RUN_MODE=inline` until a separate worker service is ready.

Worker execution also needs `RLM_WIKI_SECRET_GRANT_KEY`. BYOK provider keys are
stored only as encrypted, short-lived secret grants; raw provider keys are not
stored in runs, events, jobs, or artifacts.

Phase 3 worker mode is opt-in:

```bash
# web service
railway variables set RLM_WIKI_RUN_MODE=worker
railway variables set RLM_WIKI_SECRET_GRANT_KEY="$(openssl rand -base64 32)"

# worker service start command
bun run ./bin/rlm-wiki.ts worker
```

The first worker lanes support Code Anything jobs and wiki generation. Wiki
generation uses compact persisted progress events (`start`, `phase`,
`structure-done`, `page-start`, `page-done`, `page-error`) instead of streaming
every structure/page agent step through the browser. Ask/RLM-style exploration
stays inline so live reasoning and writing SSE remains intact.

For a reversible Railway rehearsal, use the operator script:

```bash
bun run railway:worker-mode status
bun run railway:worker-mode enable
bun run railway:worker-mode disable
```

`enable` creates/configures the `selfless-worker` service, deploys this repo to
it with `RLM_WIKI_PROCESS=worker`, then restarts the web service with
`RLM_WIKI_RUN_MODE=worker`. `disable` flips the web service back to `inline` and
stops the latest worker deployment so the extra compute cost is not left on.

For persistence, prefer Postgres:

- **Postgres** — attach a Railway Postgres service and keep `DATABASE_URL` available to the web service. Product run/event/artifact data moves to Postgres. Wiki artifacts and capability settings are mirrored through the product artifact store when Postgres is active.
- **Local filesystem / Railway volume** — useful as cache, scratch, and compatibility storage for generated wiki JSON, session files, and temporary runtime data. Do not rely on the web service volume as the long-term source of truth if you plan to add replicas or split workers.

Hosted subscription/OAuth providers need JCODE credentials inside the deployed environment. For hosted deploys, API-key providers are usually simpler: Gemini, DeepSeek, Cloudflare Workers AI, OpenRouter, MiniMax, and Anthropic API-key flows are easier to operate than browser-login or local subscription auth.

After `railway up`, generate a public domain from Railway networking and check:

```bash
curl https://<your-service>.railway.app/api/health
```

## Local Docker

```bash
docker build -t rlm-wiki .
docker run --rm -p 3141:3141 \
  -e GEMINI_API_KEY=... \
  -e DEEPSEEK_API_KEY=... \
  -e CLOUDFLARE_API_TOKEN=... \
  -e CLOUDFLARE_ACCOUNT_ID=... \
  rlm-wiki
```

## Storage Shape

```text
~/.rlm-wiki/
└── users/
    └── {userId}/
        ├── wikis/
        ├── product/
        │   ├── runs/
        │   ├── events/
        │   └── artifacts/
        ├── config/
        └── sessions/
```

When `DATABASE_URL` is set, product-level data is stored in Postgres tables:
`rlm_product_runs`, `rlm_product_run_events`, `rlm_product_artifacts`, and
`rlm_product_artifact_versions`.

`GET /api/health` includes `storage.productStore`, `storage.databaseUrlConfigured`,
`storage.localDiskRole`, `queue`, `secretGrants`, and `runMode`. For a
Postgres-first deploy, expect
`storage.productStore` to be `"postgres"` and `storage.localDiskRole` to be
`"cache"`.

## Known Limits

- GitHub only. No GitLab, Bitbucket, or arbitrary local paths in the web/API surface.
- JCODE must be installed and provider credentials must be configured where the server runs for Agent mode.
- RLM mode requires provider API keys supported by `rlm-bun`; Claude subscription auth through JCODE is only available in Agent mode.
- No first-party auth yet. Put Cloudflare Access in front of production and do not publicly share the raw Railway origin URL.
- Page generation failures do not abort the run; the failed page gets an error marker and the rest continue.
