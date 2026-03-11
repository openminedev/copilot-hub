import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  initializeCopilotHubLayout,
  resetCopilotHubConfig,
  resolveCopilotHubHomeDir,
  resolveCopilotHubLayout,
} from "../dist/install-layout.mjs";

test("resolveCopilotHubHomeDir uses the standard per-user appdata location", () => {
  assert.equal(
    resolveCopilotHubHomeDir({
      platform: "win32",
      env: {
        APPDATA: "C:/Users/amine/AppData/Roaming",
      },
      homeDirectory: "C:/Users/amine",
    }),
    path.win32.join("C:/Users/amine/AppData/Roaming", "copilot-hub"),
  );
  assert.equal(
    resolveCopilotHubHomeDir({
      platform: "linux",
      env: {
        XDG_CONFIG_HOME: "/home/amine/.config",
      },
      homeDirectory: "/home/amine",
    }),
    path.posix.join("/home/amine/.config", "copilot-hub"),
  );
});

test("initializeCopilotHubLayout migrates legacy env and data files once", () => {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "copilot-hub-layout-"));
  const legacyEngineEnvPath = path.join(repoRoot, "apps", "agent-engine", ".env");
  const legacyControlEnvPath = path.join(repoRoot, "apps", "control-plane", ".env");
  const legacyEngineDataFile = path.join(repoRoot, "apps", "agent-engine", "data", "state.json");
  const legacyEngineLockPath = path.join(repoRoot, "apps", "agent-engine", "data", "runtime.lock");
  const legacyPromptStatePath = path.join(repoRoot, ".copilot-hub", "service-onboarding.json");
  const homeDir = path.join(repoRoot, "user-home");

  fs.mkdirSync(path.dirname(legacyEngineEnvPath), { recursive: true });
  fs.mkdirSync(path.dirname(legacyControlEnvPath), { recursive: true });
  fs.mkdirSync(path.dirname(legacyEngineDataFile), { recursive: true });
  fs.mkdirSync(path.dirname(legacyPromptStatePath), { recursive: true });
  fs.writeFileSync(
    legacyEngineEnvPath,
    ["TELEGRAM_TOKEN_AGENT_1=123:abc", "BOT_REGISTRY_FILE=./data/bot-registry.json", ""].join("\n"),
    "utf8",
  );
  fs.writeFileSync(
    legacyControlEnvPath,
    ["HUB_TELEGRAM_TOKEN=456:def", "HUB_DATA_DIR=./data/copilot_hub", ""].join("\n"),
    "utf8",
  );
  fs.writeFileSync(legacyEngineDataFile, '{"ok":true}\n', "utf8");
  fs.writeFileSync(legacyEngineLockPath, "stale-lock\n", "utf8");
  fs.writeFileSync(legacyPromptStatePath, '{"decision":"accepted"}\n', "utf8");

  const layout = resolveCopilotHubLayout({
    repoRoot,
    env: {
      COPILOT_HUB_HOME_DIR: homeDir,
    },
    homeDirectory: repoRoot,
  });

  const initialized = initializeCopilotHubLayout({ repoRoot, layout });

  assert.ok(initialized.migratedPaths.includes(layout.agentEngineEnvPath));
  assert.ok(initialized.migratedPaths.includes(layout.controlPlaneEnvPath));
  assert.ok(initialized.migratedPaths.includes(layout.agentEngineDataDir));
  assert.ok(initialized.migratedPaths.includes(layout.servicePromptStatePath));
  assert.equal(
    fs.readFileSync(layout.agentEngineEnvPath, "utf8"),
    "TELEGRAM_TOKEN_AGENT_1=123:abc\n",
  );
  assert.equal(fs.readFileSync(layout.controlPlaneEnvPath, "utf8"), "HUB_TELEGRAM_TOKEN=456:def\n");
  assert.equal(
    fs.readFileSync(path.join(layout.agentEngineDataDir, "state.json"), "utf8"),
    '{"ok":true}\n',
  );
  assert.equal(fs.existsSync(path.join(layout.agentEngineDataDir, "runtime.lock")), false);
  assert.equal(fs.readFileSync(layout.servicePromptStatePath, "utf8"), '{"decision":"accepted"}\n');

  const secondPass = initializeCopilotHubLayout({ repoRoot, layout });
  assert.deepEqual(secondPass.migratedPaths, []);
  assert.deepEqual(secondPass.normalizedEnvPaths, []);
});

test("resetCopilotHubConfig removes persisted state but keeps the layout shell", () => {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "copilot-hub-reset-"));
  const layout = resolveCopilotHubLayout({
    repoRoot,
    env: {
      COPILOT_HUB_HOME_DIR: path.join(repoRoot, "user-home"),
    },
    homeDirectory: repoRoot,
  });

  initializeCopilotHubLayout({ repoRoot, layout });
  fs.writeFileSync(layout.agentEngineEnvPath, "TELEGRAM_TOKEN_AGENT_1=123:abc\n", "utf8");
  fs.mkdirSync(layout.agentEngineDataDir, { recursive: true });
  fs.writeFileSync(
    path.join(layout.agentEngineDataDir, "bot-registry.json"),
    '{"version":3}\n',
    "utf8",
  );
  fs.mkdirSync(path.join(layout.runtimeDir, "pids"), { recursive: true });
  fs.writeFileSync(path.join(layout.runtimeDir, "pids", "daemon.json"), '{"pid":1}\n', "utf8");
  fs.writeFileSync(layout.servicePromptStatePath, '{"decision":"accepted"}\n', "utf8");
  fs.writeFileSync(
    path.join(layout.runtimeDir, "windows-daemon-launcher.vbs"),
    "' launcher\n",
    "utf8",
  );

  const reset = resetCopilotHubConfig({ layout });

  assert.ok(reset.removedPaths.includes(layout.configDir));
  assert.ok(reset.removedPaths.includes(layout.dataDir));
  assert.ok(reset.removedPaths.includes(layout.logsDir));
  assert.ok(fs.existsSync(layout.configDir));
  assert.ok(fs.existsSync(layout.dataDir));
  assert.ok(fs.existsSync(layout.logsDir));
  assert.equal(fs.existsSync(layout.agentEngineEnvPath), false);
  assert.equal(fs.existsSync(path.join(layout.agentEngineDataDir, "bot-registry.json")), false);
  assert.equal(fs.existsSync(path.join(layout.runtimeDir, "pids")), false);
  assert.equal(fs.existsSync(layout.servicePromptStatePath), false);
  assert.equal(fs.existsSync(path.join(layout.runtimeDir, "windows-daemon-launcher.vbs")), true);
});
