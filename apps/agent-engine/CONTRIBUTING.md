# Contributing

Thanks for contributing.

## Quick setup

1. Install dependencies:

```bash
npm install
```

2. Create local config:

```bash
npm run setup
```

3. Run locally:

```bash
npm run start
```

## Rules

- Do not commit secrets (`.env`, `data/`, tokens).
- Keep changes focused and small.
- Update `README.md` / `.env.example` if behavior changes.
- Validate syntax before opening a PR:

```bash
node --check src/index.js
```

## Pull requests

- Describe what changed and why.
- Include reproduction steps and expected behavior.
- Link related issue(s) when available.
