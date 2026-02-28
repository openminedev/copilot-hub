// @ts-nocheck
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { AgentSupervisor } from "./agent-supervisor.js";

export class BotManager {
  constructor({
    botDefinitions,
    providerDefaults,
    turnActivityTimeoutMs,
    maxMessages,
    webPublicBaseUrl,
    projectsBaseDir,
    workerScriptPath,
    botDataRootDir = null,
    onKernelAction = null,
    heartbeatEnabled = true,
    heartbeatIntervalMs = 5000,
    heartbeatTimeoutMs = 4000,
  }) {
    this.supervisors = new Map();
    this.providerDefaults = providerDefaults;
    this.turnActivityTimeoutMs = turnActivityTimeoutMs;
    this.maxMessages = maxMessages;
    this.webPublicBaseUrl = webPublicBaseUrl;
    this.projectsBaseDir = path.resolve(projectsBaseDir);
    this.botDataRootDir = botDataRootDir ? path.resolve(botDataRootDir) : null;
    this.workerScriptPath = path.resolve(String(workerScriptPath ?? ""));
    if (!String(workerScriptPath ?? "").trim()) {
      throw new Error("workerScriptPath is required.");
    }
    this.kernelActionHandler = typeof onKernelAction === "function" ? onKernelAction : null;
    this.heartbeatEnabled = heartbeatEnabled;
    this.heartbeatIntervalMs = heartbeatIntervalMs;
    this.heartbeatTimeoutMs = heartbeatTimeoutMs;
    this.heartbeatTimer = null;
    this.heartbeatRunning = false;

    for (const definition of botDefinitions) {
      const supervisor = this.#createSupervisor(definition);
      this.supervisors.set(definition.id, supervisor);
    }
  }

  getBotCount() {
    return this.supervisors.size;
  }

  hasBot(botId) {
    return this.supervisors.has(String(botId));
  }

  setKernelActionHandler(handler) {
    this.kernelActionHandler = typeof handler === "function" ? handler : null;
  }

  setWebPublicBaseUrl(value) {
    this.webPublicBaseUrl = value;
    for (const supervisor of this.supervisors.values()) {
      supervisor.setWebPublicBaseUrl(value);
    }
  }

  async startAutoBots() {
    for (const supervisor of this.supervisors.values()) {
      if (supervisor.config.enabled !== false) {
        await supervisor.boot();
      }
    }
    this.startHeartbeatScheduler();
  }

  listBots() {
    return [...this.supervisors.values()].map((supervisor) => supervisor.getStatus());
  }

  async listBotsLive() {
    const statuses = [];
    for (const supervisor of this.supervisors.values()) {
      try {
        statuses.push(await supervisor.refreshStatus());
      } catch {
        statuses.push(supervisor.getStatus());
      }
    }
    return statuses;
  }

  getBot(botId) {
    const supervisor = this.supervisors.get(String(botId));
    if (!supervisor) {
      throw new Error(`Unknown bot '${botId}'.`);
    }
    return supervisor;
  }

  async getBotStatus(botId) {
    const supervisor = this.getBot(botId);
    return supervisor.refreshStatus();
  }

  async startBot(botId) {
    const supervisor = this.getBot(botId);
    return supervisor.startChannels();
  }

  async stopBot(botId) {
    const supervisor = this.getBot(botId);
    return supervisor.stopChannels();
  }

  async resetWebThread(botId) {
    const supervisor = this.getBot(botId);
    return supervisor.resetWebThread();
  }

  async listBotApprovals(botId, threadId) {
    const supervisor = this.getBot(botId);
    return supervisor.listPendingApprovals(threadId);
  }

  async resolveBotApproval(botId, { threadId, approvalId, decision }) {
    const supervisor = this.getBot(botId);
    return supervisor.resolvePendingApproval({
      threadId,
      approvalId,
      decision,
    });
  }

  async listBotCapabilities(botId) {
    const supervisor = this.getBot(botId);
    return supervisor.listCapabilities();
  }

