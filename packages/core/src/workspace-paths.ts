import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

export const DEFAULT_EXTERNAL_WORKSPACES_DIRNAME = "copilot_workspaces";
const DESKTOP_DIRNAME = "Desktop";

export function getKernelRootPath(): string {
  return resolveKernelRootPath();
}

export function resolveKernelRootPath({
  env = process.env,
  moduleUrl = import.meta.url,
  cwd = process.cwd(),
}: {
  env?: NodeJS.ProcessEnv;
  moduleUrl?: string;
  cwd?: string;
} = {}): string {
  const configuredRoot = String(env.COPILOT_HUB_KERNEL_ROOT ?? "").trim();
  if (configuredRoot) {
    return path.resolve(configuredRoot);
  }

  const moduleFilePath = String(moduleUrl ?? "").trim();
  if (moduleFilePath) {
    return path.resolve(path.dirname(fileURLToPath(moduleFilePath)), "..", "..", "..");
  }

  return path.resolve(String(cwd ?? process.cwd()));
}

export function getDefaultExternalWorkspaceBasePath(kernelRoot = getKernelRootPath()): string {
  return resolveExternalWorkspaceBasePath({
    kernelRootPath: kernelRoot,
  });
}

export function resolveExternalWorkspaceBasePath({
  kernelRootPath,
  desktopCandidates = getDesktopCandidates(),
  homeDir = os.homedir(),
  tempDir = os.tmpdir(),
}: {
  kernelRootPath: string;
  desktopCandidates?: readonly string[];
  homeDir?: string;
  tempDir?: string;
}): string {
  const desktopRoot =
    desktopCandidates.find((candidate) => directoryExists(candidate)) ??
    desktopCandidates[0] ??
    path.resolve(String(homeDir ?? "").trim() || process.cwd(), DESKTOP_DIRNAME);

  const preferredRoot = path.resolve(desktopRoot, DEFAULT_EXTERNAL_WORKSPACES_DIRNAME);
  if (!isPathInside(kernelRootPath, preferredRoot)) {
    return preferredRoot;
  }

  const homeFallbackRoot = path.resolve(
    String(homeDir ?? "").trim() || process.cwd(),
    DEFAULT_EXTERNAL_WORKSPACES_DIRNAME,
  );
  if (!isPathInside(kernelRootPath, homeFallbackRoot)) {
    return homeFallbackRoot;
  }

  return path.resolve(
    String(tempDir ?? "").trim() || process.cwd(),
    DEFAULT_EXTERNAL_WORKSPACES_DIRNAME,
  );
}

export function resolveDefaultWorkspaceForBot(
  botId: unknown,
  kernelRoot = getKernelRootPath(),
): string {
  const id = String(botId ?? "").trim();
  return path.resolve(getDefaultExternalWorkspaceBasePath(kernelRoot), id);
}

export function isPathInside(parentPath: unknown, candidatePath: unknown): boolean {
  const normalizedParent = normalizeForCompare(path.resolve(String(parentPath ?? "")));
  const normalizedCandidate = normalizeForCompare(path.resolve(String(candidatePath ?? "")));
  if (!normalizedParent || !normalizedCandidate) {
    return false;
  }
  if (normalizedParent === normalizedCandidate) {
    return true;
  }

  const relative = path.relative(normalizedParent, normalizedCandidate);
  return Boolean(relative) && !relative.startsWith("..") && !path.isAbsolute(relative);
}

function getDesktopCandidates(): string[] {
  const userProfile = String(process.env.USERPROFILE ?? "").trim();
  const oneDriveRoot = String(process.env.OneDrive ?? "").trim();
  const homeDir = String(os.homedir() ?? "").trim();

  const rawCandidates = [
    oneDriveRoot ? path.resolve(oneDriveRoot, DESKTOP_DIRNAME) : null,
    userProfile ? path.resolve(userProfile, DESKTOP_DIRNAME) : null,
    homeDir ? path.resolve(homeDir, DESKTOP_DIRNAME) : null,
  ];

  return uniqueAbsolutePaths(rawCandidates);
}

function normalizeForCompare(value: string): string {
  const resolved = String(value ?? "").trim();
  if (!resolved) {
    return "";
  }
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function directoryExists(candidatePath: string): boolean {
  try {
    return fs.statSync(candidatePath).isDirectory();
  } catch {
    return false;
  }
}

function uniqueAbsolutePaths(values: Array<string | null>): string[] {
  const seen = new Set<string>();
  const output: string[] = [];

  for (const value of values) {
    const raw = String(value ?? "").trim();
    if (!raw) {
      continue;
    }
    const absolute = path.resolve(raw);
    const normalized = normalizeForCompare(absolute);
    if (!normalized || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    output.push(absolute);
  }

  return output;
}
