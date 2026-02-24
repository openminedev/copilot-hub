import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

const STATE_VERSION = 3;
const DEFAULT_MAX_MESSAGES = 200;

const EMPTY_STATE = {
  version: STATE_VERSION,
  fingerprint: null,
  threads: {},
  bindings: {
    channelUsers: {}
  }
};

export class JsonStateStore {
  constructor(filePath) {
    this.filePath = filePath;
    this.state = null;
  }

  async init() {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    this.state = await this.#readOrInit();
  }

  async ensureFingerprint(expectedFingerprint) {
    await this.#ensureInit();
    const expected = String(expectedFingerprint ?? "").trim();
    if (!expected) {
      return { changed: false, reset: false };
    }

    const current = String(this.state.fingerprint ?? "").trim();
    if (current && current !== expected) {
      this.state = {
        ...EMPTY_STATE,
        fingerprint: expected
      };
      await this.#flush();
      return {
        changed: true,
        reset: true,
        previousFingerprint: current
      };
    }

    if (current !== expected) {
      this.state.fingerprint = expected;
      await this.#flush();
      return {
        changed: true,
        reset: false
      };
    }

    return { changed: false, reset: false };
  }

  async ensureThread(threadId) {
    await this.#ensureInit();
    const key = String(threadId);
    if (!this.state.threads[key]) {
      const now = new Date().toISOString();
      this.state.threads[key] = createDefaultThread(now);
      await this.#flush();
    }
    return this.state.threads[key];
  }

  async getThread(threadId) {
    await this.#ensureInit();
    return this.state.threads[String(threadId)] ?? null;
  }

  async upsertThread(threadId, updater) {
    await this.#ensureInit();
    const key = String(threadId);
    const now = new Date().toISOString();
    const current = this.state.threads[key] ?? createDefaultThread(now);
    const next = updater(cloneThread(current));
    this.state.threads[key] = {
      ...createDefaultThread(current.createdAt),
      ...next,
      createdAt: current.createdAt,
      updatedAt: now,
      messages: ensureMessages(next?.messages ?? current.messages ?? [])
    };
    await this.#flush();
    return this.state.threads[key];
  }

  async appendMessage(threadId, message, maxMessages = DEFAULT_MAX_MESSAGES) {
    return this.upsertThread(threadId, (thread) => ({
      ...thread,
      messages: trimMessages([...(thread.messages ?? []), sanitizeMessage(message)], maxMessages)
    }));
  }

  async resetThread(threadId) {
    return this.upsertThread(threadId, (thread) => ({
      ...thread,
      sessionId: null,
      turnCount: 0,
      lastMode: null,
      messages: []
    }));
  }

  async listMessages(threadId, limit = DEFAULT_MAX_MESSAGES) {
    await this.#ensureInit();
    const thread = this.state.threads[String(threadId)];
    if (!thread) {
      return [];
    }
    const safeLimit = clampLimit(limit);
    const start = Math.max(0, thread.messages.length - safeLimit);
    return thread.messages.slice(start);
  }

  async findThreadIdBySessionId(sessionId) {
    await this.#ensureInit();
    const wantedSessionId = String(sessionId ?? "").trim();
    if (!wantedSessionId) {
      return null;
    }

    for (const [threadId, thread] of Object.entries(this.state.threads ?? {})) {
      if (String(thread?.sessionId ?? "").trim() === wantedSessionId) {
        return threadId;
      }
    }

    return null;
  }

  async getThreadIdForChannelUser(channelUserKey) {
    await this.#ensureInit();
    return this.state.bindings.channelUsers[String(channelUserKey)] ?? null;
  }

  async getOrCreateThreadIdForChannelUser(channelUserKey) {
    await this.#ensureInit();
    const bindingKey = String(channelUserKey);
    const existing = this.state.bindings.channelUsers[bindingKey];
    if (existing) {
      return existing;
    }

    const threadId = allocateUniqueThreadId(this.state.threads, bindingKey);
    this.state.bindings.channelUsers[bindingKey] = threadId;
    if (!this.state.threads[threadId]) {
      this.state.threads[threadId] = createDefaultThread(new Date().toISOString());
    }
    await this.#flush();
    return threadId;
  }

