# rlm-bun

Query codebases, data files, and GitHub PRs with a Recursive Language Model.

**v0.3.0**

rlm-bun runs a **think-code-observe loop**: the LLM thinks about what to check, writes JavaScript that runs in a persistent Bun sandbox, observes the real output, and repeats until it is ready to submit an answer. Nothing is shoved into the context window ahead of time — the target is treated as an external environment the agent explores with code.

```
User query
    |
    v
+-----------+    JS code    +--------------+
|    LLM    | ------------> |  Bun REPL    |
|  (agent)  | <------------ |  (sandbox)   |
+-----------+    output     +--------------+
    |                              |
    |  think -> code -> observe    |
    +------------------------------+
              (loop)
                |
                v
            SUBMIT -> Answer
```

## Operating Modes

| Mode | Source | Purpose |
|---|---|---|
| `repo` | GitHub URL or local git repo | Code exploration, architecture analysis |
| `file` | Local file or directory (non-git) | CSV/data/document analysis |
| `workspace` | Multiple named sources via `--sources` | Cross-repo compare, port, audit, bridge |
| `pr` | GitHub PR URL | Pull Request review with diff + conversation history |
| `chat` | None (`-p` / `--prompt`) | General-purpose assistant that reasons by running code |

Mode is auto-detected from the source unless overridden with `--mode`.

## Requirements

- Bun `>= 1.3.0`
- ripgrep (used by the `grep` sandbox tool)
- One LLM API key: `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, or `GEMINI_API_KEY`
- Optional: `GITHUB_TOKEN` or `gh` CLI (for PR review and private repos)

## Installation

From source — there is no npm publish yet.

```bash
git clone https://github.com/<owner>/rlm-bun
cd rlm-bun
bun install
```

Either link the binaries globally:

```bash
bun link    # exposes `rlm-bun`, `rlm-server`, and `graphify` on PATH
```

or invoke directly:

```bash
bun run src/index.ts . "your question"
```

## Quick Start

```bash
# Local repository
rlm-bun . "Find all unused dependencies"

# GitHub repository
rlm-bun https://github.com/expressjs/express "Explain the router architecture"

# CSV / data file
rlm-bun ./feedback.csv "Categorize feedback and highlight anomalies"

# Pull Request review
rlm-bun https://github.com/owner/repo/pull/123 "Review this PR"

# Multi-repo workspace comparison
rlm-bun --sources express=https://github.com/expressjs/express koa=https://github.com/koajs/koa --goal compare

# Chat mode — no source needed
rlm-bun -p "Write a Bun script that streams a large file line by line"

# Interactive session (enables /skill commands)
rlm-bun . "Explain the auth flow" --interactive

