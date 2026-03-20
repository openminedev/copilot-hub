import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Bot, type Api, type Context } from "grammy";
import { resolvePathFromBase, resolveProcessConfigBaseDir } from "@copilot-hub/core/config-paths";
import { formatCodexQuotaLine } from "@copilot-hub/core/codex-quota-display";
import {
  maybeHandleHubOpsCallback,
  maybeHandleHubOpsCommand,
  maybeHandleHubOpsFollowUp,
} from "./hub-ops-commands.js";
import {
  readCachedCodexQuotaSnapshot,
  writeCachedCodexQuotaSnapshot,
} from "./codex-quota-cache.js";

type TelegramChannelConfig = {
  kind?: unknown;
  id?: string;
  token?: string;
  allowedChatIds?: string | Array<string | number>;
};

type ThreadState = {
  turnCount?: number;
  sessionId?: string;
  updatedAt?: string;
};

type PendingApproval = {
  id: string;
  kind: string;
  command?: string;
  cwd?: string;
  reason?: string;
  threadId?: string;
  metadata?: {
    chatId?: string;
  };
};

type ApprovalDecision = "accept" | "acceptForSession" | "decline";

type InterruptResult = {
  interrupted?: boolean;
  method?: string;
  reason?: string;
  error?: string;
};

type ActiveTurn = {
  threadId: string;
  token: string;
};

type TurnControlState = {
  token: string;
  threadId: string;
  messageId: number;
};

type RuntimeLike = {
  runtimeId?: string;
  runtimeName?: string;
  resolveThreadIdForChannel: (args: {
    channelKind: string;
    channelId: string;
    externalUserId: string;
  }) => Promise<string>;
  resetThread: (threadId: string) => Promise<unknown>;
  getThread: (threadId: string) => Promise<{ thread: ThreadState }>;
  buildWebBotUrl: () => string;
  listPendingApprovals: (threadId: string) => Promise<PendingApproval[]>;
  resolvePendingApproval: (args: {
    threadId: string;
    approvalId: string;
    decision: ApprovalDecision;
  }) => Promise<unknown>;
  interruptThread: (threadId: string) => Promise<InterruptResult | null>;
  sendTurn: (args: {
    threadId: string;
    prompt: string;
    source?: string;
    metadata?: Record<string, unknown>;
  }) => Promise<{ assistantText?: string }>;
  getProviderUsage?: () => Promise<unknown>;
};

type CodexUsageSnapshot = {
  primary?: { remainingPercent?: number | null; resetsAt?: number | null } | null;
  secondary?: { remainingPercent?: number | null; resetsAt?: number | null } | null;
} | null;

const CODEX_USAGE_CACHE_TTL_MS = 60_000;
const TELEGRAM_POLLING_RETRY_BASE_MS = 1_000;
const TELEGRAM_POLLING_RETRY_MAX_MS = 30_000;

type TelegramBotFactory = (token: string) => Bot<Context>;

export class TelegramChannel {
  kind: "telegram";
  id: string;
  config: TelegramChannelConfig;
  runtime: RuntimeLike;
  allowedChatIds: Set<string>;
  bot: Bot | null;
  running: boolean;
  error: string | null;
  activeTurnsByChat: Map<string, ActiveTurn>;
  turnControlByChat: Map<string, TurnControlState>;
  nextTurnToken: number;
  botFactory: TelegramBotFactory;
  pollingLoopPromise: Promise<void> | null;
  stopRequested: boolean;
  pollingRetryBaseMs: number;
  pollingRetryMaxMs: number;

  constructor({
    channelConfig,
    runtime,
    internals = {},
  }: {
    channelConfig: TelegramChannelConfig;
    runtime: unknown;
    internals?: {
      createBot?: TelegramBotFactory;
      pollingRetryBaseMs?: number;
      pollingRetryMaxMs?: number;
    };
  }) {
    this.kind = "telegram";
    this.id = String(channelConfig.id ?? "telegram");
    this.config = channelConfig;
    this.runtime = toRuntimeLike(runtime);
    this.allowedChatIds = normalizeAllowedChatIds(channelConfig.allowedChatIds);
    this.bot = null;
    this.running = false;
    this.error = null;
    this.activeTurnsByChat = new Map();
    this.turnControlByChat = new Map();
    this.nextTurnToken = 1;
    this.botFactory =
      typeof internals.createBot === "function" ? internals.createBot : (token) => new Bot(token);
    this.pollingLoopPromise = null;
    this.stopRequested = false;
    this.pollingRetryBaseMs = normalizeRetryDelay(
      internals.pollingRetryBaseMs,
      TELEGRAM_POLLING_RETRY_BASE_MS,
    );
    this.pollingRetryMaxMs = Math.max(
      this.pollingRetryBaseMs,
      normalizeRetryDelay(internals.pollingRetryMaxMs, TELEGRAM_POLLING_RETRY_MAX_MS),
    );
  }

  async start(): Promise<{ kind: string; id: string; running: boolean; error: string | null }> {
    if (this.running || this.pollingLoopPromise) {
      return this.getStatus();
    }

    const token = String(this.config.token ?? "").trim();
    if (!token) {
      throw new Error(`Telegram token is missing for channel '${this.id}'.`);
    }

    this.stopRequested = false;
    this.error = null;
    this.#ensurePollingLoop();

    return this.getStatus();
  }

