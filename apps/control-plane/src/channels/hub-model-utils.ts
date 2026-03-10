const MODEL_INLINE_MAX = 24;
const MODEL_PATTERN = /^[A-Za-z0-9._:-]+$/;

type ReasoningEffort = "none" | "minimal" | "low" | "medium" | "high" | "xhigh";
type ServiceTier = "fast" | "flex";

export type ModelSelectionOption = {
  key: string;
  model: string;
  label: string;
  isDefault: boolean;
  selected?: boolean;
  supportedReasoningEfforts: Array<{
    reasoningEffort: ReasoningEffort;
    description: string;
  }>;
  defaultReasoningEffort: ReasoningEffort | null;
};

export type ReasoningSelectionOption = {
  key: string;
  reasoningEffort: ReasoningEffort | null;
  label: string;
  description: string;
  selected?: boolean;
};

type SetModelCommandInvalid = {
  ok: false;
  error: string;
};

type SetModelAllCommandValid = {
  ok: true;
  model: string | null;
};

type SetModelCommandValid = {
  ok: true;
  botId: string;
  model: string | null;
};

type SetModelAllCommandResult = SetModelCommandInvalid | SetModelAllCommandValid;
type SetModelCommandResult = SetModelCommandInvalid | SetModelCommandValid;

type SessionModelSelection = {
  modelOptions?: ModelSelectionOption[];
} | null;

export type ModelSelectionResult =
  | {
      ok: false;
      key: "";
      model: null;
      label: "";
      supportedReasoningEfforts: [];
      defaultReasoningEffort: null;
    }
  | {
      ok: true;
      key: string;
      model: string | null;
      label: string;
      supportedReasoningEfforts: Array<{
        reasoningEffort: ReasoningEffort;
        description: string;
      }>;
      defaultReasoningEffort: ReasoningEffort | null;
    };

export type ReasoningSelectionResult =
  | {
      ok: false;
      reasoningEffort: null;
      label: "";
    }
  | {
      ok: true;
      reasoningEffort: ReasoningEffort | null;
      label: string;
    };

type ApiGetFn = (path: string) => Promise<unknown>;
type ApiPostFn = (path: string, payload: unknown) => Promise<unknown>;

export type ModelCatalogItem = {
  model: string;
  displayName: string;
  description: string;
  isDefault: boolean;
  supportedReasoningEfforts: Array<{
    reasoningEffort: ReasoningEffort;
    description: string;
  }>;
  defaultReasoningEffort: ReasoningEffort | null;
};

type ModelCatalogResult = {
  available: boolean;
  models: ModelCatalogItem[];
};

type BotPolicyState = {
  sandboxMode: "read-only" | "workspace-write" | "danger-full-access";
  approvalPolicy: "on-request" | "on-failure" | "never";
};

export type ProviderSelectionState = {
  model: string | null;
  reasoningEffort: ReasoningEffort | null;
  serviceTier: ServiceTier | null;
};

export type ProviderPolicyPatch = {
  model?: string | null;
  reasoningEffort?: ReasoningEffort | null;
  serviceTier?: ServiceTier | null;
};

type RuntimeProviderControl = {
  getProviderOptions?: () => unknown;
  setProviderOptions?: (payload: Record<string, unknown>) => Promise<unknown>;
} | null;

export function parseSetModelCommand(text: unknown, botIdPattern: RegExp): SetModelCommandResult {
  const tokens = String(text ?? "")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (tokens.length < 3) {
    return {
      ok: false,
      error:
        "Usage: /set_model <agent_id> <model|auto>\nExample: /set_model my_agent gpt-5.3-codex",
    };
  }

  const botId = String(tokens[1] ?? "").trim();
  if (!botIdPattern.test(botId)) {
    return {
      ok: false,
      error: "Invalid agent id format.",
    };
  }

  const modelToken = String(tokens.slice(2).join(" ") ?? "").trim();
  if (!modelToken) {
    return {
      ok: false,
      error: "Model is required. Use a model id or 'auto'.",
    };
  }

  const normalizedKeyword = modelToken.toLowerCase();
  if (normalizedKeyword === "auto" || normalizedKeyword === "default") {
    return {
      ok: true,
      botId,
      model: null,
    };
  }

  if (modelToken.length > 120 || !MODEL_PATTERN.test(modelToken)) {
    return {
      ok: false,
      error: "Invalid model format.",
    };
  }

  return {
    ok: true,
    botId,
    model: modelToken,
  };
}