  setBotCapabilities(botId, nextCapabilities) {
    const supervisor = this.getBot(botId);
    supervisor.setCapabilities(nextCapabilities);
    return supervisor.getStatus();
  }

  async setBotProviderOptions(botId, providerOptions) {
    const supervisor = this.getBot(botId);
    return supervisor.setProviderOptions(providerOptions);
  }

  async reloadBotCapabilities(botId, nextCapabilities = null) {
    const supervisor = this.getBot(botId);
    return supervisor.reloadCapabilities(nextCapabilities);
  }

  async shutdownAll() {
    this.stopHeartbeatScheduler();
    for (const supervisor of this.supervisors.values()) {
      await supervisor.shutdown();
    }
  }

  async registerBot(definition, { startIfEnabled = true } = {}) {
    const id = String(definition?.id ?? "").trim();
    if (!id) {
      throw new Error("Bot definition id is required.");
    }
    if (this.supervisors.has(id)) {
      throw new Error(`Bot '${id}' already exists.`);
    }

    const supervisor = this.#createSupervisor(definition);
    this.supervisors.set(id, supervisor);

    if (startIfEnabled && definition.enabled !== false) {
      await supervisor.boot();
    }

    return supervisor.getStatus();
  }

  async removeBot(botId, { purgeData = false, purgeWorkspace = false } = {}) {
    const id = String(botId ?? "").trim();
    if (!id) {
      throw new Error("botId is required.");
    }

    const supervisor = this.getBot(id);
    this.supervisors.delete(id);

    try {
      await supervisor.shutdown();
      if (purgeData) {
        await this.#purgeBotDataDir(supervisor.config?.dataDir);
      }
      if (purgeWorkspace) {
        await this.#purgeBotWorkspace(supervisor.config?.workspaceRoot);
      }
    } catch (error) {
      this.supervisors.set(id, supervisor);
      throw error;
    }

    return {
      id,
      removed: true,
      purgeData,
      purgeWorkspace,
    };
  }

  async listProjects() {
    await fs.mkdir(this.projectsBaseDir, { recursive: true });
    const entries = await fs.readdir(this.projectsBaseDir, { withFileTypes: true });
    const projects = entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => ({
        name: entry.name,
        path: path.join(this.projectsBaseDir, entry.name),
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
    return {
      baseDir: this.projectsBaseDir,
      projects,
    };
  }

  async createProject(projectName) {
    const normalized = normalizeProjectName(projectName);
    const projectPath = resolveProjectPath(this.projectsBaseDir, normalized);
    await fs.mkdir(projectPath, { recursive: true });
    return {
      name: normalized,
      path: projectPath,
    };
  }

  async setBotProject(botId, projectName) {
    const supervisor = this.getBot(botId);
    const normalized = normalizeProjectName(projectName);
    const projectPath = resolveProjectPath(this.projectsBaseDir, normalized);
    const stat = await fs.stat(projectPath).catch(() => null);
    if (!stat || !stat.isDirectory()) {
      throw new Error(`Project '${normalized}' does not exist in ${this.projectsBaseDir}.`);
    }

    return supervisor.setProjectRoot(projectPath);
  }

  #createSupervisor(definition) {
    return new AgentSupervisor({
      botConfig: definition,
      providerDefaults: this.providerDefaults,
      turnActivityTimeoutMs: this.turnActivityTimeoutMs,
      maxMessages: this.maxMessages,
      webPublicBaseUrl: this.webPublicBaseUrl,
      workerScriptPath: this.workerScriptPath,
      onKernelAction: (request) => this.#dispatchKernelAction(request),
    });
  }

  async #dispatchKernelAction(request) {
    if (!this.kernelActionHandler) {
      throw new Error("Kernel action handler is not configured.");
    }
    return this.kernelActionHandler(request);
  }

