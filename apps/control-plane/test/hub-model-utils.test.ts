import assert from "node:assert/strict";
import test from "node:test";

const BOT_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
let utilsPromise: Promise<any> | null = null;

async function loadUtils() {
  if (!utilsPromise) {
    const specifier = ["..", "channels", "hub-model-utils.js"].join("/");
    utilsPromise = import(specifier);
  }
  return utilsPromise;
}

test("parseSetModelCommand accepts explicit model and auto keyword", async () => {
  const { parseSetModelCommand } = await loadUtils();
  const modelResult = parseSetModelCommand("/set_model agent_a gpt-5.3-codex", BOT_ID_PATTERN);
  assert.equal(modelResult.ok, true);
  assert.equal(modelResult.botId, "agent_a");
  assert.equal(modelResult.model, "gpt-5.3-codex");

  const autoResult = parseSetModelCommand("/set_model agent_a auto", BOT_ID_PATTERN);
  assert.equal(autoResult.ok, true);
  assert.equal(autoResult.botId, "agent_a");
  assert.equal(autoResult.model, null);
});

test("parseSetModelAllCommand accepts explicit model and auto keyword", async () => {
  const { parseSetModelAllCommand } = await loadUtils();
  const modelResult = parseSetModelAllCommand("/set_model_all gpt-5.3-codex");
  assert.equal(modelResult.ok, true);
  assert.equal(modelResult.model, "gpt-5.3-codex");

  const autoResult = parseSetModelAllCommand("/set_model_all auto");
  assert.equal(autoResult.ok, true);
  assert.equal(autoResult.model, null);
});

test("parseSetModelCommand rejects invalid command input", async () => {
  const { parseSetModelAllCommand, parseSetModelCommand } = await loadUtils();
  const invalidId = parseSetModelCommand("/set_model bad*id gpt-5", BOT_ID_PATTERN);
  assert.equal(invalidId.ok, false);

  const invalidModel = parseSetModelCommand("/set_model agent_a bad/model", BOT_ID_PATTERN);
  assert.equal(invalidModel.ok, false);

  const missingModel = parseSetModelAllCommand("/set_model_all");
  assert.equal(missingModel.ok, false);

  const invalidGlobalModel = parseSetModelAllCommand("/set_model_all bad/model");
  assert.equal(invalidGlobalModel.ok, false);
});

test("buildSessionModelOptions de-duplicates and marks selected model", async () => {
  const { buildSessionModelOptions } = await loadUtils();
  const options = buildSessionModelOptions({
    currentModel: "gpt-5",
    catalog: [
      { model: "gpt-4.1", displayName: "GPT-4.1" },
      { model: "gpt-5", displayName: "GPT-5" },
      { model: "gpt-5", displayName: "GPT-5 duplicate" },
    ],
    inlineMax: 10,
  });

  assert.equal(options.length, 2);
  assert.equal(options[0].model, "gpt-5");
  assert.equal(options[0].selected, true);
  assert.equal(options[1].model, "gpt-4.1");
  assert.equal(options[1].selected, false);
});

test("resolveModelSelectionFromAction resolves auto and keyed entries", async () => {
  const { resolveModelSelectionFromAction } = await loadUtils();
  const session = {
    modelOptions: [
      { key: "k0", model: "gpt-5", label: "GPT-5" },
      { key: "k1", model: "gpt-4.1", label: "GPT-4.1" },
    ],
  };

  const autoSelection = resolveModelSelectionFromAction({ session, profileId: "auto" });
  assert.equal(autoSelection.ok, true);
  assert.equal(autoSelection.model, null);

  const explicitSelection = resolveModelSelectionFromAction({ session, profileId: "k1" });
  assert.equal(explicitSelection.ok, true);
  assert.equal(explicitSelection.model, "gpt-4.1");
  assert.equal(explicitSelection.label, "GPT-4.1");
});

