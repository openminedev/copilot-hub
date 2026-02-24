import { randomBytes } from "node:crypto";

const MENU_TTL_MS = 15 * 60 * 1000;
const FLOW_TTL_MS = 10 * 60 * 1000;
const TELEGRAM_VERIFY_TIMEOUT_MS = 10_000;

const BOT_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const TELEGRAM_TOKEN_PATTERN = /^\d{5,}:[A-Za-z0-9_-]{20,}$/;

const menuSessions = new Map();
const createFlows = new Map();

const POLICY_PROFILES = {
  safe: {
    id: "safe",
    label: "Safe",
    sandboxMode: "read-only",
    approvalPolicy: "on-request"
  },
  standard: {
    id: "standard",
    label: "Standard",
    sandboxMode: "workspace-write",
    approvalPolicy: "on-request"
  },
  semi_auto: {
    id: "semi_auto",
    label: "Semi Auto",
    sandboxMode: "workspace-write",
    approvalPolicy: "on-failure"
  },
  full_auto: {
    id: "full_auto",
    label: "Full Auto",
    sandboxMode: "danger-full-access",
    approvalPolicy: "never"
  }
};

export async function maybeHandleHubOpsCommand({ ctx, runtime, channelId }) {
  const text = String(ctx.message?.text ?? "").trim();
  const command = extractCommand(text);
  if (!command) {
    return false;
  }

  cleanupState();

  const chatId = getChatId(ctx);
  const flowKey = buildFlowKey(runtime?.runtimeId, channelId, chatId);

  if (command === "/start" || command === "/help") {
    await ctx.reply(buildHelpText(runtime?.runtimeName));
    return true;
  }

  if (command === "/health") {
    try {
      const health = await apiGet("/api/health");
      await ctx.reply(
        [
          "Engine health:",
          `ok: ${Boolean(health?.ok)}`,
          `service: ${String(health?.service ?? "-")}`,
          `botCount: ${Number(health?.botCount ?? 0)}`,
          `webPort: ${String(health?.webPort ?? "-")}`
        ].join("\n")
      );
    } catch (error) {
      await ctx.reply(`Health failed: ${sanitizeError(error)}`);
    }
    return true;
  }

  if (command === "/bots") {
    try {
      await renderBotsMenu(ctx, { editMessage: false });
    } catch (error) {
      await ctx.reply(`Bots list failed: ${sanitizeError(error)}`);
    }
    return true;
  }

  if (command === "/create_agent") {
    const existing = createFlows.get(flowKey);
    if (existing) {
      await ctx.reply("A create flow is already active. Send /cancel to abort it first.");
      return true;
    }

    createFlows.set(flowKey, {
      createdAt: Date.now(),
      step: "token",
      token: null,
      tokenInfo: null,
      botId: null
    });

    await ctx.reply(
      [
        "Create agent wizard started.",
        "Step 1: send Telegram bot token.",
        "Format: 123456789:ABC...",
        "Use /cancel to stop."
      ].join("\n")
    );
    return true;
  }

  if (command === "/cancel") {
    const deleted = createFlows.delete(flowKey);
    await ctx.reply(deleted ? "Current operation canceled." : "No active operation.");
    return true;
  }

  return false;
}

