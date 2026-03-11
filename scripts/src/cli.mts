#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import process, { stdin as input, stdout as output } from "node:process";
import { spawnSync } from "node:child_process";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";
import { spawnCodexSync } from "./codex-spawn.mjs";
import { codexInstallPackageSpec } from "./codex-version.mjs";
import {
  initializeCopilotHubLayout,
  resetCopilotHubConfig,
  resolveCopilotHubLayout,
} from "./install-layout.mjs";
import {
  buildCodexCompatibilityError,
  buildCodexCompatibilityNotice,
  probeCodexVersion,
  resolveCodexBinForStart,
  resolveCompatibleInstalledCodexBin,
} from "./codex-runtime.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "..", "..");
const layout = resolveCopilotHubLayout({ repoRoot });
const packageJsonPath = path.join(repoRoot, "package.json");
const runtimeDir = layout.runtimeDir;
const servicePromptStatePath = layout.servicePromptStatePath;
const nodeBin = process.execPath;
const agentEngineEnvPath = layout.agentEngineEnvPath;
const controlPlaneEnvPath = layout.controlPlaneEnvPath;
const codexInstallCommand = `npm install -g ${codexInstallPackageSpec}`;
const packageVersion = readPackageVersion();

const rawArgs = process.argv
  .slice(2)
  .map((value) => String(value ?? "").trim())
  .filter(Boolean);
const wantsVersion = rawArgs.includes("--version") || rawArgs.includes("-v");
const wantsHelp = rawArgs.includes("--help") || rawArgs.includes("-h");
const wantsYes = rawArgs.includes("--yes") || rawArgs.includes("-y");

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

  initializeCopilotHubLayout({ repoRoot, layout });

  switch (action) {
    case "start": {
      runNode(["scripts/dist/configure.mjs", "--required-only"]);
      runNode(["scripts/dist/ensure-shared-build.mjs"]);
      await ensureCodexLogin();
      await maybeOfferServiceInstall();
      if (isServiceAlreadyInstalled()) {
        runNode(["scripts/dist/service.mjs", "start"]);
        return;
      }
      runNode(["scripts/dist/supervisor.mjs", "up"]);
      return;
    }
    case "stop": {
      if (isServiceAlreadyInstalled()) {
        runNode(["scripts/dist/service.mjs", "stop"]);
        return;
      }
      runNode(["scripts/dist/supervisor.mjs", "down"]);
      return;
    }
    case "restart": {
      runNode(["scripts/dist/ensure-shared-build.mjs"]);
      await ensureCompatibleCodexBinary({
        autoInstall: false,
        purpose: "restart",
      });
      if (isServiceAlreadyInstalled()) {
        runNode(["scripts/dist/service.mjs", "stop"]);
        runNode(["scripts/dist/service.mjs", "start"]);
        return;
      }
      runNode(["scripts/dist/supervisor.mjs", "restart"]);
      return;
    }
    case "status": {
      if (isServiceAlreadyInstalled()) {
        runNode(["scripts/dist/daemon.mjs", "status"]);
        return;
      }
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
    case "reset-config":
    case "reset_config": {
      await resetConfig({
        force: wantsYes,
      });
      return;
    }
    case "service": {
      const serviceAction = String(rawArgs[1] ?? "")
        .trim()
        .toLowerCase();
      if (serviceAction === "install" || serviceAction === "start") {
        await ensureCompatibleCodexBinary({
          autoInstall: false,
          purpose: "service",
        });
      }
      runNode(["scripts/dist/service.mjs", ...rawArgs.slice(1)]);
      return;
    }
    default: {
      printUsage();
      process.exit(1);
    }
  }
}

