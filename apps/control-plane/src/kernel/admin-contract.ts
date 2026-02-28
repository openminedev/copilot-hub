// @ts-nocheck
const BOT_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

export const DEFAULT_ADMIN_BOT_ID = "admin_agent";
export const DEFAULT_ADMIN_TOKEN_ENV = "TELEGRAM_TOKEN_ADMIN";
export const DEFAULT_ADMIN_CHANNEL_ID = "telegram_admin";

export function normalizeAdminBotId(value) {
  const id = String(value ?? DEFAULT_ADMIN_BOT_ID).trim();
  if (!BOT_ID_PATTERN.test(id)) {
    throw new Error("ADMIN_BOT_ID has invalid format.");
  }
  return id;
}

export function normalizeAdminTokenEnv(value) {
  const name = String(value ?? DEFAULT_ADMIN_TOKEN_ENV).trim();
  if (!name) {
    throw new Error("ADMIN_TELEGRAM_TOKEN_ENV cannot be empty.");
  }
  return name;
}

export function buildAdminAgentDefinition({ botId, tokenEnvName }) {
  const normalizedBotId = normalizeAdminBotId(botId);
  const normalizedTokenEnv = normalizeAdminTokenEnv(tokenEnvName);
  return {
    id: normalizedBotId,
    name: "Admin Agent",
    enabled: true,
    autoStart: true,
    dataDir: `./data/bots/${normalizedBotId}`,
    threadMode: "single",
    sharedThreadId:
      normalizedBotId === DEFAULT_ADMIN_BOT_ID
        ? "shared-admin"
        : `shared-${normalizedBotId.replace(/_/g, "-")}`,
    provider: {
      kind: "codex",
      options: {},
    },
    kernelAccess: {
      enabled: true,
      allowedActions: ["*"],
      allowedChatIds: [],
    },
    channels: [
      {
        kind: "telegram",
        id: DEFAULT_ADMIN_CHANNEL_ID,
        tokenEnv: normalizedTokenEnv,
      },
    ],
    capabilities: [],
  };
}
