import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const DEFAULT_EXTERNAL_WORKSPACES_DIRNAME = "copilot_workspaces";
const DESKTOP_DIRNAME = "Desktop";

export function getKernelRootPath(): string {
  return path.resolve(process.cwd());
}

export function getDefaultExternalWorkspaceBasePath(_kernelRoot = getKernelRootPath()): string {
  const desktopCandidates = getDesktopCandidates();
  const fallbackDesktop = path.resolve(process.cwd(), DESKTOP_DIRNAME);
  const desktopRoot =
    desktopCandidates.find((candidate) => directoryExists(candidate)) ??
    desktopCandidates[0] ??
    fallbackDesktop;
  return path.resolve(desktopRoot, DEFAULT_EXTERNAL_WORKSPACES_DIRNAME);
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