export async function maybeHandleHubOpsFollowUp({ ctx, runtime, channelId }) {
  cleanupState();

  const text = String(ctx.message?.text ?? "").trim();
  if (!text || text.startsWith("/")) {
    return false;
  }

  const chatId = getChatId(ctx);
  const flowKey = buildFlowKey(runtime?.runtimeId, channelId, chatId);
  const flow = createFlows.get(flowKey);
  if (!flow) {
    return false;
  }

  if (flow.step === "token") {
    if (!TELEGRAM_TOKEN_PATTERN.test(text)) {
      await ctx.reply("Token format looks invalid. Send a valid Telegram token or /cancel.");
      return true;
    }

    const verification = await verifyTelegramToken(text);
    if (!verification.ok) {
      await ctx.reply(`Token verification failed:\n${verification.error}\nRetry or /cancel.`);
      return true;
    }

    flow.token = text;
    flow.tokenInfo = verification;
    flow.step = "bot_id";
    createFlows.set(flowKey, flow);

    const suggestedBotId = suggestBotIdFromUsername(verification.username);
    const suggestionText = suggestedBotId ? `Suggested id: ${suggestedBotId}` : "Suggested id: (none)";

    await ctx.reply(
      [
        `Token valid for @${verification.username || "unknown"}.`,
        suggestionText,
        "Step 2: send agent id (letters/numbers/_/-).",
        "You can also send: default"
      ].join("\n")
    );
    return true;
  }

  if (flow.step === "bot_id") {
    const suggestedBotId = suggestBotIdFromUsername(flow.tokenInfo?.username);
    const candidate = normalizeBotIdInput(text, suggestedBotId);
    if (!candidate || !BOT_ID_PATTERN.test(candidate)) {
      await ctx.reply("Invalid agent id. Use letters, numbers, underscore or dash.");
      return true;
    }

    flow.botId = candidate;
    flow.step = "confirm";
    createFlows.set(flowKey, flow);

    await ctx.reply(
      [
        "Step 3 confirm:",
        `agentId: ${flow.botId}`,
        `telegram: @${flow.tokenInfo?.username || "unknown"}`,
        "Reply YES to create, or NO to cancel."
      ].join("\n")
    );
    return true;
  }

  if (flow.step === "confirm") {
    const decision = text.toLowerCase();
    if (decision === "no" || decision === "n" || decision === "cancel") {
      createFlows.delete(flowKey);
      await ctx.reply("Create canceled.");
      return true;
    }

    if (!(decision === "yes" || decision === "y" || decision === "ok")) {
      await ctx.reply("Reply YES to create, or NO to cancel.");
      return true;
    }

    try {
      const result = await apiPost("/api/bots/create", {
        agent: buildTelegramAgentDefinition({
          botId: flow.botId,
          token: flow.token
        }),
        startIfEnabled: true
      });

      createFlows.delete(flowKey);
      await ctx.reply(
        [
          `Agent created: ${String(result?.bot?.id ?? flow.botId)}`,
          "Use /bots to manage policy, reset context, or delete."
        ].join("\n")
      );
      return true;
    } catch (error) {
      await ctx.reply(`Create failed:\n${sanitizeError(error)}\nRetry or /cancel.`);
      return true;
    }
  }

  createFlows.delete(flowKey);
  await ctx.reply("Flow reset. Use /create_agent to start again.");
  return true;
}

