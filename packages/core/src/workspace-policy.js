import os from "node:os";
import path from "node:path";

export function parseWorkspaceAllowedRoots(rawValue, { cwd = process.cwd() } = {}) {
  const values = String(rawValue ?? "")
    .split(",")
    .map((entry) => String(entry ?? "").trim())
    .filter(Boolean)
    .map((entry) => resolvePathToken(entry, cwd));

  return uniqueNormalizedPaths(values);
}

export function createWorkspaceBoundaryPolicy({
  kernelRootPath,
  defaultWorkspaceRoot,
  projectsBaseDir,
  strictMode = true,
  additionalAllowedRoots = []
}) {
  const kernelRoot = normalizeAbsolutePath(kernelRootPath);
  const defaultRoot = normalizeAbsolutePath(defaultWorkspaceRoot);
  const projectsRoot = normalizeAbsolutePath(projectsBaseDir);

  const allowedRoots = uniqueNormalizedPaths([
    defaultRoot,
    projectsRoot,
    ...(Array.isArray(additionalAllowedRoots) ? additionalAllowedRoots : [])
  ]);

  return {
    strictMode: strictMode === true,
    kernelRootPath: kernelRoot,
    defaultWorkspaceRoot: defaultRoot,
    projectsBaseDir: projectsRoot,
    allowedRoots
  };
}

export function assertWorkspaceAllowed({ workspaceRoot, policy, label = "workspaceRoot" }) {
  if (!policy || typeof policy !== "object") {
    return normalizeAbsolutePath(workspaceRoot);
  }

  const candidate = normalizeAbsolutePath(workspaceRoot);
  if (isPathInside(policy.kernelRootPath, candidate, { includeEqual: true })) {
    throw new Error(
      `${label} must be outside kernel directory. kernel=${policy.kernelRootPath} workspace=${candidate}`
    );
  }

  if (!policy.strictMode) {
    return candidate;
  }

  const allowedRoots = Array.isArray(policy.allowedRoots) ? policy.allowedRoots : [];
  const accepted = allowedRoots.some((root) => isPathInside(root, candidate, { includeEqual: true }));
  if (!accepted) {
    const allowedText = allowedRoots.length > 0 ? allowedRoots.join(", ") : "<none>";
    throw new Error(`${label} is outside allowed workspace roots. workspace=${candidate} allowed=${allowedText}`);
  }

  return candidate;
}

export function isPathInside(parentPath, candidatePath, { includeEqual = false } = {}) {
  const parent = normalizeForCompare(path.resolve(String(parentPath ?? "")));
  const candidate = normalizeForCompare(path.resolve(String(candidatePath ?? "")));
  if (!parent || !candidate) {
    return false;
  }

  if (parent === candidate) {
    return includeEqual;
  }

  const relative = path.relative(parent, candidate);
  return Boolean(relative) && !relative.startsWith("..") && !path.isAbsolute(relative);
}

export function normalizeAbsolutePath(value) {
  const raw = String(value ?? "").trim();
  if (!raw) {
    throw new Error("Path cannot be empty.");
  }
  return path.resolve(raw);
}

function normalizeForCompare(value) {
  const normalized = String(value ?? "").trim();
  if (!normalized) {
    return "";
  }
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function resolvePathToken(rawToken, cwd) {
  const token = String(rawToken ?? "").trim();
  if (!token) {
    return "";
  }

  if (path.isAbsolute(token)) {
    return path.resolve(token);
  }

  if (/^~[\\/]/.test(token)) {
    return path.resolve(os.homedir(), token.slice(2));
  }

  return path.resolve(String(cwd ?? process.cwd()), token);
}

function uniqueNormalizedPaths(values) {
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
