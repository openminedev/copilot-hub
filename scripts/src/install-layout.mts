#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

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
  const homeDir = resolveCopilotHubHomeDir({
    env,
    platform,
    homeDirectory,
  });
  const configDir = path.join(homeDir, "config");
  const dataDir = path.join(homeDir, "data");
  const logsDir = path.join(homeDir, "logs");
  const runtimeDir = path.join(homeDir, "runtime");

  void repoRoot;

  return {
    homeDir,
    configDir,
    dataDir,
    logsDir,
    runtimeDir,
    agentEngineEnvPath: path.join(configDir, "agent-engine.env"),
    controlPlaneEnvPath: path.join(configDir, "control-plane.env"),
    agentEngineDataDir: path.join(dataDir, "agent-engine"),
    controlPlaneDataDir: path.join(dataDir, "control-plane"),
    servicePromptStatePath: path.join(runtimeDir, "service-onboarding.json"),
  };
}

export function initializeCopilotHubLayout({
  repoRoot,
  layout,
}: {
  repoRoot: string;
  layout: CopilotHubLayout;
}): { migratedPaths: string[] } {
  ensureCopilotHubLayout(layout);
  const migratedPaths = migrateLegacyLayout({ repoRoot, layout });
  return { migratedPaths };
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
  const explicit = normalizePath(env.COPILOT_HUB_HOME_DIR ?? env.COPILOT_HUB_HOME ?? "");
  if (explicit) {
    return explicit;
  }

  if (platform === "win32") {
    const appData = normalizePath(env.APPDATA ?? "");
    if (appData) {
      return path.join(appData, "copilot-hub");
    }
    return path.join(homeDirectory, "AppData", "Roaming", "copilot-hub");
  }

  if (platform === "darwin") {
    return path.join(homeDirectory, "Library", "Application Support", "copilot-hub");
  }

  const xdgConfigHome = normalizePath(env.XDG_CONFIG_HOME ?? "");
  if (xdgConfigHome) {
    return path.join(xdgConfigHome, "copilot-hub");
  }
  return path.join(homeDirectory, ".config", "copilot-hub");
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

function normalizePath(value: unknown): string {
  const normalized = String(value ?? "").trim();
  return normalized ? path.resolve(normalized) : "";
}

function removeVolatileRuntimeFiles(targetDir: string): void {
  const runtimeLockPath = path.join(targetDir, "runtime.lock");
  if (fs.existsSync(runtimeLockPath)) {
    fs.rmSync(runtimeLockPath, { force: true });
  }
}
