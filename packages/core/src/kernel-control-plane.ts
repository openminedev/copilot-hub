import fs from "node:fs/promises";
import path from "node:path";
import {
  loadBotRegistry,
  type LoadBotRegistryOptions,
  type NormalizedBotDefinition,
} from "./bot-registry.js";
import {
  scaffoldCapabilityInWorkspace,
  normalizeCapabilityId,
  normalizeCapabilityName,
} from "./capability-scaffold.js";
import { CONTROL_ACTIONS, requireControlAction } from "./control-plane-actions.js";
import { getExtensionContract } from "./extension-contract.js";
import { assertControlPermission } from "./control-permission.js";
import type { KernelSecretStore } from "./secret-store.js";

type DeleteMode = "soft" | "purge_data" | "purge_all";
type SandboxMode = "read-only" | "workspace-write" | "danger-full-access";
type ApprovalPolicy = "on-request" | "on-failure" | "never";
type ReasoningEffort = "none" | "minimal" | "low" | "medium" | "high" | "xhigh";
type ServiceTier = "fast" | "flex";
type ControlAction = (typeof CONTROL_ACTIONS)[keyof typeof CONTROL_ACTIONS];

type RegistryAgent = Record<string, unknown>;
type RegistryJson = {
  version: number;
  agents: RegistryAgent[];
} & Record<string, unknown>;

type KernelBotManager = {
  getBot: (botId: string) => unknown;
  listBotsLive: () => Promise<unknown[]>;
  getBotStatus: (botId: string) => Promise<unknown>;
  startBot: (botId: string) => Promise<unknown>;
  stopBot: (botId: string) => Promise<unknown>;
  registerBot: (
    definition: NormalizedBotDefinition,
    options?: { startIfEnabled?: boolean },
  ) => Promise<unknown>;
  removeBot: (
    botId: string,
    options?: { purgeData?: boolean; purgeWorkspace?: boolean },
  ) => Promise<{ purgeData?: boolean; purgeWorkspace?: boolean }>;
  setBotProject: (botId: string, projectName: string) => Promise<unknown>;
  listProjects: () => Promise<unknown>;
  createProject: (name: string) => Promise<unknown>;
  setBotProviderOptions: (botId: string, options: Record<string, unknown>) => Promise<unknown>;
  listBotCapabilities: (botId: string) => Promise<unknown>;
  reloadBotCapabilities: (botId: string, nextCapabilities?: unknown) => Promise<unknown>;
  setBotCapabilities: (botId: string, nextCapabilities: unknown) => unknown;
};

type KernelActionContext = {
  source?: unknown;
  metadata?: {
    channelId?: unknown;
    chatId?: unknown;
  } | null;
};

type KernelActionRequest = {
  actorBotId: string;
  action: unknown;
  payload?: unknown;
  context?: KernelActionContext;
};

type RegistryLoadOptions = Partial<Omit<LoadBotRegistryOptions, "filePath" | "resolveSecret">>;

type SecretsDeleteResult = {
  name: string;
  deleted: boolean;
  error?: string;
};

export class KernelControlPlane {
  botManager: KernelBotManager;
  registryFilePath: string;
  registryLoadOptions: RegistryLoadOptions;
  secretStore: KernelSecretStore | null;
  registryMutationTail: Promise<void>;

  constructor({
    botManager,
    registryFilePath,
    registryLoadOptions,
    secretStore = null,
  }: {
    botManager: KernelBotManager;
    registryFilePath: string;
    registryLoadOptions?: RegistryLoadOptions;
    secretStore?: KernelSecretStore | null;
  }) {
    this.botManager = botManager;
    this.registryFilePath = path.resolve(String(registryFilePath));
    this.registryLoadOptions =
      registryLoadOptions && typeof registryLoadOptions === "object" ? registryLoadOptions : {};
    this.secretStore = secretStore;
    this.registryMutationTail = Promise.resolve();
  }

