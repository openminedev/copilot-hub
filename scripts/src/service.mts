#!/usr/bin/env node
// @ts-nocheck
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { initializeCopilotHubLayout, resolveCopilotHubLayout } from "./install-layout.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "..", "..");
const layout = resolveCopilotHubLayout({ repoRoot });
initializeCopilotHubLayout({ repoRoot, layout });
const nodeBin = process.execPath;
const daemonScriptPath = path.join(repoRoot, "scripts", "dist", "daemon.mjs");

const WINDOWS_TASK_NAME = "CopilotHub";
const WINDOWS_RUN_KEY_PATH = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run";
const WINDOWS_RUN_VALUE_NAME = "CopilotHub";
const LINUX_UNIT_NAME = "copilot-hub.service";
const MACOS_LABEL = "com.copilot-hub.service";

const action = String(process.argv[2] ?? "status")
  .trim()
  .toLowerCase();

try {
  await main();
} catch (error) {
  console.error(getErrorMessage(error));
  process.exit(1);
}

async function main() {
  switch (action) {
    case "install":
      await installService();
      return;
    case "uninstall":
      await uninstallService();
      return;
    case "status":
      await showStatus();
      return;
    case "start":
      await startService();
      return;
    case "stop":
      await stopService();
      return;
    case "help":
      printUsage();
      return;
    default:
      printUsage();
      process.exit(1);
  }
}

async function installService() {
  ensureDaemonScript();

  if (process.platform === "win32") {
    const mode = installWindowsAutoStart();
    if (mode === "task") {
      console.log("Service installed (Windows Task Scheduler).");
    } else {
      console.log("Service installed (Windows startup registry entry).");
    }
    return;
  }

  if (process.platform === "linux") {
    installLinuxService();
    console.log("Service installed (systemd user service).");
    return;
  }

  if (process.platform === "darwin") {
    installMacosService();
    console.log("Service installed (launchd user agent).");
    return;
  }

  throw new Error(`Unsupported platform: ${process.platform}`);
}

async function uninstallService() {
  if (process.platform === "win32") {
    const removed = uninstallWindowsAutoStart();
    if (!removed) {
      console.log("Service auto-start is already absent.");
      return;
    }
    console.log("Service uninstalled (Windows auto-start).");
    return;
  }

  if (process.platform === "linux") {
    uninstallLinuxService();
    console.log("Service uninstalled (systemd user service).");
    return;
  }

  if (process.platform === "darwin") {
    uninstallMacosService();
    console.log("Service uninstalled (launchd user agent).");
    return;
  }

  throw new Error(`Unsupported platform: ${process.platform}`);
}

async function showStatus() {
  if (process.platform === "win32") {
    showWindowsAutoStartStatus();
    return;
  }

  if (process.platform === "linux") {
    showLinuxServiceStatus();
    return;
  }

  if (process.platform === "darwin") {
    showMacosServiceStatus();
    return;
  }

  throw new Error(`Unsupported platform: ${process.platform}`);
}

async function startService() {
  if (process.platform === "win32") {
    startWindowsAutoStart();
    return;
  }

  if (process.platform === "linux") {
    ensureSystemctl();
    runChecked("systemctl", ["--user", "start", LINUX_UNIT_NAME], { stdio: "inherit" });
    return;
  }

  if (process.platform === "darwin") {
    startMacosService();
    return;
  }

  throw new Error(`Unsupported platform: ${process.platform}`);
}

async function stopService() {
  if (process.platform === "win32") {
    runDaemon("stop");
    return;
  }

  if (process.platform === "linux") {
    ensureSystemctl();
    runChecked("systemctl", ["--user", "stop", LINUX_UNIT_NAME], { stdio: "inherit" });
    return;
  }

  if (process.platform === "darwin") {
    stopMacosService();
    return;
  }

  throw new Error(`Unsupported platform: ${process.platform}`);
}

function installWindowsAutoStart() {
  ensureCommandAvailable("schtasks", ["/?"], "Windows Task Scheduler is not available.");
  ensureCommandAvailable(
    "reg",
    ["query", WINDOWS_RUN_KEY_PATH],
    "Windows registry tools are not available.",
  );

  const command = buildWindowsLaunchCommand();
  const taskCreate = runChecked(
    "schtasks",
    ["/Create", "/TN", WINDOWS_TASK_NAME, "/SC", "ONLOGON", "/RL", "LIMITED", "/F", "/TR", command],
    { allowFailure: true },
  );
  if (taskCreate.ok) {
    runWindowsTask();
    return "task";
  }

  if (!isAccessDeniedMessage(taskCreate.combinedOutput)) {
    throw new Error(taskCreate.combinedOutput || "Failed to create Windows auto-start task.");
  }

  installWindowsRunKey(command);
  runDaemon("start");
  return "run-key";
}

