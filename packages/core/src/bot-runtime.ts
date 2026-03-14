import path from "node:path";
import { ConversationEngine } from "./bridge-service.js";
import { createChannelAdapter } from "./channel-factory.js";
import { CapabilityManager } from "./capability-manager.js";
import { KERNEL_VERSION } from "./kernel-version.js";
import { createProjectFingerprint } from "./project-fingerprint.js";
import { mergeProviderOptions } from "./provider-options.js";
import { JsonStateStore } from "./state-store.js";
import { createAssistantProvider } from "./provider-factory.js";

const DEFAULT_WEB_THREAD_SUFFIX = "web-main";

type KernelActionContext = {
  source?: string;
  metadata?: Record<string, unknown>;
} & Record<string, unknown>;

type KernelActionRequest = {
  action: string;
  payload?: Record<string, unknown>;
  context?: KernelActionContext;
};

type KernelControl = {
  request: (request: KernelActionRequest) => Promise<unknown> | unknown;
};

type ProviderDefaults = {
  defaultKind?: string;
} & Record<string, unknown>;

type RuntimeTelegramChannelConfig = {
  kind: "telegram";
  id: string;
  token: string;
  tokenEnv: string | null;
  tokenSecretRef: string | null;
  allowedChatIds: string[];
};

type RuntimeWhatsAppChannelConfig = {
  kind: "whatsapp";
  id: string;
  options: Record<string, unknown>;
};

type RuntimeGenericChannelConfig = {
  kind: string;
  id: string;
  options: Record<string, unknown>;
};

type RuntimeChannelConfig =
  | RuntimeTelegramChannelConfig
  | RuntimeWhatsAppChannelConfig
  | RuntimeGenericChannelConfig;

type RuntimeCapabilityConfig = {
  id: string;
  enabled: boolean;
  manifestPath: string;
  options: Record<string, unknown>;
};

type RuntimeBotConfigInput = {
  id?: unknown;
  name?: unknown;
  enabled?: unknown;
  autoStart?: unknown;
  workspaceRoot?: unknown;
  dataDir?: unknown;
  threadMode?: unknown;
  sharedThreadId?: unknown;
  provider?: unknown;
  kernelAccess?: unknown;
  channels?: unknown;
  capabilities?: unknown;
};

type RuntimeConfig = {
  id: string;
  name: string;
  enabled: boolean;
  autoStart: boolean;
  workspaceRoot: string;
  dataDir: string;
  threadMode: "single" | "per_chat";
  sharedThreadId: string;
  provider: {
    kind: string;
    options: Record<string, unknown>;
  };
  channels: RuntimeChannelConfig[];
  capabilities: RuntimeCapabilityConfig[];
  kernelAccess: {
    enabled: boolean;
    allowedActions: string[];
    allowedChatIds: string[];
  };
};

type RuntimeChannelStatus = {
  kind: string;
  id: string;
  running: boolean;
  error?: string | null;
} & Record<string, unknown>;

type RuntimeChannel = {
  kind: string;
  id: string;
  start: () => Promise<unknown>;
  stop: () => Promise<unknown>;
  shutdown: () => Promise<void>;
  getStatus: () => RuntimeChannelStatus;
  notifyApproval?: (approval: Record<string, unknown>) => Promise<void> | void;
};

type RuntimeTurnPayload = {
  threadId: string;
  prompt: string;
  source?: string;
  metadata?: Record<string, unknown>;
  inputItems?: unknown[];
};

type RuntimeApprovalPayload = {
  threadId: string;
  approvalId: string;
  decision: string;
};

type ConversationEngineInit = ConstructorParameters<typeof ConversationEngine>[0];
type ConversationThreadPayload = Awaited<ReturnType<ConversationEngine["getThread"]>>;

