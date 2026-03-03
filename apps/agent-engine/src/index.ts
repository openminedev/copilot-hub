// @ts-nocheck
import path from "node:path";
import { randomBytes } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import express from "express";
import { BotManager } from "@copilot-hub/core/bot-manager";
import { loadBotRegistry } from "@copilot-hub/core/bot-registry";
import { config } from "./config.js";
import { InstanceLock } from "@copilot-hub/core/instance-lock";
import { KernelControlPlane } from "@copilot-hub/core/kernel-control-plane";
import { CONTROL_ACTIONS } from "@copilot-hub/core/control-plane-actions";
import { KernelSecretStore } from "@copilot-hub/core/secret-store";

let activeWebPort = config.webPort;
let runtimeWebPublicBaseUrl = config.webPublicBaseUrl;

let shuttingDown = false;
let server = null;
let botManager = null;
let instanceLock = null;
let controlPlane = null;
let secretStore = null;
let codexDeviceAuthSession = null;
const workerScriptPath = fileURLToPath(new URL("./agent-worker.js", import.meta.url));
const ANSI_ESCAPE_PATTERN = new RegExp(String.raw`\u001b\[[0-9;]*m`, "g");

await bootstrap();

async function bootstrap() {
  try {
    if (config.instanceLockEnabled) {
      instanceLock = new InstanceLock(config.instanceLockFilePath);
      await instanceLock.acquire();
    }

    secretStore = new KernelSecretStore(config.secretStoreFilePath);
    await secretStore.init();

    const registry = await loadBotRegistry({
      filePath: config.botRegistryFilePath,
      dataDir: config.dataDir,
      defaultWorkspaceRoot: config.defaultWorkspaceRoot,
      defaultThreadMode: config.defaultThreadMode,
      defaultSharedThreadId: config.defaultSharedThreadId,
      defaultAllowedChatIds: config.defaultAllowedChatIds,
      bootstrapTelegramToken: config.bootstrapTelegramToken,
      defaultProviderKind: config.defaultProviderKind,
      workspacePolicy: config.workspacePolicy,
      resolveSecret: (name) => secretStore.getSecret(name),
    });

    const runtimeBots = registry.bots.filter((bot) => bot.enabled !== false);

    botManager = new BotManager({
      botDefinitions: runtimeBots,
      providerDefaults: config.providerDefaults,
      turnActivityTimeoutMs: config.turnActivityTimeoutMs,
      maxMessages: config.maxMessages,
      webPublicBaseUrl: runtimeWebPublicBaseUrl,
      projectsBaseDir: config.projectsBaseDir,
      workerScriptPath,
      botDataRootDir: path.join(config.dataDir, "bots"),
      heartbeatEnabled: config.agentHeartbeatEnabled,
      heartbeatIntervalMs: config.agentHeartbeatIntervalMs,
      heartbeatTimeoutMs: config.agentHeartbeatTimeoutMs,
    });

    controlPlane = new KernelControlPlane({
      botManager,
      registryFilePath: registry.filePath,
      secretStore,
      registryLoadOptions: {
        dataDir: config.dataDir,
        defaultWorkspaceRoot: config.defaultWorkspaceRoot,
        defaultThreadMode: config.defaultThreadMode,
        defaultSharedThreadId: config.defaultSharedThreadId,
        defaultAllowedChatIds: config.defaultAllowedChatIds,
        bootstrapTelegramToken: config.bootstrapTelegramToken,
        defaultProviderKind: config.defaultProviderKind,
        workspacePolicy: config.workspacePolicy,
        resolveSecret: (name) => secretStore.getSecret(name),
      },
    });
    botManager.setKernelActionHandler((request) => controlPlane.handleAgentAction(request));

    const app = buildApiApp({
      botManager,
      controlPlane,
      registryFilePath: registry.filePath,
    });

    const started = await startWebServer({
      app,
      host: config.webHost,
      basePort: config.webPort,
      autoIncrement: config.webPortAutoIncrement,
      maxAttempts: config.webPortSearchMax,
    });
    server = started.server;
    activeWebPort = started.port;
    runtimeWebPublicBaseUrl = resolveRuntimeWebPublicBaseUrl({
      explicit: config.webPublicBaseUrlExplicit,
      configuredBaseUrl: config.webPublicBaseUrl,
      host: config.webHost,
      port: activeWebPort,
    });
    botManager.setWebPublicBaseUrl(runtimeWebPublicBaseUrl);

    await botManager.startAutoBots();
    registerSignals();

    console.log(`HTTP API listening on http://${config.webHost}:${activeWebPort}`);
    console.log(`Bot registry loaded: ${registry.filePath}`);
    if (instanceLock) {
      console.log(`Instance lock acquired: ${config.instanceLockFilePath}`);
    }
  } catch (error) {
    const message = sanitizeError(error);
    console.error(message);
    await cleanupBeforeExit();
    process.exit(1);
  }
}

