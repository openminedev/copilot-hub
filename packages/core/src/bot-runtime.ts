// @ts-nocheck
import path from "node:path";
import { ConversationEngine } from "./bridge-service.js";
import { createChannelAdapter } from "./channel-factory.js";
import { CapabilityManager } from "./capability-manager.js";
import { KERNEL_VERSION } from "./kernel-version.js";
import { createProjectFingerprint } from "./project-fingerprint.js";
import { JsonStateStore } from "./state-store.js";
import { createAssistantProvider } from "./provider-factory.js";

const DEFAULT_WEB_THREAD_SUFFIX = "web-main";

export class BotRuntime {
  constructor({
    botConfig,
    providerDefaults,
    turnActivityTimeoutMs,
    maxMessages,
    kernelControl = null,
    channelAdapterFactory = null,
  }) {
    this.config = {
      ...botConfig,
      channels: Array.isArray(botConfig.channels) ? botConfig.channels : [],
      capabilities: Array.isArray(botConfig.capabilities) ? botConfig.capabilities : [],
      kernelAccess:
        botConfig.kernelAccess && typeof botConfig.kernelAccess === "object"
          ? {
              enabled: botConfig.kernelAccess.enabled === true,
              allowedActions: Array.isArray(botConfig.kernelAccess.allowedActions)
                ? [...botConfig.kernelAccess.allowedActions]
                : [],
              allowedChatIds: Array.isArray(botConfig.kernelAccess.allowedChatIds)
                ? [...botConfig.kernelAccess.allowedChatIds]
                : [],
            }
          : {
              enabled: false,
              allowedActions: [],
              allowedChatIds: [],
            },
    };
    this.providerDefaults = {
      defaultKind: "codex",
      ...(providerDefaults ?? {}),
    };
    this.kernelControl =
      kernelControl && typeof kernelControl.request === "function" ? kernelControl : null;
    this.channelAdapterFactory =
      typeof channelAdapterFactory === "function" ? channelAdapterFactory : createChannelAdapter;
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
  }

  get id() {
    return this.config.id;
  }

  get name() {
    return this.config.name;
  }

  get providerKind() {
    return String(this.config.provider?.kind ?? this.providerDefaults?.defaultKind ?? "codex");
  }

  get webThreadId() {
    if (this.config.threadMode === "single") {
      return this.config.sharedThreadId;
    }
    return `web:${this.config.id}:${DEFAULT_WEB_THREAD_SUFFIX}`;
  }

  setWebPublicBaseUrl(value) {
    this.webPublicBaseUrl = String(value ?? "").trim() || this.webPublicBaseUrl;
  }

