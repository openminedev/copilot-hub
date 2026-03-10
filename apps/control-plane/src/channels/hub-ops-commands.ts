import { randomBytes } from "node:crypto";
import { invalidateCodexQuotaUsageCache } from "./codex-quota-cache.js";
import {
  applyBotProviderPolicy,
  applyProviderPolicyToBots,
  applyRuntimeProviderPolicy,
  buildReasoningOptionsForModel,
  buildSessionModelOptions,
  fetchCodexModelOptions,
  formatFastModeLabel,
  formatModelButtonText,
  formatModelLabel,
  formatReasoningLabel,
  getBotPolicyState,
  getBotProviderSelection,
  getRuntimeProviderSelection,
  type ModelSelectionResult,
  type ProviderPolicyPatch,
  parseSetModelAllCommand,
  parseSetModelCommand,
  resolveModelSelectionFromAction,
  resolveReasoningSelectionFromAction,
  resolveSharedModel,
  resolveSharedReasoningEffort,
  resolveSharedServiceTier,
} from "./hub-model-utils.js";

type SandboxMode = "read-only" | "workspace-write" | "danger-full-access";
type ApprovalPolicy = "on-request" | "on-failure" | "never";

type PolicyProfileId = "safe" | "standard" | "semi_auto" | "full_auto";

type PolicyProfile = {
  id: PolicyProfileId;
  label: string;
  hint: string;
  sandboxMode: SandboxMode;
  approvalPolicy: ApprovalPolicy;
};

type ModelSelectionOption = ReturnType<typeof buildSessionModelOptions>[number];
type ReasoningSelectionOption = ReturnType<typeof buildReasoningOptionsForModel>[number];

type TelegramChat = {
  id?: string | number | null;
};

type TelegramMessage = {
  text?: string | null;
  message_id?: number | null;
  chat?: TelegramChat | null;
};

type TelegramCallbackMessage = {
  chat?: TelegramChat | null;
};

type TelegramCallbackQuery = {
  data?: string | null;
  message?: TelegramCallbackMessage | null;
};

type TelegramApi = {
  deleteMessage: (chatId: string | number, messageId: number) => Promise<unknown>;
};

type InlineKeyboardButton = {
  text: string;
  callback_data: string;
};

type ReplyOptions = {
  reply_markup?: {
    inline_keyboard: InlineKeyboardButton[][];
  };
};

type HubOpsContext = {
  message?: TelegramMessage | null;
  callbackQuery?: TelegramCallbackQuery | null;
  chat?: TelegramChat | null;
  api: TelegramApi;
  reply: (text: string, options?: ReplyOptions) => Promise<unknown>;
  editMessageText: (text: string, options?: ReplyOptions) => Promise<unknown>;
  answerCallbackQuery: (payload?: { text: string }) => Promise<unknown>;
};

type HubRuntimeInfo = {
  runtimeId?: string | null;
  runtimeName?: string | null;
  refreshProviderSession?: (reason?: string) => Promise<unknown>;
  getProviderOptions?: () => unknown;
  setProviderOptions?: (payload: Record<string, unknown>) => Promise<unknown>;
};

type MenuSession = {
  chatId: string;
  createdAt: number;
  botIds: string[];
  modelOptions: ModelSelectionOption[];
  reasoningOptions: ReasoningSelectionOption[];
  pendingProviderPatch: ProviderPolicyPatch | null;
  pendingFlow: "model_reasoning" | "speed" | null;
  pendingSummary: {
    modelLabel: string | null;
    reasoningLabel: string | null;
    speedLabel: string | null;
  };
};

type TelegramVerificationFailure = {
  ok: false;
  error: string;
};

type TelegramVerificationSuccess = {
  ok: true;
  id: number;
  username: string | null;
};

type TelegramVerificationResult = TelegramVerificationFailure | TelegramVerificationSuccess;

type CreateFlow = {
  createdAt: number;
  step: "token" | "bot_id" | "confirm";
  token: string | null;
  tokenInfo: TelegramVerificationSuccess | null;
  botId: string | null;
};

type CodexSwitchFlow = {
  createdAt: number;
  step: "api_key";
};

type BotState = {
  id: string;
  running: boolean;
  telegramRunning: boolean;
  provider?: {
    options?: Record<string, unknown>;
  } | null;
};

type HubOpsMenuAction =
  | { type: "back" }
  | { type: "create" }
  | { type: "refresh"; sessionId: string }
  | { type: "agents_home"; sessionId: string }
  | { type: "global_model_open"; sessionId: string }
  | { type: "global_fast_open"; sessionId: string }
  | { type: "global_model"; sessionId: string; profileId: string }
  | { type: "global_fast_apply"; sessionId: string; profileId: string }
  | { type: "global_reasoning_apply"; sessionId: string; modelProfileId: string; profileId: string }
  | { type: "target_choice"; sessionId: string; profileId: string }
  | { type: "target_agent_apply"; sessionId: string; index: number }
  | {
      type: "open" | "reset_ask" | "reset_confirm" | "delete_ask" | "delete_confirm";
      sessionId: string;
      index: number;
    }
  | { type: "policy"; sessionId: string; index: number; profileId: string };

type HealthResponse = {
  ok?: boolean;
  service?: string;
  botCount?: number;
  webPort?: string | number;
};

type CodexStatusResponse = {
  configured?: boolean;
  codexBin?: string;
  detail?: string;
  deviceAuth?: {
    status?: string;
    code?: string;
    loginUrl?: string;
    detail?: string;
    refreshedBots?: string[];
    refreshFailures?: unknown[];
    restartedBots?: string[];
    restartFailures?: unknown[];
  };
};

type DeviceAuthStartResponse = {
  status?: string;
  loginUrl?: string;
  code?: string;
};

type DeviceAuthCancelResponse = {
  canceled?: boolean;
};

type CreateBotResponse = {
  bot?: {
    id?: string;
  };
};

type CodexSwitchApiKeyResponse = {
  detail?: string;
  refreshedBots?: string[];
  refreshFailures?: unknown[];
  restartedBots?: string[];
  restartFailures?: unknown[];
};

type BotListResponse = {
  bots?: unknown[];
};

const MENU_TTL_MS = 15 * 60 * 1000;
const FLOW_TTL_MS = 10 * 60 * 1000;
const TELEGRAM_VERIFY_TIMEOUT_MS = 10_000;
const CODEX_LOGIN_WATCH_TIMEOUT_MS = 5 * 60 * 1000;
const CODEX_LOGIN_WATCH_POLL_MS = 2_500;

const BOT_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const TELEGRAM_TOKEN_PATTERN = /^\d{5,}:[A-Za-z0-9_-]{20,}$/;

const menuSessions = new Map<string, MenuSession>();
const createFlows = new Map<string, CreateFlow>();
const codexSwitchFlows = new Map<string, CodexSwitchFlow>();
const codexLoginWatchers = new Map<
  string,
  {
    token: string;
    startedAt: number;
  }
>();

const POLICY_PROFILES: Record<PolicyProfileId, PolicyProfile> = {
  safe: {
    id: "safe",
    label: "Safe",
    hint: "read-only + approval prompts",
    sandboxMode: "read-only",
    approvalPolicy: "on-request",
  },
  standard: {
    id: "standard",
    label: "Standard",
    hint: "workspace write + approval prompts",
    sandboxMode: "workspace-write",
    approvalPolicy: "on-request",
  },
  semi_auto: {
    id: "semi_auto",
    label: "Semi Auto",
    hint: "workspace write + ask on failures",
    sandboxMode: "workspace-write",
    approvalPolicy: "on-failure",
  },
  full_auto: {
    id: "full_auto",
    label: "Full",
    hint: "no approval prompts",
    sandboxMode: "danger-full-access",
    approvalPolicy: "never",
  },
};

