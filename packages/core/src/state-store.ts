import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

const STATE_VERSION = 3;
const DEFAULT_MAX_MESSAGES = 200;

type MessageRole = "user" | "assistant" | "system";
type MessageSource = "telegram" | "web" | "internal";

export interface StateMessage {
  id: string;
  role: MessageRole;
  source: MessageSource;
  text: string;
  createdAt: string;
}

export interface ThreadState {
  sessionId: string | null;
  turnCount: number;
  lastMode: string | null;
  createdAt: string;
  updatedAt: string;
  messages: StateMessage[];
}

export interface StateShape {
  version: number;
  fingerprint: string | null;
  threads: Record<string, ThreadState>;
  bindings: {
    channelUsers: Record<string, string>;
  };
}

const EMPTY_STATE: StateShape = {
  version: STATE_VERSION,
  fingerprint: null,
  threads: {},
  bindings: {
    channelUsers: {},
  },
};

export class JsonStateStore {
  filePath: string;
  state: StateShape | null;

  constructor(filePath: unknown) {
    this.filePath = String(filePath);
    this.state = null;
  }

  async init(): Promise<void> {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    this.state = await this.readOrInit();
  }

  async ensureFingerprint(expectedFingerprint: unknown): Promise<{
    changed: boolean;
    reset: boolean;
    previousFingerprint?: string;
  }> {
    await this.ensureInit();
    const expected = String(expectedFingerprint ?? "").trim();
    if (!expected) {
      return { changed: false, reset: false };
    }

    const current = String(this.state!.fingerprint ?? "").trim();
    if (current && current !== expected) {
      this.state = {
        ...EMPTY_STATE,
        fingerprint: expected,
      };
      await this.flush();
      return {
        changed: true,
        reset: true,
        previousFingerprint: current,
      };
    }

    if (current !== expected) {
      this.state!.fingerprint = expected;
      await this.flush();
      return {
        changed: true,
        reset: false,
      };
    }

    return { changed: false, reset: false };
  }

  async ensureThread(threadId: unknown): Promise<ThreadState> {
    await this.ensureInit();
    const key = String(threadId);
    if (!this.state!.threads[key]) {
      const now = new Date().toISOString();
      this.state!.threads[key] = createDefaultThread(now);
      await this.flush();
    }
    return this.state!.threads[key];
  }

  async getThread(threadId: unknown): Promise<ThreadState | null> {
    await this.ensureInit();
    return this.state!.threads[String(threadId)] ?? null;
  }

  async upsertThread(
    threadId: unknown,
    updater: (thread: ThreadState) => Partial<ThreadState> | ThreadState,
  ): Promise<ThreadState> {
    await this.ensureInit();
    const key = String(threadId);
    const now = new Date().toISOString();
    const current = this.state!.threads[key] ?? createDefaultThread(now);
    const next = updater(cloneThread(current));
    this.state!.threads[key] = {
      ...createDefaultThread(current.createdAt),
      ...next,
      createdAt: current.createdAt,
      updatedAt: now,
      messages: ensureMessages(next?.messages ?? current.messages ?? []),
    };
    await this.flush();
    return this.state!.threads[key];
  }

  async appendMessage(
    threadId: unknown,
    message: unknown,
    maxMessages = DEFAULT_MAX_MESSAGES,
  ): Promise<ThreadState> {
    return this.upsertThread(threadId, (thread) => ({
      ...thread,
      messages: trimMessages([...(thread.messages ?? []), sanitizeMessage(message)], maxMessages),
    }));
  }

  async resetThread(threadId: unknown): Promise<ThreadState> {
    return this.upsertThread(threadId, (thread) => ({
      ...thread,
      sessionId: null,
      turnCount: 0,
      lastMode: null,
      messages: [],
    }));
  }

  async listMessages(threadId: unknown, limit = DEFAULT_MAX_MESSAGES): Promise<StateMessage[]> {
    await this.ensureInit();
    const thread = this.state!.threads[String(threadId)];
    if (!thread) {
      return [];
    }
    const safeLimit = clampLimit(limit);
    const start = Math.max(0, thread.messages.length - safeLimit);
    return thread.messages.slice(start);
  }

