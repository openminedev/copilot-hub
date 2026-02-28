// @ts-nocheck
import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";

const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const DEFAULT_TURN_ACTIVITY_TIMEOUT_MS = 3_600_000;

export class CodexAppClient extends EventEmitter {
  constructor({ codexBin, codexHomeDir, cwd, sandboxMode, approvalPolicy, turnActivityTimeoutMs }) {
    super();
    this.codexBin = String(codexBin ?? "codex");
    this.codexHomeDir = codexHomeDir ? path.resolve(String(codexHomeDir)) : null;
    this.cwd = path.resolve(String(cwd));
    this.sandboxMode = normalizeSandboxMode(sandboxMode);
    this.approvalPolicy = normalizeApprovalPolicy(approvalPolicy);
    this.turnActivityTimeoutMs = normalizeTimeout(
      turnActivityTimeoutMs,
      DEFAULT_TURN_ACTIVITY_TIMEOUT_MS,
    );

    this.child = null;
    this.reader = null;
    this.nextRequestId = 1;
    this.startPromise = null;
    this.started = false;

    this.pendingRequests = new Map();
    this.pendingApprovals = new Map();
    this.turnWaiters = new Map();
    this.turnOutput = new Map();
    this.completedTurns = new Map();
    this.activeTurnByThread = new Map();
  }

  setCwd(value) {
    this.cwd = path.resolve(String(value));
  }

  setPolicies({ sandboxMode, approvalPolicy }) {
    this.sandboxMode = normalizeSandboxMode(sandboxMode ?? this.sandboxMode);
    this.approvalPolicy = normalizeApprovalPolicy(approvalPolicy ?? this.approvalPolicy);
  }

  async ensureStarted() {
    if (this.started) {
      return;
    }

    if (this.startPromise) {
      await this.startPromise;
      return;
    }

    this.startPromise = this.#startInternal();
    try {
      await this.startPromise;
    } finally {
      this.startPromise = null;
    }
  }

  async shutdown() {
    this.started = false;

    if (this.reader) {
      this.reader.close();
      this.reader = null;
    }

    const child = this.child;
    this.child = null;
    if (child) {
      try {
        child.stdin.end();
      } catch {
        // Ignore stdin close errors.
      }
      child.kill();
    }

    for (const { reject, timer } of this.pendingRequests.values()) {
      clearTimeout(timer);
      reject(new Error("Codex app-server process stopped."));
    }
    this.pendingRequests.clear();

    for (const { reject, timer } of this.turnWaiters.values()) {
      clearTimeout(timer);
      reject(new Error("Codex app-server process stopped while waiting for turn completion."));
    }
    this.turnWaiters.clear();

    this.pendingApprovals.clear();
    this.completedTurns.clear();
    this.turnOutput.clear();
    this.activeTurnByThread.clear();
  }

  listPendingApprovals({ threadId } = {}) {
    const normalizedThreadId = threadId ? String(threadId) : null;
    const values = [...this.pendingApprovals.values()].filter((entry) =>
      normalizedThreadId ? entry.threadId === normalizedThreadId : true,
    );
    values.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    return values.map((entry) => ({ ...entry }));
  }

