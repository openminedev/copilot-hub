import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const DEFAULT_EXTERNAL_WORKSPACES_DIRNAME = "copilot_workspaces";
const DESKTOP_DIRNAME = "Desktop";

export function getKernelRootPath() {
  return path.resolve(process.cwd());
}

export function getDefaultExternalWorkspaceBasePath(_kernelRoot = getKernelRootPath()) {
  const desktopCandidates = getDesktopCandidates();
  const desktopRoot = desktopCandidates.find((candidate) => directoryExists(candidate)) ?? desktopCandidates[0];
  return path.resolve(desktopRoot, DEFAULT_EXTERNAL_WORKSPACES_DIRNAME);
}

export function resolveDefaultWorkspaceForBot(botId, kernelRoot = getKernelRootPath()) {
  const id = String(botId ?? "").trim();
  return path.resolve(getDefaultExternalWorkspaceBasePath(kernelRoot), id);
}

export function isPathInside(parentPath, candidatePath) {
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

function getDesktopCandidates() {
  const userProfile = String(process.env.USERPROFILE ?? "").trim();
  const oneDriveRoot = String(process.env.OneDrive ?? "").trim();
  const homeDir = String(os.homedir() ?? "").trim();

  const rawCandidates = [
    oneDriveRoot ? path.resolve(oneDriveRoot, DESKTOP_DIRNAME) : null,
    userProfile ? path.resolve(userProfile, DESKTOP_DIRNAME) : null,
    homeDir ? path.resolve(homeDir, DESKTOP_DIRNAME) : null
  ];

  return uniqueAbsolutePaths(rawCandidates);
}

function normalizeForCompare(value) {
  const resolved = String(value ?? "").trim();
  if (!resolved) {
    return "";
  }
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function directoryExists(candidatePath) {
  try {
    return fs.statSync(candidatePath).isDirectory();
  } catch {
    return false;
  }
}

function uniqueAbsolutePaths(values) {
  const seen = new Set();
  const output = [];

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