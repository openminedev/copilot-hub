#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import process, { stdin as input, stdout as output } from "node:process";
import { spawnSync } from "node:child_process";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "..", "..");
const packageJsonPath = path.join(repoRoot, "package.json");
const runtimeDir = path.join(repoRoot, ".copilot-hub");
const servicePromptStatePath = path.join(runtimeDir, "service-onboarding.json");
const nodeBin = process.execPath;
const agentEngineEnvPath = path.join(repoRoot, "apps", "agent-engine", ".env");
const controlPlaneEnvPath = path.join(repoRoot, "apps", "control-plane", ".env");
const codexNpmPackage = "@openai/codex";
const codexInstallCommand = `npm install -g ${codexNpmPackage}`;
const packageVersion = readPackageVersion();

const rawArgs = process.argv
  .slice(2)
  .map((value) => String(value ?? "").trim())
  .filter(Boolean);
const wantsVersion = rawArgs.includes("--version") || rawArgs.includes("-v");
const wantsHelp = rawArgs.includes("--help") || rawArgs.includes("-h");

const action = String(rawArgs[0] ?? "start")
  .trim()
  .toLowerCase();

await main();

async function main() {
  if (wantsVersion || action === "version") {
    console.log(packageVersion);
    return;
  }

  if (wantsHelp || action === "help") {
    printUsage();
    return;
  }

  switch (action) {
    case "start": {
      runNode(["scripts/dist/configure.mjs", "--required-only"]);
      runNode(["scripts/dist/ensure-shared-build.mjs"]);
      await ensureCodexLogin();
      await maybeOfferServiceInstall();
      runNode(["scripts/dist/supervisor.mjs", "up"]);
      return;
    }
    case "stop": {
      runNode(["scripts/dist/supervisor.mjs", "down"]);
      return;
    }
    case "restart": {
      runNode(["scripts/dist/ensure-shared-build.mjs"]);
      runNode(["scripts/dist/supervisor.mjs", "restart"]);
      return;
    }
    case "status": {
      runNode(["scripts/dist/supervisor.mjs", "status"]);
      return;
    }
    case "logs": {
      runNode(["scripts/dist/supervisor.mjs", "logs"]);
      return;
    }
    case "configure": {
      runNode(["scripts/dist/configure.mjs"]);
      return;
    }
    case "service": {
      runNode(["scripts/dist/service.mjs", ...rawArgs.slice(1)]);
      return;
    }
    default: {
      printUsage();
      process.exit(1);
    }
  }
}

function runNode(scriptArgs) {
  const result = runNodeCapture(scriptArgs, "inherit");
  const code = Number.isInteger(result.status) ? result.status : 1;
  if (code !== 0) {
    process.exit(code);
  }
}

function runNodeCapture(scriptArgs, stdioMode = "pipe") {
  const stdio: any = stdioMode === "inherit" ? "inherit" : ["ignore", "pipe", "pipe"];
  const result = spawnSync(nodeBin, scriptArgs, {
    cwd: repoRoot,
    stdio,
    shell: false,
    encoding: "utf8",
  });

  const stdout = String(result.stdout ?? "").trim();
  const stderr = String(result.stderr ?? "").trim();
  const combinedOutput = [stdout, stderr].filter(Boolean).join("\n").trim();
  const ok = !result.error && result.status === 0;

  return {
    ok,
    status: result.status,
    stdout,
    stderr,
    combinedOutput,
    error: result.error,
  };
}

