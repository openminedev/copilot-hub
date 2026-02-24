import fs from "node:fs/promises";
import path from "node:path";
import { Bot } from "grammy";

export class TelegramChannel {
  constructor({ channelConfig, runtime }) {
    this.kind = "telegram";
    this.id = String(channelConfig.id ?? "telegram");
    this.config = channelConfig;
    this.runtime = runtime;
    this.allowedChatIds = normalizeAllowedChatIds(channelConfig.allowedChatIds);
    this.bot = null;
    this.running = false;
    this.error = null;
    this.activeTurnsByChat = new Map();
    this.turnControlByChat = new Map();
    this.nextTurnToken = 1;
  }

  async start() {
    if (this.running) {
      return this.getStatus();
    }

    const token = String(this.config.token ?? "").trim();
    if (!token) {
      throw new Error(`Telegram token is missing for channel '${this.id}'.`);
    }

    const bot = new Bot(token);
    this.#attachHandlers(bot);
    this.error = null;
    this.running = true;
    this.bot = bot;

    void bot
      .start({
        onStart: () => {
          console.log(`[${this.runtime.runtimeId}:${this.id}] Telegram polling started.`);
        }
      })
      .catch((error) => {
        this.error = sanitizeError(error);
        this.running = false;
        this.bot = null;
        console.error(`[${this.runtime.runtimeId}:${this.id}] Telegram polling error: ${this.error}`);
      });

    return this.getStatus();
  }

  async stop() {
    if (this.bot) {
      try {
        this.bot.stop();
      } catch {
        // Ignore stop errors.
      }
    }
    this.bot = null;
    this.running = false;
    this.activeTurnsByChat.clear();
    this.turnControlByChat.clear();
    return this.getStatus();
  }

  async shutdown() {
    await this.stop();
  }

  getStatus() {
    return {
      kind: this.kind,
      id: this.id,
      running: this.running,
      error: this.error
    };
  }

  async notifyApproval(approval) {
    const chatId = String(approval?.metadata?.chatId ?? "").trim();
    if (!chatId || !this.bot) {
      return;
    }

    const lines = [
      `Approval required [${approval.id}]`,
      `type: ${approval.kind}`,
      `thread: ${approval.threadId}`
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

  #attachHandlers(bot) {
    bot.command("start", async (context) => {
      const chatId = String(context.chat.id);
      if (!this.#isAllowedChat(chatId)) {
        await context.reply("Chat not allowed for this bot.");
        return;
      }

      const threadId = await this.runtime.resolveThreadIdForChannel({
        channelKind: this.kind,
        channelId: this.id,
        externalUserId: chatId
      });
      await context.reply(
        [
          `Agent '${this.runtime.runtimeName}' ready.`,
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
          `threadId: ${threadId}`
        ]
          .filter(Boolean)
          .join("\n")
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
        externalUserId: chatId
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
        externalUserId: chatId
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
        externalUserId: chatId
      });
      const { thread } = await this.runtime.getThread(threadId);
      await context.reply(
        [
          `agent: ${this.runtime.runtimeName}`,
          `threadId: ${threadId}`,
          `turnCount: ${thread.turnCount ?? 0}`,
          `sessionId: ${thread.sessionId ?? "<none>"}`,
          `updatedAt: ${thread.updatedAt ?? "<unknown>"}`,
          `web: ${this.runtime.buildWebBotUrl()}`
        ].join("\n")
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
        externalUserId: chatId
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
      const payload = parseTurnControlCallbackData(context.callbackQuery.data);
      if (!payload) {
        return;
      }

      const chatId = String(context.callbackQuery.message?.chat?.id ?? "");
      if (!chatId || !this.#isAllowedChat(chatId)) {
        await context.answerCallbackQuery({
          text: "Chat not allowed for this bot.",
          show_alert: true
        });
        return;
      }

      const active = this.#getActiveTurn(chatId);
      if (!active || active.token !== payload.token) {
        await context.answerCallbackQuery({
          text: "No active generation for this action."
        });
        return;
      }

      if (payload.action === "stop") {
        const result = await this.runtime.interruptThread(active.threadId);
        if (result?.interrupted === true) {
          await this.#closeTurnControls(chatId, payload.token, "Generation interruption requested.");
        }
        await context.answerCallbackQuery({
          text: result?.interrupted === true ? "Interruption requested." : "No active generation to stop."
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
        await context.reply("Unknown command. Use /start.");
        return;
      }

      await this.#routeIncomingPrompt({
        chatId,
        prompt: text,
        mode: "auto_message"
      });
    });

    bot.on("message:photo", async (context) => {
      const chatId = String(context.chat.id);
      if (!this.#isAllowedChat(chatId)) {
        await context.reply("Chat not allowed for this bot.");
        return;
      }

      try {
        const photoInput = await this.#buildPhotoInputItem({ message: context.message });
        const caption = String(context.message?.caption ?? "").trim();
        const prompt = caption || "Analyze the image sent by the user and answer their request.";
        await this.#routeIncomingPrompt({
          chatId,
          prompt,
          mode: "auto_message",
          inputItems: [photoInput]
        });
      } catch (error) {
        await context.reply(`Unable to process photo:\n${sanitizeError(error)}`);
      }
    });