export async function maybeHandleHubOpsCommand({
  ctx,
  runtime,
  channelId,
}: {
  ctx: HubOpsContext;
  runtime?: HubRuntimeInfo | null;
  channelId?: string | null;
}): Promise<boolean> {
  const text = String(ctx.message?.text ?? "").trim();
  const command = extractCommand(text);
  if (!command) {
    return false;
  }

  cleanupState();

  const chatId = getChatId(ctx);
  const flowKey = buildFlowKey(runtime?.runtimeId, channelId, chatId);
  try {
    if (command === "/start" || command === "/help") {
      await ctx.reply(buildHelpText(runtime?.runtimeName));
      return true;
    }

    if (command === "/health") {
      try {
        const health = await apiGet<HealthResponse>("/api/health");
        await ctx.reply(
          [
            "Engine health:",
            `ok: ${Boolean(health?.ok)}`,
            `service: ${String(health?.service ?? "-")}`,
            `botCount: ${Number(health?.botCount ?? 0)}`,
            `webPort: ${String(health?.webPort ?? "-")}`,
          ].join("\n"),
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

    if (command === "/codex_status") {
      try {
        const status = await apiGet<CodexStatusResponse>("/api/system/codex/status");
        const deviceAuth = status?.deviceAuth ?? {};
        const deviceStatus = String(deviceAuth?.status ?? "idle");
        await ctx.reply(
          [
            "Codex account:",
            `configured: ${status?.configured ? "yes" : "no"}`,
            `binary: ${String(status?.codexBin ?? "-")}`,
            status?.detail ? `detail: ${String(status.detail)}` : "",
            `deviceAuth: ${deviceStatus}`,
            deviceAuth?.code ? `code: ${String(deviceAuth.code)}` : "",
            deviceAuth?.loginUrl ? `link: ${String(deviceAuth.loginUrl)}` : "",
            deviceAuth?.detail ? `deviceDetail: ${String(deviceAuth.detail)}` : "",
          ]
            .filter(Boolean)
            .join("\n"),
        );
      } catch (error) {
        await ctx.reply(`Codex status failed: ${sanitizeError(error)}`);
      }
      return true;
    }

    if (command === "/codex_login" || command === "/codex_switch") {
      try {
        clearCodexLoginWatcher(flowKey);
        const response = await apiPost<DeviceAuthStartResponse>(
          "/api/system/codex/device_auth/start",
          {},
        );
        const statusLabel = String(response?.status ?? "pending");
        const loginUrl = String(response?.loginUrl ?? "").trim();
        const code = String(response?.code ?? "").trim();
        if (!loginUrl || !code) {
          await ctx.reply(
            "Codex login flow started, but code details were not ready yet. Retry /codex_login.",
          );
          return true;
        }

        await ctx.reply(
          [
            `Codex login flow: ${statusLabel}`,
            `1) Open: ${loginUrl}`,
            `2) Enter code: ${code}`,
            "3) Finish sign-in on your phone",
            "Copilot Hub will apply the new account automatically when login succeeds.",
            "Use /cancel to abort this login flow.",
          ].join("\n"),
        );
        const watcherToken = startCodexLoginWatcher(flowKey);
        void watchCodexLoginCompletion({
          ctx,
          runtime,
          flowKey,
          watcherToken,
        });
      } catch (error) {
        await ctx.reply(`Codex login start failed: ${sanitizeError(error)}`);
      }
      return true;
    }

    if (command === "/codex_switch_key") {
      if (createFlows.has(flowKey) || codexSwitchFlows.has(flowKey)) {
        await ctx.reply("Another operation is active. Send /cancel first.");
        return true;
      }

      codexSwitchFlows.set(flowKey, {
        createdAt: Date.now(),
        step: "api_key",
      });

      await ctx.reply(
        [
          "Codex account switch started.",
          "Send your Codex API key now (example: sk-...).",
          "Running agents will restart automatically after successful switch.",
          "Use /cancel to stop.",
        ].join("\n"),
      );
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
        botId: null,
      });

      await ctx.reply(
        [
          "Create agent wizard started.",
          "Step 1: send Telegram bot token.",
          "Format: 123456789:ABC...",
          "Use /cancel to stop.",
        ].join("\n"),
      );
      return true;
    }

    if (command === "/set_model") {
      const tokenCount = String(text ?? "")
        .trim()
        .split(/\s+/)
        .filter(Boolean).length;
      if (tokenCount <= 1) {
        await renderGlobalModelMenu(ctx, { editMessage: false, runtime: runtime ?? null });
        return true;
      }

      const parsed = parseSetModelCommand(text, BOT_ID_PATTERN);
      if (!parsed.ok) {
        await renderGlobalModelMenu(ctx, {
          editMessage: false,
          runtime: runtime ?? null,
          notice: "Choose a model first, then the target.",
        });
        return true;
      }

      const botState = await fetchBotById(parsed.botId);
      if (!botState) {
        await ctx.reply(`Agent '${parsed.botId}' not found.`);
        return true;
      }

      await applyBotProviderPolicy({
        apiPost,
        botId: parsed.botId,
        botState,
        patch: {
          model: parsed.model,
          reasoningEffort: null,
        },
      });

      const modelLabel = parsed.model ? parsed.model : "auto (workspace default)";
      await ctx.reply(
        [
          `Model updated for '${parsed.botId}': ${modelLabel}`,
          "Reasoning reset to the model default.",
          "Change applies on next message while preserving conversation history.",
        ].join("\n"),
      );
      return true;
    }

    if (command === "/set_model_all") {
      const tokenCount = String(text ?? "")
        .trim()
        .split(/\s+/)
        .filter(Boolean).length;
      if (tokenCount <= 1) {
        await renderGlobalModelMenu(ctx, { editMessage: false, runtime: runtime ?? null });
        return true;
      }

      const parsed = parseSetModelAllCommand(text);
      if (!parsed.ok) {
        await ctx.reply(parsed.error);
        return true;
      }

      const bots = await fetchBots();
      const result = await applyGlobalProviderSelection({
        bots,
        patch: {
          model: parsed.model,
          reasoningEffort: null,
        },
        runtime: runtime ?? null,
      });
      if (result.totalTargets === 0) {
        await ctx.reply("No agents found and hub model control is unavailable.");
        return true;
      }

      const modelLabel = parsed.model ? parsed.model : "auto (workspace default)";
      const lines = buildGlobalModelUpdateLines({
        modelLabel,
        reasoningLabel: "Default",
        result,
      });
      lines.push("Change applies on next message while preserving conversation history.");
      await ctx.reply(lines.join("\n"));
      return true;
    }

    if (command === "/cancel") {
      const createDeleted = createFlows.delete(flowKey);
      const switchDeleted = codexSwitchFlows.delete(flowKey);
      const loginWatcherCanceled = clearCodexLoginWatcher(flowKey);
      let remoteCanceled = false;
      try {
        const canceled = await apiPost<DeviceAuthCancelResponse>(
          "/api/system/codex/device_auth/cancel",
          {},
        );
        remoteCanceled = canceled?.canceled === true;
      } catch {
        remoteCanceled = false;
      }
      await ctx.reply(
        createDeleted || switchDeleted || remoteCanceled || loginWatcherCanceled
          ? "Current operation canceled."
          : "No active operation.",
      );
      return true;
    }

    return false;
  } catch (error) {
    await ctx.reply(`Command failed: ${sanitizeError(error)}`);
    return true;
  }
}

export async function maybeHandleHubOpsFollowUp({
  ctx,
  runtime,
  channelId,
}: {
  ctx: HubOpsContext;
  runtime?: HubRuntimeInfo | null;
  channelId?: string | null;
}): Promise<boolean> {
  cleanupState();

  const text = String(ctx.message?.text ?? "").trim();
  if (!text || text.startsWith("/")) {
    return false;
  }

  const chatId = getChatId(ctx);
  const flowKey = buildFlowKey(runtime?.runtimeId, channelId, chatId);
  const codexFlow = codexSwitchFlows.get(flowKey);
  if (codexFlow) {
    const handled = await handleCodexSwitchFlow({
      ctx,
      flowKey,
      flow: codexFlow,
      text,
      runtime: runtime ?? null,
    });
    if (handled) {
      return true;
    }
  }

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
    const suggestionText = suggestedBotId
      ? `Suggested id: ${suggestedBotId}`
      : "Suggested id: (none)";

    await ctx.reply(
      [
        `Token valid for @${verification.username || "unknown"}.`,
        suggestionText,
        "Step 2: send agent id (letters/numbers/_/-).",
        "You can also send: default",
      ].join("\n"),
    );
    return true;
  }

  if (flow.step === "bot_id") {
    const suggestedBotId = suggestBotIdFromUsername(flow.tokenInfo?.username ?? null);
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
        "Default policy after create: Full (no approval prompts).",
        "Agent actions start from its own workspace folder.",
        "Reply YES to create, or NO to cancel.",
      ].join("\n"),
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
      const result = await apiPost<CreateBotResponse>("/api/bots/create", {
        agent: buildTelegramAgentDefinition({
          botId: flow.botId,
          token: flow.token,
        }),
        startIfEnabled: true,
      });

      createFlows.delete(flowKey);
      await ctx.reply(
        [
          `Agent created: ${String(result?.bot?.id ?? flow.botId)}`,
          "Use /bots to manage policy, reset context, or delete.",
        ].join("\n"),
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

async function handleCodexSwitchFlow({
  ctx,
  flowKey,
  flow,
  text,
  runtime,
}: {
  ctx: HubOpsContext;
  flowKey: string;
  flow: CodexSwitchFlow;
  text: string;
  runtime?: HubRuntimeInfo | null;
}): Promise<boolean> {
  if (flow.step !== "api_key") {
    codexSwitchFlows.delete(flowKey);
    await ctx.reply("Flow reset. Use /codex_switch_key to start again.");
    return true;
  }

  const apiKey = String(text ?? "").trim();
  if (!looksLikeCodexApiKey(apiKey)) {
    await ctx.reply("Invalid API key format. Send a key starting with 'sk-' or /cancel.");
    return true;
  }

  await maybeDeleteIncomingMessage(ctx);

  try {
    const result = await apiPost<CodexSwitchApiKeyResponse>("/api/system/codex/switch_api_key", {
      apiKey,
    });
    codexSwitchFlows.delete(flowKey);
    const refreshMessage = await refreshHubProviderAfterCodexLogin(runtime);

    const refreshedBots = readRefreshedBotIds(result);
    const refreshFailures = readRefreshFailures(result);

    const lines = ["Codex account switched successfully.", refreshMessage];
    if (result?.detail) {
      lines.push(`status: ${String(result.detail)}`);
    }

    if (refreshedBots.length > 0) {
      lines.push(`Agents refreshed: ${refreshedBots.join(", ")}`);
    } else {
      lines.push("No running agents needed refresh.");
    }

    if (refreshFailures.length > 0) {
      lines.push(
        `Refresh warnings: ${refreshFailures.length}. Use /health then /bots to verify state.`,
      );
    }

    await ctx.reply(lines.join("\n"));
    return true;
  } catch (error) {
    await ctx.reply(`Codex switch failed:\n${sanitizeError(error)}\nRetry or /cancel.`);
    return true;
  }
}

export async function maybeHandleHubOpsCallback({
  ctx,
  runtime,
}: {
  ctx: HubOpsContext;
  runtime?: HubRuntimeInfo | null;
}): Promise<boolean> {
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

    if (action.type === "agents_home") {
      await renderAgentsMenu(ctx, {
        sessionId: action.sessionId,
        editMessage: true,
      });
      await answerCallbackQuerySafe(ctx);
      return true;
    }

    if (action.type === "global_model_open") {
      await renderGlobalModelMenu(ctx, {
        sessionId: action.sessionId,
        editMessage: true,
        runtime: runtime ?? null,
      });
      await answerCallbackQuerySafe(ctx);
      return true;
    }

    if (action.type === "global_fast_open") {
      await renderGlobalFastMenu(ctx, {
        sessionId: action.sessionId,
        editMessage: true,
        runtime: runtime ?? null,
      });
      await answerCallbackQuerySafe(ctx);
      return true;
    }

    if (action.type === "target_choice") {
      const session = getMenuSession(action.sessionId, ctx);
      if (!session || !session.pendingProviderPatch || !session.pendingFlow) {
        await renderBotsMenu(ctx, {
          editMessage: true,
          notice: "Selection expired. Open the menu again.",
        });
        await answerCallbackQuerySafe(ctx, "Selection expired");
        return true;
      }

      if (action.profileId === "single") {
        await renderProviderTargetAgentMenu(ctx, {
          sessionId: action.sessionId,
          editMessage: true,
        });
        await answerCallbackQuerySafe(ctx);
        return true;
      }

      if (action.profileId === "all" || action.profileId === "all_hub") {
        const bots = await fetchBots();
        const result = await applyGlobalProviderSelection({
          bots,
          patch: session.pendingProviderPatch,
          runtime: action.profileId === "all_hub" ? (runtime ?? null) : null,
        });
        const lines =
          session.pendingFlow === "speed"
            ? buildGlobalFastUpdateLines({
                fastLabel: session.pendingSummary.speedLabel ?? "Standard",
                result,
              })
            : buildGlobalModelUpdateLines({
                modelLabel: session.pendingSummary.modelLabel ?? "auto (workspace default)",
                reasoningLabel: session.pendingSummary.reasoningLabel ?? "Default",
                result,
              });
        lines.push(
          session.pendingFlow === "speed"
            ? "Speed changes apply on next message."
            : "Change applies on next message while preserving conversation history.",
        );
        clearPendingProviderSelection(session);
        menuSessions.set(action.sessionId, session);
        await renderBotsMenu(ctx, {
          editMessage: true,
          notice: lines.join("\n"),
        });
        await answerCallbackQuerySafe(ctx, "Updated");
        return true;
      }

      await answerCallbackQuerySafe(ctx, "Invalid target");
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

    if (action.type === "global_model") {
      const selection = resolveModelSelectionFromAction({
        session,
        profileId: action.profileId,
      });
      if (!selection.ok) {
        await renderGlobalModelMenu(ctx, {
          sessionId: action.sessionId,
          editMessage: true,
          runtime: runtime ?? null,
          notice: "Model menu expired. Open Model & Reasoning again.",
        });
        await answerCallbackQuerySafe(ctx, "Model menu expired");
        return true;
      }

      if (selection.model) {
        await renderGlobalReasoningMenu(ctx, {
          sessionId: action.sessionId,
          runtime: runtime ?? null,
          modelSelection: selection,
        });
        await answerCallbackQuerySafe(ctx);
        return true;
      }

      setPendingProviderSelection(session, {
        patch: {
          model: null,
          reasoningEffort: null,
        },
        flow: "model_reasoning",
        modelLabel: selection.label,
        reasoningLabel: "Default",
      });
      menuSessions.set(action.sessionId, session);
      await renderProviderTargetMenu(ctx, {
        sessionId: action.sessionId,
        editMessage: true,
        runtime: runtime ?? null,
      });
      await answerCallbackQuerySafe(ctx);
      return true;
    }

    if (action.type === "global_reasoning_apply") {
      const modelSelection = resolveModelSelectionFromAction({
        session,
        profileId: action.modelProfileId,
      });
      if (!modelSelection.ok || !modelSelection.model) {
        await renderGlobalModelMenu(ctx, {
          sessionId: action.sessionId,
          editMessage: true,
          runtime: runtime ?? null,
          notice: "Model menu expired. Open Model & Reasoning again.",
        });
        await answerCallbackQuerySafe(ctx, "Model menu expired");
        return true;
      }

      const reasoningOptions = buildReasoningOptionsForModel({
        modelSelection,
      });
      const reasoningSelection = resolveReasoningSelectionFromAction({
        options: reasoningOptions,
        profileId: action.profileId,
      });
      if (!reasoningSelection.ok) {
        await renderGlobalReasoningMenu(ctx, {
          sessionId: action.sessionId,
          runtime: runtime ?? null,
          modelSelection,
          notice: "Reasoning options expired. Choose the model again.",
        });
        await answerCallbackQuerySafe(ctx, "Reasoning menu expired");
        return true;
      }

      setPendingProviderSelection(session, {
        patch: {
          model: modelSelection.model,
          reasoningEffort: reasoningSelection.reasoningEffort,
        },
        flow: "model_reasoning",
        modelLabel: modelSelection.label,
        reasoningLabel: reasoningSelection.label,
      });
      menuSessions.set(action.sessionId, session);
      await renderProviderTargetMenu(ctx, {
        sessionId: action.sessionId,
        editMessage: true,
        runtime: runtime ?? null,
      });
      await answerCallbackQuerySafe(ctx);
      return true;
    }

    if (action.type === "global_fast_apply") {
      setPendingProviderSelection(session, {
        patch: {
          serviceTier: action.profileId === "fast" ? "fast" : null,
        },
        flow: "speed",
        speedLabel: action.profileId === "fast" ? "Fast" : "Standard",
      });
      menuSessions.set(action.sessionId, session);
      await renderProviderTargetMenu(ctx, {
        sessionId: action.sessionId,
        editMessage: true,
        runtime: runtime ?? null,
      });
      await answerCallbackQuerySafe(ctx);
      return true;
    }

    const botId = getBotIdFromSession(session, action.index);
    if (!botId) {
      await renderBotsMenu(ctx, { editMessage: true });
      await answerCallbackQuerySafe(ctx, "Agent not found. Refreshed.");
      return true;
    }

    if (action.type === "target_agent_apply") {
      if (!session.pendingProviderPatch || !session.pendingFlow) {
        await renderBotsMenu(ctx, {
          editMessage: true,
          notice: "Selection expired. Open the menu again.",
        });
        await answerCallbackQuerySafe(ctx, "Selection expired");
        return true;
      }

      const botState = await fetchBotById(botId);
      if (!botState) {
        await renderAgentsMenu(ctx, {
          sessionId: action.sessionId,
          editMessage: true,
          notice: `Agent '${botId}' not found.`,
        });
        await answerCallbackQuerySafe(ctx, "Agent not found");
        return true;
      }

      await applyBotProviderPolicy({
        apiPost,
        botId,
        botState,
        patch: session.pendingProviderPatch,
      });

      const notice =
        session.pendingFlow === "speed"
          ? `Speed updated for '${botId}': ${session.pendingSummary.speedLabel ?? "Standard"}`
          : `Model updated for '${botId}': ${session.pendingSummary.modelLabel ?? "auto"} / ${
              session.pendingSummary.reasoningLabel ?? "Default"
            }`;
      clearPendingProviderSelection(session);
      menuSessions.set(action.sessionId, session);
      await renderBotsMenu(ctx, {
        editMessage: true,
        notice,
      });
      await answerCallbackQuerySafe(ctx, "Updated");
      return true;
    }

    if (action.type === "open") {
      await renderBotActions(ctx, {
        sessionId: action.sessionId,
        index: action.index,
      });
      await answerCallbackQuerySafe(ctx);
      return true;
    }

    if (action.type === "policy") {
      if (!isPolicyProfileId(action.profileId)) {
        await answerCallbackQuerySafe(ctx, "Invalid profile.");
        return true;
      }
      const profile = POLICY_PROFILES[action.profileId];
      if (!profile) {
        await answerCallbackQuerySafe(ctx, "Invalid profile.");
        return true;
      }

      await apiPost(`/api/bots/${encodeURIComponent(botId)}/policy`, {
        sandboxMode: profile.sandboxMode,
        approvalPolicy: profile.approvalPolicy,
      });

      await renderBotActions(ctx, {
        sessionId: action.sessionId,
        index: action.index,
        notice: `Policy updated: ${profile.label} (${profile.hint})`,
      });
      await answerCallbackQuerySafe(ctx, "Policy updated");
      return true;
    }

    if (action.type === "reset_ask") {
      await renderResetConfirm(ctx, {
        sessionId: action.sessionId,
        index: action.index,
        botId,
      });
      await answerCallbackQuerySafe(ctx);
      return true;
    }

    if (action.type === "reset_confirm") {
      await apiPost(`/api/bots/${encodeURIComponent(botId)}/reset`, {});
      await renderBotActions(ctx, {
        sessionId: action.sessionId,
        index: action.index,
        notice: "Context reset completed.",
      });
      await answerCallbackQuerySafe(ctx, "Context reset");
      return true;
    }

    if (action.type === "delete_ask") {
      await renderDeleteConfirm(ctx, {
        sessionId: action.sessionId,
        index: action.index,
        botId,
      });
      await answerCallbackQuerySafe(ctx);
      return true;
    }

    if (action.type === "delete_confirm") {
      await apiPost(`/api/bots/${encodeURIComponent(botId)}/delete`, { deleteMode: "soft" });
      await renderAgentsMenu(ctx, {
        sessionId: action.sessionId,
        editMessage: true,
        notice: `Agent deleted: ${botId}`,
      });
      await answerCallbackQuerySafe(ctx, "Agent deleted");
      return true;
    }

    await answerCallbackQuerySafe(ctx);
    return true;
  } catch (error) {
    await answerCallbackQuerySafe(ctx, "Action failed");
    await editMessageOrReply(ctx, `Action failed:\n${sanitizeError(error)}`, {
      reply_markup: {
        inline_keyboard: [[{ text: "Back to menu", callback_data: "hub:back" }]],
      },
    });
    return true;
  }
}

function buildHelpText(runtimeName: string | null | undefined): string {
  return [
    `${String(runtimeName ?? "Copilot Hub")}`,
    "",
    "Commands:",
    "/bots",
    "/health",
    "/create_agent",
    "/codex_status",
    "/codex_login",
    "/codex_switch_key",
    "/set_model",
    "/cancel",
    "",
    "/bots: open the main control menu",
    "/set_model: open Model & Reasoning directly",
    "/codex_login: switch account with device code",
    "/codex_switch_key: switch account with API key",
    "",
    "Use /bots for:",
    "Agents",
    "Model & Reasoning",
    "Speed",
    "Create agent",
  ].join("\n");
}

function buildFlowKey(
  runtimeId: string | null | undefined,
  channelId: string | null | undefined,
  chatId: string,
): string {
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

  for (const [key, flow] of codexSwitchFlows.entries()) {
    const createdAt = Number(flow?.createdAt ?? 0);
    if (!Number.isFinite(createdAt) || now - createdAt > FLOW_TTL_MS) {
      codexSwitchFlows.delete(key);
    }
  }

  for (const [key, watcher] of codexLoginWatchers.entries()) {
    const startedAt = Number(watcher?.startedAt ?? 0);
    if (!Number.isFinite(startedAt) || now - startedAt > CODEX_LOGIN_WATCH_TIMEOUT_MS * 2) {
      codexLoginWatchers.delete(key);
    }
  }
}

async function renderBotsMenu(
  ctx: HubOpsContext,
  { editMessage = false, notice = "" }: { editMessage?: boolean; notice?: string } = {},
): Promise<void> {
  const bots = await fetchBots();
  const chatId = getChatId(ctx);
  const sessionId = createMenuSession(chatId, bots);

  const lines = [];
  if (notice) {
    lines.push(notice, "");
  }
  lines.push("Control menu:");
  lines.push(`agents: ${bots.length}`);
  if (bots.length > 0) {
    const runningCount = bots.filter((bot) => bot.running).length;
    lines.push(`running: ${runningCount}/${bots.length}`);
  }
  lines.push("", "Choose a section:");

  const keyboard = buildBotsMenuKeyboard(sessionId, bots);

  if (editMessage) {
    await editMessageOrReply(ctx, lines.join("\n"), {
      reply_markup: {
        inline_keyboard: keyboard,
      },
    });
    return;
  }

  await ctx.reply(lines.join("\n"), {
    reply_markup: {
      inline_keyboard: keyboard,
    },
  });
}

async function renderAgentsMenu(
  ctx: HubOpsContext,
  {
    sessionId = "",
    editMessage = false,
    notice = "",
  }: { sessionId?: string; editMessage?: boolean; notice?: string } = {},
): Promise<void> {
  const bots = await fetchBots();
  const chatId = getChatId(ctx);
  const activeSessionId = sessionId || createMenuSession(chatId, bots);
  const session = getMenuSession(activeSessionId, ctx);
  if (!session) {
    await renderBotsMenu(ctx, {
      editMessage,
      notice: "Menu expired. Open /bots again.",
    });
    return;
  }
  session.botIds = bots.map((entry) => String(entry?.id ?? "").trim()).filter(Boolean);
  clearPendingProviderSelection(session);
  menuSessions.set(activeSessionId, session);

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
    lines.push("", "Choose an agent:");
  }

  const keyboard = buildAgentsMenuKeyboard(activeSessionId, bots);

  if (editMessage) {
    await editMessageOrReply(ctx, lines.join("\n"), {
      reply_markup: {
        inline_keyboard: keyboard,
      },
    });
    return;
  }

  await ctx.reply(lines.join("\n"), {
    reply_markup: {
      inline_keyboard: keyboard,
    },
  });
}

async function renderBotActions(
  ctx: HubOpsContext,
  { sessionId, index, notice = "" }: { sessionId: string; index: number; notice?: string },
): Promise<void> {
  const session = getMenuSession(sessionId, ctx);
  const botId = getBotIdFromSession(session, index);
  if (!botId) {
    await renderAgentsMenu(ctx, {
      sessionId,
      editMessage: true,
      notice: "Agent not found. Refreshed.",
    });
    return;
  }

  const botState = await fetchBotById(botId);
  if (!botState) {
    await renderAgentsMenu(ctx, {
      sessionId,
      editMessage: true,
      notice: `Agent '${botId}' not found.`,
    });
    return;
  }

  const providerSelection = getBotProviderSelection(botState);
  const botPolicyState = getBotPolicyState(botState);
  if (session) {
    clearPendingProviderSelection(session);
    menuSessions.set(sessionId, session);
  }

  const lines = [];
  if (notice) {
    lines.push(notice, "");
  }
  lines.push(
    `Agent: ${botState.id}`,
    `running: ${botState.running ? "yes" : "no"}`,
    `telegram: ${botState.telegramRunning ? "yes" : "no"}`,
    `sandboxMode: ${botPolicyState.sandboxMode}`,
    `approvalPolicy: ${botPolicyState.approvalPolicy}`,
    `model: ${formatModelLabel(providerSelection.model)}`,
    `reasoning: ${formatReasoningLabel(providerSelection.reasoningEffort)}`,
    `speed: ${formatFastModeLabel(providerSelection.serviceTier)}`,
    "",
    "Policy quick guide:",
    "Safe = read-only + approval prompts",
    "Standard = workspace write + approval prompts",
    "Semi Auto = workspace write + ask on failures",
    "Full = no approval prompts",
    "All actions start from this agent workspace.",
    "Use the main menu for Model & Reasoning and Speed.",
    "",
    "Choose an action:",
  );

  await editMessageOrReply(ctx, lines.join("\n"), {
    reply_markup: {
      inline_keyboard: buildBotActionsKeyboard(sessionId, index),
    },
  });
}

async function renderResetConfirm(
  ctx: HubOpsContext,
  { sessionId, index, botId }: { sessionId: string; index: number; botId: string },
): Promise<void> {
  await editMessageOrReply(
    ctx,
    [`Reset context for '${botId}'?`, "This clears the current web thread context."].join("\n"),
    {
      reply_markup: {
        inline_keyboard: [
          [
            { text: "Confirm reset", callback_data: `hub:rc:${sessionId}:${index}` },
            { text: "Cancel", callback_data: `hub:o:${sessionId}:${index}` },
          ],
          [{ text: "Back to agents", callback_data: `hub:ag:${sessionId}` }],
        ],
      },
    },
  );
}

async function renderDeleteConfirm(
  ctx: HubOpsContext,
  { sessionId, index, botId }: { sessionId: string; index: number; botId: string },
): Promise<void> {
  await editMessageOrReply(
    ctx,
    [`Delete agent '${botId}'?`, "This stops and removes the agent from runtime."].join("\n"),
    {
      reply_markup: {
        inline_keyboard: [
          [
            { text: "Confirm delete", callback_data: `hub:dc:${sessionId}:${index}` },
            { text: "Cancel", callback_data: `hub:o:${sessionId}:${index}` },
          ],
          [{ text: "Back to agents", callback_data: `hub:ag:${sessionId}` }],
        ],
      },
    },
  );
}

function buildBotsMenuKeyboard(sessionId: string, bots: BotState[]): InlineKeyboardButton[][] {
  const hasBots = bots.length > 0;
  return [
    [{ text: "Agents", callback_data: `hub:ag:${sessionId}` }],
    [{ text: "Model & Reasoning", callback_data: `hub:ga:${sessionId}` }],
    [{ text: "Speed", callback_data: `hub:gf:${sessionId}` }],
    [{ text: "Create agent", callback_data: "hub:create" }],
    ...(hasBots ? [[{ text: "Refresh", callback_data: `hub:r:${sessionId}` }]] : []),
  ];
}

function buildAgentsMenuKeyboard(sessionId: string, bots: BotState[]): InlineKeyboardButton[][] {
  const rows: InlineKeyboardButton[][] = [];

  for (let index = 0; index < bots.length; index += 1) {
    const botState = bots[index];
    if (!botState) {
      continue;
    }
    const status = botState.running ? "ON" : "OFF";
    rows.push([
      { text: `${botState.id} (${status})`, callback_data: `hub:o:${sessionId}:${index}` },
    ]);
  }

  rows.push([{ text: "Refresh", callback_data: `hub:ag:${sessionId}` }]);
  rows.push([{ text: "Back to menu", callback_data: "hub:back" }]);
  return rows;
}

async function renderGlobalModelMenu(
  ctx: HubOpsContext,
  {
    sessionId = "",
    editMessage = false,
    runtime = null,
    notice = "",
  }: {
    sessionId?: string;
    editMessage?: boolean;
    runtime?: HubRuntimeInfo | null;
    notice?: string;
  } = {},
): Promise<void> {
  const bots = await fetchBots();
  const hubIncluded = isHubModelControlAvailable(runtime);
  if (bots.length === 0 && !hubIncluded) {
    await renderBotsMenu(ctx, {
      editMessage,
      notice: notice || "No agents found.",
    });
    return;
  }

  const chatId = getChatId(ctx);
  const activeSessionId = sessionId || createMenuSession(chatId, bots);
  const session = getMenuSession(activeSessionId, ctx);
  if (!session) {
    await renderBotsMenu(ctx, {
      editMessage,
      notice: "Menu expired. Open Model & Reasoning again.",
    });
    return;
  }

  const sharedModel = resolveSharedModelForGlobalTargets(bots, runtime);
  const modelCatalog = await fetchCodexModelOptions(apiGet);
  const currentModel = sharedModel.mode === "uniform" ? (sharedModel.model ?? "") : "__mixed__";
  const modelOptions = buildSessionModelOptions({
    catalog: modelCatalog.models,
    currentModel,
  });
  clearPendingProviderSelection(session);
  session.modelOptions = modelOptions;
  session.reasoningOptions = [];
  menuSessions.set(activeSessionId, session);

  const lines = [];
  if (notice) {
    lines.push(notice, "");
  }
  lines.push("Model & Reasoning:");
  lines.push(`agents: ${bots.length}`);
  lines.push(`hub available: ${hubIncluded ? "yes" : "no"}`);
  lines.push(
    `current model: ${
      sharedModel.mode === "uniform" ? formatModelLabel(sharedModel.model) : "mixed"
    }`,
  );
  lines.push(
    modelCatalog.available
      ? `available models: ${modelCatalog.models.length}`
      : "available models: unavailable right now",
  );
  lines.push("", "Choose a model:");

  const keyboard = buildGlobalModelKeyboard(activeSessionId, {
    modelOptions,
    currentModel,
    hasMixedSelection: sharedModel.mode === "mixed",
  });

  if (editMessage) {
    await editMessageOrReply(ctx, lines.join("\n"), {
      reply_markup: {
        inline_keyboard: keyboard,
      },
    });
    return;
  }

  await ctx.reply(lines.join("\n"), {
    reply_markup: {
      inline_keyboard: keyboard,
    },
  });
}

async function renderGlobalReasoningMenu(
  ctx: HubOpsContext,
  {
    sessionId,
    runtime = null,
    modelSelection,
    editMessage = true,
    notice = "",
  }: {
    sessionId: string;
    runtime?: HubRuntimeInfo | null;
    modelSelection: ModelSelectionResult;
    editMessage?: boolean;
    notice?: string;
  },
): Promise<void> {
  const bots = await fetchBots();
  const hubIncluded = isHubModelControlAvailable(runtime);
  if (bots.length === 0 && !hubIncluded) {
    await renderBotsMenu(ctx, {
      editMessage,
      notice: notice || "No agents found.",
    });
    return;
  }

  const session = getMenuSession(sessionId, ctx);
  if (!session) {
    await renderBotsMenu(ctx, {
      editMessage,
      notice: "Menu expired. Open Model & Reasoning again.",
    });
    return;
  }

  const sharedReasoning = resolveSharedReasoningForGlobalTargets(bots, runtime);
  const currentModel = resolveSharedModelForGlobalTargets(bots, runtime);
  const reasoningOptions = buildReasoningOptionsForModel({
    modelSelection,
    currentModel:
      currentModel.mode === "uniform" && currentModel.model === modelSelection.model
        ? currentModel.model
        : null,
    currentReasoningEffort:
      sharedReasoning.mode === "uniform" ? sharedReasoning.reasoningEffort : null,
  });
  session.reasoningOptions = reasoningOptions;
  menuSessions.set(sessionId, session);

  const lines = [];
  if (notice) {
    lines.push(notice, "");
  }
  lines.push("Model & Reasoning:");
  lines.push(`model: ${modelSelection.label}`);
  lines.push(
    `current reasoning: ${
      sharedReasoning.mode === "uniform"
        ? formatReasoningLabel(sharedReasoning.reasoningEffort)
        : "mixed"
    }`,
  );
  lines.push("", "Choose the reasoning level:");

  const keyboard = buildGlobalReasoningKeyboard(sessionId, modelSelection.key, {
    reasoningOptions,
  });

  if (editMessage) {
    await editMessageOrReply(ctx, lines.join("\n"), {
      reply_markup: {
        inline_keyboard: keyboard,
      },
    });
    return;
  }

  await ctx.reply(lines.join("\n"), {
    reply_markup: {
      inline_keyboard: keyboard,
    },
  });
}

async function renderGlobalFastMenu(
  ctx: HubOpsContext,
  {
    sessionId = "",
    editMessage = false,
    runtime = null,
    notice = "",
  }: {
    sessionId?: string;
    editMessage?: boolean;
    runtime?: HubRuntimeInfo | null;
    notice?: string;
  } = {},
): Promise<void> {
  const bots = await fetchBots();
  const hubIncluded = isHubModelControlAvailable(runtime);
  if (bots.length === 0 && !hubIncluded) {
    await renderBotsMenu(ctx, {
      editMessage,
      notice: notice || "No agents found.",
    });
    return;
  }

  const chatId = getChatId(ctx);
  const activeSessionId = sessionId || createMenuSession(chatId, bots);
  const session = getMenuSession(activeSessionId, ctx);
  if (!session) {
    await renderBotsMenu(ctx, {
      editMessage,
      notice: "Menu expired. Open /bots again.",
    });
    return;
  }

  const sharedServiceTier = resolveSharedServiceTierForGlobalTargets(bots, runtime);
  clearPendingProviderSelection(session);
  session.reasoningOptions = [];
  menuSessions.set(activeSessionId, session);

  const lines = [];
  if (notice) {
    lines.push(notice, "");
  }
  lines.push("Speed:");
  lines.push(`agents: ${bots.length}`);
  lines.push(`hub available: ${hubIncluded ? "yes" : "no"}`);
  lines.push(
    `current speed: ${
      sharedServiceTier.mode === "uniform"
        ? formatFastModeLabel(sharedServiceTier.serviceTier)
        : "mixed"
    }`,
  );
  lines.push("", "Choose the speed mode:");

  const keyboard = buildGlobalFastKeyboard(activeSessionId, {
    serviceTier: sharedServiceTier.mode === "uniform" ? sharedServiceTier.serviceTier : null,
    hasMixedSelection: sharedServiceTier.mode === "mixed",
  });

  if (editMessage) {
    await editMessageOrReply(ctx, lines.join("\n"), {
      reply_markup: {
        inline_keyboard: keyboard,
      },
    });
    return;
  }

  await ctx.reply(lines.join("\n"), {
    reply_markup: {
      inline_keyboard: keyboard,
    },
  });
}

async function renderProviderTargetMenu(
  ctx: HubOpsContext,
  {
    sessionId,
    runtime = null,
    editMessage = true,
    notice = "",
  }: {
    sessionId: string;
    runtime?: HubRuntimeInfo | null;
    editMessage?: boolean;
    notice?: string;
  },
): Promise<void> {
  const bots = await fetchBots();
  const session = getMenuSession(sessionId, ctx);
  if (!session || !session.pendingProviderPatch || !session.pendingFlow) {
    await renderBotsMenu(ctx, {
      editMessage,
      notice: "Selection expired. Open the menu again.",
    });
    return;
  }

  session.botIds = bots.map((entry) => String(entry?.id ?? "").trim()).filter(Boolean);
  menuSessions.set(sessionId, session);

  const hubIncluded = isHubModelControlAvailable(runtime);
  const lines = [];
  if (notice) {
    lines.push(notice, "");
  }
  lines.push(session.pendingFlow === "speed" ? "Speed" : "Model & Reasoning");
  if (session.pendingSummary.modelLabel) {
    lines.push(`model: ${session.pendingSummary.modelLabel}`);
  }
  if (session.pendingSummary.reasoningLabel) {
    lines.push(`reasoning: ${session.pendingSummary.reasoningLabel}`);
  }
  if (session.pendingSummary.speedLabel) {
    lines.push(`speed: ${session.pendingSummary.speedLabel}`);
  }
  lines.push("", "Choose where to apply it:");

  const keyboard = buildProviderTargetKeyboard(sessionId, {
    hubIncluded,
    backCallbackData:
      session.pendingFlow === "speed" ? `hub:gf:${sessionId}` : `hub:ga:${sessionId}`,
  });

  if (editMessage) {
    await editMessageOrReply(ctx, lines.join("\n"), {
      reply_markup: {
        inline_keyboard: keyboard,
      },
    });
    return;
  }

  await ctx.reply(lines.join("\n"), {
    reply_markup: {
      inline_keyboard: keyboard,
    },
  });
}

async function renderProviderTargetAgentMenu(
  ctx: HubOpsContext,
  {
    sessionId,
    editMessage = true,
    notice = "",
  }: { sessionId: string; editMessage?: boolean; notice?: string },
): Promise<void> {
  const bots = await fetchBots();
  const session = getMenuSession(sessionId, ctx);
  if (!session || !session.pendingProviderPatch || !session.pendingFlow) {
    await renderBotsMenu(ctx, {
      editMessage,
      notice: "Selection expired. Open the menu again.",
    });
    return;
  }

  session.botIds = bots.map((entry) => String(entry?.id ?? "").trim()).filter(Boolean);
  menuSessions.set(sessionId, session);

  const lines = [];
  if (notice) {
    lines.push(notice, "");
  }
  lines.push("Choose one agent:");
  if (session.pendingSummary.modelLabel) {
    lines.push(`model: ${session.pendingSummary.modelLabel}`);
  }
  if (session.pendingSummary.reasoningLabel) {
    lines.push(`reasoning: ${session.pendingSummary.reasoningLabel}`);
  }
  if (session.pendingSummary.speedLabel) {
    lines.push(`speed: ${session.pendingSummary.speedLabel}`);
  }

  const keyboard = buildProviderTargetAgentKeyboard(sessionId, bots, {
    backCallbackData: `hub:tt:${sessionId}:single`,
  });

  if (editMessage) {
    await editMessageOrReply(ctx, lines.join("\n"), {
      reply_markup: {
        inline_keyboard: keyboard,
      },
    });
    return;
  }

  await ctx.reply(lines.join("\n"), {
    reply_markup: {
      inline_keyboard: keyboard,
    },
  });
}

function setPendingProviderSelection(
  session: MenuSession,
  {
    patch,
    flow,
    modelLabel = null,
    reasoningLabel = null,
    speedLabel = null,
  }: {
    patch: ProviderPolicyPatch;
    flow: "model_reasoning" | "speed";
    modelLabel?: string | null;
    reasoningLabel?: string | null;
    speedLabel?: string | null;
  },
): void {
  session.pendingProviderPatch = { ...patch };
  session.pendingFlow = flow;
  session.pendingSummary = {
    modelLabel,
    reasoningLabel,
    speedLabel,
  };
}

function clearPendingProviderSelection(session: MenuSession): void {
  session.pendingProviderPatch = null;
  session.pendingFlow = null;
  session.pendingSummary = {
    modelLabel: null,
    reasoningLabel: null,
    speedLabel: null,
  };
}

function buildBotActionsKeyboard(sessionId: string, index: number): InlineKeyboardButton[][] {
  return [
    [
      { text: "Safe (read-only)", callback_data: `hub:p:${sessionId}:${index}:safe` },
      { text: "Standard (ask)", callback_data: `hub:p:${sessionId}:${index}:standard` },
    ],
    [
      { text: "Semi (fail ask)", callback_data: `hub:p:${sessionId}:${index}:semi_auto` },
      { text: "Full (no prompts)", callback_data: `hub:p:${sessionId}:${index}:full_auto` },
    ],
    [{ text: "Reset Context", callback_data: `hub:ra:${sessionId}:${index}` }],
    [{ text: "Delete Agent", callback_data: `hub:da:${sessionId}:${index}` }],
    [{ text: "Back to agents", callback_data: `hub:ag:${sessionId}` }],
  ];
}

function buildGlobalModelKeyboard(
  sessionId: string,
  {
    modelOptions = [],
    currentModel = "",
    hasMixedSelection = false,
  }: {
    modelOptions?: ModelSelectionOption[];
    currentModel?: string;
    hasMixedSelection?: boolean;
  } = {},
): InlineKeyboardButton[][] {
  const rows: InlineKeyboardButton[][] = [
    [
      {
        text: formatModelButtonText("Auto", !hasMixedSelection && currentModel === ""),
        callback_data: `hub:gm:${sessionId}:auto`,
      },
    ],
  ];

  for (const option of modelOptions) {
    const isCurrent =
      !hasMixedSelection &&
      String(currentModel ?? "")
        .trim()
        .toLowerCase() ===
        String(option.model ?? "")
          .trim()
          .toLowerCase();
    rows.push([
      {
        text: formatModelButtonText(option.label, isCurrent),
        callback_data: `hub:gm:${sessionId}:${option.key}`,
      },
    ]);
  }

  rows.push([{ text: "Back to menu", callback_data: "hub:back" }]);
  return rows;
}

function buildGlobalReasoningKeyboard(
  sessionId: string,
  modelProfileId: string,
  { reasoningOptions = [] }: { reasoningOptions?: ReasoningSelectionOption[] } = {},
): InlineKeyboardButton[][] {
  const rows: InlineKeyboardButton[][] = [];

  for (const option of reasoningOptions) {
    rows.push([
      {
        text: formatModelButtonText(option.label, option.selected === true),
        callback_data: `hub:gr:${sessionId}:${modelProfileId}:${option.key}`,
      },
    ]);
  }

  rows.push([{ text: "Back to model", callback_data: `hub:ga:${sessionId}` }]);
  rows.push([{ text: "Back to menu", callback_data: "hub:back" }]);
  return rows;
}

function buildGlobalFastKeyboard(
  sessionId: string,
  {
    serviceTier = null,
    hasMixedSelection = false,
  }: { serviceTier?: string | null; hasMixedSelection?: boolean } = {},
): InlineKeyboardButton[][] {
  return [
    [
      {
        text: formatModelButtonText("Standard", !hasMixedSelection && serviceTier !== "fast"),
        callback_data: `hub:gft:${sessionId}:standard`,
      },
    ],
    [
      {
        text: formatModelButtonText("Fast", !hasMixedSelection && serviceTier === "fast"),
        callback_data: `hub:gft:${sessionId}:fast`,
      },
    ],
    [{ text: "Back to menu", callback_data: "hub:back" }],
  ];
}

function buildProviderTargetKeyboard(
  sessionId: string,
  {
    hubIncluded,
    backCallbackData,
  }: {
    hubIncluded: boolean;
    backCallbackData: string;
  },
): InlineKeyboardButton[][] {
  const rows: InlineKeyboardButton[][] = [
    [{ text: "One agent", callback_data: `hub:tt:${sessionId}:single` }],
    [{ text: "All agents", callback_data: `hub:tt:${sessionId}:all` }],
  ];

  if (hubIncluded) {
    rows.push([{ text: "All agents + hub", callback_data: `hub:tt:${sessionId}:all_hub` }]);
  }

  rows.push([{ text: "Back", callback_data: backCallbackData }]);
  rows.push([{ text: "Back to menu", callback_data: "hub:back" }]);
  return rows;
}

function buildProviderTargetAgentKeyboard(
  sessionId: string,
  bots: BotState[],
  {
    backCallbackData,
  }: {
    backCallbackData: string;
  },
): InlineKeyboardButton[][] {
  const rows: InlineKeyboardButton[][] = [];

  for (let index = 0; index < bots.length; index += 1) {
    const botState = bots[index];
    if (!botState) {
      continue;
    }
    const status = botState.running ? "ON" : "OFF";
    rows.push([
      {
        text: `${botState.id} (${status})`,
        callback_data: `hub:ta:${sessionId}:${index}`,
      },
    ]);
  }

  rows.push([{ text: "Back", callback_data: backCallbackData }]);
  rows.push([{ text: "Back to menu", callback_data: "hub:back" }]);
  return rows;
}

function createMenuSession(chatId: string, bots: BotState[]): string {
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
    botIds: bots.map((entry) => String(entry?.id ?? "").trim()).filter(Boolean),
    modelOptions: [],
    reasoningOptions: [],
    pendingProviderPatch: null,
    pendingFlow: null,
    pendingSummary: {
      modelLabel: null,
      reasoningLabel: null,
      speedLabel: null,
    },
  });

  return sessionId;
}

