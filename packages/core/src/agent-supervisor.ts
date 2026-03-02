// @ts-nocheck
import { fork } from "node:child_process";

const REQUEST_TIMEOUT_MS = 15000;
const HEARTBEAT_TIMEOUT_MS = 4000;
const WORKER_READY_TIMEOUT_MS = 30000;
const WORKER_READY_REQUEST_TIMEOUT_MS = 3000;
const WORKER_READY_POLL_INTERVAL_MS = 150;
const WORKER_RECOVERY_TIMEOUT_MS = 20000;
const WORKER_RECOVERY_POLL_INTERVAL_MS = 250;

export class AgentSupervisor {
  constructor({
    botConfig,
    providerDefaults,
    turnActivityTimeoutMs,
    maxMessages,
    webPublicBaseUrl,
    workerScriptPath,
    onKernelAction = null,
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

  get id() {
    return String(this.botConfig.id);
  }

  get config() {
    return this.botConfig;
  }

  getStatus() {
    return {
      ...this.statusCache,
      lastHeartbeatAt: this.lastHeartbeatAt,
      lastHeartbeatError: this.lastHeartbeatError,
    };
  }

  setWebPublicBaseUrl(value) {
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

  async boot() {
    await this.ensureWorker();
    if (this.config.autoStart) {
      await this.startChannels();
      return;
    }
    await this.refreshStatus();
  }

  async ensureWorker() {
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

  async startChannels() {
    await this.ensureWorker();
    this.desiredChannelsRunning = true;
    const status = await this.request("startChannels");
    this.#updateStatus(status);
    return this.getStatus();
  }

  async stopChannels() {
    await this.ensureWorker();
    this.desiredChannelsRunning = false;
    const status = await this.request("stopChannels");
    this.#updateStatus(status);
    return this.getStatus();
  }

  async resetWebThread() {
    await this.ensureWorker();
    return this.request("resetWebThread");
  }

  async listPendingApprovals(threadId) {
    await this.ensureWorker();
    return this.request("listPendingApprovals", { threadId });
  }

  async resolvePendingApproval({ threadId, approvalId, decision }) {
    await this.ensureWorker();
    return this.request("resolvePendingApproval", {
      threadId,
      approvalId,
      decision,
    });
  }

  async listCapabilities() {
    const status = await this.refreshStatus();
    return status.capabilities ?? [];
  }

  setCapabilities(nextCapabilities) {
    this.botConfig = {
      ...this.botConfig,
      capabilities: Array.isArray(nextCapabilities) ? nextCapabilities : [],
    };
  }

  async setProviderOptions(nextOptions) {
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

    this.botConfig = {
      ...previousConfig,
      provider: {
        ...previousProvider,
        kind: String(previousProvider.kind ?? "codex").trim() || "codex",
        options: mergedOptions,
      },
    };

    try {
      const status = await this.forceRestart("provider policy updated");
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
        await this.forceRestart("provider policy rollback");
      } catch {
        // Best effort rollback only.
      }
      throw error;
    }
  }

  async reloadCapabilities(nextCapabilities = null) {
    if (Array.isArray(nextCapabilities)) {
      this.setCapabilities(nextCapabilities);
    }
    await this.ensureWorker();
    const status = await this.request("reloadCapabilities", {
      capabilityDefinitions: Array.isArray(nextCapabilities) ? nextCapabilities : undefined,
    });
    this.#updateStatus(status);
    return this.getStatus();
  }

  async setProjectRoot(projectRoot) {
    await this.ensureWorker();
    const status = await this.request("setProjectRoot", { projectRoot });
    this.#updateStatus(status);
    return this.getStatus();
  }

  async refreshStatus(timeoutMs = REQUEST_TIMEOUT_MS) {
    await this.ensureWorker();
    const status = await this.request("getStatus", null, timeoutMs);
    this.#updateStatus(status);
    return this.getStatus();
  }

  async heartbeat({ timeoutMs = HEARTBEAT_TIMEOUT_MS } = {}) {
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

  async forceRestart(reason = "manual restart") {
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

  async shutdown() {
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
      child.kill("SIGTERM");
    } catch {
      // Ignore.
    }
    this.#setOfflineStatus();
  }

  request(action, payload = null, timeoutMs = REQUEST_TIMEOUT_MS) {
    if (!this.child || !this.child.connected) {
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
        this.child.send({
          type: "request",
          requestId,
          action,
          payload,
        });
      } catch (error) {
        clearTimeout(timer);
        this.pendingRequests.delete(requestId);
        reject(error);
      }
    });
  }

  async #spawnWorker() {
    this.shutdownRequested = false;
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }

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
      stdio: ["ignore", "pipe", "pipe", "ipc"],
      windowsHide: true,
    });

    this.child = child;
    child.stdout?.on("data", (chunk) => {
      process.stdout.write(chunk);
    });
    child.stderr?.on("data", (chunk) => {
      process.stderr.write(chunk);
    });

    child.on("message", (message) => {
      this.#handleWorkerMessage(message);
    });

    child.on("exit", (code, signal) => {
      this.#handleWorkerExit({ code, signal });
    });

    child.on("error", (error) => {
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

  #handleWorkerMessage(message) {
    if (!message || typeof message !== "object") {
      return;
    }
    if (message.type === "response") {
      const requestId = String(message.requestId ?? "");
      const pending = this.pendingRequests.get(requestId);
      if (!pending) {
        return;
      }
      this.pendingRequests.delete(requestId);
      clearTimeout(pending.timer);
      if (message.ok) {
        pending.resolve(message.result);
      } else {
        pending.reject(new Error(String(message.error ?? "Unknown worker error.")));
      }
      return;
    }

    if (message.type === "event") {
      if (message.event === "workerReady") {
        return;
      }
    }

    if (message.type === "kernelRequest") {
      void this.#handleKernelRequest(message);
    }
  }

  async #handleKernelRequest(message) {
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
        payload: message?.payload ?? {},
        context: message?.context ?? {},
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

  #sendKernelResponse({ requestId, ok, result = null, error = null }) {
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

  #handleWorkerExit({ code, signal }) {
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

  #rejectAllPending(error) {
    for (const pending of this.pendingRequests.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pendingRequests.clear();
  }

  #updateStatus(status) {
    if (!status || typeof status !== "object") {
      return;
    }
    this.statusCache = {
      ...this.statusCache,
      ...status,
      running: status.running ?? this.statusCache.running,
    };
    if (this.statusCache.running) {
      this.restartAttempt = 0;
    }
  }

  #setOfflineStatus() {
    this.statusCache = {
      ...this.statusCache,
      running: false,
      telegramRunning: false,
    };
  }
}