function buildApiApp({ botManager, controlPlane, registryFilePath }) {
  const app = express();
  app.use(express.json({ limit: "1mb" }));
  app.use((req, res, next) => {
    res.setHeader("Cache-Control", "no-store");
    next();
  });

  app.get("/api/health", (req, res) => {
    res.json({
      ok: true,
      service: "runtime_kernel",
      providerDefault: config.defaultProviderKind,
      webPort: activeWebPort,
      webPublicBaseUrl: runtimeWebPublicBaseUrl,
      botCount: botManager.getBotCount(),
      turnActivityTimeoutMs: config.turnActivityTimeoutMs,
      heartbeatEnabled: config.agentHeartbeatEnabled,
      heartbeatIntervalMs: config.agentHeartbeatIntervalMs,
      heartbeatTimeoutMs: config.agentHeartbeatTimeoutMs,
      registryFile: registryFilePath,
      secretStoreFile: config.secretStoreFilePath,
    });
  });

  app.get(
    "/api/system/codex/status",
    wrapAsync(async (req, res) => {
      const status = readCodexLoginStatus();
      const deviceAuth = getCodexDeviceAuthSnapshot();
      res.json({
        ok: true,
        configured: status.configured,
        codexBin: status.codexBin,
        detail: status.detail,
        deviceAuth,
      });
    }),
  );

  app.post(
    "/api/system/codex/device_auth/start",
    wrapAsync(async (req, res) => {
      const session = startCodexDeviceAuthSession();
      const ready = await waitForDeviceCode(session, 12_000);
      if (!ready) {
        res.status(400).json({
          error:
            session.error ||
            "Could not initialize Codex device login flow. Retry '/codex_login' in a few seconds.",
        });
        return;
      }

      res.json({
        ok: true,
        status: session.status,
        loginUrl: session.loginUrl,
        code: session.code,
      });
    }),
  );

  app.post(
    "/api/system/codex/device_auth/cancel",
    wrapAsync(async (req, res) => {
      const canceled = cancelCodexDeviceAuthSession();
      res.json({
        ok: true,
        canceled,
      });
    }),
  );

  app.post(
    "/api/system/codex/switch_api_key",
    wrapAsync(async (req, res) => {
      cancelCodexDeviceAuthSession();
      const apiKey = String(req.body?.apiKey ?? "").trim();
      if (!looksLikeCodexApiKey(apiKey)) {
        res.status(400).json({ error: "Field 'apiKey' is invalid." });
        return;
      }

      const login = runCodexCommand(["login", "--with-api-key"], {
        inputText: `${apiKey}\n`,
      });
      if (!login.ok) {
        const message = redactSecret(
          firstNonEmptyLine(login.errorMessage, login.stderr, login.stdout) ||
            "Codex login failed. Check API key and retry.",
          apiKey,
        );
        res.status(400).json({ error: message });
        return;
      }

      const status = readCodexLoginStatus();
      if (!status.configured) {
        res.status(400).json({
          error:
            status.detail || "Codex login verification failed after credential update. Retry once.",
        });
        return;
      }

      const restarted = await restartRunningBots();
      res.json({
        ok: true,
        switched: true,
        configured: true,
        codexBin: status.codexBin,
        detail: status.detail,
        restartedBots: restarted.restartedBotIds,
        restartFailures: restarted.failures,
      });
    }),
  );

  app.get(
    "/api/extensions/contract",
    wrapAsync(async (req, res) => {
      const contract = await controlPlane.runSystemAction(
        CONTROL_ACTIONS.EXTENSIONS_CONTRACT_GET,
        {},
      );
      res.json(contract);
    }),
  );

  app.get(
    "/api/bots",
    wrapAsync(async (req, res) => {
      const bots = await botManager.listBotsLive();
      res.json({ bots });
    }),
  );

  app.post(
    "/api/bots/create",
    wrapAsync(async (req, res) => {
      const result = await controlPlane.runSystemAction(CONTROL_ACTIONS.BOTS_CREATE, {
        agent: req.body?.agent,
        startIfEnabled: req.body?.startIfEnabled !== false,
      });
      res.json(result);
    }),
  );

  app.post(
    "/api/bots/:botId/delete",
    wrapAsync(async (req, res) => {
      const botId = String(req.params.botId ?? "").trim();
      const deleteMode = parseDeleteModeFromRequest(req.body);
      const deleted = await controlPlane.runSystemAction(CONTROL_ACTIONS.BOTS_DELETE, {
        botId,
        deleteMode,
      });
      res.json(deleted);
    }),
  );

  app.post(
    "/api/bots/:botId/project",
    wrapAsync(async (req, res) => {
      const botId = String(req.params.botId ?? "").trim();
      const projectName = String(req.body?.projectName ?? "").trim();
      if (!projectName) {
        res.status(400).json({ error: "Field 'projectName' is required." });
        return;
      }

      const result = await controlPlane.runSystemAction(CONTROL_ACTIONS.BOTS_SET_PROJECT, {
        botId,
        projectName,
      });
      res.json(result);
    }),
  );

  app.post(
    "/api/bots/:botId/policy",
    wrapAsync(async (req, res) => {
      const botId = String(req.params.botId ?? "").trim();
      const sandboxMode = String(req.body?.sandboxMode ?? "")
        .trim()
        .toLowerCase();
      const approvalPolicy = String(req.body?.approvalPolicy ?? "")
        .trim()
        .toLowerCase();
      if (!sandboxMode) {
        res.status(400).json({ error: "Field 'sandboxMode' is required." });
        return;
      }
      if (!approvalPolicy) {
        res.status(400).json({ error: "Field 'approvalPolicy' is required." });
        return;
      }

      const result = await controlPlane.runSystemAction(CONTROL_ACTIONS.BOTS_SET_POLICY, {
        botId,
        sandboxMode,
        approvalPolicy,
      });
      res.json(result);
    }),
  );

  app.get(
    "/api/projects",
    wrapAsync(async (req, res) => {
      const projects = await controlPlane.runSystemAction(CONTROL_ACTIONS.PROJECTS_LIST, {});
      res.json(projects);
    }),
  );

  app.post(
    "/api/projects/create",
    wrapAsync(async (req, res) => {
      const name = String(req.body?.name ?? "").trim();
      if (!name) {
        res.status(400).json({ error: "Field 'name' is required." });
        return;
      }

      const created = await controlPlane.runSystemAction(CONTROL_ACTIONS.PROJECTS_CREATE, { name });
      res.json(created);
    }),
  );

  app.post(
    "/api/bots/:botId/reset",
    wrapAsync(async (req, res) => {
      const botId = String(req.params.botId ?? "").trim();
      await botManager.resetWebThread(botId);
      const bot = await botManager.getBotStatus(botId);
      res.json({
        bot,
        reset: true,
      });
    }),
  );

  app.get(
    "/api/bots/:botId/approvals",
    wrapAsync(async (req, res) => {
      const botId = String(req.params.botId ?? "").trim();
      const threadId = String(req.query.threadId ?? "").trim() || undefined;
      const approvals = await botManager.listBotApprovals(botId, threadId);
      res.json({ approvals });
    }),
  );

  app.post(
    "/api/bots/:botId/approvals/:approvalId",
    wrapAsync(async (req, res) => {
      const botId = String(req.params.botId ?? "").trim();
      const approvalId = String(req.params.approvalId ?? "").trim();
      const threadId = String(req.body?.threadId ?? "").trim();
      const decision = String(req.body?.decision ?? "").trim();
      if (!threadId) {
        res.status(400).json({ error: "Field 'threadId' is required." });
        return;
      }
      if (!decision) {
        res.status(400).json({ error: "Field 'decision' is required." });
        return;
      }

      const resolved = await botManager.resolveBotApproval(botId, {
        threadId,
        approvalId,
        decision,
      });
      res.json({ approval: resolved });
    }),
  );

  app.get(
    "/api/bots/:botId/capabilities",
    wrapAsync(async (req, res) => {
      const botId = String(req.params.botId ?? "").trim();
      const result = await controlPlane.runSystemAction(CONTROL_ACTIONS.BOTS_CAPABILITIES_LIST, {
        botId,
      });
      res.json(result);
    }),
  );

  app.post(
    "/api/bots/:botId/capabilities/reload",
    wrapAsync(async (req, res) => {
      const botId = String(req.params.botId ?? "").trim();
      const result = await controlPlane.runSystemAction(CONTROL_ACTIONS.BOTS_CAPABILITIES_RELOAD, {
        botId,
      });
      res.json(result);
    }),
  );

  app.post(
    "/api/bots/:botId/capabilities/scaffold",
    wrapAsync(async (req, res) => {
      const botId = String(req.params.botId ?? "").trim();
      const capabilityId = String(req.body?.capabilityId ?? "").trim();
      const capabilityName = String(req.body?.capabilityName ?? "").trim();
      if (!capabilityId) {
        res.status(400).json({ error: "Field 'capabilityId' is required." });
        return;
      }

      const result = await controlPlane.runSystemAction(
        CONTROL_ACTIONS.BOTS_CAPABILITIES_SCAFFOLD,
        {
          botId,
          capabilityId,
          capabilityName: capabilityName || undefined,
        },
      );
      res.json(result);
    }),
  );

  app.use((error, req, res, _next) => {
    const message = sanitizeError(error);
    res.status(400).json({ error: message });
  });

  return app;
}