  async stop(): Promise<{ kind: string; id: string; running: boolean; error: string | null }> {
    this.stopRequested = true;
    if (this.bot) {
      try {
        this.bot.stop();
      } catch {
        // Ignore stop errors.
      }
    }
    if (this.pollingLoopPromise) {
      await this.pollingLoopPromise.catch(() => {
        // Best effort shutdown only.
      });
    }
    this.bot = null;
    this.running = false;
    this.activeTurnsByChat.clear();
    this.turnControlByChat.clear();
    return this.getStatus();
  }

  async shutdown(): Promise<void> {
    await this.stop();
  }

  getStatus(): { kind: string; id: string; running: boolean; error: string | null } {
    return {
      kind: this.kind,
      id: this.id,
      running: this.running,
      error: this.error,
    };
  }

  async notifyApproval(approval: PendingApproval): Promise<void> {
    const chatId = String(approval?.metadata?.chatId ?? "").trim();
    if (!chatId || !this.bot) {
      return;
    }

    const lines = [
      `Approval required [${approval.id}]`,
      `type: ${approval.kind}`,
      `thread: ${approval.threadId}`,
    ];
    if (approval.command) {
      lines.push(`command: ${approval.command}`);
    }
    if (approval.cwd) {
      lines.push(`cwd: ${approval.cwd}`);
    }
    if (approval.reason) {
      lines.push(`reason: ${approval.reason}`);
    }
    lines.push(`Use: /approve ${approval.id} or /deny ${approval.id}`);

    await sendChunkedMessage(this.bot.api, chatId, lines.join("\n"));
  }

  #ensurePollingLoop(): void {
    if (this.pollingLoopPromise) {
      return;
    }

