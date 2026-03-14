#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { initializeCopilotHubLayout, resolveCopilotHubLayout } from "./install-layout.mjs";
import { isManagedProcessRunning, isProcessRunning, normalizePid } from "./process-identity.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "..", "..");
const layout = resolveCopilotHubLayout({ repoRoot });
initializeCopilotHubLayout({ repoRoot, layout });

const runtimeDir = layout.runtimeDir;
const pidsDir = path.join(runtimeDir, "pids");
const logsDir = layout.logsDir;
const servicesRuntimeDir = path.join(runtimeDir, "services");

const SERVICES = [
  {
    id: "agent-engine",
    workingDir: path.join(servicesRuntimeDir, "agent-engine"),
    entryScript: path.join(repoRoot, "apps", "agent-engine", "dist", "index.js"),
    logFile: path.join(logsDir, "agent-engine.log"),
    envFilePath: layout.agentEngineEnvPath,
    dataDir: layout.agentEngineDataDir,
  },

  {
    id: "control-plane",
    workingDir: path.join(servicesRuntimeDir, "control-plane"),
    entryScript: path.join(repoRoot, "apps", "control-plane", "dist", "copilot-hub.js"),
    logFile: path.join(logsDir, "control-plane.log"),
    envFilePath: layout.controlPlaneEnvPath,
    dataDir: layout.controlPlaneDataDir,
  },
].map((service) => ({
  ...service,
  pidFile: path.join(pidsDir, `${service.id}.json`),
  botRegistryFilePath: path.join(service.dataDir, "bot-registry.json"),
  secretStoreFilePath: path.join(service.dataDir, "secrets.json"),
  instanceLockFilePath: path.join(service.dataDir, "runtime.lock"),
}));

const action = String(process.argv[2] ?? "up")
  .trim()
  .toLowerCase();

await main();

async function main() {
  switch (action) {
    case "up":
      await startServices();
      return;
    case "ensure":
      await ensureServices();
      return;
    case "down":
      await stopServices();
      return;
    case "restart":
      await stopServices();
      await startServices();
      return;
    case "status":
      showStatus();
      return;
    case "logs":
      showLogs();
      return;
    default:
      printUsage();
      process.exit(1);
  }
}

async function startServices() {
  ensureRuntimeDirs();

  const started = [];
  for (const service of SERVICES) {
    const ok = await startService(service);
    if (!ok) {
      for (let index = started.length - 1; index >= 0; index -= 1) {
        await stopService(started[index]);
      }
      console.error("One or more services failed to start. Run 'copilot-hub logs' for details.");
      process.exit(1);
    }
    started.push(service);
  }
}

async function ensureServices() {
  ensureRuntimeDirs();

  let hasFailure = false;
  for (const service of SERVICES) {
    const ok = await startService(service, { suppressAlreadyRunning: true });
    if (!ok) {
      hasFailure = true;
    }
  }

  if (hasFailure) {
    process.exit(1);
  }
}

async function stopServices() {
  for (const service of SERVICES) {
    await stopService(service);
  }
}

function showStatus() {
  ensureRuntimeDirs();

  for (const service of SERVICES) {
    const state = readState(service);
    const pid = normalizePid(state?.pid);
    const running = pid > 0 && isManagedProcessRunning(state);

    if (state && !running) {
      removeState(service);
    }

    console.log(`\n=== ${service.id} ===`);
    console.log(`running: ${running ? "yes" : "no"}`);
    console.log(`pid: ${running ? String(pid) : "-"}`);
    console.log(`logFile: ${service.logFile}`);
  }
}

function showLogs() {
  ensureRuntimeDirs();

  for (const service of SERVICES) {
    console.log(`\n=== ${service.id} (${service.logFile}) ===`);
    printTail(service.logFile, 120);
  }
}

