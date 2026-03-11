#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { spawn, spawnSync } from "node:child_process";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";
import { codexInstallPackageSpec } from "./codex-version.mjs";
import { initializeCopilotHubLayout, resolveCopilotHubLayout } from "./install-layout.mjs";
import {
  buildCodexCompatibilityError,
  probeCodexVersion,
  resolveCodexBinForStart,
  resolveCompatibleInstalledCodexBin,
} from "./codex-runtime.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "..", "..");
const layout = resolveCopilotHubLayout({ repoRoot });
initializeCopilotHubLayout({ repoRoot, layout });

const runtimeDir = layout.runtimeDir;
const pidsDir = path.join(runtimeDir, "pids");
const logsDir = layout.logsDir;

const daemonStatePath = path.join(pidsDir, "daemon.json");
const lastStartupErrorPath = path.join(runtimeDir, "last-startup-error.json");
const daemonLogPath = path.join(logsDir, "service-daemon.log");
const controlPlaneLogPath = path.join(logsDir, "control-plane.log");
const agentEngineLogPath = path.join(logsDir, "agent-engine.log");
const daemonScriptPath = path.join(repoRoot, "scripts", "dist", "daemon.mjs");
const supervisorScriptPath = path.join(repoRoot, "scripts", "dist", "supervisor.mjs");
const nodeBin = process.execPath;
const agentEngineEnvPath = layout.agentEngineEnvPath;
const controlPlaneEnvPath = layout.controlPlaneEnvPath;
const codexInstallCommand = `npm install -g ${codexInstallPackageSpec}`;
const WINDOWS_BACKGROUND_ENV = "COPILOT_HUB_DAEMON_BACKGROUND";

const BASE_CHECK_MS = 5000;
const MAX_BACKOFF_MS = 60000;

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
    case "start":
      await startDaemonProcess();
      return;
    case "run":
      await runDaemonLoop();
      return;
    case "stop":
      await stopDaemonProcess();
      return;
    case "status":
      showDaemonStatus();
      return;
    case "help":
      printUsage();
      return;
    default:
      printUsage();
      process.exit(1);
  }
}

async function startDaemonProcess() {
  const existingPid = getRunningDaemonPid();
  if (existingPid > 0) {
    console.log(`[daemon] already running (pid ${existingPid})`);
    return;
  }

  const pid = await spawnDetachedDaemonProcess();
  console.log(`[daemon] started (pid ${pid})`);
}

async function spawnDetachedDaemonProcess() {
  ensureScripts();
  ensureRuntimeDirs();

  const existingPid = getRunningDaemonPid();
  if (existingPid > 0) {
    return existingPid;
  }

  removeDaemonState();

  const logFd = fs.openSync(daemonLogPath, "a");
  let child;
  try {
    child = spawn(nodeBin, [daemonScriptPath, "run"], {
      cwd: runtimeDir,
      detached: true,
      stdio: ["ignore", logFd, logFd],
      windowsHide: true,
      shell: false,
      env: {
        ...process.env,
        [WINDOWS_BACKGROUND_ENV]: "1",
      },
    });
  } finally {
    fs.closeSync(logFd);
  }

  const pid = normalizePid(child?.pid);
  if (pid <= 0) {
    throw new Error("Failed to spawn daemon process.");
  }

  child.unref();
  const ready = await waitForExit(pid, 250, false);
  if (ready) {
    throw new Error(`Daemon process exited immediately (pid ${pid}). Check logs: ${daemonLogPath}`);
  }

  return pid;
}

