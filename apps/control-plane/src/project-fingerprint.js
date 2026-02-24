import crypto from "node:crypto";
import path from "node:path";

export function createProjectFingerprint({ runtimeId, workspaceRoot, providerKind, channels }) {
  const stable = {
    runtimeId: String(runtimeId ?? "").trim(),
    workspaceRoot: normalizePath(workspaceRoot),
    providerKind: String(providerKind ?? "").trim().toLowerCase(),
    channels: normalizeChannels(channels)
  };

  return crypto.createHash("sha256").update(JSON.stringify(stable)).digest("hex").slice(0, 24);
}

function normalizePath(value) {
  const resolved = path.resolve(String(value ?? ""));
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function normalizeChannels(channels) {
  if (!Array.isArray(channels)) {
    return [];
  }
  return channels
    .map((channel) => ({
      kind: String(channel?.kind ?? "").trim().toLowerCase(),
      id: String(channel?.id ?? "").trim().toLowerCase()
    }))
    .sort((a, b) => `${a.kind}:${a.id}`.localeCompare(`${b.kind}:${b.id}`));
}
