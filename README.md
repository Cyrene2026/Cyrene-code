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
- `auto_summary_refresh` can be set in `.cyrene/config.yaml` to enable/disable the rolling reducer that updates `summary` + `pendingDigest` inside normal user turns. Default: `true`.
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
- `/state` shows reducer/session state diagnostics for the current runtime.
- Pin count comes from `.cyrene/config.yaml` via `pin_max_count`.
- Older context is tracked through the rolling working-state pair: durable `summary` + lagging `pendingDigest`, while recent turns are kept for prompt context.

## Rolling context architecture

Cyrene keeps long-running coding context in three layers instead of stuffing the
entire transcript back into every prompt:

1. **`summary`** - a durable, compact working state used as the main context anchor
2. **`pendingDigest`** - the most recent turn digest that has not been merged yet
3. **memory index** - richer archived evidence that can be retrieved on demand

This keeps prompts smaller while still preserving continuity. The durable summary
is intentionally structured into sections such as:

- `OBJECTIVE`
- `CONFIRMED FACTS`
- `CONSTRAINTS`
- `COMPLETED`
- `REMAINING`
- `KNOWN PATHS`
- `RECENT FAILURES`
- `NEXT BEST ACTIONS`

### High-level memory layout

```mermaid
flowchart TD
    U["User turn"] --> P["Prompt builder"]
    S["Durable summary"] --> P
    D["Pending digest<br/>(last turn, not yet merged)"] --> P
    M["Memory index<br/>(retrieved evidence)"] --> P
    P --> Q["Main model request"]
    Q --> A["Visible assistant answer"]
    Q --> H["Hidden reducer block<br/>&lt;cyrene_state_update&gt;..."]
    H --> R["Reducer parser"]
    R --> S
    R --> D
    M -. "search / retrieval guided by summary + digest" .-> P
```

### One turn -> summary progression

Cyrene does **not** make a second background summary request after the answer.
Instead, state updates piggyback on the same main response.

```mermaid
sequenceDiagram
    participant U as User
    participant C as Cyrene UI
    participant P as Prompt Builder
    participant L as LLM
    participant R as Reducer Parser
    participant S as Session Store

    U->>C: Send current request
    C->>S: Load summary + pendingDigest + retrieved memory
    S-->>C: Current session context
    C->>P: Build main prompt
    P->>L: One normal model request

    L-->>C: Visible answer + hidden state tail
    Note over L,C: <cyrene_state_update>{...}</cyrene_state_update>

    C->>R: Strip visible answer, parse reducer payload
    R-->>C: Parsed update
    C->>S: Persist visible assistant message

    alt First reducer-enabled turn
        C->>S: Keep summary as-is
        C->>S: Store new pendingDigest
    else Later turn with valid reducer payload
        C->>S: Merge old pendingDigest into summary
        C->>S: Replace pendingDigest with current-turn digest
    else Missing/invalid reducer tail
        C->>R: Build local fallback digest
        alt Prior pendingDigest exists
            C->>S: Locally advance summary from prior pendingDigest
            C->>S: Store fallback pendingDigest for current turn
        else No prior pendingDigest
            C->>S: Store fallback pendingDigest only
        end
    end
```

### Why this design exists

- avoids a hidden second model call after every answer
- keeps prompt growth bounded
- makes task progress explicit for the model
- lets archive retrieval stay detailed while the working state stays small

Use `/state` during a session to inspect reducer mode, `summary` length,
`pendingDigest` length, and the latest state-update diagnostic.

## Security

See [SECURITY.md](SECURITY.md) for repository security boundaries, disclosure
guidelines, and hardening notes.
