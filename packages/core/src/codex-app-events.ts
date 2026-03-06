type JsonObject = Record<string, unknown>;

export type QuotaWindow = {
  usedPercent: number | null;
  remainingPercent: number | null;
  windowMinutes: number | null;
  resetsAt: number | null;
};

export type QuotaCredits = {
  hasCredits: boolean | null;
  unlimited: boolean | null;
  balance: number | null;
};

export type QuotaUsage = {
  inputTokens: number | null;
  cachedInputTokens: number | null;
  outputTokens: number | null;
  reasoningOutputTokens: number | null;
  totalTokens: number | null;
  modelContextWindow: number | null;
} | null;

export type QuotaSnapshot = {
  updatedAt: string;
  primary: QuotaWindow;
  secondary: QuotaWindow;
  credits: QuotaCredits;
  usage: QuotaUsage;
  rawType: string;
};

export function extractQuotaSnapshot(message: unknown): QuotaSnapshot | null {
  const tokenCountPayload = extractTokenCountPayload(message);
  const rateLimits =
    tokenCountPayload?.rate_limits ??
    tokenCountPayload?.rateLimits ??
    extractRateLimitsPayload(message);
  if (!isObject(rateLimits)) {
    return null;
  }

  const primary = normalizeRateLimitWindow(rateLimits.primary);
  const secondary = normalizeRateLimitWindow(rateLimits.secondary);
  const hasPrimary =
    Number.isFinite(primary.usedPercent) || Number.isFinite(primary.remainingPercent);
  const hasSecondary =
    Number.isFinite(secondary.usedPercent) || Number.isFinite(secondary.remainingPercent);
  if (!hasPrimary && !hasSecondary) {
    return null;
  }

  return {
    updatedAt: new Date().toISOString(),
    primary,
    secondary,
    credits: normalizeCredits(rateLimits.credits),
    usage: normalizeTokenUsage(tokenCountPayload?.info),
    rawType: String(tokenCountPayload?.type ?? "rate_limits"),
  };
}

export function extractThreadLifecycleModel(message: unknown): string {
  if (!isObject(message)) {
    return "";
  }

  const result = asObject(message.result);
  const params = asObject(message.params);
  const thread = asObject(message.thread);
  const resultThread = asObject(result?.thread);
  const candidates = [result?.model, params?.model, resultThread?.model, thread?.model];

  for (const candidate of candidates) {
    const value = String(candidate ?? "").trim();
    if (value) {
      return value;
    }
  }

  return "";
}

export function extractSessionConfiguredModel(message: unknown): string {
  const payload = extractSessionConfiguredPayload(message);
  if (!isObject(payload)) {
    return "";
  }
  return String(payload.model ?? "").trim();
}

function extractTokenCountPayload(message: unknown): JsonObject | null {
  if (!isObject(message)) {
    return null;
  }

  const payload = asObject(message.payload);
  const params = asObject(message.params);
  const paramsPayload = asObject(params?.payload);
  const paramsMsg = asObject(params?.msg);

  if (message.type === "event_msg" && payload?.type === "token_count") {
    return payload;
  }

  if (message.type === "token_count") {
    return message;
  }

  if (payload?.type === "token_count") {
    return payload;
  }

  if (message.method === "event_msg") {
    if (paramsPayload?.type === "token_count") {
      return paramsPayload;
    }
    if (params?.type === "token_count") {
      return params;
    }
  }

  if (message.method === "codex/event/token_count") {
    if (paramsMsg?.type === "token_count") {
      return paramsMsg;
    }
    if (params?.type === "token_count") {
      return params;
    }
  }

  if (message.method === "token_count") {
    if (params) {
      return {
        type: "token_count",
        ...params,
      };
    }
  }

  if (paramsMsg?.type === "token_count") {
    return paramsMsg;
  }

  return null;
}

function extractRateLimitsPayload(message: unknown): JsonObject | null {
  if (!isObject(message)) {
    return null;
  }

  if (message.method === "account/rateLimits/updated") {
    const params = asObject(message.params);
    const candidate = params?.rateLimits ?? params?.rate_limits;
    if (isObject(candidate)) {
      return candidate;
    }
  }

  const payload = asObject(message.payload);
  if (isObject(payload?.rate_limits)) {
    return payload.rate_limits;
  }
  if (isObject(payload?.rateLimits)) {
    return payload.rateLimits;
  }

  const params = asObject(message.params);
  if (isObject(params?.rate_limits)) {
    return params.rate_limits;
  }
  if (isObject(params?.rateLimits)) {
    return params.rateLimits;
  }

  return null;
}

