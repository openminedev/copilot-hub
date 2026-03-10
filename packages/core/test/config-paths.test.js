import assert from "node:assert/strict";
import test from "node:test";
import {
  resolveConfigBaseDir,
  resolveOptionalPathFromBase,
  resolvePathFromBase,
  resolveProcessConfigBaseDir,
} from "../dist/config-paths.js";

test("resolveConfigBaseDir prefers explicit base dir then env file dir", () => {
  assert.equal(
    resolveConfigBaseDir({
      configuredBaseDir: "C:/Users/amine/AppData/Roaming/copilot-hub/config",
      configuredEnvPath: "C:/ignored/.env",
      cwd: "C:/cwd",
    }),
    "C:\\Users\\amine\\AppData\\Roaming\\copilot-hub\\config",
  );
  assert.equal(
    resolveConfigBaseDir({
      configuredEnvPath: "C:/Users/amine/AppData/Roaming/copilot-hub/config/agent-engine.env",
      cwd: "C:/cwd",
    }),
    "C:\\Users\\amine\\AppData\\Roaming\\copilot-hub\\config",
  );
  assert.equal(
    resolveConfigBaseDir({
      cwd: "C:/cwd",
    }),
    "C:\\cwd",
  );
});

test("resolvePathFromBase resolves relative values against the config base dir", () => {
  const baseDir = "C:/Users/amine/AppData/Roaming/copilot-hub/config";
  assert.equal(
    resolvePathFromBase("./data", baseDir),
    "C:\\Users\\amine\\AppData\\Roaming\\copilot-hub\\config\\data",
  );
  assert.equal(resolvePathFromBase("D:/absolute/path", baseDir), "D:\\absolute\\path");
  assert.equal(resolveOptionalPathFromBase("", baseDir), null);
});

test("resolveProcessConfigBaseDir reads the persisted config base env", () => {
  assert.equal(
    resolveProcessConfigBaseDir({
      env: {
        COPILOT_HUB_ENV_BASE_DIR: "C:/Users/amine/AppData/Roaming/copilot-hub/config",
      },
      cwd: "C:/cwd",
    }),
    "C:\\Users\\amine\\AppData\\Roaming\\copilot-hub\\config",
  );
  assert.equal(
    resolveProcessConfigBaseDir({
      env: {
        COPILOT_HUB_ENV_PATH: "C:/Users/amine/AppData/Roaming/copilot-hub/config/control-plane.env",
      },
      cwd: "C:/cwd",
    }),
    "C:\\Users\\amine\\AppData\\Roaming\\copilot-hub\\config",
  );
});
