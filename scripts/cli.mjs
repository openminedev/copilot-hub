#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import process, { stdin as input, stdout as output } from "node:process";
import { spawnSync } from "node:child_process";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "..");
const nodeBin = process.execPath;
const agentEngineEnvPath = path.join(repoRoot, "apps", "agent-engine", ".env");
const controlPlaneEnvPath = path.join(repoRoot, "apps", "control-plane", ".env");

const action = String(process.argv[2] ?? "start").trim().toLowerCase();

await main();

async function main() {
  switch (action) {
    case "start": {
      runNode(["scripts/configure.mjs", "--required-only"]);
      await ensureCodexLogin();
      runNode(["scripts/supervisor.mjs", "up"]);
      return;
    }
    case "stop": {
      runNode(["scripts/supervisor.mjs", "down"]);
      return;
    }
    case "restart": {
      runNode(["scripts/supervisor.mjs", "restart"]);
      return;
    }
    case "status": {
      runNode(["scripts/supervisor.mjs", "status"]);
      return;
    }
    case "logs": {
      runNode(["scripts/supervisor.mjs", "logs"]);
      return;
    }
    case "configure": {
      runNode(["scripts/configure.mjs"]);
      return;
    }
    default: {
      printUsage();
      process.exit(1);
    }
  }
}

function runNode(scriptArgs) {
  const result = spawnSync(nodeBin, scriptArgs, {
    cwd: repoRoot,
    stdio: "inherit",
    shell: false
  });

  const code = Number.isInteger(result.status) ? result.status : 1;
  if (code !== 0) {
    process.exit(code);
  }
}

async function ensureCodexLogin() {
  const codexBin = resolveCodexBinForStart();
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
        reason ? `Details: ${firstLine(reason)}` : ""
      ]
        .filter(Boolean)
        .join("\n")
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
        login.errorMessage || firstLine(login.stderr) || firstLine(login.stdout) || "Unknown error."
      ]
        .filter(Boolean)
        .join("\n")
    );
  }

  const verify = runCodex(codexBin, ["login", "status"], "pipe");
  if (!verify.ok) {
    throw new Error(
      [
        "Codex login still not detected after login flow.",
        verify.errorMessage || firstLine(verify.stderr) || firstLine(verify.stdout) || "Unknown error."
      ]
        .filter(Boolean)
        .join("\n")
    );
  }

  console.log("Codex login configured.");
}

function runCodex(codexBin, args, stdioMode) {
  const stdio = stdioMode === "inherit" ? "inherit" : ["ignore", "pipe", "pipe"];
  const result = spawnSync(codexBin, args, {
    cwd: repoRoot,
    stdio,
    shell: false,
    encoding: "utf8"
  });

  if (result.error) {
    return {
      ok: false,
      stdout: "",
      stderr: "",
      errorMessage: formatCodexSpawnError(codexBin, result.error)
    };
  }

  const code = Number.isInteger(result.status) ? result.status : 1;
  return {
    ok: code === 0,
    stdout: String(result.stdout ?? "").trim(),
    stderr: String(result.stderr ?? "").trim(),
    errorMessage: ""
  };
}

function resolveCodexBinForStart() {
  const fromEnv = nonEmpty(process.env.CODEX_BIN);
  if (fromEnv) {
    return fromEnv;
  }

  for (const envPath of [agentEngineEnvPath, controlPlaneEnvPath]) {
    const value = readEnvValue(envPath, "CODEX_BIN");
    if (value) {
      return value;
    }
  }

  return "codex";
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
  const value = String(answer ?? "").trim().toLowerCase();
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
  const code = String(error?.code ?? "").trim().toUpperCase();
  if (code === "ENOENT") {
    return `Codex binary '${command}' was not found. Install Codex CLI or set CODEX_BIN.`;
  }
  if (code === "EPERM") {
    return `Codex binary '${command}' cannot be executed (EPERM). Check permissions or CODEX_BIN.`;
  }
  const message = error instanceof Error ? error.message : String(error);
  return `Failed to execute '${command}': ${firstLine(message)}`;
}

function printUsage() {
  console.log("Usage: node scripts/cli.mjs <start|stop|restart|status|logs|configure>");
}