    this.pollingLoopPromise = this.#runPollingLoop().finally(() => {
      this.pollingLoopPromise = null;
      this.running = false;
      this.bot = null;
    });
  }

  async #runPollingLoop(): Promise<void> {
    let attempt = 0;

    while (!this.stopRequested) {
      const token = String(this.config.token ?? "").trim();
      if (!token) {
        this.error = `Telegram token is missing for channel '${this.id}'.`;
        return;
      }

      const bot = this.botFactory(token);
      this.#attachHandlers(bot);
      this.bot = bot;
      this.running = true;
      this.error = null;

      try {
        await bot.start({
          onStart: () => {
            attempt = 0;
            this.error = null;
            console.log(`[${this.runtime.runtimeId}:${this.id}] Telegram polling started.`);
          },
        });

        if (this.stopRequested) {
          return;
        }

        this.error = "Telegram polling stopped unexpectedly.";
        console.error(
          `[${this.runtime.runtimeId}:${this.id}] Telegram polling stopped unexpectedly.`,
        );
      } catch (error) {
        if (this.stopRequested) {
          return;
        }

        this.error = sanitizeError(error);
        console.error(
          `[${this.runtime.runtimeId}:${this.id}] Telegram polling error: ${this.error}`,
        );
      } finally {
        if (this.bot === bot) {
          this.bot = null;
        }
        this.running = false;
      }

      if (this.stopRequested) {
        return;
      }

      const delayMs = computePollingRetryDelay(
        attempt,
        this.pollingRetryBaseMs,
        this.pollingRetryMaxMs,
      );
      attempt += 1;
      console.warn(
        `[${this.runtime.runtimeId}:${this.id}] Telegram polling retry in ${Math.ceil(delayMs / 1000)}s.`,
      );
      await waitForPollingRetry(delayMs, () => this.stopRequested);
    }
  }

  #attachHandlers(bot: Bot): void {
    bot.command("start", async (context) => {
      const chatId = String(context.chat.id);
      if (!this.#isAllowedChat(chatId)) {
        await context.reply("Chat not allowed for this bot.");
        return;
      }

      const threadId = await this.runtime.resolveThreadIdForChannel({
        channelKind: this.kind,
        channelId: this.id,
        externalUserId: chatId,
      });
      await context.reply(
        [
          `Agent '${this.runtime.runtimeName}' ready.`,
          "/help - hub commands",
          "/health - engine status",
          "/bots - list and manage agents",
          "/create_agent - create a Telegram agent",
          "/cancel - cancel current create flow",
          "/thread - show active thread",
          "/new - reset current thread",
          "/status - show session status",
          "/stop - stop current generation",
          "/steer <instruction> - interrupt current generation and apply steer immediately",
          "Send a message during generation to interrupt and replace immediately",
          "During generation button: Interrompre",
          "/approvals - list pending approvals",
          "/approve <id> - approve a pending action",
          "/approvealways <id> - approve and remember for session",
          "/approveall - approve all pending actions",
          "/approveallalways - approve all and remember for session",
          "/deny <id> - deny a pending action",
          "/denyall - deny all pending actions",
          "/whoami - show Telegram chat id",
          `Web: ${this.runtime.buildWebBotUrl()}`,
          `threadId: ${threadId}`,
        ]
          .filter(Boolean)
          .join("\n"),
      );
    });

    bot.command("thread", async (context) => {
      const chatId = String(context.chat.id);
      if (!this.#isAllowedChat(chatId)) {
        await context.reply("Chat not allowed for this bot.");
        return;
      }

      const threadId = await this.runtime.resolveThreadIdForChannel({
        channelKind: this.kind,
        channelId: this.id,
        externalUserId: chatId,
      });
      await context.reply(`threadId: ${threadId}`);
    });

    bot.command("new", async (context) => {
      const chatId = String(context.chat.id);
      if (!this.#isAllowedChat(chatId)) {
        await context.reply("Chat not allowed for this bot.");
        return;
      }

      const threadId = await this.runtime.resolveThreadIdForChannel({
        channelKind: this.kind,
        channelId: this.id,
        externalUserId: chatId,
      });
      await this.runtime.resetThread(threadId);
      await context.reply(`Thread '${threadId}' reset.`);
    });

    bot.command("status", async (context) => {
      const chatId = String(context.chat.id);
      if (!this.#isAllowedChat(chatId)) {
        await context.reply("Chat not allowed for this bot.");
        return;
      }

      const threadId = await this.runtime.resolveThreadIdForChannel({
        channelKind: this.kind,
        channelId: this.id,
        externalUserId: chatId,
      });
      const { thread } = await this.runtime.getThread(threadId);
      await context.reply(
        [
          `agent: ${this.runtime.runtimeName}`,
          `threadId: ${threadId}`,
          `turnCount: ${thread.turnCount ?? 0}`,
          `sessionId: ${thread.sessionId ?? "<none>"}`,
          `updatedAt: ${thread.updatedAt ?? "<unknown>"}`,
          `web: ${this.runtime.buildWebBotUrl()}`,
        ].join("\n"),
      );
    });

    bot.command("whoami", async (context) => {
      const chatId = String(context.chat.id);
      await context.reply(`chat_id: ${chatId}`);
    });

    bot.command("stop", async (context) => {
      await this.#handleStopTurn(context);
    });

    bot.command("steer", async (context) => {
      await this.#handleSteer(context);
    });

    bot.command("approvals", async (context) => {
      const chatId = String(context.chat.id);
      if (!this.#isAllowedChat(chatId)) {
        await context.reply("Chat not allowed for this bot.");
        return;
      }

      const threadId = await this.runtime.resolveThreadIdForChannel({
        channelKind: this.kind,
        channelId: this.id,
        externalUserId: chatId,
      });
      const approvals = await this.runtime.listPendingApprovals(threadId);
      if (approvals.length === 0) {
        await context.reply("No pending approvals.");
        return;
      }
      await context.reply(formatApprovalList(approvals));
    });

    bot.command("approve", async (context) => {
      await this.#handleSingleApproval(context, "accept");
    });

    bot.command("approvealways", async (context) => {
      await this.#handleSingleApproval(context, "acceptForSession");
    });

    bot.command("approveall", async (context) => {
      await this.#handleBulkApproval(context, "accept");
    });

    bot.command("approveallalways", async (context) => {
      await this.#handleBulkApproval(context, "acceptForSession");
    });

    bot.command("deny", async (context) => {
      await this.#handleSingleApproval(context, "decline");
    });

    bot.command("denyall", async (context) => {
      await this.#handleBulkApproval(context, "decline");
    });

    bot.on("callback_query:data", async (context) => {
      const chatId = String(context.callbackQuery.message?.chat?.id ?? "");
      if (!chatId || !this.#isAllowedChat(chatId)) {
        await context.answerCallbackQuery({
          text: "Chat not allowed for this bot.",
          show_alert: true,
        });
        return;
      }

      const hubHandled = await maybeHandleHubOpsCallback({
        ctx: context as unknown as Parameters<typeof maybeHandleHubOpsCallback>[0]["ctx"],
        runtime: this.runtime,
      });
      if (hubHandled) {
        return;
      }

      const payload = parseTurnControlCallbackData(context.callbackQuery.data);
      if (!payload) {
        return;
      }

      const active = this.#getActiveTurn(chatId);
      if (!active || active.token !== payload.token) {
        await context.answerCallbackQuery({
          text: "No active generation for this action.",
        });
        return;
      }

      if (payload.action === "stop") {
        const result = await this.runtime.interruptThread(active.threadId);
        if (result?.interrupted === true) {
          await this.#closeTurnControls(
            chatId,
            payload.token,
            "Generation interruption requested.",
          );
        }
        await context.answerCallbackQuery({
          text:
            result?.interrupted === true
              ? "Interruption requested."
              : "No active generation to stop.",
        });
        return;
      }
    });

    bot.on("message:text", async (context) => {
      const text = context.message.text;
      const chatId = String(context.chat.id);
      if (!this.#isAllowedChat(chatId)) {
        await context.reply("Chat not allowed for this bot.");
        return;
      }

      if (text.startsWith("/")) {
        const opsHandled = await maybeHandleHubOpsCommand({
          ctx: context as unknown as Parameters<typeof maybeHandleHubOpsCommand>[0]["ctx"],
          runtime: this.runtime,
          channelId: this.id,
        });
        if (opsHandled) {
          return;
        }
        await context.reply("Unknown command. Use /help.");
        return;
      }

      const opsFlowHandled = await maybeHandleHubOpsFollowUp({
        ctx: context as unknown as Parameters<typeof maybeHandleHubOpsFollowUp>[0]["ctx"],
        runtime: this.runtime,
        channelId: this.id,
      });
      if (opsFlowHandled) {
        return;
      }

      const threadId = await this.runtime.resolveThreadIdForChannel({
        channelKind: this.kind,
        channelId: this.id,
        externalUserId: chatId,
      });

      const activeTurn = this.#getActiveTurn(chatId);
      if (activeTurn && activeTurn.threadId === threadId) {
        await this.#applySteerInstruction({
          chatId,
          threadId,
          prompt: text,
          mode: "auto_message",
        });
        return;
      }

      void this.#processTurn({
        chatId,
        threadId,
        prompt: text,
      });
    });

    bot.catch((error) => {
      const details =
        error.error instanceof Error
          ? (error.error.stack ?? error.error.message)
          : String(error.error);
      this.error = details;
      console.error(
        `[${this.runtime.runtimeId}:${this.id}] Telegram error in update ${error.ctx.update.update_id}: ${details}`,
      );
    });
  }

  async #processTurn({
    chatId,
    threadId,
    prompt,
  }: {
    chatId: string;
    threadId: string;
    prompt: string;
  }): Promise<void> {
    if (!this.bot) {
      return;
    }

    const turnToken = this.#markActiveTurn(chatId, threadId);
    await this.#openTurnControls(chatId, threadId, turnToken);
    let controlStatus = "Generation completed.";

    try {
      await this.bot.api.sendChatAction(chatId, "typing");
      const result = await this.runtime.sendTurn({
        threadId,
        prompt,
        source: "telegram",
        metadata: {
          chatId,
          channelId: this.id,
        },
      });
      await sendChunkedMessage(
        this.bot.api,
        chatId,
        result.assistantText || "Assistant returned no text output.",
      );
    } catch (error) {
      const safe = sanitizeError(error);
      if (isTurnInterruptedError(safe)) {
        controlStatus = "Generation interrupted.";
        await this.bot.api.sendMessage(chatId, "Generation stopped.");
        return;
      }
      controlStatus = "Generation failed.";
      const failureMessage = await buildTurnFailureMessage({
        runtime: this.runtime,
        safeError: safe,
      });
      await this.bot.api.sendMessage(chatId, failureMessage);
    } finally {
      this.#clearActiveTurn(chatId, turnToken);
      await this.#closeTurnControls(chatId, turnToken, controlStatus);
    }
  }

  async #handleStopTurn(context: Context): Promise<void> {
    const chatId = getContextChatId(context);
    if (!chatId) {
      await context.reply("Unable to resolve chat.");
      return;
    }
    if (!this.#isAllowedChat(chatId)) {
      await context.reply("Chat not allowed for this bot.");
      return;
    }

    const threadId = await this.runtime.resolveThreadIdForChannel({
      channelKind: this.kind,
      channelId: this.id,
      externalUserId: chatId,
    });
    const result = await this.runtime.interruptThread(threadId);
    await context.reply(formatInterruptResult(result));
  }

  async #handleSteer(context: Context): Promise<void> {
    const chatId = getContextChatId(context);
    if (!chatId) {
      await context.reply("Unable to resolve chat.");
      return;
    }
    if (!this.#isAllowedChat(chatId)) {
      await context.reply("Chat not allowed for this bot.");
      return;
    }

    const instruction = extractCommandTail(getContextMessageText(context));
    const threadId = await this.runtime.resolveThreadIdForChannel({
      channelKind: this.kind,
      channelId: this.id,
      externalUserId: chatId,
    });

    if (!instruction) {
      await context.reply("Usage: /steer <instruction>");
      return;
    }

    const prompt = buildSteerPrompt(instruction);
    await this.#applySteerInstruction({
      chatId,
      threadId,
      prompt,
      mode: "command_steer",
    });
  }

  #markActiveTurn(chatId: string, threadId: string): string {
    const token = `turn_${Date.now()}_${this.nextTurnToken++}`;
    this.activeTurnsByChat.set(String(chatId), {
      threadId: String(threadId),
      token,
    });
    return token;
  }

  #clearActiveTurn(chatId: string, token: string): void {
    const key = String(chatId);
    const current = this.activeTurnsByChat.get(key);
    if (!current) {
      return;
    }
    if (String(current.token) !== String(token)) {
      return;
    }
    this.activeTurnsByChat.delete(key);
  }

  #getActiveTurn(chatId: string): ActiveTurn | null {
    return this.activeTurnsByChat.get(String(chatId)) ?? null;
  }

  async #applySteerInstruction({
    chatId,
    threadId,
    prompt,
    mode = "command_steer",
  }: {
    chatId: string;
    threadId: string;
    prompt: string;
    mode?: "auto_message" | "command_steer";
  }): Promise<void> {
    const nextPrompt = String(prompt ?? "").trim();
    if (!nextPrompt) {
      if (this.bot) {
        await this.bot.api.sendMessage(chatId, "Message is empty.");
      }
      return;
    }

    const activeTurn = this.#getActiveTurn(chatId);
    if (activeTurn && activeTurn.threadId === threadId) {
      const interruption = await this.runtime.interruptThread(threadId);
      const reason = String(interruption?.reason ?? "")
        .trim()
        .toLowerCase();
      if (
        !(
          interruption?.interrupted === true ||
          reason === "no_active_turn" ||
          reason === "no_active_session"
        )
      ) {
        if (this.bot) {
          await this.bot.api.sendMessage(
            chatId,
            `Unable to apply steer now.\n${formatInterruptResult(interruption)}`,
          );
        }
        return;
      }
      if (this.bot) {
        if (mode === "auto_message") {
          await this.bot.api.sendMessage(
            chatId,
            "New message received. Generation interrupted, applying it now.",
          );
        } else {
          await this.bot.api.sendMessage(
            chatId,
            "Steer accepted. Generation interrupted, applying instruction now.",
          );
        }
      }
    } else if (this.bot) {
      if (mode === "auto_message") {
        await this.bot.api.sendMessage(chatId, "Applying your message now.");
      } else {
        await this.bot.api.sendMessage(chatId, "No active generation. Applying steer now.");
      }
    }

    void this.#processTurn({
      chatId,
      threadId,
      prompt: nextPrompt,
    });
  }

  async #openTurnControls(chatId: string, threadId: string, token: string): Promise<void> {
    if (!this.bot) {
      return;
    }

    const key = String(chatId);
    await this.#closeTurnControls(chatId, null, null);
    try {
      const quota = await resolveCodexQuotaLine(this.runtime);
      const inProgressText = quota.line
        ? ["Generation in progress.", quota.line].join("\n")
        : "Generation in progress.";
      const sent = await this.bot.api.sendMessage(chatId, inProgressText, {
        reply_markup: buildTurnControlKeyboard(token),
      });
      this.turnControlByChat.set(key, {
        token: String(token),
        threadId: String(threadId),
        messageId: Number(sent?.message_id ?? 0),
      });
      this.#scheduleTurnControlQuotaRefresh(chatId, token, 1);
    } catch {
      // Non critical UI helper only.
    }
  }

  #scheduleTurnControlQuotaRefresh(chatId: string, token: string, attempt: number): void {
    const safeAttempt = Number.isFinite(attempt) ? Number(attempt) : 1;
    if (safeAttempt > 12) {
      return;
    }

    setTimeout(() => {
      void this.#refreshTurnControlQuota(chatId, token, safeAttempt);
    }, 1500);
  }

  async #refreshTurnControlQuota(chatId: string, token: string, attempt: number): Promise<void> {
    if (!this.bot) {
      return;
    }

    const key = String(chatId);
    const current = this.turnControlByChat.get(key);
    if (!current || String(current.token) !== String(token)) {
      return;
    }

    const quota = await resolveCodexQuotaLine(this.runtime);
    if (!quota.line) {
      this.#scheduleTurnControlQuotaRefresh(chatId, token, Number(attempt) + 1);
      return;
    }

    // Keep polling until the real quota percentages arrive (model-only line is not enough).
    if (!quota.hasQuotaWindows) {
      this.#scheduleTurnControlQuotaRefresh(chatId, token, Number(attempt) + 1);
      return;
    }

    const inProgressText = ["Generation in progress.", quota.line].join("\n");
    try {
      await this.bot.api.editMessageText(chatId, current.messageId, inProgressText, {
        reply_markup: buildTurnControlKeyboard(token),
      });
    } catch {
      // Message may be outdated/deleted or unchanged; ignore.
    }
  }

  async #closeTurnControls(
    chatId: string,
    token: string | null = null,
    finalText: string | null = null,
  ): Promise<void> {
    const key = String(chatId);
    const current = this.turnControlByChat.get(key);
    if (!current) {
      return;
    }
    if (token && String(current.token) !== String(token)) {
      return;
    }

    this.turnControlByChat.delete(key);
    if (!this.bot) {
      return;
    }

    try {
      if (finalText) {
        await this.bot.api.editMessageText(chatId, current.messageId, String(finalText), {
          reply_markup: {
            inline_keyboard: [],
          },
        });
      } else {
        await this.bot.api.editMessageReplyMarkup(chatId, current.messageId, {
          reply_markup: {
            inline_keyboard: [],
          },
        });
      }
    } catch {
      // Message may be outdated/deleted; ignore.
    }
  }

  async #handleSingleApproval(context: Context, decision: ApprovalDecision): Promise<void> {
    const chatId = getContextChatId(context);
    if (!chatId) {
      await context.reply("Unable to resolve chat.");
      return;
    }
    if (!this.#isAllowedChat(chatId)) {
      await context.reply("Chat not allowed for this bot.");
      return;
    }

    const threadId = await this.runtime.resolveThreadIdForChannel({
      channelKind: this.kind,
      channelId: this.id,
      externalUserId: chatId,
    });
    const requestedId = extractFirstCommandArgument(getContextMessageText(context));
    if (requestedId.toLowerCase() === "all") {
      const summary = await this.#resolveAllApprovals({ threadId, decision });
      await context.reply(summary);
      return;
    }

    const approvals = await this.runtime.listPendingApprovals(threadId);
    const target = selectApproval(approvals, requestedId);
    if (!target) {
      await context.reply(buildApprovalSelectionMessage(approvals, requestedId));
      return;
    }

    await this.runtime.resolvePendingApproval({
      threadId,
      approvalId: target.id,
      decision,
    });

    if (decision === "decline") {
      await context.reply(`Denied '${target.id}'.`);
      return;
    }
    if (decision === "acceptForSession") {
      await context.reply(`Approved '${target.id}' with session remember.`);
      return;
    }
    await context.reply(`Approved '${target.id}'.`);
  }

  async #handleBulkApproval(context: Context, decision: ApprovalDecision): Promise<void> {
    const chatId = getContextChatId(context);
    if (!chatId) {
      await context.reply("Unable to resolve chat.");
      return;
    }
    if (!this.#isAllowedChat(chatId)) {
      await context.reply("Chat not allowed for this bot.");
      return;
    }

    const threadId = await this.runtime.resolveThreadIdForChannel({
      channelKind: this.kind,
      channelId: this.id,
      externalUserId: chatId,
    });

    const summary = await this.#resolveAllApprovals({
      threadId,
      decision,
    });
    await context.reply(summary);
  }

  async #resolveAllApprovals({
    threadId,
    decision,
  }: {
    threadId: string;
    decision: ApprovalDecision;
  }): Promise<string> {
    const approvals = await this.runtime.listPendingApprovals(threadId);
    if (approvals.length === 0) {
      return "No pending approvals.";
    }

    let successCount = 0;
    const failedIds: string[] = [];
    for (const approval of approvals) {
      try {
        await this.runtime.resolvePendingApproval({
          threadId,
          approvalId: approval.id,
          decision,
        });
        successCount += 1;
      } catch {
        failedIds.push(approval.id);
      }
    }

    const decisionLabel =
      decision === "decline"
        ? "denied"
        : decision === "acceptForSession"
          ? "approved (session)"
          : "approved";
    if (failedIds.length === 0) {
      return `${successCount}/${approvals.length} approvals ${decisionLabel}.`;
    }
    return `${successCount}/${approvals.length} approvals ${decisionLabel}. Failed: ${failedIds.join(", ")}`;
  }

  #isAllowedChat(chatId: string): boolean {
    const set = this.allowedChatIds;
    if (!set || set.size === 0) {
      return true;
    }
    return set.has(String(chatId));
  }
}

