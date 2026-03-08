import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import {
  extractQuotaSnapshot,
  extractSessionConfiguredModel,
  extractThreadLifecycleModel,
} from "./codex-app-events.js";
import {
  annotateSpawnError,
  asRecord,
  createApprovalId,
  isRecord,
  makeTurnKey,
  normalizeApprovalDecision,
  normalizeApprovalPolicy,
  normalizeCliPath,
  normalizeModel,
  normalizeSandboxMode,
  normalizeTimeout,
  normalizeTurnInputItems,
  sanitizeError,
  toRequestId,
  toRpcId,
} from "./codex-app-utils.js";
import type {
  ApprovalDecision,
  ApprovalPolicy,
  ModelValue,
  SandboxMode,
} from "./codex-app-utils.js";

const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const DEFAULT_TURN_ACTIVITY_TIMEOUT_MS = 3_600_000;

type ApprovalRecord = {
  id: string;
  serverRequestId: string | number;
  kind: string;
  method: string;
  threadId: string;
  turnId: string;
  itemId: string;
  command: string | null;
  cwd: string | null;
  reason: string | null;
  commandActions: unknown[] | null;
  createdAt: string;
};

type TurnOutputBuffer = {
  delta: string;
  items: string[];
};

type TurnWaiter = {
  resolve: (value: TurnCompletion | PromiseLike<TurnCompletion>) => void;
  reject: (error?: unknown) => void;
  turnId: string;
  timeoutMs: number;
  timer: NodeJS.Timeout | null;
  waitingForApproval: boolean;
  pendingApprovalIds: Set<string>;
};

type PendingRequest = {
  method: string;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
};

type TurnState = {
  turnId: string;
  startedAt: string;
};

type TurnCompletion = {
  id?: string;
  status?: string;
  error?: {
    message?: string;
  };
  [key: string]: unknown;
};

type ListModelsResponse = {
  data?: unknown[];
  nextCursor?: string;
};

type ThreadResponse = {
  thread?: {
    id?: string;
    turns?: Array<{
      id?: string;
      items?: Array<{ type?: string; text?: string }>;
    }>;
  };
};

type TurnStartResponse = {
  turn?: TurnCompletion;
};

export class CodexAppClient extends EventEmitter {
  codexBin: string;
  codexHomeDir: string | null;
  cwd: string;
  sandboxMode: SandboxMode;
  approvalPolicy: ApprovalPolicy;
  model: ModelValue;
  turnActivityTimeoutMs: number;
  child: ReturnType<typeof spawn> | null;
  reader: readline.Interface | null;
  nextRequestId: number;
  startPromise: Promise<void> | null;
  started: boolean;
  pendingRequests: Map<number, PendingRequest>;
  pendingApprovals: Map<string, ApprovalRecord>;
  turnWaiters: Map<string, TurnWaiter>;
  turnOutput: Map<string, TurnOutputBuffer>;
  completedTurns: Map<string, TurnCompletion>;
  activeTurnByThread: Map<string, TurnState>;
  latestQuotaSnapshot: Record<string, unknown> | null;
  latestSessionModel: string | null;
  latestSessionModelUpdatedAt: string | null;

  constructor({
    codexBin,
    codexHomeDir,
    cwd,
    sandboxMode,
    approvalPolicy,
    model,
    turnActivityTimeoutMs,
  }: {
    codexBin?: unknown;
    codexHomeDir?: unknown;
    cwd?: unknown;
    sandboxMode?: unknown;
    approvalPolicy?: unknown;
    model?: unknown;
    turnActivityTimeoutMs?: unknown;
  }) {
    super();
    this.codexBin = String(codexBin ?? "codex");
    this.codexHomeDir = codexHomeDir ? path.resolve(String(codexHomeDir)) : null;
    this.cwd = path.resolve(String(cwd));
    this.sandboxMode = normalizeSandboxMode(sandboxMode);
    this.approvalPolicy = normalizeApprovalPolicy(approvalPolicy);
    this.model = normalizeModel(model);
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
    this.latestQuotaSnapshot = null;
    this.latestSessionModel = null;
    this.latestSessionModelUpdatedAt = null;
  }

