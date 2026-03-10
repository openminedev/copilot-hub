import path from "node:path";
import { BotRuntime } from "@copilot-hub/core/bot-runtime";
import { config } from "./config.js";
import { assertWorkspaceAllowed } from "@copilot-hub/core/workspace-policy";
import { createChannelAdapter } from "./channels/channel-factory.js";

const TELEGRAM_TOKEN_PATTERN = /^\d{5,}:[A-Za-z0-9_-]{20,}$/;

const tokenEnvName =
  String(process.env.HUB_TELEGRAM_TOKEN_ENV ?? "HUB_TELEGRAM_TOKEN").trim() || "HUB_TELEGRAM_TOKEN";
const hubToken = String(process.env[tokenEnvName] ?? "").trim();
if (!hubToken) {
  throw new Error(
    [
      `Hub Telegram token is missing (${tokenEnvName}).`,
      "Set this token to start copilot-hub.",
    ].join("\n"),
  );
}
if (!TELEGRAM_TOKEN_PATTERN.test(hubToken) || hubToken.toLowerCase().includes("replace_me")) {
  throw new Error(
    [
      `Hub Telegram token in ${tokenEnvName} is invalid.`,
      "Run 'copilot-hub configure' and paste a real BotFather token.",
    ].join("\n"),
  );
}

const hubId = String(process.env.HUB_ID ?? "copilot_hub").trim() || "copilot_hub";
const hubName = String(process.env.HUB_NAME ?? "Copilot Hub").trim() || "Copilot Hub";
const configuredHubWorkspaceRoot = String(process.env.HUB_WORKSPACE_ROOT ?? "").trim();
const hubWorkspaceRootRaw = path.resolve(
  config.envBaseDir,
  configuredHubWorkspaceRoot || config.defaultWorkspaceRoot,
);
const hubWorkspaceRoot = assertWorkspaceAllowed({
  workspaceRoot: hubWorkspaceRootRaw,
  policy: config.workspacePolicy,
  label: "HUB_WORKSPACE_ROOT",
});
const hubDataDir = path.resolve(
  config.envBaseDir,
  String(process.env.HUB_DATA_DIR ?? path.join(config.dataDir, "copilot_hub")),
);
const hubThreadMode = normalizeThreadMode(process.env.HUB_THREAD_MODE ?? "per_chat");
const hubSharedThreadId =
  String(process.env.HUB_SHARED_THREAD_ID ?? "shared-copilot-hub").trim() || "shared-copilot-hub";
const allowedChatIds = parseCsvSet(process.env.HUB_ALLOWED_CHAT_IDS ?? "");
const hubSandboxMode = String(
  process.env.HUB_CODEX_SANDBOX ?? config.codexSandbox ?? "danger-full-access",
).trim();
const hubApprovalPolicy = String(
  process.env.HUB_CODEX_APPROVAL_POLICY ?? config.codexApprovalPolicy ?? "never",
).trim();

const runtime = new BotRuntime({
  botConfig: {
    id: hubId,
    name: hubName,
    enabled: true,
    autoStart: true,
    workspaceRoot: hubWorkspaceRoot,
    dataDir: hubDataDir,
    threadMode: hubThreadMode,
    sharedThreadId: hubSharedThreadId,
    provider: {
      kind: config.defaultProviderKind,
      options: {
        sandboxMode: hubSandboxMode,
        approvalPolicy: hubApprovalPolicy,
      },
    },
    kernelAccess: {
      enabled: false,
      allowedActions: [],
      allowedChatIds: [],
    },
    channels: [
      {
        kind: "telegram",
        id: "telegram_copilot_hub",
        token: hubToken,
        allowedChatIds: [...allowedChatIds],
      },
    ],
    capabilities: [],
  },
  providerDefaults: config.providerDefaults,
  turnActivityTimeoutMs: config.turnActivityTimeoutMs,
  maxMessages: config.maxMessages,
  channelAdapterFactory: createChannelAdapter as any,
});

let shuttingDown = false;

await bootstrap();

async function bootstrap(): Promise<void> {
  await runtime.startChannels();
  console.log(`[copilot_hub] online as '${hubId}' on workspace '${hubWorkspaceRoot}'.`);
  registerSignals();
}

function registerSignals(): void {
  process.on("SIGINT", () => {
    void shutdown(0);
  });
  process.on("SIGTERM", () => {
    void shutdown(0);
  });
  process.on("uncaughtException", (error) => {
    console.error(`[copilot_hub] uncaught exception: ${sanitizeError(error)}`);
    void shutdown(1);
  });
  process.on("unhandledRejection", (reason) => {
    console.error(`[copilot_hub] unhandled rejection: ${sanitizeError(reason)}`);
    void shutdown(1);
  });
}

async function shutdown(exitCode: number): Promise<void> {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;
  try {
    await runtime.shutdown();
  } catch (error) {
    console.error(`[copilot_hub] shutdown error: ${sanitizeError(error)}`);
  }
  process.exit(exitCode);
}

function normalizeThreadMode(value: unknown): "single" | "per_chat" {
  const mode = String(value ?? "per_chat")
    .trim()
    .toLowerCase();
  if (mode === "single" || mode === "per_chat") {
    return mode;
  }
  return "per_chat";
}

function parseCsvSet(value: unknown): Set<string> {
  return new Set(
    String(value ?? "")
      .split(",")
      .map((entry) => entry.trim())
      .filter(Boolean),
  );
}

function sanitizeError(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  return raw.split(/\r?\n/).slice(0, 12).join("\n");
}
