import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { loadCopilotHubEnvironment } from "../dist/env-config.js";

test("loadCopilotHubEnvironment lets env file values override stale process env values", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "copilot-hub-env-config-"));
  const envPath = path.join(tempDir, "control-plane.env");
  fs.writeFileSync(
    envPath,
    [
      "HUB_TELEGRAM_TOKEN_ENV=HUB_TELEGRAM_TOKEN_FILE",
      "HUB_TELEGRAM_TOKEN_FILE=123456:valid_file_value_ABCDEFGHIJKLMNOPQRSTUVWXYZ",
      "DEFAULT_WORKSPACE_ROOT=./copilot_workspaces",
      "",
    ].join("\n"),
    "utf8",
  );

  const env = {
    COPILOT_HUB_ENV_PATH: envPath,
    HUB_TELEGRAM_TOKEN_ENV: "HUB_TELEGRAM_TOKEN",
    HUB_TELEGRAM_TOKEN: "123456:stale_process_value_ABCDEFGHIJKLMNOPQRSTUVWXYZ",
    DEFAULT_WORKSPACE_ROOT: "C:/stale/process/workspace",
  };

  const loaded = loadCopilotHubEnvironment({
    env,
    cwd: tempDir,
  });

  assert.equal(loaded.baseDir, tempDir);
  assert.equal(loaded.envPath, envPath);
  assert.equal(env.HUB_TELEGRAM_TOKEN_ENV, "HUB_TELEGRAM_TOKEN_FILE");
  assert.equal(env.HUB_TELEGRAM_TOKEN_FILE, "123456:valid_file_value_ABCDEFGHIJKLMNOPQRSTUVWXYZ");
  assert.equal(env.DEFAULT_WORKSPACE_ROOT, "./copilot_workspaces");
  assert.deepEqual(loaded.overriddenKeys.sort(), [
    "DEFAULT_WORKSPACE_ROOT",
    "HUB_TELEGRAM_TOKEN_ENV",
  ]);
});

test("loadCopilotHubEnvironment preserves injected runtime paths when requested", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "copilot-hub-env-preserve-"));
  const envPath = path.join(tempDir, "agent-engine.env");
  fs.writeFileSync(
    envPath,
    [
      "BOT_REGISTRY_FILE=./data/bot-registry.json",
      "SECRET_STORE_FILE=./data/secrets.json",
      "",
    ].join("\n"),
    "utf8",
  );

  const env = {
    COPILOT_HUB_ENV_PATH: envPath,
    BOT_REGISTRY_FILE: path.join(tempDir, "managed", "bot-registry.json"),
    SECRET_STORE_FILE: path.join(tempDir, "managed", "secrets.json"),
  };

  const loaded = loadCopilotHubEnvironment({
    env,
    cwd: tempDir,
    preserveExistingKeys: ["BOT_REGISTRY_FILE", "SECRET_STORE_FILE"],
  });

  assert.equal(loaded.envPath, envPath);
  assert.equal(env.BOT_REGISTRY_FILE, path.join(tempDir, "managed", "bot-registry.json"));
  assert.equal(env.SECRET_STORE_FILE, path.join(tempDir, "managed", "secrets.json"));
  assert.deepEqual(loaded.overriddenKeys, []);
});