function getMenuSession(sessionId: string, ctx: HubOpsContext): MenuSession | null {
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

function getBotIdFromSession(session: MenuSession | null, index: number): string | null {
  if (!session) {
    return null;
  }

  if (!Number.isInteger(index) || index < 0 || index >= session.botIds.length) {
    return null;
  }

  const botId = String(session.botIds[index] ?? "").trim();
  return botId || null;
}

function parseMenuAction(rawData: string): HubOpsMenuAction | null {
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
  if (!kind) {
    return null;
  }

  if (kind === "r" && parts.length === 3) {
    const sessionId = parts[2];
    if (!sessionId) {
      return null;
    }
    return {
      type: "refresh",
      sessionId,
    };
  }

  if (kind === "ga" && parts.length === 3) {
    const sessionId = parts[2];
    if (!sessionId) {
      return null;
    }
    return {
      type: "global_model_open",
      sessionId,
    };
  }

  if (kind === "gf" && parts.length === 3) {
    const sessionId = parts[2];
    if (!sessionId) {
      return null;
    }
    return {
      type: "global_fast_open",
      sessionId,
    };
  }

  if (kind === "ag" && parts.length === 3) {
    const sessionId = parts[2];
    if (!sessionId) {
      return null;
    }
    return {
      type: "agents_home",
      sessionId,
    };
  }

  if (
    (kind === "o" || kind === "ra" || kind === "rc" || kind === "da" || kind === "dc") &&
    parts.length === 4
  ) {
    const sessionId = parts[2];
    if (!sessionId) {
      return null;
    }
    const index = parseMenuIndex(parts[3]);
    if (index === null) {
      return null;
    }

    const mapping = {
      o: "open",
      ra: "reset_ask",
      rc: "reset_confirm",
      da: "delete_ask",
      dc: "delete_confirm",
    } as const;
    const actionType = mapping[kind as keyof typeof mapping];
    if (!actionType) {
      return null;
    }

    return {
      type: actionType,
      sessionId,
      index,
    };
  }

  if (kind === "p" && parts.length === 5) {
    const index = parseMenuIndex(parts[3]);
    const profileId = String(parts[4] ?? "")
      .trim()
      .toLowerCase();
    if (index === null || !profileId) {
      return null;
    }
    const sessionId = parts[2];
    if (!sessionId) {
      return null;
    }

    return {
      type: "policy",
      sessionId,
      index,
      profileId,
    };
  }

  if (kind === "gm" && parts.length === 4) {
    const sessionId = parts[2];
    const profileId = String(parts[3] ?? "")
      .trim()
      .toLowerCase();
    if (!sessionId || !profileId) {
      return null;
    }
    return {
      type: "global_model",
      sessionId,
      profileId,
    };
  }

  if (kind === "gft" && parts.length === 4) {
    const sessionId = parts[2];
    const profileId = String(parts[3] ?? "")
      .trim()
      .toLowerCase();
    if (!sessionId || !profileId) {
      return null;
    }
    return {
      type: "global_fast_apply",
      sessionId,
      profileId,
    };
  }

  if (kind === "tt" && parts.length === 4) {
    const sessionId = parts[2];
    const profileId = String(parts[3] ?? "")
      .trim()
      .toLowerCase();
    if (!sessionId || !profileId) {
      return null;
    }
    return {
      type: "target_choice",
      sessionId,
      profileId,
    };
  }

  if (kind === "ta" && parts.length === 4) {
    const sessionId = parts[2];
    const index = parseMenuIndex(parts[3]);
    if (!sessionId || index === null) {
      return null;
    }
    return {
      type: "target_agent_apply",
      sessionId,
      index,
    };
  }

  if (kind === "gr" && parts.length === 5) {
    const sessionId = parts[2];
    const modelProfileId = String(parts[3] ?? "")
      .trim()
      .toLowerCase();
    const profileId = String(parts[4] ?? "")
      .trim()
      .toLowerCase();
    if (!sessionId || !modelProfileId || !profileId) {
      return null;
    }
    return {
      type: "global_reasoning_apply",
      sessionId,
      modelProfileId,
      profileId,
    };
  }

  return null;
}

type GlobalProviderApplyResult = {
  updatedCount: number;
  totalTargets: number;
  botFailures: Array<{ botId: string; error: string }>;
  hubIncluded: boolean;
  hubError: string | null;
};

function isHubModelControlAvailable(runtime?: HubRuntimeInfo | null): boolean {
  return Boolean(runtime && typeof runtime.setProviderOptions === "function");
}

function resolveSharedModelForGlobalTargets(
  bots: BotState[],
  runtime?: HubRuntimeInfo | null,
): { mode: "uniform"; model: string | null } | { mode: "mixed" } {
  const models = bots.map((bot) => bot?.provider?.options?.model);
  if (runtime && typeof runtime.getProviderOptions === "function") {
    models.push(getRuntimeProviderSelection(runtime).model);
  }
  return resolveSharedModel(models);
}

function resolveSharedReasoningForGlobalTargets(
  bots: BotState[],
  runtime?: HubRuntimeInfo | null,
): { mode: "uniform"; reasoningEffort: string | null } | { mode: "mixed" } {
  const values = bots.map((bot) => bot?.provider?.options?.reasoningEffort);
  if (runtime && typeof runtime.getProviderOptions === "function") {
    values.push(getRuntimeProviderSelection(runtime).reasoningEffort);
  }
  return resolveSharedReasoningEffort(values);
}

function resolveSharedServiceTierForGlobalTargets(
  bots: BotState[],
  runtime?: HubRuntimeInfo | null,
): { mode: "uniform"; serviceTier: string | null } | { mode: "mixed" } {
  const values = bots.map((bot) => bot?.provider?.options?.serviceTier);
  if (runtime && typeof runtime.getProviderOptions === "function") {
    values.push(getRuntimeProviderSelection(runtime).serviceTier);
  }
  return resolveSharedServiceTier(values);
}

async function applyGlobalProviderSelection({
  bots,
  patch,
  runtime,
}: {
  bots: BotState[];
  patch: ProviderPolicyPatch;
  runtime?: HubRuntimeInfo | null;
}): Promise<GlobalProviderApplyResult> {
  const hubIncluded = isHubModelControlAvailable(runtime);
  const botResult = await applyProviderPolicyToBots({
    apiPost,
    bots,
    patch,
  });

  let hubError: string | null = null;
  let hubUpdated = false;
  if (hubIncluded) {
    try {
      await applyRuntimeProviderPolicy({
        runtime,
        patch,
      });
      hubUpdated = true;
    } catch (error) {
      hubError = sanitizeError(error);
    }
  }

  return {
    updatedCount: botResult.updatedBotIds.length + (hubUpdated ? 1 : 0),
    totalTargets: bots.length + (hubIncluded ? 1 : 0),
    botFailures: botResult.failures,
    hubIncluded,
    hubError,
  };
}

function buildGlobalModelUpdateLines({
  modelLabel,
  reasoningLabel,
  result,
}: {
  modelLabel: string;
  reasoningLabel: string;
  result: GlobalProviderApplyResult;
}): string[] {
  const lines = [
    result.hubIncluded
      ? `Model updated for all agents and hub: ${modelLabel} / ${reasoningLabel}`
      : `Model updated for all agents: ${modelLabel} / ${reasoningLabel}`,
    `Updated: ${result.updatedCount}/${result.totalTargets}`,
  ];

  if (result.botFailures.length > 0 || result.hubError) {
    lines.push(`Warnings: ${result.botFailures.length + (result.hubError ? 1 : 0)}`);
  }

  if (result.botFailures.length > 0) {
    const failedIds = result.botFailures.map((entry) => entry.botId).filter(Boolean);
    if (failedIds.length > 0) {
      lines.push(`Failed agents: ${failedIds.join(", ")}`);
    }
  }

  if (result.hubError) {
    lines.push(`Hub warning: ${result.hubError}`);
  }

  return lines;
}

function buildGlobalFastUpdateLines({
  fastLabel,
  result,
}: {
  fastLabel: string;
  result: GlobalProviderApplyResult;
}): string[] {
  const lines = [
    result.hubIncluded
      ? `Speed updated for all agents and hub: ${fastLabel}`
      : `Speed updated for all agents: ${fastLabel}`,
    `Updated: ${result.updatedCount}/${result.totalTargets}`,
  ];

  if (result.botFailures.length > 0 || result.hubError) {
    lines.push(`Warnings: ${result.botFailures.length + (result.hubError ? 1 : 0)}`);
  }

  if (result.botFailures.length > 0) {
    const failedIds = result.botFailures.map((entry) => entry.botId).filter(Boolean);
    if (failedIds.length > 0) {
      lines.push(`Failed agents: ${failedIds.join(", ")}`);
    }
  }

  if (result.hubError) {
    lines.push(`Hub warning: ${result.hubError}`);
  }

  return lines;
}

function parseMenuIndex(value: string | undefined): number | null {
  const index = Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(index) || index < 0 || index > 9999) {
    return null;
  }
  return index;
}