  async findThreadIdBySessionId(sessionId: unknown): Promise<string | null> {
    await this.ensureInit();
    const wantedSessionId = String(sessionId ?? "").trim();
    if (!wantedSessionId) {
      return null;
    }

    for (const [threadId, thread] of Object.entries(this.state!.threads ?? {})) {
      if (String(thread?.sessionId ?? "").trim() === wantedSessionId) {
        return threadId;
      }
    }

    return null;
  }

  async getThreadIdForChannelUser(channelUserKey: unknown): Promise<string | null> {
    await this.ensureInit();
    return this.state!.bindings.channelUsers[String(channelUserKey)] ?? null;
  }

  async getOrCreateThreadIdForChannelUser(channelUserKey: unknown): Promise<string> {
    await this.ensureInit();
    const bindingKey = String(channelUserKey);
    const existing = this.state!.bindings.channelUsers[bindingKey];
    if (existing) {
      return existing;
    }

    const threadId = allocateUniqueThreadId(this.state!.threads, bindingKey);
    this.state!.bindings.channelUsers[bindingKey] = threadId;
    if (!this.state!.threads[threadId]) {
      this.state!.threads[threadId] = createDefaultThread(new Date().toISOString());
    }
    await this.flush();
    return threadId;
  }

  private async ensureInit(): Promise<void> {
    if (!this.state) {
      await this.init();
    }
  }

  private async readOrInit(): Promise<StateShape> {
    try {
      const raw = await fs.readFile(this.filePath, "utf8");
      try {
        const parsed = JSON.parse(raw);
        return normalizeStateShape(parsed);
      } catch (error) {
        if (!isJsonSyntaxError(error)) {
          throw error;
        }

        await this.recoverCorruptState(raw, error);
        return { ...EMPTY_STATE };
      }
    } catch (error) {
      if (getErrorCode(error) === "ENOENT") {
        await this.writeState({ ...EMPTY_STATE });
        return { ...EMPTY_STATE };
      }
      throw error;
    }
  }

  private async flush(): Promise<void> {
    await this.writeState(this.state!);
  }

  private async writeState(state: StateShape): Promise<void> {
    const tmpPath = `${this.filePath}.tmp`;
    const payload = `${JSON.stringify(state, null, 2)}\n`;
    await fs.writeFile(tmpPath, payload, "utf8");
    await fs.rename(tmpPath, this.filePath);
  }

  private async recoverCorruptState(raw: string, error: unknown): Promise<void> {
    const backupPath = `${this.filePath}.corrupt-${Date.now()}`;
    await fs.writeFile(backupPath, raw, "utf8").catch(() => {
      // Best effort backup only.
    });
    await this.writeState({ ...EMPTY_STATE });
    console.warn(
      `[state-store] Recovered corrupt state at ${this.filePath}. Backup: ${backupPath}. Error: ${getErrorMessage(error)}`,
    );
  }
}

function normalizeStateShape(parsed: unknown): StateShape {
  if (isVersion3State(parsed)) {
    return {
      version: STATE_VERSION,
      fingerprint: normalizeFingerprint(parsed.fingerprint),
      threads: normalizeThreads(parsed.threads),
      bindings: {
        channelUsers: normalizeStringMap(parsed.bindings?.channelUsers),
      },
    };
  }

  return { ...EMPTY_STATE };
}

function isVersion3State(value: unknown): value is {
  version: number;
  fingerprint?: unknown;
  threads: unknown;
  bindings?: { channelUsers?: unknown };
} {
  if (!value || typeof value !== "object") {
    return false;
  }
  const obj = value as { version?: unknown; threads?: unknown };
  return (
    Number(obj.version) === STATE_VERSION && Boolean(obj.threads) && typeof obj.threads === "object"
  );
}

