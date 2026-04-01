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

## Configure

Set `QUERY_BASE_URL` to your API host. The app posts to `/query` and expects a JSON body like:

```json
{ "streamUrl": "https://your-host/stream" }
```

The streaming endpoint should emit SSE with `data:` lines and end with `[DONE]`.