  setCwd(value: string): void {
    this.cwd = path.resolve(String(value));
  }

  setPolicies(
    options: {
      sandboxMode?: SandboxMode;
      approvalPolicy?: ApprovalPolicy;
      model?: ModelValue;
    } = {},
  ): void {
    const { sandboxMode, approvalPolicy, model } = options;
    this.sandboxMode = normalizeSandboxMode(sandboxMode ?? this.sandboxMode);
    this.approvalPolicy = normalizeApprovalPolicy(approvalPolicy ?? this.approvalPolicy);
    if (Object.prototype.hasOwnProperty.call(options, "model")) {
      this.model = normalizeModel(model);
    }
  }

  async ensureStarted(): Promise<void> {
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

  async shutdown(): Promise<void> {
    this.started = false;

    if (this.reader) {
      this.reader.close();
      this.reader = null;
    }

    const child = this.child;
    this.child = null;
    if (child) {
      try {
        if (child.stdin) {
          child.stdin.end();
        }
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
      if (timer) {
        clearTimeout(timer);
      }
      reject(new Error("Codex app-server process stopped while waiting for turn completion."));
    }
    this.turnWaiters.clear();

    this.pendingApprovals.clear();
    this.completedTurns.clear();
    this.turnOutput.clear();
    this.activeTurnByThread.clear();
    this.latestSessionModel = null;
    this.latestSessionModelUpdatedAt = null;
  }

  listPendingApprovals({ threadId }: { threadId?: string } = {}): ApprovalRecord[] {
    const normalizedThreadId = threadId ? String(threadId) : null;
    const values = [...this.pendingApprovals.values()].filter((entry) =>
      normalizedThreadId ? entry.threadId === normalizedThreadId : true,
    );
    values.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    return values.map((entry) => ({ ...entry }));
  }

  getLatestQuotaSnapshot(): Record<string, unknown> | null {
    const snapshot: Record<string, unknown> = isRecord(this.latestQuotaSnapshot)
      ? (JSON.parse(JSON.stringify(this.latestQuotaSnapshot)) as Record<string, unknown>)
      : {};

    if (this.latestSessionModel) {
      snapshot.model = this.latestSessionModel;
      if (!snapshot.updatedAt && this.latestSessionModelUpdatedAt) {
        snapshot.updatedAt = this.latestSessionModelUpdatedAt;
      }
    }

    if (!snapshot || Object.keys(snapshot).length === 0) {
      return null;
    }

    return snapshot;
  }

  async listModels({ limit = 100 }: { limit?: number } = {}): Promise<
    Array<{
      id: string;
      model: string;
      displayName: string;
      description: string;
      isDefault: boolean;
    }>
  > {
    await this.ensureStarted();

    const safeLimit = Number.isFinite(Number(limit))
      ? Math.min(Math.max(Number(limit), 1), 500)
      : 100;

    const models = [];
    const seen = new Set();
    let cursor = null;
    let guard = 0;

    while (guard < 20) {
      const response: ListModelsResponse = await this.#sendRequest("model/list", {
        cursor,
        limit: safeLimit,
      });
      const page = Array.isArray(response.data) ? response.data : [];

      for (const entry of page) {
        const modelEntry = asRecord(entry);
        const model = String(modelEntry.model ?? modelEntry.id ?? "").trim();
        if (!model || seen.has(model)) {
          continue;
        }
        seen.add(model);
        models.push({
          id: String(modelEntry.id ?? model).trim() || model,
          model,
          displayName: String(modelEntry.displayName ?? model).trim() || model,
          description: String(modelEntry.description ?? "").trim(),
          isDefault: modelEntry.isDefault === true,
        });
      }

      const nextCursor: string = String(response.nextCursor ?? "").trim();
      if (!nextCursor) {
        break;
      }
      cursor = nextCursor;
      guard += 1;
    }

    return models.sort((a, b) => {
      if (a.isDefault !== b.isDefault) {
        return a.isDefault ? -1 : 1;
      }
      return a.displayName.localeCompare(b.displayName);
    });
  }