export function parseSetModelAllCommand(text: unknown): SetModelAllCommandResult {
  const tokens = String(text ?? "")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (tokens.length < 2) {
    return {
      ok: false,
      error: "Usage: /set_model_all <model|auto>\nExample: /set_model_all gpt-5.3-codex",
    };
  }

  const modelToken = String(tokens.slice(1).join(" ") ?? "").trim();
  if (!modelToken) {
    return {
      ok: false,
      error: "Model is required. Use a model id or 'auto'.",
    };
  }

  const normalizedKeyword = modelToken.toLowerCase();
  if (normalizedKeyword === "auto" || normalizedKeyword === "default") {
    return {
      ok: true,
      model: null,
    };
  }

  if (modelToken.length > 120 || !MODEL_PATTERN.test(modelToken)) {
    return {
      ok: false,
      error: "Invalid model format.",
    };
  }

  return {
    ok: true,
    model: modelToken,
  };
}

export function formatModelLabel(value: unknown): string {
  const model = String(value ?? "").trim();
  if (!model) {
    return "auto (workspace default)";
  }
  return model;
}

export function formatReasoningLabel(value: unknown): string {
  const reasoningEffort = normalizeReasoningEffortValue(value);
  if (!reasoningEffort) {
    return "Default";
  }
  switch (reasoningEffort) {
    case "xhigh":
      return "Extra High";
    case "none":
      return "None";
    default:
      return reasoningEffort.charAt(0).toUpperCase() + reasoningEffort.slice(1);
  }
}

export function formatFastModeLabel(value: unknown): string {
  const serviceTier = normalizeServiceTierValue(value);
  if (serviceTier === "fast") {
    return "Fast";
  }
  if (serviceTier === "flex") {
    return "Flex (manual)";
  }
  return "Standard";
}

export function formatModelButtonText(label: unknown, selected: boolean): string {
  const text = String(label ?? "").trim() || "Model";
  return selected ? `* ${text}` : text;
}

export function buildSessionModelOptions({
  catalog,
  currentModel,
  inlineMax = MODEL_INLINE_MAX,
}: {
  catalog: unknown;
  currentModel: unknown;
  inlineMax?: number;
}): ModelSelectionOption[] {
  const normalizedCurrent = String(currentModel ?? "")
    .trim()
    .toLowerCase();
  const options: ModelSelectionOption[] = [];
  const seen = new Set<string>();

  for (const entry of Array.isArray(catalog) ? catalog : []) {
    if (!isObject(entry)) {
      continue;
    }
    const model = String(entry.model ?? "").trim();
    if (!model) {
      continue;
    }
    const key = model.toLowerCase();
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    options.push({
      key: `k${options.length}`,
      model,
      label: String(entry.displayName ?? model).trim() || model,
      isDefault: entry.isDefault === true,
      selected: normalizedCurrent === key,
      supportedReasoningEfforts: normalizeReasoningCatalog(entry.supportedReasoningEfforts),
      defaultReasoningEffort: normalizeReasoningEffortValue(entry.defaultReasoningEffort),
    });
  }

  options.sort((a, b) => {
    const aSelected = a.selected === true;
    const bSelected = b.selected === true;
    if (aSelected !== bSelected) {
      return aSelected ? -1 : 1;
    }
    if (a.isDefault !== b.isDefault) {
      return a.isDefault ? -1 : 1;
    }
    return a.label.localeCompare(b.label);
  });

  const limit = Number.isFinite(inlineMax) ? Math.max(1, Math.floor(inlineMax)) : MODEL_INLINE_MAX;
  return options.slice(0, limit).map((entry, index) => ({
    ...entry,
    key: `k${index}`,
  }));
}

