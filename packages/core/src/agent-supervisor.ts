import { fork, type ChildProcess } from "node:child_process";

const REQUEST_TIMEOUT_MS = 15000;
const HEARTBEAT_TIMEOUT_MS = 4000;
const WORKER_READY_TIMEOUT_MS = 30000;
const WORKER_READY_REQUEST_TIMEOUT_MS = 3000;
const WORKER_READY_POLL_INTERVAL_MS = 150;
const WORKER_RECOVERY_TIMEOUT_MS = 20000;
const WORKER_RECOVERY_POLL_INTERVAL_MS = 250;

type BotConfig = {
  id: string;
  name: string;
  enabled?: boolean;
  autoStart?: boolean;
  threadMode?: string;
  sharedThreadId?: string;
  workspaceRoot: string;
  dataDir: string;
  provider?: {
    kind?: string;
    options?: Record<string, unknown>;
  };
  kernelAccess?: {
    enabled?: boolean;
    allowedActions?: unknown;
    allowedChatIds?: unknown;
  };
  capabilities?: unknown[];
} & Record<string, unknown>;

type ProviderDefaults = Record<string, unknown>;

type KernelActionHandler = (payload: {
  actorBotId: string;
  action: unknown;
  payload: Record<string, unknown>;
  context: Record<string, unknown>;
}) => Promise<unknown> | unknown;

type WorkerStatusBase = {
  id: string;
  name: string;
  enabled: boolean;
  autoStart: boolean;
  threadMode: string;
  sharedThreadId: string;
  providerKind: string;
  kernelVersion: string | null;
  webThreadId: string | null;
  running: boolean;
  telegramRunning: boolean;
  telegramError: string | null;
  workspaceRoot: string;
  dataDir: string;
  kernelAccess: {
    enabled: boolean;
    allowedActions: string[];
    allowedChatIds: string[];
  };
  capabilities: unknown[];
  channels: unknown[];
};

type SupervisorStatus = WorkerStatusBase & {
  lastHeartbeatAt: string | null;
  lastHeartbeatError: string | null;
};

type PendingRequest = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
};

type WorkerResponseMessage = {
  type: "response";
  requestId?: unknown;
  ok?: unknown;
  result?: unknown;
  error?: unknown;
};

type WorkerEventMessage = {
  type: "event";
  event?: unknown;
};

type WorkerKernelRequestMessage = {
  type: "kernelRequest";
  requestId?: unknown;
  action?: unknown;
  payload?: unknown;
  context?: unknown;
};

export class AgentSupervisor {
  botConfig: BotConfig;
  providerDefaults: ProviderDefaults;
  turnActivityTimeoutMs: number;
  maxMessages: number;
  webPublicBaseUrl: string;
  workerScriptPath: string;
  onKernelAction: KernelActionHandler | null;
  child: ChildProcess | null;
  startingPromise: Promise<void> | null;
  shutdownRequested: boolean;
  restartTimer: NodeJS.Timeout | null;
  restartAttempt: number;
  nextRequestId: number;
  pendingRequests: Map<string, PendingRequest>;
  desiredChannelsRunning: boolean;
  heartbeatInFlight: Promise<SupervisorStatus> | null;
  recoveryPromise: Promise<void> | null;
  lastHeartbeatAt: string | null;
  lastHeartbeatError: string | null;
  statusCache: WorkerStatusBase;

  constructor({
    botConfig,
    providerDefaults,
    turnActivityTimeoutMs,
    maxMessages,
    webPublicBaseUrl,
    workerScriptPath,
    onKernelAction = null,
  }: {
    botConfig: BotConfig;
    providerDefaults: ProviderDefaults;
    turnActivityTimeoutMs: number;
    maxMessages: number;
    webPublicBaseUrl: string;
    workerScriptPath: string;
    onKernelAction?: KernelActionHandler | null;
  }) {
    this.botConfig = botConfig;
    this.providerDefaults = providerDefaults;
    this.turnActivityTimeoutMs = turnActivityTimeoutMs;
    this.maxMessages = maxMessages;
    this.webPublicBaseUrl = webPublicBaseUrl;
    this.workerScriptPath = workerScriptPath;
    this.onKernelAction = typeof onKernelAction === "function" ? onKernelAction : null;

    this.child = null;
    this.startingPromise = null;
    this.shutdownRequested = false;
    this.restartTimer = null;
    this.restartAttempt = 0;
    this.nextRequestId = 1;
    this.pendingRequests = new Map();
    this.desiredChannelsRunning = Boolean(botConfig.autoStart);
    this.heartbeatInFlight = null;
    this.recoveryPromise = null;
    this.lastHeartbeatAt = null;
    this.lastHeartbeatError = null;

    this.statusCache = createInitialStatus(botConfig);
  }

