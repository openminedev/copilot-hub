import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  initializeCopilotHubLayout,
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
    path.resolve("/home/amine/.config", "copilot-hub"),
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
  fs.writeFileSync(legacyEngineEnvPath, "TELEGRAM_TOKEN_AGENT_1=123:abc\n", "utf8");
  fs.writeFileSync(legacyControlEnvPath, "HUB_TELEGRAM_TOKEN=456:def\n", "utf8");
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
});