  async ensureInitialized() {
    if (this.initPromise) {
      await this.initPromise;
      return;
    }

    this.initPromise = (async () => {
      const stateFilePath = path.join(this.config.dataDir, "sessions.json");
      this.store = new JsonStateStore(stateFilePath);
      await this.store.init();
      await this.#ensureStoreFingerprint();

      this.provider = createAssistantProvider({
        providerConfig: this.config.provider,
        providerDefaults: this.providerDefaults,
        workspaceRoot: this.projectRoot,
        turnActivityTimeoutMs: this.turnActivityTimeoutMs,
      });

      this.engine = new ConversationEngine({
        store: this.store,
        assistantProvider: this.provider,
        projectRoot: this.projectRoot,
        turnActivityTimeoutMs: this.turnActivityTimeoutMs,
        maxMessages: this.maxMessages,
        onApprovalRequested: (approval) => this.onApprovalRequested(approval),
      });

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

  async startChannels() {
    await this.ensureInitialized();
    for (const channel of this.channels) {
      await channel.start();
    }
    this.#syncTelegramStatus();
    return this.getStatus();
  }

  async stopChannels() {
    await this.ensureInitialized();
    for (const channel of this.channels) {
      await channel.stop();
    }
    this.#syncTelegramStatus();
    return this.getStatus();
  }

  async shutdown() {
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

  async setProjectRoot(projectRoot) {
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

  async resetWebThread() {
    await this.ensureInitialized();
    return this.engine.resetThread(this.webThreadId);
  }

  async listPendingApprovals(threadId) {
    await this.ensureInitialized();
    return this.engine.listPendingApprovals(threadId);
  }

  async resolvePendingApproval({ threadId, approvalId, decision }) {
    await this.ensureInitialized();
    return this.engine.resolvePendingApproval({ threadId, approvalId, decision });
  }

  async interruptThread(threadId) {
    await this.ensureInitialized();
    return this.engine.interruptThread(threadId);
  }

  async resolveThreadIdForChannel({ channelKind, channelId, externalUserId }) {
    await this.ensureInitialized();
    if (this.config.threadMode === "single") {
      const threadId = this.config.sharedThreadId;
      await this.store.ensureThread(threadId);
      return threadId;
    }

    const key = `${String(channelKind)}:${String(channelId)}:${String(externalUserId)}`;
    return this.store.getOrCreateThreadIdForChannelUser(key);
  }

  async getThread(threadId) {
    await this.ensureInitialized();
    return this.engine.getThread(threadId);
  }

  async resetThread(threadId) {
    await this.ensureInitialized();
    return this.engine.resetThread(threadId);
  }

  async sendTurn(payload) {
    await this.ensureInitialized();
    const input = await this.capabilityManager.transformTurnInput({
      ...payload,
      metadata: payload?.metadata && typeof payload.metadata === "object" ? payload.metadata : {},
    });

    if (!String(input.prompt ?? "").trim()) {
      throw new Error("Capability pipeline produced an empty prompt.");
    }

    const result = await this.engine.sendTurn(input);
    await this.capabilityManager.runHook("onTurnResult", {
      threadId: input.threadId,
      prompt: input.prompt,
      source: input.source,
      metadata: input.metadata,
      result,
    });
    return result;
  }

  getStatus() {
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

  async reloadCapabilities(nextDefinitions = null) {
    await this.ensureInitialized();
    if (Array.isArray(nextDefinitions)) {
      this.config.capabilities = nextDefinitions;
    }
    await this.capabilityManager.reload(this.config.capabilities);
    return this.getStatus();
  }

  async onApprovalRequested(approval) {
    if (this.capabilityManager) {
      await this.capabilityManager.notifyApprovalRequested(approval);
    }

    const source = String(approval?.source ?? "");
    if (source !== "telegram") {
      return;
    }

    const requestedChannelId = String(approval?.metadata?.channelId ?? "").trim();
    const telegramChannels = this.channels.filter((channel) => channel.kind === "telegram");
    const targets = requestedChannelId
      ? telegramChannels.filter((channel) => channel.id === requestedChannelId)
      : telegramChannels;

    if (targets.length === 0) {
      return;
    }

    for (const channel of targets) {
      await channel.notifyApproval(approval);
    }
  }

  buildWebBotUrl() {
    try {
      const url = new URL(this.webPublicBaseUrl);
      url.searchParams.set("bot", this.id);
      return url.toString();
    } catch {
      const base = this.webPublicBaseUrl.replace(/\/+$/, "");
      return `${base}/?bot=${encodeURIComponent(this.id)}`;
    }
  }

  async #ensureStoreFingerprint() {
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

  #buildChannelRuntime() {
    return {
      runtimeId: this.id,
      runtimeName: this.name,
      getWorkspaceRoot: () => this.projectRoot,
      buildWebBotUrl: () => this.buildWebBotUrl(),
      isKernelControlEnabled: () => this.isKernelControlEnabled(),
      executeKernelAction: (payload) => this.executeKernelAction(payload),
      resolveThreadIdForChannel: (payload) => this.resolveThreadIdForChannel(payload),
      getThread: (threadId) => this.getThread(threadId),
      resetThread: (threadId) => this.resetThread(threadId),
      interruptThread: (threadId) => this.interruptThread(threadId),
      listPendingApprovals: (threadId) => this.listPendingApprovals(threadId),
      resolvePendingApproval: (payload) => this.resolvePendingApproval(payload),
      sendTurn: (payload) => this.sendTurn(payload),
    };
  }

  isKernelControlEnabled() {
    return this.config.kernelAccess?.enabled === true && this.kernelControl !== null;
  }

  async executeKernelAction({ action, payload, context }) {
    if (!this.isKernelControlEnabled()) {
      throw new Error(`Kernel control is disabled for '${this.id}'.`);
    }
    return this.kernelControl.request({
      action,
      payload: payload ?? {},
      context: context ?? { source: "internal", metadata: {} },
    });
  }

  #syncTelegramStatus() {
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
    this.telegramError = errors.length > 0 ? errors[0] : null;
  }
}
