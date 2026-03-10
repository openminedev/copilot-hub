import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { CONTROL_ACTIONS } from "../dist/control-plane-actions.js";
import { KernelControlPlane } from "../dist/kernel-control-plane.js";

async function withTempRegistry(agent, fn) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "copilot-hub-kernel-"));
  const registryFilePath = path.join(root, "bot-registry.json");
  const initialRegistry = {
    version: 3,
    agents: [agent],
  };
  await fs.writeFile(registryFilePath, `${JSON.stringify(initialRegistry, null, 2)}\n`, "utf8");

  try {
    return await fn({ root, registryFilePath, initialRegistry });
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

test("BOTS_SET_POLICY keeps existing model when no model override is provided", async () => {
  await withTempRegistry(
    {
      id: "worker-a",
      provider: {
        kind: "codex",
        options: {
          sandboxMode: "workspace-write",
          approvalPolicy: "on-request",
          model: "gpt-5",
        },
      },
    },
    async ({ registryFilePath }) => {
      const calls = [];
      const controlPlane = new KernelControlPlane({
        registryFilePath,
        botManager: {
          async setBotProviderOptions(botId, options) {
            calls.push({ botId, options });
            return { id: botId, provider: { kind: "codex", options } };
          },
        },
      });

      const result = await controlPlane.runSystemAction(CONTROL_ACTIONS.BOTS_SET_POLICY, {
        botId: "worker-a",
        sandboxMode: "danger-full-access",
        approvalPolicy: "never",
      });

      assert.equal(calls.length, 1);
      assert.equal(calls[0].botId, "worker-a");
      assert.equal(calls[0].options.sandboxMode, "danger-full-access");
      assert.equal(calls[0].options.approvalPolicy, "never");
      assert.equal(Object.prototype.hasOwnProperty.call(calls[0].options, "model"), false);
      assert.equal(result.policy.model, "gpt-5");

      const nextRegistry = JSON.parse(await fs.readFile(registryFilePath, "utf8"));
      const options = nextRegistry.agents[0].provider.options;
      assert.equal(options.sandboxMode, "danger-full-access");
      assert.equal(options.approvalPolicy, "never");
      assert.equal(options.model, "gpt-5");
    },
  );
});

test("BOTS_SET_POLICY applies and clears model override", async () => {
  await withTempRegistry(
    {
      id: "worker-b",
      provider: {
        kind: "codex",
        options: {
          sandboxMode: "workspace-write",
          approvalPolicy: "on-request",
        },
      },
    },
    async ({ registryFilePath }) => {
      const calls = [];
      const controlPlane = new KernelControlPlane({
        registryFilePath,
        botManager: {
          async setBotProviderOptions(botId, options) {
            calls.push({ botId, options });
            return { id: botId, provider: { kind: "codex", options } };
          },
        },
      });

      const setResult = await controlPlane.runSystemAction(CONTROL_ACTIONS.BOTS_SET_POLICY, {
        botId: "worker-b",
        sandboxMode: "workspace-write",
        approvalPolicy: "on-failure",
        model: "gpt-5.3-codex",
        reasoningEffort: "xhigh",
        serviceTier: "fast",
      });
      assert.equal(setResult.policy.model, "gpt-5.3-codex");
      assert.equal(setResult.policy.reasoningEffort, "xhigh");
      assert.equal(setResult.policy.serviceTier, "fast");
      assert.equal(calls[0].options.model, "gpt-5.3-codex");
      assert.equal(calls[0].options.reasoningEffort, "xhigh");
      assert.equal(calls[0].options.serviceTier, "fast");

      const clearResult = await controlPlane.runSystemAction(CONTROL_ACTIONS.BOTS_SET_POLICY, {
        botId: "worker-b",
        sandboxMode: "workspace-write",
        approvalPolicy: "on-failure",
        model: "auto",
        reasoningEffort: "default",
        serviceTier: "standard",
      });
      assert.equal(clearResult.policy.model, null);
      assert.equal(clearResult.policy.reasoningEffort, null);
      assert.equal(clearResult.policy.serviceTier, null);
      assert.equal(calls[1].options.model, null);
      assert.equal(calls[1].options.reasoningEffort, null);
      assert.equal(calls[1].options.serviceTier, null);

      const nextRegistry = JSON.parse(await fs.readFile(registryFilePath, "utf8"));
      const options = nextRegistry.agents[0].provider.options;
      assert.equal(options.sandboxMode, "workspace-write");
      assert.equal(options.approvalPolicy, "on-failure");
      assert.equal(Object.prototype.hasOwnProperty.call(options, "model"), false);
      assert.equal(Object.prototype.hasOwnProperty.call(options, "reasoningEffort"), false);
      assert.equal(Object.prototype.hasOwnProperty.call(options, "serviceTier"), false);
    },
  );
});

test("BOTS_SET_POLICY rolls back registry if runtime update fails", async () => {
  await withTempRegistry(
    {
      id: "worker-c",
      provider: {
        kind: "codex",
        options: {
          sandboxMode: "read-only",
          approvalPolicy: "on-request",
          model: "gpt-5",
        },
      },
    },
    async ({ registryFilePath, initialRegistry }) => {
      const controlPlane = new KernelControlPlane({
        registryFilePath,
        botManager: {
          async setBotProviderOptions() {
            throw new Error("runtime unavailable");
          },
        },
      });

      await assert.rejects(
        () =>
          controlPlane.runSystemAction(CONTROL_ACTIONS.BOTS_SET_POLICY, {
            botId: "worker-c",
            sandboxMode: "danger-full-access",
            approvalPolicy: "never",
            model: "gpt-5.3-codex",
          }),
        /runtime unavailable/,
      );

      const finalRegistry = JSON.parse(await fs.readFile(registryFilePath, "utf8"));
      assert.deepEqual(finalRegistry, initialRegistry);
    },
  );
});

test("BOTS_SET_POLICY mutations are serialized to avoid overlapping registry writes", async () => {
  await withTempRegistry(
    {
      id: "worker-d",
      provider: {
        kind: "codex",
        options: {
          sandboxMode: "workspace-write",
          approvalPolicy: "on-request",
        },
      },
    },
    async ({ registryFilePath }) => {
      const calls = [];
      let releaseFirstCall = null;
      const firstCallBlocked = new Promise((resolve) => {
        releaseFirstCall = resolve;
      });

      const controlPlane = new KernelControlPlane({
        registryFilePath,
        botManager: {
          async setBotProviderOptions(botId, options) {
            calls.push({ botId, options });
            if (calls.length === 1) {
              await firstCallBlocked;
            }
            return { id: botId, provider: { kind: "codex", options } };
          },
        },
      });

      const first = controlPlane.runSystemAction(CONTROL_ACTIONS.BOTS_SET_POLICY, {
        botId: "worker-d",
        sandboxMode: "workspace-write",
        approvalPolicy: "on-failure",
      });
      await new Promise((resolve) => setTimeout(resolve, 10));

      const second = controlPlane.runSystemAction(CONTROL_ACTIONS.BOTS_SET_POLICY, {
        botId: "worker-d",
        sandboxMode: "danger-full-access",
        approvalPolicy: "never",
      });
      await new Promise((resolve) => setTimeout(resolve, 10));

      assert.equal(calls.length, 1);
      releaseFirstCall();

      await Promise.all([first, second]);
      assert.equal(calls.length, 2);

      const nextRegistry = JSON.parse(await fs.readFile(registryFilePath, "utf8"));
      const options = nextRegistry.agents[0].provider.options;
      assert.equal(options.sandboxMode, "danger-full-access");
      assert.equal(options.approvalPolicy, "never");
    },
  );
});
