import fs from "node:fs/promises";
import path from "node:path";

export class InstanceLock {
  lockFilePath: string;
  owned: boolean;

  constructor(lockFilePath: unknown) {
    this.lockFilePath = path.resolve(String(lockFilePath));
    this.owned = false;
  }

  async acquire(): Promise<void> {
    await fs.mkdir(path.dirname(this.lockFilePath), { recursive: true });

    try {
      await this.writeLockFile();
      this.owned = true;
      return;
    } catch (error) {
      if (getErrorCode(error) !== "EEXIST") {
        throw error;
      }
    }

    const stale = await this.detectStaleLock();
    if (!stale) {
      throw new Error(`Another bridge instance is already running (lock: ${this.lockFilePath}).`);
    }

    await fs.rm(this.lockFilePath, { force: true });
    await this.writeLockFile();
    this.owned = true;
  }

  async release(): Promise<void> {
    if (!this.owned) {
      return;
    }
    await fs.rm(this.lockFilePath, { force: true });
    this.owned = false;
  }

  private async writeLockFile(): Promise<void> {
    const payload = JSON.stringify(
      {
        pid: process.pid,
        createdAt: new Date().toISOString(),
        cwd: process.cwd(),
      },
      null,
      2,
    );
    await fs.writeFile(this.lockFilePath, `${payload}\n`, { encoding: "utf8", flag: "wx" });
  }

  private async detectStaleLock(): Promise<boolean> {
    try {
      const raw = await fs.readFile(this.lockFilePath, "utf8");
      const lock = JSON.parse(raw) as { pid?: unknown };
      const pid = Number.parseInt(String(lock?.pid ?? ""), 10);
      if (!Number.isFinite(pid) || pid < 1) {
        return true;
      }
      try {
        process.kill(pid, 0);
        return false;
      } catch {
        return true;
      }
    } catch {
      return true;
    }
  }
}

function getErrorCode(error: unknown): string {
  if (!error || typeof error !== "object") {
    return "";
  }
  return String((error as { code?: unknown }).code ?? "")
    .trim()
    .toUpperCase();
}
