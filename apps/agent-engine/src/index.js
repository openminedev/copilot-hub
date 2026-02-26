import path from "node:path";
import express from "express";
import { BotManager } from "./bot-manager.js";
import { loadBotRegistry } from "./bot-registry.js";
import { config } from "./config.js";
import { InstanceLock } from "./instance-lock.js";
import { KernelControlPlane } from "./kernel/control-plane.js";
import { CONTROL_ACTIONS } from "./kernel/control-plane-actions.js";
import { KernelSecretStore } from "./kernel/secret-store.js";

let activeWebPort = config.webPort;
let runtimeWebPublicBaseUrl = config.webPublicBaseUrl;

let shuttingDown = false;
let server = null;
let botManager = null;
let instanceLock = null;
let controlPlane = null;
let secretStore = null;

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
      resolveSecret: (name) => secretStore.getSecret(name)
    });

    const runtimeBots = registry.bots.filter((bot) => bot.enabled !== false);


    botManager = new BotManager({
      botDefinitions: runtimeBots,
      providerDefaults: config.providerDefaults,
      turnActivityTimeoutMs: config.turnActivityTimeoutMs,
      maxMessages: config.maxMessages,
      webPublicBaseUrl: runtimeWebPublicBaseUrl,
      projectsBaseDir: config.projectsBaseDir,
      botDataRootDir: path.join(config.dataDir, "bots"),
      heartbeatEnabled: config.agentHeartbeatEnabled,
      heartbeatIntervalMs: config.agentHeartbeatIntervalMs,
      heartbeatTimeoutMs: config.agentHeartbeatTimeoutMs
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
        resolveSecret: (name) => secretStore.getSecret(name)
      }
    });
    botManager.setKernelActionHandler((request) => controlPlane.handleAgentAction(request));

    const app = buildApiApp({
      botManager,
      controlPlane,
      registryFilePath: registry.filePath
    });

    const started = await startWebServer({
      app,
      host: config.webHost,
      basePort: config.webPort,
      autoIncrement: config.webPortAutoIncrement,
      maxAttempts: config.webPortSearchMax
    });
    server = started.server;
    activeWebPort = started.port;
    runtimeWebPublicBaseUrl = resolveRuntimeWebPublicBaseUrl({
      explicit: config.webPublicBaseUrlExplicit,
      configuredBaseUrl: config.webPublicBaseUrl,
      host: config.webHost,
      port: activeWebPort
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
      secretStoreFile: config.secretStoreFilePath
    });
  });

  app.get(
    "/api/extensions/contract",
    wrapAsync(async (req, res) => {
      const contract = await controlPlane.runSystemAction(CONTROL_ACTIONS.EXTENSIONS_CONTRACT_GET, {});
      res.json(contract);
    })
  );

  app.get(
    "/api/bots",
    wrapAsync(async (req, res) => {
      const bots = await botManager.listBotsLive();
      res.json({ bots });
    })
  );

  app.post(
    "/api/bots/create",
    wrapAsync(async (req, res) => {
      const result = await controlPlane.runSystemAction(CONTROL_ACTIONS.BOTS_CREATE, {
        agent: req.body?.agent,
        startIfEnabled: req.body?.startIfEnabled !== false
      });
      res.json(result);
    })
  );

  app.post(
    "/api/bots/:botId/delete",
    wrapAsync(async (req, res) => {
      const botId = String(req.params.botId ?? "").trim();
      const deleteMode = parseDeleteModeFromRequest(req.body);
      const deleted = await controlPlane.runSystemAction(CONTROL_ACTIONS.BOTS_DELETE, {
        botId,
        deleteMode
      });
      res.json(deleted);
    })
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
        projectName
      });
      res.json(result);
    })
  );

  app.post(
    "/api/bots/:botId/policy",
    wrapAsync(async (req, res) => {
      const botId = String(req.params.botId ?? "").trim();
      const sandboxMode = String(req.body?.sandboxMode ?? "").trim().toLowerCase();
      const approvalPolicy = String(req.body?.approvalPolicy ?? "").trim().toLowerCase();
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
        approvalPolicy
      });
      res.json(result);
    })
  );


  app.get(
    "/api/projects",
    wrapAsync(async (req, res) => {
      const projects = await controlPlane.runSystemAction(CONTROL_ACTIONS.PROJECTS_LIST, {});
      res.json(projects);
    })
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
    })
  );

  app.post(
    "/api/bots/:botId/reset",
    wrapAsync(async (req, res) => {
      const botId = String(req.params.botId ?? "").trim();
      await botManager.resetWebThread(botId);
      const bot = await botManager.getBotStatus(botId);
      res.json({
        bot,
        reset: true
      });
    })
  );

  app.get(
    "/api/bots/:botId/approvals",
    wrapAsync(async (req, res) => {
      const botId = String(req.params.botId ?? "").trim();
      const threadId = String(req.query.threadId ?? "").trim() || undefined;
      const approvals = await botManager.listBotApprovals(botId, threadId);
      res.json({ approvals });
    })
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
        decision
      });
      res.json({ approval: resolved });
    })
  );

  app.get(
    "/api/bots/:botId/capabilities",
    wrapAsync(async (req, res) => {
      const botId = String(req.params.botId ?? "").trim();
      const result = await controlPlane.runSystemAction(CONTROL_ACTIONS.BOTS_CAPABILITIES_LIST, {
        botId
      });
      res.json(result);
    })
  );

  app.post(
    "/api/bots/:botId/capabilities/reload",
    wrapAsync(async (req, res) => {
      const botId = String(req.params.botId ?? "").trim();
      const result = await controlPlane.runSystemAction(CONTROL_ACTIONS.BOTS_CAPABILITIES_RELOAD, {
        botId
      });
      res.json(result);
    })
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

      const result = await controlPlane.runSystemAction(CONTROL_ACTIONS.BOTS_CAPABILITIES_SCAFFOLD, {
        botId,
        capabilityId,
        capabilityName: capabilityName || undefined
      });
      res.json(result);
    })
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

  throw new Error(`Could not find a free web port after ${maxAttempts} attempts starting from ${basePort}.`);
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