function normalizeThreads(threads: unknown): Record<string, ThreadState> {
  const out: Record<string, ThreadState> = {};
  const entries = threads && typeof threads === "object" ? Object.entries(threads) : [];
  for (const [threadId, rawValue] of entries) {
    const value = rawValue as {
      sessionId?: unknown;
      turnCount?: unknown;
      lastMode?: unknown;
      createdAt?: unknown;
      updatedAt?: unknown;
      messages?: unknown;
    };
    const createdAt = String(value?.createdAt ?? new Date().toISOString());
    out[threadId] = {
      sessionId: value?.sessionId ? String(value.sessionId) : null,
      turnCount: safeNumber(value?.turnCount),
      lastMode: value?.lastMode ? String(value.lastMode) : null,
      createdAt,
      updatedAt: value?.updatedAt ? String(value.updatedAt) : createdAt,
      messages: ensureMessages(value?.messages ?? []),
    };
  }
  return out;
}

function normalizeFingerprint(value: unknown): string | null {
  const fingerprint = String(value ?? "").trim();
  return fingerprint || null;
}

function normalizeStringMap(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object") {
    return {};
  }
  const out: Record<string, string> = {};
  for (const [key, mapValue] of Object.entries(value)) {
    if (typeof mapValue === "string" && mapValue.trim()) {
      out[key] = mapValue;
    }
  }
  return out;
}

function createDefaultThread(nowIso: string): ThreadState {
  return {
    sessionId: null,
    turnCount: 0,
    lastMode: null,
    createdAt: nowIso,
    updatedAt: nowIso,
    messages: [],
  };
}

function cloneThread(value: ThreadState): ThreadState {
  return {
    ...value,
    messages: [...(value.messages ?? [])],
  };
}

function ensureMessages(value: unknown): StateMessage[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.map((entry) => sanitizeMessage(entry)).filter((entry) => entry.text.length > 0);
}

function sanitizeMessage(input: unknown): StateMessage {
  const raw = input as {
    role?: unknown;
    source?: unknown;
    text?: unknown;
    createdAt?: unknown;
    id?: unknown;
  };
  const role = normalizeRole(raw?.role);
  const source = normalizeSource(raw?.source);
  const text = String(raw?.text ?? "").trim();
  const createdAt = String(raw?.createdAt ?? new Date().toISOString());
  const id = raw?.id ? String(raw.id) : createMessageId();
  return {
    id,
    role,
    source,
    text,
    createdAt,
  };
}

function normalizeRole(value: unknown): MessageRole {
  const role = String(value ?? "").toLowerCase();
  if (role === "assistant" || role === "system") {
    return role;
  }
  return "user";
}

function normalizeSource(value: unknown): MessageSource {
  const source = String(value ?? "").toLowerCase();
  if (source === "telegram" || source === "web" || source === "internal") {
    return source;
  }
  return "internal";
}

function trimMessages(messages: StateMessage[], maxMessages: unknown): StateMessage[] {
  const safeMax = clampLimit(maxMessages);
  if (messages.length <= safeMax) {
    return messages;
  }
  return messages.slice(messages.length - safeMax);
}

function clampLimit(value: unknown): number {
  const parsed = Number.parseInt(String(value), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return DEFAULT_MAX_MESSAGES;
  }
  return Math.min(parsed, 1000);
}

function safeNumber(value: unknown): number {
  const parsed = Number.parseInt(String(value ?? 0), 10);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return 0;
  }
  return parsed;
}

function createMessageId(): string {
  return `msg_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function allocateUniqueThreadId(
  existingThreads: Record<string, ThreadState>,
  bindingKey: string,
): string {
  const base = `ch:${hashBindingKey(bindingKey).slice(0, 16)}`;
  if (!existingThreads[base]) {
    return base;
  }

  let index = 1;
  while (index < 1000) {
    const candidate = `${base}:${index}`;
    if (!existingThreads[candidate]) {
      return candidate;
    }
    index += 1;
  }

  return `ch:${Date.now().toString(36)}`;
}

function hashBindingKey(value: unknown): string {
  return crypto.createHash("sha1").update(String(value)).digest("hex");
}

function getErrorCode(error: unknown): string {
  if (!error || typeof error !== "object") {
    return "";
  }
  return String((error as { code?: unknown }).code ?? "")
    .trim()
    .toUpperCase();
}

function isJsonSyntaxError(error: unknown): boolean {
  return error instanceof SyntaxError;
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message) {
    return error.message;
  }
  return String(error ?? "Unknown error.");
}
