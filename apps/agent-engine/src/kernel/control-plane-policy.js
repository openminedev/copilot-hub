import { normalizeControlAction } from "./control-plane-actions.js";

export function assertControlPermission({ supervisor, action, source, metadata }) {
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

  const normalizedSource = String(source ?? "").trim().toLowerCase();
  if (normalizedSource === "telegram") {
    const allowedChatIds = resolveAllowedChatIds({
      kernelAccess,
      supervisor,
      channelId: metadata?.channelId
    });
    if (allowedChatIds.size > 0) {
      const chatId = String(metadata?.chatId ?? "").trim();
      if (!chatId || !allowedChatIds.has(chatId)) {
        throw new Error(`Telegram chat '${chatId || "<empty>"}' is not allowed for admin control.`);
      }
    }
  }
}

function normalizeKernelAccess(value) {
  const raw = value && typeof value === "object" ? value : {};
  const enabled = raw.enabled === true;
  const allowedActions = normalizeStringArray(raw.allowedActions);
  const allowedChatIds = normalizeStringArray(raw.allowedChatIds);
  return {
    enabled,
    allowedActions,
    allowedChatIds
  };
}

function isActionAllowed(allowedActions, action) {
  if (!Array.isArray(allowedActions) || allowedActions.length === 0) {
    return false;
  }
  const normalized = new Set(allowedActions.map((entry) => String(entry).toLowerCase()));
  return normalized.has("*") || normalized.has(action);
}

function resolveAllowedChatIds({ kernelAccess, supervisor, channelId }) {
  if (kernelAccess.allowedChatIds.length > 0) {
    return new Set(kernelAccess.allowedChatIds);
  }

  const requestedChannelId = String(channelId ?? "").trim();
  const channels = Array.isArray(supervisor.config?.channels) ? supervisor.config.channels : [];
  const channel = channels.find((entry) => {
    if (!entry || typeof entry !== "object") {
      return false;
    }
    if (String(entry.kind ?? "").trim().toLowerCase() !== "telegram") {
      return false;
    }
    if (!requestedChannelId) {
      return true;
    }
    return String(entry.id ?? "").trim() === requestedChannelId;
  });

  if (!channel) {
    return new Set();
  }

  return new Set(normalizeStringArray(channel.allowedChatIds));
}

function normalizeStringArray(value) {
  if (Array.isArray(value)) {
    return uniqueStrings(value);
  }
  if (typeof value === "string") {
    return uniqueStrings(
      value
        .split(",")
        .map((entry) => entry.trim())
        .filter(Boolean)
    );
  }
  return [];
}

function uniqueStrings(values) {
  const seen = new Set();
  const out = [];
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