type ChannelRuntime = {
  runtimeId: string;
  runtimeName: string;
  getWorkspaceRoot: () => string;
  buildWebBotUrl: () => string;
  getProviderOptions: () => Record<string, unknown>;
  setProviderOptions: (options: Record<string, unknown>) => Promise<BotRuntimeStatus>;
  refreshProviderSession: (reason?: string) => Promise<{
    refreshed: boolean;
    channelsRestarted: boolean;
    reason: string;
  }>;
  isKernelControlEnabled: () => boolean;
  executeKernelAction: (payload: {
    action: unknown;
    payload?: unknown;
    context?: unknown;
  }) => Promise<unknown>;
  resolveThreadIdForChannel: (payload: {
    channelKind: string;
    channelId: string;
    externalUserId: string;
  }) => Promise<string>;
  getThread: (threadId: string) => Promise<ConversationThreadPayload>;
  resetThread: (threadId: string) => Promise<ConversationThreadPayload>;
  interruptThread: (threadId: string) => Promise<Record<string, unknown>>;
  listPendingApprovals: (threadId?: string) => Promise<unknown[]>;
  resolvePendingApproval: (payload: RuntimeApprovalPayload) => Promise<unknown>;
  getProviderUsage: () => Promise<unknown>;
  sendTurn: (payload: RuntimeTurnPayload) => Promise<
    {
      threadId: string;
      assistantText: string;
    } & Record<string, unknown>
  >;
};

type ChannelAdapterFactory = (params: {
  channelConfig: RuntimeChannelConfig;
  runtime: ChannelRuntime;
}) => RuntimeChannel;

type BotRuntimeStatus = {
  id: string;
  name: string;
  enabled: boolean;
  autoStart: boolean;
  threadMode: "single" | "per_chat";
  sharedThreadId: string;
  providerKind: string;
  kernelVersion: string;
  webThreadId: string;
  running: boolean;
  telegramRunning: boolean;
  telegramError: string | null;
  workspaceRoot: string;
  dataDir: string;
  provider: {
    kind: string;
    options: Record<string, unknown>;
  };
  kernelAccess: {
    enabled: boolean;
    allowedActions: string[];
    allowedChatIds: string[];
  };
  capabilities: unknown[];
  channels: RuntimeChannelStatus[];
};

export class BotRuntime {
  config: RuntimeConfig;
  providerDefaults: ProviderDefaults;
  kernelControl: KernelControl | null;
  channelAdapterFactory: ChannelAdapterFactory;
  turnActivityTimeoutMs: number;
  maxMessages: number;
  projectRoot: string;
  projectFingerprint: string;
  store: JsonStateStore | null;
  engine: ConversationEngine | null;
  provider: ReturnType<typeof createAssistantProvider> | null;
  capabilityManager: CapabilityManager | null;
  channels: RuntimeChannel[];
  telegramRunning: boolean;
  telegramError: string | null;
  webPublicBaseUrl: string;
  initPromise: Promise<void> | null;
  providerRefreshPromise: Promise<void> | null;

  constructor({
    botConfig,
    providerDefaults,
    turnActivityTimeoutMs,
    maxMessages,
    kernelControl = null,
    channelAdapterFactory = null,
  }: {
    botConfig: RuntimeBotConfigInput;
    providerDefaults: ProviderDefaults;
    turnActivityTimeoutMs: number;
    maxMessages: number;
    kernelControl?: KernelControl | null;
    channelAdapterFactory?: ChannelAdapterFactory | null;
  }) {
    this.config = normalizeRuntimeConfig(botConfig);
    this.providerDefaults = {
      defaultKind: "codex",
      ...(providerDefaults ?? {}),
    };
    this.kernelControl =
      kernelControl && typeof kernelControl.request === "function" ? kernelControl : null;
    this.channelAdapterFactory =
      typeof channelAdapterFactory === "function"
        ? channelAdapterFactory
        : (createChannelAdapter as ChannelAdapterFactory);
    this.turnActivityTimeoutMs = turnActivityTimeoutMs;
    this.maxMessages = maxMessages;
    this.projectRoot = path.resolve(String(this.config.workspaceRoot));
    this.config.workspaceRoot = this.projectRoot;
    this.projectFingerprint = createProjectFingerprint({
      runtimeId: this.config.id,
      workspaceRoot: this.projectRoot,
      providerKind: this.config.provider?.kind,
      channels: this.config.channels,
    });

    this.store = null;
    this.engine = null;
    this.provider = null;
    this.capabilityManager = null;
    this.channels = [];
    this.telegramRunning = false;
    this.telegramError = null;
    this.webPublicBaseUrl = "http://127.0.0.1:8787";
    this.initPromise = null;
    this.providerRefreshPromise = null;
  }

  get id(): string {
    return this.config.id;
  }

  get name(): string {
    return this.config.name;
  }

