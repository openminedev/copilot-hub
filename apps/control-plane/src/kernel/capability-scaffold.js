import fs from "node:fs/promises";
import path from "node:path";
import { KERNEL_VERSION } from "./kernel-version.js";

const CAPABILITY_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export function normalizeCapabilityId(value) {
  const capabilityId = String(value ?? "").trim();
  if (
    !CAPABILITY_ID_PATTERN.test(capabilityId) ||
    capabilityId === "." ||
    capabilityId === ".." ||
    capabilityId.includes("..")
  ) {
    throw new Error("Invalid capabilityId. Allowed: letters, numbers, dot, underscore, dash.");
  }
  return capabilityId;
}

export function normalizeCapabilityName(value, capabilityId) {
  const fallback = String(capabilityId ?? "").trim() || "capability";
  const name = String(value ?? "").trim();
  if (!name) {
    return fallback;
  }
  return name.slice(0, 120);
}

export async function scaffoldCapabilityInWorkspace({ workspaceRoot, capabilityId, capabilityName, kernelVersion }) {
  const resolvedWorkspaceRoot = path.resolve(String(workspaceRoot ?? "").trim() || process.cwd());
  const normalizedCapabilityId = normalizeCapabilityId(capabilityId);
  const normalizedCapabilityName = normalizeCapabilityName(capabilityName, normalizedCapabilityId);
  const minKernelVersion = String(kernelVersion ?? KERNEL_VERSION).trim() || KERNEL_VERSION;

  const capabilitiesBaseDir = path.resolve(resolvedWorkspaceRoot, "capabilities");
  const capabilityDir = path.resolve(capabilitiesBaseDir, normalizedCapabilityId);
  assertPathInsideBase(capabilityDir, capabilitiesBaseDir);
  const manifestPath = path.resolve(capabilityDir, "manifest.json");
  const entryPath = path.resolve(capabilityDir, "index.js");
  const manifestPathForRegistry = path.posix.join("capabilities", normalizedCapabilityId, "manifest.json");

  await fs.mkdir(capabilityDir, { recursive: true });

  const manifestExists = await fileExists(manifestPath);
  const entryExists = await fileExists(entryPath);

  if (!manifestExists) {
    const manifest = {
      id: normalizedCapabilityId,
      name: normalizedCapabilityName,
      version: "0.1.0",
      entry: "./index.js",
      minKernelVersion,
      timeoutMs: 5000,
      hooks: ["onTurnStart"],
      permissions: []
    };
    await fs.writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  }

  if (!entryExists) {
    const source = buildCapabilityEntryTemplate(normalizedCapabilityId);
    await fs.writeFile(entryPath, source, "utf8");
  }

  return {
    capabilityId: normalizedCapabilityId,
    capabilityName: normalizedCapabilityName,
    workspaceRoot: resolvedWorkspaceRoot,
    capabilityDir,
    manifestPath,
    entryPath,
    manifestPathForRegistry,
    files: {
      manifest: {
        path: manifestPath,
        created: !manifestExists
      },
      entry: {
        path: entryPath,
        created: !entryExists
      }
    }
  };
}

function buildCapabilityEntryTemplate(capabilityId) {
  const safeId = String(capabilityId ?? "").trim();
  return [
    "export function createCapability({ runtimeId, capabilityId, options }) {",
    "  return {",
    "    async onRuntimeStart() {",
    `      console.log(\`[\${runtimeId}] capability '${safeId}' loaded.\`);`,
    "    },",
    "",
    "    async onTurnStart({ prompt, metadata }) {",
    "      return {",
    "        prompt,",
    "        metadata: {",
    "          ...metadata,",
    "          capabilityId,",
    "          capabilityOptions: options ?? {}",
    "        }",
    "      };",
    "    }",
    "  };",
    "}",
    ""
  ].join("\n");
}

async function fileExists(filePath) {
  try {
    const stat = await fs.stat(filePath);
    return stat.isFile();
  } catch {
    return false;
  }
}

function assertPathInsideBase(targetPath, basePath) {
  const normalizedTarget = path.resolve(String(targetPath ?? ""));
  const normalizedBase = path.resolve(String(basePath ?? ""));
  const relative = path.relative(normalizedBase, normalizedTarget);
  if (!relative || relative === ".") {
    return;
  }
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("Capability path escapes workspace capabilities directory.");
  }
}
