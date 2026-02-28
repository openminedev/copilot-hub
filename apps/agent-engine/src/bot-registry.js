import fs from "node:fs/promises";
import path from "node:path";
import { assertWorkspaceAllowed } from "@copilot-hub/core/workspace-policy";
import { getKernelRootPath, isPathInside } from "@copilot-hub/core/workspace-paths";

const REGISTRY_VERSION = 3;
const BOT_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const CHANNEL_ID_PATTERN = /^[A-Za-z0-9._:-]{1,80}$/;
const KERNEL_ROOT_PATH = getKernelRootPath();

export async function loadBotRegistry({
  filePath,
  dataDir,
  defaultWorkspaceRoot,
  defaultThreadMode,
  defaultSharedThreadId,
  defaultAllowedChatIds,
  bootstrapTelegramToken,
  defaultProviderKind,
  workspacePolicy = null,
  resolveSecret = null
}) {
  const state = await readOrCreateRegistry({
    filePath,
    bootstrapTelegramToken
  });

  if (!Array.isArray(state?.agents)) {
    throw new Error("Registry must define an 'agents' array.");
  }

  const workspaceRootFallback = path.resolve(String(defaultWorkspaceRoot ?? process.cwd()));
  const bots = [];
  const seenIds = new Set();

  for (let index = 0; index < state.agents.length; index += 1) {
    const raw = state.agents[index];
    const normalized = normalizeAgentDefinition({
      raw,
      index,
      dataDir,
      defaultWorkspaceRoot: workspaceRootFallback,
      defaultThreadMode,
      defaultSharedThreadId,
      defaultAllowedChatIds,
      defaultProviderKind,
      workspacePolicy,
      resolveSecret
    });
    if (!normalized) {
      continue;
    }
    if (seenIds.has(normalized.id)) {
      throw new Error(`Duplicated agent id '${normalized.id}' in registry.`);
    }
    seenIds.add(normalized.id);
    bots.push(normalized);
  }

  return {
    filePath,
    version: REGISTRY_VERSION,
    bots
  };
}

async function readOrCreateRegistry({ filePath, bootstrapTelegramToken }) {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    const parsed = JSON.parse(stripBom(raw));
    if (!parsed || typeof parsed !== "object") {
      throw new Error("Invalid registry format.");
    }
    if (!Array.isArray(parsed.agents)) {
      throw new Error("Registry must include an 'agents' array.");
    }
    return parsed;
  } catch (error) {
    if (error && error.code !== "ENOENT") {
      throw error;
    }

    const initial = createInitialRegistry(bootstrapTelegramToken);
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, `${JSON.stringify(initial, null, 2)}\n`, "utf8");
    return initial;
  }
}

function stripBom(value) {
  const text = String(value ?? "");
  if (text.charCodeAt(0) === 0xfeff) {
    return text.slice(1);
  }
  return text;
}

function createInitialRegistry(bootstrapTelegramToken) {
  const agents = [];
  if (bootstrapTelegramToken) {
    agents.push({
      id: deriveBotIdFromToken(bootstrapTelegramToken) ?? "bot_default",
      name: "Primary Bot",
      enabled: true,
      autoStart: true,
      provider: {
        kind: "codex",
        options: {}
      },
      channels: [
        {
          kind: "telegram",
          id: "telegram_main",
          token: bootstrapTelegramToken
        }
      ],
      capabilities: []
    });
  }

  return {
    version: REGISTRY_VERSION,
    agents
  };
}

