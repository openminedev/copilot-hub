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
      {
        key: "k0",
        model: "gpt-5",
        label: "GPT-5",
        supportedReasoningEfforts: [],
        defaultReasoningEffort: null,
      },
      {
        key: "k1",
        model: "gpt-4.1",
        label: "GPT-4.1",
        supportedReasoningEfforts: [],
        defaultReasoningEffort: null,
      },
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
      {
        id: "model-a",
        model: "gpt-5",
        displayName: "GPT-5",
        isDefault: true,
        supportedReasoningEfforts: [{ reasoningEffort: "high", description: "Deep reasoning" }],
        defaultReasoningEffort: "medium",
      },
      { id: "model-b", model: "gpt-5", displayName: "Duplicate" },
      { id: "model-c", model: "gpt-4.1", displayName: "GPT-4.1" },
    ],
  }));

  assert.equal(result.available, true);
  assert.equal(result.models.length, 2);
  assert.deepEqual(result.models[0], {
    model: "gpt-5",
    displayName: "GPT-5",
    description: "",
    isDefault: true,
    supportedReasoningEfforts: [{ reasoningEffort: "high", description: "Deep reasoning" }],
    defaultReasoningEffort: "medium",
  });
});

test("provider helpers normalize selections and preserve policy defaults", async () => {
  const {
    applyBotProviderPolicy,
    applyProviderPolicyToBots,
    applyRuntimeProviderPolicy,
    buildReasoningOptionsForModel,
    formatFastModeLabel,
    formatReasoningLabel,
    getBotPolicyState,
    getBotProviderSelection,
    getRuntimeProviderSelection,
    resolveSharedModel,
    resolveSharedReasoningEffort,
    resolveSharedServiceTier,
    resolveReasoningSelectionFromAction,
    resolveApprovalPolicy,
    resolveSandboxMode,
  } = await loadUtils();

  assert.equal(resolveSandboxMode("read-only"), "read-only");
  assert.equal(resolveSandboxMode("invalid"), "danger-full-access");
  assert.equal(resolveApprovalPolicy("on-request"), "on-request");
  assert.equal(resolveApprovalPolicy("invalid"), "never");
  assert.equal(formatReasoningLabel("xhigh"), "Extra High");
  assert.equal(formatFastModeLabel("fast"), "Fast");
  assert.equal(formatFastModeLabel("flex"), "Flex (manual)");
  assert.equal(formatFastModeLabel(null), "Standard");

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

  assert.deepEqual(
    getBotProviderSelection({
      provider: {
        options: {
          model: "gpt-5.4",
          reasoningEffort: "high",
          serviceTier: "fast",
        },
      },
    }),
    {
      model: "gpt-5.4",
      reasoningEffort: "high",
      serviceTier: "fast",
    },
  );

  let capturedPath = "";
  let capturedPayload: unknown = null;
  await applyBotProviderPolicy({
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
    patch: {
      model: "gpt-5",
      reasoningEffort: "medium",
      serviceTier: "fast",
    },
  });
  assert.equal(capturedPath, "/api/bots/worker-a/policy");
  assert.deepEqual(capturedPayload, {
    sandboxMode: "read-only",
    approvalPolicy: "on-request",
    model: "gpt-5",
    reasoningEffort: "medium",
    serviceTier: "fast",
  });

  const posted: Array<{ path: string; payload: unknown }> = [];
  const batchResult = await applyProviderPolicyToBots({
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
    patch: {
      model: null,
      reasoningEffort: null,
    },
  });
  assert.deepEqual(batchResult.updatedBotIds, ["worker-a"]);
  assert.equal(batchResult.failures.length, 1);
  assert.equal(batchResult.failures[0].botId, "worker-b");
  assert.equal(posted.length, 2);

  assert.deepEqual(
    getRuntimeProviderSelection({
      getProviderOptions: () => ({
        model: "gpt-5",
        reasoningEffort: "xhigh",
        serviceTier: "fast",
      }),
    }),
    {
      model: "gpt-5",
      reasoningEffort: "xhigh",
      serviceTier: "fast",
    },
  );

  let runtimePayload: unknown = null;
  await applyRuntimeProviderPolicy({
    runtime: {
      setProviderOptions: async (payload: Record<string, unknown>) => {
        runtimePayload = payload;
      },
    },
    patch: {
      model: null,
      reasoningEffort: "low",
      serviceTier: null,
    },
  });
  assert.deepEqual(runtimePayload, {
    model: null,
    reasoningEffort: "low",
    serviceTier: null,
  });

  assert.deepEqual(resolveSharedModel(["gpt-5", "gpt-5", "gpt-5"]), {
    mode: "uniform",
    model: "gpt-5",
  });
  assert.deepEqual(resolveSharedModel(["gpt-5", null]), {
    mode: "mixed",
  });
  assert.deepEqual(resolveSharedReasoningEffort(["high", "high"]), {
    mode: "uniform",
    reasoningEffort: "high",
  });
  assert.deepEqual(resolveSharedReasoningEffort(["high", null]), {
    mode: "mixed",
  });
  assert.deepEqual(resolveSharedServiceTier(["fast", "fast"]), {
    mode: "uniform",
    serviceTier: "fast",
  });
  assert.deepEqual(resolveSharedServiceTier(["fast", null]), {
    mode: "mixed",
  });

  const reasoningOptions = buildReasoningOptionsForModel({
    modelSelection: {
      ok: true,
      key: "k0",
      model: "gpt-5.4",
      label: "GPT-5.4",
      supportedReasoningEfforts: [
        { reasoningEffort: "low", description: "Fast responses" },
        { reasoningEffort: "xhigh", description: "Deepest reasoning" },
      ],
      defaultReasoningEffort: "medium",
    },
    currentModel: "gpt-5.4",
    currentReasoningEffort: "xhigh",
  });
  assert.equal(reasoningOptions.length, 3);
  assert.equal(reasoningOptions[2].selected, true);

  const reasoningSelection = resolveReasoningSelectionFromAction({
    options: reasoningOptions,
    profileId: reasoningOptions[1].key,
  });
  assert.equal(reasoningSelection.ok, true);
  assert.equal(reasoningSelection.reasoningEffort, "low");
});