async function resetConfig({ force }: { force: boolean }): Promise<void> {
  if (!force) {
    if (!process.stdin.isTTY) {
      throw new Error(
        "reset-config requires confirmation. Re-run with '--yes' in non-interactive mode.",
      );
    }

    const rl = createInterface({ input, output });
    try {
      const confirmed = await askYesNo(
        rl,
        [
          "Reset Copilot Hub config and runtime state?",
          "This removes persisted config, bot registry, secrets, logs, and runtime state.",
          "Agent workspaces are kept.",
        ].join(" "),
        false,
      );
      if (!confirmed) {
        console.log("Reset canceled.");
        return;
      }
    } finally {
      rl.close();
    }
  }

  if (isServiceAlreadyInstalled()) {
    runNodeCapture(["scripts/dist/service.mjs", "stop"], "inherit");
  } else {
    runNodeCapture(["scripts/dist/supervisor.mjs", "down"], "inherit");
  }

  const reset = resetCopilotHubConfig({ layout });
  initializeCopilotHubLayout({ repoRoot, layout });

  console.log("Copilot Hub config reset completed.");
  if (reset.removedPaths.length > 0) {
    console.log("Removed:");
    for (const removedPath of reset.removedPaths) {
      console.log(`- ${removedPath}`);
    }
  }
  console.log("Kept:");
  console.log("- package installation");
  console.log("- external workspaces (for example Desktop/copilot_workspaces)");
  console.log("Next step: run 'copilot-hub configure' then 'copilot-hub start'.");
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
  const codexBin = await ensureCompatibleCodexBinary({
    autoInstall: false,
    purpose: "start",
  });
  const status = runCodex(codexBin, ["login", "status"], "pipe");
  if (status.ok) {
    console.log("Codex login already configured.");
    return;
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

async function ensureCompatibleCodexBinary({
  autoInstall,
  purpose,
}: {
  autoInstall: boolean;
  purpose: "start" | "restart" | "service";
}): Promise<string> {
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
    return resolved.bin;
  }

  if (!resolved.userConfigured) {
    const compatibleInstalled = resolveCompatibleInstalledCodexBin({ repoRoot });
    if (compatibleInstalled) {
      if (compatibleInstalled !== resolved.bin) {
        const probe = probeCodexVersion({
          codexBin: compatibleInstalled,
          repoRoot,
        });
        if (probe.ok) {
          console.log(`Using compatible Codex CLI ${probe.version} from '${compatibleInstalled}'.`);
        } else {
          console.log(`Using compatible Codex CLI from '${compatibleInstalled}'.`);
        }
      }
      return compatibleInstalled;
    }
  }

  if (resolved.userConfigured) {
    throw new Error(
      buildCodexCompatibilityError({
        resolved,
        probe: currentProbe,
        includeInstallHint: false,
        installCommand: codexInstallCommand,
      }),
    );
  }

  if (!autoInstall && !process.stdin.isTTY) {
    throw new Error(
      buildCodexCompatibilityError({
        resolved,
        probe: currentProbe,
        includeInstallHint: true,
        installCommand: codexInstallCommand,
      }),
    );
  }

  let shouldInstall = autoInstall;
  if (!autoInstall) {
    console.log(buildCodexCompatibilityNotice({ resolved, probe: currentProbe }));
    const rl = createInterface({ input, output });
    try {
      shouldInstall = await askYesNo(
        rl,
        `Install compatible Codex CLI now (${codexInstallCommand})?`,
        true,
      );
    } finally {
      rl.close();
    }
  }

  if (!shouldInstall) {
    throw new Error("Compatible Codex CLI is required before starting services.");
  }

  const install = runNpm(["install", "-g", codexInstallPackageSpec], "inherit");
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

  const installed = resolveCompatibleInstalledCodexBin({ repoRoot });
  if (!installed) {
    throw new Error(
      [
        `Compatible Codex CLI was not detected after installation.`,
        "Set CODEX_BIN to a compatible executable path, then retry.",
      ].join("\n"),
    );
  }

  const installedProbe = probeCodexVersion({
    codexBin: installed,
    repoRoot,
  });
  if (installedProbe.ok) {
    console.log(`Codex CLI ready: ${installedProbe.version} from '${installed}'.`);
  } else {
    console.log(`Codex CLI ready from '${installed}'.`);
  }
  return installed;
}

function runCodex(codexBin, args, stdioMode) {
  const stdio: any = stdioMode === "inherit" ? "inherit" : ["ignore", "pipe", "pipe"];
  const result = spawnCodexSync({
    codexBin,
    args,
    cwd: repoRoot,
    stdio,
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
      "Reset persistent state:",
      "  node scripts/dist/cli.mjs reset-config [--yes]",
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