  async resolveApproval({
    approvalId,
    decision,
  }: {
    approvalId: string;
    decision: ApprovalDecision | string;
  }): Promise<ApprovalRecord & { decision: ApprovalDecision }> {
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

  async interruptTurn({ threadId }: { threadId: string | null }): Promise<Record<string, unknown>> {
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
  }: {
    threadId: string;
    prompt: string;
    inputItems?: unknown[];
    turnActivityTimeoutMs?: number;
    onThreadReady?: ((threadId: string) => Promise<unknown> | unknown) | null;
  }): Promise<{ threadId: string; turnId: string; assistantText: string }> {
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
    const response = await this.#sendRequest<TurnStartResponse>("turn/start", {
      threadId: resolvedThreadId,
      input: normalizedInputItems,
    });

    const turnId = String(response.turn?.id ?? "").trim();
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

  async #startInternal(): Promise<void> {
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

  #buildEnvironment(): NodeJS.ProcessEnv {
    const env = { ...process.env };
    if (this.codexHomeDir) {
      env.CODEX_HOME = this.codexHomeDir;
    }
    return env;
  }

  async #ensureThread(threadId: string): Promise<string> {
    const previousThreadId = String(threadId ?? "").trim();
    if (previousThreadId) {
      const resumeParams: {
        threadId: string;
        cwd: string;
        approvalPolicy: ApprovalPolicy;
        sandbox: SandboxMode;
        model?: string;
      } = {
        threadId: previousThreadId,
        cwd: normalizeCliPath(this.cwd),
        approvalPolicy: this.approvalPolicy,
        sandbox: this.sandboxMode,
      };
      if (this.model) {
        resumeParams.model = this.model;
      }
      try {
        await this.#sendRequest("thread/resume", resumeParams);
        return previousThreadId;
      } catch (error) {
        this.emit("warning", {
          type: "thread_resume_failed",
          threadId: previousThreadId,
          error: sanitizeError(error),
        });
      }
    }

    const startParams: {
      cwd: string;
      approvalPolicy: ApprovalPolicy;
      sandbox: SandboxMode;
      experimentalRawEvents: boolean;
      model?: string;
    } = {
      cwd: normalizeCliPath(this.cwd),
      approvalPolicy: this.approvalPolicy,
      sandbox: this.sandboxMode,
      experimentalRawEvents: false,
    };
    if (this.model) {
      startParams.model = this.model;
    }

    const started = await this.#sendRequest<ThreadResponse>("thread/start", startParams);
    const nextThreadId = String(started.thread?.id ?? "").trim();
    if (!nextThreadId) {
      throw new Error("thread/start did not return a thread id.");
    }
    return nextThreadId;
  }

  async #resolveAssistantText(threadId: string, turnId: string): Promise<string> {
    const key = makeTurnKey(threadId, turnId);
    const buffered = this.turnOutput.get(key);
    if (buffered?.items?.length) {
      const lastBufferedItem = buffered.items[buffered.items.length - 1];
      if (lastBufferedItem) {
        return lastBufferedItem;
      }
    }
    if (buffered?.delta?.trim()) {
      return buffered.delta.trim();
    }

    const read = await this.#sendRequest<ThreadResponse>("thread/read", {
      threadId,
      includeTurns: true,
    });
    const turns = Array.isArray(read.thread?.turns) ? read.thread.turns : [];
    const targetTurn = turns.find((entry) => entry.id === turnId);
    if (!targetTurn || !Array.isArray(targetTurn.items)) {
      return "";
    }

    const messages = targetTurn.items
      .filter(
        (
          entry,
        ): entry is {
          type: string;
          text: string;
        } => entry.type === "agentMessage" && typeof entry.text === "string",
      )
      .map((entry) => entry.text.trim())
      .filter(Boolean);
    if (messages.length === 0) {
      return "";
    }
    return messages[messages.length - 1] ?? "";
  }

  #waitForTurnCompletion(
    threadId: string,
    turnId: string,
    timeoutMs: number,
  ): Promise<TurnCompletion> {
    const key = makeTurnKey(threadId, turnId);
    const cached = this.completedTurns.get(key);
    if (cached) {
      this.completedTurns.delete(key);
      return Promise.resolve(cached);
    }

    return new Promise((resolve, reject) => {
      const waiter: TurnWaiter = {
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

  #armTurnActivityTimeout(turnKey: string): void {
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
    if (!Number.isFinite(waiter.timeoutMs) || waiter.timeoutMs <= 0) {
      waiter.timer = null;
      return;
    }
    waiter.timer = setTimeout(() => {
      this.turnWaiters.delete(turnKey);
      waiter.reject(
        new Error(`Turn ${waiter.turnId || "<unknown>"} inactive for ${waiter.timeoutMs}ms.`),
      );
    }, waiter.timeoutMs);
  }

  #touchTurn(threadId: string, turnId: string): void {
    const key = makeTurnKey(threadId, turnId);
    if (!this.turnWaiters.has(key)) {
      return;
    }
    this.#armTurnActivityTimeout(key);
  }

  #pauseTurnForApproval(turnKey: string, approvalId: string): void {
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

  #resumeTurnAfterApproval(turnKey: string, approvalId: string): void {
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

  #clearTurnApprovalTracking(turnKey: string): void {
    const waiter = this.turnWaiters.get(turnKey);
    if (!waiter) {
      return;
    }
    waiter.waitingForApproval = false;
    waiter.pendingApprovalIds.clear();
  }

  async #sendRequest<T = unknown>(
    method: string,
    params?: unknown,
    timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
  ): Promise<T> {
    await this.ensureStarted();
    const requestId = this.nextRequestId;
    this.nextRequestId += 1;

    const message: {
      jsonrpc: "2.0";
      id: number;
      method: string;
      params?: unknown;
    } = {
      jsonrpc: "2.0",
      id: requestId,
      method,
    };
    if (params !== undefined) {
      message.params = params;
    }

    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingRequests.delete(requestId);
        reject(new Error(`Request '${method}' timed out after ${timeoutMs}ms.`));
      }, timeoutMs);

      this.pendingRequests.set(requestId, {
        method,
        resolve: resolve as (value: unknown) => void,
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

  async #sendNotification(method: string, params?: unknown): Promise<void> {
    await this.ensureStarted();
    const message: {
      jsonrpc: "2.0";
      method: string;
      params?: unknown;
    } = {
      jsonrpc: "2.0",
      method,
    };
    if (params !== undefined) {
      message.params = params;
    }
    this.#writeMessage(message);
  }

  async #sendResponse({
    id,
    result,
    error,
  }: {
    id: string | number;
    result?: unknown;
    error?: unknown;
  }): Promise<void> {
    await this.ensureStarted();
    const message: {
      jsonrpc: "2.0";
      id: string | number;
      result?: unknown;
      error?: unknown;
    } = {
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

  #writeMessage(value: unknown): void {
    if (!this.child || !this.child.stdin) {
      throw new Error("Codex app-server process is not available.");
    }
    this.child.stdin.write(`${JSON.stringify(value)}\n`);
  }

  #handleStdoutLine(rawLine: string): void {
    const line = String(rawLine ?? "").trim();
    if (!line) {
      return;
    }

    let message: unknown;
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }

    this.#captureQuotaSnapshot(message);
    if (!isRecord(message)) {
      return;
    }

    if ("id" in message && ("result" in message || "error" in message) && !("method" in message)) {
      this.#handleResponse(message);
      return;
    }

    if ("id" in message && typeof message.method === "string") {
      void this.#handleServerRequest(message);
      return;
    }

    if (typeof message.method === "string") {
      this.#handleNotification(message);
    }
  }

  #captureQuotaSnapshot(message: unknown): void {
    const sessionModel =
      extractThreadLifecycleModel(message) || extractSessionConfiguredModel(message);
    if (sessionModel) {
      this.latestSessionModel = sessionModel;
      this.latestSessionModelUpdatedAt = new Date().toISOString();
    }

    const snapshot = extractQuotaSnapshot(message);
    if (!snapshot) {
      return;
    }
    const snapshotRecord = JSON.parse(JSON.stringify(snapshot)) as Record<string, unknown>;
    if (this.latestSessionModel) {
      snapshotRecord.model = this.latestSessionModel;
    }
    this.latestQuotaSnapshot = snapshotRecord;
    this.emit("quota", snapshotRecord);
  }

  #handleResponse(message: Record<string, unknown>): void {
    const requestId = toRequestId(message.id);
    if (requestId === null) {
      return;
    }
    const pending = this.pendingRequests.get(requestId);
    if (!pending) {
      return;
    }
    this.pendingRequests.delete(requestId);
    clearTimeout(pending.timer);

    if (message.error) {
      const errorPayload = asRecord(message.error);
      const details =
        typeof errorPayload.message === "string"
          ? errorPayload.message
          : JSON.stringify(message.error);
      pending.reject(new Error(details || `Codex request '${pending.method}' failed.`));
      return;
    }

    pending.resolve(message.result);
  }

  async #handleServerRequest(message: Record<string, unknown>): Promise<void> {
    const method = String(message.method);
    const serverRequestId = toRpcId(message.id);
    if (serverRequestId === null) {
      return;
    }

    if (
      method === "item/commandExecution/requestApproval" ||
      method === "item/fileChange/requestApproval"
    ) {
      const params = asRecord(message.params);
      this.#touchTurn(String(params.threadId ?? ""), String(params.turnId ?? ""));
      const approval: ApprovalRecord = {
        id: createApprovalId(),
        serverRequestId,
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
      id: serverRequestId,
      error: {
        code: -32601,
        message: `Method '${method}' is not supported by telegram-codex-bridge.`,
      },
    });
  }

  #handleNotification(message: Record<string, unknown>): void {
    const method = String(message.method ?? "");
    const params = asRecord(message.params);

    if (method === "item/agentMessage/delta") {
      const threadId = String(params.threadId ?? "");
      const turnId = String(params.turnId ?? "");
      this.#touchTurn(threadId, turnId);
      const key = makeTurnKey(threadId, turnId);
      const buffer = this.turnOutput.get(key) ?? { delta: "", items: [] };
      buffer.delta += String(params.delta ?? "");
      this.turnOutput.set(key, buffer);
      return;
    }

    if (method === "item/completed") {
      const threadId = String(params.threadId ?? "");
      const turnId = String(params.turnId ?? "");
      this.#touchTurn(threadId, turnId);
      const key = makeTurnKey(threadId, turnId);
      const item = asRecord(params.item);
      if (item.type === "agentMessage" && typeof item.text === "string") {
        const buffer = this.turnOutput.get(key) ?? { delta: "", items: [] };
        buffer.items.push(item.text.trim());
        this.turnOutput.set(key, buffer);
      }
      return;
    }

    if (method === "turn/completed") {
      const threadId = String(params.threadId ?? "");
      const turn = asRecord(params.turn) as TurnCompletion;
      const turnId = String(turn.id ?? "");
      const key = makeTurnKey(threadId, turnId);
      this.#clearTurnApprovalTracking(key);
      const waiter = this.turnWaiters.get(key);
      if (waiter) {
        this.turnWaiters.delete(key);
        if (waiter.timer) {
          clearTimeout(waiter.timer);
        }
        waiter.resolve(turn);
      } else {
        this.completedTurns.set(key, turn);
      }
      return;
    }

    if (method === "error") {
      this.emit("warning", {
        type: "notification_error",
        error:
          typeof params.message === "string"
            ? params.message
            : "Unknown app-server error notification.",
      });
    }
  }

  #handleProcessFailure(error: unknown): void {
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
      if (timer) {
        clearTimeout(timer);
      }
      reject(reason);
    }
    this.turnWaiters.clear();
    this.pendingApprovals.clear();
    this.turnOutput.clear();
    this.completedTurns.clear();
    this.activeTurnByThread.clear();
    this.latestSessionModel = null;
    this.latestSessionModelUpdatedAt = null;
  }
}
