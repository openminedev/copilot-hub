import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { JsonStateStore } from "../dist/state-store.js";

test("JsonStateStore recovers from malformed JSON by backing up and resetting state", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "copilot-hub-state-"));
  const statePath = path.join(root, "sessions.json");

  try {
    await fs.writeFile(statePath, '{"version": 3,', "utf8");

    const store = new JsonStateStore(statePath);
    await store.init();

    const thread = await store.ensureThread("thread-a");
    assert.equal(thread.turnCount, 0);
    assert.equal(thread.sessionId, null);

    const files = await fs.readdir(root);
    const backups = files.filter((entry) => entry.startsWith("sessions.json.corrupt-"));
    assert.equal(backups.length, 1);

    const repaired = JSON.parse(await fs.readFile(statePath, "utf8"));
    assert.equal(repaired.version, 3);
    assert.deepEqual(repaired.threads["thread-a"].messages, []);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