  get providerKind(): string {
    return String(this.config.provider?.kind ?? this.providerDefaults?.defaultKind ?? "codex");
  }

  get webThreadId(): string {
    if (this.config.threadMode === "single") {
      return this.config.sharedThreadId;
    }
    return `web:${this.config.id}:${DEFAULT_WEB_THREAD_SUFFIX}`;
  }

  setWebPublicBaseUrl(value: string): void {
    this.webPublicBaseUrl = String(value ?? "").trim() || this.webPublicBaseUrl;
  }

  async ensureInitialized(): Promise<void> {
    if (this.initPromise) {
      await this.initPromise;
      return;
    }

    this.initPromise = (async () => {
      const stateFilePath = path.join(this.config.dataDir, "sessions.json");
      this.store = new JsonStateStore(stateFilePath);
      await this.store.init();
      await this.#ensureStoreFingerprint();

      this.provider = this.#createProvider();
      this.engine = this.#createConversationEngine(this.provider);

      this.capabilityManager = new CapabilityManager({
        runtimeId: this.id,
        kernelVersion: KERNEL_VERSION,
        workspaceRoot: this.projectRoot,
        capabilityDefinitions: this.config.capabilities,
      });
      await this.capabilityManager.initialize();

      await this.store.ensureThread(this.webThreadId);
      const createAdapter = this.channelAdapterFactory;
      this.channels = this.config.channels.map((channelConfig) =>
        createAdapter({ channelConfig, runtime: this.#buildChannelRuntime() }),
      );
      this.#syncTelegramStatus();
    })();

    await this.initPromise;
  }

  async startChannels(): Promise<BotRuntimeStatus> {
    await this.ensureInitialized();
    for (const channel of this.channels) {
      await channel.start();
    }
    this.#syncTelegramStatus();
    return this.getStatus();
  }

  async stopChannels(): Promise<BotRuntimeStatus> {
    await this.ensureInitialized();
    for (const channel of this.channels) {
      await channel.stop();
    }
    this.#syncTelegramStatus();
    return this.getStatus();
  }

  async shutdown(): Promise<void> {
    if (this.channels.length > 0) {
      for (const channel of this.channels) {
        await channel.shutdown();
      }
    }
    if (this.engine) {
      await this.engine.shutdown();
    }
    if (this.capabilityManager) {
      await this.capabilityManager.shutdown();
    }
    this.channels = [];
    this.engine = null;
    this.provider = null;
    this.capabilityManager = null;
    this.store = null;
    this.initPromise = null;
    this.telegramRunning = false;
    this.telegramError = null;
  }

  async setProjectRoot(projectRoot: string): Promise<void> {
    const nextRoot = path.resolve(String(projectRoot));
    if (nextRoot === this.projectRoot) {
      return;
    }

    const wasRunning = this.channels.some((channel) => channel.getStatus().running);
    await this.shutdown();
    this.projectRoot = nextRoot;
    this.config.workspaceRoot = nextRoot;
    this.projectFingerprint = createProjectFingerprint({
      runtimeId: this.id,
      workspaceRoot: this.projectRoot,
      providerKind: this.providerKind,
      channels: this.config.channels,
    });

    await this.ensureInitialized();
    if (wasRunning) {
      await this.startChannels();
    }
  }

  async refreshProviderSession(reason = "manual provider session refresh"): Promise<{
    refreshed: boolean;
    channelsRestarted: boolean;
    reason: string;
  }> {
    await this.ensureInitialized();
    await this.#recreateProviderSession();
    return {
      refreshed: true,
      channelsRestarted: false,
      reason: String(reason ?? "manual provider session refresh"),
    };
  }

  async setProviderOptions(nextOptions: Record<string, unknown>): Promise<BotRuntimeStatus> {
    const previousProvider = {
      kind: String(this.config.provider?.kind ?? "codex").trim() || "codex",
      options: { ...asRecord(this.config.provider?.options) },
    };
    const nextProvider = {
      ...previousProvider,
      options: mergeProviderOptions(previousProvider.options, nextOptions),
    };

    this.config = {
      ...this.config,
      provider: nextProvider,
    };

    if (!this.initPromise && !this.store && !this.engine && !this.provider) {
      return this.getStatus();
    }

    try {
      await this.ensureInitialized();
      await this.#recreateProviderSession();
      return this.getStatus();
    } catch (error) {
      this.config = {
        ...this.config,
        provider: previousProvider,
      };
      try {
        if (this.store || this.engine || this.provider) {
          await this.#recreateProviderSession();
        }
      } catch {
        // Best effort rollback only.
      }
      throw error;
    }
  }

  async resetWebThread(): Promise<ConversationThreadPayload> {
    await this.ensureInitialized();
    return this.#requireEngine().resetThread(this.webThreadId);
  }

  async listPendingApprovals(threadId?: string): Promise<unknown[]> {
    await this.ensureInitialized();
    return this.#requireEngine().listPendingApprovals(threadId);
  }

  async resolvePendingApproval({
    threadId,
    approvalId,
    decision,
  }: RuntimeApprovalPayload): Promise<unknown> {
    await this.ensureInitialized();
    return this.#requireEngine().resolvePendingApproval({ threadId, approvalId, decision });
  }

  async interruptThread(threadId: string): Promise<Record<string, unknown>> {
    await this.ensureInitialized();
    return this.#requireEngine().interruptThread(threadId);
  }

  async getProviderUsage(): Promise<unknown> {
    await this.ensureInitialized();
    const engine = this.#requireEngine();
    if (typeof engine.getProviderUsage !== "function") {
      return null;
    }
    return engine.getProviderUsage();
  }

  async resolveThreadIdForChannel({
    channelKind,
    channelId,
    externalUserId,
  }: {
    channelKind: string;
    channelId: string;
    externalUserId: string;
  }): Promise<string> {
    await this.ensureInitialized();
    const store = this.#requireStore();
    if (this.config.threadMode === "single") {
      const threadId = this.config.sharedThreadId;
      await store.ensureThread(threadId);
      return threadId;
    }

    const key = `${String(channelKind)}:${String(channelId)}:${String(externalUserId)}`;
    return store.getOrCreateThreadIdForChannelUser(key);
  }

  async getThread(threadId: string): Promise<ConversationThreadPayload> {
    await this.ensureInitialized();
    return this.#requireEngine().getThread(threadId);
  }

  async resetThread(threadId: string): Promise<ConversationThreadPayload> {
    await this.ensureInitialized();
    return this.#requireEngine().resetThread(threadId);
  }

  async sendTurn(payload: RuntimeTurnPayload): Promise<
    {
      threadId: string;
      assistantText: string;
    } & Record<string, unknown>
  > {
    await this.ensureInitialized();
    const capabilityManager = this.#requireCapabilityManager();
    const input = await capabilityManager.transformTurnInput({
      ...payload,
      metadata: payload?.metadata && typeof payload.metadata === "object" ? payload.metadata : {},
    });

    const threadId = String((input as Record<string, unknown>).threadId ?? "").trim();
    if (!threadId) {
      throw new Error("threadId is required.");
    }
    const prompt = String((input as Record<string, unknown>).prompt ?? "").trim();
    if (!prompt) {
      throw new Error("Capability pipeline produced an empty prompt.");
    }
    const source = String((input as Record<string, unknown>).source ?? "").trim() || "internal";
    const metadata = asRecord((input as Record<string, unknown>).metadata);
    const inputItemsRaw = (input as Record<string, unknown>).inputItems;
    const sendPayload: Parameters<ConversationEngine["sendTurn"]>[0] = {
      threadId,
      prompt,
      source,
      metadata,
      ...(Array.isArray(inputItemsRaw) ? { inputItems: inputItemsRaw } : {}),
    };

    let result: ({ threadId: string; assistantText: string } & Record<string, unknown>) | null =
      null;
    try {
      result = (await this.#requireEngine().sendTurn(sendPayload)) as {
        threadId: string;
        assistantText: string;
      } & Record<string, unknown>;
    } catch (error) {
      await this.#recoverProviderSessionAfterTurnError(error);
      throw error;
    }
    if (!result) {
      throw new Error("Conversation engine returned no turn result.");
    }
    await capabilityManager.runHook("onTurnResult", {
      threadId: sendPayload.threadId,
      prompt: sendPayload.prompt,
      source: sendPayload.source,
      metadata: sendPayload.metadata,
      result,
    });
    return result;
  }

  getStatus(): BotRuntimeStatus {
    this.#syncTelegramStatus();
    return {
      id: this.config.id,
      name: this.config.name,
      enabled: this.config.enabled,
      autoStart: this.config.autoStart,
      threadMode: this.config.threadMode,
      sharedThreadId: this.config.sharedThreadId,
      providerKind: this.providerKind,
      kernelVersion: KERNEL_VERSION,
      webThreadId: this.webThreadId,
      running: this.channels.some((channel) => channel.getStatus().running),
      telegramRunning: this.telegramRunning,
      telegramError: this.telegramError,
      workspaceRoot: this.projectRoot,
      dataDir: this.config.dataDir,
      provider: {
        kind: this.providerKind,
        options: this.getProviderOptions(),
      },
      kernelAccess: {
        enabled: this.config.kernelAccess?.enabled === true,
        allowedActions: Array.isArray(this.config.kernelAccess?.allowedActions)
          ? [...this.config.kernelAccess.allowedActions]
          : [],
        allowedChatIds: Array.isArray(this.config.kernelAccess?.allowedChatIds)
          ? [...this.config.kernelAccess.allowedChatIds]
          : [],
      },
      capabilities: this.capabilityManager ? this.capabilityManager.getStatus() : [],
      channels: this.channels.map((channel) => channel.getStatus()),
    };
  }

  getProviderOptions(): Record<string, unknown> {
    return { ...asRecord(this.config.provider?.options) };
  }

  async reloadCapabilities(nextDefinitions: unknown = null): Promise<BotRuntimeStatus> {
    await this.ensureInitialized();
    if (Array.isArray(nextDefinitions)) {
      this.config.capabilities = normalizeCapabilityDefinitions(nextDefinitions);
    }
    await this.#requireCapabilityManager().reload(this.config.capabilities);
    return this.getStatus();
  }

  async onApprovalRequested(approval: Record<string, unknown>): Promise<void> {
    if (this.capabilityManager) {
      await this.capabilityManager.notifyApprovalRequested(approval);
    }

    const source = String(approval?.source ?? "");
    if (source !== "telegram") {
      return;
    }

    const metadata = asRecord(approval.metadata);
    const requestedChannelId = String(metadata.channelId ?? "").trim();
    const telegramChannels = this.channels.filter((channel) => channel.kind === "telegram");
    const targets = requestedChannelId
      ? telegramChannels.filter((channel) => channel.id === requestedChannelId)
      : telegramChannels;

    if (targets.length === 0) {
      return;
    }

    for (const channel of targets) {
      if (typeof channel.notifyApproval === "function") {
        await channel.notifyApproval(approval);
      }
    }
  }

  buildWebBotUrl(): string {
    try {
      const url = new URL(this.webPublicBaseUrl);
      url.searchParams.set("bot", this.id);
      return url.toString();
    } catch {
      const base = this.webPublicBaseUrl.replace(/\/+$/, "");
      return `${base}/?bot=${encodeURIComponent(this.id)}`;
    }
  }

  async #ensureStoreFingerprint(): Promise<void> {
    if (!this.store) {
      return;
    }

    const result = await this.store.ensureFingerprint(this.projectFingerprint);
    if (result.reset) {
      console.log(
        `[${this.id}] Session store reset due project fingerprint change (${result.previousFingerprint} -> ${this.projectFingerprint}).`,
      );
    }
  }

  #buildChannelRuntime(): ChannelRuntime {
    return {
      runtimeId: this.id,
      runtimeName: this.name,
      getWorkspaceRoot: () => this.projectRoot,
      buildWebBotUrl: () => this.buildWebBotUrl(),
      getProviderOptions: () => this.getProviderOptions(),
      setProviderOptions: (options) => this.setProviderOptions(options),
      refreshProviderSession: (reason) => this.refreshProviderSession(reason),
      isKernelControlEnabled: () => this.isKernelControlEnabled(),
      executeKernelAction: (payload) => this.executeKernelAction(payload),
      resolveThreadIdForChannel: (payload) => this.resolveThreadIdForChannel(payload),
      getThread: (threadId) => this.getThread(threadId),
      resetThread: (threadId) => this.resetThread(threadId),
      interruptThread: (threadId) => this.interruptThread(threadId),
      listPendingApprovals: (threadId) => this.listPendingApprovals(threadId),
      resolvePendingApproval: (payload) => this.resolvePendingApproval(payload),
      getProviderUsage: () => this.getProviderUsage(),
      sendTurn: (payload) => this.sendTurn(payload),
    };
  }