  get id(): string {
    return String(this.botConfig.id);
  }

  get config(): BotConfig {
    return this.botConfig;
  }

  getStatus(): SupervisorStatus {
    return {
      ...this.statusCache,
      lastHeartbeatAt: this.lastHeartbeatAt,
      lastHeartbeatError: this.lastHeartbeatError,
    };
  }

  setWebPublicBaseUrl(value: string): void {
    const next = String(value ?? "").trim();
    if (!next) {
      return;
    }
    this.webPublicBaseUrl = next;
    if (!this.child || !this.child.connected) {
      return;
    }
    void this.request("setWebPublicBaseUrl", { webPublicBaseUrl: next }).catch(() => {
      // Non-critical update, will reapply on restart.
    });
  }

  async boot(): Promise<void> {
    await this.ensureWorker();
    if (this.config.autoStart) {
      await this.startChannels();
      return;
    }
    await this.refreshStatus();
  }

  async ensureWorker(): Promise<void> {
    if (this.child && this.child.connected) {
      return;
    }

    if (this.startingPromise) {
      await this.startingPromise;
      return;
    }

    this.startingPromise = this.#spawnWorker();
    try {
      await this.startingPromise;
    } finally {
      this.startingPromise = null;
    }
  }

  async startChannels(): Promise<SupervisorStatus> {
    await this.ensureWorker();
    this.desiredChannelsRunning = true;
    const status = await this.request("startChannels");
    this.#updateStatus(status);
    return this.getStatus();
  }

  async stopChannels(): Promise<SupervisorStatus> {
    await this.ensureWorker();
    this.desiredChannelsRunning = false;
    const status = await this.request("stopChannels");
    this.#updateStatus(status);
    return this.getStatus();
  }

  async resetWebThread(): Promise<unknown> {
    await this.ensureWorker();
    return this.request("resetWebThread");
  }

  async listPendingApprovals(threadId?: string): Promise<unknown> {
    await this.ensureWorker();
    return this.request("listPendingApprovals", { threadId });
  }

  async resolvePendingApproval({
    threadId,
    approvalId,
    decision,
  }: {
    threadId: string;
    approvalId: string;
    decision: string;
  }): Promise<unknown> {
    await this.ensureWorker();
    return this.request("resolvePendingApproval", {
      threadId,
      approvalId,
      decision,
    });
  }

  async listCapabilities(): Promise<unknown[]> {
    const status = await this.refreshStatus();
    return status.capabilities ?? [];
  }

  setCapabilities(nextCapabilities: unknown): void {
    this.botConfig = {
      ...this.botConfig,
      capabilities: Array.isArray(nextCapabilities) ? nextCapabilities : [],
    };
  }

  async setProviderOptions(nextOptions: Record<string, unknown>): Promise<SupervisorStatus> {
    const previousConfig = this.botConfig;
    const previousProvider =
      previousConfig?.provider && typeof previousConfig.provider === "object"
        ? previousConfig.provider
        : { kind: "codex", options: {} };
    const mergedOptions = {
      ...(previousProvider.options && typeof previousProvider.options === "object"
        ? previousProvider.options
        : {}),
    };

    if (typeof nextOptions?.sandboxMode === "string" && nextOptions.sandboxMode.trim()) {
      mergedOptions.sandboxMode = nextOptions.sandboxMode.trim();
    }
    if (typeof nextOptions?.approvalPolicy === "string" && nextOptions.approvalPolicy.trim()) {
      mergedOptions.approvalPolicy = nextOptions.approvalPolicy.trim();
    }
    if (Object.prototype.hasOwnProperty.call(nextOptions ?? {}, "model")) {
      const normalizedModel = String(nextOptions?.model ?? "").trim();
      if (normalizedModel) {
        mergedOptions.model = normalizedModel;
      } else {
        delete mergedOptions.model;
      }
    }

    this.botConfig = {
      ...previousConfig,
      provider: {
        ...previousProvider,
        kind: String(previousProvider.kind ?? "codex").trim() || "codex",
        options: mergedOptions,
      },
    };

    try {
      const status = await this.forceRestart("provider options updated");
      this.#updateStatus(status);
      return this.getStatus();
    } catch (error) {
      if (isWorkerReadyTimeoutError(error)) {
        const recoveredStatus = await waitForWorkerRecovery(this).catch(() => null);
        if (recoveredStatus) {
          this.#updateStatus(recoveredStatus);
          return this.getStatus();
        }
      }

      this.botConfig = previousConfig;
      try {
        await this.forceRestart("provider options rollback");
      } catch {
        // Best effort rollback only.
      }
      throw error;
    }
  }

