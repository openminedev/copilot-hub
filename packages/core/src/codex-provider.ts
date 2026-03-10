import { EventEmitter } from "node:events";
import path from "node:path";
import { CodexAppClient } from "./codex-app-client.js";

type SendTurnParams = {
  sessionId: string | null;
  prompt?: string | null;
  inputItems?: unknown[];
  turnActivityTimeoutMs?: number;
  onSessionReady?: ((threadId: string) => void) | null;
};

type ProviderTurnResult = {
  sessionId: string;
  turnId: string | null;
  assistantText: string;
};

type CodexProviderInit = {
  codexBin?: string;
  codexHomeDir?: string | null;
  sandboxMode?: string;
  approvalPolicy?: string;
  model?: string | null;
  reasoningEffort?: string | null;
  serviceTier?: string | null;
  workspaceRoot: string;
  turnActivityTimeoutMs?: number;
};

export class CodexProvider extends EventEmitter {
  kind: "codex";
  workspaceRoot: string;
  client: CodexAppClient;

  constructor({
    codexBin,
    codexHomeDir,
    sandboxMode,
    approvalPolicy,
    model,
    reasoningEffort,
    serviceTier,
    workspaceRoot,
    turnActivityTimeoutMs,
  }: CodexProviderInit) {
    super();
    this.kind = "codex";
    this.workspaceRoot = path.resolve(String(workspaceRoot));
    this.client = new CodexAppClient({
      codexBin,
      codexHomeDir,
      cwd: this.workspaceRoot,
      sandboxMode,
      approvalPolicy,
      model,
      reasoningEffort,
      serviceTier,
      turnActivityTimeoutMs,
    });

    this.client.on("approvalRequested", (approval: Record<string, unknown>) => {
      this.emit("approvalRequested", {
        ...approval,
        sessionId: String(approval.threadId ?? ""),
      });
    });
    this.client.on("warning", (warning: unknown) => {
      this.emit("warning", warning);
    });
    this.client.on("stderr", (stderr: unknown) => {
      this.emit("stderr", stderr);
    });
    this.client.on("quota", (snapshot: unknown) => {
      this.emit("quota", snapshot);
    });
  }

  setWorkspaceRoot(workspaceRoot: string): void {
    this.workspaceRoot = path.resolve(String(workspaceRoot));
    this.client.setCwd(this.workspaceRoot);
  }

  async sendTurn({
    sessionId,
    prompt,
    inputItems = [],
    turnActivityTimeoutMs,
    onSessionReady = null,
  }: SendTurnParams): Promise<ProviderTurnResult> {
    const request = {
      threadId: sessionId,
      prompt,
      inputItems,
      turnActivityTimeoutMs,
      onThreadReady: onSessionReady,
    } as any;
    const result = (await this.client.sendTurn(request)) as {
      threadId?: unknown;
      turnId?: unknown;
      assistantText?: unknown;
    };
    return {
      sessionId: String(result.threadId ?? ""),
      turnId: result.turnId == null ? null : String(result.turnId),
      assistantText: String(result.assistantText ?? ""),
    };
  }

  async resolveApproval({
    approvalId,
    decision,
  }: {
    approvalId: string;
    decision: string;
  }): Promise<unknown> {
    return this.client.resolveApproval({
      approvalId,
      decision,
    });
  }

  async interruptTurn({ sessionId }: { sessionId: string | null }): Promise<unknown> {
    return this.client.interruptTurn({
      threadId: sessionId,
    });
  }

  async shutdown(): Promise<void> {
    await this.client.shutdown();
  }

  getLatestQuotaSnapshot(): unknown {
    return this.client.getLatestQuotaSnapshot();
  }
}
