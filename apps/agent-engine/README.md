# Agent Engine

`agent-engine` is the execution plane for worker agents, Telegram channels, capabilities, projects, and runtime policy.

In Copilot Hub:
- `apps/control-plane`: single Telegram hub chat (operations + LLM development)
- `apps/agent-engine`: runtime execution plane

## Quick start

```bash
npm install
# Windows
copy .env.example .env
# macOS/Linux
cp .env.example .env
npm run setup
npm run start
```

## Operator entry point

Use `apps/control-plane` as the main operator chat.

## Workspace policy

- If `DEFAULT_WORKSPACE_ROOT` is empty, default root is `~/Desktop/copilot_workspaces`.
- `WORKSPACE_STRICT_MODE=true` enforces allowed roots.
- `WORKSPACE_ALLOWED_ROOTS` lets you append extra allowed roots.
- Agent workspaces must stay outside the kernel directory.

## Runtime API

Core:
- `GET /api/health`
- `GET /api/bots`
- `POST /api/bots/create`
- `POST /api/bots/:botId/delete`
- `POST /api/bots/:botId/policy`
- `POST /api/bots/:botId/reset`

Projects:
- `GET /api/projects`
- `POST /api/projects/create`
- `POST /api/bots/:botId/project`

Capabilities and approvals:
- `GET /api/bots/:botId/capabilities`
- `POST /api/bots/:botId/capabilities/reload`
- `POST /api/bots/:botId/capabilities/scaffold`
- `GET /api/bots/:botId/approvals`
- `POST /api/bots/:botId/approvals/:approvalId`

## Security

- Never commit `.env` or `data/`.
- Rotate exposed tokens.