  async reloadCapabilities(nextCapabilities: unknown = null): Promise<SupervisorStatus> {
    if (Array.isArray(nextCapabilities)) {
      this.setCapabilities(nextCapabilities);
    }
    await this.ensureWorker();
    const payload: Record<string, unknown> = {};
    if (Array.isArray(nextCapabilities)) {
      payload.capabilityDefinitions = nextCapabilities;
    }
    const status = await this.request("reloadCapabilities", payload);
    this.#updateStatus(status);
    return this.getStatus();
  }

  async setProjectRoot(projectRoot: string): Promise<SupervisorStatus> {
    await this.ensureWorker();
    const status = await this.request("setProjectRoot", { projectRoot });
    this.#updateStatus(status);
    return this.getStatus();
  }

  async refreshStatus(timeoutMs = REQUEST_TIMEOUT_MS): Promise<SupervisorStatus> {
    await this.ensureWorker();
    const status = await this.request("getStatus", null, timeoutMs);
    this.#updateStatus(status);
    return this.getStatus();
  }

  async heartbeat({
    timeoutMs = HEARTBEAT_TIMEOUT_MS,
  }: {
    timeoutMs?: number;
  } = {}): Promise<SupervisorStatus> {
    if (this.shutdownRequested) {
      return this.getStatus();
    }

    if (this.heartbeatInFlight) {
      return this.heartbeatInFlight;
    }

    this.heartbeatInFlight = (async () => {
      try {
        const status = await this.refreshStatus(timeoutMs);
        this.lastHeartbeatAt = new Date().toISOString();
        this.lastHeartbeatError = null;
        return status;
      } catch (error) {
        this.lastHeartbeatAt = new Date().toISOString();
        this.lastHeartbeatError = sanitizeError(error);
        await this.forceRestart(`heartbeat failed: ${this.lastHeartbeatError}`);
        return this.getStatus();
      } finally {
        this.heartbeatInFlight = null;
      }
    })();

    return this.heartbeatInFlight;
  }

  async forceRestart(reason = "manual restart"): Promise<SupervisorStatus> {
    if (this.recoveryPromise) {
      await this.recoveryPromise;
      return this.getStatus();
    }

    this.recoveryPromise = (async () => {
      if (this.restartTimer) {
        clearTimeout(this.restartTimer);
        this.restartTimer = null;
      }

      const child = this.child;
      if (child && child.connected) {
        this.shutdownRequested = true;
        try {
          child.kill("SIGKILL");
        } catch {
          // Ignore kill errors.
        }
        await waitForChildExit(child, 5000).catch(() => {
          // If the process does not exit promptly, normal backoff recovery will still handle it.
        });
      }

      this.shutdownRequested = false;
      this.restartAttempt = 0;
      this.child = null;
      this.#setOfflineStatus();

      try {
        await this.ensureWorker();
      } catch (error) {
        throw new Error(`Worker restart failed (${reason}): ${sanitizeError(error)}`);
      }
    })().finally(() => {
      this.recoveryPromise = null;
    });

    await this.recoveryPromise;
    return this.getStatus();
  }

  async shutdown(): Promise<void> {
    this.shutdownRequested = true;

    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }

    if (!this.child) {
      this.#setOfflineStatus();
      return;
    }

    try {
      await this.request("shutdown");
    } catch {
      // Continue hard-stop path.
    }