function registerSignals() {
  process.on("SIGINT", () => {
    void shutdown(0);
  });
  process.on("SIGTERM", () => {
    void shutdown(0);
  });
}

function wrapAsync(handler) {
  return (req, res, next) => {
    Promise.resolve(handler(req, res, next)).catch(next);
  };
}

function resolveRuntimeWebPublicBaseUrl({ explicit, configuredBaseUrl, host, port }) {
  if (explicit) {
    return configuredBaseUrl;
  }

  const exposedHost = host === "0.0.0.0" ? "127.0.0.1" : host;
  return `http://${exposedHost}:${port}`;
}

async function startWebServer({ app, host, basePort, autoIncrement, maxAttempts }) {
  let port = basePort;
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    try {
      const startedServer = await listenOnce({ app, host, port });
      return { server: startedServer, port };
    } catch (error) {
      const occupied = error && typeof error === "object" && error.code === "EADDRINUSE";
      if (!occupied || !autoIncrement || port >= 65535) {
        throw error;
      }
      port += 1;
    }
  }

  throw new Error(
    `Could not find a free web port after ${maxAttempts} attempts starting from ${basePort}.`,
  );
}

function listenOnce({ app, host, port }) {
  return new Promise((resolve, reject) => {
    const candidate = app.listen(port, host);
    candidate.once("listening", () => resolve(candidate));
    candidate.once("error", (error) => reject(error));
  });
}

