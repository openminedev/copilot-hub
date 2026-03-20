import assert from "node:assert/strict";
import test from "node:test";
import { TelegramChannel } from "../dist/telegram-channel.js";

test("TelegramChannel restarts polling after a transient start failure", async () => {
  const runtime = {
    runtimeId: "bot_runtime",
    runtimeName: "Bot Runtime",
    resolveThreadIdForChannel: async () => "thread_1",
    resetThread: async () => ({ thread: {} }),
    getThread: async () => ({ thread: {} }),
    buildWebBotUrl: () => "http://127.0.0.1:8787/?bot=bot_runtime",
    listPendingApprovals: async () => [],
    resolvePendingApproval: async () => null,
    interruptThread: async () => ({ interrupted: false, reason: "no_active_turn" }),
    sendTurn: async () => ({ assistantText: "ok" }),
    getProviderUsage: async () => null,
  };

  const control = {
    startCount: 0,
    resolveCurrentStart: null,
  };

  class FakeBot {
    constructor(token) {
      this.token = token;
      this.api = {};
    }

    command() {
      return this;
    }

    on() {
      return this;
    }

    catch() {
      return this;
    }

    start({ onStart } = {}) {
      control.startCount += 1;
      if (control.startCount === 1) {
        return Promise.reject(new Error("network down"));
      }

      onStart?.();
      return new Promise((resolve) => {
        control.resolveCurrentStart = resolve;
      });
    }

    stop() {
      const resolve = control.resolveCurrentStart;
      control.resolveCurrentStart = null;
      resolve?.();
    }
  }

  const originalConsole = {
    log: console.log,
    warn: console.warn,
    error: console.error,
  };
  console.log = () => {};
  console.warn = () => {};
  console.error = () => {};

  const channel = new TelegramChannel({
    channelConfig: {
      id: "telegram_main",
      token: "123456:telegram-token",
    },
    runtime,
    internals: {
      createBot: (token) => new FakeBot(token),
      pollingRetryBaseMs: 5,
      pollingRetryMaxMs: 5,
    },
  });

  try {
    await channel.start();
    await delay(40);

    const status = channel.getStatus();
    assert.equal(control.startCount, 2);
    assert.equal(status.running, true);
    assert.equal(status.error, null);
  } finally {
    await channel.stop();
    console.log = originalConsole.log;
    console.warn = originalConsole.warn;
    console.error = originalConsole.error;
  }
});

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