  async handleAgentAction({
    actorBotId,
    action,
    payload,
    context,
  }: KernelActionRequest): Promise<unknown> {
    const normalizedAction = requireControlAction(action);
    const supervisor = this.botManager.getBot(actorBotId);
    const permissionPayload: Parameters<typeof assertControlPermission>[0] = {
      supervisor: supervisor as Parameters<typeof assertControlPermission>[0]["supervisor"],
      action: normalizedAction,
      source: context?.source,
      metadata: context?.metadata ?? null,
    };
    assertControlPermission(permissionPayload);
    return this.#executeAction({
      action: normalizedAction,
      payload,
      actorBotId,
    });
  }

  async runSystemAction(action: unknown, payload: unknown): Promise<unknown> {
    const normalizedAction = requireControlAction(action);
    return this.#executeAction({
      action: normalizedAction,
      payload,
      actorBotId: null,
    });
  }

  async #executeAction({
    action,
    payload,
    actorBotId,
  }: {
    action: ControlAction;
    payload: unknown;
    actorBotId: string | null;
  }): Promise<unknown> {
    const safePayload =
      payload && typeof payload === "object" ? (payload as Record<string, unknown>) : {};

    switch (action) {
      case CONTROL_ACTIONS.BOTS_LIST: {
        const bots = await this.botManager.listBotsLive();
        return { bots };
      }

      case CONTROL_ACTIONS.BOTS_STATUS: {
        const botId = requireNonEmptyString(safePayload.botId, "payload.botId");
        const bot = await this.botManager.getBotStatus(botId);
        return { bot };
      }

      case CONTROL_ACTIONS.BOTS_START: {
        const botId = requireNonEmptyString(safePayload.botId, "payload.botId");
        const bot = await this.botManager.startBot(botId);
        return { bot };
      }

      case CONTROL_ACTIONS.BOTS_STOP: {
        const botId = requireNonEmptyString(safePayload.botId, "payload.botId");
        const bot = await this.botManager.stopBot(botId);
        return { bot };
      }

      case CONTROL_ACTIONS.BOTS_CREATE: {
        const agent = safePayload.agent;
        if (!agent || typeof agent !== "object") {
          throw new Error("payload.agent is required.");
        }
        const startIfEnabled = safePayload.startIfEnabled !== false;
        const created = await this.#withRegistryMutationLock(() =>
          this.#createBot({
            rawAgent: agent as RegistryAgent,
            startIfEnabled,
          }),
        );
        return created;
      }

      case CONTROL_ACTIONS.BOTS_DELETE: {
        const botId = requireNonEmptyString(safePayload.botId, "payload.botId");
        if (actorBotId && botId === actorBotId) {
          throw new Error("An active agent cannot delete itself while it is active.");
        }
        const deleteMode = parseDeleteMode(safePayload);
        const purgeData = deleteMode === "purge_data" || deleteMode === "purge_all";
        const purgeWorkspace = deleteMode === "purge_all";
        if (purgeWorkspace) {
          ensureSecretStore(this.secretStore);
        }
        const deleted = await this.#withRegistryMutationLock(() =>
          this.#deleteBot({
            botId,
            deleteMode,
            purgeData,
            purgeWorkspace,
          }),
        );
        return {
          deleted: true,
          ...deleted,
        };
      }

      case CONTROL_ACTIONS.BOTS_SET_PROJECT: {
        const botId = requireNonEmptyString(safePayload.botId, "payload.botId");
        const projectName = requireNonEmptyString(safePayload.projectName, "payload.projectName");
        const bot = await this.botManager.setBotProject(botId, projectName);
        return { bot };
      }

      case CONTROL_ACTIONS.PROJECTS_LIST: {
        return this.botManager.listProjects();
      }

      case CONTROL_ACTIONS.PROJECTS_CREATE: {
        const name = requireNonEmptyString(safePayload.name, "payload.name");
        const project = await this.botManager.createProject(name);
        return { project };
      }

      case CONTROL_ACTIONS.BOTS_SET_POLICY: {
        const botId = requireNonEmptyString(safePayload.botId, "payload.botId");
        const sandboxMode = requireSandboxMode(safePayload.sandboxMode);
        const approvalPolicy = requireApprovalPolicy(safePayload.approvalPolicy);
        const hasModelOverride = Object.prototype.hasOwnProperty.call(safePayload, "model");
        const hasReasoningEffortOverride = Object.prototype.hasOwnProperty.call(
          safePayload,
          "reasoningEffort",
        );
        const hasServiceTierOverride = Object.prototype.hasOwnProperty.call(
          safePayload,
          "serviceTier",
        );
        const model = hasModelOverride ? requireOptionalModel(safePayload.model) : undefined;
        const reasoningEffort = hasReasoningEffortOverride
          ? requireOptionalReasoningEffort(safePayload.reasoningEffort)
          : undefined;
        const serviceTier = hasServiceTierOverride
          ? requireOptionalServiceTier(safePayload.serviceTier)
          : undefined;
        const policyPayload: {
          botId: string;
          sandboxMode: SandboxMode;
          approvalPolicy: ApprovalPolicy;
          model?: string | null;
          reasoningEffort?: ReasoningEffort | null;
          serviceTier?: ServiceTier | null;
        } = {
          botId,
          sandboxMode,
          approvalPolicy,
        };
        if (hasModelOverride && model !== undefined) {
          policyPayload.model = model;
        }
        if (hasReasoningEffortOverride && reasoningEffort !== undefined) {
          policyPayload.reasoningEffort = reasoningEffort;
        }
        if (hasServiceTierOverride && serviceTier !== undefined) {
          policyPayload.serviceTier = serviceTier;
        }
        return this.#withRegistryMutationLock(() => this.#setBotPolicy(policyPayload));
      }

      case CONTROL_ACTIONS.BOTS_CAPABILITIES_LIST: {
        const botId = requireNonEmptyString(safePayload.botId, "payload.botId");
        const capabilities = await this.botManager.listBotCapabilities(botId);
        return {
          botId,
          capabilities,
        };
      }

      case CONTROL_ACTIONS.BOTS_CAPABILITIES_RELOAD: {
        const botId = requireNonEmptyString(safePayload.botId, "payload.botId");
        const bot = await this.botManager.reloadBotCapabilities(botId);
        return { bot };
      }

      case CONTROL_ACTIONS.BOTS_CAPABILITIES_SCAFFOLD: {
        const botId = requireNonEmptyString(safePayload.botId, "payload.botId");
        const capabilityId = normalizeCapabilityId(safePayload.capabilityId);
        const capabilityName = normalizeCapabilityName(safePayload.capabilityName, capabilityId);
        const result = await this.#withRegistryMutationLock(() =>
          this.#scaffoldCapability({
            botId,
            capabilityId,
            capabilityName,
          }),
        );
        return result;
      }

      case CONTROL_ACTIONS.SECRETS_LIST: {
        ensureSecretStore(this.secretStore);
        return {
          secrets: this.secretStore.listSecretNames(),
        };
      }

      case CONTROL_ACTIONS.SECRETS_SET: {
        ensureSecretStore(this.secretStore);
        const name = requireNonEmptyString(safePayload.name, "payload.name");
        const value = requireNonEmptyString(safePayload.value, "payload.value");
        const secret = await this.secretStore.setSecret(name, value);
        return { secret };
      }

      case CONTROL_ACTIONS.SECRETS_DELETE: {
        ensureSecretStore(this.secretStore);
        const name = requireNonEmptyString(safePayload.name, "payload.name");
        const secret = await this.secretStore.deleteSecret(name);
        return { secret };
      }

      case CONTROL_ACTIONS.EXTENSIONS_CONTRACT_GET: {
        return getExtensionContract();
      }

      default: {
        throw new Error(`Unsupported control action '${action}'.`);
      }
    }
  }

  async #createBot({
    rawAgent,
    startIfEnabled,
  }: {
    rawAgent: RegistryAgent;
    startIfEnabled: boolean;
  }): Promise<{
    bot: unknown;
    paths: {
      workspaceRoot: { path: string; existed: boolean };
      dataDir: { path: string; existed: boolean };
    };
  }> {
    const requestedId = requireNonEmptyString(rawAgent.id, "agent.id");

    const previousRegistryText = await fs.readFile(this.registryFilePath, "utf8");
    const previousRegistry = parseRegistryJson(previousRegistryText, this.registryFilePath);

    if (
      previousRegistry.agents.some(
        (entry) => String((entry as RegistryAgent)?.id ?? "").trim() === requestedId,
      )
    ) {
      throw new Error(`Bot '${requestedId}' already exists.`);
    }

    const nextRegistry = {
      ...previousRegistry,
      version: Number(previousRegistry.version) || 3,
      agents: [...previousRegistry.agents, rawAgent],
    };
    await this.#writeRegistry(nextRegistry);

    try {
      const normalized = await this.#loadNormalizedBot(requestedId);
      const paths = await this.#ensureBotDirectories(normalized);
      const bot = await this.botManager.registerBot(normalized, { startIfEnabled });
      return { bot, paths };
    } catch (error) {
      await writeTextFileAtomic(this.registryFilePath, previousRegistryText).catch(() => {
        // Best effort rollback only.
      });
      throw error;
    }
  }

  async #deleteBot({
    botId,
    deleteMode,
    purgeData,
    purgeWorkspace,
  }: {
    botId: string;
    deleteMode: DeleteMode;
    purgeData: boolean;
    purgeWorkspace: boolean;
  }): Promise<{
    botId: string;
    deleteMode: DeleteMode;
    purgeData: boolean;
    purgeWorkspace: boolean;
    tokenSecretRefs: string[];
    secretsDeleted: SecretsDeleteResult[];
  }> {
    const previousRegistryText = await fs.readFile(this.registryFilePath, "utf8");
    const previousRegistry = parseRegistryJson(previousRegistryText, this.registryFilePath);

    const targetAgent =
      previousRegistry.agents.find(
        (entry) => String((entry as RegistryAgent)?.id ?? "").trim() === botId,
      ) ?? null;
    if (!targetAgent) {
      throw new Error(`Bot '${botId}' does not exist.`);
    }
    const tokenSecretRefs = collectChannelTokenSecretRefs(targetAgent);

    const nextRegistry = {
      ...previousRegistry,
      version: Number(previousRegistry.version) || 3,
      agents: previousRegistry.agents.filter(
        (entry) => String((entry as RegistryAgent)?.id ?? "").trim() !== botId,
      ),
    };
    await this.#writeRegistry(nextRegistry);

    try {
      const removed = await this.botManager.removeBot(botId, {
        purgeData,
        purgeWorkspace,
      });

      let secretsDeleted: SecretsDeleteResult[] = [];
      if (purgeWorkspace && tokenSecretRefs.length > 0) {
        secretsDeleted = await this.#deleteSecretsBestEffort(tokenSecretRefs);
      }

      return {
        botId,
        deleteMode,
        purgeData: removed.purgeData === true,
        purgeWorkspace: removed.purgeWorkspace === true,
        tokenSecretRefs,
        secretsDeleted,
      };
    } catch (error) {
      await writeTextFileAtomic(this.registryFilePath, previousRegistryText).catch(() => {
        // Best effort rollback only.
      });
      throw error;
    }
  }

  async #setBotPolicy({
    botId,
    sandboxMode,
    approvalPolicy,
    model,
    reasoningEffort,
    serviceTier,
  }: {
    botId: string;
    sandboxMode: SandboxMode;
    approvalPolicy: ApprovalPolicy;
    model?: string | null;
    reasoningEffort?: ReasoningEffort | null;
    serviceTier?: ServiceTier | null;
  }): Promise<{
    bot: unknown;
    policy: {
      sandboxMode: SandboxMode;
      approvalPolicy: ApprovalPolicy;
      model: string | null;
      reasoningEffort: ReasoningEffort | null;
      serviceTier: ServiceTier | null;
    };
  }> {
    const previousRegistryText = await fs.readFile(this.registryFilePath, "utf8");
    const previousRegistry = parseRegistryJson(previousRegistryText, this.registryFilePath);
    const targetIndex = previousRegistry.agents.findIndex((entry) => {
      const candidate = entry as RegistryAgent;
      return String(candidate?.id ?? "").trim() === botId;
    });
    if (targetIndex < 0) {
      throw new Error(`Bot '${botId}' does not exist.`);
    }

    const targetAgent = previousRegistry.agents[targetIndex] as RegistryAgent;
    const currentProvider: { kind?: unknown; options?: unknown } & Record<string, unknown> =
      targetAgent?.provider && typeof targetAgent.provider === "object"
        ? (targetAgent.provider as Record<string, unknown>)
        : { kind: "codex", options: {} };
    const nextProviderOptions: Record<string, unknown> = {
      ...(currentProvider.options && typeof currentProvider.options === "object"
        ? currentProvider.options
        : {}),
      sandboxMode,
      approvalPolicy,
    };
    if (model !== undefined) {
      if (model) {
        nextProviderOptions.model = model;
      } else {
        delete nextProviderOptions.model;
      }
    }
    if (reasoningEffort !== undefined) {
      if (reasoningEffort) {
        nextProviderOptions.reasoningEffort = reasoningEffort;
      } else {
        delete nextProviderOptions.reasoningEffort;
      }
    }
    if (serviceTier !== undefined) {
      if (serviceTier) {
        nextProviderOptions.serviceTier = serviceTier;
      } else {
        delete nextProviderOptions.serviceTier;
      }
    }

    const nextProvider = {
      ...currentProvider,
      kind: String(currentProvider.kind ?? "codex").trim() || "codex",
      options: nextProviderOptions,
    };

    const nextAgents = [...previousRegistry.agents];
    nextAgents[targetIndex] = {
      ...targetAgent,
      provider: nextProvider,
    };

    const nextRegistry = {
      ...previousRegistry,
      version: Number(previousRegistry.version) || 3,
      agents: nextAgents,
    };

    await this.#writeRegistry(nextRegistry);

    try {
      const runtimeProviderUpdate: Record<string, unknown> = {
        sandboxMode,
        approvalPolicy,
      };
      if (model !== undefined) {
        runtimeProviderUpdate.model = model;
      }
      if (reasoningEffort !== undefined) {
        runtimeProviderUpdate.reasoningEffort = reasoningEffort;
      }
      if (serviceTier !== undefined) {
        runtimeProviderUpdate.serviceTier = serviceTier;
      }

      const bot = await this.botManager.setBotProviderOptions(botId, runtimeProviderUpdate);
      return {
        bot,
        policy: {
          sandboxMode,
          approvalPolicy,
          model: normalizeModelFromOptions(nextProviderOptions.model),
          reasoningEffort: normalizeReasoningEffortFromOptions(nextProviderOptions.reasoningEffort),
          serviceTier: normalizeServiceTierFromOptions(nextProviderOptions.serviceTier),
        },
      };
    } catch (error) {
      await writeTextFileAtomic(this.registryFilePath, previousRegistryText).catch(() => {
        // Best effort rollback only.
      });
      throw error;
    }
  }

  async #deleteSecretsBestEffort(secretNames: unknown): Promise<SecretsDeleteResult[]> {
    const names = Array.isArray(secretNames) ? secretNames : [];
    if (!this.secretStore || names.length === 0) {
      return [];
    }

    const deleted: SecretsDeleteResult[] = [];
    for (const name of names) {
      try {
        const result = await this.secretStore.deleteSecret(name);
        deleted.push({
          name,
          deleted: result?.deleted === true,
        });
      } catch (error) {
        deleted.push({
          name,
          deleted: false,
          error: sanitizeError(error),
        });
      }
    }
    return deleted;
  }

  async #scaffoldCapability({
    botId,
    capabilityId,
    capabilityName,
  }: {
    botId: string;
    capabilityId: string;
    capabilityName: string;
  }): Promise<{
    bot: unknown;
    capability: {
      id: string;
      enabled: boolean;
      manifestPath: string;
      options: Record<string, unknown>;
    };
    scaffold: unknown;
  }> {
    const previousRegistryText = await fs.readFile(this.registryFilePath, "utf8");
    const previousRegistry = parseRegistryJson(previousRegistryText, this.registryFilePath);

    const targetIndex = previousRegistry.agents.findIndex((entry) => {
      const candidate = entry as RegistryAgent;
      return String(candidate?.id ?? "").trim() === botId;
    });
    if (targetIndex < 0) {
      throw new Error(`Bot '${botId}' does not exist.`);
    }

    const targetAgent = previousRegistry.agents[targetIndex] as RegistryAgent;
    const existingCapabilities = Array.isArray(targetAgent?.capabilities)
      ? (targetAgent.capabilities as unknown[])
      : [];
    const alreadyDeclared = existingCapabilities.some(
      (entry) =>
        entry &&
        typeof entry === "object" &&
        String((entry as Record<string, unknown>).id ?? "").trim() === capabilityId,
    );
    if (alreadyDeclared) {
      throw new Error(`Capability '${capabilityId}' already exists for bot '${botId}'.`);
    }

    const normalizedBefore = await this.#loadNormalizedBot(botId);
    const previousLoadedCapabilities = Array.isArray(normalizedBefore.capabilities)
      ? [...normalizedBefore.capabilities]
      : [];
    const scaffold = await scaffoldCapabilityInWorkspace({
      workspaceRoot: normalizedBefore.workspaceRoot,
      capabilityId,
      capabilityName,
    });

    const appendedCapability = {
      id: capabilityId,
      enabled: true,
      manifestPath: scaffold.manifestPathForRegistry,
      options: {},
    };

    const nextAgents = [...previousRegistry.agents];
    const nextAgent = {
      ...targetAgent,
      capabilities: [...existingCapabilities, appendedCapability],
    };
    nextAgents[targetIndex] = nextAgent;

    const nextRegistry = {
      ...previousRegistry,
      version: Number(previousRegistry.version) || 3,
      agents: nextAgents,
    };

    await this.#writeRegistry(nextRegistry);

    try {
      const normalizedAfter = await this.#loadNormalizedBot(botId);
      this.botManager.setBotCapabilities(botId, normalizedAfter.capabilities);
      const bot = await this.botManager.reloadBotCapabilities(botId, normalizedAfter.capabilities);
      return {
        bot,
        capability: appendedCapability,
        scaffold,
      };
    } catch (error) {
      await writeTextFileAtomic(this.registryFilePath, previousRegistryText).catch(() => {
        // Best effort rollback only.
      });
      try {
        this.botManager.setBotCapabilities(botId, previousLoadedCapabilities);
        await this.botManager.reloadBotCapabilities(botId, previousLoadedCapabilities);
      } catch {
        // Best effort runtime rollback only.
      }
      throw error;
    }
  }

  async #loadNormalizedBot(botId: string): Promise<NormalizedBotDefinition> {
    const registry = await loadBotRegistry({
      filePath: this.registryFilePath,
      resolveSecret: (name: string) => this.secretStore?.getSecret(name) ?? null,
      ...this.registryLoadOptions,
    } as LoadBotRegistryOptions);
    const normalized = registry.bots.find((entry) => entry.id === botId);
    if (!normalized) {
      throw new Error(`Could not normalize bot '${botId}' from registry.`);
    }
    return normalized;
  }

  async #ensureBotDirectories(botDefinition: NormalizedBotDefinition): Promise<{
    workspaceRoot: { path: string; existed: boolean };
    dataDir: { path: string; existed: boolean };
  }> {
    const workspacePath = path.resolve(String(botDefinition.workspaceRoot));
    const dataDirPath = path.resolve(String(botDefinition.dataDir));
    const workspaceExisted = await directoryExists(workspacePath);
    const dataDirExisted = await directoryExists(dataDirPath);

    await fs.mkdir(workspacePath, { recursive: true });
    await fs.mkdir(dataDirPath, { recursive: true });

    return {
      workspaceRoot: {
        path: workspacePath,
        existed: workspaceExisted,
      },
      dataDir: {
        path: dataDirPath,
        existed: dataDirExisted,
      },
    };
  }

  async #writeRegistry(value: RegistryJson): Promise<void> {
    await writeTextFileAtomic(this.registryFilePath, `${JSON.stringify(value, null, 2)}\n`);
  }

  async #withRegistryMutationLock<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.registryMutationTail;
    let release!: () => void;
    this.registryMutationTail = new Promise<void>((resolve) => {
      release = resolve;
    });

    await previous.catch(() => {
      // Preserve queue progress even if the previous mutation failed.
    });

    try {
      return await operation();
    } finally {
      release();
    }
  }
}

