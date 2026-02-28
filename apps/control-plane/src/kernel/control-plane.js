import fs from "node:fs/promises";
import path from "node:path";
import { loadBotRegistry } from "../bot-registry.js";
import { scaffoldCapabilityInWorkspace, normalizeCapabilityId, normalizeCapabilityName } from "./capability-scaffold.js";
import { CONTROL_ACTIONS, requireControlAction } from "./control-plane-actions.js";
import { getExtensionContract } from "./extension-contract.js";
import { assertControlPermission } from "@copilot-hub/core/control-permission";

export class KernelControlPlane {
  constructor({ botManager, registryFilePath, registryLoadOptions, secretStore = null }) {
    this.botManager = botManager;
    this.registryFilePath = path.resolve(String(registryFilePath));
    this.registryLoadOptions = registryLoadOptions && typeof registryLoadOptions === "object" ? registryLoadOptions : {};
    this.secretStore = secretStore;
  }

  async handleAgentAction({ actorBotId, action, payload, context }) {
    const normalizedAction = requireControlAction(action);
    const supervisor = this.botManager.getBot(actorBotId);
    assertControlPermission({
      supervisor,
      action: normalizedAction,
      source: context?.source,
      metadata: context?.metadata
    });
    return this.#executeAction({
      action: normalizedAction,
      payload,
      actorBotId
    });
  }

  async runSystemAction(action, payload) {
    const normalizedAction = requireControlAction(action);
    return this.#executeAction({
      action: normalizedAction,
      payload,
      actorBotId: null
    });
  }

  async #executeAction({ action, payload, actorBotId }) {
    const safePayload = payload && typeof payload === "object" ? payload : {};

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
        const created = await this.#createBot({
          rawAgent: agent,
          startIfEnabled
        });
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
        const deleted = await this.#deleteBot({
          botId,
          deleteMode,
          purgeData,
          purgeWorkspace
        });
        return {
          deleted: true,
          ...deleted
        };
      }

      case CONTROL_ACTIONS.BOTS_SET_POLICY: {
        const botId = requireNonEmptyString(safePayload.botId, "payload.botId");
        const sandboxMode = requireSandboxMode(safePayload.sandboxMode);
        const approvalPolicy = requireApprovalPolicy(safePayload.approvalPolicy);
        return this.#setBotPolicy({
          botId,
          sandboxMode,
          approvalPolicy
        });
      }

      case CONTROL_ACTIONS.BOTS_SET_PROJECT: {
        const botId = requireNonEmptyString(safePayload.botId, "payload.botId");
        const projectName = requireNonEmptyString(safePayload.projectName, "payload.projectName");
        const bot = await this.botManager.setBotProject(botId, projectName);
        return { bot };
      }

      case CONTROL_ACTIONS.BOTS_CAPABILITIES_LIST: {
        const botId = requireNonEmptyString(safePayload.botId, "payload.botId");
        const capabilities = await this.botManager.listBotCapabilities(botId);
        return {
          botId,
          capabilities
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
        const result = await this.#scaffoldCapability({
          botId,
          capabilityId,
          capabilityName
        });
        return result;
      }

      case CONTROL_ACTIONS.PROJECTS_LIST: {
        return this.botManager.listProjects();
      }

      case CONTROL_ACTIONS.PROJECTS_CREATE: {
        const name = requireNonEmptyString(safePayload.name, "payload.name");
        const project = await this.botManager.createProject(name);
        return { project };
      }

      case CONTROL_ACTIONS.SECRETS_LIST: {
        ensureSecretStore(this.secretStore);
        return {
          secrets: this.secretStore.listSecretNames()
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

  async #createBot({ rawAgent, startIfEnabled }) {
    const requestedId = requireNonEmptyString(rawAgent.id, "agent.id");

    const previousRegistryText = await fs.readFile(this.registryFilePath, "utf8");
    const previousRegistry = parseRegistryJson(previousRegistryText, this.registryFilePath);

    if (previousRegistry.agents.some((entry) => String(entry?.id ?? "").trim() === requestedId)) {
      throw new Error(`Bot '${requestedId}' already exists.`);
    }

    const nextRegistry = {
      ...previousRegistry,
      version: Number(previousRegistry.version) || 3,
      agents: [...previousRegistry.agents, rawAgent]
    };
    await this.#writeRegistry(nextRegistry);

    try {
      const normalized = await this.#loadNormalizedBot(requestedId);
      const paths = await this.#ensureBotDirectories(normalized);
      const bot = await this.botManager.registerBot(normalized, { startIfEnabled });
      return { bot, paths };
    } catch (error) {
      await fs.writeFile(this.registryFilePath, previousRegistryText, "utf8").catch(() => {
        // Best effort rollback only.
      });
      throw error;
    }
  }

  async #deleteBot({ botId, deleteMode, purgeData, purgeWorkspace }) {
    const previousRegistryText = await fs.readFile(this.registryFilePath, "utf8");
    const previousRegistry = parseRegistryJson(previousRegistryText, this.registryFilePath);

    const targetAgent = previousRegistry.agents.find((entry) => String(entry?.id ?? "").trim() === botId) ?? null;
    if (!targetAgent) {
      throw new Error(`Bot '${botId}' does not exist.`);
    }
    const tokenSecretRefs = collectChannelTokenSecretRefs(targetAgent);

    const nextRegistry = {
      ...previousRegistry,
      version: Number(previousRegistry.version) || 3,
      agents: previousRegistry.agents.filter((entry) => String(entry?.id ?? "").trim() !== botId)
    };
    await this.#writeRegistry(nextRegistry);

    try {
      const removed = await this.botManager.removeBot(botId, {
        purgeData,
        purgeWorkspace
      });

      let secretsDeleted = [];
      if (purgeWorkspace && tokenSecretRefs.length > 0) {
        secretsDeleted = await this.#deleteSecretsBestEffort(tokenSecretRefs);
      }

      return {
        botId,
        deleteMode,
        purgeData: removed.purgeData === true,
        purgeWorkspace: removed.purgeWorkspace === true,
        tokenSecretRefs,
        secretsDeleted
      };
    } catch (error) {
      await fs.writeFile(this.registryFilePath, previousRegistryText, "utf8").catch(() => {
        // Best effort rollback only.
      });
      throw error;
    }
  }

  async #setBotPolicy({ botId, sandboxMode, approvalPolicy }) {
    const previousRegistryText = await fs.readFile(this.registryFilePath, "utf8");
    const previousRegistry = parseRegistryJson(previousRegistryText, this.registryFilePath);
    const targetIndex = previousRegistry.agents.findIndex((entry) => String(entry?.id ?? "").trim() === botId);
    if (targetIndex < 0) {
      throw new Error(`Bot "${botId}" does not exist.`);
    }

    const targetAgent = previousRegistry.agents[targetIndex];
    const currentProvider =
      targetAgent?.provider && typeof targetAgent.provider === "object"
        ? targetAgent.provider
        : { kind: "codex", options: {} };
    const nextProvider = {
      ...currentProvider,
      kind: String(currentProvider.kind ?? "codex").trim() || "codex",
      options: {
        ...(currentProvider.options && typeof currentProvider.options === "object" ? currentProvider.options : {}),
        sandboxMode,
        approvalPolicy
      }
    };

    const nextAgents = [...previousRegistry.agents];
    nextAgents[targetIndex] = {
      ...targetAgent,
      provider: nextProvider
    };

    const nextRegistry = {
      ...previousRegistry,
      version: Number(previousRegistry.version) || 3,
      agents: nextAgents
    };

    await this.#writeRegistry(nextRegistry);

    try {
      const bot = await this.botManager.setBotProviderOptions(botId, {
        sandboxMode,
        approvalPolicy
      });
      return {
        bot,
        policy: {
          sandboxMode,
          approvalPolicy
        }
      };
    } catch (error) {
      await fs.writeFile(this.registryFilePath, previousRegistryText, "utf8").catch(() => {
        // Best effort rollback only.
      });
      throw error;
    }
  }

  async #deleteSecretsBestEffort(secretNames) {
    const names = Array.isArray(secretNames) ? secretNames : [];
    if (!this.secretStore || names.length === 0) {
      return [];
    }

    const deleted = [];
    for (const name of names) {
      try {
        const result = await this.secretStore.deleteSecret(name);
        deleted.push({
          name,
          deleted: result?.deleted === true
        });
      } catch (error) {
        deleted.push({
          name,
          deleted: false,
          error: sanitizeError(error)
        });
      }
    }
    return deleted;
  }

  async #scaffoldCapability({ botId, capabilityId, capabilityName }) {
    const previousRegistryText = await fs.readFile(this.registryFilePath, "utf8");
    const previousRegistry = parseRegistryJson(previousRegistryText, this.registryFilePath);

    const targetIndex = previousRegistry.agents.findIndex((entry) => String(entry?.id ?? "").trim() === botId);
    if (targetIndex < 0) {
      throw new Error(`Bot '${botId}' does not exist.`);
    }

    const targetAgent = previousRegistry.agents[targetIndex];
    const existingCapabilities = Array.isArray(targetAgent?.capabilities) ? targetAgent.capabilities : [];
    const alreadyDeclared = existingCapabilities.some(
      (entry) => entry && typeof entry === "object" && String(entry.id ?? "").trim() === capabilityId
    );
    if (alreadyDeclared) {
      throw new Error(`Capability '${capabilityId}' already exists for bot '${botId}'.`);
    }

    const normalizedBefore = await this.#loadNormalizedBot(botId);
    const previousLoadedCapabilities = Array.isArray(normalizedBefore.capabilities) ? normalizedBefore.capabilities : [];
    const scaffold = await scaffoldCapabilityInWorkspace({
      workspaceRoot: normalizedBefore.workspaceRoot,
      capabilityId,
      capabilityName
    });

    const appendedCapability = {
      id: capabilityId,
      enabled: true,
      manifestPath: scaffold.manifestPathForRegistry,
      options: {}
    };

    const nextAgents = [...previousRegistry.agents];
    const nextAgent = {
      ...targetAgent,
      capabilities: [...existingCapabilities, appendedCapability]
    };
    nextAgents[targetIndex] = nextAgent;

    const nextRegistry = {
      ...previousRegistry,
      version: Number(previousRegistry.version) || 3,
      agents: nextAgents
    };

    await this.#writeRegistry(nextRegistry);

    try {
      const normalizedAfter = await this.#loadNormalizedBot(botId);
      this.botManager.setBotCapabilities(botId, normalizedAfter.capabilities);
      const bot = await this.botManager.reloadBotCapabilities(botId, normalizedAfter.capabilities);
      return {
        bot,
        capability: appendedCapability,
        scaffold
      };
    } catch (error) {
      await fs.writeFile(this.registryFilePath, previousRegistryText, "utf8").catch(() => {
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

  async #loadNormalizedBot(botId) {
    const registry = await loadBotRegistry({
      filePath: this.registryFilePath,
      resolveSecret: (name) => this.secretStore?.getSecret(name) ?? null,
      ...this.registryLoadOptions
    });
    const normalized = registry.bots.find((entry) => entry.id === botId);
    if (!normalized) {
      throw new Error(`Could not normalize bot '${botId}' from registry.`);
    }
    return normalized;
  }

  async #ensureBotDirectories(botDefinition) {
    const workspacePath = path.resolve(String(botDefinition.workspaceRoot));
    const dataDirPath = path.resolve(String(botDefinition.dataDir));
    const workspaceExisted = await directoryExists(workspacePath);
    const dataDirExisted = await directoryExists(dataDirPath);

    await fs.mkdir(workspacePath, { recursive: true });
    await fs.mkdir(dataDirPath, { recursive: true });

    return {
      workspaceRoot: {
        path: workspacePath,
        existed: workspaceExisted
      },
      dataDir: {
        path: dataDirPath,
        existed: dataDirExisted
      }
    };
  }

  async #writeRegistry(value) {
    await fs.writeFile(this.registryFilePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  }
}