export function buildReasoningOptionsForModel({
  modelSelection,
  currentModel,
  currentReasoningEffort,
}: {
  modelSelection: ModelSelectionResult;
  currentModel?: unknown;
  currentReasoningEffort?: unknown;
}): ReasoningSelectionOption[] {
  if (!modelSelection.ok || !modelSelection.model) {
    return [
      {
        key: "default",
        reasoningEffort: null,
        label: "Default",
        description: "Use the default reasoning level for the resolved model.",
        selected: true,
      },
    ];
  }

  const selectedModel = String(modelSelection.model).trim().toLowerCase();
  const normalizedCurrentModel = String(currentModel ?? "")
    .trim()
    .toLowerCase();
  const normalizedCurrentReasoning = normalizeReasoningEffortValue(currentReasoningEffort);
  const selectedReasoning =
    selectedModel === normalizedCurrentModel ? normalizedCurrentReasoning : null;

  const options: ReasoningSelectionOption[] = [
    {
      key: "default",
      reasoningEffort: null,
      label: "Default",
      description:
        modelSelection.defaultReasoningEffort !== null
          ? `Use ${formatReasoningLabel(modelSelection.defaultReasoningEffort)} for this model.`
          : "Use the model default reasoning level.",
      selected: selectedReasoning === null,
    },
  ];

  for (const entry of modelSelection.supportedReasoningEfforts) {
    options.push({
      key: `r${options.length - 1}`,
      reasoningEffort: entry.reasoningEffort,
      label: formatReasoningLabel(entry.reasoningEffort),
      description:
        String(entry.description ?? "").trim() ||
        `${formatReasoningLabel(entry.reasoningEffort)} reasoning effort.`,
      selected: selectedReasoning === entry.reasoningEffort,
    });
  }

  return options;
}

export function resolveModelSelectionFromAction({
  session,
  profileId,
}: {
  session: SessionModelSelection;
  profileId: unknown;
}): ModelSelectionResult {
  const target = String(profileId ?? "")
    .trim()
    .toLowerCase();
  if (!target) {
    return {
      ok: false,
      key: "",
      model: null,
      label: "",
      supportedReasoningEfforts: [],
      defaultReasoningEffort: null,
    };
  }

  if (target === "auto") {
    return {
      ok: true,
      key: "auto",
      model: null,
      label: "Auto (workspace default)",
      supportedReasoningEfforts: [],
      defaultReasoningEffort: null,
    };
  }

  const options = Array.isArray(session?.modelOptions) ? session.modelOptions : [];
  const matched = options.find(
    (entry) =>
      String(entry?.key ?? "")
        .trim()
        .toLowerCase() === target,
  );
  if (!matched) {
    return {
      ok: false,
      key: "",
      model: null,
      label: "",
      supportedReasoningEfforts: [],
      defaultReasoningEffort: null,
    };
  }

  return {
    ok: true,
    key: matched.key,
    model: String(matched.model ?? "").trim() || null,
    label: String(matched.label ?? matched.model ?? "custom").trim(),
    supportedReasoningEfforts: matched.supportedReasoningEfforts,
    defaultReasoningEffort: matched.defaultReasoningEffort,
  };
}

export function resolveReasoningSelectionFromAction({
  options,
  profileId,
}: {
  options: ReasoningSelectionOption[];
  profileId: unknown;
}): ReasoningSelectionResult {
  const target = String(profileId ?? "")
    .trim()
    .toLowerCase();
  if (!target) {
    return {
      ok: false,
      reasoningEffort: null,
      label: "",
    };
  }

  const matched = options.find(
    (entry) =>
      String(entry?.key ?? "")
        .trim()
        .toLowerCase() === target,
  );
  if (!matched) {
    return {
      ok: false,
      reasoningEffort: null,
      label: "",
    };
  }

  return {
    ok: true,
    reasoningEffort: matched.reasoningEffort,
    label: matched.label,
  };
}

export async function fetchCodexModelOptions(apiGet: ApiGetFn): Promise<ModelCatalogResult> {
  try {
    const payload = await apiGet("/api/system/codex/models");
    const rawModels = isObject(payload) && Array.isArray(payload.models) ? payload.models : [];
    const seen = new Set<string>();
    const models: ModelCatalogItem[] = [];
    for (const entry of rawModels) {
      if (!isObject(entry)) {
        continue;
      }
      const model = String(entry.model ?? entry.id ?? "").trim();
      if (!model) {
        continue;
      }
      const key = model.toLowerCase();
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      models.push({
        model,
        displayName: String(entry.displayName ?? model).trim() || model,
        description: String(entry.description ?? "").trim(),
        isDefault: entry.isDefault === true,
        supportedReasoningEfforts: normalizeReasoningCatalog(entry.supportedReasoningEfforts),
        defaultReasoningEffort: normalizeReasoningEffortValue(entry.defaultReasoningEffort),
      });
    }

    return {
      available: true,
      models,
    };
  } catch {
    return {
      available: false,
      models: [],
    };
  }
}

