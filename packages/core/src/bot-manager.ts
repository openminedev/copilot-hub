import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { AgentSupervisor } from "./agent-supervisor.js";

type KernelActionRequest = Record<string, unknown>;
type KernelActionHandler = (request: KernelActionRequest) => Promise<unknown> | unknown;

type BotDefinition = {
  id: string;
  name: string;
  enabled?: boolean;
  autoStart?: boolean;
  dataDir: string;
  workspaceRoot: string;
  threadMode?: string;
  sharedThreadId?: string;
  provider?: {
    kind?: string;
    options?: Record<string, unknown>;
  };
  kernelAccess?: {
    enabled?: boolean;
    allowedActions?: unknown;
    allowedChatIds?: unknown;
  };
  capabilities?: unknown[];
  channels?: unknown[];
} & Record<string, unknown>;

type ProviderDefaults = Record<string, unknown>;

type SupervisorStatus = ReturnType<AgentSupervisor["getStatus"]>;

export class BotManager {
  supervisors: Map<string, AgentSupervisor>;
  providerDefaults: ProviderDefaults;
  turnActivityTimeoutMs: number;
  maxMessages: number;
  webPublicBaseUrl: string;
  projectsBaseDir: string;
  botDataRootDir: string | null;
  workerScriptPath: string;
  kernelActionHandler: KernelActionHandler | null;
  heartbeatEnabled: boolean;
  heartbeatIntervalMs: number;
  heartbeatTimeoutMs: number;
  heartbeatTimer: ReturnType<typeof setInterval> | null;
  heartbeatRunning: boolean;

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
  }: {
    botDefinitions: BotDefinition[];
    providerDefaults: ProviderDefaults;
    turnActivityTimeoutMs: number;
    maxMessages: number;
    webPublicBaseUrl: string;
    projectsBaseDir: string;
    workerScriptPath: string;
    botDataRootDir?: string | null;
    onKernelAction?: KernelActionHandler | null;
    heartbeatEnabled?: boolean;
    heartbeatIntervalMs?: number;
    heartbeatTimeoutMs?: number;
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

  getBotCount(): number {
    return this.supervisors.size;
  }

  hasBot(botId: string): boolean {
    return this.supervisors.has(String(botId));
  }

  setKernelActionHandler(handler: KernelActionHandler | null): void {
    this.kernelActionHandler = typeof handler === "function" ? handler : null;
  }

  setWebPublicBaseUrl(value: string): void {
    this.webPublicBaseUrl = value;
    for (const supervisor of this.supervisors.values()) {
      supervisor.setWebPublicBaseUrl(value);
    }
  }

  async startAutoBots(): Promise<void> {
    for (const supervisor of this.supervisors.values()) {
      if (supervisor.config.enabled !== false) {
        await supervisor.boot();
      }
    }
    this.startHeartbeatScheduler();
  }

  listBots(): SupervisorStatus[] {
    return [...this.supervisors.values()].map((supervisor) => supervisor.getStatus());
  }

  async listBotsLive(): Promise<SupervisorStatus[]> {
    const statuses: SupervisorStatus[] = [];
    for (const supervisor of this.supervisors.values()) {
      try {
        statuses.push(await supervisor.refreshStatus());
      } catch {
        statuses.push(supervisor.getStatus());
      }
    }
    return statuses;
  }

  getBot(botId: string): AgentSupervisor {
    const supervisor = this.supervisors.get(String(botId));
    if (!supervisor) {
      throw new Error(`Unknown bot '${botId}'.`);
    }
    return supervisor;
  }

  async getBotStatus(botId: string): Promise<SupervisorStatus> {
    const supervisor = this.getBot(botId);
    return supervisor.refreshStatus();
  }

  async startBot(botId: string): Promise<SupervisorStatus> {
    const supervisor = this.getBot(botId);
    return supervisor.startChannels();
  }

  async stopBot(botId: string): Promise<SupervisorStatus> {
    const supervisor = this.getBot(botId);
    return supervisor.stopChannels();
  }

  async resetWebThread(botId: string): Promise<unknown> {
    const supervisor = this.getBot(botId);
    return supervisor.resetWebThread();
  }

  async listBotApprovals(botId: string, threadId?: string): Promise<unknown[]> {
    const supervisor = this.getBot(botId);
    const approvals = await supervisor.listPendingApprovals(threadId);
    return Array.isArray(approvals) ? approvals : [];
  }

  async resolveBotApproval(
    botId: string,
    { threadId, approvalId, decision }: { threadId: string; approvalId: string; decision: string },
  ): Promise<unknown> {
    const supervisor = this.getBot(botId);
    return supervisor.resolvePendingApproval({
      threadId,
      approvalId,
      decision,
    });
  }

  async listBotCapabilities(botId: string): Promise<unknown> {
    const supervisor = this.getBot(botId);
    return supervisor.listCapabilities();
  }

  setBotCapabilities(botId: string, nextCapabilities: unknown): SupervisorStatus {
    const supervisor = this.getBot(botId);
    supervisor.setCapabilities(nextCapabilities);
    return supervisor.getStatus();
  }

  async setBotProviderOptions(
    botId: string,
    providerOptions: Record<string, unknown>,
  ): Promise<SupervisorStatus> {
    const supervisor = this.getBot(botId);
    return supervisor.setProviderOptions(providerOptions);
  }

  async refreshBotProviderSession(
    botId: string,
    reason = "manual provider session refresh",
  ): Promise<SupervisorStatus> {
    const supervisor = this.getBot(botId);
    return supervisor.refreshProviderSession(reason);
  }

  async reloadBotCapabilities(
    botId: string,
    nextCapabilities: unknown = null,
  ): Promise<SupervisorStatus> {
    const supervisor = this.getBot(botId);
    return supervisor.reloadCapabilities(
      nextCapabilities as Parameters<AgentSupervisor["reloadCapabilities"]>[0],
    );
  }

  async shutdownAll(): Promise<void> {
    this.stopHeartbeatScheduler();
    for (const supervisor of this.supervisors.values()) {
      await supervisor.shutdown();
    }
  }

  async registerBot(
    definition: BotDefinition,
    { startIfEnabled = true }: { startIfEnabled?: boolean } = {},
  ): Promise<SupervisorStatus> {
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

  async removeBot(
    botId: string,
    {
      purgeData = false,
      purgeWorkspace = false,
    }: { purgeData?: boolean; purgeWorkspace?: boolean } = {},
  ): Promise<{
    id: string;
    removed: true;
    purgeData: boolean;
    purgeWorkspace: boolean;
  }> {
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

  async listProjects(): Promise<{
    baseDir: string;
    projects: Array<{ name: string; path: string }>;
  }> {
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

  async createProject(projectName: string): Promise<{ name: string; path: string }> {
    const normalized = normalizeProjectName(projectName);
    const projectPath = resolveProjectPath(this.projectsBaseDir, normalized);
    await fs.mkdir(projectPath, { recursive: true });
    return {
      name: normalized,
      path: projectPath,
    };
  }

  async setBotProject(botId: string, projectName: string): Promise<SupervisorStatus> {
    const supervisor = this.getBot(botId);
    const normalized = normalizeProjectName(projectName);
    const projectPath = resolveProjectPath(this.projectsBaseDir, normalized);
    const stat = await fs.stat(projectPath).catch(() => null);
    if (!stat || !stat.isDirectory()) {
      throw new Error(`Project '${normalized}' does not exist in ${this.projectsBaseDir}.`);
    }

    return supervisor.setProjectRoot(projectPath);
  }

  #createSupervisor(definition: BotDefinition): AgentSupervisor {
    return new AgentSupervisor({
      botConfig: definition,
      providerDefaults: this.providerDefaults,
      turnActivityTimeoutMs: this.turnActivityTimeoutMs,
      maxMessages: this.maxMessages,
      webPublicBaseUrl: this.webPublicBaseUrl,
      workerScriptPath: this.workerScriptPath,
      onKernelAction: (request: KernelActionRequest) => this.#dispatchKernelAction(request),
    });
  }

  async #dispatchKernelAction(request: KernelActionRequest): Promise<unknown> {
    if (!this.kernelActionHandler) {
      throw new Error("Kernel action handler is not configured.");
    }
    return this.kernelActionHandler(request);
  }

  startHeartbeatScheduler(): void {
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

  stopHeartbeatScheduler(): void {
    if (!this.heartbeatTimer) {
      return;
    }
    clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null;
  }

  async #runHeartbeatTick(): Promise<void> {
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

  async #purgeBotDataDir(dataDir: unknown): Promise<void> {
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

  async #purgeBotWorkspace(workspaceRoot: unknown): Promise<void> {
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

function normalizeProjectName(value: unknown): string {
  const name = String(value ?? "").trim();
  if (!PROJECT_NAME_PATTERN.test(name)) {
    throw new Error("Invalid project name. Allowed: letters, numbers, dot, underscore, dash.");
  }
  return name;
}

function resolveProjectPath(baseDir: string, projectName: string): string {
  const full = path.resolve(baseDir, projectName);
  const resolvedBase = path.resolve(baseDir);
  const normalizedBase = `${resolvedBase}${path.sep}`;
  if (full !== resolvedBase && !full.startsWith(normalizedBase)) {
    throw new Error("Project path escapes projects base directory.");
  }
  return full;
}

function isSubPath(candidatePath: string, rootPath: string): boolean {
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

function assertSafePurgeTarget(
  targetPath: string,
  { label, protectedPaths }: { label: string; protectedPaths: Array<string | null> },
): void {
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
