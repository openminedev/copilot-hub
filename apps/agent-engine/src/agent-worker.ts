import { BotRuntime } from "@copilot-hub/core/bot-runtime";

type UnknownRecord = Record<string, unknown>;

type PendingKernelRequest = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
};

const rawBotConfig = String(process.env.AGENT_BOT_CONFIG_JSON ?? "").trim();
const rawProviderDefaults = String(process.env.AGENT_PROVIDER_DEFAULTS_JSON ?? "").trim();
const turnActivityTimeoutMs = Number.parseInt(
  String(process.env.AGENT_TURN_ACTIVITY_TIMEOUT_MS ?? "0"),
  10,
);
const maxMessages = Number.parseInt(String(process.env.AGENT_MAX_MESSAGES ?? "200"), 10);
const initialWebPublicBaseUrl = String(
  process.env.AGENT_WEB_PUBLIC_BASE_URL ?? "http://127.0.0.1:8787",
).trim();
const kernelRequestTimeoutMs = Number.parseInt(
  String(process.env.AGENT_KERNEL_REQUEST_TIMEOUT_MS ?? "20000"),
  10,
);

if (!rawBotConfig) {
  throw new Error("AGENT_BOT_CONFIG_JSON is required.");
}

const botConfig = JSON.parse(rawBotConfig);
const providerDefaults = rawProviderDefaults ? JSON.parse(rawProviderDefaults) : {};

let nextKernelRequestId = 1;
const pendingKernelRequests = new Map<string, PendingKernelRequest>();

const runtime = new BotRuntime({
  botConfig,
  providerDefaults,
  turnActivityTimeoutMs,
  maxMessages,
  kernelControl: {
    request: (payload: { action: unknown; payload?: unknown; context?: unknown }) =>
      requestKernelAction(payload),
  },
} as any);
runtime.setWebPublicBaseUrl(initialWebPublicBaseUrl);

process.on("message", (message: unknown) => {
  void handleInboundMessage(message);
});

process.on("disconnect", () => {
  void gracefulShutdown(0);
});

process.on("SIGINT", () => {
  void gracefulShutdown(0);
});

process.on("SIGTERM", () => {
  void gracefulShutdown(0);
});

process.on("uncaughtException", (error) => {
  console.error(`Worker uncaught exception: ${sanitizeError(error)}`);
  void gracefulShutdown(1);
});

process.on("unhandledRejection", (reason) => {
  console.error(`Worker unhandled rejection: ${sanitizeError(reason)}`);
  void gracefulShutdown(1);
});

sendEvent("workerReady", {
  runtimeId: runtime.id,
  name: runtime.name,
});

async function handleInboundMessage(message: unknown): Promise<void> {
  const record = asRecord(message);
  const type = String(record.type ?? "request").trim();
  if (type === "kernelResponse") {
    handleKernelResponse(record);
    return;
  }
  if (type !== "request") {
    return;
  }

  try {
    await handleWorkerRequest(record);
  } catch (error) {
    const requestId = record.requestId ?? null;
    if (requestId !== null && requestId !== undefined) {
      sendResponse({
        requestId,
        ok: false,
        error: sanitizeError(error),
      });
      return;
    }
    console.error(`Worker inbound message failed: ${sanitizeError(error)}`);
  }
}