function ensureSecretStore(
  secretStore: KernelSecretStore | null,
): asserts secretStore is KernelSecretStore {
  if (!secretStore) {
    throw new Error("Secret store is not configured in kernel.");
  }
}

function requireNonEmptyString(value: unknown, label: string): string {
  const normalized = String(value ?? "").trim();
  if (!normalized) {
    throw new Error(`${label} is required.`);
  }
  return normalized;
}

function parseRegistryJson(text: unknown, filePath: string): RegistryJson {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripBom(String(text ?? "")));
  } catch {
    throw new Error(`Registry file '${filePath}' is not valid JSON.`);
  }

  if (!parsed || typeof parsed !== "object") {
    throw new Error(`Registry file '${filePath}' must contain an object.`);
  }
  const parsedObj = parsed as { agents?: unknown };
  if (!Array.isArray(parsedObj.agents)) {
    throw new Error(`Registry file '${filePath}' must contain an agents array.`);
  }
  return {
    ...(parsed as Record<string, unknown>),
    version: Number((parsed as { version?: unknown }).version) || 3,
    agents: parsedObj.agents.map((entry) =>
      entry && typeof entry === "object" ? (entry as RegistryAgent) : {},
    ),
  };
}

function stripBom(value: string): string {
  if (value.charCodeAt(0) === 0xfeff) {
    return value.slice(1);
  }
  return value;
}