async function startService(service, options: { suppressAlreadyRunning?: boolean } = {}) {
  const suppressAlreadyRunning = options?.suppressAlreadyRunning === true;
  const existing = readState(service);
  const existingPid = normalizePid(existing?.pid);
  if (existingPid > 0 && isManagedProcessRunning(existing)) {
    if (!suppressAlreadyRunning) {
      console.log(`[${service.id}] already running (pid ${existingPid})`);
    }
    return true;
  }

  if (existing) {
    removeState(service);
  }

  fs.mkdirSync(path.dirname(service.logFile), { recursive: true });
  const logFd = fs.openSync(service.logFile, "a");

  let child;
  try {
    const childEnv = buildServiceEnvironment(service);
    child = spawn(process.execPath, [service.entryScript], {
      cwd: service.workingDir,
      detached: true,
      stdio: ["ignore", logFd, logFd],
      windowsHide: true,
      shell: false,
      env: childEnv,
    });
  } finally {
    fs.closeSync(logFd);
  }

  const pid = normalizePid(child?.pid);
  if (pid <= 0) {
    console.error(`[${service.id}] failed to spawn.`);
    return false;
  }

  child.unref();

  writeState(service, {
    pid,
    startedAt: new Date().toISOString(),
    command: `${process.execPath} ${service.entryScript}`,
    executablePath: process.execPath,
    entryScript: service.entryScript,
  });

  await sleep(250);

  if (!isManagedProcessRunning(readState(service))) {
    removeState(service);
    console.error(`[${service.id}] exited immediately. Check logs: ${service.logFile}`);
    return false;
  }

  console.log(`[${service.id}] started (pid ${pid})`);
  return true;
}

async function stopService(service) {
  const state = readState(service);
  if (!state) {
    console.log(`[${service.id}] not running (no pid file)`);
    return;
  }

  const pid = normalizePid(state.pid);
  if (pid <= 0) {
    removeState(service);
    console.log(`[${service.id}] removed invalid pid file`);
    return;
  }

  if (!isManagedProcessRunning(state)) {
    removeState(service);
    console.log(`[${service.id}] not running (stale pid ${pid})`);
    return;
  }

  const stopped = await terminateProcess(pid);
  if (stopped) {
    removeState(service);
    console.log(`[${service.id}] stopped`);
    return;
  }

  console.error(`[${service.id}] could not stop pid ${pid}`);
}

async function terminateProcess(pid) {
  if (process.platform === "win32") {
    await killTreeWindows(pid);
    return waitForExit(pid, 5000);
  }

  sendSignal(pid, "SIGTERM");
  if (await waitForExit(pid, 5000)) {
    return true;
  }

  sendSignal(pid, "SIGKILL");
  return waitForExit(pid, 2000);
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

async function waitForExit(pid, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isProcessRunning(pid)) {
      return true;
    }
    await sleep(150);
  }

  return !isProcessRunning(pid);
}

function readState(service) {
  if (!fs.existsSync(service.pidFile)) {
    return null;
  }

  try {
    const raw = fs.readFileSync(service.pidFile, "utf8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function writeState(service, state) {
  fs.mkdirSync(path.dirname(service.pidFile), { recursive: true });
  fs.writeFileSync(service.pidFile, `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

function removeState(service) {
  if (fs.existsSync(service.pidFile)) {
    fs.rmSync(service.pidFile, { force: true });
  }
}

function ensureRuntimeDirs() {
  fs.mkdirSync(runtimeDir, { recursive: true });
  fs.mkdirSync(pidsDir, { recursive: true });
  fs.mkdirSync(logsDir, { recursive: true });
  fs.mkdirSync(servicesRuntimeDir, { recursive: true });
  for (const service of SERVICES) {
    fs.mkdirSync(service.workingDir, { recursive: true });
  }
}

function buildServiceEnvironment(service) {
  return {
    ...process.env,
    COPILOT_HUB_HOME_DIR: process.env.COPILOT_HUB_HOME_DIR || layout.homeDir,
    COPILOT_HUB_ENV_PATH: service.envFilePath,
    BOT_DATA_DIR: service.dataDir,
    BOT_REGISTRY_FILE: service.botRegistryFilePath,
    SECRET_STORE_FILE: service.secretStoreFilePath,
    INSTANCE_LOCK_FILE: service.instanceLockFilePath,
    ...(service.id === "control-plane"
      ? {
          HUB_DATA_DIR: path.join(service.dataDir, "copilot_hub"),
        }
      : {}),
  };
}

function printTail(filePath, lines) {
  if (!fs.existsSync(filePath)) {
    console.log("(no log file yet)");
    return;
  }

  const content = fs.readFileSync(filePath, "utf8");
  const entries = content.split(/\r?\n/).filter(Boolean);
  const start = Math.max(0, entries.length - lines);
  for (let index = start; index < entries.length; index += 1) {
    console.log(entries[index]);
  }
}

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function printUsage() {
  console.log("Usage: node scripts/dist/supervisor.mjs <up|ensure|down|restart|status|logs>");
}
