import assert from "node:assert/strict";
import test from "node:test";
import { BotManager } from "../dist/bot-manager.js";

function createBotDefinition(id) {
  return {
    id,
    name: id,
    enabled: true,
    autoStart: true,
    workspaceRoot: process.cwd(),
    dataDir: process.cwd(),
    provider: {
      kind: "codex",
      options: {
        sandboxMode: "workspace-write",
        approvalPolicy: "on-request",
      },
    },
    channels: [],
    capabilities: [],
  };
}

test("startAutoBots continues when one bot fails to boot", async () => {
  const manager = new BotManager({
    botDefinitions: [createBotDefinition("broken"), createBotDefinition("healthy")],
    providerDefaults: {
      defaultKind: "codex",
    },
    turnActivityTimeoutMs: 60_000,
    maxMessages: 200,
    webPublicBaseUrl: "http://127.0.0.1:8787",
    projectsBaseDir: process.cwd(),
    workerScriptPath: process.execPath,
  });

  manager.startHeartbeatScheduler = () => {};

  const broken = manager.getBot("broken");
  const healthy = manager.getBot("healthy");
  let healthyBooted = false;

  broken.boot = async () => {
    throw new Error("sessions.json is invalid");
  };
  healthy.boot = async () => {
    healthyBooted = true;
  };

  await assert.doesNotReject(() => manager.startAutoBots());
  assert.equal(healthyBooted, true);
  assert.match(String(broken.getStatus().lastHeartbeatError ?? ""), /sessions\.json is invalid/i);
});
