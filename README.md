<p align="center">
  <img src="assets/brand/cyrene-logo.svg" alt="Cyrene" width="420" />
</p>

# Cyrene

Terminal-first coding assistant built with Bun, React Ink, and a reviewable query loop.

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
- `/model` opens model picker (Up/Down select, Left/Right page, Enter switch).
- `/model refresh` pulls model list immediately and overwrites `.cyrene/model.yaml`.
- `/model <name>` switches immediately only if model exists in `.cyrene/model.yaml`; otherwise it fails.

Model source priority:
1. `.cyrene/model.yaml`
2. If missing/invalid, fetch from `GET /v1/models`
3. If fetch fails, model initialization fails (and refresh reports failure)

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
- `/help` shows the command reference.
- `/sessions` lists sessions by latest update time.
- `/resume <session_id>` restores a previous session.
- `/resume` opens keyboard picker (Left/Right page, Enter resume, Esc cancel).
- `/new` starts a fresh session.
- `/pin <note>` stores human-selected key context.
- `/pins` shows pinned key context.
- `/unpin <index>` removes a pinned key context item.
- Pin count comes from `.cyrene/config.yaml` via `pin_max_count`.
- Older context is compressed to summary and recent turns are kept for prompt context.
