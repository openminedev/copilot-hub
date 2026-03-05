#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "..", "..");

const runtimeDir = path.join(repoRoot, ".copilot-hub");
const pidsDir = path.join(runtimeDir, "pids");
const logsDir = path.join(repoRoot, "logs");

const daemonStatePath = path.join(pidsDir, "daemon.json");
const daemonLogPath = path.join(logsDir, "service-daemon.log");
const controlPlaneLogPath = path.join(logsDir, "control-plane.log");
const agentEngineLogPath = path.join(logsDir, "agent-engine.log");
const daemonScriptPath = path.join(repoRoot, "scripts", "dist", "daemon.mjs");
const supervisorScriptPath = path.join(repoRoot, "scripts", "dist", "supervisor.mjs");
const nodeBin = process.execPath;

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
  ensureScripts();
  ensureRuntimeDirs();

  const existingPid = getRunningDaemonPid();
  if (existingPid > 0) {
    console.log(`[daemon] already running (pid ${existingPid})`);
    return;
  }

  removeDaemonState();

  const logFd = fs.openSync(daemonLogPath, "a");
  let child;
  try {
    child = spawn(nodeBin, [daemonScriptPath, "run"], {
      cwd: repoRoot,
      detached: true,
      stdio: ["ignore", logFd, logFd],
      windowsHide: true,
      shell: false,
      env: process.env,
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

  console.log(`[daemon] started (pid ${pid})`);
}

async function runDaemonLoop() {
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

  console.log(`[daemon] running (pid ${process.pid})`);

  let failureCount = 0;

  while (!state.stopping) {
    const ensureResult = runSupervisor("ensure", { allowFailure: true });
    if (ensureResult.ok) {
      if (failureCount > 0) {
        console.log("[daemon] workers recovered.");
      }
      failureCount = 0;
      await sleepInterruptible(BASE_CHECK_MS, () => state.stopping);
      continue;
    }

    const fatal = detectFatalStartupError(ensureResult);
    if (fatal) {
      console.error(`[daemon] fatal startup error: ${fatal.reason}`);
      console.error(`[daemon] action required: ${fatal.action}`);
      state.stopping = true;
      await shutdownDaemon(state, { reason: "fatal-configuration", exitCode: 1 });
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

async function shutdownDaemon(state, { reason, exitCode }) {
  if (state.shuttingDown) {
    return;
  }
  state.shuttingDown = true;

  console.log(`[daemon] stopping (${reason})...`);
  runSupervisor("down", { allowFailure: true });
  removeDaemonState();

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
    cwd: repoRoot,
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

function detectFatalStartupError(ensureResult) {
  const evidence = [
    String(ensureResult?.combinedOutput ?? ""),
    readLogTail(controlPlaneLogPath, 120),
    readLogTail(agentEngineLogPath, 120),
  ]
    .map((chunk) => String(chunk ?? "").trim())
    .filter(Boolean)
    .join("\n")
    .toLowerCase();

  const missingHubToken =
    evidence.includes("hub telegram token is missing") && evidence.includes("hub_telegram_token");
  if (missingHubToken) {
    return {
      reason: "Hub Telegram token is missing (HUB_TELEGRAM_TOKEN).",
      action: "Run 'copilot-hub configure', set the token, then run 'copilot-hub start'.",
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

function printUsage() {
  console.log("Usage: node scripts/dist/daemon.mjs <start|run|stop|status|help>");
}