async function runDaemonLoop() {
  if (shouldDetachInteractiveWindowsDaemon()) {
    await spawnDetachedDaemonProcess();
    return;
  }

  ensureScripts();
  ensureRuntimeDirs();

  const existingPid = getRunningDaemonPid();
  if (existingPid > 0 && existingPid !== process.pid) {
    console.log(`[daemon] already running (pid ${existingPid})`);
    return;
  }

  writeDaemonState({
    pid: process.pid,
    startedAt: new Date().toISOString(),
    command: `${nodeBin} ${daemonScriptPath} run`,
  });

  const state = { stopping: false, shuttingDown: false };
  setupSignalHandlers(state);

  try {
    ensureCompatibleCodexForDaemon();
    clearLastStartupError();
  } catch (error) {
    writeLastStartupError({
      detectedAt: new Date().toISOString(),
      reason: getErrorMessage(error),
      action: buildCodexCompatibilityAction(error),
    });
    console.error(`[daemon] fatal startup error: ${getErrorMessage(error)}`);
    console.error(`[daemon] action required: ${buildCodexCompatibilityAction(error)}`);
    state.stopping = true;
    await shutdownDaemon(state, {
      reason: "fatal-codex-compatibility",
      exitCode: 1,
      pauseBeforeExit: true,
    });
    return;
  }

  console.log(`[daemon] running (pid ${process.pid})`);

  let failureCount = 0;

  while (!state.stopping) {
    const ensureResult = runSupervisor("ensure", { allowFailure: true });
    if (ensureResult.ok) {
      clearLastStartupError();
      if (failureCount > 0) {
        console.log("[daemon] workers recovered.");
      }
      failureCount = 0;
      await sleepInterruptible(BASE_CHECK_MS, () => state.stopping);
      continue;
    }

    const fatal = detectFatalStartupError(ensureResult);
    if (fatal) {
      writeLastStartupError(fatal);
      console.error(`[daemon] fatal startup error: ${fatal.reason}`);
      console.error(`[daemon] action required: ${fatal.action}`);
      state.stopping = true;
      await shutdownDaemon(state, {
        reason: "fatal-configuration",
        exitCode: 1,
        pauseBeforeExit: true,
      });
      return;
    }

    failureCount += 1;
    const delay = computeBackoffDelay(failureCount);
    const reason =
      firstLine(ensureResult.combinedOutput) ||
      `supervisor ensure exited with code ${String(ensureResult.status ?? "unknown")}`;
    console.error(
      `[daemon] worker health check failed: ${reason}. Retrying in ${Math.ceil(delay / 1000)}s.`,
    );
    await sleepInterruptible(delay, () => state.stopping);
  }

  await shutdownDaemon(state, { reason: "stop-request", exitCode: 0 });
}

async function stopDaemonProcess() {
  ensureRuntimeDirs();

  const pid = getRunningDaemonPid();
  if (pid <= 0) {
    removeDaemonState();
    runSupervisor("down", { allowFailure: true });
    console.log("[daemon] not running.");
    return;
  }

  await terminateProcess(pid);
  if (isProcessRunning(pid)) {
    throw new Error(`Daemon did not stop cleanly (pid ${pid}).`);
  }

  removeDaemonState();
  runSupervisor("down", { allowFailure: true });
  console.log("[daemon] stopped.");
}

function showDaemonStatus() {
  ensureRuntimeDirs();

  const pid = getRunningDaemonPid();
  const running = pid > 0;

  if (!running) {
    removeDaemonState();
  }

  console.log("\n=== daemon ===");
  console.log(`running: ${running ? "yes" : "no"}`);
  console.log(`pid: ${running ? String(pid) : "-"}`);
  console.log(`logFile: ${daemonLogPath}`);
  printLastStartupError();

  if (!fs.existsSync(supervisorScriptPath)) {
    console.log("\n(worker status unavailable: supervisor script missing)");
    return;
  }

  console.log("\n=== workers ===");
  runSupervisor("status", { allowFailure: true, stdio: "inherit" });
}

function setupSignalHandlers(state) {
  const requestStop = () => {
    state.stopping = true;
  };

  process.on("SIGINT", requestStop);
  process.on("SIGTERM", requestStop);
  process.on("SIGHUP", requestStop);

  process.on("uncaughtException", (error) => {
    if (!state.shuttingDown) {
      console.error(`[daemon] uncaught exception: ${getErrorMessage(error)}`);
    }
    state.stopping = true;
    void shutdownDaemon(state, { reason: "uncaught-exception", exitCode: 1 });
  });

  process.on("unhandledRejection", (reason) => {
    if (!state.shuttingDown) {
      console.error(`[daemon] unhandled rejection: ${getErrorMessage(reason)}`);
    }
    state.stopping = true;
    void shutdownDaemon(state, { reason: "unhandled-rejection", exitCode: 1 });
  });
}

async function shutdownDaemon(state, { reason, exitCode, pauseBeforeExit = false }) {
  if (state.shuttingDown) {
    return;
  }
  state.shuttingDown = true;

  console.log(`[daemon] stopping (${reason})...`);
  runSupervisor("down", { allowFailure: true });
  removeDaemonState();
  if (pauseBeforeExit) {
    await maybePauseWindowBeforeExit();
  }

  process.exit(exitCode);
}

function ensureScripts() {
  if (!fs.existsSync(supervisorScriptPath)) {
    throw new Error(
      [
        "Supervisor script is missing.",
        "Run 'npm run build:scripts' (or reinstall package) and retry.",
      ].join("\n"),
    );
  }

  if (!fs.existsSync(daemonScriptPath)) {
    throw new Error(
      [
        "Daemon script is missing.",
        "Run 'npm run build:scripts' (or reinstall package) and retry.",
      ].join("\n"),
    );
  }
}

function ensureRuntimeDirs() {
  fs.mkdirSync(runtimeDir, { recursive: true });
  fs.mkdirSync(pidsDir, { recursive: true });
  fs.mkdirSync(logsDir, { recursive: true });
}

