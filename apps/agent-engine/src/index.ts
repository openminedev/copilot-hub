import path from "node:path";
import { randomBytes } from "node:crypto";
import { spawn, spawnSync, type SpawnSyncReturns } from "node:child_process";
import type { Server } from "node:http";
import { fileURLToPath } from "node:url";
import express, {
  type Express,
  type NextFunction,
  type Request,
  type RequestHandler,
  type Response,
} from "express";
import { BotManager } from "@copilot-hub/core/bot-manager";
import { CodexAppClient } from "@copilot-hub/core/codex-app-client";
import { loadBotRegistry } from "@copilot-hub/core/bot-registry";
import { config } from "./config.js";
import { InstanceLock } from "@copilot-hub/core/instance-lock";
import { KernelControlPlane } from "@copilot-hub/core/kernel-control-plane";
import { CONTROL_ACTIONS } from "@copilot-hub/core/control-plane-actions";
import { KernelSecretStore } from "@copilot-hub/core/secret-store";

let activeWebPort = config.webPort;
let runtimeWebPublicBaseUrl = config.webPublicBaseUrl;

type RestartFailure = {
  botId: string;
  error: string;
};

type DeviceAuthStatus = "starting" | "pending" | "succeeded" | "failed" | "canceled";

type DeviceAuthSession = {
  id: string;
  status: DeviceAuthStatus;
  startedAt: string;
  codexBin: string;
  loginUrl: string;
  code: string;
  logLines: string[];
  error: string;
  child: ReturnType<typeof spawn> | null;
  restartedBots: string[];
  restartFailures: RestartFailure[];
};

type RunCodexCommandResult = {
  ok: boolean;
  status: number;
  stdout: string;
  stderr: string;
  errorMessage: string;
};

type ModelCatalogEntry = {
  id: string;
  model: string;
  displayName: string;
  description: string;
  isDefault: boolean;
};

let shuttingDown = false;
let server: Server | null = null;
let botManager: BotManager | null = null;
let instanceLock: InstanceLock | null = null;
let controlPlane: KernelControlPlane | null = null;
let secretStore: KernelSecretStore | null = null;
let codexDeviceAuthSession: DeviceAuthSession | null = null;
const workerScriptPath = fileURLToPath(new URL("./agent-worker.js", import.meta.url));
const ANSI_ESCAPE_PATTERN = new RegExp(String.raw`\u001b\[[0-9;]*m`, "g");

await bootstrap();

