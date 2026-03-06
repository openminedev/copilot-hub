export type JsonObject = Record<string, unknown>;

export type SandboxMode = "read-only" | "workspace-write" | "danger-full-access";
export type ApprovalPolicy = "untrusted" | "on-failure" | "on-request" | "never";
export type ModelValue = string | null;
export type ApprovalDecision = "accept" | "acceptForSession" | "decline" | "cancel";

export function normalizeSandboxMode(value: unknown): SandboxMode {
  const mode = String(value ?? "danger-full-access")
    .trim()
    .toLowerCase();
  if (mode === "read-only" || mode === "workspace-write" || mode === "danger-full-access") {
    return mode;
  }
  return "danger-full-access";
}

export function normalizeApprovalPolicy(value: unknown): ApprovalPolicy {
  const mode = String(value ?? "never")
    .trim()
    .toLowerCase();
  if (mode === "untrusted" || mode === "on-failure" || mode === "on-request" || mode === "never") {
    return mode;
  }
  return "never";
}

export function normalizeModel(value: unknown): ModelValue {
  if (value === null || value === undefined) {
    return null;
  }

  const normalized = String(value).trim();
  if (!normalized) {
    return null;
  }

  const keyword = normalized.toLowerCase();
  if (keyword === "auto" || keyword === "default") {
    return null;
  }

  return normalized;
}

export function normalizeApprovalDecision(value: unknown): ApprovalDecision {
  const decision = String(value ?? "")
    .trim()
    .toLowerCase();
  if (decision === "accept" || decision === "approve" || decision === "approved") {
    return "accept";
  }
  if (decision === "acceptforsession" || decision === "always") {
    return "acceptForSession";
  }
  if (
    decision === "decline" ||
    decision === "deny" ||
    decision === "denied" ||
    decision === "reject"
  ) {
    return "decline";
  }
  if (decision === "cancel" || decision === "abort") {
    return "cancel";
  }
  throw new Error("decision must be one of: accept, acceptForSession, decline, cancel.");
}

export function normalizeTimeout(value: unknown, fallback: number): number {
  const parsed = Number.parseInt(String(value ?? fallback), 10);
  if (!Number.isFinite(parsed) || parsed < 1_000) {
    return fallback;
  }
  return parsed;
}

export function normalizeCliPath(value: string): string {
  if (process.platform !== "win32") {
    return value;
  }
  return String(value).replace(/\\/g, "/");
}

export function makeTurnKey(threadId: string, turnId: string): string {
  return `${String(threadId ?? "")}::${String(turnId ?? "")}`;
}

export function createApprovalId(): string {
  return `apr_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
}

export function annotateSpawnError(error: unknown, command: string): Error {
  if (!(error instanceof Error)) {
    return new Error(String(error ?? "Unknown spawn error."));
  }
  const errnoError = error as NodeJS.ErrnoException;

  if (errnoError.code === "ENOENT") {
    return new Error(
      [
        `Cannot execute Codex binary '${command}' (ENOENT).`,
        "Set CODEX_BIN to a valid executable (example: C:\\Users\\<you>\\...\\codex.exe) or ensure it is on PATH.",
      ].join("\n"),
    );
  }

  if (process.platform === "win32" && errnoError.code === "EPERM") {
    return new Error(
      [
        `Cannot execute Codex binary '${command}' (EPERM).`,
        "On Windows, verify CODEX_BIN points to an executable and that permissions allow process spawn.",
      ].join("\n"),
    );
  }

  return error;
}

export function normalizeTurnInputItems({
  prompt,
  inputItems,
}: {
  prompt: string;
  inputItems: unknown[];
}): Array<{ type: string; text?: string; url?: string; path?: string }> {
  const items: Array<{ type: string; text?: string; url?: string; path?: string }> = [];
  const text = String(prompt ?? "").trim();
  if (text) {
    items.push({
      type: "text",
      text,
    });
  }

  if (Array.isArray(inputItems)) {
    for (const entry of inputItems) {
      const parsedEntry = asRecord(entry);
      const type = String(parsedEntry.type ?? "")
        .trim()
        .toLowerCase();

      if (type === "image") {
        const url = String(parsedEntry.url ?? "").trim();
        if (!url) {
          throw new Error("Image input item requires a non-empty url.");
        }
        items.push({
          type: "image",
          url,
        });
        continue;
      }

      if (type === "localimage") {
        const localPath = String(parsedEntry.path ?? "").trim();
        if (!localPath) {
          throw new Error("localImage input item requires a non-empty path.");
        }
        items.push({
          type: "localImage",
          path: localPath,
        });
      }
    }
  }

  if (items.length === 0) {
    throw new Error("Prompt cannot be empty.");
  }
  return items;
}

export function sanitizeError(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  return raw.split(/\r?\n/).slice(0, 12).join("\n");
}

export function isRecord(value: unknown): value is JsonObject {
  return value !== null && typeof value === "object";
}

export function asRecord(value: unknown): JsonObject {
  return isRecord(value) ? value : {};
}

export function toRequestId(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim()) {
    const parsed = Number.parseInt(value, 10);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

export function toRpcId(value: unknown): string | number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim()) {
    return value;
  }
  return null;
}
