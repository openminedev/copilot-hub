import assert from "node:assert/strict";
import test from "node:test";
import { AgentSupervisor } from "../dist/agent-supervisor.js";

function createSupervisor({ autoStart = true } = {}) {
  return new AgentSupervisor({
    botConfig: {
      id: "worker-a",
      name: "Worker A",
      enabled: true,
      autoStart,
      workspaceRoot: process.cwd(),
      dataDir: process.cwd(),
      provider: {
        kind: "codex",
        options: {
          sandboxMode: "workspace-write",
          approvalPolicy: "on-request",
          model: "gpt-5",
        },
      },
    },
    providerDefaults: {
      defaultKind: "codex",
    },
    turnActivityTimeoutMs: 60_000,
    maxMessages: 200,
    webPublicBaseUrl: "http://127.0.0.1:8787",
    workerScriptPath: process.execPath,
  });
}

test("setProviderOptions updates a live worker without forceRestart", async () => {
  const supervisor = createSupervisor();
  const calls = [];
  let forceRestartCalled = false;

  supervisor.child = { connected: true };
  supervisor.request = async (action, payload) => {
    calls.push({ action, payload });
    return {
      running: true,
      telegramRunning: true,
    };
  };
  supervisor.forceRestart = async () => {
    forceRestartCalled = true;
    return supervisor.getStatus();
  };

  const status = await supervisor.setProviderOptions({
    model: "gpt-5.4",
    reasoningEffort: "high",
    serviceTier: "fast",
    approvalPolicy: "on-failure",
  });

  assert.equal(forceRestartCalled, false);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].action, "setProviderOptions");
  assert.deepEqual(calls[0].payload, {
    sandboxMode: "workspace-write",
    approvalPolicy: "on-failure",
    model: "gpt-5.4",
    reasoningEffort: "high",
    serviceTier: "fast",
  });
  assert.equal(supervisor.config.provider.options.model, "gpt-5.4");
  assert.equal(supervisor.config.provider.options.reasoningEffort, "high");
  assert.equal(supervisor.config.provider.options.serviceTier, "fast");
  assert.equal(status.running, true);
  assert.equal(status.telegramRunning, true);
});

test("setProviderOptions updates config for stopped workers without spawning one", async () => {
  const supervisor = createSupervisor({ autoStart: false });
  let ensureWorkerCalled = false;
  let requestCalled = false;

  supervisor.ensureWorker = async () => {
    ensureWorkerCalled = true;
  };
  supervisor.request = async () => {
    requestCalled = true;
    return {};
  };

  const status = await supervisor.setProviderOptions({
    model: "auto",
    sandboxMode: "danger-full-access",
  });

  assert.equal(ensureWorkerCalled, false);
  assert.equal(requestCalled, false);
  assert.equal(status.running, false);
  assert.equal(
    Object.prototype.hasOwnProperty.call(supervisor.config.provider.options, "model"),
    false,
  );
  assert.equal(supervisor.config.provider.options.sandboxMode, "danger-full-access");
});

test("refreshProviderSession proxies the refresh request to a live worker", async () => {
  const supervisor = createSupervisor();
  const calls = [];

  supervisor.child = { connected: true };
  supervisor.request = async (action, payload) => {
    calls.push({ action, payload });
    return {
      running: true,
      telegramRunning: true,
    };
  };

  const status = await supervisor.refreshProviderSession("codex account switched");

  assert.equal(calls.length, 1);
  assert.equal(calls[0].action, "refreshProviderSession");
  assert.deepEqual(calls[0].payload, {
    reason: "codex account switched",
  });
  assert.equal(status.running, true);
  assert.equal(status.telegramRunning, true);
});