  async resolveApproval({ approvalId, decision }) {
    const normalizedApprovalId = String(approvalId ?? "").trim();
    if (!normalizedApprovalId) {
      throw new Error("approvalId is required.");
    }

    const approval = this.pendingApprovals.get(normalizedApprovalId);
    if (!approval) {
      throw new Error(`Unknown approval '${normalizedApprovalId}'.`);
    }

    const normalizedDecision = normalizeApprovalDecision(decision);
    await this.#sendResponse({
      id: approval.serverRequestId,
      result: {
        decision: normalizedDecision,
      },
    });

    this.pendingApprovals.delete(normalizedApprovalId);
    this.#resumeTurnAfterApproval(
      makeTurnKey(approval.threadId, approval.turnId),
      normalizedApprovalId,
    );
    return {
      ...approval,
      decision: normalizedDecision,
    };
  }

  async interruptTurn({ threadId }) {
    await this.ensureStarted();

    const normalizedThreadId = String(threadId ?? "").trim();
    if (!normalizedThreadId) {
      throw new Error("threadId is required.");
    }

    const active = this.activeTurnByThread.get(normalizedThreadId);
    const activeTurnId = String(active?.turnId ?? "").trim();
    if (!activeTurnId) {
      return {
        interrupted: false,
        reason: "no_active_turn",
      };
    }

    const attempts = [
      {
        method: "turn/cancel",
        params: { threadId: normalizedThreadId, turnId: activeTurnId },
      },
      {
        method: "turn/cancel",
        params: { threadId: normalizedThreadId },
      },
      {
        method: "turn/interrupt",
        params: { threadId: normalizedThreadId, turnId: activeTurnId },
      },
      {
        method: "turn/interrupt",
        params: { threadId: normalizedThreadId },
      },
    ];

    let lastError = null;
    for (const attempt of attempts) {
      try {
        await this.#sendRequest(attempt.method, attempt.params, 2_000);
        return {
          interrupted: true,
          method: attempt.method,
          turnId: activeTurnId,
        };
      } catch (error) {
        lastError = error;
      }
    }

    this.#handleProcessFailure(new Error("Turn interrupted by user (forced process restart)."));
    try {
      await this.ensureStarted();
    } catch {
      // Best effort restart only.
    }
    return {
      interrupted: true,
      method: "process_restart",
      turnId: activeTurnId,
      warning: lastError ? sanitizeError(lastError) : null,
    };
  }

  async sendTurn({
    threadId,
    prompt,
    inputItems = [],
    turnActivityTimeoutMs,
    onThreadReady = null,
  }) {
    await this.ensureStarted();

    const text = String(prompt ?? "").trim();
    const normalizedInputItems = normalizeTurnInputItems({
      prompt: text,
      inputItems,
    });

    const resolvedThreadId = await this.#ensureThread(threadId);
    if (typeof onThreadReady === "function") {
      try {
        await onThreadReady(resolvedThreadId);
      } catch (error) {
        this.emit("warning", {
          type: "thread_ready_callback_failed",
          threadId: resolvedThreadId,
          error: sanitizeError(error),
        });
      }
    }
    const response = await this.#sendRequest("turn/start", {
      threadId: resolvedThreadId,
      input: normalizedInputItems,
    });

    const turnId = String(response?.turn?.id ?? "").trim();
    if (!turnId) {
      throw new Error("turn/start did not return a turn id.");
    }
    this.activeTurnByThread.set(resolvedThreadId, {
      turnId,
      startedAt: new Date().toISOString(),
    });

    try {
      const waitTimeout = normalizeTimeout(turnActivityTimeoutMs, this.turnActivityTimeoutMs);
      const turn =
        response.turn?.status && response.turn.status !== "inProgress"
          ? response.turn
          : await this.#waitForTurnCompletion(resolvedThreadId, turnId, waitTimeout);

      if (turn.status === "failed") {
        throw new Error(turn.error?.message || "Turn failed.");
      }
      if (turn.status === "interrupted") {
        throw new Error("Turn was interrupted.");
      }

      const assistantText = await this.#resolveAssistantText(resolvedThreadId, turnId);
      return {
        threadId: resolvedThreadId,
        turnId,
        assistantText,
      };
    } finally {
      const current = this.activeTurnByThread.get(resolvedThreadId);
      if (String(current?.turnId ?? "") === turnId) {
        this.activeTurnByThread.delete(resolvedThreadId);
      }
    }
  }

  async #startInternal() {
    if (this.codexHomeDir) {
      fs.mkdirSync(this.codexHomeDir, { recursive: true });
    }

    const args = ["-C", normalizeCliPath(this.cwd), "app-server"];
    const env = this.#buildEnvironment();
    const child = spawn(this.codexBin, args, {
      windowsHide: true,
      shell: false,
      env,
    });

    this.child = child;
    this.started = true;

    this.reader = readline.createInterface({
      input: child.stdout,
      crlfDelay: Infinity,
    });
    this.reader.on("line", (line) => {
      this.#handleStdoutLine(line);
    });

    child.stderr.on("data", (chunk) => {
      const text = chunk.toString("utf8").trim();
      if (text) {
        this.emit("stderr", text);
      }
    });

    child.on("error", (error) => {
      this.#handleProcessFailure(annotateSpawnError(error, this.codexBin));
    });
    child.on("close", (code) => {
      this.#handleProcessFailure(new Error(`Codex app-server exited with code ${code ?? -1}.`));
    });

    await this.#sendRequest("initialize", {
      clientInfo: {
        name: "telegram-codex-bridge",
        title: "Telegram Codex Bridge",
        version: "0.2.0",
      },
      capabilities: {
        experimentalApi: true,
      },
    });
    await this.#sendNotification("initialized");
  }

  #buildEnvironment() {
    const env = { ...process.env };
    if (this.codexHomeDir) {
      env.CODEX_HOME = this.codexHomeDir;
    }
    return env;
  }

  async #ensureThread(threadId) {
    const previousThreadId = String(threadId ?? "").trim();
    if (previousThreadId) {
      try {
        await this.#sendRequest("thread/resume", {
          threadId: previousThreadId,
          cwd: normalizeCliPath(this.cwd),
          approvalPolicy: this.approvalPolicy,
          sandbox: this.sandboxMode,
        });
        return previousThreadId;
      } catch (error) {
        this.emit("warning", {
          type: "thread_resume_failed",
          threadId: previousThreadId,
          error: sanitizeError(error),
        });
      }
    }

    const started = await this.#sendRequest("thread/start", {
      cwd: normalizeCliPath(this.cwd),
      approvalPolicy: this.approvalPolicy,
      sandbox: this.sandboxMode,
      experimentalRawEvents: false,
    });
    const nextThreadId = String(started?.thread?.id ?? "").trim();
    if (!nextThreadId) {
      throw new Error("thread/start did not return a thread id.");
    }
    return nextThreadId;
  }

  async #resolveAssistantText(threadId, turnId) {
    const key = makeTurnKey(threadId, turnId);
    const buffered = this.turnOutput.get(key);
    if (buffered?.items?.length) {
      return buffered.items[buffered.items.length - 1];
    }
    if (buffered?.delta?.trim()) {
      return buffered.delta.trim();
    }

    const read = await this.#sendRequest("thread/read", {
      threadId,
      includeTurns: true,
    });
    const turns = Array.isArray(read?.thread?.turns) ? read.thread.turns : [];
    const targetTurn = turns.find((entry) => entry.id === turnId);
    if (!targetTurn || !Array.isArray(targetTurn.items)) {
      return "";
    }

    const messages = targetTurn.items
      .filter((entry) => entry?.type === "agentMessage" && typeof entry.text === "string")
      .map((entry) => entry.text.trim())
      .filter(Boolean);
    if (messages.length === 0) {
      return "";
    }
    return messages[messages.length - 1];
  }

  #waitForTurnCompletion(threadId, turnId, timeoutMs) {
    const key = makeTurnKey(threadId, turnId);
    const cached = this.completedTurns.get(key);
    if (cached) {
      this.completedTurns.delete(key);
      return Promise.resolve(cached);
    }

    return new Promise((resolve, reject) => {
      const waiter = {
        resolve,
        reject,
        turnId: String(turnId),
        timeoutMs,
        timer: null,
        waitingForApproval: false,
        pendingApprovalIds: new Set(),
      };
      this.turnWaiters.set(key, waiter);
      this.#armTurnActivityTimeout(key);
    });
  }

  #armTurnActivityTimeout(turnKey) {
    const waiter = this.turnWaiters.get(turnKey);
    if (!waiter) {
      return;
    }

    if (waiter.waitingForApproval) {
      if (waiter.timer) {
        clearTimeout(waiter.timer);
        waiter.timer = null;
      }
      return;
    }

    if (waiter.timer) {
      clearTimeout(waiter.timer);
    }
    waiter.timer = setTimeout(() => {
      this.turnWaiters.delete(turnKey);
      waiter.reject(
        new Error(`Turn ${waiter.turnId || "<unknown>"} inactive for ${waiter.timeoutMs}ms.`),
      );
    }, waiter.timeoutMs);
  }

  #touchTurn(threadId, turnId) {
    const key = makeTurnKey(threadId, turnId);
    if (!this.turnWaiters.has(key)) {
      return;
    }
    this.#armTurnActivityTimeout(key);
  }

  #pauseTurnForApproval(turnKey, approvalId) {
    const waiter = this.turnWaiters.get(turnKey);
    if (!waiter) {
      return;
    }

    waiter.pendingApprovalIds.add(String(approvalId));
    waiter.waitingForApproval = true;
    if (waiter.timer) {
      clearTimeout(waiter.timer);
      waiter.timer = null;
    }
  }

  #resumeTurnAfterApproval(turnKey, approvalId) {
    const waiter = this.turnWaiters.get(turnKey);
    if (!waiter) {
      return;
    }

    waiter.pendingApprovalIds.delete(String(approvalId));
    if (waiter.pendingApprovalIds.size > 0) {
      return;
    }

    waiter.waitingForApproval = false;
    this.#armTurnActivityTimeout(turnKey);
  }

  #clearTurnApprovalTracking(turnKey) {
    const waiter = this.turnWaiters.get(turnKey);
    if (!waiter) {
      return;
    }
    waiter.waitingForApproval = false;
    waiter.pendingApprovalIds.clear();
  }

  async #sendRequest(method, params, timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS) {
    await this.ensureStarted();
    const requestId = this.nextRequestId;
    this.nextRequestId += 1;

    const message = {
      jsonrpc: "2.0",
      id: requestId,
      method,
    };
    if (params !== undefined) {
      message.params = params;
    }

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingRequests.delete(requestId);
        reject(new Error(`Request '${method}' timed out after ${timeoutMs}ms.`));
      }, timeoutMs);

      this.pendingRequests.set(requestId, {
        method,
        resolve,
        reject,
        timer,
      });

      try {
        this.#writeMessage(message);
      } catch (error) {
        clearTimeout(timer);
        this.pendingRequests.delete(requestId);
        reject(error);
      }
    });
  }

  async #sendNotification(method, params) {
    await this.ensureStarted();
    const message = {
      jsonrpc: "2.0",
      method,
    };
    if (params !== undefined) {
      message.params = params;
    }
    this.#writeMessage(message);
  }

  async #sendResponse({ id, result, error }) {
    await this.ensureStarted();
    const message = {
      jsonrpc: "2.0",
      id,
    };
    if (error) {
      message.error = error;
    } else {
      message.result = result;
    }
    this.#writeMessage(message);
  }

  #writeMessage(value) {
    if (!this.child || !this.child.stdin) {
      throw new Error("Codex app-server process is not available.");
    }
    this.child.stdin.write(`${JSON.stringify(value)}\n`);
  }

  #handleStdoutLine(rawLine) {
    const line = String(rawLine ?? "").trim();
    if (!line) {
      return;
    }

    let message;
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }

    if (
      message &&
      typeof message === "object" &&
      "id" in message &&
      ("result" in message || "error" in message) &&
      !message.method
    ) {
      this.#handleResponse(message);
      return;
    }

    if (
      message &&
      typeof message === "object" &&
      "id" in message &&
      typeof message.method === "string"
    ) {
      void this.#handleServerRequest(message);
      return;
    }

    if (message && typeof message === "object" && typeof message.method === "string") {
      this.#handleNotification(message);
    }
  }

  #handleResponse(message) {
    const pending = this.pendingRequests.get(message.id);
    if (!pending) {
      return;
    }
    this.pendingRequests.delete(message.id);
    clearTimeout(pending.timer);

    if (message.error) {
      const details =
        typeof message.error?.message === "string"
          ? message.error.message
          : JSON.stringify(message.error);
      pending.reject(new Error(details || `Codex request '${pending.method}' failed.`));
      return;
    }

    pending.resolve(message.result);
  }

  async #handleServerRequest(message) {
    const method = String(message.method);

    if (
      method === "item/commandExecution/requestApproval" ||
      method === "item/fileChange/requestApproval"
    ) {
      const params = message.params ?? {};
      this.#touchTurn(params.threadId, params.turnId);
      const approval = {
        id: createApprovalId(),
        serverRequestId: message.id,
        kind:
          method === "item/commandExecution/requestApproval" ? "commandExecution" : "fileChange",
        method,
        threadId: String(params.threadId ?? ""),
        turnId: String(params.turnId ?? ""),
        itemId: String(params.itemId ?? ""),
        command: typeof params.command === "string" ? params.command : null,
        cwd: typeof params.cwd === "string" ? params.cwd : null,
        reason: typeof params.reason === "string" ? params.reason : null,
        commandActions: Array.isArray(params.commandActions) ? params.commandActions : null,
        createdAt: new Date().toISOString(),
      };
      this.pendingApprovals.set(approval.id, approval);
      this.#pauseTurnForApproval(makeTurnKey(approval.threadId, approval.turnId), approval.id);
      this.emit("approvalRequested", { ...approval });
      return;
    }

    await this.#sendResponse({
      id: message.id,
      error: {
        code: -32601,
        message: `Method '${method}' is not supported by telegram-codex-bridge.`,
      },
    });
  }

  #handleNotification(message) {
    const method = String(message.method ?? "");
    const params = message.params ?? {};

    if (method === "item/agentMessage/delta") {
      this.#touchTurn(params.threadId, params.turnId);
      const key = makeTurnKey(params.threadId, params.turnId);
      const buffer = this.turnOutput.get(key) ?? { delta: "", items: [] };
      buffer.delta += String(params.delta ?? "");
      this.turnOutput.set(key, buffer);
      return;
    }

    if (method === "item/completed") {
      this.#touchTurn(params.threadId, params.turnId);
      const key = makeTurnKey(params.threadId, params.turnId);
      const item = params.item ?? {};
      if (item.type === "agentMessage" && typeof item.text === "string") {
        const buffer = this.turnOutput.get(key) ?? { delta: "", items: [] };
        buffer.items.push(item.text.trim());
        this.turnOutput.set(key, buffer);
      }
      return;
    }

    if (method === "turn/completed") {
      const turn = params.turn;
      const key = makeTurnKey(params.threadId, turn?.id);
      this.#clearTurnApprovalTracking(key);
      const waiter = this.turnWaiters.get(key);
      if (waiter) {
        this.turnWaiters.delete(key);
        clearTimeout(waiter.timer);
        waiter.resolve(turn);
      } else {
        this.completedTurns.set(key, turn);
      }
      return;
    }

    if (method === "error") {
      this.emit("warning", {
        type: "notification_error",
        error: params?.message ? String(params.message) : "Unknown app-server error notification.",
      });
    }
  }

  #handleProcessFailure(error) {
    const reason = error instanceof Error ? error : new Error(String(error));
    if (!this.started && !this.startPromise) {
      return;
    }

    this.started = false;
    if (this.reader) {
      this.reader.close();
      this.reader = null;
    }
    this.child = null;
    this.emit("warning", {
      type: "process_failure",
      error: sanitizeError(reason),
    });

    for (const { reject, timer } of this.pendingRequests.values()) {
      clearTimeout(timer);
      reject(reason);
    }
    this.pendingRequests.clear();

    for (const { reject, timer } of this.turnWaiters.values()) {
      clearTimeout(timer);
      reject(reason);
    }
    this.turnWaiters.clear();
    this.pendingApprovals.clear();
    this.turnOutput.clear();
    this.completedTurns.clear();
    this.activeTurnByThread.clear();
  }
}