    bot.on("message:voice", async (context) => {
      const chatId = String(context.chat.id);
      if (!this.#isAllowedChat(chatId)) {
        await context.reply("Chat not allowed for this bot.");
        return;
      }

      try {
        const prompt = await this.#buildVoicePrompt({
          chatId,
          message: context.message
        });
        await this.#routeIncomingPrompt({
          chatId,
          prompt,
          mode: "auto_message"
        });
      } catch (error) {
        await context.reply(`Unable to process voice note:\n${sanitizeError(error)}`);
      }
    });

    bot.catch((error) => {
      const details = error.error instanceof Error ? error.error.stack ?? error.error.message : String(error.error);
      this.error = details;
      console.error(`[${this.runtime.runtimeId}:${this.id}] Telegram error in update ${error.ctx.update.update_id}: ${details}`);
    });
  }

  async #routeIncomingPrompt({ chatId, prompt, mode = "auto_message", inputItems = null }) {
    const normalizedPrompt = String(prompt ?? "").trim();
    if (!normalizedPrompt) {
      if (this.bot) {
        await this.bot.api.sendMessage(chatId, "Message is empty.");
      }
      return;
    }

    const threadId = await this.runtime.resolveThreadIdForChannel({
      channelKind: this.kind,
      channelId: this.id,
      externalUserId: chatId
    });

    const activeTurn = this.#getActiveTurn(chatId);
    if (activeTurn && activeTurn.threadId === threadId) {
      await this.#applySteerInstruction({
        chatId,
        threadId,
        prompt: normalizedPrompt,
        mode,
        inputItems
      });
      return;
    }

    void this.#processTurn({
      chatId,
      threadId,
      prompt: normalizedPrompt,
      inputItems
    });
  }

  async #buildPhotoInputItem({ message }) {
    const photos = Array.isArray(message?.photo) ? message.photo : [];
    if (photos.length === 0) {
      throw new Error("Telegram update does not contain photo payload.");
    }

    let chosen = photos[0];
    for (const candidate of photos) {
      if (Number(candidate?.file_size ?? 0) >= Number(chosen?.file_size ?? 0)) {
        chosen = candidate;
      }
    }

    const fileId = String(chosen?.file_id ?? "").trim();
    if (!fileId) {
      throw new Error("Telegram photo file id is missing.");
    }

    const file = await this.#resolveTelegramFile(fileId);
    const telegramPath = String(file?.file_path ?? "").trim();
    if (!telegramPath) {
      throw new Error("Telegram photo file path is missing.");
    }

    const binary = await this.#downloadTelegramBinary(telegramPath);
    const maxBytes = 8 * 1024 * 1024;
    if (binary.length > maxBytes) {
      throw new Error(`Photo is too large for direct model upload (${binary.length} bytes). Please send a smaller image.`);
    }

    const mime = mimeTypeFromExtension(path.extname(telegramPath), "image/jpeg");
    const dataUrl = `data:${mime};base64,${binary.toString("base64")}`;
    return {
      type: "image",
      url: dataUrl
    };
  }

  async #buildVoicePrompt({ chatId, message }) {
    const voice = message?.voice;
    if (!voice || !voice.file_id) {
      throw new Error("Telegram update does not contain voice payload.");
    }

    const stored = await this.#saveTelegramMediaFile({
      chatId,
      fileId: String(voice.file_id ?? "").trim(),
      mediaKind: "voice",
      preferredExtension: extensionFromMimeType(voice.mime_type)
    });
    const caption = String(message?.caption ?? "").trim();

    const lines = [
      "Telegram user sent a voice note.",
      `file_path: ${stored.relativePath}`,
      `absolute_path: ${stored.absolutePath}`,
      `duration_seconds: ${Number(voice.duration ?? 0)}`,
      `mime_type: ${String(voice.mime_type ?? "audio/ogg")}`
    ];
    if (caption) {
      lines.push(`caption: ${caption}`);
    }
    lines.push(
      "Task: transcribe the audio first, then answer the user request. If transcription is not possible with available tools, explain what is missing."
    );
    return lines.join("\n");
  }

  async #resolveTelegramFile(fileId) {
    if (!this.bot) {
      throw new Error("Telegram bot is not running.");
    }
    const normalizedFileId = String(fileId ?? "").trim();
    if (!normalizedFileId) {
      throw new Error("Telegram file id is missing.");
    }
    return this.bot.api.getFile(normalizedFileId);
  }

  async #downloadTelegramBinary(telegramPath) {
    const token = String(this.config.token ?? "").trim();
    if (!token) {
      throw new Error("Telegram token is missing.");
    }

    const normalizedPath = String(telegramPath ?? "").trim();
    if (!normalizedPath) {
      throw new Error("Telegram file path is missing.");
    }

    const downloadUrl = `https://api.telegram.org/file/bot${token}/${normalizedPath}`;
    const response = await fetch(downloadUrl);
    if (!response.ok) {
      throw new Error(`Telegram download failed (HTTP ${response.status}).`);
    }
    return Buffer.from(await response.arrayBuffer());
  }

  async #saveTelegramMediaFile({ chatId, fileId, mediaKind, preferredExtension }) {
    if (!this.bot) {
      throw new Error("Telegram bot is not running.");
    }

    const normalizedFileId = String(fileId ?? "").trim();
    if (!normalizedFileId) {
      throw new Error("Telegram file id is missing.");
    }

    const file = await this.#resolveTelegramFile(normalizedFileId);
    const telegramPath = String(file?.file_path ?? "").trim();
    if (!telegramPath) {
      throw new Error("Telegram file path is missing.");
    }

    const workspaceRoot = this.#resolveWorkspaceRoot();
    const day = new Date().toISOString().slice(0, 10);
    const targetDir = path.join(
      workspaceRoot,
      ".runtime_media",
      "telegram",
      sanitizePathSegment(this.id),
      sanitizePathSegment(chatId),
      day
    );
    await fs.mkdir(targetDir, { recursive: true });

    const extension = normalizeMediaExtension(path.extname(telegramPath), preferredExtension);
    const fileName = `${sanitizePathSegment(mediaKind)}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}${extension}`;
    const absolutePath = path.join(targetDir, fileName);
    const payload = await this.#downloadTelegramBinary(telegramPath);
    await fs.writeFile(absolutePath, payload);

    const relativePath = normalizePathForPrompt(path.relative(workspaceRoot, absolutePath) || fileName);
    return {
      absolutePath: normalizePathForPrompt(absolutePath),
      relativePath
    };
  }

  #resolveWorkspaceRoot() {
    if (this.runtime && typeof this.runtime.getWorkspaceRoot === "function") {
      return path.resolve(String(this.runtime.getWorkspaceRoot() ?? process.cwd()));
    }
    return path.resolve(process.cwd());
  }

  async #processTurn({ chatId, threadId, prompt, inputItems = null }) {
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
        inputItems: Array.isArray(inputItems) ? inputItems : undefined,
        source: "telegram",
        metadata: {
          chatId,
          channelId: this.id
        }
      });
      await sendChunkedMessage(this.bot.api, chatId, result.assistantText || "Assistant returned no text output.");
    } catch (error) {
      const safe = sanitizeError(error);
      if (isTurnInterruptedError(safe)) {
        controlStatus = "Generation interrupted.";
        await this.bot.api.sendMessage(chatId, "Generation stopped.");
        return;
      }
      controlStatus = "Generation failed.";
      await this.bot.api.sendMessage(chatId, `Execution error:\n${safe}`);
    } finally {
      this.#clearActiveTurn(chatId, turnToken);
      await this.#closeTurnControls(chatId, turnToken, controlStatus);
    }
  }

  async #handleStopTurn(context) {
    const chatId = String(context.chat.id);
    if (!this.#isAllowedChat(chatId)) {
      await context.reply("Chat not allowed for this bot.");
      return;
    }

    const threadId = await this.runtime.resolveThreadIdForChannel({
      channelKind: this.kind,
      channelId: this.id,
      externalUserId: chatId
    });
    const result = await this.runtime.interruptThread(threadId);
    await context.reply(formatInterruptResult(result));
  }

  async #handleSteer(context) {
    const chatId = String(context.chat.id);
    if (!this.#isAllowedChat(chatId)) {
      await context.reply("Chat not allowed for this bot.");
      return;
    }

    const instruction = extractCommandTail(context.message.text);
    const threadId = await this.runtime.resolveThreadIdForChannel({
      channelKind: this.kind,
      channelId: this.id,
      externalUserId: chatId
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
      mode: "command_steer"
    });
  }

  #markActiveTurn(chatId, threadId) {
    const token = `turn_${Date.now()}_${this.nextTurnToken++}`;
    this.activeTurnsByChat.set(String(chatId), {
      threadId: String(threadId),
      token
    });
    return token;
  }

  #clearActiveTurn(chatId, token) {
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

  #getActiveTurn(chatId) {
    return this.activeTurnsByChat.get(String(chatId)) ?? null;
  }

  async #applySteerInstruction({ chatId, threadId, prompt, mode = "command_steer", inputItems = null }) {
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
      if (!(interruption?.interrupted === true || reason === "no_active_turn" || reason === "no_active_session")) {
        if (this.bot) {
          await this.bot.api.sendMessage(chatId, `Unable to apply steer now.\n${formatInterruptResult(interruption)}`);
        }
        return;
      }
      if (this.bot) {
        if (mode === "auto_message") {
          await this.bot.api.sendMessage(chatId, "New message received. Generation interrupted, applying it now.");
        } else {
          await this.bot.api.sendMessage(chatId, "Steer accepted. Generation interrupted, applying instruction now.");
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
      inputItems
    });
  }

  async #openTurnControls(chatId, threadId, token) {
    if (!this.bot) {
      return;
    }

    const key = String(chatId);
    await this.#closeTurnControls(chatId, null, null);
    try {
      const sent = await this.bot.api.sendMessage(chatId, "Generation in progress.", {
        reply_markup: buildTurnControlKeyboard(token)
      });
      this.turnControlByChat.set(key, {
        token: String(token),
        threadId: String(threadId),
        messageId: Number(sent?.message_id ?? 0)
      });
    } catch {
      // Non critical UI helper only.
    }
  }

  async #closeTurnControls(chatId, token = null, finalText = null) {
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
            inline_keyboard: []
          }
        });
      } else {
        await this.bot.api.editMessageReplyMarkup(chatId, current.messageId, {
          reply_markup: {
            inline_keyboard: []
          }
        });
      }
    } catch {
      // Message may be outdated/deleted; ignore.
    }
  }

  async #handleSingleApproval(context, decision) {
    const chatId = String(context.chat.id);
    if (!this.#isAllowedChat(chatId)) {
      await context.reply("Chat not allowed for this bot.");
      return;
    }

    const threadId = await this.runtime.resolveThreadIdForChannel({
      channelKind: this.kind,
      channelId: this.id,
      externalUserId: chatId
    });
    const requestedId = extractFirstCommandArgument(context.message.text);
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
      decision
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

  async #handleBulkApproval(context, decision) {
    const chatId = String(context.chat.id);
    if (!this.#isAllowedChat(chatId)) {
      await context.reply("Chat not allowed for this bot.");
      return;
    }

    const threadId = await this.runtime.resolveThreadIdForChannel({
      channelKind: this.kind,
      channelId: this.id,
      externalUserId: chatId
    });

    const summary = await this.#resolveAllApprovals({
      threadId,
      decision
    });
    await context.reply(summary);
  }

  async #resolveAllApprovals({ threadId, decision }) {
    const approvals = await this.runtime.listPendingApprovals(threadId);
    if (approvals.length === 0) {
      return "No pending approvals.";
    }

    let successCount = 0;
    const failedIds = [];
    for (const approval of approvals) {
      try {
        await this.runtime.resolvePendingApproval({
          threadId,
          approvalId: approval.id,
          decision
        });
        successCount += 1;
      } catch {
        failedIds.push(approval.id);
      }
    }

    const decisionLabel = decision === "decline" ? "denied" : decision === "acceptForSession" ? "approved (session)" : "approved";
    if (failedIds.length === 0) {
      return `${successCount}/${approvals.length} approvals ${decisionLabel}.`;
    }
    return `${successCount}/${approvals.length} approvals ${decisionLabel}. Failed: ${failedIds.join(", ")}`;
  }

  #isAllowedChat(chatId) {
    const set = this.allowedChatIds;
    if (!set || set.size === 0) {
      return true;
    }
    return set.has(String(chatId));
  }
}