async function shutdown(exitCode) {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;

  await cleanupBeforeExit();
  process.exit(exitCode);
}

async function cleanupBeforeExit() {
  if (botManager) {
    await botManager.shutdownAll();
  }
  if (server) {
    await new Promise((resolve) => {
      server.close(() => resolve());
    });
  }
  if (instanceLock) {
    await instanceLock.release();
  }
}

function sanitizeError(error) {
  const raw = error instanceof Error ? error.message : String(error);
  return raw.split(/\r?\n/).slice(0, 12).join("\n");
}

function parseDeleteModeFromRequest(body) {
  const value = String(body?.deleteMode ?? "")
    .trim()
    .toLowerCase();
  if (value === "soft" || value === "purge_data" || value === "purge_all") {
    return value;
  }
  return "soft";
}

function startCodexDeviceAuthSession() {
  if (codexDeviceAuthSession && isDeviceAuthActive(codexDeviceAuthSession.status)) {
    return codexDeviceAuthSession;
  }

  const codexBin = String(config.codexBin ?? "codex").trim() || "codex";
  const session = {
    id: createSessionId(),
    status: "starting",
    startedAt: new Date().toISOString(),
    codexBin,
    loginUrl: "",
    code: "",
    logLines: [],
    error: "",
    child: null,
    restartedBots: [],
    restartFailures: [],
  };

  const child = spawn(codexBin, ["login", "--device-auth"], {
    cwd: config.kernelRootPath,
    shell: false,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
    env: process.env,
  });
  session.child = child;
  codexDeviceAuthSession = session;

  child.stdout.on("data", (chunk) => {
    appendDeviceAuthOutput(session, chunk);
  });
  child.stderr.on("data", (chunk) => {
    appendDeviceAuthOutput(session, chunk);
  });

  child.once("error", (error) => {
    session.child = null;
    session.status = "failed";
    session.error = sanitizeError(error);
  });

  child.once("exit", (code) => {
    session.child = null;
    if (session.status === "canceled") {
      return;
    }

    if (code === 0) {
      session.status = "succeeded";
      void restartRunningBots()
        .then((restarted) => {
          session.restartedBots = restarted.restartedBotIds;
          session.restartFailures = restarted.failures;
        })
        .catch((error) => {
          session.restartFailures = [{ botId: "*", error: sanitizeError(error) }];
        });
      return;
    }

    session.status = "failed";
    session.error =
      firstNonEmptyLine(session.error, ...session.logLines.slice(-12)) ||
      `Codex login exited with code ${String(code ?? "unknown")}.`;
  });

  return session;
}

