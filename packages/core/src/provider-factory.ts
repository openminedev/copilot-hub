// @ts-nocheck
import { CodexProvider } from "./codex-provider.js";

export function createAssistantProvider({
  providerConfig,
  providerDefaults,
  workspaceRoot,
  turnActivityTimeoutMs,
}) {
  const defaults = providerDefaults ?? {};
  const kind = String(providerConfig?.kind ?? defaults.defaultKind ?? "codex")
    .trim()
    .toLowerCase();
  const options = providerConfig?.options ?? {};

  if (kind === "codex") {
    return new CodexProvider({
      codexBin: String(options.codexBin ?? defaults.codexBin ?? "codex"),
      codexHomeDir: options.codexHomeDir ?? defaults.codexHomeDir ?? null,
      sandboxMode: String(options.sandboxMode ?? defaults.codexSandbox ?? "workspace-write"),
      approvalPolicy: String(
        options.approvalPolicy ?? defaults.codexApprovalPolicy ?? "on-request",
      ),
      workspaceRoot,
      turnActivityTimeoutMs,
    });
  }

  throw new Error(`Unknown assistant provider kind '${kind}'.`);
}