function uninstallWindowsAutoStart() {
  ensureCommandAvailable("schtasks", ["/?"], "Windows Task Scheduler is not available.");
  ensureCommandAvailable(
    "reg",
    ["query", WINDOWS_RUN_KEY_PATH],
    "Windows registry tools are not available.",
  );
  runDaemon("stop", { allowFailure: true });

  let removed = false;

  const taskDelete = runChecked("schtasks", ["/Delete", "/TN", WINDOWS_TASK_NAME, "/F"], {
    allowFailure: true,
  });
  if (taskDelete.ok) {
    removed = true;
  } else if (
    !isNotFoundMessage(taskDelete.combinedOutput) &&
    !isAccessDeniedMessage(taskDelete.combinedOutput)
  ) {
    throw new Error(taskDelete.combinedOutput || "Failed to remove Windows Task Scheduler entry.");
  }

  const runKeyDelete = runChecked(
    "reg",
    ["delete", WINDOWS_RUN_KEY_PATH, "/v", WINDOWS_RUN_VALUE_NAME, "/f"],
    { allowFailure: true },
  );
  if (runKeyDelete.ok) {
    removed = true;
  } else if (!isRegistryValueNotFoundMessage(runKeyDelete.combinedOutput)) {
    throw new Error(
      runKeyDelete.combinedOutput || "Failed to remove Windows startup registry entry.",
    );
  }

  return removed;
}

function showWindowsAutoStartStatus() {
  ensureCommandAvailable("schtasks", ["/?"], "Windows Task Scheduler is not available.");
  ensureCommandAvailable(
    "reg",
    ["query", WINDOWS_RUN_KEY_PATH],
    "Windows registry tools are not available.",
  );

  const runKey = queryWindowsRunKey();
  if (runKey.installed) {
    console.log("Service installed (Windows startup registry entry).");
    return;
  }

  const result = runChecked("schtasks", ["/Query", "/TN", WINDOWS_TASK_NAME, "/FO", "LIST", "/V"], {
    allowFailure: true,
  });
  if (
    !result.ok &&
    (isNotFoundMessage(result.combinedOutput) || isAccessDeniedMessage(result.combinedOutput))
  ) {
    console.log("Service not installed.");
    return;
  }
  if (!result.ok) {
    throw new Error(result.combinedOutput || "Failed to query service task.");
  }
  console.log("Service installed (Windows Task Scheduler).");
}

function runWindowsTask() {
  ensureCommandAvailable("schtasks", ["/?"], "Windows Task Scheduler is not available.");
  const result = runChecked("schtasks", ["/Run", "/TN", WINDOWS_TASK_NAME], { allowFailure: true });
  if (!result.ok && isNotFoundMessage(result.combinedOutput)) {
    throw new Error("Service is not installed. Run 'copilot-hub service install' first.");
  }
  if (!result.ok) {
    throw new Error(result.combinedOutput || "Failed to run service task.");
  }
}

function startWindowsAutoStart() {
  const runKey = queryWindowsRunKey();
  if (runKey.installed) {
    runDaemon("start");
    return;
  }
  runWindowsTask();
}

function queryWindowsRunKey() {
  const result = runChecked("reg", ["query", WINDOWS_RUN_KEY_PATH, "/v", WINDOWS_RUN_VALUE_NAME], {
    allowFailure: true,
  });
  if (result.ok) {
    return { installed: true };
  }
  if (isRegistryValueNotFoundMessage(result.combinedOutput) || result.status === 1) {
    return { installed: false };
  }
  throw new Error(result.combinedOutput || "Failed to query Windows startup registry entry.");
}

function installWindowsRunKey(command) {
  runChecked(
    "reg",
    [
      "add",
      WINDOWS_RUN_KEY_PATH,
      "/v",
      WINDOWS_RUN_VALUE_NAME,
      "/t",
      "REG_SZ",
      "/d",
      command,
      "/f",
    ],
    { stdio: "pipe" },
  );
}

function installLinuxService() {
  ensureSystemctl();
  const unitPath = getLinuxUnitPath();
  fs.mkdirSync(path.dirname(unitPath), { recursive: true });
  fs.writeFileSync(unitPath, buildLinuxUnitContent(), "utf8");
  runChecked("systemctl", ["--user", "daemon-reload"], { stdio: "inherit" });
  runChecked("systemctl", ["--user", "enable", "--now", LINUX_UNIT_NAME], { stdio: "inherit" });
}

function uninstallLinuxService() {
  ensureSystemctl();
  runChecked("systemctl", ["--user", "disable", "--now", LINUX_UNIT_NAME], {
    allowFailure: true,
    stdio: "inherit",
  });
  const unitPath = getLinuxUnitPath();
  if (fs.existsSync(unitPath)) {
    fs.rmSync(unitPath, { force: true });
  }
  runChecked("systemctl", ["--user", "daemon-reload"], { stdio: "inherit" });
}