async function sendChunkedMessage(botApi, chatId, text) {
  const max = 3900;
  for (let start = 0; start < text.length; start += max) {
    const chunk = text.slice(start, start + max);
    await botApi.sendMessage(chatId, chunk || " ");
  }
}

function formatApprovalList(approvals) {
  const lines = ["Pending approvals:"];
  for (const approval of approvals) {
    const commandPart = approval.command ? ` | ${approval.command.slice(0, 90)}` : "";
    lines.push(`${approval.id} | ${approval.kind}${commandPart}`);
  }
  return lines.join("\n");
}

function extractFirstCommandArgument(text) {
  const value = String(text ?? "").trim();
  const parts = value.split(/\s+/).slice(1);
  return String(parts[0] ?? "").trim();
}

function extractCommandTail(text) {
  const value = String(text ?? "").trim();
  const firstSpace = value.indexOf(" ");
  if (firstSpace < 0) {
    return "";
  }
  return value.slice(firstSpace + 1).trim();
}

function selectApproval(approvals, requestedId) {
  const wantedId = String(requestedId ?? "").trim();
  if (wantedId) {
    return approvals.find((approval) => approval.id === wantedId) ?? null;
  }
  if (approvals.length === 1) {
    return approvals[0];
  }
  return null;
}

function buildApprovalSelectionMessage(approvals, requestedId) {
  const wantedId = String(requestedId ?? "").trim();
  if (wantedId && approvals.length > 0) {
    return `Approval '${wantedId}' not found.\n${formatApprovalList(approvals)}`;
  }
  if (approvals.length === 0) {
    return "No pending approvals.";
  }
  return `Multiple approvals pending.\n${formatApprovalList(approvals)}\nUse /approve <id>, /approvealways <id>, /approveall, /approveallalways, /deny <id> or /denyall.`;
}

