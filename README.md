# Bun Ink Query Loop

TypeScript + Bun + React Ink + Axios + Zod setup with an event-stream query loop.

## Install

```bash
bun install
```

## Run

```bash
bun dev
```

By default, the CLI runs with a local in-memory core transport, so you can test
the full query loop without any backend service.

## Configure

Put these env vars in your prepared env file to enable OpenAI-compatible HTTP transport:

```bash
CYRENE_BASE_URL=https://your-openai-compatible-host
CYRENE_API_KEY=your_api_key
CYRENE_MODEL=gpt-4o-mini
```

When they are set, the CLI sends `POST /v1/chat/completions` with streaming enabled.
When they are missing, the app falls back to local core transport.

Current request shape:
```json
{
  "model": "gpt-4o-mini",
  "stream": true,
  "messages": [{ "role": "user", "content": "..." }]
}
```

Model switch:
- `/model` shows current model.
- `/model <name>` switches model at runtime.

Prompt priority and customization:
- Priority is fixed as: `system prompt > .cyrene/.cyrene.md > pins`.
- User-facing config is centralized in `.cyrene/config.yaml`.
- `system_prompt` can be set in `.cyrene/config.yaml` (or env fallback: `CYRENE_SYSTEM_PROMPT=...`).
- Runtime system prompt commands:
  - `/system` show current system prompt
  - `/system <text>` set current runtime system prompt
  - `/system reset` reset to default
- `.cyrene/.cyrene.md` is fully user-editable project policy.
- `/pin <note>` and `/pins` manage human-selected focus.
- `/unpin <index>` removes one pinned focus item (1-based index).

Session and context:
- Sessions are persisted under `.cyrene/session` as JSON files.
- `/sessions` lists sessions by latest update time.
- `/resume <session_id>` restores a previous session.
- `/new` starts a fresh session.
- `/pin <note>` stores human-selected key context.
- `/pins` shows pinned key context.
- `/unpin <index>` removes a pinned key context item.
- Pin count comes from `.cyrene/config.yaml` via `pin_max_count`.
- Older context is compressed to summary and recent turns are kept for prompt context.
