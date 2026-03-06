const MODEL_INLINE_MAX = 6;
const MODEL_PATTERN = /^[A-Za-z0-9._:-]+$/;

type ModelSelectionOption = {
  key: string;
  model: string;
  label: string;
  isDefault: boolean;
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

type ModelSelectionResult =
  | {
      ok: false;
      model: null;
      label: "";
    }
  | {
      ok: true;
      model: string | null;
      label: string;
    };

type ApiGetFn = (path: string) => Promise<unknown>;
type ApiPostFn = (path: string, payload: unknown) => Promise<unknown>;

type ModelCatalogItem = {
  model: string;
  displayName: string;
  isDefault: boolean;
};

type ModelCatalogResult = {
  available: boolean;
  models: ModelCatalogItem[];
};

type BotPolicyState = {
  sandboxMode: "read-only" | "workspace-write" | "danger-full-access";
  approvalPolicy: "on-request" | "on-failure" | "never";
};

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
      model: null,
      label: "",
    };
  }

  if (target === "auto") {
    return {
      ok: true,
      model: null,
      label: "Auto (workspace default)",
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
      model: null,
      label: "",
    };
  }

  return {
    ok: true,
    model: String(matched.model ?? "").trim() || null,
    label: String(matched.label ?? matched.model ?? "custom").trim(),
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
        isDefault: entry.isDefault === true,
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

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object";
}

export function getBotPolicyState(botState: unknown): BotPolicyState {
  const provider = isObject(botState) && isObject(botState.provider) ? botState.provider : null;
  const options = provider && isObject(provider.options) ? provider.options : {};
  return {
    sandboxMode: resolveSandboxMode(options.sandboxMode),
    approvalPolicy: resolveApprovalPolicy(options.approvalPolicy),
  };
}

export async function applyBotModelPolicy({
  apiPost,
  botId,
  botState,
  model,
}: {
  apiPost: ApiPostFn;
  botId: string;
  botState: unknown;
  model: string | null;
}): Promise<unknown> {
  const policyState = getBotPolicyState(botState);
  return apiPost(`/api/bots/${encodeURIComponent(botId)}/policy`, {
    sandboxMode: policyState.sandboxMode,
    approvalPolicy: policyState.approvalPolicy,
    model,
  });
}

export async function applyModelPolicyToBots({
  apiPost,
  bots,
  model,
}: {
  apiPost: ApiPostFn;
  bots: Array<{ id?: string; provider?: { options?: Record<string, unknown> } | null }>;
  model: string | null;
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
      await applyBotModelPolicy({
        apiPost,
        botId,
        botState,
        model,
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

function sanitizeError(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  return raw.split(/\r?\n/).slice(0, 6).join("\n");
}