  isKernelControlEnabled(): boolean {
    return this.config.kernelAccess?.enabled === true && this.kernelControl !== null;
  }

  async executeKernelAction({
    action,
    payload,
    context,
  }: {
    action: unknown;
    payload?: unknown;
    context?: unknown;
  }): Promise<unknown> {
    if (!this.isKernelControlEnabled()) {
      throw new Error(`Kernel control is disabled for '${this.id}'.`);
    }
    const kernelControl = this.kernelControl;
    if (!kernelControl) {
      throw new Error(`Kernel control is disabled for '${this.id}'.`);
    }
    return kernelControl.request({
      action: String(action ?? "").trim(),
      payload: asRecord(payload),
      context: asKernelActionContext(context),
    });
  }

  #syncTelegramStatus(): void {
    if (!this.channels || this.channels.length === 0) {
      this.telegramRunning = false;
      this.telegramError = null;
      return;
    }

    const telegram = this.channels
      .filter((channel) => channel.kind === "telegram")
      .map((channel) => channel.getStatus());
    this.telegramRunning = telegram.some((entry) => entry.running);
    const errors = telegram.map((entry) => entry.error).filter(Boolean);
    this.telegramError = errors.length > 0 ? String(errors[0]) : null;
  }

  #requireStore(): JsonStateStore {
    if (!this.store) {
      throw new Error("State store is not initialized.");
    }
    return this.store;
  }

  #requireEngine(): ConversationEngine {
    if (!this.engine) {
      throw new Error("Conversation engine is not initialized.");
    }
    return this.engine;
  }

  #requireCapabilityManager(): CapabilityManager {
    if (!this.capabilityManager) {
      throw new Error("Capability manager is not initialized.");
    }
    return this.capabilityManager;
  }

  #createProvider() {
    return createAssistantProvider({
      providerConfig: this.config.provider,
      providerDefaults: this.providerDefaults,
      workspaceRoot: this.projectRoot,
      turnActivityTimeoutMs: this.turnActivityTimeoutMs,
    });
  }

  #createConversationEngine(provider: ReturnType<typeof createAssistantProvider>) {
    return new ConversationEngine({
      store: this.#requireStore() as unknown as ConversationEngineInit["store"],
      assistantProvider: provider as unknown as ConversationEngineInit["assistantProvider"],
      projectRoot: this.projectRoot,
      turnActivityTimeoutMs: this.turnActivityTimeoutMs,
      maxMessages: this.maxMessages,
      onApprovalRequested: (approval) => this.onApprovalRequested(approval),
    });
  }

  async #recoverProviderSessionAfterTurnError(error: unknown): Promise<void> {
    if (!shouldRecoverProviderSessionAfterTurnError(error)) {
      return;
    }

    try {
      await this.#recreateProviderSession();
    } catch (refreshError) {
      console.error(
        `[${this.id}] provider session recovery failed after turn error: ${sanitizeError(refreshError)}`,
      );
    }
  }

  async #recreateProviderSession(): Promise<void> {
    if (this.providerRefreshPromise) {
      await this.providerRefreshPromise;
      return;
    }

    this.providerRefreshPromise = (async () => {
      await this.ensureInitialized();

      const previousEngine = this.engine;
      const previousProvider = this.provider;
      this.engine = null;
      this.provider = null;

      if (previousEngine) {
        await previousEngine.shutdown();
      } else if (previousProvider) {
        await previousProvider.shutdown();
      }

      this.provider = this.#createProvider();
      this.engine = this.#createConversationEngine(this.provider);
      await this.#requireStore().ensureThread(this.webThreadId);
    })();

    try {
      await this.providerRefreshPromise;
    } finally {
      this.providerRefreshPromise = null;
    }
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function sanitizeError(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  return raw.split(/\r?\n/).slice(0, 12).join("\n");
}