function showLinuxServiceStatus() {
  ensureSystemctl();
  const unitPath = getLinuxUnitPath();
  const result = runChecked(
    "systemctl",
    ["--user", "status", LINUX_UNIT_NAME, "--no-pager", "--lines=40"],
    { allowFailure: true },
  );
  if (!result.ok && !fs.existsSync(unitPath)) {
    console.log("Service not installed.");
    return;
  }
  console.log((result.stdout || result.stderr || "No status output.").trim());
}

function installMacosService() {
  ensureCommandAvailable("launchctl", ["help"], "launchctl is not available.");
  const plistPath = getMacosPlistPath();
  fs.mkdirSync(path.dirname(plistPath), { recursive: true });
  fs.mkdirSync(layout.logsDir, { recursive: true });
  fs.writeFileSync(plistPath, buildMacosPlist(), "utf8");

  stopMacosService({ allowFailure: true });
  const target = getMacosLaunchTarget();
  runChecked("launchctl", ["bootstrap", target, plistPath], { stdio: "inherit" });
  runChecked("launchctl", ["kickstart", "-k", `${target}/${MACOS_LABEL}`], { stdio: "inherit" });
}

function uninstallMacosService() {
  ensureCommandAvailable("launchctl", ["help"], "launchctl is not available.");
  stopMacosService({ allowFailure: true });
  const plistPath = getMacosPlistPath();
  if (fs.existsSync(plistPath)) {
    fs.rmSync(plistPath, { force: true });
  }
}

function showMacosServiceStatus() {
  ensureCommandAvailable("launchctl", ["help"], "launchctl is not available.");
  const target = getMacosLaunchTarget();
  const label = `${target}/${MACOS_LABEL}`;
  const result = runChecked("launchctl", ["print", label], { allowFailure: true });
  if (!result.ok && !fs.existsSync(getMacosPlistPath())) {
    console.log("Service not installed.");
    return;
  }
  console.log((result.stdout || result.stderr || "No status output.").trim());
}

function startMacosService() {
  ensureCommandAvailable("launchctl", ["help"], "launchctl is not available.");
  const plistPath = getMacosPlistPath();
  if (!fs.existsSync(plistPath)) {
    throw new Error("Service is not installed. Run 'copilot-hub service install' first.");
  }
  const target = getMacosLaunchTarget();
  const label = `${target}/${MACOS_LABEL}`;
  const kickstart = runChecked("launchctl", ["kickstart", "-k", label], { allowFailure: true });
  if (kickstart.ok) {
    return;
  }
  runChecked("launchctl", ["bootstrap", target, plistPath], { stdio: "inherit" });
  runChecked("launchctl", ["kickstart", "-k", label], { stdio: "inherit" });
}

function stopMacosService({ allowFailure = false } = {}) {
  ensureCommandAvailable("launchctl", ["help"], "launchctl is not available.");
  const target = getMacosLaunchTarget();
  runChecked("launchctl", ["bootout", target, getMacosPlistPath()], {
    allowFailure,
    stdio: "inherit",
  });
}

function getLinuxUnitPath() {
  return path.join(os.homedir(), ".config", "systemd", "user", LINUX_UNIT_NAME);
}

function getMacosPlistPath() {
  return path.join(os.homedir(), "Library", "LaunchAgents", `${MACOS_LABEL}.plist`);
}

function getMacosLaunchTarget() {
  if (typeof process.getuid !== "function") {
    throw new Error("Could not resolve macOS user id.");
  }
  return `gui/${process.getuid()}`;
}

function buildLinuxUnitContent() {
  return [
    "[Unit]",
    "Description=Copilot Hub Service",
    "After=network-online.target",
    "",
    "[Service]",
    "Type=simple",
    `WorkingDirectory=${layout.runtimeDir}`,
    `ExecStart="${nodeBin}" "${daemonScriptPath}" run`,
    `ExecStop="${nodeBin}" "${daemonScriptPath}" stop`,
    "Restart=always",
    "RestartSec=3",
    "KillMode=process",
    "",
    "[Install]",
    "WantedBy=default.target",
    "",
  ].join("\n");
}