function ensureSecretStore(secretStore) {
  if (!secretStore) {
    throw new Error("Secret store is not configured in kernel.");
  }
}

function requireNonEmptyString(value, label) {
  const normalized = String(value ?? "").trim();
  if (!normalized) {
    throw new Error(`${label} is required.`);
  }
  return normalized;
}

function parseRegistryJson(text, filePath) {
  let parsed;
  try {
    parsed = JSON.parse(stripBom(String(text ?? "")));
  } catch {
    throw new Error(`Registry file '${filePath}' is not valid JSON.`);
  }

  if (!parsed || typeof parsed !== "object") {
    throw new Error(`Registry file '${filePath}' must contain an object.`);
  }
  if (!Array.isArray(parsed.agents)) {
    throw new Error(`Registry file '${filePath}' must contain an agents array.`);
  }
  return parsed;
}

function stripBom(value) {
  if (value.charCodeAt(0) === 0xfeff) {
    return value.slice(1);
  }
  return value;
}

async function directoryExists(candidatePath) {
  try {
    const stat = await fs.stat(candidatePath);
    return stat.isDirectory();
  } catch {
    return false;
  }
}

function parseDeleteMode(payload) {
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

function requireSandboxMode(value) {
  const normalized = String(value ?? "")
    .trim()
    .toLowerCase();
  if (!ALLOWED_SANDBOX_MODES.has(normalized)) {
    throw new Error(`Unsupported sandboxMode "${normalized || "<empty>"}".`);
  }
  return normalized;
}

function requireApprovalPolicy(value) {
  const normalized = String(value ?? "")
    .trim()
    .toLowerCase();
  if (!ALLOWED_APPROVAL_POLICIES.has(normalized)) {
    throw new Error(`Unsupported approvalPolicy "${normalized || "<empty>"}".`);
  }
  return normalized;
}

function collectChannelTokenSecretRefs(agent) {
  const channels = Array.isArray(agent?.channels) ? agent.channels : [];
  const refs = [];
  for (const channel of channels) {
    const raw = String(channel?.tokenSecretRef ?? "").trim();
    if (raw) {
      refs.push(raw);
    }
  }
  return [...new Set(refs)];
}

function sanitizeError(error) {
  const raw = error instanceof Error ? error.message : String(error);
  return raw.split(/\r?\n/).slice(0, 12).join("\n");
}
