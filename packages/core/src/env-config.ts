import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import dotenv from "dotenv";
import { resolveConfigBaseDir } from "./config-paths.js";

export interface LoadedCopilotHubEnvironment {
  baseDir: string;
  envPath: string | null;
  fileValues: Record<string, string>;
  overriddenKeys: string[];
}

export function loadCopilotHubEnvironment({
  env = process.env,
  cwd = process.cwd(),
  preserveExistingKeys = [],
}: {
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  preserveExistingKeys?: Iterable<string>;
} = {}): LoadedCopilotHubEnvironment {
  const configuredEnvPath = String(env.COPILOT_HUB_ENV_PATH ?? "").trim();
  const resolvedEnvPath = configuredEnvPath ? path.resolve(configuredEnvPath) : "";
  const discoveredEnvPath = resolvedEnvPath || resolveDefaultEnvPath(cwd);
  const baseDir = resolveConfigBaseDir({
    configuredBaseDir: env.COPILOT_HUB_ENV_BASE_DIR,
    configuredEnvPath: discoveredEnvPath,
    cwd,
  });
  const fileValues = loadEnvFileValues(discoveredEnvPath);
  const overriddenKeys = applyEnvFileValues(env, fileValues, preserveExistingKeys);

  if (resolvedEnvPath) {
    env.COPILOT_HUB_ENV_PATH = resolvedEnvPath;
  }
  env.COPILOT_HUB_ENV_BASE_DIR = baseDir;

  return {
    baseDir,
    envPath: discoveredEnvPath || null,
    fileValues,
    overriddenKeys,
  };
}

function resolveDefaultEnvPath(cwd: string): string {
  const candidate = path.resolve(String(cwd ?? process.cwd()), ".env");
  return fs.existsSync(candidate) ? candidate : "";
}

function loadEnvFileValues(filePath: string): Record<string, string> {
  if (!filePath || !fs.existsSync(filePath)) {
    return {};
  }

  try {
    const raw = fs.readFileSync(filePath, "utf8");
    return normalizeEnvMap(dotenv.parse(raw));
  } catch {
    return {};
  }
}

function applyEnvFileValues(
  env: NodeJS.ProcessEnv,
  fileValues: Record<string, string>,
  preserveExistingKeys: Iterable<string>,
): string[] {
  const overriddenKeys: string[] = [];
  const preservedKeys = new Set(
    [...preserveExistingKeys].map((key) => String(key ?? "").trim()).filter(Boolean),
  );

  for (const [key, value] of Object.entries(fileValues)) {
    const previousValue = String(env[key] ?? "");
    if (previousValue && preservedKeys.has(key)) {
      continue;
    }
    if (previousValue && previousValue !== value) {
      overriddenKeys.push(key);
    }
    env[key] = value;
  }

  return overriddenKeys.sort();
}

function normalizeEnvMap(value: Record<string, string>): Record<string, string> {
  const output: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value ?? {})) {
    const normalizedKey = String(key ?? "").trim();
    if (!normalizedKey) {
      continue;
    }
    output[normalizedKey] = String(entry ?? "").trim();
  }
  return output;
}