function normalizeSandboxMode(value) {
  const mode = String(value ?? "workspace-write")
    .trim()
    .toLowerCase();
  if (mode === "read-only" || mode === "workspace-write" || mode === "danger-full-access") {
    return mode;
  }
  return "workspace-write";
}

function normalizeApprovalPolicy(value) {
  const mode = String(value ?? "on-request")
    .trim()
    .toLowerCase();
  if (mode === "untrusted" || mode === "on-failure" || mode === "on-request" || mode === "never") {
    return mode;
  }
  return "on-request";
}

function normalizeApprovalDecision(value) {
  const decision = String(value ?? "")
    .trim()
    .toLowerCase();
  if (decision === "accept" || decision === "approve" || decision === "approved") {
    return "accept";
  }
  if (decision === "acceptforsession" || decision === "always") {
    return "acceptForSession";
  }
  if (
    decision === "decline" ||
    decision === "deny" ||
    decision === "denied" ||
    decision === "reject"
  ) {
    return "decline";
  }
  if (decision === "cancel" || decision === "abort") {
    return "cancel";
  }
  throw new Error("decision must be one of: accept, acceptForSession, decline, cancel.");
}

function normalizeTimeout(value, fallback) {
  const parsed = Number.parseInt(String(value ?? fallback), 10);
  if (!Number.isFinite(parsed) || parsed < 1_000) {
    return fallback;
  }
  return parsed;
}