async function directoryExists(candidatePath: string): Promise<boolean> {
  try {
    const stat = await fs.stat(candidatePath);
    return stat.isDirectory();
  } catch {
    return false;
  }
}

function parseDeleteMode(payload: Record<string, unknown>): DeleteMode {
  const value = String(payload?.deleteMode ?? "")
    .trim()
    .toLowerCase();
  if (value === "soft" || value === "purge_data" || value === "purge_all") {
    return value;
  }
  return "soft";
}

const ALLOWED_SANDBOX_MODES = new Set(["read-only", "workspace-write", "danger-full-access"]);
const ALLOWED_APPROVAL_POLICIES = new Set(["on-request", "on-failure", "never"]);

function requireSandboxMode(value: unknown): SandboxMode {
  const normalized = String(value ?? "")
    .trim()
    .toLowerCase();
  if (!ALLOWED_SANDBOX_MODES.has(normalized)) {
    throw new Error(`Unsupported sandboxMode '${normalized || "<empty>"}'.`);
  }
  return normalized as SandboxMode;
}

function requireApprovalPolicy(value: unknown): ApprovalPolicy {
  const normalized = String(value ?? "")
    .trim()
    .toLowerCase();
  if (!ALLOWED_APPROVAL_POLICIES.has(normalized)) {
    throw new Error(`Unsupported approvalPolicy '${normalized || "<empty>"}'.`);
  }
  return normalized as ApprovalPolicy;
}