function cancelCodexDeviceAuthSession() {
  if (!codexDeviceAuthSession || !isDeviceAuthActive(codexDeviceAuthSession.status)) {
    return false;
  }

  codexDeviceAuthSession.status = "canceled";
  codexDeviceAuthSession.error = "Canceled by user.";
  try {
    codexDeviceAuthSession.child?.kill("SIGTERM");
  } catch {
    // ignore
  }
  codexDeviceAuthSession.child = null;
  return true;
}

function getCodexDeviceAuthSnapshot() {
  const session = codexDeviceAuthSession;
  if (!session) {
    return { status: "idle" };
  }

  return {
    status: session.status,
    startedAt: session.startedAt,
    loginUrl: session.loginUrl || undefined,
    code: session.code || undefined,
    detail: session.error || undefined,
    restartedBots: session.restartedBots,
    restartFailures: session.restartFailures,
  };
}

async function waitForDeviceCode(session, timeoutMs) {
  const timeout = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 10_000;
  const started = Date.now();

  while (Date.now() - started < timeout) {
    if (session.status === "failed" || session.status === "canceled") {
      return false;
    }
    if (session.loginUrl && session.code) {
      if (session.status === "starting") {
        session.status = "pending";
      }
      return true;
    }
    await sleep(150);
  }

  return Boolean(session.loginUrl && session.code);
}

function appendDeviceAuthOutput(session, chunk) {
  const text = stripAnsi(String(chunk ?? ""));
  if (!text.trim()) {
    return;
  }

  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length === 0) {
    return;
  }

  session.logLines.push(...lines);
  if (session.logLines.length > 120) {
    session.logLines = session.logLines.slice(-120);
  }

  if (!session.loginUrl) {
    const url = findDeviceLoginUrl(lines);
    if (url) {
      session.loginUrl = url;
    }
  }

  if (!session.code) {
    const code = findDeviceCode(lines);
    if (code) {
      session.code = code;
    }
  }

  if (session.loginUrl && session.code && session.status === "starting") {
    session.status = "pending";
  }
}