export function resolveSandboxMode(
  value: unknown,
): "read-only" | "workspace-write" | "danger-full-access" {
  const mode = String(value ?? "")
    .trim()
    .toLowerCase();
  if (mode === "read-only" || mode === "workspace-write" || mode === "danger-full-access") {
    return mode;
  }
  return "danger-full-access";
}

export function resolveApprovalPolicy(value: unknown): "on-request" | "on-failure" | "never" {
  const mode = String(value ?? "")
    .trim()
    .toLowerCase();
  if (mode === "on-request" || mode === "on-failure" || mode === "never") {
    return mode;
  }
  return "never";
}

export function getBotPolicyState(botState: unknown): BotPolicyState {
  const provider = isObject(botState) && isObject(botState.provider) ? botState.provider : null;
  const options = provider && isObject(provider.options) ? provider.options : {};
  return {
    sandboxMode: resolveSandboxMode(options.sandboxMode),
    approvalPolicy: resolveApprovalPolicy(options.approvalPolicy),
  };
}

export function getBotProviderSelection(botState: unknown): ProviderSelectionState {
  const provider = isObject(botState) && isObject(botState.provider) ? botState.provider : null;
  const options = provider && isObject(provider.options) ? provider.options : {};
  return {
    model: normalizeModelValue(options.model),
    reasoningEffort: normalizeReasoningEffortValue(options.reasoningEffort),
    serviceTier: normalizeServiceTierValue(options.serviceTier),
  };
}

export function getRuntimeProviderSelection(
  runtime: RuntimeProviderControl | undefined,
): ProviderSelectionState {
  if (!runtime || typeof runtime.getProviderOptions !== "function") {
    return {
      model: null,
      reasoningEffort: null,
      serviceTier: null,
    };
  }

  const options = runtime.getProviderOptions();
  const record = isObject(options) ? options : {};
  return {
    model: normalizeModelValue(record.model),
    reasoningEffort: normalizeReasoningEffortValue(record.reasoningEffort),
    serviceTier: normalizeServiceTierValue(record.serviceTier),
  };
}

export async function applyBotProviderPolicy({
  apiPost,
  botId,
  botState,
  patch,
}: {
  apiPost: ApiPostFn;
  botId: string;
  botState: unknown;
  patch: ProviderPolicyPatch;
}): Promise<unknown> {
  const policyState = getBotPolicyState(botState);
  const payload: Record<string, unknown> = {
    sandboxMode: policyState.sandboxMode,
    approvalPolicy: policyState.approvalPolicy,
  };

  if (Object.prototype.hasOwnProperty.call(patch, "model")) {
    payload.model = patch.model ?? null;
  }
  if (Object.prototype.hasOwnProperty.call(patch, "reasoningEffort")) {
    payload.reasoningEffort = patch.reasoningEffort ?? null;
  }
  if (Object.prototype.hasOwnProperty.call(patch, "serviceTier")) {
    payload.serviceTier = patch.serviceTier ?? null;
  }

  return apiPost(`/api/bots/${encodeURIComponent(botId)}/policy`, payload);
}

export async function applyRuntimeProviderPolicy({
  runtime,
  patch,
}: {
  runtime: RuntimeProviderControl | undefined;
  patch: ProviderPolicyPatch;
}): Promise<void> {
  if (!runtime || typeof runtime.setProviderOptions !== "function") {
    throw new Error("Hub provider update is not available on this runtime.");
  }

  const payload: Record<string, unknown> = {};
  if (Object.prototype.hasOwnProperty.call(patch, "model")) {
    payload.model = patch.model ?? null;
  }
  if (Object.prototype.hasOwnProperty.call(patch, "reasoningEffort")) {
    payload.reasoningEffort = patch.reasoningEffort ?? null;
  }
  if (Object.prototype.hasOwnProperty.call(patch, "serviceTier")) {
    payload.serviceTier = patch.serviceTier ?? null;
  }

  await runtime.setProviderOptions(payload);
}