# Resume a previous session
rlm-bun . "What about the refresh token path?" --resume-session rlm-abc123
```

## CLI Reference

| Flag | Description | Default |
|---|---|---|
| `<source>` | GitHub URL, local git repo, file, or directory | — |
| `<query>` | Question (quote it) | — |
| `--sources <specs>` | Workspace sources as `id=url` pairs (space-separated) | — |
| `--goal <goal>` | Workspace goal: `compare`, `steal`, `understand`, `bridge`, `audit` | — |
| `--mode <mode>` | `auto`, `repo`, `file`, `workspace`, `pr`, `rlm` | `auto` |
| `--provider <name>` | `anthropic`, `openai`, `gemini`, `codex`, `codex-cli`, `claude-cli` | `anthropic` |
| `--model <id>` | Primary model ID | `claude-opus-4-7` (Anthropic) / `gpt-4o` / `gemini-2.5-flash` |
| `--base-url <url>` | Override primary API base URL (OpenAI-compatible) | — |
| `--sub-model <id>` | Secondary model used by `llmQuery` inside the sandbox | Same as `--model` |
| `--sub-provider <name>` | Secondary provider | Same as `--provider` |
| `--sub-base-url <url>` | Secondary base URL | Same as `--base-url` |
| `--max-iter <n>` | Max reasoning iterations | `20` |
| `--max-llm <n>` | Max sub-LLM calls per run | `5000` |
| `--branch <name>` | Git branch to check out (repo mode) | — |
| `--no-cache` | Disable repo caching for GitHub clones | cache enabled |
| `--sandbox-timeout <ms>` | Per-step sandbox execution timeout | `1800000` (30 min) |
| `--github-token <token>` | GitHub token for PR review | `$GITHUB_TOKEN` |
| `--prompt`, `-p` | Chat mode — no source needed | — |
| `--interactive`, `-i` | Stay alive after SUBMIT, enables `/skill` and `/help` commands | — |
| `--verbose` | Stream reasoning steps in real time | — |
| `--optimizer` | Auto-rewrite the query before analysis | — |
| `--json` | Print the final result as JSON | — |
| `--session-dir <dir>` | Directory for session JSONL files | `.rlm-sessions` |
| `--resume-session <id>` | Resume a previous session by ID | — |
| `-h`, `--help` | Show help | — |

## Workspace Goals

Pass `--goal <goal>` alongside `--sources` to enter workspace mode. Each goal expands into a tuned system prompt that steers the agent toward a specific cross-repo analysis.

| Goal | Label | Description |
|---|---|---|
| `compare` | Cross-repo comparison | Feature-by-feature matrix covering architecture, tooling, and trade-offs |
| `steal` | Steal / port features | Identify features unique to one repo and produce a prioritized port plan |
| `understand` | Cross-repo understanding | Shared patterns, differing approaches, and architectural lessons |
| `bridge` | Feature gap bridging | Gap matrix plus concrete steps to bridge missing features between repos |
| `audit` | Cross-repo audit | Shared patterns, anti-patterns, and best-practice extraction |

You can also pass a free-form query alongside the goal to narrow the scope:

```bash
rlm-bun --sources old=./v1 new=./v2 --goal bridge "Identify missing endpoints in v2"
rlm-bun --sources a=./repo-a b=./repo-b --goal understand "how do they handle caching?"
```

Paths inside the workspace sandbox use the `repoId:relative/path` prefix, e.g. `readFile("new:src/server.ts")`.

## MCP Integration

rlm-bun connects to any Model Context Protocol server and exposes its tools to the agent as `mcp__<server>__<tool>`. The config format is compatible with Claude Desktop, Cursor, and Windsurf.

### Config locations (first match wins)

| Location | Scope |
|---|---|
| `<cwd>/.mcp.json` | Project root — recommended, commit to the repo |
| `<cwd>/.rlm-bun/mcp.json` | Project-specific rlm-bun config |
| `~/.rlm/mcp.json` | Global user config |

### Stdio transport

```json
{
  "mcpServers": {
    "github": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-github"],
      "env": { "GITHUB_TOKEN": "${GITHUB_TOKEN}" }
    },
    "chrome-devtools": {
      "command": "npx",
      "args": ["-y", "chrome-devtools-mcp@latest"]
    }
  }
}
```

### HTTP / SSE transport

```json
{
  "mcpServers": {
    "linear": {
      "type": "http",
      "url": "https://mcp.linear.app/mcp",
      "headers": { "Authorization": "Bearer ${LINEAR_API_KEY}" }
    },
    "events": {
      "type": "sse",
      "url": "https://example.com/mcp/sse"
    }
  }
}
```

`${ENV_VAR}` placeholders are resolved at connection time. Set `"enabled": false` to disable a server. If one server fails to connect, the others continue and the agent starts normally.

From inside the sandbox, call `list_mcp_tools()` to see what's available.

## Skills

Skills are `SKILL.md` files (YAML frontmatter plus a markdown body) that get injected directly into the system prompt at runtime. They give the agent domain knowledge with no code changes.

```markdown
---
name: react-best-practices
description: React and Next.js performance guidelines
---

# React Best Practices

Always use React.memo for expensive components...
```

### Slash commands (interactive mode)

Run with `--interactive` and use:

```
/skill add vercel-labs/agent-skills@react-best-practices   # single skill from GitHub
/skill add owner/repo                                      # all skills from a repo
/skill add ./my-skills                                     # local directory
/skill list
/skill remove react-best-practices
/skill clear
/help
```

### Source formats

| Format | Example |
|---|---|
| `owner/repo@skill` | `vercel-labs/agent-skills@react` |
| `owner/repo` | `vercel-labs/agent-skills` |
| `owner/repo/subpath` | `myorg/skills/react` |
| Full GitHub URL | `https://github.com/org/repo/tree/main/skills` |
| Local path | `./my-skills` |

GitHub skills are cached under `~/.rlm/skills-cache/<owner>__<repo>` and refreshed with `git pull` on re-load. The set of loaded sources is persisted to `.rlm-bun/skills.json` in the working directory and auto-restored on the next run — commit this file to share skill sets with your team.

## Session Management

Every run writes an append-only JSONL event log that records every reasoning step, code block, tool call, and raw output at full fidelity — never truncated, never summarized. The agent can query its own history from inside the sandbox:

```js
const events = await getSessionEvents({ type: "tool-call", fromStep: 3 });
```

### Flags

| Flag | Effect |
|---|---|
| `--session-dir <dir>` | Directory for session files (default `.rlm-sessions`) |
| `--resume-session <id>` | Load an existing session and continue from it |

### Backends

- `FileSession` — local JSONL file at `<sessionDir>/<sessionId>.jsonl` (default).
- `S3Session` — extends `FileSession` and uploads the JSONL to an S3 bucket via AWS SDK v3 on `save()`.

Because sessions are durable and queryable, they survive context-window compaction. The agent can recover any earlier fact by asking its own log.

## LSP Integration

When a TypeScript language server is available, the sandbox exposes `lsp_query(op, file, line, char)` with operations such as `goToDefinition` and `findReferences`. This lets the agent resolve imports and trace symbol usage precisely instead of guessing with regex.

## Sandbox Tools Reference

All tools below are available as globals inside the Bun sandbox.

### Exploration

