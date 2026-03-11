#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { parseEnvMap, readEnvLines, removeEnvKeys, writeEnvLines } from "./env-file-utils.mjs";

export type CopilotHubLayout = {
  homeDir: string;
  configDir: string;
  dataDir: string;
  logsDir: string;
  runtimeDir: string;
  agentEngineEnvPath: string;
  controlPlaneEnvPath: string;
  agentEngineDataDir: string;
  controlPlaneDataDir: string;
  servicePromptStatePath: string;
};

export function resolveCopilotHubLayout({
  repoRoot,
  env = process.env,
  platform = process.platform,
  homeDirectory = os.homedir(),
}: {
  repoRoot: string;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  homeDirectory?: string;
}): CopilotHubLayout {
  const pathApi = getPathApi(platform);
  const homeDir = resolveCopilotHubHomeDir({
    env,
    platform,
    homeDirectory,
  });
  const configDir = pathApi.join(homeDir, "config");
  const dataDir = pathApi.join(homeDir, "data");
  const logsDir = pathApi.join(homeDir, "logs");
  const runtimeDir = pathApi.join(homeDir, "runtime");

  void repoRoot;

  return {
    homeDir,
    configDir,
    dataDir,
    logsDir,
    runtimeDir,
    agentEngineEnvPath: pathApi.join(configDir, "agent-engine.env"),
    controlPlaneEnvPath: pathApi.join(configDir, "control-plane.env"),
    agentEngineDataDir: pathApi.join(dataDir, "agent-engine"),
    controlPlaneDataDir: pathApi.join(dataDir, "control-plane"),
    servicePromptStatePath: pathApi.join(runtimeDir, "service-onboarding.json"),
  };
}

export function initializeCopilotHubLayout({
  repoRoot,
  layout,
}: {
  repoRoot: string;
  layout: CopilotHubLayout;
}): { migratedPaths: string[]; normalizedEnvPaths: string[] } {
  ensureCopilotHubLayout(layout);
  const migratedPaths = migrateLegacyLayout({ repoRoot, layout });
  const normalizedEnvPaths = normalizePersistentEnvFiles(layout);
  return { migratedPaths, normalizedEnvPaths };
}

export function resetCopilotHubConfig({ layout }: { layout: CopilotHubLayout }): {
  removedPaths: string[];
} {
  const removedPaths: string[] = [];

  for (const target of [layout.configDir, layout.dataDir, layout.logsDir]) {
    if (!fs.existsSync(target)) {
      continue;
    }
    fs.rmSync(target, { recursive: true, force: true });
    removedPaths.push(target);
  }

  const runtimeTargets = [
    path.join(layout.runtimeDir, "pids"),
    path.join(layout.runtimeDir, "services"),
    path.join(layout.runtimeDir, "last-startup-error.json"),
    layout.servicePromptStatePath,
  ];
  for (const target of runtimeTargets) {
    if (!fs.existsSync(target)) {
      continue;
    }
    fs.rmSync(target, { recursive: true, force: true });
    removedPaths.push(target);
  }

  ensureCopilotHubLayout(layout);
  return {
    removedPaths: removedPaths.sort(),
  };
}

export function ensureCopilotHubLayout(layout: CopilotHubLayout): void {
  fs.mkdirSync(layout.homeDir, { recursive: true });
  fs.mkdirSync(layout.configDir, { recursive: true });
  fs.mkdirSync(layout.dataDir, { recursive: true });
  fs.mkdirSync(layout.logsDir, { recursive: true });
  fs.mkdirSync(layout.runtimeDir, { recursive: true });
}

export function resolveCopilotHubHomeDir({
  env = process.env,
  platform = process.platform,
  homeDirectory = os.homedir(),
}: {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  homeDirectory?: string;
} = {}): string {
  const pathApi = getPathApi(platform);
  const explicit = normalizePath(env.COPILOT_HUB_HOME_DIR ?? env.COPILOT_HUB_HOME ?? "", pathApi);
  if (explicit) {
    return explicit;
  }

  if (platform === "win32") {
    const appData = normalizePath(env.APPDATA ?? "", pathApi);
    if (appData) {
      return pathApi.join(appData, "copilot-hub");
    }
    return pathApi.join(homeDirectory, "AppData", "Roaming", "copilot-hub");
  }

  if (platform === "darwin") {
    return pathApi.join(homeDirectory, "Library", "Application Support", "copilot-hub");
  }

  const xdgConfigHome = normalizePath(env.XDG_CONFIG_HOME ?? "", pathApi);
  if (xdgConfigHome) {
    return pathApi.join(xdgConfigHome, "copilot-hub");
  }
  return pathApi.join(homeDirectory, ".config", "copilot-hub");
}