function extractCommand(text: string): string {
  const tokenParts = String(text ?? "")
    .trim()
    .split(/\s+/);
  const token = tokenParts[0] ?? "";
  if (!token.startsWith("/")) {
    return "";
  }
  const slashToken = token.split("@")[0];
  return String(slashToken ?? "").toLowerCase();
}

function normalizeBotIdInput(value: string, suggested: string | null): string | null {
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

function suggestBotIdFromUsername(username: string | null): string | null {
  const raw = String(username ?? "")
    .trim()
    .toLowerCase();
  if (!raw) {
    return null;
  }

  const candidate = raw
    .replace(/[^a-z0-9_-]/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 64);
  if (!candidate || !BOT_ID_PATTERN.test(candidate)) {
    return null;
  }

  return candidate;
}

function buildTelegramAgentDefinition({
  botId,
  token,
}: {
  botId: string | null;
  token: string | null;
}) {
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
        sandboxMode: "danger-full-access",
        approvalPolicy: "never",
      },
    },
    channels: [
      {
        kind: "telegram",
        id: `telegram_${safeId}`,
        token: String(token ?? "").trim(),
      },
    ],
    capabilities: [],
  };
}

async function fetchBots(): Promise<BotState[]> {
  const payload = await apiGet<BotListResponse>("/api/bots");
  const bots = Array.isArray(payload.bots) ? payload.bots : [];
  const normalized: BotState[] = [];
  for (const entry of bots) {
    if (!isRecord(entry)) {
      continue;
    }
    const id = String(entry.id ?? "").trim();
    if (!id) {
      continue;
    }
    const provider = isRecord(entry.provider) ? entry.provider : null;
    const options = provider && isRecord(provider.options) ? provider.options : undefined;
    normalized.push({
      id,
      running: entry.running === true,
      telegramRunning: entry.telegramRunning === true,
      provider: options ? { options } : null,
    });
  }
  return normalized.sort((a, b) => String(a.id ?? "").localeCompare(String(b.id ?? "")));
}