| Tool | Signature | Description |
|---|---|---|
| `readFile` | `(path)` | Read a file as UTF-8 |
| `inspect` | `(path)` | File metadata: size, kind, type, binary flag, optional line count |
| `glob` | `(pattern)` | Find matching files |
| `grep` | `(pattern, { glob?, maxResults? }?)` | ripgrep-backed content search |
| `listFiles` | `()` | List all tracked files |
| `gitLog` | `(n?)` | Recent commits |
| `gitDiff` | `(a, b?)` | Diff between two refs |
| `gitBlame` | `(path)` | Per-line blame |
| `gitStatus` | `()` | Short status |
| `gitDiffWorking` | `(path?)` | Unstaged diff |
| `bash` | `(command, { timeout?, maxOutput? }?)` | Run a shell command (destructive patterns blocked) |

### File / Data

| Tool | Signature | Description |
|---|---|---|
| `fileInfo` | `(path)` | Size, optional line count, type, mtime |
| `csvInfo` | `(path)` | Columns, row count, sample, inferred types |
| `csvQuery` | `(path, opts?)` | Filter and return rows |
| `csvAggregate` | `(path, opts)` | Group-by aggregation |

### Semantic

| Tool | Signature | Description |
|---|---|---|
| `lsp_query` | `(op, file, line, char)` | TypeScript LSP — `goToDefinition`, `findReferences` |
| `run_websearch` | `(query)` | Web search via the primary provider |

### Agent Delegation

| Tool | Signature | Description |
|---|---|---|
| `llmQuery` | `(prompt)` | Delegate a sub-task to the secondary LLM |
| `llmQueryBatched` | `(prompts[])` | Run many sub-LLM queries in parallel |
| `run_agent` | `({ agent, prompt, timeout?, maxOutput? })` | Spawn an external coding agent (`claude`, `gemini-cli`, `codex`, `opencode`, `copilot`, `cursor-agent`) |
| `list_mcp_tools` | `()` | List connected MCP tools |
| `mcp__<server>__<tool>` | varies | Call a tool exposed by a connected MCP server |

### State Management

| Tool | Description |
|---|---|
| `getSessionEvents(opts?)` | Query the full-fidelity event log (by step, type, range, or last N) |
| `PLAN(tasks)` | Create a task plan |
| `updateTask(i, status, notes?)` | Update a task |
| `getPlan()` | Retrieve the current plan |
| `SUBMIT({ answer, sources })` | Finalize the run and return the answer |

## Programmatic API

```ts
import { RLM, AnthropicClient } from "rlm-bun";

const llm = new AnthropicClient({ model: "claude-opus-4-7" });

const rlm = new RLM({
  source: "https://github.com/facebook/react",
  llm,
});

const result = await rlm.query("Where is the reconciler implemented?");
console.log(result.answer);
console.log(rlm.getTokenUsage());
```

### Other clients

```ts
import { OpenAIClient, GeminiClient } from "rlm-bun";

const openai = new OpenAIClient({ model: "gpt-4o" });
const gemini = new GeminiClient({ model: "gemini-2.5-flash" });
```

### Chat mode (no source)

```ts
const rlm = new RLM({
  mode: "chat",
  llm: new AnthropicClient({ model: "claude-opus-4-7" }),
});

const result = await rlm.query("Write a Bun script to stream a file");
```

### Skills

```ts
import { RLM, AnthropicClient, SkillRegistry } from "rlm-bun";

const registry = new SkillRegistry();
await registry.add("vercel-labs/agent-skills@react-best-practices");

const rlm = new RLM({ source: ".", llm: new AnthropicClient({ model: "claude-opus-4-7" }) });
rlm.setSkillsPromptText(registry.formatForPrompt());

await rlm.query("How should I optimize this component?");
```

### MCP

```ts
const rlm = new RLM({
  source: ".",
  llm,
  mcpConfig: {
    mcpServers: {
      "chrome-devtools": { command: "npx", args: ["-y", "chrome-devtools-mcp@latest"] },
    },
  },
});
```

Options are validated against `RLMOptionsSchema` (Zod). See `src/index.ts` for the full export surface: clients, tools (`buildRepoTools`, `buildFileTools`, `buildWorkspaceTools`), session (`FileSession`, `S3Session`), skills (`SkillRegistry`), and MCP (`loadMCPConfig`, `connectAllMCPServers`).

## Development

```bash
bun test                          # run the test suite
bun run example:local             # examples/ask-local.ts
bun run example:github            # examples/ask-github.ts
bun run server                    # bin/rlm-server.ts HTTP server
bun run graphify <path>           # bin/graphify.ts — build a knowledge graph over a repo
```

Examples live under `examples/`:

| File | Description |
|---|---|
| `examples/ask-local.ts` | Query a local repo programmatically |
| `examples/ask-github.ts` | Query a remote GitHub repo |
| `examples/chat.ts` | Chat mode without a source |
| `examples/pr-review.ts` | PR review mode |

## License

MIT License — Copyright (c) 2026 Sheing Ng