export async function maybeHandleHubOpsCallback({ ctx }) {
  const rawData = String(ctx.callbackQuery?.data ?? "").trim();
  if (!rawData.startsWith("hub:")) {
    return false;
  }

  cleanupState();

  const action = parseMenuAction(rawData);
  if (!action) {
    await answerCallbackQuerySafe(ctx);
    return true;
  }

  try {
    if (action.type === "create") {
      await answerCallbackQuerySafe(ctx, "Use /create_agent in this chat.");
      await ctx.reply("Use /create_agent to create a new Telegram agent.");
      return true;
    }

    if (action.type === "refresh") {
      await renderBotsMenu(ctx, { editMessage: true });
      await answerCallbackQuerySafe(ctx, "Updated");
      return true;
    }

    if (action.type === "back") {
      await renderBotsMenu(ctx, { editMessage: true });
      await answerCallbackQuerySafe(ctx);
      return true;
    }

    const session = getMenuSession(action.sessionId, ctx);
    if (!session) {
      await renderBotsMenu(ctx, { editMessage: true });
      await answerCallbackQuerySafe(ctx, "Menu expired. Refreshed.");
      return true;
    }

    const botId = getBotIdFromSession(session, action.index);
    if (!botId) {
      await renderBotsMenu(ctx, { editMessage: true });
      await answerCallbackQuerySafe(ctx, "Agent not found. Refreshed.");
      return true;
    }

    if (action.type === "open") {
      await renderBotActions(ctx, {
        sessionId: action.sessionId,
        index: action.index
      });
      await answerCallbackQuerySafe(ctx);
      return true;
    }

    if (action.type === "policy") {
      const profile = POLICY_PROFILES[action.profileId];
      if (!profile) {
        await answerCallbackQuerySafe(ctx, "Invalid profile.");
        return true;
      }

      await apiPost(`/api/bots/${encodeURIComponent(botId)}/policy`, {
        sandboxMode: profile.sandboxMode,
        approvalPolicy: profile.approvalPolicy
      });

      await renderBotActions(ctx, {
        sessionId: action.sessionId,
        index: action.index,
        notice: `Policy updated: ${profile.label}`
      });
      await answerCallbackQuerySafe(ctx, "Policy updated");
      return true;
    }

    if (action.type === "reset_ask") {
      await renderResetConfirm(ctx, {
        sessionId: action.sessionId,
        index: action.index,
        botId
      });
      await answerCallbackQuerySafe(ctx);
      return true;
    }

    if (action.type === "reset_confirm") {
      await apiPost(`/api/bots/${encodeURIComponent(botId)}/reset`, {});
      await renderBotActions(ctx, {
        sessionId: action.sessionId,
        index: action.index,
        notice: "Context reset completed."
      });
      await answerCallbackQuerySafe(ctx, "Context reset");
      return true;
    }

    if (action.type === "delete_ask") {
      await renderDeleteConfirm(ctx, {
        sessionId: action.sessionId,
        index: action.index,
        botId
      });
      await answerCallbackQuerySafe(ctx);
      return true;
    }

    if (action.type === "delete_confirm") {
      await apiPost(`/api/bots/${encodeURIComponent(botId)}/delete`, { deleteMode: "soft" });
      await renderBotsMenu(ctx, {
        editMessage: true,
        notice: `Agent deleted: ${botId}`
      });
      await answerCallbackQuerySafe(ctx, "Agent deleted");
      return true;
    }

    await answerCallbackQuerySafe(ctx);
    return true;
  } catch (error) {
    await answerCallbackQuerySafe(ctx, "Action failed");
    await editMessageOrReply(
      ctx,
      `Action failed:\n${sanitizeError(error)}`,
      {
        reply_markup: {
          inline_keyboard: [[{ text: "Back to bots", callback_data: "hub:back" }]]
        }
      }
    );
    return true;
  }
}

function buildHelpText(runtimeName) {
  return [
    `${String(runtimeName ?? "Copilot Hub")}`,
    "",
    "Commands:",
    "/help",
    "/health",
    "/bots",
    "/create_agent",
    "/cancel",
    "",
    "For development tasks, send a normal message to the assistant."
  ].join("\n");
}

function buildFlowKey(runtimeId, channelId, chatId) {
  return `${String(runtimeId ?? "hub")}::${String(channelId ?? "telegram")}::${String(chatId ?? "")}`;
}

function cleanupState() {
  const now = Date.now();

  for (const [sessionId, session] of menuSessions.entries()) {
    const createdAt = Number(session?.createdAt ?? 0);
    if (!Number.isFinite(createdAt) || now - createdAt > MENU_TTL_MS) {
      menuSessions.delete(sessionId);
    }
  }

  for (const [key, flow] of createFlows.entries()) {
    const createdAt = Number(flow?.createdAt ?? 0);
    if (!Number.isFinite(createdAt) || now - createdAt > FLOW_TTL_MS) {
      createFlows.delete(key);
    }
  }
}

