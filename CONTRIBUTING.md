# Contributing

Thanks for contributing to Copilot Hub.

## Principles

- Respect the 2-plane architecture (`control-plane`, `agent-engine`).
- Keep runtime core stable; add features via capabilities when possible.
- Use versioned contracts in `packages/contracts` for cross-plane changes.

## Security rules

- Never commit secrets (`.env`, token values, `data/` content).
- Rotate any token exposed in logs/chat/history.

## Dev flow

1. Update code in the relevant app/package.
2. Run quality checks:
   - `npm run test`
   - `npm run lint`
   - `npm run format:check`
3. Run smoke checks for impacted app(s).
4. Update docs if behavior changed.

## Pull requests

- Explain the problem and the architectural impact.
- Include verification steps.
- Keep changes scoped and reversible.
