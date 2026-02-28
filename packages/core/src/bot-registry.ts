import fs from "node:fs/promises";
import path from "node:path";
import { assertWorkspaceAllowed, type WorkspaceBoundaryPolicy } from "./workspace-policy.js";
import { getKernelRootPath, isPathInside } from "./workspace-paths.js";

const REGISTRY_VERSION = 3;
const BOT_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const CHANNEL_ID_PATTERN = /^[A-Za-z0-9._:-]{1,80}$/;
const KERNEL_ROOT_PATH = getKernelRootPath();

export interface LoadBotRegistryOptions {
  filePath: string;
  dataDir: string;
  defaultWorkspaceRoot: string;
  defaultThreadMode: string;
  defaultSharedThreadId: string;
  defaultAllowedChatIds: Set<string>;
  bootstrapTelegramToken: string;
  defaultProviderKind: string;
  workspacePolicy?: WorkspaceBoundaryPolicy | null;
  resolveSecret?: ((name: string) => unknown) | null;
}

export interface LoadedBotRegistry {
  filePath: string;
  version: number;
  bots: NormalizedBotDefinition[];
}

export interface NormalizedBotDefinition {
  id: string;
  name: string;
  enabled: boolean;
  autoStart: boolean;
  workspaceRoot: string;
  dataDir: string;
  threadMode: "single" | "per_chat";
  sharedThreadId: string;
  provider: {
    kind: string;
    options: Record<string, unknown>;
  };
  kernelAccess: {
    enabled: boolean;
    allowedActions: string[];
    allowedChatIds: string[];
  };
  capabilities: Array<{
    id: string;
    enabled: boolean;
    manifestPath: string;
    options: Record<string, unknown>;
  }>;
  channels: Array<
    | {
        kind: "telegram";
        id: string;
        token: string;
        tokenEnv: string | null;
        tokenSecretRef: string | null;
        allowedChatIds: string[];
      }
    | {
        kind: "whatsapp";
        id: string;
        options: Record<string, unknown>;
      }
    | {
        kind: string;
        id: string;
        options: Record<string, unknown>;
      }
  >;
}

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
  resolveSecret = null,
}: LoadBotRegistryOptions): Promise<LoadedBotRegistry> {
  const state = await readOrCreateRegistry({
    filePath,
    bootstrapTelegramToken,
  });

  if (!Array.isArray(state?.agents)) {
    throw new Error("Registry must define an 'agents' array.");
  }

  const workspaceRootFallback = path.resolve(String(defaultWorkspaceRoot ?? process.cwd()));
  const bots: NormalizedBotDefinition[] = [];
  const seenIds = new Set<string>();

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
      resolveSecret,
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
    bots,
  };
}

async function readOrCreateRegistry({
  filePath,
  bootstrapTelegramToken,
}: {
  filePath: string;
  bootstrapTelegramToken: string;
}): Promise<{ version: number; agents: unknown[] }> {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    const parsed = JSON.parse(stripBom(raw));
    if (!parsed || typeof parsed !== "object") {
      throw new Error("Invalid registry format.");
    }
    if (!Array.isArray((parsed as { agents?: unknown }).agents)) {
      throw new Error("Registry must include an 'agents' array.");
    }
    return parsed as { version: number; agents: unknown[] };
  } catch (error) {
    if (getErrorCode(error) !== "ENOENT") {
      throw error;
    }

    const initial = createInitialRegistry(bootstrapTelegramToken);
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, `${JSON.stringify(initial, null, 2)}\n`, "utf8");
    return initial;
  }
}

function stripBom(value: string): string {
  const text = String(value ?? "");
  if (text.charCodeAt(0) === 0xfeff) {
    return text.slice(1);
  }
  return text;
}

