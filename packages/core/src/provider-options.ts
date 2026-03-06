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
      const normalizedModel = normalizeModel(rawValue);
      if (normalizedModel) {
        merged.model = normalizedModel;
      } else {
        delete merged.model;
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

function normalizeModel(value: unknown): string | null {
  if (value === null || value === undefined) {
    return null;
  }

  const normalized = String(value).trim();
  if (!normalized) {
    return null;
  }

  const keyword = normalized.toLowerCase();
  if (keyword === "auto" || keyword === "default") {
    return null;
  }

  return normalized;
}