async function handleWorkerRequest(message: UnknownRecord): Promise<void> {
  const requestId = message.requestId;
  const action = String(message.action ?? "").trim();
  const payload = asRecord(message.payload);

  if (!requestId) {
    throw new Error("requestId is required.");
  }
  if (!action) {
    throw new Error("action is required.");
  }

  let result: unknown;
  switch (action) {
    case "getStatus": {
      result = runtime.getStatus();
      break;
    }
    case "startChannels": {
      result = await runtime.startChannels();
      break;
    }
    case "stopChannels": {
      result = await runtime.stopChannels();
      break;
    }
    case "resetWebThread": {
      result = await runtime.resetWebThread();
      break;
    }
    case "listPendingApprovals": {
      const threadId = payload.threadId ? String(payload.threadId) : undefined;
      result = await runtime.listPendingApprovals(threadId);
      break;
    }
    case "resolvePendingApproval": {
      result = await runtime.resolvePendingApproval({
        threadId: String(payload.threadId ?? ""),
        approvalId: String(payload.approvalId ?? ""),
        decision: String(payload.decision ?? ""),
      });
      break;
    }
    case "reloadCapabilities": {
      const capabilityDefinitions = Array.isArray(payload.capabilityDefinitions)
        ? payload.capabilityDefinitions
        : null;
      result = await runtime.reloadCapabilities(capabilityDefinitions as any);
      break;
    }
    case "setProviderOptions": {
      result = await runtime.setProviderOptions(payload);
      break;
    }
    case "refreshProviderSession": {
      result = await runtime.refreshProviderSession(String(payload.reason ?? ""));
      break;
    }
    case "setProjectRoot": {
      const projectRoot = String(payload.projectRoot ?? "").trim();
      if (!projectRoot) {
        throw new Error("projectRoot is required.");
      }
      await runtime.setProjectRoot(projectRoot);
      result = runtime.getStatus();
      break;
    }
    case "setWebPublicBaseUrl": {
      const value = String(payload.webPublicBaseUrl ?? "").trim();
      if (!value) {
        throw new Error("webPublicBaseUrl is required.");
      }
      runtime.setWebPublicBaseUrl(value);
      result = runtime.getStatus();
      break;
    }
    case "shutdown": {
      await runtime.shutdown();
      result = { ok: true };
      sendResponse({ requestId, ok: true, result });
      process.exit(0);
      return;
    }
    default: {
      throw new Error(`Unsupported worker action '${action}'.`);
    }
  }

  sendResponse({ requestId, ok: true, result });
}

async function gracefulShutdown(exitCode: number): Promise<void> {
  try {
    await runtime.shutdown();
  } catch {
    // Ignore shutdown errors during process termination.
  }

  for (const pending of pendingKernelRequests.values()) {
    clearTimeout(pending.timer);
    pending.reject(new Error("Worker process is shutting down."));
  }
  pendingKernelRequests.clear();
  process.exit(exitCode);
}

function sendResponse(value: UnknownRecord): void {
  if (!process.send) {
    return;
  }
  process.send({
    type: "response",
    ...value,
  });
}

function sendEvent(event: string, payload: UnknownRecord): void {
  if (!process.send) {
    return;
  }
  process.send({
    type: "event",
    event,
    payload,
  });
}

function requestKernelAction({
  action,
  payload,
  context,
}: {
  action: unknown;
  payload?: unknown;
  context?: unknown;
}): Promise<unknown> {
  if (!process.send) {
    return Promise.reject(new Error("Kernel IPC is unavailable."));
  }

  const requestId = `kreq_${Date.now()}_${nextKernelRequestId++}`;
  const timeoutMs =
    Number.isFinite(kernelRequestTimeoutMs) && kernelRequestTimeoutMs >= 1000
      ? kernelRequestTimeoutMs
      : 20000;

  return new Promise((resolve, reject) => {
    const send = process.send;
    if (!send) {
      reject(new Error("Kernel IPC is unavailable."));
      return;
    }

    const timer = setTimeout(() => {
      pendingKernelRequests.delete(requestId);
      reject(new Error(`Kernel request '${String(action ?? "")}' timed out after ${timeoutMs}ms.`));
    }, timeoutMs);

    pendingKernelRequests.set(requestId, {
      resolve,
      reject,
      timer,
    });

    try {
      send({
        type: "kernelRequest",
        requestId,
        action,
        payload,
        context,
      });
    } catch (error) {
      clearTimeout(timer);
      pendingKernelRequests.delete(requestId);
      reject(error as Error);
    }
  });
}

function handleKernelResponse(message: UnknownRecord): void {
  const requestId = String(message.requestId ?? "").trim();
  if (!requestId) {
    return;
  }
  const pending = pendingKernelRequests.get(requestId);
  if (!pending) {
    return;
  }
  pendingKernelRequests.delete(requestId);
  clearTimeout(pending.timer);
  if (message.ok) {
    pending.resolve(message.result);
    return;
  }
  pending.reject(new Error(String(message.error ?? "Unknown kernel response error.")));
}

function sanitizeError(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  return raw.split(/\r?\n/).slice(0, 12).join("\n");
}

function asRecord(value: unknown): UnknownRecord {
  return value && typeof value === "object" ? (value as UnknownRecord) : {};
}
