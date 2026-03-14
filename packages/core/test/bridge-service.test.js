import assert from "node:assert/strict";
import test from "node:test";
import { ConversationEngine } from "../dist/bridge-service.js";

function createMemoryStore() {
  const threads = new Map();

  const ensureThreadRecord = (threadId) => {
    const existing = threads.get(threadId);
    if (existing) {
      return existing;
    }
    const created = {
      sessionId: null,
      turnCount: 0,
      lastMode: null,
      messages: [],
    };
    threads.set(threadId, created);
    return created;
  };

  return {
    async getThread(threadId) {
      return threads.get(threadId) ?? null;
    },
    async ensureThread(threadId) {
      return ensureThreadRecord(threadId);
    },
    async appendMessage(threadId, message, maxMessages) {
      const current = ensureThreadRecord(threadId);
      const messages = Array.isArray(current.messages) ? [...current.messages, message] : [message];
      current.messages = messages.slice(-maxMessages);
      threads.set(threadId, current);
      return current;
    },
    async upsertThread(threadId, updater) {
      const current = ensureThreadRecord(threadId);
      const next = updater({
        ...current,
        messages: Array.isArray(current.messages) ? [...current.messages] : [],
      });
      threads.set(threadId, next);
      return next;
    },
    async listMessages(threadId, limit) {
      const current = ensureThreadRecord(threadId);
      const messages = Array.isArray(current.messages) ? current.messages : [];
      if (Number.isFinite(limit)) {
        return messages.slice(-Number(limit));
      }
      return messages;
    },
    async resetThread(threadId) {
      const next = {
        sessionId: null,
        turnCount: 0,
        lastMode: null,
        messages: [],
      };
      threads.set(threadId, next);
      return next;
    },
    async findThreadIdBySessionId(sessionId) {
      for (const [threadId, thread] of threads.entries()) {
        if (String(thread?.sessionId ?? "") === String(sessionId ?? "")) {
          return threadId;
        }
      }
      return null;
    },
  };
}

test("ConversationEngine preserves disabled turn activity timeout", async () => {
  const providerCalls = [];
  const provider = {
    kind: "codex",
    on() {},
    setWorkspaceRoot() {},
    async sendTurn(payload) {
      providerCalls.push(payload);
      return {
        sessionId: "thread-session-1",
        assistantText: "ok",
      };
    },
    async resolveApproval() {
      return { decision: "accept" };
    },
    async shutdown() {},
  };

  const engine = new ConversationEngine({
    store: createMemoryStore(),
    assistantProvider: provider,
    projectRoot: process.cwd(),
    turnActivityTimeoutMs: 0,
  });

  assert.equal(engine.turnActivityTimeoutMs, 0);

  const result = await engine.sendTurn({
    threadId: "thread:bridge-test",
    prompt: "hello",
  });

  assert.equal(result.assistantText, "ok");
  assert.equal(providerCalls.length, 1);
  assert.equal(providerCalls[0].turnActivityTimeoutMs, 0);
});