function toRuntimeLike(runtime: unknown): RuntimeLike {
  return runtime as RuntimeLike;
}

function getContextChatId(context: Context): string {
  return String(context.chat?.id ?? "").trim();
}

function getContextMessageText(context: Context): string {
  return String(context.message?.text ?? "").trim();
}

async function sendChunkedMessage(botApi: Api, chatId: string, text: string): Promise<void> {
  const max = 3900;
  for (let start = 0; start < text.length; start += max) {
    const chunk = text.slice(start, start + max);
    await botApi.sendMessage(chatId, chunk || " ");
  }
}

function formatApprovalList(approvals: PendingApproval[]): string {
  const lines = ["Pending approvals:"];
  for (const approval of approvals) {
    const commandPart = approval.command ? ` | ${approval.command.slice(0, 90)}` : "";
    lines.push(`${approval.id} | ${approval.kind}${commandPart}`);
  }
  return lines.join("\n");
}

function extractFirstCommandArgument(text: string): string {
  const value = String(text ?? "").trim();
  const parts = value.split(/\s+/).slice(1);
  return String(parts[0] ?? "").trim();
}

function extractCommandTail(text: string): string {
  const value = String(text ?? "").trim();
  const firstSpace = value.indexOf(" ");
  if (firstSpace < 0) {
    return "";
  }
  return value.slice(firstSpace + 1).trim();
}