test("fetchCodexModelOptions normalizes model catalog from API", async () => {
  const { fetchCodexModelOptions } = await loadUtils();
  const result = await fetchCodexModelOptions(async () => ({
    models: [
      { id: "model-a", model: "gpt-5", displayName: "GPT-5", isDefault: true },
      { id: "model-b", model: "gpt-5", displayName: "Duplicate" },
      { id: "model-c", model: "gpt-4.1", displayName: "GPT-4.1" },
    ],
  }));

  assert.equal(result.available, true);
  assert.equal(result.models.length, 2);
  assert.deepEqual(result.models[0], {
    model: "gpt-5",
    displayName: "GPT-5",
    isDefault: true,
  });
});

test("policy resolvers keep safe defaults", async () => {
  const {
    applyBotModelPolicy,
    applyModelPolicyToBots,
    applyRuntimeModelPolicy,
    getRuntimeModel,
    getBotPolicyState,
    resolveSharedModel,
    resolveApprovalPolicy,
    resolveSandboxMode,
  } = await loadUtils();
  assert.equal(resolveSandboxMode("read-only"), "read-only");
  assert.equal(resolveSandboxMode("invalid"), "danger-full-access");
  assert.equal(resolveApprovalPolicy("on-request"), "on-request");
  assert.equal(resolveApprovalPolicy("invalid"), "never");

  assert.deepEqual(
    getBotPolicyState({
      provider: {
        options: {
          sandboxMode: "workspace-write",
          approvalPolicy: "on-failure",
        },
      },
    }),
    {
      sandboxMode: "workspace-write",
      approvalPolicy: "on-failure",
    },
  );

  let capturedPath = "";
  let capturedPayload: unknown = null;
  await applyBotModelPolicy({
    apiPost: async (path: string, payload: unknown) => {
      capturedPath = path;
      capturedPayload = payload;
      return { ok: true };
    },
    botId: "worker-a",
    botState: {
      provider: {
        options: {
          sandboxMode: "read-only",
          approvalPolicy: "on-request",
        },
      },
    },
    model: "gpt-5",
  });
  assert.equal(capturedPath, "/api/bots/worker-a/policy");
  assert.deepEqual(capturedPayload, {
    sandboxMode: "read-only",
    approvalPolicy: "on-request",
    model: "gpt-5",
  });

  const posted: Array<{ path: string; payload: unknown }> = [];
  const batchResult = await applyModelPolicyToBots({
    apiPost: async (path: string, payload: unknown) => {
      posted.push({ path, payload });
      if (path.endsWith("/worker-b/policy")) {
        throw new Error("restart failed");
      }
      return { ok: true };
    },
    bots: [
      {
        id: "worker-a",
        provider: {
          options: {
            sandboxMode: "read-only",
            approvalPolicy: "on-request",
          },
        },
      },
      {
        id: "worker-b",
        provider: {
          options: {
            sandboxMode: "workspace-write",
            approvalPolicy: "on-failure",
          },
        },
      },
    ],
    model: null,
  });
  assert.deepEqual(batchResult.updatedBotIds, ["worker-a"]);
  assert.equal(batchResult.failures.length, 1);
  assert.equal(batchResult.failures[0].botId, "worker-b");
  assert.equal(posted.length, 2);

  assert.equal(
    getRuntimeModel({
      getProviderOptions: () => ({
        model: "gpt-5",
      }),
    }),
    "gpt-5",
  );

  let runtimePayload: unknown = null;
  await applyRuntimeModelPolicy({
    runtime: {
      setProviderOptions: async (payload: Record<string, unknown>) => {
        runtimePayload = payload;
      },
    },
    model: null,
  });
  assert.deepEqual(runtimePayload, {
    model: null,
  });

  assert.deepEqual(resolveSharedModel(["gpt-5", "gpt-5", "gpt-5"]), {
    mode: "uniform",
    model: "gpt-5",
  });
  assert.deepEqual(resolveSharedModel(["gpt-5", null]), {
    mode: "mixed",
  });
});
