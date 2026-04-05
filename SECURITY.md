# Security Policy

## Supported versions

This repository is under active development. Security fixes are expected to land
on the latest mainline code first.

| Version | Supported |
| --- | --- |
| latest `main` / current working tree | Yes |
| older snapshots / forks / local patches | Best effort only |

## Reporting a vulnerability

If you believe you found a security issue, please **avoid public disclosure
first**.

Recommended process:

1. Share the issue privately with the project maintainers through an existing
   trusted channel.
2. Include:
   - affected commit / branch
   - reproduction steps
   - impact assessment
   - whether the issue requires local access, workspace access, or network access
3. Wait for a fix or mitigation plan before publishing details.

If this repository is hosted on a platform that supports private security
reporting, prefer that channel.

## Security model

Cyrene is a local, terminal-first coding assistant. Its security posture relies
on a few core boundaries:

### 1. Workspace boundary

- file tools are intended to stay inside the configured workspace root
- path-escape checks should reject reads/writes outside the workspace
- review-gated mutations should show the exact target path before approval

### 2. Human review boundary

- destructive or higher-risk filesystem actions should require review
- shell and command execution should be reviewable unless explicitly classified
  as low risk
- persistent shell sessions should preserve clear status output so users know
  what is running

### 3. Prompt/context boundary

- long-lived context is compacted into `summary` and `pendingDigest`
- archive memory is indexed and retrieved selectively instead of replaying
  entire transcripts
- hidden reducer state should never be shown to users as visible transcript text

### 4. Provider boundary

- HTTP transport sends prompts to an OpenAI-compatible API when configured
- `CYRENE_API_KEY` is intentionally excluded from transcript items, session
  JSON, reducer state (`summary` / `pendingDigest`), and memory index storage
- Cyrene may persist `CYRENE_API_KEY` in **user-scoped environment/profile
  storage** through the login flow:
  - Windows user environment
  - managed shell-profile blocks for zsh / bash / POSIX shells
  - managed fish config file under `~/.config/fish/conf.d/`
- provider URL and model catalog metadata live in the global user `.cyrene`
  directory and are treated as non-secret runtime metadata
- model/provider switching should be explicit and visible in the UI

## Current hardening expectations

When changing code, please preserve or improve these properties:

- prevent duplicate request submission and duplicate completion handling
- avoid command/tool loops that cause accidental repeated execution
- keep approval flows one-shot and idempotent where possible
- do not allow hidden reducer metadata to leak into visible assistant output
- keep large-file and large-output handling bounded to protect terminal stability
- maintain test coverage for:
  - workspace escape protection
  - review-gated file mutations
  - command/shell risk handling
  - duplicate submit / duplicate finalize guards
  - reducer fallback behavior

## Out of scope / non-goals

Unless explicitly documented otherwise, this project does **not** currently
promise:

- sandboxing against a malicious local user with full machine access
- protection against a compromised upstream model or provider
- protection against unsafe custom plugins, local patches, or user-modified
  prompts/policies
- backward security support for stale forks or heavily diverged branches

## Secure deployment notes

If you run Cyrene outside local experimentation:

- keep API keys out of the repo and shell history
- review `.cyrene/` config and session files before sharing them
- remember that login persistence writes `CYRENE_API_KEY` to user-scoped shell
  or environment storage, not to session JSON
- treat session logs as potentially sensitive prompt/output data
- prefer least-privilege execution contexts for shell access
- verify Docker / CI mounts so the workspace root is exactly what you intend
- rotate provider credentials if they were ever written to logs or transcripts

## Disclosure philosophy

Please report vulnerabilities responsibly and give maintainers time to patch
before publishing exploit details. Public issues are welcome for general
hardening ideas, but not for live secrets, escape techniques, or reproducible
unpatched exploit chains.