export function resolveSharedModel(
  models: unknown,
): { mode: "uniform"; model: string | null } | { mode: "mixed" } {
  let normalizedModel: string | null | undefined;

  for (const entry of Array.isArray(models) ? models : []) {
    const nextModel = normalizeModelValue(entry);
    if (normalizedModel === undefined) {
      normalizedModel = nextModel;
      continue;
    }
    if (normalizedModel !== nextModel) {
      return { mode: "mixed" };
    }
  }

  return {
    mode: "uniform",
    model: normalizedModel ?? null,
  };
}

export function resolveSharedReasoningEffort(
  values: unknown,
): { mode: "uniform"; reasoningEffort: ReasoningEffort | null } | { mode: "mixed" } {
  let normalizedValue: ReasoningEffort | null | undefined;

  for (const entry of Array.isArray(values) ? values : []) {
    const nextValue = normalizeReasoningEffortValue(entry);
    if (normalizedValue === undefined) {
      normalizedValue = nextValue;
      continue;
    }
    if (normalizedValue !== nextValue) {
      return { mode: "mixed" };
    }
  }

  return {
    mode: "uniform",
    reasoningEffort: normalizedValue ?? null,
  };
}

export function resolveSharedServiceTier(
  values: unknown,
): { mode: "uniform"; serviceTier: ServiceTier | null } | { mode: "mixed" } {
  let normalizedValue: ServiceTier | null | undefined;

  for (const entry of Array.isArray(values) ? values : []) {
    const nextValue = normalizeServiceTierValue(entry);
    if (normalizedValue === undefined) {
      normalizedValue = nextValue;
      continue;
    }
    if (normalizedValue !== nextValue) {
      return { mode: "mixed" };
    }
  }

  return {
    mode: "uniform",
    serviceTier: normalizedValue ?? null,
  };
}

export async function applyProviderPolicyToBots({
  apiPost,
  bots,
  patch,
}: {
  apiPost: ApiPostFn;
  bots: Array<{ id?: string }>;
  patch: ProviderPolicyPatch;
}): Promise<{
  updatedBotIds: string[];
  failures: Array<{ botId: string; error: string }>;
}> {
  const updatedBotIds: string[] = [];
  const failures: Array<{ botId: string; error: string }> = [];

  for (const botState of Array.isArray(bots) ? bots : []) {
    const botId = String(botState?.id ?? "").trim();
    if (!botId) {
      continue;
    }

    try {
      await applyBotProviderPolicy({
        apiPost,
        botId,
        botState,
        patch,
      });
      updatedBotIds.push(botId);
    } catch (error) {
      failures.push({
        botId,
        error: sanitizeError(error),
      });
    }
  }

  return {
    updatedBotIds,
    failures,
  };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object";
}

function normalizeModelValue(value: unknown): string | null {
  const normalized = String(value ?? "").trim();
  return normalized || null;
}

function normalizeReasoningCatalog(value: unknown): Array<{
  reasoningEffort: ReasoningEffort;
  description: string;
}> {
  const options: Array<{
    reasoningEffort: ReasoningEffort;
    description: string;
  }> = [];
  const seen = new Set<string>();

  for (const entry of Array.isArray(value) ? value : []) {
    const option = isObject(entry) ? entry : {};
    const reasoningEffort = normalizeReasoningEffortValue(
      option.reasoningEffort ?? option.effort ?? option.id,
    );
    if (!reasoningEffort || seen.has(reasoningEffort)) {
      continue;
    }
    seen.add(reasoningEffort);
    options.push({
      reasoningEffort,
      description: String(option.description ?? "").trim(),
    });
  }

  return options;
}

function normalizeReasoningEffortValue(value: unknown): ReasoningEffort | null {
  const normalized = String(value ?? "")
    .trim()
    .toLowerCase();
  if (
    normalized === "none" ||
    normalized === "minimal" ||
    normalized === "low" ||
    normalized === "medium" ||
    normalized === "high" ||
    normalized === "xhigh"
  ) {
    return normalized;
  }
  return null;
}

function normalizeServiceTierValue(value: unknown): ServiceTier | null {
  const normalized = String(value ?? "")
    .trim()
    .toLowerCase();
  if (normalized === "fast" || normalized === "flex") {
    return normalized;
  }
  return null;
}

function sanitizeError(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  return raw.split(/\r?\n/).slice(0, 6).join("\n");
}