function migrateLegacyLayout({
  repoRoot,
  layout,
}: {
  repoRoot: string;
  layout: CopilotHubLayout;
}): string[] {
  const migratedPaths: string[] = [];
  const legacy = resolveLegacyPaths(repoRoot);

  if (copyFileIfMissing(legacy.agentEngineEnvPath, layout.agentEngineEnvPath)) {
    migratedPaths.push(layout.agentEngineEnvPath);
  }
  if (copyFileIfMissing(legacy.controlPlaneEnvPath, layout.controlPlaneEnvPath)) {
    migratedPaths.push(layout.controlPlaneEnvPath);
  }
  if (copyDirectoryIfMissing(legacy.agentEngineDataDir, layout.agentEngineDataDir)) {
    migratedPaths.push(layout.agentEngineDataDir);
  }
  if (copyDirectoryIfMissing(legacy.controlPlaneDataDir, layout.controlPlaneDataDir)) {
    migratedPaths.push(layout.controlPlaneDataDir);
  }
  if (copyFileIfMissing(legacy.servicePromptStatePath, layout.servicePromptStatePath)) {
    migratedPaths.push(layout.servicePromptStatePath);
  }

  return migratedPaths;
}

function normalizePersistentEnvFiles(layout: CopilotHubLayout): string[] {
  const normalizedPaths: string[] = [];

  if (
    normalizePersistentEnvFile(layout.agentEngineEnvPath, [
      {
        key: "BOT_DATA_DIR",
        legacyValues: ["./data"],
        wrongResolvedPath: path.join(layout.configDir, "data"),
      },
      {
        key: "BOT_REGISTRY_FILE",
        legacyValues: ["./data/bot-registry.json"],
        wrongResolvedPath: path.join(layout.configDir, "data", "bot-registry.json"),
      },
      {
        key: "SECRET_STORE_FILE",
        legacyValues: ["./data/secrets.json"],
        wrongResolvedPath: path.join(layout.configDir, "data", "secrets.json"),
      },
      {
        key: "INSTANCE_LOCK_FILE",
        legacyValues: ["./data/runtime.lock"],
        wrongResolvedPath: path.join(layout.configDir, "data", "runtime.lock"),
      },
    ])
  ) {
    normalizedPaths.push(layout.agentEngineEnvPath);
  }

  if (
    normalizePersistentEnvFile(layout.controlPlaneEnvPath, [
      {
        key: "BOT_DATA_DIR",
        legacyValues: ["./data"],
        wrongResolvedPath: path.join(layout.configDir, "data"),
      },
      {
        key: "BOT_REGISTRY_FILE",
        legacyValues: ["./data/bot-registry.json"],
        wrongResolvedPath: path.join(layout.configDir, "data", "bot-registry.json"),
      },
      {
        key: "SECRET_STORE_FILE",
        legacyValues: ["./data/secrets.json"],
        wrongResolvedPath: path.join(layout.configDir, "data", "secrets.json"),
      },
      {
        key: "INSTANCE_LOCK_FILE",
        legacyValues: ["./data/runtime.lock"],
        wrongResolvedPath: path.join(layout.configDir, "data", "runtime.lock"),
      },
      {
        key: "HUB_DATA_DIR",
        legacyValues: ["./data/copilot_hub"],
        wrongResolvedPath: path.join(layout.configDir, "data", "copilot_hub"),
      },
    ])
  ) {
    normalizedPaths.push(layout.controlPlaneEnvPath);
  }

  return normalizedPaths.sort();
}

