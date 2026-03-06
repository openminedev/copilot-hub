import assert from "node:assert/strict";
import test from "node:test";
import {
  extractQuotaSnapshot,
  extractSessionConfiguredModel,
  extractThreadLifecycleModel,
} from "../dist/codex-app-events.js";

test("extractQuotaSnapshot parses token_count payload", () => {
  const snapshot = extractQuotaSnapshot({
    type: "event_msg",
    payload: {
      type: "token_count",
      rate_limits: {
        primary: { used_percent: 20, resets_at: 1_900_000_000, window_minutes: 300 },
        secondary: { used_percent: 40, resets_at: 1_900_100_000, window_minutes: 10_080 },
      },
      info: {
        model_context_window: 200_000,
        total_token_usage: {
          input_tokens: 11,
          output_tokens: 22,
          total_tokens: 33,
        },
      },
    },
  });

  assert.ok(snapshot);
  assert.equal(snapshot.primary.remainingPercent, 80);
  assert.equal(snapshot.secondary.remainingPercent, 60);
  assert.equal(snapshot.usage?.totalTokens, 33);
});

test("extractThreadLifecycleModel reads model from common lifecycle envelopes", () => {
  assert.equal(extractThreadLifecycleModel({ result: { model: "gpt-5" } }), "gpt-5");
  assert.equal(extractThreadLifecycleModel({ params: { model: "gpt-4.1" } }), "gpt-4.1");
  assert.equal(
    extractThreadLifecycleModel({ result: { thread: { model: "gpt-5.3-codex" } } }),
    "gpt-5.3-codex",
  );
});

test("extractSessionConfiguredModel reads configured session model", () => {
  assert.equal(
    extractSessionConfiguredModel({
      method: "event_msg",
      params: {
        payload: {
          type: "session_configured",
          model: "gpt-5",
        },
      },
    }),
    "gpt-5",
  );
});
