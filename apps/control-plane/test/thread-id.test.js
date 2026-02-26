import assert from "node:assert/strict";
import test from "node:test";
import { normalizeThreadId } from "../src/thread-id.js";

test("normalizeThreadId trims and accepts valid thread ids", () => {
  assert.equal(normalizeThreadId("  shared-copilot-hub  "), "shared-copilot-hub");
  assert.equal(normalizeThreadId("chat:123_ABC-1"), "chat:123_ABC-1");
});

test("normalizeThreadId rejects empty and invalid values", () => {
  assert.throws(() => normalizeThreadId(""), /threadId is required/);
  assert.throws(() => normalizeThreadId("thread id with spaces"), /Invalid threadId/);
  assert.throws(() => normalizeThreadId("chat/123"), /Invalid threadId/);
});