function normalizeRateLimitWindow(value: unknown): QuotaWindow {
  const input = asObject(value) ?? {};
  const usedPercent = readUsedPercent(input);
  const remainingPercent = readRemainingPercent(input);
  const normalizedUsedPercent = Number.isFinite(usedPercent) ? clampPercent(usedPercent) : null;
  const normalizedRemainingPercent = Number.isFinite(remainingPercent)
    ? clampPercent(remainingPercent)
    : null;
  const resolvedUsedPercent =
    normalizedUsedPercent ??
    (normalizedRemainingPercent === null ? null : clampPercent(100 - normalizedRemainingPercent));
  const resolvedRemainingPercent =
    normalizedRemainingPercent ??
    (resolvedUsedPercent === null ? null : clampPercent(100 - resolvedUsedPercent));

  return {
    usedPercent: resolvedUsedPercent,
    remainingPercent: resolvedRemainingPercent,
    windowMinutes: readWindowMinutes(input),
    resetsAt: readResetsAt(input),
  };
}

function normalizeCredits(value: unknown): QuotaCredits {
  const input = asObject(value) ?? {};
  return {
    hasCredits: toNullableBoolean(input.has_credits ?? input.hasCredits),
    unlimited: toNullableBoolean(input.unlimited),
    balance: toFiniteNumber(input.balance),
  };
}

function normalizeTokenUsage(info: unknown): QuotaUsage {
  const usage = extractUsageBlock(info);
  if (!usage) {
    return null;
  }
  const infoObject = asObject(info) ?? {};
  return {
    inputTokens: toFiniteNumber(usage.input_tokens ?? usage.inputTokens),
    cachedInputTokens: toFiniteNumber(usage.cached_input_tokens ?? usage.cachedInputTokens),
    outputTokens: toFiniteNumber(usage.output_tokens ?? usage.outputTokens),
    reasoningOutputTokens: toFiniteNumber(
      usage.reasoning_output_tokens ?? usage.reasoningOutputTokens,
    ),
    totalTokens: toFiniteNumber(usage.total_tokens ?? usage.totalTokens),
    modelContextWindow: toFiniteNumber(
      infoObject.model_context_window ?? infoObject.modelContextWindow,
    ),
  };
}

function extractSessionConfiguredPayload(message: unknown): JsonObject | null {
  if (!isObject(message)) {
    return null;
  }

  const payload = asObject(message.payload);
  const params = asObject(message.params);
  const paramsPayload = asObject(params?.payload);
  const paramsMsg = asObject(params?.msg);

  if (message.type === "event_msg" && payload?.type === "session_configured") {
    return payload;
  }

  if (message.type === "session_configured") {
    return message;
  }

  if (payload?.type === "session_configured") {
    return payload;
  }

  if (message.method === "event_msg") {
    if (paramsPayload?.type === "session_configured") {
      return paramsPayload;
    }
    if (params?.type === "session_configured") {
      return params;
    }
  }

  if (message.method === "codex/event/session_configured") {
    if (paramsMsg?.type === "session_configured") {
      return paramsMsg;
    }
    if (params?.type === "session_configured") {
      return params;
    }
  }

  if (message.method === "session_configured") {
    if (params) {
      return {
        type: "session_configured",
        ...params,
      };
    }
  }

  if (paramsMsg?.type === "session_configured") {
    return paramsMsg;
  }

  return null;
}

function extractUsageBlock(info: unknown): JsonObject | null {
  const infoObject = asObject(info);
  if (!infoObject) {
    return null;
  }

  const candidate = infoObject.total_token_usage ?? infoObject.totalTokenUsage ?? infoObject.total;
  return asObject(candidate);
}

function readUsedPercent(value: unknown): number | null {
  const input = asObject(value) ?? {};
  return toFiniteNumber(input.used_percent ?? input.usedPercent);
}

function readRemainingPercent(value: unknown): number | null {
  const input = asObject(value) ?? {};
  return toFiniteNumber(input.remaining_percent ?? input.remainingPercent);
}

function readWindowMinutes(value: unknown): number | null {
  const input = asObject(value) ?? {};
  return toFiniteNumber(input.window_minutes ?? input.windowDurationMins);
}

function readResetsAt(value: unknown): number | null {
  const input = asObject(value) ?? {};
  return toFiniteNumber(input.resets_at ?? input.resetsAt);
}

function toFiniteNumber(value: unknown): number | null {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function toNullableBoolean(value: unknown): boolean | null {
  if (value === true) {
    return true;
  }
  if (value === false) {
    return false;
  }
  return null;
}

function clampPercent(value: unknown): number | null {
  const n = Number(value);
  if (!Number.isFinite(n)) {
    return null;
  }
  if (n < 0) {
    return 0;
  }
  if (n > 100) {
    return 100;
  }
  return n;
}

function isObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === "object";
}

function asObject(value: unknown): JsonObject | null {
  return isObject(value) ? value : null;
}
