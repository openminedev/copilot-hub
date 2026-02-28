# Agent Engine Architecture

## Purpose

`apps/agent-engine` is the execution plane.
It runs worker agents, channels, sessions, capabilities, and the runtime HTTP API.

## Main components

- Runtime kernel (`src/index.ts`)
- Bot manager + worker supervisors
- Provider adapters (Codex, future providers)
- Channel adapters (Telegram)
- Control plane actions for bot lifecycle and capabilities

## Operations model

Recommended:
- Use `apps/control-plane` as the operator chat over HTTP APIs

This keeps one operator entry point while preserving runtime isolation.

## Data layout

- `data/bot-registry.json`: bot definitions
- `data/secrets.json`: secret references (`tokenEnv` values)
- `data/bots/<botId>/sessions.json`: per-bot sessions
- External workspaces: `~/Desktop/copilot_workspaces/<botId>` by default

## API surface

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

Advanced:
- `GET /api/bots/:botId/capabilities`
- `POST /api/bots/:botId/capabilities/reload`
- `POST /api/bots/:botId/capabilities/scaffold`
- `GET /api/bots/:botId/approvals`
- `POST /api/bots/:botId/approvals/:approvalId`