async function renderBotsMenu(ctx, { editMessage = false, notice = "" } = {}) {
  const bots = await fetchBots();
  const chatId = getChatId(ctx);
  const sessionId = createMenuSession(chatId, bots);

  const lines = [];
  if (notice) {
    lines.push(notice, "");
  }
  lines.push("Agents:");

  if (bots.length === 0) {
    lines.push("No bots registered.");
  } else {
    for (const botState of bots) {
      const status = botState.running ? "ON" : "OFF";
      lines.push(`- ${botState.id} (${status})`);
    }
    lines.push("", "Tap an agent below.");
  }

  const keyboard = buildBotsMenuKeyboard(sessionId, bots);

  if (editMessage) {
    await editMessageOrReply(ctx, lines.join("\n"), {
      reply_markup: {
        inline_keyboard: keyboard
      }
    });
    return;
  }

  await ctx.reply(lines.join("\n"), {
    reply_markup: {
      inline_keyboard: keyboard
    }
  });
}

async function renderBotActions(ctx, { sessionId, index, notice = "" }) {
  const session = getMenuSession(sessionId, ctx);
  const botId = getBotIdFromSession(session, index);
  if (!botId) {
    await renderBotsMenu(ctx, { editMessage: true, notice: "Agent not found. Refreshed." });
    return;
  }

  const botState = await fetchBotById(botId);
  if (!botState) {
    await renderBotsMenu(ctx, { editMessage: true, notice: `Agent '${botId}' not found.` });
    return;
  }

  const providerOptions = botState?.provider?.options && typeof botState.provider.options === "object"
    ? botState.provider.options
    : {};

  const lines = [];
  if (notice) {
    lines.push(notice, "");
  }
  lines.push(
    `Agent: ${botState.id}`,
    `running: ${botState.running ? "yes" : "no"}`,
    `telegram: ${botState.telegramRunning ? "yes" : "no"}`,
    `sandboxMode: ${String(providerOptions.sandboxMode ?? "-")}`,
    `approvalPolicy: ${String(providerOptions.approvalPolicy ?? "-")}`,
    "",
    "Choose an action:"
  );

  await editMessageOrReply(ctx, lines.join("\n"), {
    reply_markup: {
      inline_keyboard: buildBotActionsKeyboard(sessionId, index)
    }
  });
}

async function renderResetConfirm(ctx, { sessionId, index, botId }) {
  await editMessageOrReply(ctx, [`Reset context for '${botId}'?`, "This clears the current web thread context."].join("\n"), {
    reply_markup: {
      inline_keyboard: [
        [
          { text: "Confirm reset", callback_data: `hub:rc:${sessionId}:${index}` },
          { text: "Cancel", callback_data: `hub:o:${sessionId}:${index}` }
        ],
        [{ text: "Back to bots", callback_data: "hub:back" }]
      ]
    }
  });
}

async function renderDeleteConfirm(ctx, { sessionId, index, botId }) {
  await editMessageOrReply(ctx, [`Delete agent '${botId}'?`, "This stops and removes the agent from runtime."].join("\n"), {
    reply_markup: {
      inline_keyboard: [
        [
          { text: "Confirm delete", callback_data: `hub:dc:${sessionId}:${index}` },
          { text: "Cancel", callback_data: `hub:o:${sessionId}:${index}` }
        ],
        [{ text: "Back to bots", callback_data: "hub:back" }]
      ]
    }
  });
}

function buildBotsMenuKeyboard(sessionId, bots) {
  const rows = [];

  for (let index = 0; index < bots.length; index += 1) {
    const botState = bots[index];
    const status = botState.running ? "ON" : "OFF";
    rows.push([{ text: `${botState.id} (${status})`, callback_data: `hub:o:${sessionId}:${index}` }]);
  }

  rows.push([{ text: "Refresh", callback_data: `hub:r:${sessionId}` }]);
  rows.push([{ text: "Create agent", callback_data: "hub:create" }]);
  return rows;
}