function shouldRecoverProviderSessionAfterTurnError(error: unknown): boolean {
  const normalized = sanitizeError(error).trim().toLowerCase();
  if (!normalized) {
    return false;
  }

  return (
    normalized.includes("inactive for") ||
    normalized.includes("process stopped while waiting for turn completion") ||
    normalized.includes("codex app-server process stopped") ||
    normalized.includes("codex app-server exited with code") ||
    normalized.includes("request 'turn/start' timed out") ||
    normalized.includes("request 'thread/resume' timed out") ||
    normalized.includes("request 'thread/start' timed out")
  );
}

function normalizeRuntimeConfig(botConfig: RuntimeBotConfigInput): RuntimeConfig {
  const id = String(botConfig?.id ?? "").trim() || "bot_default";
  const name = String(botConfig?.name ?? id).trim() || id;
  const workspaceRoot = path.resolve(String(botConfig?.workspaceRoot ?? process.cwd()));
  const dataDir = path.resolve(
    String(botConfig?.dataDir ?? path.join(process.cwd(), ".copilot-hub", "bots", id)),
  );

  return {
    id,
    name,
    enabled: botConfig?.enabled !== false,
    autoStart: Boolean(botConfig?.autoStart),
    workspaceRoot,
    dataDir,
    threadMode: normalizeThreadMode(botConfig?.threadMode),
    sharedThreadId: String(botConfig?.sharedThreadId ?? `thread:${id}`).trim() || `thread:${id}`,
    provider: normalizeProviderConfig(botConfig?.provider),
    channels: normalizeChannelConfigs(botConfig?.channels),
    capabilities: normalizeCapabilityDefinitions(botConfig?.capabilities),
    kernelAccess: normalizeKernelAccess(botConfig?.kernelAccess),
  };
}

