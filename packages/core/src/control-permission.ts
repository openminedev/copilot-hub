interface KernelAccessConfig {
  enabled: boolean;
  allowedActions: string[];
  allowedChatIds: string[];
}

interface SupervisorLike {
  id?: unknown;
  config?: {
    id?: unknown;
    kernelAccess?: unknown;
    channels?: unknown;
  };
}

interface AssertControlPermissionOptions {
  supervisor: SupervisorLike | null | undefined;
  action: unknown;
  source?: unknown;
  metadata?: {
    channelId?: unknown;
    chatId?: unknown;
  } | null;
}

export function assertControlPermission({
  supervisor,
  action,
  source,
  metadata,
}: AssertControlPermissionOptions): void {
  if (!supervisor || typeof supervisor !== "object") {
    throw new Error("Agent supervisor is required for control permission checks.");
  }

  const agentId = String(supervisor.config?.id ?? supervisor.id ?? "").trim() || "<unknown>";
  const kernelAccess = normalizeKernelAccess(supervisor.config?.kernelAccess);
  if (!kernelAccess.enabled) {
    throw new Error(`Agent '${agentId}' is not allowed to call kernel control actions.`);
  }

  const normalizedAction = normalizeControlAction(action);
  if (!isActionAllowed(kernelAccess.allowedActions, normalizedAction)) {
    throw new Error(`Action '${normalizedAction}' is not allowed for agent '${agentId}'.`);
  }

  const normalizedSource = String(source ?? "")
    .trim()
    .toLowerCase();
  if (normalizedSource === "telegram") {
    const allowedChatIds = resolveAllowedChatIds({
      kernelAccess,
      supervisor,
      channelId: metadata?.channelId,
    });
    if (allowedChatIds.size > 0) {
      const chatId = String(metadata?.chatId ?? "").trim();
      if (!chatId || !allowedChatIds.has(chatId)) {
        throw new Error(`Telegram chat '${chatId || "<empty>"}' is not allowed for admin control.`);
      }
    }
  }
}

function normalizeControlAction(value: unknown): string {
  return String(value ?? "")
    .trim()
    .toLowerCase();
}

function normalizeKernelAccess(value: unknown): KernelAccessConfig {
  const raw = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  const enabled = raw.enabled === true;
  const allowedActions = normalizeStringArray(raw.allowedActions);
  const allowedChatIds = normalizeStringArray(raw.allowedChatIds);
  return {
    enabled,
    allowedActions,
    allowedChatIds,
  };
}

function isActionAllowed(allowedActions: string[], action: string): boolean {
  if (!Array.isArray(allowedActions) || allowedActions.length === 0) {
    return false;
  }
  const normalized = new Set(allowedActions.map((entry) => String(entry).toLowerCase()));
  return normalized.has("*") || normalized.has(action);
}

function resolveAllowedChatIds({
  kernelAccess,
  supervisor,
  channelId,
}: {
  kernelAccess: KernelAccessConfig;
  supervisor: SupervisorLike;
  channelId: unknown;
}): Set<string> {
  if (kernelAccess.allowedChatIds.length > 0) {
    return new Set(kernelAccess.allowedChatIds);
  }

  const requestedChannelId = String(channelId ?? "").trim();
  const channels = Array.isArray(supervisor.config?.channels) ? supervisor.config.channels : [];
  const channel =
    channels.find((entry) => {
      if (!entry || typeof entry !== "object") {
        return false;
      }
      const channelObj = entry as { kind?: unknown; id?: unknown };
      if (
        String(channelObj.kind ?? "")
          .trim()
          .toLowerCase() !== "telegram"
      ) {
        return false;
      }
      if (!requestedChannelId) {
        return true;
      }
      return String(channelObj.id ?? "").trim() === requestedChannelId;
    }) ?? null;

  if (!channel || typeof channel !== "object") {
    return new Set();
  }

  const allowedChatIds = (channel as { allowedChatIds?: unknown }).allowedChatIds;
  return new Set(normalizeStringArray(allowedChatIds));
}

function normalizeStringArray(value: unknown): string[] {
  if (Array.isArray(value)) {
    return uniqueStrings(value);
  }
  if (typeof value === "string") {
    return uniqueStrings(
      value
        .split(",")
        .map((entry) => entry.trim())
        .filter(Boolean),
    );
  }
  return [];
}

function uniqueStrings(values: unknown[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    const normalized = String(value ?? "").trim();
    if (!normalized || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    out.push(normalized);
  }
  return out;
}