async function fetchBotById(botId: string): Promise<BotState | null> {
  const bots = await fetchBots();
  return bots.find((entry) => String(entry?.id ?? "").trim() === botId) ?? null;
}

async function editMessageOrReply(
  ctx: HubOpsContext,
  text: string,
  options: ReplyOptions = {},
): Promise<void> {
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

function getChatId(ctx: HubOpsContext): string {
  return String(ctx.chat?.id ?? ctx.callbackQuery?.message?.chat?.id ?? "").trim();
}

function looksLikeCodexApiKey(value: string): boolean {
  const raw = String(value ?? "").trim();
  if (!raw.startsWith("sk-")) {
    return false;
  }
  if (raw.length < 20 || raw.length > 4096) {
    return false;
  }
  return /^[A-Za-z0-9._-]+$/.test(raw);
}

async function maybeDeleteIncomingMessage(ctx: HubOpsContext): Promise<void> {
  const chatId = ctx.chat?.id;
  const messageId = ctx.message?.message_id;
  if (!chatId || !messageId) {
    return;
  }

  try {
    await ctx.api.deleteMessage(chatId, messageId);
  } catch {
    // Best effort only.
  }
}

async function answerCallbackQuerySafe(ctx: HubOpsContext, text = ""): Promise<void> {
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

async function apiGet<T = unknown>(endpoint: string): Promise<T> {
  const response = await fetch(`${getEngineBaseUrl()}${endpoint}`, {
    method: "GET",
    headers: {
      Accept: "application/json",
    },
  });
  return parseJsonResponse(response);
}

async function apiPost<T = unknown>(endpoint: string, body: unknown): Promise<T> {
  const response = await fetch(`${getEngineBaseUrl()}${endpoint}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify(body ?? {}),
  });
  return parseJsonResponse(response);
}

function getEngineBaseUrl(): string {
  const value = String(process.env.HUB_ENGINE_BASE_URL ?? "http://127.0.0.1:8787").trim();
  return value.replace(/\/+$/, "") || "http://127.0.0.1:8787";
}

async function parseJsonResponse<T>(response: Response): Promise<T> {
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    const detail =
      isRecord(payload) && typeof payload.error === "string" && payload.error.trim()
        ? `: ${payload.error}`
        : "";
    throw new Error(`HTTP ${response.status}${detail}`);
  }
  return payload as T;
}

async function verifyTelegramToken(token: string): Promise<TelegramVerificationResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TELEGRAM_VERIFY_TIMEOUT_MS);

  try {
    const response = await fetch(`https://api.telegram.org/bot${token}/getMe`, {
      method: "GET",
      signal: controller.signal,
      headers: {
        Accept: "application/json",
      },
    });

    const payload = await response.json().catch(() => null);
    const payloadRecord = isRecord(payload) ? payload : {};
    const resultRecord = isRecord(payloadRecord.result) ? payloadRecord.result : null;
    if (!response.ok || payloadRecord.ok !== true || !resultRecord) {
      const reason = String(payloadRecord.description ?? `HTTP ${response.status}`).trim();
      return {
        ok: false,
        error: reason || "Telegram getMe failed.",
      };
    }

    const rawId = resultRecord.id;
    const numericId = typeof rawId === "number" ? rawId : Number(rawId);
    const safeId = Number.isFinite(numericId) ? numericId : 0;
    return {
      ok: true,
      id: safeId,
      username: String(resultRecord.username ?? "").trim() || null,
    };
  } catch (error) {
    const reason = sanitizeError(error);
    if (reason.toLowerCase().includes("aborted")) {
      return {
        ok: false,
        error: "Telegram verification timed out.",
      };
    }

    return {
      ok: false,
      error: reason,
    };
  } finally {
    clearTimeout(timer);
  }
}

