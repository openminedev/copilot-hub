import {
  normalizeModel,
  normalizeReasoningEffort,
  normalizeServiceTier,
} from "./codex-app-utils.js";

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

export function mergeProviderOptions(
  currentOptions: unknown,
  nextOptions: unknown,
): Record<string, unknown> {
  const merged = {
    ...asRecord(currentOptions),
  };

  for (const [key, rawValue] of Object.entries(asRecord(nextOptions))) {
    if (key === "model") {
      const normalizedValue = normalizeModel(rawValue);
      if (normalizedValue) {
        merged.model = normalizedValue;
      } else {
        delete merged.model;
      }
      continue;
    }

    if (key === "reasoningEffort") {
      const normalizedValue = normalizeReasoningEffort(rawValue);
      if (normalizedValue) {
        merged.reasoningEffort = normalizedValue;
      } else {
        delete merged.reasoningEffort;
      }
      continue;
    }

    if (key === "serviceTier") {
      const normalizedValue = normalizeServiceTier(rawValue);
      if (normalizedValue) {
        merged.serviceTier = normalizedValue;
      } else {
        delete merged.serviceTier;
      }
      continue;
    }

    if (typeof rawValue === "string") {
      const normalizedValue = rawValue.trim();
      if (!normalizedValue) {
        continue;
      }
      merged[key] = normalizedValue;
      continue;
    }

    if (rawValue !== undefined) {
      merged[key] = rawValue;
    }
  }

  return merged;
}
