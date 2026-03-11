#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import process, { stdin as input, stdout as output } from "node:process";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline/promises";
import { parseEnvMap, readEnvLines, setEnvValue, writeEnvLines } from "./env-file-utils.mjs";
import { initializeCopilotHubLayout, resolveCopilotHubLayout } from "./install-layout.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "..", "..");
const layout = resolveCopilotHubLayout({ repoRoot });

initializeCopilotHubLayout({ repoRoot, layout });

const engineEnvPath = layout.agentEngineEnvPath;
const engineExamplePath = path.join(repoRoot, "apps", "agent-engine", ".env.example");
const controlPlaneEnvPath = layout.controlPlaneEnvPath;
const controlPlaneExamplePath = path.join(repoRoot, "apps", "control-plane", ".env.example");
const TELEGRAM_TOKEN_PATTERN = /^\d{5,}:[A-Za-z0-9_-]{20,}$/;
const DEFAULT_CONTROL_PLANE_TOKEN_ENV = "HUB_TELEGRAM_TOKEN_FILE";
const LEGACY_CONTROL_PLANE_TOKEN_ENV = "HUB_TELEGRAM_TOKEN";

const args = new Set(process.argv.slice(2));
const requiredOnly = args.has("--required-only");

await main();

async function main() {
  ensureEnvFile(engineEnvPath, engineExamplePath);
  ensureEnvFile(controlPlaneEnvPath, controlPlaneExamplePath);

  const engineLines = readEnvLines(engineEnvPath);
  const controlPlaneLines = readEnvLines(controlPlaneEnvPath);

  const rl = createInterface({ input, output });

  try {
    if (requiredOnly) {
      await configureRequiredTokens({ rl, controlPlaneLines });
    } else {
      await configureAll({ rl, controlPlaneLines });
      console.log("\nSaved:");
      console.log(`- ${controlPlaneEnvPath}`);
      console.log("\nNext step:");
      console.log("1) copilot-hub start");
    }
  } finally {
    rl.close();
  }

  writeEnvLines(engineEnvPath, engineLines);
  writeEnvLines(controlPlaneEnvPath, controlPlaneLines);
}

async function configureRequiredTokens({ rl, controlPlaneLines }) {
  const controlPlaneTokenEnvName = migrateControlPlaneTokenEnv(controlPlaneLines);

  const postControlPlaneMap = parseEnvMap(controlPlaneLines);
  const currentToken = String(postControlPlaneMap[controlPlaneTokenEnvName] ?? "").trim();

  if (isUsableTelegramToken(currentToken)) {
    console.log("Required tokens already configured.");
    return;
  }

  if (!process.stdin.isTTY) {
    throw new Error(
      "Missing required tokens and no interactive terminal. Run 'copilot-hub configure'.",
    );
  }

  console.log("Missing or invalid hub token. Please enter a valid Telegram bot token.");
  const value = await askRequiredTelegramToken(rl, "Control-plane Telegram token");
  setEnvValue(controlPlaneLines, controlPlaneTokenEnvName, value);
  console.log("Required token saved.");
}

async function configureAll({ rl, controlPlaneLines }) {
  console.log("\nCopilot Hub control-plane configuration\n");

  const controlPlaneTokenEnvDefault = migrateControlPlaneTokenEnv(controlPlaneLines);
  const currentControlPlaneToken = String(
    parseEnvMap(controlPlaneLines)[controlPlaneTokenEnvDefault] ?? "",
  ).trim();

  const newControlPlaneToken = currentControlPlaneToken
    ? await askTelegramToken(rl, "Control-plane Telegram token (press Enter to keep current)", true)
    : await askRequiredTelegramToken(rl, "Control-plane Telegram token");

  if (newControlPlaneToken) {
    setEnvValue(controlPlaneLines, controlPlaneTokenEnvDefault, newControlPlaneToken);
  } else {
    console.log("- Control-plane token left unchanged.");
  }
}

function migrateControlPlaneTokenEnv(lines) {
  const controlPlaneMap = parseEnvMap(lines);
  const configuredTokenEnvName = nonEmpty(
    controlPlaneMap.HUB_TELEGRAM_TOKEN_ENV,
    DEFAULT_CONTROL_PLANE_TOKEN_ENV,
  );
  const shouldMigrateLegacyName = configuredTokenEnvName === LEGACY_CONTROL_PLANE_TOKEN_ENV;
  const nextTokenEnvName = shouldMigrateLegacyName
    ? DEFAULT_CONTROL_PLANE_TOKEN_ENV
    : configuredTokenEnvName;
  setEnvValue(lines, "HUB_TELEGRAM_TOKEN_ENV", nextTokenEnvName);

  if (shouldMigrateLegacyName) {
    const legacyToken = String(controlPlaneMap[LEGACY_CONTROL_PLANE_TOKEN_ENV] ?? "").trim();
    const dedicatedToken = String(controlPlaneMap[DEFAULT_CONTROL_PLANE_TOKEN_ENV] ?? "").trim();
    if (legacyToken && !dedicatedToken) {
      setEnvValue(lines, DEFAULT_CONTROL_PLANE_TOKEN_ENV, legacyToken);
    }
  }

  return nextTokenEnvName;
}

function ensureEnvFile(envPath, examplePath) {
  fs.mkdirSync(path.dirname(envPath), { recursive: true });
  if (fs.existsSync(envPath)) {
    return;
  }

  if (fs.existsSync(examplePath)) {
    fs.copyFileSync(examplePath, envPath);
    return;
  }

  fs.writeFileSync(envPath, "", "utf8");
}

function nonEmpty(value, fallback) {
  const normalized = String(value ?? "").trim();
  return normalized || fallback;
}

async function askRequired(rl, label) {
  while (true) {
    const value = await rl.question(`${label}: `);
    const normalized = String(value ?? "").trim();
    if (normalized) {
      return normalized;
    }
    console.log("Value is required.");
  }
}

async function askRequiredTelegramToken(rl, label) {
  while (true) {
    const value = await askRequired(rl, label);
    if (isUsableTelegramToken(value)) {
      return value;
    }
    console.log("Token format looks invalid. Expected format like: 123456789:AA...");
  }
}

async function askTelegramToken(rl, label, allowEmpty) {
  while (true) {
    const value = await rl.question(`${label}: `);
    const normalized = String(value ?? "").trim();
    if (!normalized && allowEmpty) {
      return "";
    }
    if (isUsableTelegramToken(normalized)) {
      return normalized;
    }
    console.log("Token format looks invalid. Expected format like: 123456789:AA...");
  }
}

function isUsableTelegramToken(value) {
  const token = String(value ?? "").trim();
  if (!token) {
    return false;
  }
  if (token.toLowerCase().includes("replace_me")) {
    return false;
  }
  return TELEGRAM_TOKEN_PATTERN.test(token);
}
