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
    getProviderUsage: async () => ({
      model: "gpt-5.4",
      primary: { remainingPercent: 50, resetsAt: 1_777_777_777 },
    }),
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

test("TelegramChannel keeps polling alive when detached turn reporting hits a network send failure", async () => {
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
    sendTurn: async () => {
      throw new Error("provider down");
    },
    getProviderUsage: async () => ({
      model: "gpt-5.4",
      primary: { remainingPercent: 50, resetsAt: 1_777_777_777 },
    }),
  };

  const control = {
    resolveCurrentStart: null,
    currentBot: null,
    sendMessageCount: 0,
  };

  class FakeBot {
    constructor(token) {
      this.token = token;
      this.handlers = new Map();
      this.api = {
        sendMessage: async () => {
          control.sendMessageCount += 1;
          throw new Error("Network request for 'sendMessage' failed!");
        },
        sendChatAction: async () => {},
        editMessageText: async () => {},
        editMessageReplyMarkup: async () => {},
      };
      control.currentBot = this;
    }

    command() {
      return this;
    }

    on(event, handler) {
      this.handlers.set(event, handler);
      return this;
    }

    catch() {
      return this;
    }

    start({ onStart } = {}) {
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

    async emitText(text) {
      const handler = this.handlers.get("message:text");
      await handler?.({
        message: { text },
        chat: { id: 123456 },
      });
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
    await delay(10);

    await control.currentBot.emitText("hello");
    await delay(60);

    const status = channel.getStatus();
    assert.ok(control.sendMessageCount >= 2);
    assert.equal(status.running, true);
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
