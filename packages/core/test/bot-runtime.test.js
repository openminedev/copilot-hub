import assert from "node:assert/strict";
import test from "node:test";
import { BotRuntime } from "../dist/bot-runtime.js";

function createRuntimeForTurnFailureTests() {
  const runtime = new BotRuntime({
    botConfig: {
      id: "bot-runtime-test",
      name: "Bot Runtime Test",
      enabled: true,
      autoStart: false,
      workspaceRoot: process.cwd(),
      dataDir: process.cwd(),
      threadMode: "single",
      sharedThreadId: "thread:runtime-test",
      provider: {
        kind: "codex",
        options: {},
      },
      channels: [],
      capabilities: [],
    },
    providerDefaults: {
      defaultKind: "codex",
    },
    turnActivityTimeoutMs: 0,
    maxMessages: 200,
  });

  runtime.ensureInitialized = async () => {};
  runtime.store = {
    async ensureThread() {
      return {
        sessionId: null,
        turnCount: 0,
        messages: [],
      };
    },
  };
  runtime.capabilityManager = {
    async transformTurnInput(input) {
      return input;
    },
    async runHook() {},
    getStatus() {
      return [];
    },
    async notifyApprovalRequested() {},
    async reload() {},
    async shutdown() {},
  };

  return runtime;
}

test("BotRuntime recreates the provider session after an inactive turn error", async () => {
  const runtime = createRuntimeForTurnFailureTests();
  let shutdownCount = 0;

  const previousEngine = {
    async sendTurn() {
      throw new Error("Turn 019_integration inactive for 3600000ms.");
    },
    async shutdown() {
      shutdownCount += 1;
    },
  };

  runtime.engine = previousEngine;
  runtime.provider = {
    async shutdown() {
      throw new Error("provider shutdown should not be used when engine exists");
    },
  };

  await assert.rejects(
    runtime.sendTurn({
      threadId: "thread:runtime-test",
      prompt: "hello",
    }),
    /inactive for 3600000ms/i,
  );

  assert.equal(shutdownCount, 1);
  assert.notEqual(runtime.engine, previousEngine);
  assert.ok(runtime.engine);
  assert.ok(runtime.provider);
});

test("BotRuntime keeps the provider session when the turn error is not recoverable", async () => {
  const runtime = createRuntimeForTurnFailureTests();
  let shutdownCount = 0;

  const previousEngine = {
    async sendTurn() {
      throw new Error("quota limit reached");
    },
    async shutdown() {
      shutdownCount += 1;
    },
  };

  runtime.engine = previousEngine;
  runtime.provider = {
    async shutdown() {},
  };

  await assert.rejects(
    runtime.sendTurn({
      threadId: "thread:runtime-test",
      prompt: "hello",
    }),
    /quota limit reached/i,
  );

  assert.equal(shutdownCount, 0);
  assert.equal(runtime.engine, previousEngine);
});
