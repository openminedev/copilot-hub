import { normalizeTimeout } from "./codex-app-utils.js";
import { normalizeThreadId } from "./thread-id.js";

const DEFAULT_MAX_MESSAGES = 200;
const DEFAULT_TURN_ACTIVITY_TIMEOUT_MS = 3_600_000;

type MessageSource = "web" | "telegram" | "internal";

type BridgeMessage = {
  role: "user" | "assistant";
  source: MessageSource;
  text: string;
};

type BridgeThread = {
  sessionId?: string | null;
  turnCount?: number;
  lastMode?: string;
  messages?: BridgeMessage[];
} & Record<string, unknown>;

type BridgeStore = {
  getThread: (threadId: string) => Promise<BridgeThread | null>;
  ensureThread: (threadId: string) => Promise<BridgeThread>;
  appendMessage: (
    threadId: string,
    message: BridgeMessage,
    maxMessages: number,
  ) => Promise<unknown>;
  upsertThread: (
    threadId: string,
    updater: (current: BridgeThread) => BridgeThread,
  ) => Promise<BridgeThread>;
  listMessages: (threadId: string, limit?: number) => Promise<unknown[]>;
  resetThread: (threadId: string) => Promise<BridgeThread>;
  findThreadIdBySessionId: (sessionId: string) => Promise<string | null>;
};

type AssistantTurnResult = {
  sessionId: string;
  assistantText?: string;
} & Record<string, unknown>;

type ApprovalEntry = {
  id: string;
  kind?: string;
  threadId: string;
  sessionId: string;
  turnId?: string;
  itemId?: string;
  command?: string;
  cwd?: string;
  reason?: string;
  commandActions?: unknown;
  createdAt: string;
} & Record<string, unknown>;

type AssistantProvider = {
  kind: string;
  on: (event: string, handler: (payload: unknown) => void) => void;
  setWorkspaceRoot: (projectRoot: string) => void;
  sendTurn: (payload: {
    sessionId: string | null;
    prompt: string;
    inputItems?: unknown[];
    turnActivityTimeoutMs: number;
    onSessionReady?: (providerSessionId: string) => Promise<void>;
  }) => Promise<AssistantTurnResult>;
  resolveApproval: (payload: {
    approvalId: string;
    decision: string;
  }) => Promise<{ decision: string }>;
  interruptTurn?: (payload: { sessionId: string }) => Promise<Record<string, unknown>>;
  shutdown: () => Promise<void>;
  getLatestQuotaSnapshot?: () => unknown;
};

type ConversationEngineInit = {
  store: BridgeStore;
  assistantProvider: AssistantProvider;
  projectRoot: string;
  turnActivityTimeoutMs: unknown;
  maxMessages?: number;
  onApprovalRequested?: ((payload: Record<string, unknown>) => Promise<void>) | null;
};

type TurnContext = {
  source: MessageSource;
  metadata: Record<string, unknown>;
};

export class ConversationEngine {
  store: BridgeStore;
  assistantProvider: AssistantProvider;
  projectRoot: string;
  turnActivityTimeoutMs: number;
  maxMessages: number;
  queueByThread: Map<string, Promise<unknown>>;
  threadByProviderSession: Map<string, string>;
  turnContextByThread: Map<string, TurnContext>;
  pendingApprovalsByThread: Map<string, ApprovalEntry[]>;
  onApprovalRequested: ((payload: Record<string, unknown>) => Promise<void>) | null;

