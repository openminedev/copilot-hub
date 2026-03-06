import { CodexProvider } from "./codex-provider.js";

type UnknownRecord = Record<string, unknown>;

type ProviderConfig = {
  kind?: unknown;
  options?: unknown;
} | null;

type ProviderDefaults = {
  defaultKind?: unknown;
  codexBin?: unknown;
  codexHomeDir?: unknown;
  codexSandbox?: unknown;
  codexApprovalPolicy?: unknown;
  codexModel?: unknown;
} | null;

type CreateAssistantProviderParams = {
  providerConfig?: ProviderConfig;
  providerDefaults?: ProviderDefaults;
  workspaceRoot: string;
  turnActivityTimeoutMs?: number;
};

export function createAssistantProvider({
  providerConfig,
  providerDefaults,
  workspaceRoot,
  turnActivityTimeoutMs,
}: CreateAssistantProviderParams): CodexProvider {
  const defaults = asRecord(providerDefaults);
  const provider = asRecord(providerConfig);
  const kind = String(provider.kind ?? defaults.defaultKind ?? "codex")
    .trim()
    .toLowerCase();
  const options = asRecord(provider.options);

  if (kind === "codex") {
    const codexProviderConfig = {
      codexBin: String(options.codexBin ?? defaults.codexBin ?? "codex"),
      codexHomeDir: normalizeOptionalString(options.codexHomeDir ?? defaults.codexHomeDir),
      sandboxMode: String(options.sandboxMode ?? defaults.codexSandbox ?? "danger-full-access"),
      approvalPolicy: String(options.approvalPolicy ?? defaults.codexApprovalPolicy ?? "never"),
      model: normalizeOptionalString(options.model ?? defaults.codexModel),
      workspaceRoot,
      ...(turnActivityTimeoutMs === undefined ? {} : { turnActivityTimeoutMs }),
    };
    return new CodexProvider(codexProviderConfig);
  }

  throw new Error(`Unknown assistant provider kind '${kind}'.`);
}

function asRecord(value: unknown): UnknownRecord {
  return value && typeof value === "object" ? (value as UnknownRecord) : {};
}

function normalizeOptionalString(value: unknown): string | null {
  if (value === null || value === undefined) {
    return null;
  }
  const normalized = String(value).trim();
  return normalized || null;
}