  startHeartbeatScheduler() {
    if (!this.heartbeatEnabled || this.heartbeatTimer) {
      return;
    }

    this.heartbeatTimer = setInterval(() => {
      void this.#runHeartbeatTick();
    }, this.heartbeatIntervalMs);
    if (typeof this.heartbeatTimer.unref === "function") {
      this.heartbeatTimer.unref();
    }
  }

  stopHeartbeatScheduler() {
    if (!this.heartbeatTimer) {
      return;
    }
    clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null;
  }

  async #runHeartbeatTick() {
    if (this.heartbeatRunning) {
      return;
    }
    this.heartbeatRunning = true;
    try {
      for (const supervisor of this.supervisors.values()) {
        await supervisor.heartbeat({ timeoutMs: this.heartbeatTimeoutMs });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`Heartbeat tick error: ${message}`);
    } finally {
      this.heartbeatRunning = false;
    }
  }

  async #purgeBotDataDir(dataDir) {
    if (!this.botDataRootDir) {
      throw new Error("botDataRootDir is not configured, cannot purge bot data.");
    }

    const target = path.resolve(String(dataDir ?? ""));
    if (!target) {
      throw new Error("Invalid bot data directory.");
    }
    if (!isSubPath(target, this.botDataRootDir)) {
      throw new Error(`Refusing to purge outside bot data root: ${target}`);
    }
    await fs.rm(target, { recursive: true, force: true });
  }

  async #purgeBotWorkspace(workspaceRoot) {
    const target = path.resolve(String(workspaceRoot ?? ""));
    if (!target) {
      throw new Error("Invalid bot workspace directory.");
    }

    assertSafePurgeTarget(target, {
      label: "workspace",
      protectedPaths: [
        path.parse(target).root,
        process.cwd(),
        os.homedir(),
        this.projectsBaseDir,
        this.botDataRootDir,
      ].filter(Boolean),
    });

    await fs.rm(target, { recursive: true, force: true });
  }
}

const PROJECT_NAME_PATTERN = /^[A-Za-z0-9._-]{1,80}$/;

function normalizeProjectName(value) {
  const name = String(value ?? "").trim();
  if (!PROJECT_NAME_PATTERN.test(name)) {
    throw new Error("Invalid project name. Allowed: letters, numbers, dot, underscore, dash.");
  }
  return name;
}

function resolveProjectPath(baseDir, projectName) {
  const full = path.resolve(baseDir, projectName);
  const resolvedBase = path.resolve(baseDir);
  const normalizedBase = `${resolvedBase}${path.sep}`;
  if (full !== resolvedBase && !full.startsWith(normalizedBase)) {
    throw new Error("Project path escapes projects base directory.");
  }
  return full;
}

function isSubPath(candidatePath, rootPath) {
  const normalizedRoot = path.resolve(rootPath);
  const normalizedCandidate = path.resolve(candidatePath);
  if (normalizedCandidate === normalizedRoot) {
    return false;
  }
  const rootWithSep = normalizedRoot.endsWith(path.sep)
    ? normalizedRoot
    : `${normalizedRoot}${path.sep}`;
  return normalizedCandidate.startsWith(rootWithSep);
}

function assertSafePurgeTarget(targetPath, { label, protectedPaths }) {
  const normalizedTarget = path.resolve(String(targetPath ?? ""));
  const root = path.parse(normalizedTarget).root;
  if (normalizedTarget === root) {
    throw new Error(`Refusing to purge ${label} root directory: ${normalizedTarget}`);
  }

  for (const entry of protectedPaths) {
    const protectedPath = path.resolve(String(entry));
    if (!protectedPath) {
      continue;
    }
    if (normalizedTarget === protectedPath) {
      throw new Error(`Refusing to purge protected ${label} path: ${normalizedTarget}`);
    }
    if (isSubPath(protectedPath, normalizedTarget)) {
      throw new Error(
        `Refusing to purge ${label} path that contains protected path: ${normalizedTarget}`,
      );
    }
  }
}
