import fs from "node:fs";
import path from "node:path";
import dotenv from "dotenv";
import {
  createWorkspaceBoundaryPolicy,
  assertWorkspaceAllowed,
  parseWorkspaceAllowedRoots,
} from "@copilot-hub/core/workspace-policy";
import {
  getDefaultExternalWorkspaceBasePath,
  getKernelRootPath,
} from "@copilot-hub/core/workspace-paths";

dotenv.config();

type ThreadMode = "single" | "per_chat";
type CodexSandbox = "read-only" | "workspace-write" | "danger-full-access";
type ApprovalPolicy = "untrusted" | "on-failure" | "on-request" | "never";
type ProviderKind = "codex";

const kernelRootPath = getKernelRootPath();
const configuredDefaultWorkspaceRoot = String(process.env.DEFAULT_WORKSPACE_ROOT ?? "").trim();
const defaultWorkspaceRoot = resolveWorkspaceRoot(
  configuredDefaultWorkspaceRoot || getDefaultExternalWorkspaceBasePath(kernelRootPath),
);
const configuredProjectsBaseDir = String(process.env.PROJECTS_BASE_DIR ?? "").trim();
const projectsBaseDir = path.resolve(configuredProjectsBaseDir || defaultWorkspaceRoot);
const workspaceStrictMode = parseBoolean(process.env.WORKSPACE_STRICT_MODE ?? "true");
const workspaceAllowedRoots = parseWorkspaceAllowedRoots(
  process.env.WORKSPACE_ALLOWED_ROOTS ?? "",
  {
    cwd: process.cwd(),
  },
);
const workspacePolicy = createWorkspaceBoundaryPolicy({
  kernelRootPath,
  defaultWorkspaceRoot,
  projectsBaseDir,
  strictMode: workspaceStrictMode,
  additionalAllowedRoots: workspaceAllowedRoots,
});
assertWorkspaceAllowed({
  workspaceRoot: defaultWorkspaceRoot,
  policy: workspacePolicy,
  label: "DEFAULT_WORKSPACE_ROOT",
});

const dataDir = path.resolve(process.env.BOT_DATA_DIR ?? path.join(process.cwd(), "data"));
const botRegistryFilePath = path.resolve(
  process.env.BOT_REGISTRY_FILE ?? path.join(dataDir, "bot-registry.json"),
);
const secretStoreFilePath = path.resolve(
  process.env.SECRET_STORE_FILE ?? path.join(dataDir, "secrets.json"),
);
const instanceLockEnabled = parseBoolean(process.env.INSTANCE_LOCK_ENABLED ?? "true");
const instanceLockFilePath = path.resolve(
  process.env.INSTANCE_LOCK_FILE ?? path.join(dataDir, "runtime.lock"),
);

const bootstrapTelegramToken = String(process.env.TELEGRAM_BOT_TOKEN ?? "").trim();
const defaultProviderKind = normalizeProviderKind(process.env.DEFAULT_PROVIDER_KIND ?? "codex");
const codexBin = resolveCodexBin(process.env.CODEX_BIN);
const codexHomeDir = resolveOptionalPath(process.env.CODEX_HOME_DIR);
const codexSandbox = normalizeCodexSandbox(process.env.CODEX_SANDBOX ?? "danger-full-access");
const codexApprovalPolicy = normalizeApprovalPolicy(process.env.CODEX_APPROVAL_POLICY ?? "never");

const turnActivityTimeoutMs = Number.parseInt(
  process.env.TURN_ACTIVITY_TIMEOUT_MS ?? "3600000",
  10,
);
if (!Number.isFinite(turnActivityTimeoutMs) || turnActivityTimeoutMs < 10000) {
  throw new Error("TURN_ACTIVITY_TIMEOUT_MS must be an integer >= 10000.");
}

const maxMessages = Number.parseInt(process.env.MAX_THREAD_MESSAGES ?? "200", 10);
if (!Number.isFinite(maxMessages) || maxMessages < 20) {
  throw new Error("MAX_THREAD_MESSAGES must be an integer >= 20.");
}

const webHost = (process.env.WEB_HOST ?? "127.0.0.1").trim() || "127.0.0.1";
const webPort = Number.parseInt(process.env.WEB_PORT ?? "8787", 10);
if (!Number.isFinite(webPort) || webPort < 1 || webPort > 65535) {
  throw new Error("WEB_PORT must be an integer in range 1..65535.");
}

const webPublicBaseUrl = (process.env.WEB_PUBLIC_BASE_URL ?? `http://localhost:${webPort}`).trim();
const webPublicBaseUrlExplicit = Boolean((process.env.WEB_PUBLIC_BASE_URL ?? "").trim());
const webPortAutoIncrement = parseBoolean(process.env.WEB_PORT_AUTO_INCREMENT ?? "true");
const webPortSearchMax = Number.parseInt(process.env.WEB_PORT_SEARCH_MAX ?? "30", 10);
if (!Number.isFinite(webPortSearchMax) || webPortSearchMax < 1 || webPortSearchMax > 1000) {
  throw new Error("WEB_PORT_SEARCH_MAX must be an integer in range 1..1000.");
}

const agentHeartbeatEnabled = parseBoolean(process.env.AGENT_HEARTBEAT_ENABLED ?? "true");
const agentHeartbeatIntervalMs = Number.parseInt(
  process.env.AGENT_HEARTBEAT_INTERVAL_MS ?? "5000",
  10,
);
if (
  !Number.isFinite(agentHeartbeatIntervalMs) ||
  agentHeartbeatIntervalMs < 1000 ||
  agentHeartbeatIntervalMs > 600000
) {
  throw new Error("AGENT_HEARTBEAT_INTERVAL_MS must be an integer in range 1000..600000.");
}

