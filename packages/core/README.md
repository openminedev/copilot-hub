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

Use this package for cross-app primitives that must stay consistent across planes.
