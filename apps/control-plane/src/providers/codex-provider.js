import { EventEmitter } from "node:events";
import path from "node:path";
import { CodexAppClient } from "../codex-app-client.js";

export class CodexProvider extends EventEmitter {
  constructor({ codexBin, codexHomeDir, sandboxMode, approvalPolicy, workspaceRoot, turnActivityTimeoutMs }) {
    super();
    this.kind = "codex";
    this.workspaceRoot = path.resolve(String(workspaceRoot));
    this.client = new CodexAppClient({
      codexBin,
      codexHomeDir,
      cwd: this.workspaceRoot,
      sandboxMode,
      approvalPolicy,
      turnActivityTimeoutMs
    });

    this.client.on("approvalRequested", (approval) => {
      this.emit("approvalRequested", {
        ...approval,
        sessionId: String(approval.threadId ?? "")
      });
    });
    this.client.on("warning", (warning) => {
      this.emit("warning", warning);
    });
    this.client.on("stderr", (stderr) => {
      this.emit("stderr", stderr);
    });
  }

  setWorkspaceRoot(workspaceRoot) {
    this.workspaceRoot = path.resolve(String(workspaceRoot));
    this.client.setCwd(this.workspaceRoot);
  }

  async sendTurn({ sessionId, prompt, turnActivityTimeoutMs, onSessionReady = null }) {
    const result = await this.client.sendTurn({
      threadId: sessionId,
      prompt,
      turnActivityTimeoutMs,
      onThreadReady: onSessionReady
    });
    return {
      sessionId: result.threadId,
      turnId: result.turnId,
      assistantText: result.assistantText
    };
  }

  async resolveApproval({ approvalId, decision }) {
    return this.client.resolveApproval({
      approvalId,
      decision
    });
  }

  async interruptTurn({ sessionId }) {
    return this.client.interruptTurn({
      threadId: sessionId
    });
  }

  async shutdown() {
    await this.client.shutdown();
  }
}