async function ensureCodexLogin() {
  const resolved = resolveCodexBinForStart();
  let codexBin = resolved.bin;
  let status = runCodex(codexBin, ["login", "status"], "pipe");
  if (status.ok) {
    console.log("Codex login already configured.");
    return;
  }

  if (status.errorCode === "ENOENT") {
    codexBin = await recoverCodexBinary({
      resolved,
      status,
    });

    status = runCodex(codexBin, ["login", "status"], "pipe");
    if (status.ok) {
      console.log("Codex login already configured.");
      return;
    }
  }

  const reason = status.errorMessage || status.stderr || status.stdout;
  if (!process.stdin.isTTY) {
    throw new Error(
      [
        "Codex login is required and this terminal is non-interactive.",
        `Run '${codexBin} login' once, then retry 'npm run start'.`,
        reason ? `Details: ${firstLine(reason)}` : "",
      ]
        .filter(Boolean)
        .join("\n"),
    );
  }

  console.log("Codex login is not configured on this machine.");
  if (reason) {
    console.log(`Status details: ${firstLine(reason)}`);
  }

  const rl = createInterface({ input, output });
  try {
    const proceed = await askYesNo(rl, `Run '${codexBin} login' now?`, true);
    if (!proceed) {
      throw new Error("Codex login is required before starting services.");
    }
  } finally {
    rl.close();
  }

  const login = runCodex(codexBin, ["login"], "inherit");
  if (!login.ok) {
    throw new Error(
      [
        `Codex login failed for '${codexBin}'.`,
        login.errorMessage ||
          firstLine(login.stderr) ||
          firstLine(login.stdout) ||
          "Unknown error.",
      ]
        .filter(Boolean)
        .join("\n"),
    );
  }

  const verify = runCodex(codexBin, ["login", "status"], "pipe");
  if (!verify.ok) {
    throw new Error(
      [
        "Codex login still not detected after login flow.",
        verify.errorMessage ||
          firstLine(verify.stderr) ||
          firstLine(verify.stdout) ||
          "Unknown error.",
      ]
        .filter(Boolean)
        .join("\n"),
    );
  }

  console.log("Codex login configured.");
}

async function maybeOfferServiceInstall() {
  if (!process.stdin.isTTY) {
    return;
  }
  if (!isServiceSupportedOnCurrentPlatform()) {
    return;
  }
  if (isServiceAlreadyInstalled()) {
    return;
  }

  const state = readServicePromptState();
  if (state?.decision === "declined") {
    return;
  }

  const rl = createInterface({ input, output });
  let shouldInstall = false;
  try {
    shouldInstall = await askYesNo(
      rl,
      "Enable OS-native auto-start service now? (recommended for reliability)",
      false,
    );
  } finally {
    rl.close();
  }

  if (!shouldInstall) {
    writeServicePromptState("declined");
    console.log("Service setup skipped. You can run 'copilot-hub service install' anytime.");
    return;
  }

  const install = runNodeCapture(["scripts/dist/service.mjs", "install"], "inherit");
  if (!install.ok) {
    console.log("Service install failed. Continuing in local mode.");
    return;
  }
  writeServicePromptState("accepted");
}

function isServiceSupportedOnCurrentPlatform() {
  return (
    process.platform === "win32" || process.platform === "linux" || process.platform === "darwin"
  );
}

function isServiceAlreadyInstalled() {
  const status = runNodeCapture(["scripts/dist/service.mjs", "status"], "pipe");
  const message = String(status.combinedOutput ?? "").toLowerCase();
  if (message.includes("service not installed")) {
    return false;
  }
  if (message.includes("not installed")) {
    return false;
  }
  return status.ok;
}