function findDeviceLoginUrl(lines) {
  for (const line of lines) {
    const urls = line.match(/https?:\/\/\S+/g);
    if (!urls) {
      continue;
    }
    for (const url of urls) {
      if (url.includes("/codex/device")) {
        return url;
      }
    }
  }
  return "";
}

function findDeviceCode(lines) {
  for (const line of lines) {
    const match = line.match(/\b[A-Z0-9]{4}-[A-Z0-9]{5}\b/);
    if (match?.[0]) {
      return match[0];
    }
  }
  return "";
}

function stripAnsi(value) {
  return String(value ?? "").replace(ANSI_ESCAPE_PATTERN, "");
}

function isDeviceAuthActive(status) {
  const value = String(status ?? "")
    .trim()
    .toLowerCase();
  return value === "starting" || value === "pending";
}

function createSessionId() {
  return randomBytes(8).toString("hex");
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function readCodexLoginStatus() {
  const codexBin = String(config.codexBin ?? "codex").trim() || "codex";
  const status = runCodexCommand(["login", "status"]);
  return {
    configured: status.ok,
    codexBin,
    detail: firstNonEmptyLine(status.errorMessage, status.stderr, status.stdout),
  };
}

function looksLikeCodexApiKey(value) {
  const key = String(value ?? "").trim();
  if (key.length < 20 || key.length > 4096) {
    return false;
  }
  if (!/^[A-Za-z0-9._-]+$/.test(key)) {
    return false;
  }
  return key.startsWith("sk-");
}

function runCodexCommand(args, { inputText = "" } = {}) {
  const codexBin = String(config.codexBin ?? "codex").trim() || "codex";
  const result = spawnSync(codexBin, args, {
    cwd: config.kernelRootPath,
    shell: false,
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
    encoding: "utf8",
    input: inputText,
    env: process.env,
  });

  if (result.error) {
    return {
      ok: false,
      status: 1,
      stdout: "",
      stderr: "",
      errorMessage: formatCodexSpawnError(codexBin, result.error),
    };
  }

  const status = Number.isInteger(result.status) ? result.status : 1;
  return {
    ok: status === 0,
    status,
    stdout: String(result.stdout ?? "").trim(),
    stderr: String(result.stderr ?? "").trim(),
    errorMessage: "",
  };
}

function formatCodexSpawnError(codexBin, error) {
  const code = String(error?.code ?? "")
    .trim()
    .toUpperCase();
  if (code === "ENOENT") {
    return `Codex binary '${codexBin}' was not found.`;
  }
  if (code === "EPERM") {
    return `Codex binary '${codexBin}' cannot be executed (EPERM).`;
  }
  const message = error instanceof Error ? error.message : String(error);
  return `Failed to execute '${codexBin}': ${firstNonEmptyLine(message)}`;
}

function firstNonEmptyLine(...values) {
  for (const value of values) {
    const line = String(value ?? "")
      .split(/\r?\n/)
      .map((entry) => entry.trim())
      .find(Boolean);
    if (line) {
      return line;
    }
  }
  return "";
}

function redactSecret(text, secret) {
  const input = String(text ?? "");
  const token = String(secret ?? "").trim();
  if (!token) {
    return input;
  }
  return input.split(token).join("[redacted]");
}

async function restartRunningBots() {
  const statuses = await botManager.listBotsLive();
  const runningBotIds = statuses
    .filter((entry) => entry?.running === true)
    .map((entry) => String(entry?.id ?? "").trim())
    .filter(Boolean);

  const restartedBotIds = [];
  const failures = [];

  for (const botId of runningBotIds) {
    try {
      await botManager.stopBot(botId);
      await botManager.startBot(botId);
      restartedBotIds.push(botId);
    } catch (error) {
      failures.push({
        botId,
        error: sanitizeError(error),
      });
    }
  }

  return {
    restartedBotIds,
    failures,
  };
}