function buildBotActionsKeyboard(sessionId, index) {
  return [
    [
      { text: "Policy Safe", callback_data: `hub:p:${sessionId}:${index}:safe` },
      { text: "Policy Standard", callback_data: `hub:p:${sessionId}:${index}:standard` }
    ],
    [
      { text: "Policy Semi", callback_data: `hub:p:${sessionId}:${index}:semi_auto` },
      { text: "Policy Full", callback_data: `hub:p:${sessionId}:${index}:full_auto` }
    ],
    [{ text: "Reset Context", callback_data: `hub:ra:${sessionId}:${index}` }],
    [{ text: "Delete Agent", callback_data: `hub:da:${sessionId}:${index}` }],
    [{ text: "Back to bots", callback_data: "hub:back" }]
  ];
}

function createMenuSession(chatId, bots) {
  let sessionId = "";
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const candidate = randomBytes(4).toString("hex");
    if (!menuSessions.has(candidate)) {
      sessionId = candidate;
      break;
    }
  }

  if (!sessionId) {
    sessionId = `${Date.now().toString(36)}${Math.floor(Math.random() * 9999).toString(36)}`;
  }

  menuSessions.set(sessionId, {
    chatId,
    createdAt: Date.now(),
    botIds: bots.map((entry) => String(entry?.id ?? "").trim()).filter(Boolean)
  });

  return sessionId;
}

function getMenuSession(sessionId, ctx) {
  const session = menuSessions.get(sessionId);
  if (!session) {
    return null;
  }

  const chatId = getChatId(ctx);
  if (!chatId || session.chatId !== chatId) {
    return null;
  }

  return session;
}

function getBotIdFromSession(session, index) {
  if (!session) {
    return null;
  }

  if (!Number.isInteger(index) || index < 0 || index >= session.botIds.length) {
    return null;
  }

  const botId = String(session.botIds[index] ?? "").trim();
  return botId || null;
}

function parseMenuAction(rawData) {
  const data = String(rawData ?? "").trim();
  if (!data || !data.startsWith("hub:")) {
    return null;
  }

  if (data === "hub:back") {
    return { type: "back" };
  }

  if (data === "hub:create") {
    return { type: "create" };
  }

  const parts = data.split(":");
  if (parts.length < 3) {
    return null;
  }

  const kind = parts[1];

  if (kind === "r" && parts.length === 3) {
    return {
      type: "refresh",
      sessionId: parts[2]
    };
  }

  if ((kind === "o" || kind === "ra" || kind === "rc" || kind === "da" || kind === "dc") && parts.length === 4) {
    const index = parseMenuIndex(parts[3]);
    if (index === null) {
      return null;
    }

    const mapping = {
      o: "open",
      ra: "reset_ask",
      rc: "reset_confirm",
      da: "delete_ask",
      dc: "delete_confirm"
    };

    return {
      type: mapping[kind],
      sessionId: parts[2],
      index
    };
  }

  if (kind === "p" && parts.length === 5) {
    const index = parseMenuIndex(parts[3]);
    const profileId = String(parts[4] ?? "").trim().toLowerCase();
    if (index === null || !profileId) {
      return null;
    }

    return {
      type: "policy",
      sessionId: parts[2],
      index,
      profileId
    };
  }

  return null;
}

function parseMenuIndex(value) {
  const index = Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(index) || index < 0 || index > 9999) {
    return null;
  }
  return index;
}

function extractCommand(text) {
  const token = String(text ?? "").trim().split(/\s+/)[0] ?? "";
  if (!token.startsWith("/")) {
    return "";
  }
  return token.split("@")[0].toLowerCase();
}

function normalizeBotIdInput(value, suggested) {
  const raw = String(value ?? "").trim();
  if (!raw) {
    return null;
  }

  const normalized = raw.toLowerCase();
  if ((normalized === "default" || normalized === "auto") && suggested) {
    return suggested;
  }

  if (!BOT_ID_PATTERN.test(raw)) {
    return null;
  }

  return raw;
}

function suggestBotIdFromUsername(username) {
  const raw = String(username ?? "").trim().toLowerCase();
  if (!raw) {
    return null;
  }

  const candidate = raw.replace(/[^a-z0-9_-]/g, "_").replace(/^_+|_+$/g, "").slice(0, 64);
  if (!candidate || !BOT_ID_PATTERN.test(candidate)) {
    return null;
  }

  return candidate;
}