function normalizeAgentDefinition({
  raw,
  index,
  dataDir,
  defaultWorkspaceRoot,
  defaultThreadMode,
  defaultSharedThreadId,
  defaultAllowedChatIds,
  defaultProviderKind,
  workspacePolicy,
  resolveSecret
}) {
  if (!raw || typeof raw !== "object") {
    return null;
  }

  const candidateId = String(raw.id ?? `bot_${index + 1}`).trim();
  if (!BOT_ID_PATTERN.test(candidateId)) {
    throw new Error(`Invalid agent id '${candidateId}'.`);
  }

  const threadMode = normalizeThreadMode(raw.threadMode, defaultThreadMode);
  const sharedThreadId = String(raw.sharedThreadId ?? defaultSharedThreadId).trim();
  const workspaceRoot = resolveAgentWorkspaceRoot({
    rawWorkspaceRoot: raw.workspaceRoot,
    defaultWorkspaceRoot,
    botId: candidateId
  });
  assertWorkspaceForAgent({
    workspaceRoot,
    workspacePolicy,
    botId: candidateId
  });

  const provider = normalizeProvider(raw.provider, defaultProviderKind);
  const channels = normalizeChannels({
    channels: raw.channels,
    botId: candidateId,
    defaultAllowedChatIds,
    resolveSecret
  });
  const kernelAccess = normalizeKernelAccess(raw.kernelAccess);
  const capabilities = normalizeCapabilities(raw.capabilities);

  if (channels.length === 0) {
    throw new Error(`Agent '${candidateId}' must define at least one channel.`);
  }

  return {
    id: candidateId,
    name: String(raw.name ?? candidateId).trim() || candidateId,
    enabled: raw.enabled !== false,
    autoStart: Boolean(raw.autoStart),
    workspaceRoot,
    dataDir: path.resolve(String(raw.dataDir ?? path.join(dataDir, "bots", candidateId))),
    threadMode,
    sharedThreadId,
    provider,
    kernelAccess,
    capabilities,
    channels
  };
}

function resolveAgentWorkspaceRoot({ rawWorkspaceRoot, defaultWorkspaceRoot, botId }) {
  const defaultRoot = path.resolve(String(defaultWorkspaceRoot ?? process.cwd()));
  const fallbackRoot = path.resolve(defaultRoot, String(botId ?? "").trim() || "agent");
  const raw = String(rawWorkspaceRoot ?? "").trim();
  if (!raw) {
    return fallbackRoot;
  }

  return path.resolve(raw);
}

function assertWorkspaceForAgent({ workspaceRoot, workspacePolicy, botId }) {
  if (workspacePolicy && typeof workspacePolicy === "object") {
    assertWorkspaceAllowed({
      workspaceRoot,
      policy: workspacePolicy,
      label: `Agent '${botId}' workspaceRoot`
    });
    return;
  }

  if (isPathInside(KERNEL_ROOT_PATH, workspaceRoot)) {
    throw new Error(
      `Agent '${botId}' workspaceRoot must be outside kernel directory. kernel=${KERNEL_ROOT_PATH} workspace=${workspaceRoot}`
    );
  }
}

function normalizeThreadMode(value, fallback) {
  const mode = String(value ?? fallback ?? "single")
    .trim()
    .toLowerCase();
  if (mode === "single" || mode === "per_chat") {
    return mode;
  }
  throw new Error(`Invalid threadMode '${mode}'.`);
}

function normalizeProvider(provider, defaultProviderKind) {
  const kind = String(provider?.kind ?? defaultProviderKind ?? "codex")
    .trim()
    .toLowerCase();
  if (!kind) {
    throw new Error("Provider kind is required.");
  }

  return {
    kind,
    options: provider?.options && typeof provider.options === "object" ? provider.options : {}
  };
}

function normalizeChannels({ channels, botId, defaultAllowedChatIds, resolveSecret }) {
  if (!Array.isArray(channels)) {
    throw new Error(`Agent '${botId}' channels must be an array.`);
  }

  const normalized = [];
  const seen = new Set();
  for (let index = 0; index < channels.length; index += 1) {
    const channel = channels[index];
    if (!channel || typeof channel !== "object") {
      continue;
    }

    const kind = String(channel.kind ?? "").trim().toLowerCase();
    if (!kind) {
      continue;
    }

    const generatedId = `${kind}_${index + 1}`;
    const id = String(channel.id ?? generatedId).trim() || generatedId;
    if (!CHANNEL_ID_PATTERN.test(id)) {
      throw new Error(`Invalid channel id '${id}' for bot '${botId}'.`);
    }
    const key = `${kind}:${id}`;
    if (seen.has(key)) {
      throw new Error(`Duplicate channel '${key}' for bot '${botId}'.`);
    }
    seen.add(key);

    if (kind === "telegram") {
      normalized.push({
        kind: "telegram",
        id,
        token: resolveTelegramToken(channel, botId, id, resolveSecret),
        tokenEnv: String(channel.tokenEnv ?? "").trim() || null,
        tokenSecretRef: String(channel.tokenSecretRef ?? "").trim() || null,
        allowedChatIds: normalizeAllowedChatIds(channel.allowedChatIds, defaultAllowedChatIds)
      });
      continue;
    }

    if (kind === "whatsapp") {
      normalized.push({
        kind: "whatsapp",
        id,
        options: channel.options && typeof channel.options === "object" ? channel.options : {}
      });
      continue;
    }

    normalized.push({
      kind,
      id,
      options: channel.options && typeof channel.options === "object" ? channel.options : {}
    });
  }

  return normalized;
}

