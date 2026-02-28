import assert from "node:assert/strict";
import test from "node:test";
import { createProjectFingerprint } from "@copilot-hub/core/project-fingerprint";

test("createProjectFingerprint is stable and order-independent for channels", () => {
  const a = createProjectFingerprint({
    runtimeId: "agent-a",
    workspaceRoot: "./workspace-a",
    providerKind: "CODEX",
    channels: [
      { kind: "telegram", id: "123" },
      { kind: "whatsapp", id: "abc" },
    ],
  });

  const b = createProjectFingerprint({
    runtimeId: "agent-a",
    workspaceRoot: "./workspace-a",
    providerKind: "codex",
    channels: [
      { kind: "whatsapp", id: "abc" },
      { kind: "telegram", id: "123" },
    ],
  });

  assert.equal(a, b);
  assert.match(a, /^[a-f0-9]{24}$/);
});

test("createProjectFingerprint changes when stable inputs differ", () => {
  const base = createProjectFingerprint({
    runtimeId: "agent-a",
    workspaceRoot: "./workspace-a",
    providerKind: "codex",
    channels: [{ kind: "telegram", id: "123" }],
  });

  const changedProvider = createProjectFingerprint({
    runtimeId: "agent-a",
    workspaceRoot: "./workspace-a",
    providerKind: "other",
    channels: [{ kind: "telegram", id: "123" }],
  });

  assert.notEqual(base, changedProvider);
});
