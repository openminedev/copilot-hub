# Copilot Hub

Copilot Hub is a 2-plane monorepo for building and operating Telegram AI agents.

## Planes

- `apps/control-plane`: single Telegram hub chat for operations commands and LLM development tasks.
- `apps/agent-engine`: execution plane (workers, channels, sessions, capabilities).

Shared packages:
- `packages/contracts`
- `packages/core`
- `packages/capabilities`

## Hub chat model

The same Telegram chat handles both operations and development:

- commands: `/help`, `/health`, `/bots`, `/create_agent`, `/cancel`
- normal message: handled by the LLM assistant

## Workspace isolation

Each runtime agent has its own dedicated `workspaceRoot`.

```mermaid
flowchart LR
    CA["Chat A"] --> A["Agent A"] --> WA["~/Desktop/copilot_workspaces/Agent_A"]
    CB["Chat B"] --> B["Agent B"] --> WB["~/Desktop/copilot_workspaces/Agent_B"]
    CC["Chat C"] --> C["Agent C"] --> WC["~/Desktop/copilot_workspaces/Agent_C"]
```

Why this matters:
- multiple chats can run at the same time without mixing files
- multiple projects can run in parallel on the same machine
- one agent change stays inside that agent workspace

## Control-plane role

- `control chat` is a simple maintenance chat: fix issues and add new capabilities.
- `runtime chats` are user-facing chats: execute tasks and deliver results.
- users stay in runtime chats for normal work and use control chat only when an agent needs a fix or upgrade.

## Example flow

Scenario: user asks a runtime chat (Agent A) to create a website from an image.

```mermaid
flowchart TD
    U1["User -> Runtime chat (Agent A): Create a website from this image"] --> C{"Can Agent A read images?"}
    C -- Yes --> O1["Agent A builds the website"]
    C -- No --> M["Agent A says: I cannot read images yet"]

    M --> U3["User -> Control chat (control-plane): Fix this for Agent A"]
    U3 --> I["Control chat adds image_reader to Agent A workspace"]
    I --> T{"Works correctly?"}
    T -- No --> U3
    T -- Yes --> R["Agent A reloads capabilities"]

    R --> U4["User -> Runtime chat (Agent A): Continue the website task"]
    U4 --> O1
```

## Quick start

1. Install dependencies:

```bash
npm install
```

2. Start services:

```bash
npm run start
```

`start` checks required tokens and prompts only if values are missing.

## Startup troubleshooting

- If `npm run start` fails, first read the error and follow the suggested action.
- `npm run start` now auto-detects Codex from VS Code (Windows) and can install Codex CLI automatically if missing.
- For Codex login issues, run `codex login` (or the configured `CODEX_BIN`) and retry `npm run start`.
- If auto-install is skipped or unavailable, install Codex CLI with `npm install -g @openai/codex` or set `CODEX_BIN` in `.env`.
- If you are still stuck, ask your favorite LLM with the exact error output.

## Commands

```bash
npm run start
npm run stop
npm run restart
npm run status
npm run logs
npm run configure
```

## Workspace policy

- Default workspace root: `~/Desktop/copilot_workspaces` when not explicitly set.
- `WORKSPACE_STRICT_MODE=true` enforces allowed roots.
- `WORKSPACE_ALLOWED_ROOTS` adds extra allowed roots.
- Workspaces inside kernel directories are rejected.

## Runtime files

- PIDs: `.copilot-hub/pids/`
- Logs: `logs/`

## Security

- Never commit real tokens.
- Keep `.env` and runtime data local.
- Rotate leaked tokens immediately.