function buildTelegramAgentDefinition({ botId, token }) {
  const safeId = String(botId ?? "").trim();
  return {
    id: safeId,
    name: safeId,
    enabled: true,
    autoStart: true,
    threadMode: "single",
    sharedThreadId: `shared-${safeId}`,
    provider: {
      kind: "codex",
      options: {
        sandboxMode: "workspace-write",
        approvalPolicy: "on-request"
      }
    },
    channels: [
      {
        kind: "telegram",
        id: `telegram_${safeId}`,
        token: String(token ?? "").trim()
      }
    ],
    capabilities: []
  };
}

async function fetchBots() {
  const payload = await apiGet("/api/bots");
  const bots = Array.isArray(payload?.bots) ? payload.bots : [];
  return bots
    .filter((entry) => String(entry?.id ?? "").trim() !== "")
    .sort((a, b) => String(a.id ?? "").localeCompare(String(b.id ?? "")));
}

async function fetchBotById(botId) {
  const bots = await fetchBots();
  return bots.find((entry) => String(entry?.id ?? "").trim() === botId) ?? null;
}

async function editMessageOrReply(ctx, text, options = {}) {
  try {
    await ctx.editMessageText(text, options);
  } catch (error) {
    const message = sanitizeError(error).toLowerCase();
    if (message.includes("message is not modified")) {
      return;
    }

    await ctx.reply(text, options);
  }
}

function getChatId(ctx) {
  return String(ctx.chat?.id ?? ctx.callbackQuery?.message?.chat?.id ?? "").trim();
}

async function answerCallbackQuerySafe(ctx, text = "") {
  try {
    if (text) {
      await ctx.answerCallbackQuery({ text });
      return;
    }
    await ctx.answerCallbackQuery();
  } catch {
    // ignore
  }
}

async function apiGet(endpoint) {
  const response = await fetch(`${getEngineBaseUrl()}${endpoint}`, {
    method: "GET",
    headers: {
      Accept: "application/json"
    }
  });
  return parseJsonResponse(response);
}

async function apiPost(endpoint, body) {
  const response = await fetch(`${getEngineBaseUrl()}${endpoint}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json"
    },
    body: JSON.stringify(body ?? {})
  });
  return parseJsonResponse(response);
}

function getEngineBaseUrl() {
  const value = String(process.env.HUB_ENGINE_BASE_URL ?? "http://127.0.0.1:8787").trim();
  return value.replace(/\/+$/, "") || "http://127.0.0.1:8787";
}

async function parseJsonResponse(response) {
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    const detail = payload?.error ? `: ${payload.error}` : "";
    throw new Error(`HTTP ${response.status}${detail}`);
  }
  return payload;
}

async function verifyTelegramToken(token) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TELEGRAM_VERIFY_TIMEOUT_MS);

  try {
    const response = await fetch(`https://api.telegram.org/bot${token}/getMe`, {
      method: "GET",
      signal: controller.signal,
      headers: {
        Accept: "application/json"
      }
    });

    const payload = await response.json().catch(() => null);
    if (!response.ok || payload?.ok !== true || !payload?.result) {
      const reason = String(payload?.description ?? `HTTP ${response.status}`).trim();
      return {
        ok: false,
        error: reason || "Telegram getMe failed."
      };
    }

    return {
      ok: true,
      id: payload.result.id,
      username: String(payload.result.username ?? "").trim() || null
    };
  } catch (error) {
    const reason = sanitizeError(error);
    if (reason.toLowerCase().includes("aborted")) {
      return {
        ok: false,
        error: "Telegram verification timed out."
      };
    }

    return {
      ok: false,
      error: reason
    };
  } finally {
    clearTimeout(timer);
  }
}

function sanitizeError(error) {
  const raw = error instanceof Error ? error.message : String(error);
  return raw.split(/\r?\n/).slice(0, 6).join("\n");
}