function startCodexLoginWatcher(flowKey: string): string {
  const token = randomBytes(6).toString("hex");
  codexLoginWatchers.set(flowKey, {
    token,
    startedAt: Date.now(),
  });
  return token;
}

function clearCodexLoginWatcher(flowKey: string): boolean {
  return codexLoginWatchers.delete(flowKey);
}

function isCodexLoginWatcherActive(flowKey: string, watcherToken: string): boolean {
  const watcher = codexLoginWatchers.get(flowKey);
  return Boolean(watcher && watcher.token === watcherToken);
}

async function watchCodexLoginCompletion({
  ctx,
  runtime,
  flowKey,
  watcherToken,
}: {
  ctx: HubOpsContext;
  runtime: HubRuntimeInfo | null | undefined;
  flowKey: string;
  watcherToken: string;
}): Promise<void> {
  const startedAt = Date.now();

  while (Date.now() - startedAt <= CODEX_LOGIN_WATCH_TIMEOUT_MS) {
    if (!isCodexLoginWatcherActive(flowKey, watcherToken)) {
      return;
    }

    await sleep(CODEX_LOGIN_WATCH_POLL_MS);

    let status: CodexStatusResponse | null = null;
    try {
      status = await apiGet<CodexStatusResponse>("/api/system/codex/status");
    } catch {
      continue;
    }

    const deviceAuth = isRecord(status?.deviceAuth) ? status.deviceAuth : {};
    const state = String(deviceAuth.status ?? "idle")
      .trim()
      .toLowerCase();

    if (state === "succeeded") {
      const refreshMessage = await refreshHubProviderAfterCodexLogin(runtime);
      const refreshedBots = readRefreshedBotIds(deviceAuth);
      const refreshFailures = readRefreshFailures(deviceAuth);
      if (!isCodexLoginWatcherActive(flowKey, watcherToken)) {
        return;
      }
      clearCodexLoginWatcher(flowKey);
      const lines = ["Codex account switched successfully.", refreshMessage];
      if (refreshedBots.length > 0) {
        lines.push(`Agents refreshed: ${refreshedBots.join(", ")}`);
      } else {
        lines.push("No running agents needed refresh.");
      }
      if (refreshFailures.length > 0) {
        lines.push(`Refresh warnings: ${refreshFailures.length}. Use /health then /bots.`);
      }
      lines.push("New turns now use the new account quota.");
      await ctx.reply(lines.join("\n"));
      return;
    }

    if (state === "failed" || state === "canceled") {
      if (!isCodexLoginWatcherActive(flowKey, watcherToken)) {
        return;
      }
      clearCodexLoginWatcher(flowKey);
      const detail = String(deviceAuth.detail ?? "").trim();
      await ctx.reply(
        detail
          ? `Codex login ${state}: ${detail}`
          : `Codex login ${state}. Retry /codex_login if needed.`,
      );
      return;
    }
  }

  if (!isCodexLoginWatcherActive(flowKey, watcherToken)) {
    return;
  }
  clearCodexLoginWatcher(flowKey);
  await ctx.reply(
    "Codex login is still pending. Run /codex_status. Once succeeded, new turns use the new account quota.",
  );
}