function getRunningDaemonPid() {
  const state = readDaemonState();
  const pid = normalizePid(state?.pid);
  if (pid <= 0) {
    return 0;
  }
  return isProcessRunning(pid) ? pid : 0;
}

function readDaemonState() {
  if (!fs.existsSync(daemonStatePath)) {
    return null;
  }
  try {
    return JSON.parse(fs.readFileSync(daemonStatePath, "utf8"));
  } catch {
    return null;
  }
}

function writeDaemonState(value) {
  fs.mkdirSync(path.dirname(daemonStatePath), { recursive: true });
  fs.writeFileSync(daemonStatePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function removeDaemonState() {
  if (!fs.existsSync(daemonStatePath)) {
    return;
  }
  fs.rmSync(daemonStatePath, { force: true });
}

function normalizePid(value) {
  const pid = Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(pid) || pid <= 0) {
    return 0;
  }
  return pid;
}

function isProcessRunning(pid) {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "EPERM") {
      return true;
    }
    return false;
  }
}

async function terminateProcess(pid) {
  if (process.platform === "win32") {
    await killTreeWindows(pid);
    if (!(await waitForExit(pid, 7000))) {
      await killTreeWindows(pid);
    }
    return;
  }

  sendSignal(pid, "SIGTERM");
  if (await waitForExit(pid, 7000)) {
    return;
  }

  sendSignal(pid, "SIGKILL");
  await waitForExit(pid, 2000);
}

function killTreeWindows(pid) {
  return new Promise<void>((resolve) => {
    const child = spawn("taskkill", ["/PID", String(pid), "/T", "/F"], {
      stdio: "ignore",
      shell: false,
      windowsHide: true,
    });
    child.once("error", () => resolve());
    child.once("exit", () => resolve());
  });
}

function sendSignal(pid, signal) {
  try {
    process.kill(-pid, signal);
    return;
  } catch {
    // continue
  }

  try {
    process.kill(pid, signal);
  } catch {
    // ignore
  }
}

async function waitForExit(pid, timeoutMs, expectExit = true) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const running = isProcessRunning(pid);
    if (expectExit && !running) {
      return true;
    }
    if (!expectExit && running) {
      return false;
    }
    await sleep(100);
  }

  const stillRunning = isProcessRunning(pid);
  return expectExit ? !stillRunning : stillRunning === false;
}

function runSupervisor(actionValue, { allowFailure = false, stdio = "pipe" } = {}) {
  return runChecked(nodeBin, [supervisorScriptPath, String(actionValue ?? "").trim()], {
    allowFailure,
    stdio,
  });
}

function runChecked(command, args, { stdio = "pipe", allowFailure = false } = {}) {
  const spawnStdio = stdio as "pipe" | "inherit";
  const result = spawnSync(command, args, {
    cwd: runtimeDir,
    shell: false,
    stdio: spawnStdio,
    windowsHide: true,
    encoding: "utf8",
    env: process.env,
  });

  const stdout = String(result.stdout ?? "").trim();
  const stderr = String(result.stderr ?? "").trim();
  const combinedOutput = [stdout, stderr].filter(Boolean).join("\n").trim();
  const spawnErrorCode = String((result.error as NodeJS.ErrnoException | undefined)?.code ?? "")
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

function computeBackoffDelay(failureCount) {
  const power = Math.max(0, failureCount - 1);
  const calculated = BASE_CHECK_MS * 2 ** power;
  return Math.min(calculated, MAX_BACKOFF_MS);
}

async function sleepInterruptible(ms, shouldStop) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (shouldStop()) {
      return;
    }
    await sleep(Math.min(250, Math.max(1, deadline - Date.now())));
  }
}

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function firstLine(value) {
  const text = String(value ?? "").trim();
  if (!text) {
    return "";
  }
  const [line] = text.split(/\r?\n/, 1);
  return String(line ?? "").trim();
}

function getErrorMessage(error) {
  if (error instanceof Error && error.message) {
    return error.message;
  }
  return String(error ?? "Unknown error.");
}

async function maybePauseWindowBeforeExit() {
  if (!shouldPauseBeforeExit()) {
    return;
  }

  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  try {
    console.log("");
    await rl.question("[daemon] Press Enter to close this window.");
  } catch {
    // Ignore pause errors and exit anyway.
  } finally {
    rl.close();
  }
}

function shouldPauseBeforeExit() {
  if (process.platform !== "win32") {
    return false;
  }

  if (!process.stdin || !process.stdout) {
    return false;
  }

  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    return false;
  }

  return true;
}

function shouldDetachInteractiveWindowsDaemon() {
  if (process.platform !== "win32") {
    return false;
  }

  if (String(process.env[WINDOWS_BACKGROUND_ENV] ?? "").trim() === "1") {
    return false;
  }

  if (!process.stdin || !process.stdout) {
    return false;
  }

  return Boolean(process.stdin.isTTY && process.stdout.isTTY);
}

