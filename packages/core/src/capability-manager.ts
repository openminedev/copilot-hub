import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const CAPABILITY_HOOK_VALUES = [
  "onRuntimeStart",
  "onRuntimeStop",
  "onTurnStart",
  "onTurnResult",
  "onApprovalRequested",
] as const;

export type CapabilityHookName = (typeof CAPABILITY_HOOK_VALUES)[number];

export const CAPABILITY_HOOKS: readonly CapabilityHookName[] = Object.freeze([
  ...CAPABILITY_HOOK_VALUES,
]);

const SUPPORTED_HOOKS = new Set<CapabilityHookName>(CAPABILITY_HOOKS);

type CapabilityDefinition = {
  id?: string;
  enabled?: boolean;
  manifestPath?: string;
  options?: Record<string, unknown>;
};

type CapabilityManifest = {
  id: string;
  name: string;
  version: string;
  entry: string;
  hooks: unknown[];
  permissions: unknown[];
  minKernelVersion: string | null;
  timeoutMs: number;
};

type CapabilityHookPayload = Record<string, unknown>;
type CapabilityHookFn = (payload: CapabilityHookPayload) => unknown | Promise<unknown>;

type CapabilityInstance = {
  [K in CapabilityHookName]?: CapabilityHookFn;
} & Record<string, unknown>;

type LoadedCapability = {
  id: string;
  name?: string;
  version?: string;
  timeoutMs?: number;
  hooks: CapabilityHookName[];
  status: "loaded" | "degraded" | "error";
  manifestPath?: string | undefined;
  entryPath: string | null;
  error: string | null;
  instance?: CapabilityInstance;
};

type TurnInput = {
  prompt?: string;
  source?: string;
  metadata?: Record<string, unknown>;
} & Record<string, unknown>;

type TurnResultPayload = {
  result?: unknown;
} & Record<string, unknown>;

export class CapabilityManager {
  runtimeId: string;
  kernelVersion: string;
  workspaceRoot: string;
  capabilityDefinitions: CapabilityDefinition[];
  loadedCapabilities: LoadedCapability[];

  constructor({
    runtimeId,
    kernelVersion,
    workspaceRoot,
    capabilityDefinitions,
  }: {
    runtimeId: string;
    kernelVersion?: string;
    workspaceRoot?: string;
    capabilityDefinitions?: CapabilityDefinition[];
  }) {
    this.runtimeId = String(runtimeId ?? "").trim();
    this.kernelVersion = String(kernelVersion ?? "0.0.0").trim() || "0.0.0";
    this.workspaceRoot = path.resolve(String(workspaceRoot ?? process.cwd()));
    this.capabilityDefinitions = Array.isArray(capabilityDefinitions) ? capabilityDefinitions : [];
    this.loadedCapabilities = [];
  }

  async initialize(): Promise<void> {
    await this.reload(this.capabilityDefinitions);
  }