function requireOptionalModel(value: unknown): string | null {
  if (value === null || value === undefined) {
    return null;
  }

  const normalized = String(value).trim();
  if (!normalized) {
    return null;
  }

  const keyword = normalized.toLowerCase();
  if (keyword === "auto" || keyword === "default") {
    return null;
  }

  if (normalized.length > 120) {
    throw new Error("model is too long.");
  }
  if (!/^[A-Za-z0-9._:-]+$/.test(normalized)) {
    throw new Error("model format is invalid.");
  }

  return normalized;
}

function requireOptionalReasoningEffort(value: unknown): ReasoningEffort | null {
  if (value === null || value === undefined) {
    return null;
  }

  const normalized = String(value).trim().toLowerCase();
  if (!normalized || normalized === "auto" || normalized === "default") {
    return null;
  }

  if (
    normalized === "none" ||
    normalized === "minimal" ||
    normalized === "low" ||
    normalized === "medium" ||
    normalized === "high" ||
    normalized === "xhigh"
  ) {
    return normalized;
  }

  throw new Error("reasoningEffort must be one of: none, minimal, low, medium, high, xhigh.");
}

function requireOptionalServiceTier(value: unknown): ServiceTier | null {
  if (value === null || value === undefined) {
    return null;
  }

  const normalized = String(value).trim().toLowerCase();
  if (
    !normalized ||
    normalized === "auto" ||
    normalized === "default" ||
    normalized === "standard"
  ) {
    return null;
  }

  if (normalized === "fast" || normalized === "flex") {
    return normalized;
  }

  throw new Error("serviceTier must be one of: fast, flex.");
}

