import { normalizeThreadId } from "./thread-id.js";

const DEFAULT_MAX_MESSAGES = 200;

export class ConversationEngine {
  constructor({
    store,
    assistantProvider,
    projectRoot,
    turnActivityTimeoutMs,
    maxMessages = DEFAULT_MAX_MESSAGES,
    onApprovalRequested = null
  }) {
    this.store = store;
    this.assistantProvider = assistantProvider;
    this.projectRoot = projectRoot;
    this.turnActivityTimeoutMs = Number.parseInt(String(turnActivityTimeoutMs), 10) || 3600000;
    this.maxMessages = maxMessages;
    this.queueByThread = new Map();
    this.threadByProviderSession = new Map();
    this.turnContextByThread = new Map();
    this.pendingApprovalsByThread = new Map();
    this.onApprovalRequested = typeof onApprovalRequested === "function" ? onApprovalRequested : null;

    this.assistantProvider.on("approvalRequested", (approval) => {
      void this.#handleApprovalRequested(approval).catch((error) => {
        console.error(`Approval callback failed: ${sanitizeError(error)}`);
      });
    });
  }

  setProjectRoot(projectRoot) {
    this.projectRoot = projectRoot;
    this.assistantProvider.setWorkspaceRoot(projectRoot);
  }

  async sendTurn({ threadId, prompt, source, metadata = {}, inputItems = [] }) {
    const normalizedThreadId = normalizeThreadId(threadId);
    const text = String(prompt ?? "").trim();
    const normalizedInputItems = Array.isArray(inputItems) ? [...inputItems] : [];
    const normalizedSource = normalizeSource(source);
    if (!text && normalizedInputItems.length === 0) {
      throw new Error("Message cannot be empty.");
    }

    return this.#queue(normalizedThreadId, async () => {
      const previous = (await this.store.getThread(normalizedThreadId)) ?? (await this.store.ensureThread(normalizedThreadId));
      const previousProviderSessionId = String(previous.sessionId ?? "").trim();
      if (previousProviderSessionId) {
        this.threadByProviderSession.set(previousProviderSessionId, normalizedThreadId);
      }

      await this.store.appendMessage(
        normalizedThreadId,
        {
          role: "user",
          source: normalizedSource,
          text: text || "[non-text message]"
        },
        this.maxMessages
      );

      this.turnContextByThread.set(normalizedThreadId, {
        source: normalizedSource,
        metadata: { ...metadata }
      });

      const result = await this.assistantProvider.sendTurn({
        sessionId: previous.sessionId,
        prompt: text,
        inputItems: normalizedInputItems,
        turnActivityTimeoutMs: this.turnActivityTimeoutMs,
        onSessionReady: async (providerSessionId) => {
          this.threadByProviderSession.set(String(providerSessionId), normalizedThreadId);
        }
      });
      this.threadByProviderSession.set(result.sessionId, normalizedThreadId);

      const assistantText = (result.assistantText || "Assistant provider returned no text output.").trim();
      const thread = await this.store.upsertThread(normalizedThreadId, (current) => ({
        ...current,
        sessionId: result.sessionId ?? current.sessionId ?? null,
        turnCount: (current.turnCount ?? 0) + 1,
        lastMode: this.assistantProvider.kind,
        messages: trimMessages(
          [
            ...(current.messages ?? []),
            {
              role: "assistant",
              source: normalizedSource,
              text: assistantText
            }
          ],
          this.maxMessages
        )
      }));

      return {
        threadId: normalizedThreadId,
        thread,
        assistantText,
        mode: this.assistantProvider.kind
      };
    });
  }

  async getThread(threadId) {
    const normalizedThreadId = normalizeThreadId(threadId);
    const thread = (await this.store.getThread(normalizedThreadId)) ?? (await this.store.ensureThread(normalizedThreadId));
    return {
      threadId: normalizedThreadId,
      thread
    };
  }

  async getMessages(threadId, limit) {
    const normalizedThreadId = normalizeThreadId(threadId);
    const messages = await this.store.listMessages(normalizedThreadId, limit);
    return {
      threadId: normalizedThreadId,
      messages
    };
  }

  async resetThread(threadId) {
    const normalizedThreadId = normalizeThreadId(threadId);
    const previous = await this.store.getThread(normalizedThreadId);
    this.pendingApprovalsByThread.delete(normalizedThreadId);
    const thread = await this.store.resetThread(normalizedThreadId);
    if (previous?.sessionId) {
      this.threadByProviderSession.delete(previous.sessionId);
    }
    return {
      threadId: normalizedThreadId,
      thread
    };
  }

  listPendingApprovals(threadId = null) {
    if (threadId) {
      const normalizedThreadId = normalizeThreadId(threadId);
      return [...(this.pendingApprovalsByThread.get(normalizedThreadId) ?? [])].map((entry) => ({ ...entry }));
    }

    const all = [];
    for (const entries of this.pendingApprovalsByThread.values()) {
      all.push(...entries);
    }
    all.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    return all.map((entry) => ({ ...entry }));
  }

  async resolvePendingApproval({ threadId, approvalId, decision }) {
    const normalizedThreadId = normalizeThreadId(threadId);
    const targetApprovalId = String(approvalId ?? "").trim();
    if (!targetApprovalId) {
      throw new Error("approvalId is required.");
    }

    const approvals = this.pendingApprovalsByThread.get(normalizedThreadId) ?? [];
    const target = approvals.find((entry) => entry.id === targetApprovalId);
    if (!target) {
      throw new Error(`Unknown approval '${targetApprovalId}' for thread '${normalizedThreadId}'.`);
    }

    const resolved = await this.assistantProvider.resolveApproval({
      approvalId: target.id,
      decision
    });
    this.pendingApprovalsByThread.set(
      normalizedThreadId,
      approvals.filter((entry) => entry.id !== target.id)
    );
    return {
      ...target,
      decision: resolved.decision
    };
  }

  async interruptThread(threadId) {
    const normalizedThreadId = normalizeThreadId(threadId);
    const thread = (await this.store.getThread(normalizedThreadId)) ?? (await this.store.ensureThread(normalizedThreadId));
    const sessionId = String(thread?.sessionId ?? "").trim();
    if (!sessionId) {
      return {
        threadId: normalizedThreadId,
        interrupted: false,
        reason: "no_active_session"
      };
    }

    if (typeof this.assistantProvider?.interruptTurn !== "function") {
      return {
        threadId: normalizedThreadId,
        sessionId,
        interrupted: false,
        reason: "not_supported"
      };
    }

    try {
      const result = await this.assistantProvider.interruptTurn({
        sessionId
      });
      return {
        threadId: normalizedThreadId,
        sessionId,
        ...(result && typeof result === "object" ? result : {})
      };
    } catch (error) {
      return {
        threadId: normalizedThreadId,
        sessionId,
        interrupted: false,
        reason: "error",
        error: sanitizeError(error)
      };
    }
  }

  async shutdown() {
    await this.assistantProvider.shutdown();
  }

  #queue(threadId, work) {
    const previous = this.queueByThread.get(threadId) ?? Promise.resolve();
    const next = previous.then(work, work);
    const tracked = next.finally(() => {
      if (this.queueByThread.get(threadId) === tracked) {
        this.queueByThread.delete(threadId);
      }
    });
    this.queueByThread.set(threadId, tracked);
    return tracked;
  }

  async #handleApprovalRequested(approval) {
    const providerSessionId = String(approval.sessionId ?? approval.threadId ?? "").trim();
    if (!providerSessionId) {
      return;
    }

    let bridgeThreadId = this.threadByProviderSession.get(providerSessionId);
    if (!bridgeThreadId) {
      bridgeThreadId = await this.store.findThreadIdBySessionId(providerSessionId);
      if (bridgeThreadId) {
        this.threadByProviderSession.set(providerSessionId, bridgeThreadId);
      }
    }

    if (!bridgeThreadId) {
      return;
    }

    const entry = {
      id: approval.id,
      kind: approval.kind,
      threadId: bridgeThreadId,
      sessionId: providerSessionId,
      turnId: approval.turnId,
      itemId: approval.itemId,
      command: approval.command,
      cwd: approval.cwd,
      reason: approval.reason,
      commandActions: approval.commandActions,
      createdAt: approval.createdAt
    };

    const previousEntries = this.pendingApprovalsByThread.get(bridgeThreadId) ?? [];
    this.pendingApprovalsByThread.set(bridgeThreadId, [...previousEntries, entry]);

    if (!this.onApprovalRequested) {
      return;
    }
    const context = this.turnContextByThread.get(bridgeThreadId) ?? { source: "internal", metadata: {} };
    try {
      await this.onApprovalRequested({
        ...entry,
        source: context.source,
        metadata: context.metadata
      });
    } catch (error) {
      console.error(`onApprovalRequested failed: ${sanitizeError(error)}`);
    }
  }
}

function trimMessages(messages, maxMessages) {
  const safeMax = Number.isFinite(maxMessages) && maxMessages > 0 ? Math.min(maxMessages, 1000) : DEFAULT_MAX_MESSAGES;
  if (messages.length <= safeMax) {
    return messages;
  }
  return messages.slice(messages.length - safeMax);
}

function normalizeSource(value) {
  const source = String(value ?? "").toLowerCase();
  if (source === "web" || source === "telegram" || source === "internal") {
    return source;
  }
  return "internal";
}

function sanitizeError(error) {
  const raw = error instanceof Error ? error.message : String(error);
  return raw.split(/\r?\n/).slice(0, 12).join("\n");
}
