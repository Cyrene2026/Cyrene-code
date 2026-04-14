# Cyrene Frontend v2

This directory is the Go terminal frontend rewrite using Bubble Tea and Lip Gloss.

Current scope:

- Bubble Tea `model/update/view` loop
- bottom-pinned composer and status line, following the earlier CLI page structure
- transcript viewport with streaming assistant output
- Bun/TypeScript bridge into the existing query transport, session store, auth runtime, and MCP approval runtime
- session create/list/load flow
- approval queue render + approve/reject actions
- model/provider picker panels
- HTTP auth panel wired to the existing auth runtime
- mouse-aware transcript/panel wheel routing plus click/double-click picker support
- `PgUp` / `PgDn` transcript scroll support
- terminal resize handling via `tea.WindowSizeMsg`

Runtime notes:

- v2 still depends on `bun` at runtime because the business logic remains in the TypeScript bridge.
- session/config path resolution follows the existing CLI logic: use global `~/.cyrene` by default, or honor explicit `CYRENE_HOME` if set.
- mouse capture starts enabled; press `F6` to switch to terminal copy/paste mode, then press `F6` again to restore in-app mouse scrolling and picker clicks.

Commands:

- `/help`
- `/login`
- `/logout`
- `/auth`
- `/provider`
- `/provider refresh`
- `/provider profile list`
- `/provider profile <openai|gemini|anthropic|custom> [url]`
- `/provider profile clear [url]`
- `/model`
- `/model refresh`
- `/model <name>`
- `/sessions`
- `/resume`
- `/resume <session-id>`
- `/load <session-id>`
- `/review`
- `/review <id>`
- `/approve <id|low|all>`
- `/reject <id|all>`
- `/new`
- `/clear`
- `/quit`

Run locally:

```bash
bun run v2:dev
```

Build:

```bash
bun run build
```

`bun run v2:build` now aliases the default build pipeline and produces the same
`dist/cyrene-v2` binary.