  constructor({
    store,
    assistantProvider,
    projectRoot,
    turnActivityTimeoutMs,
    maxMessages = DEFAULT_MAX_MESSAGES,
    onApprovalRequested = null,
  }: ConversationEngineInit) {
    this.store = store;
    this.assistantProvider = assistantProvider;
    this.projectRoot = projectRoot;
    this.turnActivityTimeoutMs = normalizeTimeout(
      turnActivityTimeoutMs,
      DEFAULT_TURN_ACTIVITY_TIMEOUT_MS,
    );
    this.maxMessages = maxMessages;
    this.queueByThread = new Map();
    this.threadByProviderSession = new Map();
    this.turnContextByThread = new Map();
    this.pendingApprovalsByThread = new Map();
    this.onApprovalRequested =
      typeof onApprovalRequested === "function" ? onApprovalRequested : null;

    this.assistantProvider.on("approvalRequested", (approval) => {
      void this.#handleApprovalRequested(approval).catch((error) => {
        console.error(`Approval callback failed: ${sanitizeError(error)}`);
      });
    });
  }

  setProjectRoot(projectRoot: string): void {
    this.projectRoot = projectRoot;
    this.assistantProvider.setWorkspaceRoot(projectRoot);
  }

  async sendTurn({
    threadId,
    prompt,
    source,
    metadata = {},
    inputItems = [],
  }: {
    threadId: string;
    prompt?: string | null;
    source?: unknown;
    metadata?: Record<string, unknown>;
    inputItems?: unknown[];
  }) {
    const normalizedThreadId = normalizeThreadId(threadId);
    const text = String(prompt ?? "").trim();
    const normalizedInputItems = Array.isArray(inputItems) ? [...inputItems] : [];
    const normalizedSource = normalizeSource(source);
    if (!text && normalizedInputItems.length === 0) {
      throw new Error("Message cannot be empty.");
    }

    return this.#queue(normalizedThreadId, async () => {
      const previous =
        (await this.store.getThread(normalizedThreadId)) ??
        (await this.store.ensureThread(normalizedThreadId));
      const previousProviderSessionId = String(previous.sessionId ?? "").trim();
      if (previousProviderSessionId) {
        this.threadByProviderSession.set(previousProviderSessionId, normalizedThreadId);
      }

      await this.store.appendMessage(
        normalizedThreadId,
        {
          role: "user",
          source: normalizedSource,
          text: text || "[non-text message]",
        },
        this.maxMessages,
      );

      this.turnContextByThread.set(normalizedThreadId, {
        source: normalizedSource,
        metadata: { ...metadata },
      });

      const result = await this.assistantProvider.sendTurn({
        sessionId: (previous.sessionId as string | null | undefined) ?? null,
        prompt: text,
        inputItems: normalizedInputItems,
        turnActivityTimeoutMs: this.turnActivityTimeoutMs,
        onSessionReady: async (providerSessionId: string) => {
          this.threadByProviderSession.set(String(providerSessionId), normalizedThreadId);
        },
      });
      this.threadByProviderSession.set(result.sessionId, normalizedThreadId);

      const assistantText = (
        String(result.assistantText ?? "") || "Assistant provider returned no text output."
      ).trim();
      const thread = await this.store.upsertThread(normalizedThreadId, (current) => ({
        ...current,
        sessionId: result.sessionId ?? current.sessionId ?? null,
        turnCount: (Number(current.turnCount) || 0) + 1,
        lastMode: this.assistantProvider.kind,
        messages: trimMessages(
          [
            ...(Array.isArray(current.messages) ? current.messages : []),
            {
              role: "assistant",
              source: normalizedSource,
              text: assistantText,
            },
          ],
          this.maxMessages,
        ),
      }));

      return {
        threadId: normalizedThreadId,
        thread,
        assistantText,
        mode: this.assistantProvider.kind,
      };
    });
  }

  async getThread(threadId: string) {
    const normalizedThreadId = normalizeThreadId(threadId);
    const thread =
      (await this.store.getThread(normalizedThreadId)) ??
      (await this.store.ensureThread(normalizedThreadId));
    return {
      threadId: normalizedThreadId,
      thread,
    };
  }

  async getMessages(threadId: string, limit?: number) {
    const normalizedThreadId = normalizeThreadId(threadId);
    const messages = await this.store.listMessages(normalizedThreadId, limit);
    return {
      threadId: normalizedThreadId,
      messages,
    };
  }

  async resetThread(threadId: string) {
    const normalizedThreadId = normalizeThreadId(threadId);
    const previous = await this.store.getThread(normalizedThreadId);
    this.pendingApprovalsByThread.delete(normalizedThreadId);
    const thread = await this.store.resetThread(normalizedThreadId);
    if (previous?.sessionId) {
      this.threadByProviderSession.delete(String(previous.sessionId));
    }
    return {
      threadId: normalizedThreadId,
      thread,
    };
  }

  listPendingApprovals(threadId: string | null = null) {
    if (threadId) {
      const normalizedThreadId = normalizeThreadId(threadId);
      return [...(this.pendingApprovalsByThread.get(normalizedThreadId) ?? [])].map((entry) => ({
        ...entry,
      }));
    }

    const all: ApprovalEntry[] = [];
    for (const entries of this.pendingApprovalsByThread.values()) {
      all.push(...entries);
    }
    all.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    return all.map((entry) => ({ ...entry }));
  }

  async resolvePendingApproval({
    threadId,
    approvalId,
    decision,
  }: {
    threadId: string;
    approvalId: string;
    decision: string;
  }) {
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
      decision,
    });
    this.pendingApprovalsByThread.set(
      normalizedThreadId,
      approvals.filter((entry) => entry.id !== target.id),
    );
    return {
      ...target,
      decision: resolved.decision,
    };
  }

  async interruptThread(threadId: string) {
    const normalizedThreadId = normalizeThreadId(threadId);
    const thread =
      (await this.store.getThread(normalizedThreadId)) ??
      (await this.store.ensureThread(normalizedThreadId));
    const sessionId = String(thread?.sessionId ?? "").trim();
    if (!sessionId) {
      return {
        threadId: normalizedThreadId,
        interrupted: false,
        reason: "no_active_session",
      };
    }

    if (typeof this.assistantProvider?.interruptTurn !== "function") {
      return {
        threadId: normalizedThreadId,
        sessionId,
        interrupted: false,
        reason: "not_supported",
      };
    }

    try {
      const result = await this.assistantProvider.interruptTurn({
        sessionId,
      });
      return {
        threadId: normalizedThreadId,
        sessionId,
        ...(result && typeof result === "object" ? result : {}),
      };
    } catch (error) {
      return {
        threadId: normalizedThreadId,
        sessionId,
        interrupted: false,
        reason: "error",
        error: sanitizeError(error),
      };
    }
  }

  async shutdown() {
    await this.assistantProvider.shutdown();
  }

  getProviderUsage() {
    if (typeof this.assistantProvider?.getLatestQuotaSnapshot !== "function") {
      return null;
    }
    return this.assistantProvider.getLatestQuotaSnapshot();
  }

  #queue(threadId: string, work: () => Promise<unknown>) {
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

  async #handleApprovalRequested(approval: unknown): Promise<void> {
    const approvalRecord =
      approval && typeof approval === "object" ? (approval as Record<string, unknown>) : {};
    const providerSessionId = String(
      approvalRecord.sessionId ?? approvalRecord.threadId ?? "",
    ).trim();
    if (!providerSessionId) {
      return;
    }

    let bridgeThreadId = this.threadByProviderSession.get(providerSessionId);
    if (!bridgeThreadId) {
      const lookedUpThreadId = await this.store.findThreadIdBySessionId(providerSessionId);
      if (lookedUpThreadId) {
        bridgeThreadId = lookedUpThreadId;
        this.threadByProviderSession.set(providerSessionId, lookedUpThreadId);
      }
    }

    if (!bridgeThreadId) {
      return;
    }

    const entry: ApprovalEntry = {
      id: String(approvalRecord.id ?? ""),
      kind: String(approvalRecord.kind ?? ""),
      threadId: bridgeThreadId,
      sessionId: providerSessionId,
      turnId: String(approvalRecord.turnId ?? ""),
      itemId: String(approvalRecord.itemId ?? ""),
      command: String(approvalRecord.command ?? ""),
      cwd: String(approvalRecord.cwd ?? ""),
      reason: String(approvalRecord.reason ?? ""),
      commandActions: approvalRecord.commandActions,
      createdAt: String(approvalRecord.createdAt ?? new Date().toISOString()),
    };

    const previousEntries = this.pendingApprovalsByThread.get(bridgeThreadId) ?? [];
    this.pendingApprovalsByThread.set(bridgeThreadId, [...previousEntries, entry]);

    if (!this.onApprovalRequested) {
      return;
    }
    const context = this.turnContextByThread.get(bridgeThreadId) ?? {
      source: "internal",
      metadata: {},
    };
    try {
      await this.onApprovalRequested({
        ...entry,
        source: context.source,
        metadata: context.metadata,
      });
    } catch (error) {
      console.error(`onApprovalRequested failed: ${sanitizeError(error)}`);
    }
  }
}

function trimMessages(messages: BridgeMessage[], maxMessages: number): BridgeMessage[] {
  const safeMax =
    Number.isFinite(maxMessages) && maxMessages > 0
      ? Math.min(maxMessages, 1000)
      : DEFAULT_MAX_MESSAGES;
  if (messages.length <= safeMax) {
    return messages;
  }
  return messages.slice(messages.length - safeMax);
}

function normalizeSource(value: unknown): MessageSource {
  const source = String(value ?? "").toLowerCase();
  if (source === "web" || source === "telegram" || source === "internal") {
    return source;
  }
  return "internal";
}

function sanitizeError(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  return raw.split(/\r?\n/).slice(0, 12).join("\n");
}
