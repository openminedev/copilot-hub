import fs from "node:fs/promises";
import path from "node:path";

export class InstanceLock {
  constructor(lockFilePath) {
    this.lockFilePath = path.resolve(String(lockFilePath));
    this.owned = false;
  }

  async acquire() {
    await fs.mkdir(path.dirname(this.lockFilePath), { recursive: true });

    try {
      await this.#writeLockFile();
      this.owned = true;
      return;
    } catch (error) {
      if (error?.code !== "EEXIST") {
        throw error;
      }
    }

    const stale = await this.#detectStaleLock();
    if (!stale) {
      throw new Error(`Another bridge instance is already running (lock: ${this.lockFilePath}).`);
    }

    await fs.rm(this.lockFilePath, { force: true });
    await this.#writeLockFile();
    this.owned = true;
  }

  async release() {
    if (!this.owned) {
      return;
    }
    await fs.rm(this.lockFilePath, { force: true });
    this.owned = false;
  }

  async #writeLockFile() {
    const payload = JSON.stringify(
      {
        pid: process.pid,
        createdAt: new Date().toISOString(),
        cwd: process.cwd()
      },
      null,
      2
    );
    await fs.writeFile(this.lockFilePath, `${payload}\n`, { encoding: "utf8", flag: "wx" });
  }

  async #detectStaleLock() {
    try {
      const raw = await fs.readFile(this.lockFilePath, "utf8");
      const lock = JSON.parse(raw);
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
