import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import dotenv from "dotenv";
import {
  createWorkspaceBoundaryPolicy,
  assertWorkspaceAllowed,
  parseWorkspaceAllowedRoots,
} from "@copilot-hub/core/workspace-policy";
import { parseTurnActivityTimeoutSetting } from "@copilot-hub/core/codex-app-utils";
import {
  resolveConfigBaseDir,
  resolveOptionalPathFromBase,
  resolvePathFromBase,
} from "@copilot-hub/core/config-paths";
import {
  getDefaultExternalWorkspaceBasePath,
  getKernelRootPath,
} from "@copilot-hub/core/workspace-paths";

const envBaseDir = loadEnvironment();

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
const projectsBaseDir = resolvePathFromBase(
  configuredProjectsBaseDir || defaultWorkspaceRoot,
  envBaseDir,
);
const workspaceStrictMode = parseBoolean(process.env.WORKSPACE_STRICT_MODE ?? "true");
const workspaceAllowedRoots = parseWorkspaceAllowedRoots(
  process.env.WORKSPACE_ALLOWED_ROOTS ?? "",
  {
    cwd: envBaseDir,
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

const dataDir = resolvePathFromBase(
  process.env.BOT_DATA_DIR ?? path.join(envBaseDir, "data"),
  envBaseDir,
);
const botRegistryFilePath = resolvePathFromBase(
  process.env.BOT_REGISTRY_FILE ?? path.join(dataDir, "bot-registry.json"),
  envBaseDir,
);
const secretStoreFilePath = resolvePathFromBase(
  process.env.SECRET_STORE_FILE ?? path.join(dataDir, "secrets.json"),
  envBaseDir,
);
const instanceLockEnabled = parseBoolean(process.env.INSTANCE_LOCK_ENABLED ?? "true");
const instanceLockFilePath = resolvePathFromBase(
  process.env.INSTANCE_LOCK_FILE ?? path.join(dataDir, "runtime.lock"),
  envBaseDir,
);

const bootstrapTelegramToken = String(process.env.TELEGRAM_BOT_TOKEN ?? "").trim();
const defaultProviderKind = normalizeProviderKind(process.env.DEFAULT_PROVIDER_KIND ?? "codex");
const codexBin = resolveCodexBin(process.env.CODEX_BIN);
const codexHomeDir = resolveOptionalPathFromBase(process.env.CODEX_HOME_DIR, envBaseDir);
if (codexHomeDir) {
  process.env.CODEX_HOME_DIR = codexHomeDir;
  process.env.CODEX_HOME = codexHomeDir;
}
const codexSandbox = normalizeCodexSandbox(process.env.CODEX_SANDBOX ?? "danger-full-access");
const codexApprovalPolicy = normalizeApprovalPolicy(process.env.CODEX_APPROVAL_POLICY ?? "never");

const turnActivityTimeoutMs = parseTurnActivityTimeoutSetting(
  process.env.TURN_ACTIVITY_TIMEOUT_MS ?? "0",
  0,
);

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
  envBaseDir,
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

function loadEnvironment(): string {
  const configuredEnvPath = String(process.env.COPILOT_HUB_ENV_PATH ?? "").trim();
  const resolvedEnvPath = configuredEnvPath ? path.resolve(configuredEnvPath) : "";
  const baseDir = resolveConfigBaseDir({
    configuredBaseDir: process.env.COPILOT_HUB_ENV_BASE_DIR,
    configuredEnvPath: resolvedEnvPath,
    cwd: process.cwd(),
  });
  if (configuredEnvPath) {
    process.env.COPILOT_HUB_ENV_PATH = resolvedEnvPath;
    dotenv.config({ path: resolvedEnvPath });
  } else {
    dotenv.config();
  }
  process.env.COPILOT_HUB_ENV_BASE_DIR = baseDir;
  return baseDir;
}

function resolveCodexBin(rawValue: string | undefined): string {
  const value = String(rawValue ?? "").trim();
  const normalized = value.toLowerCase();

  if (value && normalized !== "codex") {
    return value;
  }

  if (process.platform === "win32") {
    const npmGlobalCodex = findWindowsNpmGlobalCodexBin();
    if (npmGlobalCodex) {
      return npmGlobalCodex;
    }
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

function findWindowsNpmGlobalCodexBin(): string | null {
  if (process.platform !== "win32") {
    return null;
  }

  const candidates: string[] = [];
  const appData = String(process.env.APPDATA ?? "").trim();
  if (appData) {
    candidates.push(path.join(appData, "npm", "codex.cmd"));
    candidates.push(path.join(appData, "npm", "codex.exe"));
    candidates.push(path.join(appData, "npm", "codex"));
  }

  const npmPrefix = readNpmPrefix();
  if (npmPrefix) {
    candidates.push(path.join(npmPrefix, "codex.cmd"));
    candidates.push(path.join(npmPrefix, "codex.exe"));
    candidates.push(path.join(npmPrefix, "codex"));
  }

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }

  return null;
}

function readNpmPrefix(): string {
  const result = spawnNpm(["config", "get", "prefix"]);
  if (result.error || result.status !== 0) {
    return "";
  }

  const value = String(result.stdout ?? "").trim();
  if (!value || value.toLowerCase() === "undefined") {
    return "";
  }
  return value;
}

function spawnNpm(args: string[]) {
  if (process.platform === "win32") {
    const comspec = process.env.ComSpec || "cmd.exe";
    const commandLine = ["npm", ...args].join(" ");
    return spawnSync(comspec, ["/d", "/s", "/c", commandLine], {
      cwd: envBaseDir,
      stdio: ["ignore", "pipe", "pipe"],
      shell: false,
      encoding: "utf8",
    });
  }

  return spawnSync("npm", args, {
    cwd: envBaseDir,
    stdio: ["ignore", "pipe", "pipe"],
    shell: false,
    encoding: "utf8",
  });
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
  return resolvePathFromBase(raw, envBaseDir);
}
