import assert from "node:assert/strict";
import test from "node:test";
import { createProjectFingerprint } from "@copilot-hub/core/project-fingerprint";

test("createProjectFingerprint is stable and order-independent for channels", () => {
  const a = createProjectFingerprint({
    runtimeId: "control-plane",
    workspaceRoot: "./workspace-admin",
    providerKind: "CODEX",
    channels: [
      { kind: "telegram", id: "123" },
      { kind: "whatsapp", id: "admin" },
    ],
  });

  const b = createProjectFingerprint({
    runtimeId: "control-plane",
    workspaceRoot: "./workspace-admin",
    providerKind: "codex",
    channels: [
      { kind: "whatsapp", id: "admin" },
      { kind: "telegram", id: "123" },
    ],
  });

  assert.equal(a, b);
  assert.match(a, /^[a-f0-9]{24}$/);
});

test("createProjectFingerprint changes when stable inputs differ", () => {
  const base = createProjectFingerprint({
    runtimeId: "control-plane",
    workspaceRoot: "./workspace-admin",
    providerKind: "codex",
    channels: [{ kind: "telegram", id: "123" }],
  });

  const changedWorkspace = createProjectFingerprint({
    runtimeId: "control-plane",
    workspaceRoot: "./workspace-other",
    providerKind: "codex",
    channels: [{ kind: "telegram", id: "123" }],
  });

  assert.notEqual(base, changedWorkspace);
});