function detectFatalStartupError(ensureResult) {
  const evidenceChunks = [
    String(ensureResult?.combinedOutput ?? ""),
    readLogTail(controlPlaneLogPath, 120),
    readLogTail(agentEngineLogPath, 120),
  ].map((chunk) => String(chunk ?? "").trim());

  const missingHubTokenLine = findLineContaining(
    evidenceChunks,
    (line) => line.includes("hub telegram token is missing") && line.includes("hub_telegram_token"),
  );
  const missingHubToken = Boolean(missingHubTokenLine);
  if (missingHubToken) {
    return {
      reason: missingHubTokenLine || "Hub Telegram token is missing (HUB_TELEGRAM_TOKEN).",
      action: "Run 'copilot-hub start' in a terminal (it will guide setup), then retry service.",
      detectedAt: new Date().toISOString(),
    };
  }

  const invalidHubTokenLine = findLineContaining(
    evidenceChunks,
    (line) => line.includes("hub telegram token in") && line.includes("is invalid"),
  );
  if (invalidHubTokenLine) {
    return {
      reason: invalidHubTokenLine,
      action:
        "Run 'copilot-hub configure' to save a valid hub token in the control-plane config, then retry service.",
      detectedAt: new Date().toISOString(),
    };
  }

  const workspaceRootLine = findLineContaining(
    evidenceChunks,
    (line) =>
      line.includes("default_workspace_root must be outside kernel directory") ||
      line.includes("hub_workspace_root must be outside kernel directory"),
  );
  if (workspaceRootLine) {
    return {
      reason: workspaceRootLine,
      action:
        "Set DEFAULT_WORKSPACE_ROOT to a folder outside the copilot-hub installation, then retry service.",
      detectedAt: new Date().toISOString(),
    };
  }

  return null;
}

function readLogTail(filePath, maxLines = 120) {
  try {
    if (!fs.existsSync(filePath)) {
      return "";
    }

    const content = fs.readFileSync(filePath, "utf8");
    const lines = content.split(/\r?\n/);
    return lines.slice(-maxLines).join("\n").trim();
  } catch {
    return "";
  }
}

function findLineContaining(chunks, predicate) {
  const lines = chunks
    .flatMap((chunk) => String(chunk ?? "").split(/\r?\n/))
    .map((line) => String(line ?? "").trim())
    .filter(Boolean);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index];
    if (predicate(line.toLowerCase())) {
      return line;
    }
  }
  return "";
}

function writeLastStartupError(value) {
  try {
    fs.mkdirSync(runtimeDir, { recursive: true });
    fs.writeFileSync(lastStartupErrorPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  } catch {
    // Best effort only.
  }
}

function readLastStartupError() {
  if (!fs.existsSync(lastStartupErrorPath)) {
    return null;
  }
  try {
    const raw = fs.readFileSync(lastStartupErrorPath, "utf8");
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

function clearLastStartupError() {
  if (!fs.existsSync(lastStartupErrorPath)) {
    return;
  }
  try {
    fs.rmSync(lastStartupErrorPath, { force: true });
  } catch {
    // Best effort only.
  }
}

function printLastStartupError() {
  const issue = readLastStartupError();
  if (!issue) {
    return;
  }

  console.log("\n=== last startup error ===");
  if (issue.detectedAt) {
    console.log(`detectedAt: ${String(issue.detectedAt)}`);
  }
  if (issue.reason) {
    console.log(`reason: ${String(issue.reason)}`);
  }
  if (issue.action) {
    console.log(`action: ${String(issue.action)}`);
  }
}

function ensureCompatibleCodexForDaemon(): void {
  const resolved = resolveCodexBinForStart({
    repoRoot,
    agentEngineEnvPath,
    controlPlaneEnvPath,
  });
  const currentProbe = probeCodexVersion({
    codexBin: resolved.bin,
    repoRoot,
  });
  if (currentProbe.ok && currentProbe.compatible) {
    return;
  }

  if (!resolved.userConfigured) {
    const compatibleInstalled = resolveCompatibleInstalledCodexBin({ repoRoot });
    if (compatibleInstalled) {
      return;
    }
  }

  throw new Error(
    buildCodexCompatibilityError({
      resolved,
      probe: currentProbe,
      includeInstallHint: !resolved.userConfigured,
      installCommand: codexInstallCommand,
    }),
  );
}

function buildCodexCompatibilityAction(error: unknown): string {
  const message = getErrorMessage(error);
  if (message.includes("Install a compatible version with")) {
    return `Install a compatible version with '${codexInstallCommand}', then restart the service.`;
  }
  return "Update that binary or point CODEX_BIN to a compatible executable, then restart the service.";
}

function printUsage() {
  console.log("Usage: node scripts/dist/daemon.mjs <start|run|stop|status|help>");
}