function normalizePersistentEnvFile(
  filePath: string,
  rules: Array<{ key: string; legacyValues: string[]; wrongResolvedPath: string }>,
): boolean {
  if (!fs.existsSync(filePath)) {
    return false;
  }

  const lines = readEnvLines(filePath);
  const envMap = parseEnvMap(lines);
  const keysToRemove = rules
    .filter((rule) =>
      shouldRemoveLegacyManagedPath(envMap[rule.key], {
        legacyValues: rule.legacyValues,
        wrongResolvedPath: rule.wrongResolvedPath,
        configBaseDir: path.dirname(filePath),
      }),
    )
    .map((rule) => rule.key);

  if (keysToRemove.length === 0) {
    return false;
  }

  removeEnvKeys(lines, keysToRemove);
  writeEnvLines(filePath, lines);
  return true;
}

function shouldRemoveLegacyManagedPath(
  rawValue: string | undefined,
  {
    legacyValues,
    wrongResolvedPath,
    configBaseDir,
  }: {
    legacyValues: string[];
    wrongResolvedPath: string;
    configBaseDir: string;
  },
): boolean {
  const value = String(rawValue ?? "").trim();
  if (!value) {
    return false;
  }

  const normalizedValue = normalizeForCompare(value);
  if (legacyValues.some((entry) => normalizeForCompare(entry) === normalizedValue)) {
    return true;
  }

  if (path.isAbsolute(value)) {
    return normalizeForCompare(value) === normalizeForCompare(wrongResolvedPath);
  }

  return (
    normalizeForCompare(path.resolve(configBaseDir, value)) ===
    normalizeForCompare(wrongResolvedPath)
  );
}

function resolveLegacyPaths(repoRoot: string): {
  agentEngineEnvPath: string;
  controlPlaneEnvPath: string;
  agentEngineDataDir: string;
  controlPlaneDataDir: string;
  servicePromptStatePath: string;
} {
  return {
    agentEngineEnvPath: path.join(repoRoot, "apps", "agent-engine", ".env"),
    controlPlaneEnvPath: path.join(repoRoot, "apps", "control-plane", ".env"),
    agentEngineDataDir: path.join(repoRoot, "apps", "agent-engine", "data"),
    controlPlaneDataDir: path.join(repoRoot, "apps", "control-plane", "data"),
    servicePromptStatePath: path.join(repoRoot, ".copilot-hub", "service-onboarding.json"),
  };
}

function copyFileIfMissing(sourcePath: string, targetPath: string): boolean {
  if (!fs.existsSync(sourcePath) || fs.existsSync(targetPath)) {
    return false;
  }
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  fs.copyFileSync(sourcePath, targetPath);
  return true;
}

function copyDirectoryIfMissing(sourceDir: string, targetDir: string): boolean {
  if (!fs.existsSync(sourceDir) || !fs.statSync(sourceDir).isDirectory()) {
    return false;
  }
  if (directoryHasEntries(targetDir)) {
    return false;
  }
  fs.mkdirSync(path.dirname(targetDir), { recursive: true });
  fs.cpSync(sourceDir, targetDir, {
    recursive: true,
    errorOnExist: false,
    force: false,
  });
  removeVolatileRuntimeFiles(targetDir);
  return true;
}

function directoryHasEntries(directoryPath: string): boolean {
  if (!fs.existsSync(directoryPath)) {
    return false;
  }
  try {
    return fs.readdirSync(directoryPath).length > 0;
  } catch {
    return false;
  }
}

function normalizePath(value: unknown, pathApi: typeof path.posix | typeof path.win32): string {
  const normalized = String(value ?? "").trim();
  return normalized ? pathApi.resolve(normalized) : "";
}

function normalizeForCompare(value: unknown): string {
  const normalized = String(value ?? "").trim();
  if (!normalized) {
    return "";
  }
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function getPathApi(platform: NodeJS.Platform): typeof path.posix | typeof path.win32 {
  return platform === "win32" ? path.win32 : path.posix;
}

function removeVolatileRuntimeFiles(targetDir: string): void {
  const runtimeLockPath = path.join(targetDir, "runtime.lock");
  if (fs.existsSync(runtimeLockPath)) {
    fs.rmSync(runtimeLockPath, { force: true });
  }
}