function selectApproval(approvals: PendingApproval[], requestedId: string): PendingApproval | null {
  const wantedId = String(requestedId ?? "").trim();
  if (wantedId) {
    return approvals.find((approval) => approval.id === wantedId) ?? null;
  }
  if (approvals.length === 1) {
    return approvals[0] ?? null;
  }
  return null;
}

function buildApprovalSelectionMessage(approvals: PendingApproval[], requestedId: string): string {
  const wantedId = String(requestedId ?? "").trim();
  if (wantedId && approvals.length > 0) {
    return `Approval '${wantedId}' not found.\n${formatApprovalList(approvals)}`;
  }
  if (approvals.length === 0) {
    return "No pending approvals.";
  }
  return `Multiple approvals pending.\n${formatApprovalList(approvals)}\nUse /approve <id>, /approvealways <id>, /approveall, /approveallalways, /deny <id> or /denyall.`;
}

function formatInterruptResult(result: InterruptResult | null): string {
  if (!result || typeof result !== "object") {
    return "Stop request sent.";
  }
  if (result.interrupted === true) {
    if (String(result.method ?? "") === "process_restart") {
      return "Generation interruption requested (provider restarted).";
    }
    return "Generation interruption requested.";
  }

  const reason = String(result.reason ?? "")
    .trim()
    .toLowerCase();
  if (reason === "no_active_turn" || reason === "no_active_session") {
    return "No active generation to stop.";
  }
  if (reason === "not_supported") {
    return "Stop is not supported by this provider.";
  }
  if (reason === "error") {
    return `Stop failed:\n${String(result.error ?? "unknown error")}`;
  }
  return "No active generation to stop.";
}

