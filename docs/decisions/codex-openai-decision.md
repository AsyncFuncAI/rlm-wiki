# Codex vs OpenAI API Decision

## Decision

For the MVP web app, GPT models should run through **OpenAI API BYOK** using `OPENAI_API_KEY`.

Codex subscription/JCODE login support should remain as a **legacy/local channel**, not the default production path for invited users.

## Why

The product is now invite-based and BYOK-only. Friends who try rlm-wiki need a model path they can understand and control:

- Paste an API key in **Model access**.
- Pick `GPT-5.5`, `Claude Sonnet`, `Gemini`, `DeepSeek`, or an OpenRouter model.
- Run the task.

Codex subscription auth is different. It depends on an interactive local login, CLI state, machine-local credentials, and provider approval flows. That makes sense on a developer laptop, but it is awkward and risky on a hosted Railway app where many users share one server process.

The key Socratic question was:

> If six friends log in today, whose Codex account would they be using?

If the answer is "the server owner's", that is not acceptable for a multi-user MVP. If the answer is "each user's", then we need a real per-user OAuth/session design before it is production-ready.

## Current Shape

Production web:

- `gpt-5.5`
- `gpt-5.5-pro`
- `gpt-5.4-mini`

These are OpenAI API channels and require `OPENAI_API_KEY` from the current browser's model access store.

Legacy/local:

- `codex:gpt-5.5`
- `codex:<model>`

These use the JCODE/OpenAI provider path and are useful for local developer workflows where the machine is intentionally logged in.

## User Experience

In production, a user who wants GPT should:

1. Open **model access**.
2. Add an OpenAI API key.
3. Save it for this session or this device.
4. Pick `GPT-5.5` or another OpenAI API model.

The key is sent only with run requests. It is not persisted in Postgres or server storage. Browser "this device" persistence means localStorage on that user's browser, not server-side storage.

## Why Not Use Codex First

Codex/JCODE login is excellent for one developer using one machine. It is less clean for hosted multi-user beta access:

- The Railway container cannot open a per-user login flow reliably.
- Server-side JCODE auth state risks becoming shared account state.
- We would need to isolate provider credentials per verified user.
- We would need clear UX around "connect ChatGPT/Codex account" vs "paste API key".
- We would need revocation and status handling per user.

So for MVP, OpenAI API BYOK is the honest version of "your usage, your key, your quota."

## Future: Bringing Codex Back

We can support Codex again if we make it explicitly per-user.

Needed pieces:

- A user-scoped credential store, probably encrypted server-side.
- A real "Connect Codex/OpenAI account" flow, not shared CLI state.
- Per-user JCODE config directories or isolated subprocess environments.
- Clear separation between:
  - OpenAI API key channels (`OPENAI_API_KEY`)
  - Codex subscription channels (`codex:<model>`)
- A `/api/me/model-connections` style status endpoint.
- A disconnect/revoke path.
- Tests proving User A cannot run with User B's Codex credentials.

Until those exist, Codex channels should stay opt-in and local/admin-oriented.

## Implementation Notes

Current model registry behavior:

- `openai` provider uses `OPENAI_API_KEY`.
- `codex` provider is still present for legacy/local paths.
- `codex:<model>` dynamic channels still resolve, but they are not normal BYOK production choices.
- Production UI marks provider-key models as needing model access.

If we reintroduce Codex for production, do not overload the `openai` provider. Add a distinct user-facing connection type so the product can say exactly what account and quota will be used.
