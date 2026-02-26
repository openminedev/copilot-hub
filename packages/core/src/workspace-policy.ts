import os from "node:os";
import path from "node:path";

export interface ParseWorkspaceAllowedRootsOptions {
  cwd?: string;
}

export interface CreateWorkspaceBoundaryPolicyOptions {
  kernelRootPath: string;
  defaultWorkspaceRoot: string;
  projectsBaseDir: string;
  strictMode?: boolean;
  additionalAllowedRoots?: readonly string[];
}

export interface WorkspaceBoundaryPolicy {
  strictMode: boolean;
  kernelRootPath: string;
  defaultWorkspaceRoot: string;
  projectsBaseDir: string;
  allowedRoots: string[];
}

export interface AssertWorkspaceAllowedOptions {
  workspaceRoot: string;
  policy?: WorkspaceBoundaryPolicy | null;
  label?: string;
}

export interface IsPathInsideOptions {
  includeEqual?: boolean;
}

export function parseWorkspaceAllowedRoots(
  rawValue: string,
  { cwd = process.cwd() }: ParseWorkspaceAllowedRootsOptions = {},
): string[] {
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
  additionalAllowedRoots = [],
}: CreateWorkspaceBoundaryPolicyOptions): WorkspaceBoundaryPolicy {
  const kernelRoot = normalizeAbsolutePath(kernelRootPath);
  const defaultRoot = normalizeAbsolutePath(defaultWorkspaceRoot);
  const projectsRoot = normalizeAbsolutePath(projectsBaseDir);

  const allowedRoots = uniqueNormalizedPaths([
    defaultRoot,
    projectsRoot,
    ...(Array.isArray(additionalAllowedRoots) ? additionalAllowedRoots : []),
  ]);

  return {
    strictMode: strictMode === true,
    kernelRootPath: kernelRoot,
    defaultWorkspaceRoot: defaultRoot,
    projectsBaseDir: projectsRoot,
    allowedRoots,
  };
}

export function assertWorkspaceAllowed({
  workspaceRoot,
  policy,
  label = "workspaceRoot",
}: AssertWorkspaceAllowedOptions): string {
  if (!policy || typeof policy !== "object") {
    return normalizeAbsolutePath(workspaceRoot);
  }

  const candidate = normalizeAbsolutePath(workspaceRoot);
  if (isPathInside(policy.kernelRootPath, candidate, { includeEqual: true })) {
    throw new Error(
      `${label} must be outside kernel directory. kernel=${policy.kernelRootPath} workspace=${candidate}`,
    );
  }

  if (!policy.strictMode) {
    return candidate;
  }

  const allowedRoots = Array.isArray(policy.allowedRoots) ? policy.allowedRoots : [];
  const accepted = allowedRoots.some((root) =>
    isPathInside(root, candidate, { includeEqual: true }),
  );
  if (!accepted) {
    const allowedText = allowedRoots.length > 0 ? allowedRoots.join(", ") : "<none>";
    throw new Error(
      `${label} is outside allowed workspace roots. workspace=${candidate} allowed=${allowedText}`,
    );
  }

  return candidate;
}

export function isPathInside(
  parentPath: string,
  candidatePath: string,
  { includeEqual = false }: IsPathInsideOptions = {},
): boolean {
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

export function normalizeAbsolutePath(value: string): string {
  const raw = String(value ?? "").trim();
  if (!raw) {
    throw new Error("Path cannot be empty.");
  }
  return path.resolve(raw);
}

function normalizeForCompare(value: string): string {
  const normalized = String(value ?? "").trim();
  if (!normalized) {
    return "";
  }
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function resolvePathToken(rawToken: string, cwd: string): string {
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

function uniqueNormalizedPaths(values: readonly string[]): string[] {
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