function buildSteerPrompt(instruction: string): string {
  const text = String(instruction ?? "").trim();
  return [
    "Steer instruction from user:",
    text,
    "Continue by strictly applying this steering.",
  ].join("\n");
}

function isTurnInterruptedError(message: string): boolean {
  const normalized = String(message ?? "")
    .trim()
    .toLowerCase();
  if (!normalized) {
    return false;
  }
  return (
    normalized.includes("turn was interrupted") ||
    normalized.includes("turn interrupted by user") ||
    normalized.includes("process stopped while waiting for turn completion")
  );
}

async function buildTurnFailureMessage({
  runtime,
  safeError,
}: {
  runtime: RuntimeLike;
  safeError: string;
}): Promise<string> {
  if (isQuotaLimitError(safeError)) {
    const quota = await resolveCodexQuotaLine(runtime);
    const base = "Execution paused: Codex quota limit reached for this account.";
    if (quota.line) {
      return `${base}\n${quota.line}`;
    }
    return `${base}\nPlease retry after the quota reset window.`;
  }
  return `Execution error:\n${safeError}`;
}

function isQuotaLimitError(message: string): boolean {
  const normalized = String(message ?? "")
    .trim()
    .toLowerCase();
  if (!normalized) {
    return false;
  }
  return (
    normalized.includes("quota") ||
    normalized.includes("rate limit") ||
    normalized.includes("too many requests") ||
    normalized.includes("usage limit") ||
    normalized.includes("limit reached") ||
    normalized.includes("insufficient quota") ||
    normalized.includes("credit balance") ||
    normalized.includes("429")
  );
}

