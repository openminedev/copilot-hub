# Control Plane

`control-plane` is the single Telegram hub for Copilot Hub.

It handles:

- simple operations commands (`/help`, `/health`, `/bots`, `/create_agent`, `/codex_status`, `/codex_login`, `/cancel`)
- LLM development requests through normal chat messages

## Setup

```bash
npm install
# Windows
copy .env.example .env
# macOS/Linux
cp .env.example .env
npm run start
```

Required env:

- `HUB_TELEGRAM_TOKEN` (or custom `HUB_TELEGRAM_TOKEN_ENV`)

Recommended env:

- `HUB_ENGINE_BASE_URL` (default: `http://127.0.0.1:8787`)

## Workspace and policy guards

- `HUB_WORKSPACE_ROOT` is validated against shared workspace policy.
- `WORKSPACE_STRICT_MODE` and `WORKSPACE_ALLOWED_ROOTS` follow the same boundary model as `agent-engine`.

## Responsibility boundary

- `control-plane`: operator chat + development assistant.
- `agent-engine`: execution of worker agents.