  async #ensureInit() {
    if (!this.state) {
      await this.init();
    }
  }

  async #readOrInit() {
    try {
      const raw = await fs.readFile(this.filePath, "utf8");
      const parsed = JSON.parse(raw);
      return normalizeStateShape(parsed);
    } catch (error) {
      if (error && error.code === "ENOENT") {
        await this.#writeState({ ...EMPTY_STATE });
        return { ...EMPTY_STATE };
      }
      throw error;
    }
  }

  async #flush() {
    await this.#writeState(this.state);
  }

  async #writeState(state) {
    const tmpPath = `${this.filePath}.tmp`;
    const payload = `${JSON.stringify(state, null, 2)}\n`;
    await fs.writeFile(tmpPath, payload, "utf8");
    await fs.rename(tmpPath, this.filePath);
  }
}

function normalizeStateShape(parsed) {
  if (isVersion3State(parsed)) {
    return {
      version: STATE_VERSION,
      fingerprint: normalizeFingerprint(parsed.fingerprint),
      threads: normalizeThreads(parsed.threads),
      bindings: {
        channelUsers: normalizeStringMap(parsed.bindings?.channelUsers)
      }
    };
  }

  return { ...EMPTY_STATE };
}

function isVersion3State(value) {
  return value && typeof value === "object" && Number(value.version) === STATE_VERSION && value.threads && typeof value.threads === "object";
}

function normalizeThreads(threads) {
  const out = {};
  for (const [threadId, value] of Object.entries(threads ?? {})) {
    const createdAt = value?.createdAt ?? new Date().toISOString();
    out[threadId] = {
      sessionId: value?.sessionId ?? null,
      turnCount: safeNumber(value?.turnCount),
      lastMode: value?.lastMode ?? null,
      createdAt,
      updatedAt: value?.updatedAt ?? createdAt,
      messages: ensureMessages(value?.messages ?? [])
    };
  }
  return out;
}

function normalizeFingerprint(value) {
  const fingerprint = String(value ?? "").trim();
  return fingerprint || null;
}

function normalizeStringMap(value) {
  if (!value || typeof value !== "object") {
    return {};
  }
  const out = {};
  for (const [key, mapValue] of Object.entries(value)) {
    if (typeof mapValue === "string" && mapValue.trim()) {
      out[key] = mapValue;
    }
  }
  return out;
}

function createDefaultThread(nowIso) {
  return {
    sessionId: null,
    turnCount: 0,
    lastMode: null,
    createdAt: nowIso,
    updatedAt: nowIso,
    messages: []
  };
}

function cloneThread(value) {
  return {
    ...value,
    messages: [...(value.messages ?? [])]
  };
}

function ensureMessages(value) {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .map((entry) => sanitizeMessage(entry))
    .filter((entry) => entry.text.length > 0);
}

function sanitizeMessage(input) {
  const role = normalizeRole(input?.role);
  const source = normalizeSource(input?.source);
  const text = String(input?.text ?? "").trim();
  const createdAt = input?.createdAt ?? new Date().toISOString();
  const id = input?.id ?? createMessageId();
  return {
    id,
    role,
    source,
    text,
    createdAt
  };
}

function normalizeRole(value) {
  const role = String(value ?? "").toLowerCase();
  if (role === "assistant" || role === "system") {
    return role;
  }
  return "user";
}

function normalizeSource(value) {
  const source = String(value ?? "").toLowerCase();
  if (source === "telegram" || source === "web" || source === "internal") {
    return source;
  }
  return "internal";
}

function trimMessages(messages, maxMessages) {
  const safeMax = clampLimit(maxMessages);
  if (messages.length <= safeMax) {
    return messages;
  }
  return messages.slice(messages.length - safeMax);
}

function clampLimit(value) {
  const parsed = Number.parseInt(String(value), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return DEFAULT_MAX_MESSAGES;
  }
  return Math.min(parsed, 1000);
}

function safeNumber(value) {
  const parsed = Number.parseInt(String(value ?? 0), 10);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return 0;
  }
  return parsed;
}

function createMessageId() {
  return `msg_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function allocateUniqueThreadId(existingThreads, bindingKey) {
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

function hashBindingKey(value) {
  return crypto.createHash("sha1").update(String(value)).digest("hex");
}