function sanitizeError(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  return raw.split(/\r?\n/).slice(0, 12).join("\n");
}

function normalizeAllowedChatIds(value: TelegramChannelConfig["allowedChatIds"]): Set<string> {
  if (Array.isArray(value)) {
    return new Set(value.map((entry) => String(entry ?? "").trim()).filter(Boolean));
  }

  if (typeof value === "string") {
    return new Set(
      value
        .split(",")
        .map((entry) => entry.trim())
        .filter(Boolean),
    );
  }

  return new Set();
}

function buildTurnControlKeyboard(token: string): {
  inline_keyboard: Array<Array<{ text: string; callback_data: string }>>;
} {
  const safeToken = String(token ?? "").trim();
  if (!safeToken) {
    return {
      inline_keyboard: [],
    };
  }

  return {
    inline_keyboard: [
      [
        {
          text: "Interrompre",
          callback_data: `turnctl:stop:${safeToken}`,
        },
      ],
    ],
  };
}

function parseTurnControlCallbackData(raw: string): { action: "stop"; token: string } | null {
  const value = String(raw ?? "").trim();
  const match = /^turnctl:(stop):([A-Za-z0-9._:-]+)$/.exec(value);
  if (!match) {
    return null;
  }
  const action = match[1];
  const token = match[2];
  if (action !== "stop" || !token) {
    return null;
  }
  return {
    action,
    token,
  };
}

async function resolveCodexQuotaLine(
  runtime: RuntimeLike,
): Promise<{ line: string; hasQuotaWindows: boolean }> {
  if (!runtime || typeof runtime.getProviderUsage !== "function") {
    return resolveCodexQuotaLineFromSnapshot(null);
  }

  try {
    const snapshot = await runtime.getProviderUsage();
    const first = resolveCodexQuotaLineFromSnapshot(snapshot);
    if (first.hasQuotaWindows) {
      return first;
    }

    const fallbackSnapshot = await fetchCodexQuotaSnapshotFromAuth();
    if (!fallbackSnapshot) {
      return first;
    }

    const merged =
      snapshot && typeof snapshot === "object"
        ? {
            ...(snapshot as Record<string, unknown>),
            ...fallbackSnapshot,
          }
        : fallbackSnapshot;
    return resolveCodexQuotaLineFromSnapshot(merged);
  } catch {
    return resolveCodexQuotaLineFromSnapshot(null);
  }
}

function resolveCodexQuotaLineFromSnapshot(snapshot: unknown): {
  line: string;
  hasQuotaWindows: boolean;
} {
  const typed = snapshot as Parameters<typeof formatCodexQuotaLine>[0];
  return {
    line: formatCodexQuotaLine(typed),
    hasQuotaWindows: hasQuotaWindowsSnapshot(typed),
  };
}

function hasQuotaWindowsSnapshot(snapshot: unknown): boolean {
  if (!snapshot || typeof snapshot !== "object") {
    return false;
  }
  const safe = snapshot as {
    primary?: { remainingPercent?: unknown } | null;
    secondary?: { remainingPercent?: unknown } | null;
  };
  const primary = Number(safe.primary?.remainingPercent);
  const secondary = Number(safe.secondary?.remainingPercent);
  return Number.isFinite(primary) || Number.isFinite(secondary);
}

