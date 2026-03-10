import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { normalizeConfiguredCodexBin } from "../dist/codex-runtime.mjs";

test("normalizeConfiguredCodexBin remaps absolute Windows npm wrappers to codex.js", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "copilot-hub-codex-bin-"));
  const wrapperDir = path.join(tempDir, "npm");
  const packageDir = path.join(wrapperDir, "node_modules", "@openai", "codex", "bin");
  fs.mkdirSync(packageDir, { recursive: true });

  const wrapperPath = path.join(wrapperDir, "codex.cmd");
  const entrypointPath = path.join(packageDir, "codex.js");
  fs.writeFileSync(wrapperPath, "@echo off\r\n", "utf8");
  fs.writeFileSync(entrypointPath, "console.log('ok');\n", "utf8");

  const resolved = normalizeConfiguredCodexBin({
    value: wrapperPath,
    env: {},
    repoRoot: tempDir,
    platform: "win32",
  });

  assert.equal(resolved, entrypointPath);
});

test("normalizeConfiguredCodexBin resolves bare codex.cmd through detected npm install", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "copilot-hub-codex-bin-"));
  const appDataDir = path.join(tempDir, "AppData", "Roaming");
  const packageDir = path.join(appDataDir, "npm", "node_modules", "@openai", "codex", "bin");
  fs.mkdirSync(packageDir, { recursive: true });

  const entrypointPath = path.join(packageDir, "codex.js");
  fs.writeFileSync(entrypointPath, "console.log('ok');\n", "utf8");

  const resolved = normalizeConfiguredCodexBin({
    value: "codex.cmd",
    env: {
      APPDATA: appDataDir,
    },
    repoRoot: tempDir,
    platform: "win32",
  });

  assert.equal(resolved, entrypointPath);
});

test("normalizeConfiguredCodexBin preserves non-wrapper commands", () => {
  const resolved = normalizeConfiguredCodexBin({
    value: "C:/tools/codex.exe",
    env: {},
    repoRoot: process.cwd(),
    platform: "win32",
  });

  assert.equal(resolved, "C:/tools/codex.exe");
});