function buildMacosPlist() {
  const stdoutPath = path.join(layout.logsDir, "service-launchd.log");
  const stderrPath = path.join(layout.logsDir, "service-launchd.error.log");
  const values = {
    label: escapeXml(MACOS_LABEL),
    node: escapeXml(nodeBin),
    script: escapeXml(daemonScriptPath),
    cwd: escapeXml(layout.runtimeDir),
    stdoutPath: escapeXml(stdoutPath),
    stderrPath: escapeXml(stderrPath),
  };

  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    "<dict>",
    "  <key>Label</key>",
    `  <string>${values.label}</string>`,
    "  <key>ProgramArguments</key>",
    "  <array>",
    `    <string>${values.node}</string>`,
    `    <string>${values.script}</string>`,
    "    <string>run</string>",
    "  </array>",
    "  <key>WorkingDirectory</key>",
    `  <string>${values.cwd}</string>`,
    "  <key>RunAtLoad</key>",
    "  <true/>",
    "  <key>KeepAlive</key>",
    "  <true/>",
    "  <key>StandardOutPath</key>",
    `  <string>${values.stdoutPath}</string>`,
    "  <key>StandardErrorPath</key>",
    `  <string>${values.stderrPath}</string>`,
    "</dict>",
    "</plist>",
    "",
  ].join("\n");
}

function ensureDaemonScript() {
  if (!fs.existsSync(daemonScriptPath)) {
    throw new Error(
      [
        "Daemon script is missing.",
        "Run 'npm run build:scripts' (or reinstall package) and retry.",
      ].join("\n"),
    );
  }
}

function ensureSystemctl() {
  ensureCommandAvailable(
    "systemctl",
    ["--version"],
    "systemd is not available. This command requires Linux with systemd user services.",
  );
}

function ensureCommandAvailable(command, args, errorMessage) {
  const probe = runChecked(command, args, { allowFailure: true });
  if (!probe.spawnErrorCode || probe.spawnErrorCode !== "ENOENT") {
    return;
  }
  throw new Error(errorMessage);
}

function runDaemon(actionValue, { allowFailure = false } = {}) {
  const result = runChecked(nodeBin, [daemonScriptPath, String(actionValue ?? "").trim()], {
    stdio: "inherit",
    allowFailure,
  });
  if (!result.ok && !allowFailure) {
    throw new Error(result.combinedOutput || `Failed to execute daemon action '${actionValue}'.`);
  }
}

function runChecked(command, args, { stdio = "pipe", allowFailure = false } = {}) {
  const result = spawnSync(command, args, {
    cwd: layout.runtimeDir,
    shell: false,
    stdio,
    windowsHide: true,
    encoding: "utf8",
    env: process.env,
  });

  const stdout = String(result.stdout ?? "").trim();
  const stderr = String(result.stderr ?? "").trim();
  const combinedOutput = [stdout, stderr].filter(Boolean).join("\n").trim();
  const spawnErrorCode = String(result.error?.code ?? "")
    .trim()
    .toUpperCase();
  const ok = !result.error && result.status === 0;

  if (!ok && !allowFailure) {
    const errorMessage =
      result.error && spawnErrorCode
        ? `${command} failed (${spawnErrorCode}).`
        : combinedOutput || `${command} exited with code ${String(result.status ?? "unknown")}.`;
    throw new Error(errorMessage);
  }

  return {
    ok,
    status: result.status,
    stdout,
    stderr,
    combinedOutput,
    spawnErrorCode,
  };
}

function isNotFoundMessage(value) {
  const message = String(value ?? "").toLowerCase();
  if (!message) {
    return false;
  }
  return (
    message.includes("cannot find") ||
    message.includes("cannot be found") ||
    message.includes("not found") ||
    message.includes("introuvable") ||
    message.includes("n'existe pas")
  );
}

function isAccessDeniedMessage(value) {
  const simplified = simplifyMessageForMatch(value);
  if (!simplified) {
    return false;
  }
  if (simplified.includes("access is denied")) {
    return true;
  }
  if (simplified.includes("acces refuse")) {
    return true;
  }
  return simplified.includes("refus") && simplified.includes("acc");
}

function isRegistryValueNotFoundMessage(value) {
  const simplified = simplifyMessageForMatch(value);
  if (!simplified) {
    return false;
  }
  return (
    simplified.includes("unable to find the specified registry key or value") ||
    simplified.includes("the system was unable to find the specified registry key or value") ||
    simplified.includes("impossible de trouver") ||
    simplified.includes("n'a pas trouve") ||
    simplified.includes("n a pas trouve") ||
    simplified.includes("la cle ou la valeur de registre specifiee") ||
    simplified.includes("introuvable")
  );
}

function simplifyMessageForMatch(value) {
  return String(value ?? "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\uFFFD/g, "")
    .replace(/[?]/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

function getErrorMessage(error) {
  if (error instanceof Error && error.message) {
    return error.message;
  }
  return String(error ?? "Unknown error.");
}

function buildWindowsLaunchCommand() {
  return `"${nodeBin}" "${daemonScriptPath}" run`;
}

function escapeXml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function printUsage() {
  console.log(
    [
      "Usage: node scripts/dist/service.mjs <install|uninstall|status|start|stop|help>",
      "",
      "Platform mapping:",
      "- Windows: Task Scheduler task (fallback: user startup registry entry)",
      "- Linux: systemd user service",
      "- macOS: launchd user agent",
    ].join("\n"),
  );
}
