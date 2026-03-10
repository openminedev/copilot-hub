import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  resolveConfigBaseDir,
  resolveOptionalPathFromBase,
  resolvePathFromBase,
  resolveProcessConfigBaseDir,
} from "../dist/config-paths.js";

test("resolveConfigBaseDir prefers explicit base dir then env file dir", () => {
  const tempRoot = path.join(os.tmpdir(), "copilot-hub-config-paths");
  const explicitBaseDir = path.join(tempRoot, "config");
  const envFilePath = path.join(explicitBaseDir, "agent-engine.env");
  const cwd = path.join(tempRoot, "cwd");

  assert.equal(
    resolveConfigBaseDir({
      configuredBaseDir: explicitBaseDir,
      configuredEnvPath: path.join(tempRoot, "ignored.env"),
      cwd,
    }),
    path.resolve(explicitBaseDir),
  );
  assert.equal(
    resolveConfigBaseDir({
      configuredEnvPath: envFilePath,
      cwd,
    }),
    path.resolve(explicitBaseDir),
  );
  assert.equal(
    resolveConfigBaseDir({
      cwd,
    }),
    path.resolve(cwd),
  );
});

test("resolvePathFromBase resolves relative values against the config base dir", () => {
  const baseDir = path.join(os.tmpdir(), "copilot-hub-config-paths", "config");
  const absoluteTarget = path.join(path.parse(baseDir).root, "absolute-target");

  assert.equal(resolvePathFromBase("./data", baseDir), path.resolve(baseDir, "./data"));
  assert.equal(resolvePathFromBase(absoluteTarget, baseDir), path.resolve(absoluteTarget));
  assert.equal(resolveOptionalPathFromBase("", baseDir), null);
});

test("resolveProcessConfigBaseDir reads the persisted config base env", () => {
  const configBaseDir = path.join(os.tmpdir(), "copilot-hub-config-paths", "config");
  const envFilePath = path.join(configBaseDir, "control-plane.env");
  const cwd = path.join(os.tmpdir(), "copilot-hub-config-paths", "cwd");

  assert.equal(
    resolveProcessConfigBaseDir({
      env: {
        COPILOT_HUB_ENV_BASE_DIR: configBaseDir,
      },
      cwd,
    }),
    path.resolve(configBaseDir),
  );
  assert.equal(
    resolveProcessConfigBaseDir({
      env: {
        COPILOT_HUB_ENV_PATH: envFilePath,
      },
      cwd,
    }),
    path.resolve(configBaseDir),
  );
});
