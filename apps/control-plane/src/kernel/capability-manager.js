import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

export const CAPABILITY_HOOKS = Object.freeze([
  "onRuntimeStart",
  "onRuntimeStop",
  "onTurnStart",
  "onTurnResult",
  "onApprovalRequested"
]);

const SUPPORTED_HOOKS = new Set(CAPABILITY_HOOKS);

export class CapabilityManager {
  constructor({ runtimeId, kernelVersion, workspaceRoot, capabilityDefinitions }) {
    this.runtimeId = String(runtimeId ?? "").trim();
    this.kernelVersion = String(kernelVersion ?? "0.0.0").trim() || "0.0.0";
    this.workspaceRoot = path.resolve(String(workspaceRoot ?? process.cwd()));
    this.capabilityDefinitions = Array.isArray(capabilityDefinitions) ? capabilityDefinitions : [];
    this.loadedCapabilities = [];
  }

  async initialize() {
    await this.reload(this.capabilityDefinitions);
  }

  async reload(nextDefinitions = this.capabilityDefinitions) {
    await this.runHook("onRuntimeStop", {});

    this.capabilityDefinitions = Array.isArray(nextDefinitions) ? nextDefinitions : [];
    this.loadedCapabilities = [];

    const seenIds = new Set();
    for (let index = 0; index < this.capabilityDefinitions.length; index += 1) {
      const definition = this.capabilityDefinitions[index];
      if (!definition || definition.enabled === false) {
        continue;
      }

      const capabilityId = String(definition.id ?? `capability_${index + 1}`).trim();
      if (!capabilityId || seenIds.has(capabilityId)) {
        continue;
      }
      seenIds.add(capabilityId);

      try {
        const loaded = await this.#loadCapability({
          id: capabilityId,
          definition
        });
        this.loadedCapabilities.push(loaded);
      } catch (error) {
        this.loadedCapabilities.push({
          id: capabilityId,
          status: "error",
          error: sanitizeError(error),
          hooks: [],
          manifestPath: definition.manifestPath,
          entryPath: null
        });
      }
    }

    await this.runHook("onRuntimeStart", {});
  }

  getStatus() {
    return this.loadedCapabilities.map((entry) => ({
      id: entry.id,
      name: entry.name ?? entry.id,
      version: entry.version ?? "0.0.0",
      status: entry.status,
      hooks: [...(entry.hooks ?? [])],
      error: entry.error ?? null,
      manifestPath: entry.manifestPath ?? null,
      entryPath: entry.entryPath ?? null
    }));
  }

  async shutdown() {
    await this.runHook("onRuntimeStop", {});
    this.loadedCapabilities = [];
  }

  async transformTurnInput(input) {
    let current = {
      ...input,
      metadata: input?.metadata && typeof input.metadata === "object" ? { ...input.metadata } : {}
    };

    for (const capability of this.loadedCapabilities) {
      if (capability.status !== "loaded" || typeof capability.instance.onTurnStart !== "function") {
        continue;
      }
      const output = await this.#runCapabilityHook({
        capability,
        hookName: "onTurnStart",
        payload: freezeShallow({
          ...current,
          runtimeId: this.runtimeId
        })
      });
      if (!output || typeof output !== "object") {
        continue;
      }

      if (Object.prototype.hasOwnProperty.call(output, "prompt")) {
        current.prompt = String(output.prompt ?? "").trim();
      }
      if (Object.prototype.hasOwnProperty.call(output, "source")) {
        current.source = String(output.source ?? "").trim() || current.source;
      }
      if (output.metadata && typeof output.metadata === "object") {
        current.metadata = {
          ...current.metadata,
          ...output.metadata
        };
      }
    }

    return current;
  }

  async transformTurnResult(payload) {
    let current = {
      ...payload,
      result: payload?.result && typeof payload.result === "object" ? { ...payload.result } : payload?.result
    };

    for (const capability of this.loadedCapabilities) {
      if (capability.status !== "loaded" || typeof capability.instance.onTurnResult !== "function") {
        continue;
      }
      const output = await this.#runCapabilityHook({
        capability,
        hookName: "onTurnResult",
        payload: freezeShallow({
          ...current,
          runtimeId: this.runtimeId
        })
      });
      if (!output || typeof output !== "object") {
        continue;
      }

      if (Object.prototype.hasOwnProperty.call(output, "assistantText")) {
        current.result = {
          ...(current.result ?? {}),
          assistantText: String(output.assistantText ?? "")
        };
      }
      if (output.result && typeof output.result === "object") {
        current.result = {
          ...(current.result ?? {}),
          ...output.result
        };
      }
    }

    return current;
  }

  async notifyApprovalRequested(approval) {
    await this.runHook("onApprovalRequested", {
      approval,
      runtimeId: this.runtimeId
    });
  }

  async runHook(hookName, payload) {
    const normalizedHook = String(hookName ?? "").trim();
    if (!SUPPORTED_HOOKS.has(normalizedHook)) {
      return;
    }

    for (const capability of this.loadedCapabilities) {
      if (capability.status !== "loaded") {
        continue;
      }
      if (typeof capability.instance?.[normalizedHook] !== "function") {
        continue;
      }

      await this.#runCapabilityHook({
        capability,
        hookName: normalizedHook,
        payload: freezeShallow({
          ...payload,
          runtimeId: this.runtimeId
        })
      });
    }
  }

  async #runCapabilityHook({ capability, hookName, payload }) {
    const timeoutMs = clampTimeoutMs(capability.timeoutMs);
    const work = Promise.resolve(capability.instance[hookName](payload));
    try {
      return await withTimeout(work, timeoutMs, `${capability.id}.${hookName}`);
    } catch (error) {
      capability.error = sanitizeError(error);
      capability.status = "degraded";
      return null;
    }
  }

  async #loadCapability({ id, definition }) {
    const manifestPath = resolvePath(definition.manifestPath, this.workspaceRoot);
    const manifest = await readManifest(manifestPath);

    if (manifest.minKernelVersion && compareSemver(this.kernelVersion, manifest.minKernelVersion) < 0) {
      throw new Error(
        `Capability '${id}' requires kernel ${manifest.minKernelVersion}, current kernel is ${this.kernelVersion}.`
      );
    }

    const declaredHooks = (Array.isArray(manifest.hooks) ? manifest.hooks : [])
      .map((entry) => String(entry ?? "").trim())
      .filter((entry) => SUPPORTED_HOOKS.has(entry));
    const entryPath = path.resolve(path.dirname(manifestPath), String(manifest.entry ?? "index.js"));
    const moduleUrl = `${pathToFileURL(entryPath).href}?ts=${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const loadedModule = await import(moduleUrl);
    const factory = resolveCapabilityFactory(loadedModule);
    const instance = await factory({
      runtimeId: this.runtimeId,
      capabilityId: id,
      manifest,
      options: definition.options ?? {}
    });

    if (!instance || typeof instance !== "object") {
      throw new Error(`Capability '${id}' entry did not return an object.`);
    }

    const hooks = declaredHooks.filter((hookName) => typeof instance[hookName] === "function");
    return {
      id,
      name: String(manifest.name ?? id).trim() || id,
      version: String(manifest.version ?? "0.0.0").trim() || "0.0.0",
      timeoutMs: manifest.timeoutMs,
      hooks,
      status: "loaded",
      manifestPath,
      entryPath,
      error: null,
      instance
    };
  }
}

async function readManifest(manifestPath) {
  const raw = await fs.readFile(manifestPath, "utf8");
  const parsed = JSON.parse(raw);
  if (!parsed || typeof parsed !== "object") {
    throw new Error(`Invalid capability manifest at ${manifestPath}.`);
  }

  const id = String(parsed.id ?? "").trim();
  if (!id) {
    throw new Error(`Capability manifest ${manifestPath} must include a non-empty 'id'.`);
  }

  const entry = String(parsed.entry ?? "index.js").trim();
  if (!entry) {
    throw new Error(`Capability manifest ${manifestPath} must include a non-empty 'entry'.`);
  }

  return {
    id,
    name: String(parsed.name ?? id).trim() || id,
    version: String(parsed.version ?? "0.0.0").trim() || "0.0.0",
    entry,
    hooks: Array.isArray(parsed.hooks) ? parsed.hooks : [],
    permissions: Array.isArray(parsed.permissions) ? parsed.permissions : [],
    minKernelVersion: String(parsed.minKernelVersion ?? "").trim() || null,
    timeoutMs: clampTimeoutMs(parsed.timeoutMs)
  };
}

function resolveCapabilityFactory(loadedModule) {
  if (typeof loadedModule?.createCapability === "function") {
    return loadedModule.createCapability;
  }
  if (typeof loadedModule?.default === "function") {
    return loadedModule.default;
  }
  if (loadedModule?.default && typeof loadedModule.default === "object") {
    return async () => loadedModule.default;
  }
  throw new Error("Capability module must export createCapability(), default function, or default object.");
}

function clampTimeoutMs(value) {
  const parsed = Number.parseInt(String(value ?? "5000"), 10);
  if (!Number.isFinite(parsed) || parsed < 100) {
    return 5000;
  }
  return Math.min(parsed, 60000);
}

function withTimeout(promise, timeoutMs, label) {
  let timer = null;
  const timeoutPromise = new Promise((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`Capability hook timeout (${label}) after ${timeoutMs}ms.`));
    }, timeoutMs);
  });

  return Promise.race([promise, timeoutPromise]).finally(() => {
    if (timer) {
      clearTimeout(timer);
    }
  });
}

function freezeShallow(value) {
  if (!value || typeof value !== "object") {
    return value;
  }
  return Object.freeze({ ...value });
}

function sanitizeError(error) {
  const raw = error instanceof Error ? error.message : String(error);
  return raw.split(/\r?\n/).slice(0, 12).join("\n");
}

function resolvePath(candidate, workspaceRoot) {
  const raw = String(candidate ?? "").trim();
  if (!raw) {
    throw new Error("capability manifestPath is required.");
  }
  if (path.isAbsolute(raw)) {
    return raw;
  }

  const fromWorkspace = path.resolve(workspaceRoot, raw);
  if (fsSync.existsSync(fromWorkspace)) {
    return fromWorkspace;
  }

  const fromProcess = path.resolve(process.cwd(), raw);
  if (fsSync.existsSync(fromProcess)) {
    return fromProcess;
  }

  return fromWorkspace;
}

function compareSemver(a, b) {
  const left = parseSemver(a);
  const right = parseSemver(b);
  for (let index = 0; index < 3; index += 1) {
    if (left[index] > right[index]) {
      return 1;
    }
    if (left[index] < right[index]) {
      return -1;
    }
  }
  return 0;
}

function parseSemver(value) {
  const parts = String(value ?? "0.0.0")
    .split(".")
    .slice(0, 3)
    .map((entry) => Number.parseInt(entry, 10));
  while (parts.length < 3) {
    parts.push(0);
  }
  return parts.map((entry) => (Number.isFinite(entry) && entry >= 0 ? entry : 0));
}