async function waitForWorkerReady(supervisor, child) {
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

function createInitialStatus(botConfig) {
  return {
    id: botConfig.id,
    name: botConfig.name,
    enabled: botConfig.enabled !== false,
    autoStart: Boolean(botConfig.autoStart),
    threadMode: botConfig.threadMode,
    sharedThreadId: botConfig.sharedThreadId,
    providerKind: botConfig.provider?.kind ?? "codex",
    kernelVersion: null,
    webThreadId: null,
    running: false,
    telegramRunning: false,
    telegramError: null,
    workspaceRoot: botConfig.workspaceRoot,
    dataDir: botConfig.dataDir,
    kernelAccess: {
      enabled: botConfig.kernelAccess?.enabled === true,
      allowedActions: Array.isArray(botConfig.kernelAccess?.allowedActions)
        ? [...botConfig.kernelAccess.allowedActions]
        : [],
      allowedChatIds: Array.isArray(botConfig.kernelAccess?.allowedChatIds)
        ? [...botConfig.kernelAccess.allowedChatIds]
        : [],
    },
    capabilities: [],
    channels: [],
  };
}

function calculateRestartDelay(attempt) {
  const safeAttempt = Number.isFinite(attempt) && attempt >= 0 ? attempt : 0;
  return Math.min(30000, 1000 * 2 ** safeAttempt);
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function waitForChildExit(child, timeoutMs) {
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

async function waitForWorkerRecovery(supervisor) {
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

function isWorkerReadyTimeoutError(error) {
  const message = sanitizeError(error).toLowerCase();
  return (
    message.includes("did not become ready within") ||
    message.includes("worker restart failed") ||
    message.includes("worker request 'getstatus' timed out")
  );
}

function sanitizeError(error) {
  const raw = error instanceof Error ? error.message : String(error);
  return raw.split(/\r?\n/).slice(0, 12).join("\n");
}