function createInitialRegistry(bootstrapTelegramToken: string): {
  version: number;
  agents: unknown[];
} {
  const agents: unknown[] = [];
  if (bootstrapTelegramToken) {
    agents.push({
      id: deriveBotIdFromToken(bootstrapTelegramToken) ?? "bot_default",
      name: "Primary Bot",
      enabled: true,
      autoStart: true,
      provider: {
        kind: "codex",
        options: {},
      },
      channels: [
        {
          kind: "telegram",
          id: "telegram_main",
          token: bootstrapTelegramToken,
        },
      ],
      capabilities: [],
    });
  }

  return {
    version: REGISTRY_VERSION,
    agents,
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
  resolveSecret,
}: {
  raw: unknown;
  index: number;
  dataDir: string;
  defaultWorkspaceRoot: string;
  defaultThreadMode: string;
  defaultSharedThreadId: string;
  defaultAllowedChatIds: Set<string>;
  defaultProviderKind: string;
  workspacePolicy: WorkspaceBoundaryPolicy | null;
  resolveSecret: ((name: string) => unknown) | null;
}): NormalizedBotDefinition | null {
  if (!raw || typeof raw !== "object") {
    return null;
  }

  const rawAgent = raw as Record<string, unknown>;
  const candidateId = String(rawAgent.id ?? `bot_${index + 1}`).trim();
  if (!BOT_ID_PATTERN.test(candidateId)) {
    throw new Error(`Invalid agent id '${candidateId}'.`);
  }

  const threadMode = normalizeThreadMode(rawAgent.threadMode, defaultThreadMode);
  const sharedThreadId = String(rawAgent.sharedThreadId ?? defaultSharedThreadId).trim();
  const workspaceRoot = resolveAgentWorkspaceRoot({
    rawWorkspaceRoot: rawAgent.workspaceRoot,
    defaultWorkspaceRoot,
    botId: candidateId,
  });
  assertWorkspaceForAgent({
    workspaceRoot,
    workspacePolicy,
    botId: candidateId,
  });

  const provider = normalizeProvider(rawAgent.provider, defaultProviderKind);
  const channels = normalizeChannels({
    channels: rawAgent.channels,
    botId: candidateId,
    defaultAllowedChatIds,
    resolveSecret,
  });
  const kernelAccess = normalizeKernelAccess(rawAgent.kernelAccess);
  const capabilities = normalizeCapabilities(rawAgent.capabilities);

  if (channels.length === 0) {
    throw new Error(`Agent '${candidateId}' must define at least one channel.`);
  }

  return {
    id: candidateId,
    name: String(rawAgent.name ?? candidateId).trim() || candidateId,
    enabled: rawAgent.enabled !== false,
    autoStart: Boolean(rawAgent.autoStart),
    workspaceRoot,
    dataDir: path.resolve(String(rawAgent.dataDir ?? path.join(dataDir, "bots", candidateId))),
    threadMode,
    sharedThreadId,
    provider,
    kernelAccess,
    capabilities,
    channels,
  };
}

function resolveAgentWorkspaceRoot({
  rawWorkspaceRoot,
  defaultWorkspaceRoot,
  botId,
}: {
  rawWorkspaceRoot: unknown;
  defaultWorkspaceRoot: string;
  botId: string;
}): string {
  const defaultRoot = path.resolve(String(defaultWorkspaceRoot ?? process.cwd()));
  const fallbackRoot = path.resolve(defaultRoot, String(botId ?? "").trim() || "agent");
  const raw = String(rawWorkspaceRoot ?? "").trim();
  if (!raw) {
    return fallbackRoot;
  }

  return path.resolve(raw);
}

function assertWorkspaceForAgent({
  workspaceRoot,
  workspacePolicy,
  botId,
}: {
  workspaceRoot: string;
  workspacePolicy: WorkspaceBoundaryPolicy | null;
  botId: string;
}): void {
  if (workspacePolicy && typeof workspacePolicy === "object") {
    assertWorkspaceAllowed({
      workspaceRoot,
      policy: workspacePolicy,
      label: `Agent '${botId}' workspaceRoot`,
    });
    return;
  }

  if (isPathInside(KERNEL_ROOT_PATH, workspaceRoot)) {
    throw new Error(
      `Agent '${botId}' workspaceRoot must be outside kernel directory. kernel=${KERNEL_ROOT_PATH} workspace=${workspaceRoot}`,
    );
  }
}

function normalizeThreadMode(value: unknown, fallback: string): "single" | "per_chat" {
  const mode = String(value ?? fallback ?? "single")
    .trim()
    .toLowerCase();
  if (mode === "single" || mode === "per_chat") {
    return mode;
  }
  throw new Error(`Invalid threadMode '${mode}'.`);
}

function normalizeProvider(
  provider: unknown,
  defaultProviderKind: string,
): { kind: string; options: Record<string, unknown> } {
  const raw = provider && typeof provider === "object" ? (provider as Record<string, unknown>) : {};
  const kind = String(raw.kind ?? defaultProviderKind ?? "codex")
    .trim()
    .toLowerCase();
  if (!kind) {
    throw new Error("Provider kind is required.");
  }

  const rawOptions =
    raw.options && typeof raw.options === "object" ? (raw.options as Record<string, unknown>) : {};
  return {
    kind,
    options: rawOptions,
  };
}