  async reload(
    nextDefinitions: CapabilityDefinition[] = this.capabilityDefinitions,
  ): Promise<void> {
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
          definition,
        });
        this.loadedCapabilities.push(loaded);
      } catch (error) {
        const failedEntry: LoadedCapability = {
          id: capabilityId,
          status: "error",
          error: sanitizeError(error),
          hooks: [] as CapabilityHookName[],
          manifestPath: definition.manifestPath,
          entryPath: null,
        };
        this.loadedCapabilities.push(failedEntry);
      }
    }

    await this.runHook("onRuntimeStart", {});
  }

  getStatus(): Array<{
    id: string;
    name: string;
    version: string;
    status: "loaded" | "degraded" | "error";
    hooks: CapabilityHookName[];
    error: string | null;
    manifestPath: string | null;
    entryPath: string | null;
  }> {
    return this.loadedCapabilities.map((entry) => ({
      id: entry.id,
      name: entry.name ?? entry.id,
      version: entry.version ?? "0.0.0",
      status: entry.status,
      hooks: [...(entry.hooks ?? [])],
      error: entry.error ?? null,
      manifestPath: entry.manifestPath ?? null,
      entryPath: entry.entryPath ?? null,
    }));
  }

  async shutdown(): Promise<void> {
    await this.runHook("onRuntimeStop", {});
    this.loadedCapabilities = [];
  }

  async transformTurnInput(input: TurnInput): Promise<TurnInput> {
    let current = {
      ...input,
      metadata: input?.metadata && typeof input.metadata === "object" ? { ...input.metadata } : {},
    };

    for (const capability of this.loadedCapabilities) {
      if (
        capability.status !== "loaded" ||
        typeof capability.instance?.onTurnStart !== "function"
      ) {
        continue;
      }
      const output = await this.#runCapabilityHook({
        capability,
        hookName: "onTurnStart",
        payload: freezeShallow({
          ...current,
          runtimeId: this.runtimeId,
        }),
      });
      if (!isRecord(output)) {
        continue;
      }

      if (Object.prototype.hasOwnProperty.call(output, "prompt")) {
        current.prompt = String(output["prompt"] ?? "").trim();
      }
      if (Object.prototype.hasOwnProperty.call(output, "source")) {
        const nextSource = String(output["source"] ?? "").trim();
        if (nextSource) {
          current.source = nextSource;
        }
      }
      const metadata = output["metadata"];
      if (isRecord(metadata)) {
        current.metadata = {
          ...current.metadata,
          ...metadata,
        };
      }
    }

    return current;
  }

  async transformTurnResult(payload: TurnResultPayload): Promise<TurnResultPayload> {
    let current = {
      ...payload,
      result: isRecord(payload?.result) ? { ...payload.result } : payload?.result,
    };

    for (const capability of this.loadedCapabilities) {
      if (
        capability.status !== "loaded" ||
        typeof capability.instance?.onTurnResult !== "function"
      ) {
        continue;
      }
      const output = await this.#runCapabilityHook({
        capability,
        hookName: "onTurnResult",
        payload: freezeShallow({
          ...current,
          runtimeId: this.runtimeId,
        }),
      });
      if (!isRecord(output)) {
        continue;
      }

      if (Object.prototype.hasOwnProperty.call(output, "assistantText")) {
        current.result = {
          ...asRecord(current.result),
          assistantText: String(output["assistantText"] ?? ""),
        };
      }
      const nextResult = output["result"];
      if (isRecord(nextResult)) {
        current.result = {
          ...asRecord(current.result),
          ...nextResult,
        };
      }
    }

    return current;
  }

  async notifyApprovalRequested(approval: Record<string, unknown>): Promise<void> {
    await this.runHook("onApprovalRequested", {
      approval,
      runtimeId: this.runtimeId,
    });
  }

  async runHook(hookName: string, payload: CapabilityHookPayload): Promise<void> {
    const normalizedHook = String(hookName ?? "").trim() as CapabilityHookName;
    if (!isCapabilityHookName(normalizedHook)) {
      return;
    }

    for (const capability of this.loadedCapabilities) {
      if (capability.status !== "loaded") {
        continue;
      }
      const hook = capability.instance?.[normalizedHook];
      if (typeof hook !== "function") {
        continue;
      }

      await this.#runCapabilityHook({
        capability,
        hookName: normalizedHook,
        payload: freezeShallow({
          ...payload,
          runtimeId: this.runtimeId,
        }),
      });
    }
  }

  async #runCapabilityHook({
    capability,
    hookName,
    payload,
  }: {
    capability: LoadedCapability;
    hookName: CapabilityHookName;
    payload: CapabilityHookPayload;
  }): Promise<unknown | null> {
    const timeoutMs = clampTimeoutMs(capability.timeoutMs);
    const hook = capability.instance?.[hookName];
    if (typeof hook !== "function") {
      return null;
    }
    const work = Promise.resolve((hook as CapabilityHookFn)(payload));
    try {
      return await withTimeout(work, timeoutMs, `${capability.id}.${hookName}`);
    } catch (error) {
      capability.error = sanitizeError(error);
      capability.status = "degraded";
      return null;
    }
  }

  async #loadCapability({
    id,
    definition,
  }: {
    id: string;
    definition: CapabilityDefinition;
  }): Promise<LoadedCapability> {
    const manifestPath = resolvePath(definition.manifestPath, this.workspaceRoot);
    const manifest = await readManifest(manifestPath);

    if (
      manifest.minKernelVersion &&
      compareSemver(this.kernelVersion, manifest.minKernelVersion) < 0
    ) {
      throw new Error(
        `Capability '${id}' requires kernel ${manifest.minKernelVersion}, current kernel is ${this.kernelVersion}.`,
      );
    }

    const declaredHooks = (Array.isArray(manifest.hooks) ? manifest.hooks : [])
      .map((entry) => String(entry ?? "").trim())
      .filter(isCapabilityHookName);
    const entryPath = path.resolve(
      path.dirname(manifestPath),
      String(manifest.entry ?? "index.js"),
    );
    const moduleUrl = `${pathToFileURL(entryPath).href}?ts=${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const loadedModule = await import(moduleUrl);
    const factory = resolveCapabilityFactory(loadedModule);
    const instance = (await factory({
      runtimeId: this.runtimeId,
      capabilityId: id,
      manifest,
      options: definition.options ?? {},
    })) as CapabilityInstance;

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
      instance,
    };
  }
}

async function readManifest(manifestPath: string): Promise<CapabilityManifest> {
  const raw = await fs.readFile(manifestPath, "utf8");
  const parsed = JSON.parse(raw) as Record<string, unknown>;
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
    timeoutMs: clampTimeoutMs(parsed.timeoutMs),
  };
}

function resolveCapabilityFactory(
  loadedModule: Record<string, unknown> | null | undefined,
): (payload: {
  runtimeId: string;
  capabilityId: string;
  manifest: CapabilityManifest;
  options: Record<string, unknown>;
}) => Promise<CapabilityInstance> | CapabilityInstance {
  if (typeof loadedModule?.createCapability === "function") {
    return loadedModule.createCapability as (payload: {
      runtimeId: string;
      capabilityId: string;
      manifest: CapabilityManifest;
      options: Record<string, unknown>;
    }) => Promise<CapabilityInstance> | CapabilityInstance;
  }
  if (typeof loadedModule?.default === "function") {
    return loadedModule.default as (payload: {
      runtimeId: string;
      capabilityId: string;
      manifest: CapabilityManifest;
      options: Record<string, unknown>;
    }) => Promise<CapabilityInstance> | CapabilityInstance;
  }
  if (loadedModule?.default && typeof loadedModule.default === "object") {
    return async () => loadedModule.default as CapabilityInstance;
  }
  throw new Error(
    "Capability module must export createCapability(), default function, or default object.",
  );
}

function clampTimeoutMs(value: unknown): number {
  const parsed = Number.parseInt(String(value ?? "5000"), 10);
  if (!Number.isFinite(parsed) || parsed < 100) {
    return 5000;
  }
  return Math.min(parsed, 60000);
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`Capability hook timeout (${label}) after ${timeoutMs}ms.`));
    }, timeoutMs);
  });

  return Promise.race<T>([promise, timeoutPromise]).finally(() => {
    if (timer) {
      clearTimeout(timer);
    }
  });
}

function freezeShallow<T>(value: T): T {
  if (!value || typeof value !== "object") {
    return value;
  }
  return Object.freeze({ ...(value as Record<string, unknown>) }) as T;
}

function sanitizeError(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  return raw.split(/\r?\n/).slice(0, 12).join("\n");
}

function resolvePath(candidate: unknown, workspaceRoot: string): string {
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

function compareSemver(a: unknown, b: unknown): number {
  const left = parseSemver(a);
  const right = parseSemver(b);
  if (left[0] > right[0]) {
    return 1;
  }
  if (left[0] < right[0]) {
    return -1;
  }
  if (left[1] > right[1]) {
    return 1;
  }
  if (left[1] < right[1]) {
    return -1;
  }
  if (left[2] > right[2]) {
    return 1;
  }
  if (left[2] < right[2]) {
    return -1;
  }
  return 0;
}

function parseSemver(value: unknown): [number, number, number] {
  const parts = String(value ?? "0.0.0")
    .split(".")
    .slice(0, 3)
    .map((entry) => Number.parseInt(entry, 10));
  while (parts.length < 3) {
    parts.push(0);
  }
  const normalized = parts.map((entry) => (Number.isFinite(entry) && entry >= 0 ? entry : 0));
  return [normalized[0] ?? 0, normalized[1] ?? 0, normalized[2] ?? 0];
}

function isCapabilityHookName(value: string): value is CapabilityHookName {
  return SUPPORTED_HOOKS.has(value as CapabilityHookName);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object";
}

function asRecord(value: unknown): Record<string, unknown> {
  return isRecord(value) ? { ...value } : {};
}
