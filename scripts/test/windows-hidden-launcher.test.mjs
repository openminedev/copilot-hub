import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  buildWindowsHiddenLauncherCommand,
  buildWindowsHiddenLauncherContent,
  ensureWindowsHiddenLauncher,
  getWindowsHiddenLauncherStopSignalPath,
  resolveWindowsScriptHost,
} from "../dist/windows-hidden-launcher.mjs";

test("resolveWindowsScriptHost prefers SystemRoot", () => {
  const actual = resolveWindowsScriptHost({ SystemRoot: "D:\\Windows" });
  assert.equal(actual, path.win32.join("D:\\Windows", "System32", "wscript.exe"));
});

test("buildWindowsHiddenLauncherCommand uses wscript in batch mode", () => {
  const actual = buildWindowsHiddenLauncherCommand("C:\\runtime\\launcher.vbs", {
    SystemRoot: "C:\\Windows",
  });
  assert.equal(
    actual,
    '"C:\\Windows\\System32\\wscript.exe" //B //Nologo "C:\\runtime\\launcher.vbs"',
  );
});

test("buildWindowsHiddenLauncherContent starts daemon in hidden mode", () => {
  const content = buildWindowsHiddenLauncherContent({
    nodeBin: "C:\\Program Files\\nodejs\\node.exe",
    daemonScriptPath: "C:\\Program Files\\copilot-hub\\scripts\\dist\\daemon.mjs",
    runtimeDir: "C:\\Users\\amine\\AppData\\Roaming\\copilot-hub\\runtime",
  });

  assert.match(content, /CreateObject\("WScript\.Shell"\)/);
  assert.match(content, /CreateObject\("Scripting\.FileSystemObject"\)/);
  assert.match(content, /shell\.Run/);
  assert.match(content, /, 0, True/);
  assert.match(content, /restartDelayMs = 5000/);
  assert.match(content, /WScript\.Sleep restartDelayMs/);
  assert.match(content, /"run"/);
  assert.match(content, /windows-daemon-launcher\.stop/);
});

test("ensureWindowsHiddenLauncher writes and preserves launcher content", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "copilot-hub-launcher-"));
  const scriptPath = path.join(tempDir, "windows-daemon-launcher.vbs");

  try {
    ensureWindowsHiddenLauncher({
      scriptPath,
      nodeBin: "C:\\node.exe",
      daemonScriptPath: "C:\\copilot-hub\\daemon.mjs",
      runtimeDir: "C:\\copilot-hub\\runtime",
    });

    const first = fs.readFileSync(scriptPath, "utf8");
    ensureWindowsHiddenLauncher({
      scriptPath,
      nodeBin: "C:\\node.exe",
      daemonScriptPath: "C:\\copilot-hub\\daemon.mjs",
      runtimeDir: "C:\\copilot-hub\\runtime",
    });
    const second = fs.readFileSync(scriptPath, "utf8");

    assert.equal(second, first);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("getWindowsHiddenLauncherStopSignalPath uses the runtime directory", () => {
  const actual = getWindowsHiddenLauncherStopSignalPath(
    "C:\\Users\\amine\\AppData\\Roaming\\copilot-hub\\runtime",
  );
  assert.equal(
    actual,
    "C:\\Users\\amine\\AppData\\Roaming\\copilot-hub\\runtime\\windows-daemon-launcher.stop",
  );
});
