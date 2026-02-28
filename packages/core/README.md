# Core

Shared runtime utilities for all Copilot Hub apps.

Current modules:
- `workspace-policy`: workspace boundary policy creation and enforcement.
- `workspace-paths`: desktop/workspace path helpers used by runtime apps.
- `thread-id`: canonical thread id validation.
- `project-fingerprint`: stable fingerprint generator for runtime session isolation.
- `instance-lock`: single-instance process lock helper.

Use this package for cross-app primitives that must stay consistent across planes.