const agentHeartbeatTimeoutMs = Number.parseInt(
  process.env.AGENT_HEARTBEAT_TIMEOUT_MS ?? "4000",
  10,
);
if (
  !Number.isFinite(agentHeartbeatTimeoutMs) ||
  agentHeartbeatTimeoutMs < 500 ||
  agentHeartbeatTimeoutMs > 60000
) {
  throw new Error("AGENT_HEARTBEAT_TIMEOUT_MS must be an integer in range 500..60000.");
}

const defaultThreadMode = normalizeThreadMode(process.env.THREAD_MODE);
const defaultSharedThreadId = String(process.env.SHARED_THREAD_ID ?? "shared-main").trim();
if (!/^[A-Za-z0-9:_-]{1,120}$/.test(defaultSharedThreadId)) {
  throw new Error("SHARED_THREAD_ID has invalid format.");
}

const defaultAllowedChatIds = new Set(
  (process.env.TELEGRAM_ALLOWED_CHAT_IDS ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean),
);

fs.mkdirSync(dataDir, { recursive: true });

export const config = {
  defaultProviderKind,
  providerDefaults: {
    defaultKind: defaultProviderKind,
    codexBin,
    codexHomeDir,
    codexSandbox,
    codexApprovalPolicy,
  },
  codexBin,
  codexHomeDir,
  codexSandbox,
  codexApprovalPolicy,
  kernelRootPath,
  workspaceStrictMode,
  workspaceAllowedRoots,
  workspacePolicy,
  defaultWorkspaceRoot,
  projectsBaseDir,
  dataDir,
  botRegistryFilePath,
  secretStoreFilePath,
  instanceLockEnabled,
  instanceLockFilePath,
  bootstrapTelegramToken,
  turnActivityTimeoutMs,
  maxMessages,
  webHost,
  webPort,
  webPublicBaseUrl,
  webPublicBaseUrlExplicit,
  webPortAutoIncrement,
  webPortSearchMax,
  agentHeartbeatEnabled,
  agentHeartbeatIntervalMs,
  agentHeartbeatTimeoutMs,
  defaultThreadMode,
  defaultSharedThreadId,
  defaultAllowedChatIds,
};

function resolveCodexBin(rawValue: string | undefined): string {
  const value = String(rawValue ?? "").trim();
  const normalized = value.toLowerCase();

  if (value && normalized !== "codex") {
    return value;
  }

  if (process.platform === "win32") {
    const vscodeCodex = findVscodeCodexExe();
    if (vscodeCodex) {
      return vscodeCodex;
    }
  }

  return value || "codex";
}

function findVscodeCodexExe(): string | null {
  const userProfile = process.env.USERPROFILE;
  if (!userProfile) {
    return null;
  }

  const extensionsDir = path.join(userProfile, ".vscode", "extensions");
  if (!fs.existsSync(extensionsDir)) {
    return null;
  }

  const candidates = fs
    .readdirSync(extensionsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .filter((name) => name.startsWith("openai.chatgpt-"))
    .sort()
    .reverse();

  for (const folder of candidates) {
    const exePath = path.join(extensionsDir, folder, "bin", "windows-x86_64", "codex.exe");
    if (fs.existsSync(exePath)) {
      return exePath;
    }
  }

  return null;
}

function normalizeThreadMode(value: unknown): ThreadMode {
  const mode = String(value ?? "single")
    .trim()
    .toLowerCase();
  if (mode === "single" || mode === "per_chat") {
    return mode;
  }
  throw new Error("THREAD_MODE must be either 'single' or 'per_chat'.");
}

function parseBoolean(value: unknown): boolean {
  const normalized = String(value ?? "")
    .trim()
    .toLowerCase();
  if (normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on") {
    return true;
  }
  if (normalized === "0" || normalized === "false" || normalized === "no" || normalized === "off") {
    return false;
  }
  throw new Error("Invalid boolean value in environment.");
}

function resolveOptionalPath(value: unknown): string | null {
  const raw = String(value ?? "").trim();
  if (!raw) {
    return null;
  }
  return path.resolve(raw);
}

function normalizeCodexSandbox(value: unknown): CodexSandbox {
  const mode = String(value ?? "")
    .trim()
    .toLowerCase();
  if (mode === "read-only" || mode === "workspace-write" || mode === "danger-full-access") {
    return mode;
  }
  throw new Error("CODEX_SANDBOX must be one of: read-only, workspace-write, danger-full-access.");
}

function normalizeApprovalPolicy(value: unknown): ApprovalPolicy {
  const mode = String(value ?? "")
    .trim()
    .toLowerCase();
  if (mode === "untrusted" || mode === "on-failure" || mode === "on-request" || mode === "never") {
    return mode;
  }
  throw new Error(
    "CODEX_APPROVAL_POLICY must be one of: untrusted, on-failure, on-request, never.",
  );
}

function normalizeProviderKind(value: unknown): ProviderKind {
  const kind = String(value ?? "")
    .trim()
    .toLowerCase();
  if (!kind) {
    return "codex";
  }
  if (kind === "codex") {
    return kind;
  }
  throw new Error("DEFAULT_PROVIDER_KIND must currently be 'codex'.");
}

function resolveWorkspaceRoot(value: unknown): string {
  const raw = String(value ?? "").trim();
  if (!raw) {
    throw new Error("DEFAULT_WORKSPACE_ROOT must not be empty.");
  }
  return path.resolve(raw);
}