function normalizeCliPath(value) {
  if (process.platform !== "win32") {
    return value;
  }
  return String(value).replace(/\\/g, "/");
}

function makeTurnKey(threadId, turnId) {
  return `${String(threadId ?? "")}::${String(turnId ?? "")}`;
}

function createApprovalId() {
  return `apr_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
}

function annotateSpawnError(error, command) {
  if (!error || typeof error !== "object") {
    return error;
  }

  if (error.code === "ENOENT") {
    return new Error(
      [
        `Cannot execute Codex binary '${command}' (ENOENT).`,
        "Set CODEX_BIN to a valid executable (example: C:\\Users\\<you>\\...\\codex.exe) or ensure it is on PATH.",
      ].join("\n"),
    );
  }

  if (process.platform === "win32" && error.code === "EPERM") {
    return new Error(
      [
        `Cannot execute Codex binary '${command}' (EPERM).`,
        "On Windows, verify CODEX_BIN points to an executable and that permissions allow process spawn.",
      ].join("\n"),
    );
  }

  return error;
}

function normalizeTurnInputItems({ prompt, inputItems }) {
  const items = [];
  const text = String(prompt ?? "").trim();
  if (text) {
    items.push({
      type: "text",
      text,
    });
  }

  if (Array.isArray(inputItems)) {
    for (const entry of inputItems) {
      const type = String(entry?.type ?? "")
        .trim()
        .toLowerCase();

      if (type === "image") {
        const url = String(entry?.url ?? "").trim();
        if (!url) {
          throw new Error("Image input item requires a non-empty url.");
        }
        items.push({
          type: "image",
          url,
        });
        continue;
      }

      if (type === "localimage") {
        const localPath = String(entry?.path ?? "").trim();
        if (!localPath) {
          throw new Error("localImage input item requires a non-empty path.");
        }
        items.push({
          type: "localImage",
          path: localPath,
        });
      }
    }
  }

  if (items.length === 0) {
    throw new Error("Prompt cannot be empty.");
  }
  return items;
}

function sanitizeError(error) {
  const raw = error instanceof Error ? error.message : String(error);
  return raw.split(/\r?\n/).slice(0, 12).join("\n");
}