function normalizeChannels({
  channels,
  botId,
  defaultAllowedChatIds,
  resolveSecret,
}: {
  channels: unknown;
  botId: string;
  defaultAllowedChatIds: Set<string>;
  resolveSecret: ((name: string) => unknown) | null;
}): NormalizedBotDefinition["channels"] {
  if (!Array.isArray(channels)) {
    throw new Error(`Agent '${botId}' channels must be an array.`);
  }

  const normalized: NormalizedBotDefinition["channels"] = [];
  const seen = new Set<string>();
  for (let index = 0; index < channels.length; index += 1) {
    const channel = channels[index];
    if (!channel || typeof channel !== "object") {
      continue;
    }
    const rawChannel = channel as Record<string, unknown>;

    const kind = String(rawChannel.kind ?? "")
      .trim()
      .toLowerCase();
    if (!kind) {
      continue;
    }

    const generatedId = `${kind}_${index + 1}`;
    const id = String(rawChannel.id ?? generatedId).trim() || generatedId;
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
        token: resolveTelegramToken(rawChannel, botId, id, resolveSecret),
        tokenEnv: String(rawChannel.tokenEnv ?? "").trim() || null,
        tokenSecretRef: String(rawChannel.tokenSecretRef ?? "").trim() || null,
        allowedChatIds: normalizeAllowedChatIds(rawChannel.allowedChatIds, defaultAllowedChatIds),
      });
      continue;
    }

    if (kind === "whatsapp") {
      normalized.push({
        kind: "whatsapp",
        id,
        options:
          rawChannel.options && typeof rawChannel.options === "object"
            ? (rawChannel.options as Record<string, unknown>)
            : {},
      });
      continue;
    }

    normalized.push({
      kind,
      id,
      options:
        rawChannel.options && typeof rawChannel.options === "object"
          ? (rawChannel.options as Record<string, unknown>)
          : {},
    });
  }

  return normalized;
}

function normalizeCapabilities(value: unknown): NormalizedBotDefinition["capabilities"] {
  if (!Array.isArray(value)) {
    return [];
  }

  const normalized: NormalizedBotDefinition["capabilities"] = [];
  const seen = new Set<string>();
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
        options: {},
      });
      continue;
    }

    if (!entry || typeof entry !== "object") {
      continue;
    }
    const rawEntry = entry as Record<string, unknown>;

    const id = String(rawEntry.id ?? `capability_${index + 1}`).trim();
    const manifestPath = String(rawEntry.manifestPath ?? "").trim();
    if (!id || !manifestPath || seen.has(id)) {
      continue;
    }
    seen.add(id);
    normalized.push({
      id,
      enabled: rawEntry.enabled !== false,
      manifestPath,
      options:
        rawEntry.options && typeof rawEntry.options === "object"
          ? (rawEntry.options as Record<string, unknown>)
          : {},
    });
  }

  return normalized;
}

function normalizeAllowedChatIds(value: unknown, fallbackSet: Set<string>): string[] {
  if (Array.isArray(value)) {
    return uniqueStrings(value);
  }

  if (typeof value === "string") {
    return uniqueStrings(value.split(","));
  }

  return uniqueStrings([...fallbackSet]);
}

function normalizeKernelAccess(value: unknown): NormalizedBotDefinition["kernelAccess"] {
  if (!value || typeof value !== "object") {
    return {
      enabled: false,
      allowedActions: [],
      allowedChatIds: [],
    };
  }

  const raw = value as Record<string, unknown>;
  return {
    enabled: raw.enabled === true,
    allowedActions: normalizeActionList(raw.allowedActions),
    allowedChatIds: normalizeAllowedChatIds(raw.allowedChatIds, new Set<string>()),
  };
}

function normalizeActionList(value: unknown): string[] {
  if (Array.isArray(value)) {
    return uniqueStrings(value.map((entry) => String(entry ?? "").toLowerCase()));
  }
  if (typeof value === "string") {
    return uniqueStrings(value.split(",").map((entry) => String(entry ?? "").toLowerCase()));
  }
  return [];
}

function uniqueStrings(values: unknown[]): string[] {
  const seen = new Set<string>();
  const output: string[] = [];
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

function resolveTelegramToken(
  channel: Record<string, unknown>,
  botId: string,
  channelId: string,
  resolveSecret: ((name: string) => unknown) | null,
): string {
  const tokenEnvName = String(channel?.tokenEnv ?? "").trim();
  const tokenSecretRef = String(channel?.tokenSecretRef ?? "").trim();
  const directToken = String(channel?.token ?? "").trim();
  const envToken = tokenEnvName ? String(process.env[tokenEnvName] ?? "").trim() : "";
  const secretToken =
    tokenSecretRef && typeof resolveSecret === "function"
      ? String(resolveSecret(tokenSecretRef) ?? "").trim()
      : "";
  const resolved = envToken || secretToken || directToken;
  if (!resolved) {
    throw new Error(
      `Telegram token missing for bot '${botId}' channel '${channelId}'. Set '${tokenEnvName || tokenSecretRef || "token"}'.`,
    );
  }
  return resolved;
}

function deriveBotIdFromToken(token: unknown): string | null {
  const value = String(token ?? "").trim();
  const prefix = value.split(":")[0]?.trim();
  if (!prefix) {
    return null;
  }
  const candidate = `bot_${prefix}`;
  return BOT_ID_PATTERN.test(candidate) ? candidate : null;
}

function getErrorCode(error: unknown): string {
  if (!error || typeof error !== "object") {
    return "";
  }
  return String((error as { code?: unknown }).code ?? "")
    .trim()
    .toUpperCase();
}
