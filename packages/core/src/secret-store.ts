import fs from "node:fs/promises";
import path from "node:path";

const SECRET_NAME_PATTERN = /^[A-Za-z0-9._:-]{1,120}$/;

export class KernelSecretStore {
  filePath: string;
  secrets: Map<string, string>;
  initialized: boolean;

  constructor(filePath: unknown) {
    this.filePath = path.resolve(String(filePath));
    this.secrets = new Map<string, string>();
    this.initialized = false;
  }

  async init(): Promise<void> {
    if (this.initialized) {
      return;
    }

    try {
      const raw = await fs.readFile(this.filePath, "utf8");
      const parsed = JSON.parse(stripBom(raw));
      this.loadFromParsed(parsed);
    } catch (error) {
      if (getErrorCode(error) !== "ENOENT") {
        throw error;
      }
      await fs.mkdir(path.dirname(this.filePath), { recursive: true });
      await this.flush();
    }

    this.initialized = true;
  }

  getSecret(name: unknown): string | null {
    const key = normalizeSecretName(name);
    return this.secrets.get(key) ?? null;
  }

  listSecretNames(): string[] {
    return [...this.secrets.keys()].sort((a, b) => a.localeCompare(b));
  }

  async setSecret(name: unknown, value: unknown): Promise<{ name: string }> {
    const key = normalizeSecretName(name);
    const secretValue = normalizeSecretValue(value);
    this.secrets.set(key, secretValue);
    await this.flush();
    return { name: key };
  }

  async deleteSecret(name: unknown): Promise<{ name: string; deleted: boolean }> {
    const key = normalizeSecretName(name);
    const existed = this.secrets.delete(key);
    await this.flush();
    return { name: key, deleted: existed };
  }

  private loadFromParsed(parsed: unknown): void {
    const parsedObj = parsed && typeof parsed === "object" ? parsed : {};
    const entries = (parsedObj as { secrets?: unknown }).secrets;
    if (!entries || typeof entries !== "object") {
      this.secrets = new Map<string, string>();
      return;
    }

    const next = new Map<string, string>();
    for (const [rawName, rawValue] of Object.entries(entries)) {
      if (!SECRET_NAME_PATTERN.test(String(rawName))) {
        continue;
      }
      const value = String(rawValue ?? "");
      if (!value.trim()) {
        continue;
      }
      next.set(String(rawName), value);
    }
    this.secrets = next;
  }

  private async flush(): Promise<void> {
    const serialized = {
      version: 1,
      updatedAt: new Date().toISOString(),
      secrets: Object.fromEntries(this.secrets.entries()),
    };
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    await fs.writeFile(this.filePath, `${JSON.stringify(serialized, null, 2)}\n`, "utf8");
  }
}

function normalizeSecretName(value: unknown): string {
  const name = String(value ?? "").trim();
  if (!SECRET_NAME_PATTERN.test(name)) {
    throw new Error(
      "Invalid secret name. Allowed: letters, numbers, dot, underscore, dash, colon.",
    );
  }
  return name;
}

function normalizeSecretValue(value: unknown): string {
  const text = String(value ?? "").trim();
  if (!text) {
    throw new Error("Secret value cannot be empty.");
  }
  return text;
}

function stripBom(value: unknown): string {
  const text = String(value ?? "");
  if (text.charCodeAt(0) === 0xfeff) {
    return text.slice(1);
  }
  return text;
}

function getErrorCode(error: unknown): string {
  if (!error || typeof error !== "object") {
    return "";
  }
  return String((error as { code?: unknown }).code ?? "")
    .trim()
    .toUpperCase();
}
