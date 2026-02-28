# Control Plane Architecture

## Purpose

`apps/control-plane` is the single Telegram hub for operator actions and LLM development tasks.

## Runtime model

- One Telegram-facing bot (`src/copilot-hub.ts`)
- Command path for simple operations (`/health`, `/bots`, `/create_agent`)
- LLM path for normal text requests

## Boundaries

- `control-plane` orchestrates operations via `agent-engine` HTTP API.
- `agent-engine` executes and hosts runtime agents.

## Workspace defaults

If `HUB_WORKSPACE_ROOT` is empty, default workspace root is:
- `~/Desktop/copilot_workspaces`

This keeps user workspaces outside application source code.