function normalizeThreadMode(value: unknown): "single" | "per_chat" {
  const mode = String(value ?? "single")
    .trim()
    .toLowerCase();
  return mode === "per_chat" ? "per_chat" : "single";
}

function normalizeProviderConfig(value: unknown): RuntimeConfig["provider"] {
  const raw = asRecord(value);
  const options = mergeProviderOptions({}, raw.options);
  return {
    kind: String(raw.kind ?? "codex").trim() || "codex",
    options,
  };
}

function normalizeChannelConfigs(value: unknown): RuntimeChannelConfig[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const channels: RuntimeChannelConfig[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const raw = asRecord(value[index]);
    const kind = String(raw.kind ?? "")
      .trim()
      .toLowerCase();
    if (!kind) {
      continue;
    }

    const fallbackId = `${kind}_${index + 1}`;
    const id = String(raw.id ?? fallbackId).trim() || fallbackId;

    if (kind === "telegram") {
      channels.push({
        kind: "telegram",
        id,
        token: String(raw.token ?? "").trim(),
        tokenEnv: normalizeOptionalString(raw.tokenEnv),
        tokenSecretRef: normalizeOptionalString(raw.tokenSecretRef),
        allowedChatIds: normalizeStringList(raw.allowedChatIds),
      });
      continue;
    }

    if (kind === "whatsapp") {
      channels.push({
        kind: "whatsapp",
        id,
        options: asRecord(raw.options),
      });
      continue;
    }

    channels.push({
      kind,
      id,
      options: asRecord(raw.options),
    });
  }

  return channels;
}