    const child = this.child;
    this.child = null;
    try {
      child?.kill("SIGTERM");
    } catch {
      // Ignore.
    }
    this.#setOfflineStatus();
  }

  request(
    action: string,
    payload: unknown = null,
    timeoutMs = REQUEST_TIMEOUT_MS,
  ): Promise<unknown> {
    const child = this.child;
    if (!child || !child.connected) {
      return Promise.reject(new Error(`Worker '${this.id}' is not running.`));
    }

    const requestId = `${this.id}_${Date.now()}_${this.nextRequestId++}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingRequests.delete(requestId);
        reject(new Error(`Worker request '${action}' timed out after ${timeoutMs}ms.`));
      }, timeoutMs);

      this.pendingRequests.set(requestId, {
        resolve,
        reject,
        timer,
      });

      try {
        child.send({
          type: "request",
          requestId,
          action,
          payload,
        });
      } catch (error) {
        clearTimeout(timer);
        this.pendingRequests.delete(requestId);
        reject(toError(error));
      }
    });
  }

  async #spawnWorker(): Promise<void> {
    this.shutdownRequested = false;
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }

    const windowsForkOptions =
      process.platform === "win32" ? ({ windowsHide: true } as Record<string, unknown>) : {};

    const child = fork(this.workerScriptPath, [], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        AGENT_BOT_CONFIG_JSON: JSON.stringify(this.botConfig),
        AGENT_PROVIDER_DEFAULTS_JSON: JSON.stringify(this.providerDefaults ?? {}),
        AGENT_TURN_ACTIVITY_TIMEOUT_MS: String(this.turnActivityTimeoutMs),
        AGENT_MAX_MESSAGES: String(this.maxMessages),
        AGENT_WEB_PUBLIC_BASE_URL: this.webPublicBaseUrl,
        AGENT_KERNEL_REQUEST_TIMEOUT_MS: String(REQUEST_TIMEOUT_MS),
      },
      ...windowsForkOptions,
      stdio: ["ignore", "pipe", "pipe", "ipc"],
    });

    this.child = child;
    child.stdout?.on("data", (chunk: string | Buffer) => {
      process.stdout.write(chunk);
    });
    child.stderr?.on("data", (chunk: string | Buffer) => {
      process.stderr.write(chunk);
    });

    child.on("message", (message: unknown) => {
      this.#handleWorkerMessage(message);
    });

    child.on("exit", (code: number | null, signal: NodeJS.Signals | null) => {
      this.#handleWorkerExit({ code, signal });
    });

    child.on("error", (error: Error) => {
      this.#rejectAllPending(error);
    });

    await waitForWorkerReady(this, child);
    if (this.desiredChannelsRunning) {
      const started = await this.request("startChannels");
      this.#updateStatus(started);
      return;
    }
    await this.refreshStatus();
  }

  #handleWorkerMessage(message: unknown): void {
    const record = asRecord(message);
    if (!record.type) {
      return;
    }
    if (record.type === "response") {
      const response = record as WorkerResponseMessage;
      const requestId = String(response.requestId ?? "");
      const pending = this.pendingRequests.get(requestId);
      if (!pending) {
        return;
      }
      this.pendingRequests.delete(requestId);
      clearTimeout(pending.timer);
      if (response.ok) {
        pending.resolve(response.result);
      } else {
        pending.reject(new Error(String(response.error ?? "Unknown worker error.")));
      }
      return;
    }

    if (record.type === "event") {
      const event = record as WorkerEventMessage;
      if (event.event === "workerReady") {
        return;
      }
    }

    if (record.type === "kernelRequest") {
      void this.#handleKernelRequest(record as WorkerKernelRequestMessage);
    }
  }

  async #handleKernelRequest(message: WorkerKernelRequestMessage): Promise<void> {
    const requestId = String(message?.requestId ?? "").trim();
    if (!requestId) {
      return;
    }

    if (!this.onKernelAction) {
      this.#sendKernelResponse({
        requestId,
        ok: false,
        error: "Kernel control handler is not configured.",
      });
      return;
    }

    try {
      const result = await this.onKernelAction({
        actorBotId: this.id,
        action: message?.action,
        payload: asRecord(message?.payload),
        context: asRecord(message?.context),
      });
      this.#sendKernelResponse({
        requestId,
        ok: true,
        result,
      });
    } catch (error) {
      this.#sendKernelResponse({
        requestId,
        ok: false,
        error: sanitizeError(error),
      });
    }
  }

  #sendKernelResponse({
    requestId,
    ok,
    result = null,
    error = null,
  }: {
    requestId: string;
    ok: boolean;
    result?: unknown;
    error?: string | null;
  }): void {
    if (!this.child || !this.child.connected) {
      return;
    }
    try {
      this.child.send({
        type: "kernelResponse",
        requestId,
        ok,
        result,
        error,
      });
    } catch {
      // Ignore response send errors.
    }
  }

  #handleWorkerExit({
    code,
    signal,
  }: {
    code: number | null;
    signal: NodeJS.Signals | null;
  }): void {
    if (this.child) {
      this.child = null;
    }

    this.#rejectAllPending(
      new Error(
        `Worker '${this.id}' exited (code=${String(code ?? "null")}, signal=${String(signal ?? "null")}).`,
      ),
    );
    this.#setOfflineStatus();

    if (this.shutdownRequested) {
      return;
    }

    const delayMs = calculateRestartDelay(this.restartAttempt);
    this.restartAttempt += 1;
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      void this.ensureWorker().catch((error) => {
        console.error(`[kernel:${this.id}] worker restart failed: ${sanitizeError(error)}`);
      });
    }, delayMs);
  }

  #rejectAllPending(error: unknown): void {
    const normalized = toError(error);
    for (const pending of this.pendingRequests.values()) {
      clearTimeout(pending.timer);
      pending.reject(normalized);
    }
    this.pendingRequests.clear();
  }

  #updateStatus(status: unknown): void {
    const statusRecord = asRecord(status);
    if (Object.keys(statusRecord).length === 0) {
      return;
    }
    const running =
      typeof statusRecord.running === "boolean" ? statusRecord.running : this.statusCache.running;
    this.statusCache = {
      ...this.statusCache,
      ...statusRecord,
      running,
    };
    if (this.statusCache.running) {
      this.restartAttempt = 0;
    }
  }

  #setOfflineStatus(): void {
    this.statusCache = {
      ...this.statusCache,
      running: false,
      telegramRunning: false,
    };
  }
}

async function waitForWorkerReady(supervisor: AgentSupervisor, child: ChildProcess): Promise<void> {
  const start = Date.now();
  const timeoutMs = WORKER_READY_TIMEOUT_MS;

  while (Date.now() - start < timeoutMs) {
    if (!child.connected) {
      break;
    }
    try {
      await supervisor.request("getStatus", null, WORKER_READY_REQUEST_TIMEOUT_MS);
      return;
    } catch {
      await delay(WORKER_READY_POLL_INTERVAL_MS);
    }
  }

  throw new Error(`Worker '${supervisor.id}' did not become ready within ${timeoutMs}ms.`);
}

function createInitialStatus(botConfig: BotConfig): WorkerStatusBase {
  const provider = asRecord(botConfig.provider);
  const kernelAccess = asRecord(botConfig.kernelAccess);
  return {
    id: String(botConfig.id),
    name: String(botConfig.name),
    enabled: botConfig.enabled !== false,
    autoStart: Boolean(botConfig.autoStart),
    threadMode: String(botConfig.threadMode ?? "single"),
    sharedThreadId: String(botConfig.sharedThreadId ?? ""),
    providerKind: String(provider.kind ?? "codex"),
    kernelVersion: null,
    webThreadId: null,
    running: false,
    telegramRunning: false,
    telegramError: null,
    workspaceRoot: String(botConfig.workspaceRoot),
    dataDir: String(botConfig.dataDir),
    kernelAccess: {
      enabled: kernelAccess.enabled === true,
      allowedActions: normalizeStringList(kernelAccess.allowedActions),
      allowedChatIds: normalizeStringList(kernelAccess.allowedChatIds),
    },
    capabilities: [],
    channels: [],
  };
}

function calculateRestartDelay(attempt: number): number {
  const safeAttempt = Number.isFinite(attempt) && attempt >= 0 ? attempt : 0;
  return Math.min(30000, 1000 * 2 ** safeAttempt);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function waitForChildExit(child: ChildProcess | null, timeoutMs: number): Promise<void> {
  if (!child) {
    return Promise.resolve();
  }
  if (child.exitCode !== null || child.killed) {
    return Promise.resolve();
  }

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`Child process did not exit after ${timeoutMs}ms.`));
    }, timeoutMs);

    const onExit = () => {
      cleanup();
      resolve();
    };

    const cleanup = () => {
      clearTimeout(timer);
      child.off("exit", onExit);
    };

    child.once("exit", onExit);
  });
}

async function waitForWorkerRecovery(supervisor: AgentSupervisor): Promise<SupervisorStatus> {
  const start = Date.now();
  while (Date.now() - start < WORKER_RECOVERY_TIMEOUT_MS) {
    try {
      const status = await supervisor.refreshStatus(WORKER_READY_REQUEST_TIMEOUT_MS);
      if (status && typeof status === "object") {
        return status;
      }
    } catch {
      await delay(WORKER_RECOVERY_POLL_INTERVAL_MS);
      continue;
    }

    await delay(WORKER_RECOVERY_POLL_INTERVAL_MS);
  }

  throw new Error(
    `Worker '${supervisor.id}' did not recover within ${WORKER_RECOVERY_TIMEOUT_MS}ms after restart timeout.`,
  );
}

function isWorkerReadyTimeoutError(error: unknown): boolean {
  const message = sanitizeError(error).toLowerCase();
  return (
    message.includes("did not become ready within") ||
    message.includes("worker restart failed") ||
    message.includes("worker request 'getstatus' timed out")
  );
}

function sanitizeError(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  return raw.split(/\r?\n/).slice(0, 12).join("\n");
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
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