async function refreshHubProviderAfterCodexLogin(runtime?: HubRuntimeInfo | null): Promise<string> {
  invalidateCodexQuotaUsageCache();
  if (!runtime || typeof runtime.refreshProviderSession !== "function") {
    return "Account updated. Hub refresh is not available on this runtime.";
  }

  try {
    const result = await runtime.refreshProviderSession("codex account switched");
    const payload = isRecord(result) ? result : {};
    const channelsRestarted = payload.channelsRestarted === true;
    return channelsRestarted
      ? "Hub session refreshed automatically."
      : "Hub provider refreshed automatically.";
  } catch (error) {
    return `Account updated, but hub refresh warning: ${sanitizeError(error)}`;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isPolicyProfileId(value: string): value is PolicyProfileId {
  return value === "safe" || value === "standard" || value === "semi_auto" || value === "full_auto";
}

function readRefreshedBotIds(payload: unknown): string[] {
  const record = isRecord(payload) ? payload : {};
  const raw =
    Array.isArray(record.refreshedBots) && record.refreshedBots.length > 0
      ? record.refreshedBots
      : Array.isArray(record.restartedBots)
        ? record.restartedBots
        : [];
  return raw.map((entry) => String(entry ?? "").trim()).filter(Boolean);
}

function readRefreshFailures(payload: unknown): unknown[] {
  const record = isRecord(payload) ? payload : {};
  if (Array.isArray(record.refreshFailures)) {
    return record.refreshFailures;
  }
  if (Array.isArray(record.restartFailures)) {
    return record.restartFailures;
  }
  return [];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object";
}

function sanitizeError(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  return raw.split(/\r?\n/).slice(0, 6).join("\n");
}