function normalizeCapabilities(value) {
  if (!Array.isArray(value)) {
    return [];
  }

  const normalized = [];
  const seen = new Set();
  for (let index = 0; index < value.length; index += 1) {
    const entry = value[index];

    if (typeof entry === "string") {
      const manifestPath = entry.trim();
      if (!manifestPath) {
        continue;
      }
      const id = `capability_${index + 1}`;
      if (seen.has(id)) {
        continue;
      }
      seen.add(id);
      normalized.push({
        id,
        enabled: true,
        manifestPath,
        options: {}
      });
      continue;
    }

    if (!entry || typeof entry !== "object") {
      continue;
    }

    const id = String(entry.id ?? `capability_${index + 1}`).trim();
    const manifestPath = String(entry.manifestPath ?? "").trim();
    if (!id || !manifestPath || seen.has(id)) {
      continue;
    }
    seen.add(id);
    normalized.push({
      id,
      enabled: entry.enabled !== false,
      manifestPath,
      options: entry.options && typeof entry.options === "object" ? entry.options : {}
    });
  }

  return normalized;
}

function normalizeAllowedChatIds(value, fallbackSet) {
  if (Array.isArray(value)) {
    return uniqueStrings(value);
  }

  if (typeof value === "string") {
    return uniqueStrings(value.split(","));
  }

  return uniqueStrings(fallbackSet ?? []);
}

function normalizeKernelAccess(value) {
  if (!value || typeof value !== "object") {
    return {
      enabled: false,
      allowedActions: [],
      allowedChatIds: []
    };
  }

  return {
    enabled: value.enabled === true,
    allowedActions: normalizeActionList(value.allowedActions),
    allowedChatIds: normalizeAllowedChatIds(value.allowedChatIds, [])
  };
}

function normalizeActionList(value) {
  if (Array.isArray(value)) {
    return uniqueStrings(value.map((entry) => String(entry ?? "").toLowerCase()));
  }
  if (typeof value === "string") {
    return uniqueStrings(
      value
        .split(",")
        .map((entry) => String(entry ?? "").toLowerCase())
    );
  }
  return [];
}

function uniqueStrings(values) {
  const seen = new Set();
  const output = [];
  for (const value of values) {
    const normalized = String(value ?? "").trim();
    if (!normalized || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    output.push(normalized);
  }
  return output;
}

function resolveTelegramToken(channel, botId, channelId, resolveSecret) {
  const tokenEnvName = String(channel?.tokenEnv ?? "").trim();
  const tokenSecretRef = String(channel?.tokenSecretRef ?? "").trim();
  const directToken = String(channel?.token ?? "").trim();
  const envToken = tokenEnvName ? String(process.env[tokenEnvName] ?? "").trim() : "";
  const secretToken =
    tokenSecretRef && typeof resolveSecret === "function" ? String(resolveSecret(tokenSecretRef) ?? "").trim() : "";
  const resolved = envToken || secretToken || directToken;
  if (!resolved) {
    throw new Error(
      `Telegram token missing for bot '${botId}' channel '${channelId}'. Set '${tokenEnvName || tokenSecretRef || "token"}'.`
    );
  }
  return resolved;
}

function deriveBotIdFromToken(token) {
  const value = String(token ?? "").trim();
  const prefix = value.split(":")[0]?.trim();
  if (!prefix) {
    return null;
  }
  const candidate = `bot_${prefix}`;
  return BOT_ID_PATTERN.test(candidate) ? candidate : null;
}