async function fetchCodexQuotaSnapshotFromAuth(): Promise<CodexUsageSnapshot> {
  const now = Date.now();
  const cached = readCachedCodexQuotaSnapshot(now);
  if (cached) {
    return cached as CodexUsageSnapshot;
  }

  const auth = await readCodexAuthTokens();
  if (!auth?.accessToken) {
    return null;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => {
    controller.abort();
  }, 3500);

  try {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${auth.accessToken}`,
      Accept: "application/json",
      "User-Agent": "CopilotHub",
    };
    if (auth.accountId) {
      headers["ChatGPT-Account-Id"] = auth.accountId;
    }

    const response = await fetch("https://chatgpt.com/backend-api/wham/usage", {
      method: "GET",
      headers,
      signal: controller.signal,
    });
    if (!response.ok) {
      return null;
    }

    const payload = (await response.json()) as {
      rate_limit?: {
        primary_window?: {
          used_percent?: number;
          remaining_percent?: number;
          reset_at?: number;
          resets_at?: number;
        };
        secondary_window?: {
          used_percent?: number;
          remaining_percent?: number;
          reset_at?: number;
          resets_at?: number;
        };
      };
    };

    const primary = normalizeWhamWindow(payload?.rate_limit?.primary_window);
    const secondary = normalizeWhamWindow(payload?.rate_limit?.secondary_window);
    const hasData =
      Number.isFinite(Number(primary?.remainingPercent)) ||
      Number.isFinite(Number(secondary?.remainingPercent));
    if (!hasData) {
      return null;
    }

    const snapshot: CodexUsageSnapshot = { primary, secondary };
    writeCachedCodexQuotaSnapshot(snapshot, now + CODEX_USAGE_CACHE_TTL_MS);
    return snapshot;
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

function normalizeWhamWindow(
  window:
    | {
        used_percent?: number;
        remaining_percent?: number;
        reset_at?: number;
        resets_at?: number;
      }
    | null
    | undefined,
): { remainingPercent: number | null; resetsAt: number | null } {
  const used = Number(window?.used_percent);
  const remainingDirect = Number(window?.remaining_percent);
  let remaining: number | null = null;
  if (Number.isFinite(remainingDirect)) {
    remaining = clampPercent(remainingDirect);
  } else if (Number.isFinite(used)) {
    remaining = clampPercent(100 - used);
  }

  const resetSeconds = Number(window?.reset_at ?? window?.resets_at);
  const resetsAt = Number.isFinite(resetSeconds) ? resetSeconds : null;
  return {
    remainingPercent: remaining,
    resetsAt,
  };
}

async function readCodexAuthTokens(): Promise<{
  accessToken: string;
  accountId: string | null;
} | null> {
  const codexHome = resolveCodexHomeDir();
  const authPath = path.join(codexHome, "auth.json");
  try {
    const raw = await fs.readFile(authPath, "utf8");
    const parsed = JSON.parse(raw) as {
      tokens?: { access_token?: string; account_id?: string };
    };
    const accessToken = String(parsed?.tokens?.access_token ?? "").trim();
    if (!accessToken) {
      return null;
    }
    const accountId = String(parsed?.tokens?.account_id ?? "").trim() || null;
    return { accessToken, accountId };
  } catch {
    return null;
  }
}

function resolveCodexHomeDir(): string {
  const fromEnv = String(process.env.CODEX_HOME_DIR ?? process.env.CODEX_HOME ?? "").trim();
  if (fromEnv) {
    return resolvePathFromBase(fromEnv, resolveProcessConfigBaseDir());
  }
  return path.join(os.homedir(), ".codex");
}

function clampPercent(value: number): number {
  const n = Number(value);
  if (!Number.isFinite(n)) {
    return 0;
  }
  if (n < 0) {
    return 0;
  }
  if (n > 100) {
    return 100;
  }
  return n;
}

function computePollingRetryDelay(attempt: number, baseMs: number, maxMs: number): number {
  const safeAttempt = Number.isFinite(attempt) && attempt > 0 ? Math.floor(attempt) : 0;
  const safeBase = normalizeRetryDelay(baseMs, TELEGRAM_POLLING_RETRY_BASE_MS);
  const safeMax = Math.max(safeBase, normalizeRetryDelay(maxMs, TELEGRAM_POLLING_RETRY_MAX_MS));
  return Math.min(safeMax, safeBase * 2 ** safeAttempt);
}

async function waitForPollingRetry(delayMs: number, shouldStop: () => boolean): Promise<void> {
  const remaining = Number.isFinite(delayMs) && delayMs > 0 ? Math.floor(delayMs) : 0;
  const startedAt = Date.now();
  while (!shouldStop()) {
    const elapsed = Date.now() - startedAt;
    if (elapsed >= remaining) {
      return;
    }
    const slice = Math.min(250, remaining - elapsed);
    await sleep(slice);
  }
}

function normalizeRetryDelay(value: unknown, fallback: number): number {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return fallback;
  }
  return parsed;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