function normalizeModelFromOptions(value: unknown): string | null {
  const normalized = String(value ?? "").trim();
  return normalized || null;
}

function normalizeReasoningEffortFromOptions(value: unknown): ReasoningEffort | null {
  const normalized = String(value ?? "")
    .trim()
    .toLowerCase();
  if (
    normalized === "none" ||
    normalized === "minimal" ||
    normalized === "low" ||
    normalized === "medium" ||
    normalized === "high" ||
    normalized === "xhigh"
  ) {
    return normalized;
  }
  return null;
}

function normalizeServiceTierFromOptions(value: unknown): ServiceTier | null {
  const normalized = String(value ?? "")
    .trim()
    .toLowerCase();
  if (normalized === "fast" || normalized === "flex") {
    return normalized;
  }
  return null;
}

function collectChannelTokenSecretRefs(agent: unknown): string[] {
  const agentRecord = agent && typeof agent === "object" ? (agent as RegistryAgent) : {};
  const channels = Array.isArray(agentRecord?.channels) ? (agentRecord.channels as unknown[]) : [];
  const refs: string[] = [];
  for (const channel of channels) {
    const channelRecord =
      channel && typeof channel === "object" ? (channel as Record<string, unknown>) : {};
    const raw = String(channelRecord?.tokenSecretRef ?? "").trim();
    if (raw) {
      refs.push(raw);
    }
  }
  return [...new Set(refs)];
}

function sanitizeError(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  return raw.split(/\r?\n/).slice(0, 12).join("\n");
}

async function writeTextFileAtomic(filePath: string, text: string): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.tmp`;
  await fs.writeFile(tmpPath, text, "utf8");
  await fs.rename(tmpPath, filePath);
}
