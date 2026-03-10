import path from "node:path";
import process from "node:process";

export function resolveConfigBaseDir({
  configuredBaseDir,
  configuredEnvPath,
  cwd = process.cwd(),
}: {
  configuredBaseDir?: string | null | undefined;
  configuredEnvPath?: string | null | undefined;
  cwd?: string;
} = {}): string {
  const explicitBaseDir = normalizePath(configuredBaseDir);
  if (explicitBaseDir) {
    return explicitBaseDir;
  }

  const envPath = normalizePath(configuredEnvPath);
  if (envPath) {
    return path.dirname(envPath);
  }

  return path.resolve(cwd);
}

export function resolveProcessConfigBaseDir({
  env = process.env,
  cwd = process.cwd(),
}: {
  env?: NodeJS.ProcessEnv;
  cwd?: string;
} = {}): string {
  return resolveConfigBaseDir({
    configuredBaseDir: env.COPILOT_HUB_ENV_BASE_DIR,
    configuredEnvPath: env.COPILOT_HUB_ENV_PATH,
    cwd,
  });
}

export function resolvePathFromBase(value: unknown, baseDir: string): string {
  const raw = String(value ?? "").trim();
  if (!raw) {
    throw new Error("Path value must not be empty.");
  }
  return path.resolve(baseDir, raw);
}

export function resolveOptionalPathFromBase(value: unknown, baseDir: string): string | null {
  const raw = String(value ?? "").trim();
  if (!raw) {
    return null;
  }
  return resolvePathFromBase(raw, baseDir);
}

function normalizePath(value: unknown): string {
  const raw = String(value ?? "").trim();
  if (!raw) {
    return "";
  }
  return path.resolve(raw);
}
