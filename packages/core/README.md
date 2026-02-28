# Core

Shared runtime utilities for all Copilot Hub apps.

Current modules:
- `workspace-policy`: workspace boundary policy creation and enforcement.
- `workspace-paths`: desktop/workspace path helpers used by runtime apps.
- `thread-id`: canonical thread id validation.
- `project-fingerprint`: stable fingerprint generator for runtime session isolation.
- `instance-lock`: single-instance process lock helper.
- `state-store`: persisted session/thread state helper shared by runtime apps.
- `control-permission`: shared kernel control authorization guard.
- `kernel-version`: shared kernel version constant.
- `capability-scaffold`: capability scaffolding helpers.
- `secret-store`: shared secret store helper.
- `bot-registry`: shared registry loader/normalizer for runtime agents.
- `agent-supervisor`: shared worker supervision logic.
- `bot-manager`: shared multi-bot lifecycle orchestration.
- `bot-runtime`: shared bot runtime engine.
- `bridge-service`: shared conversation orchestration layer.
- `codex-app-client`: shared Codex app-server client bridge.
- `codex-provider`: shared provider adapter built on Codex app-server.
- `provider-factory`: shared provider construction helpers.
- `capability-manager`: shared capability loading + hook runtime.
- `channel-factory`: shared default channel adapter factory.
- `telegram-channel`: shared Telegram channel adapter.
- `whatsapp-channel`: shared WhatsApp placeholder adapter.
- `control-plane-actions`: shared control-plane action contracts.
- `extension-contract`: shared extension contract descriptor.
- `kernel-control-plane`: shared kernel control action executor.
- `example-capability`: shared sample capability factory for local examples.

Use this package for cross-app primitives that must stay consistent across planes.