function normalizeCapabilityDefinitions(value: unknown): RuntimeCapabilityConfig[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const capabilities: RuntimeCapabilityConfig[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const raw = asRecord(value[index]);
    const id = String(raw.id ?? `capability_${index + 1}`).trim();
    const manifestPath = String(raw.manifestPath ?? "").trim();
    if (!id || !manifestPath) {
      continue;
    }

    capabilities.push({
      id,
      enabled: raw.enabled !== false,
      manifestPath,
      options: asRecord(raw.options),
    });
  }
  return capabilities;
}

function normalizeKernelAccess(value: unknown): RuntimeConfig["kernelAccess"] {
  const raw = asRecord(value);
  return {
    enabled: raw.enabled === true,
    allowedActions: normalizeStringList(raw.allowedActions),
    allowedChatIds: normalizeStringList(raw.allowedChatIds),
  };
}

function normalizeStringList(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.map((entry) => String(entry ?? "").trim()).filter(Boolean);
  }
  if (typeof value === "string") {
    return value
      .split(",")
      .map((entry) => entry.trim())
      .filter(Boolean);
  }
  return [];
}

function normalizeOptionalString(value: unknown): string | null {
  const normalized = String(value ?? "").trim();
  return normalized || null;
}

function asKernelActionContext(value: unknown): KernelActionContext {
  const record = asRecord(value);
  return {
    ...record,
    source: String(record.source ?? "internal").trim() || "internal",
    metadata: asRecord(record.metadata),
  };
}