async function bootstrap() {
  try {
    if (config.instanceLockEnabled) {
      const lock = new InstanceLock(config.instanceLockFilePath);
      await lock.acquire();
      instanceLock = lock;
    }

    const kernelSecretStore = new KernelSecretStore(config.secretStoreFilePath);
    await kernelSecretStore.init();
    secretStore = kernelSecretStore;

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
      resolveSecret: (name) => kernelSecretStore.getSecret(name),
    });

    const runtimeBots = registry.bots.filter((bot) => bot.enabled !== false);

    const botDefinitions = runtimeBots as unknown as ConstructorParameters<
      typeof BotManager
    >[0]["botDefinitions"];
    const manager = new BotManager({
      botDefinitions,
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
    botManager = manager;

    const controlPlaneDeps: ConstructorParameters<typeof KernelControlPlane>[0] = {
      botManager: manager as unknown as ConstructorParameters<
        typeof KernelControlPlane
      >[0]["botManager"],
      registryFilePath: registry.filePath,
      secretStore: kernelSecretStore,
      registryLoadOptions: {
        dataDir: config.dataDir,
        defaultWorkspaceRoot: config.defaultWorkspaceRoot,
        defaultThreadMode: config.defaultThreadMode,
        defaultSharedThreadId: config.defaultSharedThreadId,
        defaultAllowedChatIds: config.defaultAllowedChatIds,
        bootstrapTelegramToken: config.bootstrapTelegramToken,
        defaultProviderKind: config.defaultProviderKind,
        workspacePolicy: config.workspacePolicy,
      },
    };
    const kernelControlPlane = new KernelControlPlane(controlPlaneDeps);
    controlPlane = kernelControlPlane;
    manager.setKernelActionHandler((request) =>
      kernelControlPlane.handleAgentAction(
        request as Parameters<KernelControlPlane["handleAgentAction"]>[0],
      ),
    );

    const app = buildApiApp({
      botManager: manager,
      controlPlane: kernelControlPlane,
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
    manager.setWebPublicBaseUrl(runtimeWebPublicBaseUrl);

    await manager.startAutoBots();
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

function buildApiApp({
  botManager,
  controlPlane,
  registryFilePath,
}: {
  botManager: BotManager;
  controlPlane: KernelControlPlane;
  registryFilePath: string;
}): Express {
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

  app.get(
    "/api/system/codex/models",
    wrapAsync(async (req, res) => {
      const modelsResult = await readCodexModelCatalog();
      if (!modelsResult.ok) {
        res.status(400).json({
          error: modelsResult.error,
          codexBin: modelsResult.codexBin,
        });
        return;
      }

      res.json({
        ok: true,
        codexBin: modelsResult.codexBin,
        models: modelsResult.models,
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
      const hasModel = Object.prototype.hasOwnProperty.call(req.body ?? {}, "model");
      const rawModel = req.body?.model;
      const model = rawModel === null || rawModel === undefined ? null : String(rawModel).trim();
      if (!sandboxMode) {
        res.status(400).json({ error: "Field 'sandboxMode' is required." });
        return;
      }
      if (!approvalPolicy) {
        res.status(400).json({ error: "Field 'approvalPolicy' is required." });
        return;
      }

      const payload: {
        botId: string;
        sandboxMode: string;
        approvalPolicy: string;
        model?: string | null;
      } = {
        botId,
        sandboxMode,
        approvalPolicy,
      };
      if (hasModel) {
        payload.model = model;
      }

      const result = await controlPlane.runSystemAction(CONTROL_ACTIONS.BOTS_SET_POLICY, payload);
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

  app.use((error: unknown, req: Request, res: Response, _next: NextFunction) => {
    const message = sanitizeError(error);
    res.status(400).json({ error: message });
  });

  return app;
}

function registerSignals(): void {
  process.on("SIGINT", () => {
    void shutdown(0);
  });
  process.on("SIGTERM", () => {
    void shutdown(0);
  });
}

function wrapAsync(
  handler: (req: Request, res: Response, next: NextFunction) => Promise<unknown>,
): RequestHandler {
  return (req, res, next) => {
    void Promise.resolve(handler(req, res, next)).catch(next);
  };
}

function resolveRuntimeWebPublicBaseUrl({
  explicit,
  configuredBaseUrl,
  host,
  port,
}: {
  explicit: boolean;
  configuredBaseUrl: string;
  host: string;
  port: number;
}): string {
  if (explicit) {
    return configuredBaseUrl;
  }

  const exposedHost = host === "0.0.0.0" ? "127.0.0.1" : host;
  return `http://${exposedHost}:${port}`;
}

async function startWebServer({
  app,
  host,
  basePort,
  autoIncrement,
  maxAttempts,
}: {
  app: Express;
  host: string;
  basePort: number;
  autoIncrement: boolean;
  maxAttempts: number;
}): Promise<{ server: Server; port: number }> {
  let port = basePort;
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    try {
      const startedServer = await listenOnce({ app, host, port });
      return { server: startedServer, port };
    } catch (error) {
      const occupied = isErrnoException(error) && error.code === "EADDRINUSE";
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

function listenOnce({
  app,
  host,
  port,
}: {
  app: Express;
  host: string;
  port: number;
}): Promise<Server> {
  return new Promise((resolve, reject) => {
    const candidate = app.listen(port, host);
    candidate.once("listening", () => resolve(candidate));
    candidate.once("error", (error) => reject(error));
  });
}

async function shutdown(exitCode: number): Promise<void> {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;

  await cleanupBeforeExit();
  process.exit(exitCode);
}

async function cleanupBeforeExit(): Promise<void> {
  if (botManager) {
    await botManager.shutdownAll();
  }
  const activeServer = server;
  if (activeServer) {
    await new Promise<void>((resolve) => {
      activeServer.close(() => resolve());
    });
    server = null;
  }
  if (instanceLock) {
    await instanceLock.release();
  }
}

function sanitizeError(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  return raw.split(/\r?\n/).slice(0, 12).join("\n");
}

function parseDeleteModeFromRequest(body: unknown): "soft" | "purge_data" | "purge_all" {
  const payload = isRecord(body) ? body : {};
  const value = String(payload.deleteMode ?? "")
    .trim()
    .toLowerCase();
  if (value === "soft" || value === "purge_data" || value === "purge_all") {
    return value;
  }
  return "soft";
}

function startCodexDeviceAuthSession(): DeviceAuthSession {
  if (codexDeviceAuthSession && isDeviceAuthActive(codexDeviceAuthSession.status)) {
    return codexDeviceAuthSession;
  }

  const codexBin = String(config.codexBin ?? "codex").trim() || "codex";
  const session: DeviceAuthSession = {
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

function cancelCodexDeviceAuthSession(): boolean {
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

function getCodexDeviceAuthSnapshot(): {
  status: DeviceAuthStatus | "idle";
  startedAt?: string;
  loginUrl?: string;
  code?: string;
  detail?: string;
  restartedBots?: string[];
  restartFailures?: RestartFailure[];
} {
  const session = codexDeviceAuthSession;
  if (!session) {
    return { status: "idle" };
  }

  return {
    status: session.status,
    startedAt: session.startedAt,
    ...(session.loginUrl ? { loginUrl: session.loginUrl } : {}),
    ...(session.code ? { code: session.code } : {}),
    ...(session.error ? { detail: session.error } : {}),
    restartedBots: session.restartedBots,
    restartFailures: session.restartFailures,
  };
}

async function waitForDeviceCode(session: DeviceAuthSession, timeoutMs: number): Promise<boolean> {
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

function appendDeviceAuthOutput(session: DeviceAuthSession, chunk: unknown): void {
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

function findDeviceLoginUrl(lines: string[]): string {
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

function findDeviceCode(lines: string[]): string {
  for (const line of lines) {
    const match = line.match(/\b[A-Z0-9]{4}-[A-Z0-9]{5}\b/);
    if (match?.[0]) {
      return match[0];
    }
  }
  return "";
}

function stripAnsi(value: unknown): string {
  return String(value ?? "").replace(ANSI_ESCAPE_PATTERN, "");
}

function isDeviceAuthActive(status: unknown): boolean {
  const value = String(status ?? "")
    .trim()
    .toLowerCase();
  return value === "starting" || value === "pending";
}

function createSessionId(): string {
  return randomBytes(8).toString("hex");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function readCodexLoginStatus(): { configured: boolean; codexBin: string; detail: string } {
  const codexBin = String(config.codexBin ?? "codex").trim() || "codex";
  const status = runCodexCommand(["login", "status"]);
  return {
    configured: status.ok,
    codexBin,
    detail: firstNonEmptyLine(status.errorMessage, status.stderr, status.stdout),
  };
}

async function readCodexModelCatalog(): Promise<
  | { ok: true; codexBin: string; models: ModelCatalogEntry[] }
  | { ok: false; codexBin: string; error: string }
> {
  const codexBin = String(config.codexBin ?? "codex").trim() || "codex";
  const client = new CodexAppClient({
    codexBin,
    codexHomeDir: config.codexHomeDir ?? null,
    cwd: config.kernelRootPath,
    sandboxMode: config.codexSandbox,
    approvalPolicy: config.codexApprovalPolicy,
    model: null,
    turnActivityTimeoutMs: Math.min(config.turnActivityTimeoutMs, 60_000),
  });

  try {
    const models = await client.listModels({ limit: 200 });
    return {
      ok: true,
      codexBin,
      models: normalizeModelCatalog(models),
    };
  } catch (error) {
    return {
      ok: false,
      codexBin,
      error: sanitizeError(error) || "Could not load model catalog from Codex.",
    };
  } finally {
    await client.shutdown().catch(() => {
      // Best effort only.
    });
  }
}

function normalizeModelCatalog(rawModels: unknown): ModelCatalogEntry[] {
  const seen = new Set<string>();
  const normalized: ModelCatalogEntry[] = [];

  for (const entry of Array.isArray(rawModels) ? rawModels : []) {
    const model = String(entry?.model ?? entry?.id ?? "").trim();
    if (!model || seen.has(model)) {
      continue;
    }
    seen.add(model);
    normalized.push({
      id: String(entry?.id ?? model).trim() || model,
      model,
      displayName: String(entry?.displayName ?? model).trim() || model,
      description: String(entry?.description ?? "").trim(),
      isDefault: entry?.isDefault === true,
    });
  }

  return normalized.sort((a, b) => {
    if (a.isDefault !== b.isDefault) {
      return a.isDefault ? -1 : 1;
    }
    return a.displayName.localeCompare(b.displayName);
  });
}

function looksLikeCodexApiKey(value: unknown): boolean {
  const key = String(value ?? "").trim();
  if (key.length < 20 || key.length > 4096) {
    return false;
  }
  if (!/^[A-Za-z0-9._-]+$/.test(key)) {
    return false;
  }
  return key.startsWith("sk-");
}

function runCodexCommand(
  args: string[],
  { inputText = "" }: { inputText?: string } = {},
): RunCodexCommandResult {
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

  const status = typeof result.status === "number" ? result.status : 1;
  return {
    ok: status === 0,
    status,
    stdout: String(result.stdout ?? "").trim(),
    stderr: String(result.stderr ?? "").trim(),
    errorMessage: "",
  };
}

function formatCodexSpawnError(codexBin: string, error: unknown): string {
  const code = String(isErrnoException(error) ? (error.code ?? "") : "")
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

function firstNonEmptyLine(...values: unknown[]): string {
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

function redactSecret(text: unknown, secret: unknown): string {
  const input = String(text ?? "");
  const token = String(secret ?? "").trim();
  if (!token) {
    return input;
  }
  return input.split(token).join("[redacted]");
}

function requireBotManager(): BotManager {
  if (!botManager) {
    throw new Error("Bot manager is not initialized.");
  }
  return botManager;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object";
}

function isErrnoException(error: unknown): error is NodeJS.ErrnoException {
  return isRecord(error);
}

async function restartRunningBots(): Promise<{
  restartedBotIds: string[];
  failures: RestartFailure[];
}> {
  const manager = requireBotManager();
  const statuses = await manager.listBotsLive();
  const runningBotIds: string[] = [];
  for (const entry of statuses) {
    if (!isRecord(entry) || entry.running !== true) {
      continue;
    }
    const botId = String(entry.id ?? "").trim();
    if (botId) {
      runningBotIds.push(botId);
    }
  }

  const restartedBotIds = [];
  const failures = [];

  for (const botId of runningBotIds) {
    try {
      await manager.stopBot(botId);
      await manager.startBot(botId);
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