function readServicePromptState() {
  if (!fs.existsSync(servicePromptStatePath)) {
    return null;
  }
  try {
    const raw = fs.readFileSync(servicePromptStatePath, "utf8");
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

function writeServicePromptState(decision) {
  try {
    fs.mkdirSync(runtimeDir, { recursive: true });
    fs.writeFileSync(
      servicePromptStatePath,
      `${JSON.stringify(
        {
          decision: String(decision ?? "")
            .trim()
            .toLowerCase(),
          updatedAt: new Date().toISOString(),
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
  } catch {
    // Non-critical state cache only.
  }
}

async function recoverCodexBinary({ resolved, status }) {
  const detected = findDetectedCodexBin();
  if (detected && detected !== resolved.bin) {
    const probe = runCodex(detected, ["--version"], "pipe");
    if (probe.ok) {
      console.log(`Detected Codex binary: ${detected}`);
      return detected;
    }
  }

  if (resolved.userConfigured) {
    return resolved.bin;
  }

  if (!process.stdin.isTTY) {
    throw new Error(
      [
        status.errorMessage || `Codex binary '${resolved.bin}' was not found.`,
        `Install Codex CLI with '${codexInstallCommand}' or set CODEX_BIN, then retry 'npm run start'.`,
      ]
        .filter(Boolean)
        .join("\n"),
    );
  }

  console.log("Codex CLI was not found on this machine.");
  const rl = createInterface({ input, output });
  let installNow = false;
  try {
    installNow = await askYesNo(rl, `Install Codex CLI now (${codexInstallCommand})?`, true);
  } finally {
    rl.close();
  }

  if (!installNow) {
    throw new Error("Codex CLI is required before starting services.");
  }

  const install = runNpm(["install", "-g", codexNpmPackage], "inherit");
  if (!install.ok) {
    throw new Error(
      [
        "Codex CLI installation failed.",
        install.errorMessage ||
          firstLine(install.stderr) ||
          firstLine(install.stdout) ||
          "Unknown error.",
      ]
        .filter(Boolean)
        .join("\n"),
    );
  }

  const installed = resolveInstalledCodexBin();
  if (!installed) {
    throw new Error(
      [
        "Codex CLI appears installed, but no runnable 'codex' binary was detected.",
        "Set CODEX_BIN to the full Codex executable path, then retry 'npm run start'.",
      ].join("\n"),
    );
  }

  console.log(`Codex CLI installed. Using '${installed}'.`);
  return installed;
}

function runCodex(codexBin, args, stdioMode) {
  const stdio: any = stdioMode === "inherit" ? "inherit" : ["ignore", "pipe", "pipe"];
  const result = spawnSync(codexBin, args, {
    cwd: repoRoot,
    stdio,
    shell: false,
    encoding: "utf8",
  });

  if (result.error) {
    return {
      ok: false,
      stdout: "",
      stderr: "",
      errorMessage: formatCodexSpawnError(codexBin, result.error),
      errorCode: normalizeErrorCode(result.error),
    };
  }

  const code = Number.isInteger(result.status) ? result.status : 1;
  return {
    ok: code === 0,
    stdout: String(result.stdout ?? "").trim(),
    stderr: String(result.stderr ?? "").trim(),
    errorMessage: "",
    errorCode: "",
  };
}

function resolveCodexBinForStart() {
  const fromEnv = nonEmpty(process.env.CODEX_BIN);
  if (fromEnv) {
    return {
      bin: fromEnv,
      source: "process_env",
      userConfigured: true,
    };
  }

  for (const [source, envPath] of [
    ["agent_env", agentEngineEnvPath],
    ["control_plane_env", controlPlaneEnvPath],
  ]) {
    const value = readEnvValue(envPath, "CODEX_BIN");
    if (value) {
      return {
        bin: value,
        source,
        userConfigured: true,
      };
    }
  }

  const detected = findDetectedCodexBin();
  if (detected) {
    return {
      bin: detected,
      source: "detected",
      userConfigured: false,
    };
  }

  return {
    bin: "codex",
    source: "default",
    userConfigured: false,
  };
}

function resolveInstalledCodexBin() {
  const candidates = dedupe(
    ["codex", findDetectedCodexBin(), findWindowsNpmGlobalCodexBin(), findVscodeCodexExe()].filter(
      Boolean,
    ),
  );

  for (const candidate of candidates) {
    const status = runCodex(candidate, ["--version"], "pipe");
    if (status.ok) {
      return candidate;
    }
  }

  return "";
}

function findDetectedCodexBin() {
  if (process.platform !== "win32") {
    return "";
  }

  return findVscodeCodexExe() || findWindowsNpmGlobalCodexBin() || "";
}

function findVscodeCodexExe() {
  const userProfile = nonEmpty(process.env.USERPROFILE);
  if (!userProfile) {
    return "";
  }

  const extensionsDir = path.join(userProfile, ".vscode", "extensions");
  if (!fs.existsSync(extensionsDir)) {
    return "";
  }

  const candidates = fs
    .readdirSync(extensionsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .filter((name) => name.startsWith("openai.chatgpt-"))
    .sort()
    .reverse();

  for (const folder of candidates) {
    const exePath = path.join(extensionsDir, folder, "bin", "windows-x86_64", "codex.exe");
    if (fs.existsSync(exePath)) {
      return exePath;
    }
  }

  return "";
}

function findWindowsNpmGlobalCodexBin() {
  if (process.platform !== "win32") {
    return "";
  }

  const candidates = [];
  const appData = nonEmpty(process.env.APPDATA);
  if (appData) {
    candidates.push(path.join(appData, "npm", "codex.cmd"));
    candidates.push(path.join(appData, "npm", "codex.exe"));
    candidates.push(path.join(appData, "npm", "codex"));
  }

  const npmPrefix = readNpmPrefix();
  if (npmPrefix) {
    candidates.push(path.join(npmPrefix, "codex.cmd"));
    candidates.push(path.join(npmPrefix, "codex.exe"));
    candidates.push(path.join(npmPrefix, "codex"));
  }

  for (const candidate of dedupe(candidates)) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }

  return "";
}

function readNpmPrefix() {
  const result = spawnNpm(["config", "get", "prefix"], {
    cwd: repoRoot,
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf8",
  });
  if (result.error || result.status !== 0) {
    return "";
  }

  const value = String(result.stdout ?? "").trim();
  if (!value || value.toLowerCase() === "undefined") {
    return "";
  }
  return value;
}

function runNpm(args, stdioMode) {
  const stdio = stdioMode === "inherit" ? "inherit" : ["ignore", "pipe", "pipe"];
  const result = spawnNpm(args, {
    cwd: repoRoot,
    stdio,
    encoding: "utf8",
  });

  if (result.error) {
    return {
      ok: false,
      stdout: "",
      stderr: "",
      errorMessage: formatNpmSpawnError(result.error),
      errorCode: normalizeErrorCode(result.error),
    };
  }

  const code = Number.isInteger(result.status) ? result.status : 1;
  return {
    ok: code === 0,
    stdout: String(result.stdout ?? "").trim(),
    stderr: String(result.stderr ?? "").trim(),
    errorMessage: "",
    errorCode: "",
  };
}

function readEnvValue(filePath, key) {
  if (!fs.existsSync(filePath)) {
    return "";
  }

  const lines = fs.readFileSync(filePath, "utf8").split(/\r?\n/);
  const pattern = new RegExp(`^\\s*${escapeRegex(key)}\\s*=\\s*(.*)\\s*$`);
  for (const line of lines) {
    const match = line.match(pattern);
    if (!match) {
      continue;
    }
    return unquote(match[1]);
  }
  return "";
}

function unquote(value) {
  const raw = String(value ?? "").trim();
  if (!raw) {
    return "";
  }
  if ((raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith("'") && raw.endsWith("'"))) {
    return raw.slice(1, -1).trim();
  }
  return raw;
}

async function askYesNo(rl, label, defaultYes) {
  const suffix = defaultYes ? "[Y/n]" : "[y/N]";
  const answer = await rl.question(`${label} ${suffix}: `);
  const value = String(answer ?? "")
    .trim()
    .toLowerCase();
  if (!value) {
    return defaultYes;
  }
  if (value === "y" || value === "yes") {
    return true;
  }
  if (value === "n" || value === "no") {
    return false;
  }
  return defaultYes;
}

function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function nonEmpty(value) {
  const normalized = String(value ?? "").trim();
  return normalized || "";
}

function firstLine(value) {
  return (
    String(value ?? "")
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find(Boolean) ?? ""
  );
}

function formatCodexSpawnError(command, error) {
  const code = normalizeErrorCode(error);
  if (code === "ENOENT") {
    return `Codex binary '${command}' was not found. Install Codex CLI or set CODEX_BIN.`;
  }
  if (code === "EPERM") {
    return `Codex binary '${command}' cannot be executed (EPERM). Check permissions or CODEX_BIN.`;
  }
  const message = error instanceof Error ? error.message : String(error);
  return `Failed to execute '${command}': ${firstLine(message)}`;
}

function formatNpmSpawnError(error) {
  const code = normalizeErrorCode(error);
  if (code === "ENOENT") {
    return "npm was not found. Install Node.js/npm, then retry.";
  }
  if (code === "EPERM") {
    return "npm cannot be executed (EPERM). Check permissions.";
  }
  const message = error instanceof Error ? error.message : String(error);
  return `Failed to execute 'npm': ${firstLine(message)}`;
}

function normalizeErrorCode(error) {
  return String(error?.code ?? "")
    .trim()
    .toUpperCase();
}

function dedupe(values: string[]) {
  return [...new Set(values.map((value) => String(value).trim()).filter(Boolean))];
}

function spawnNpm(args, options) {
  if (process.platform === "win32") {
    const comspec = process.env.ComSpec || "cmd.exe";
    const commandLine = ["npm", ...args].join(" ");
    return spawnSync(comspec, ["/d", "/s", "/c", commandLine], {
      ...options,
      shell: false,
    });
  }

  return spawnSync("npm", args, {
    ...options,
    shell: false,
  });
}

function printUsage() {
  console.log(
    [
      "Usage: node scripts/dist/cli.mjs <start|stop|restart|status|logs|configure|service|version|help>",
      "Service management:",
      "  node scripts/dist/cli.mjs service <install|uninstall|status|start|stop|help>",
    ].join("\n"),
  );
}

function readPackageVersion() {
  try {
    const content = fs.readFileSync(packageJsonPath, "utf8");
    const parsed = JSON.parse(content);
    const version = String(parsed?.version ?? "").trim();
    if (version) {
      return version;
    }
  } catch {
    // Ignore and use fallback.
  }
  return "0.0.0";
}
