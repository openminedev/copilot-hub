import path from "node:path";
import { BotRuntime } from "./bot-runtime.js";
import { config } from "./config.js";
import { assertWorkspaceAllowed } from "@copilot-hub/core/workspace-policy";

const tokenEnvName = String(process.env.HUB_TELEGRAM_TOKEN_ENV ?? "HUB_TELEGRAM_TOKEN").trim() || "HUB_TELEGRAM_TOKEN";
const hubToken = String(process.env[tokenEnvName] ?? "").trim();
if (!hubToken) {
  throw new Error(
    [
      `Hub Telegram token is missing (${tokenEnvName}).`,
      "Set this token to start copilot-hub."
    ].join("\n")
  );
}

const hubId = String(process.env.HUB_ID ?? "copilot_hub").trim() || "copilot_hub";
const hubName = String(process.env.HUB_NAME ?? "Copilot Hub").trim() || "Copilot Hub";
const hubWorkspaceRootRaw = path.resolve(String(process.env.HUB_WORKSPACE_ROOT ?? config.defaultWorkspaceRoot));
const hubWorkspaceRoot = assertWorkspaceAllowed({
  workspaceRoot: hubWorkspaceRootRaw,
  policy: config.workspacePolicy,
  label: "HUB_WORKSPACE_ROOT"
});
const hubDataDir = path.resolve(String(process.env.HUB_DATA_DIR ?? path.join(config.dataDir, "copilot_hub")));
const hubThreadMode = normalizeThreadMode(process.env.HUB_THREAD_MODE ?? "per_chat");
const hubSharedThreadId = String(process.env.HUB_SHARED_THREAD_ID ?? "shared-copilot-hub").trim() || "shared-copilot-hub";
const allowedChatIds = parseCsvSet(process.env.HUB_ALLOWED_CHAT_IDS ?? "");
const hubImmutableCore = parseBoolean(process.env.HUB_IMMUTABLE_CORE ?? "true");
let hubSandboxMode = String(process.env.HUB_CODEX_SANDBOX ?? config.codexSandbox ?? "workspace-write").trim();
let hubApprovalPolicy = String(process.env.HUB_CODEX_APPROVAL_POLICY ?? config.codexApprovalPolicy ?? "on-request").trim();

if (hubImmutableCore && hubSandboxMode === "danger-full-access" && hubApprovalPolicy === "never") {
  console.warn(
    "HUB_IMMUTABLE_CORE=true: forcing safer hub policy (workspace-write + on-request) instead of danger-full-access + never."
  );
  hubSandboxMode = "workspace-write";
  hubApprovalPolicy = "on-request";
}

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
        approvalPolicy: hubApprovalPolicy
      }
    },
    kernelAccess: {
      enabled: false,
      allowedActions: [],
      allowedChatIds: []
    },
    channels: [
      {
        kind: "telegram",
        id: "telegram_copilot_hub",
        token: hubToken,
        allowedChatIds: [...allowedChatIds]
      }
    ],
    capabilities: []
  },
  providerDefaults: config.providerDefaults,
  turnActivityTimeoutMs: config.turnActivityTimeoutMs,
  maxMessages: config.maxMessages
});

let shuttingDown = false;

await bootstrap();

async function bootstrap() {
  await runtime.startChannels();
  console.log(`[copilot_hub] online as '${hubId}' on workspace '${hubWorkspaceRoot}'.`);
  registerSignals();
}

function registerSignals() {
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

async function shutdown(exitCode) {
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

function normalizeThreadMode(value) {
  const mode = String(value ?? "per_chat")
    .trim()
    .toLowerCase();
  if (mode === "single" || mode === "per_chat") {
    return mode;
  }
  return "per_chat";
}

function parseCsvSet(value) {
  return new Set(
    String(value ?? "")
      .split(",")
      .map((entry) => entry.trim())
      .filter(Boolean)
  );
}

function parseBoolean(value) {
  const normalized = String(value ?? "")
    .trim()
    .toLowerCase();
  if (normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on") {
    return true;
  }
  if (normalized === "0" || normalized === "false" || normalized === "no" || normalized === "off") {
    return false;
  }
  throw new Error("Invalid boolean value.");
}

function sanitizeError(error) {
  const raw = error instanceof Error ? error.message : String(error);
  return raw.split(/\r?\n/).slice(0, 12).join("\n");
}