function formatInterruptResult(result) {
  if (!result || typeof result !== "object") {
    return "Stop request sent.";
  }
  if (result.interrupted === true) {
    if (String(result.method ?? "") === "process_restart") {
      return "Generation interruption requested (provider restarted).";
    }
    return "Generation interruption requested.";
  }

  const reason = String(result.reason ?? "").trim().toLowerCase();
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

function buildSteerPrompt(instruction) {
  const text = String(instruction ?? "").trim();
  return [
    "Steer instruction from user:",
    text,
    "Continue by strictly applying this steering."
  ].join("\n");
}

function isTurnInterruptedError(message) {
  const normalized = String(message ?? "").trim().toLowerCase();
  if (!normalized) {
    return false;
  }
  return (
    normalized.includes("turn was interrupted") ||
    normalized.includes("turn interrupted by user") ||
    normalized.includes("process stopped while waiting for turn completion")
  );
}

function normalizePathForPrompt(value) {
  return String(value ?? "").replace(/[\\/]+/g, "/");
}

function sanitizePathSegment(value) {
  const normalized = String(value ?? "")
    .trim()
    .replace(/[^A-Za-z0-9._-]+/g, "_");
  return normalized || "unknown";
}

function normalizeMediaExtension(primary, fallback = ".bin") {
  const direct = String(primary ?? "").trim();
  if (/^\.[A-Za-z0-9]{1,8}$/.test(direct)) {
    return direct.toLowerCase();
  }

  const alt = String(fallback ?? "").trim();
  if (/^\.[A-Za-z0-9]{1,8}$/.test(alt)) {
    return alt.toLowerCase();
  }

  return ".bin";
}

function extensionFromMimeType(value) {
  const mime = String(value ?? "")
    .trim()
    .toLowerCase();
  if (mime.includes("ogg")) {
    return ".ogg";
  }
  if (mime.includes("mpeg") || mime.includes("mp3")) {
    return ".mp3";
  }
  if (mime.includes("wav")) {
    return ".wav";
  }
  if (mime.includes("mp4")) {
    return ".mp4";
  }
  return ".ogg";
}

function mimeTypeFromExtension(extension, fallback = "application/octet-stream") {
  const ext = String(extension ?? "")
    .trim()
    .toLowerCase();
  if (ext === ".jpg" || ext === ".jpeg") {
    return "image/jpeg";
  }
  if (ext === ".png") {
    return "image/png";
  }
  if (ext === ".webp") {
    return "image/webp";
  }
  if (ext === ".gif") {
    return "image/gif";
  }
  return fallback;
}

function sanitizeError(error) {
  const raw = error instanceof Error ? error.message : String(error);
  return raw.split(/\r?\n/).slice(0, 12).join("\n");
}

function normalizeAllowedChatIds(value) {
  if (Array.isArray(value)) {
    return new Set(
      value
        .map((entry) => String(entry ?? "").trim())
        .filter(Boolean)
    );
  }

  if (typeof value === "string") {
    return new Set(
      value
        .split(",")
        .map((entry) => entry.trim())
        .filter(Boolean)
    );
  }

  return new Set();
}

function buildTurnControlKeyboard(token) {
  const safeToken = String(token ?? "").trim();
  if (!safeToken) {
    return {
      inline_keyboard: []
    };
  }

  return {
    inline_keyboard: [
      [
        {
          text: "Interrompre",
          callback_data: `turnctl:stop:${safeToken}`
        }
      ]
    ]
  };
}

function parseTurnControlCallbackData(raw) {
  const value = String(raw ?? "").trim();
  const match = /^turnctl:(stop):([A-Za-z0-9._:-]+)$/.exec(value);
  if (!match) {
    return null;
  }
  return {
    action: match[1],
    token: match[2]
  };
}





