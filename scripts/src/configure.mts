#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import process, { stdin as input, stdout as output } from "node:process";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline/promises";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "..", "..");

const engineEnvPath = path.join(repoRoot, "apps", "agent-engine", ".env");
const engineExamplePath = path.join(repoRoot, "apps", "agent-engine", ".env.example");
const controlPlaneEnvPath = path.join(repoRoot, "apps", "control-plane", ".env");
const controlPlaneExamplePath = path.join(repoRoot, "apps", "control-plane", ".env.example");

const args = new Set(process.argv.slice(2));
const requiredOnly = args.has("--required-only");

await main();

async function main() {
  ensureEnvFile(engineEnvPath, engineExamplePath);
  ensureEnvFile(controlPlaneEnvPath, controlPlaneExamplePath);

  const engineLines = readLines(engineEnvPath);
  const controlPlaneLines = readLines(controlPlaneEnvPath);

  const rl = createInterface({ input, output });

  try {
    if (requiredOnly) {
      await configureRequiredTokens({ rl, controlPlaneLines });
    } else {
      await configureAll({ rl, engineLines, controlPlaneLines });
      console.log("\nSaved:");
      console.log(`- ${relativeFromRepo(engineEnvPath)}`);
      console.log(`- ${relativeFromRepo(controlPlaneEnvPath)}`);
      console.log("\nNext step:");
      console.log("1) npm run start");
    }
  } finally {
    rl.close();
  }

  writeLines(engineEnvPath, engineLines);
  writeLines(controlPlaneEnvPath, controlPlaneLines);
}

async function configureRequiredTokens({ rl, controlPlaneLines }) {
  const controlPlaneMap = parseEnvMap(controlPlaneLines);

  const controlPlaneTokenEnvName = nonEmpty(
    controlPlaneMap.HUB_TELEGRAM_TOKEN_ENV,
    "HUB_TELEGRAM_TOKEN",
  );
  setEnvValue(controlPlaneLines, "HUB_TELEGRAM_TOKEN_ENV", controlPlaneTokenEnvName);

  const postControlPlaneMap = parseEnvMap(controlPlaneLines);

  if (String(postControlPlaneMap[controlPlaneTokenEnvName] ?? "").trim()) {
    console.log("Required tokens already configured.");
    return;
  }

  if (!process.stdin.isTTY) {
    throw new Error(
      "Missing required tokens and no interactive terminal. Run 'npm run configure'.",
    );
  }

  console.log("Missing required token. Please enter value:");
  const value = await askRequired(
    rl,
    `Token value for ${controlPlaneTokenEnvName} (control-plane)`,
  );
  setEnvValue(controlPlaneLines, controlPlaneTokenEnvName, value);
  console.log("Required token saved.");
}

async function configureAll({ rl, engineLines, controlPlaneLines }) {
  const engineMap = parseEnvMap(engineLines);
  const controlPlaneMap = parseEnvMap(controlPlaneLines);

  console.log("\nCopilot Hub token configuration\n");

  const controlPlaneTokenEnvDefault = nonEmpty(
    controlPlaneMap.HUB_TELEGRAM_TOKEN_ENV,
    "HUB_TELEGRAM_TOKEN",
  );
  const controlPlaneTokenEnvName = await ask(
    rl,
    "control-plane token variable",
    controlPlaneTokenEnvDefault,
  );
  setEnvValue(controlPlaneLines, "HUB_TELEGRAM_TOKEN_ENV", controlPlaneTokenEnvName);
  const currentControlPlaneToken = parseEnvMap(controlPlaneLines)[controlPlaneTokenEnvName] ?? "";
  const newControlPlaneToken = await ask(
    rl,
    `Token value for ${controlPlaneTokenEnvName} (control-plane, Enter to keep current)`,
    "",
  );
  if (newControlPlaneToken) {
    setEnvValue(controlPlaneLines, controlPlaneTokenEnvName, newControlPlaneToken);
  } else if (!currentControlPlaneToken) {
    console.log(`- No value set for ${controlPlaneTokenEnvName} yet.`);
  }

  const configureAgentToken = await askYesNo(rl, "Configure TELEGRAM_TOKEN_AGENT_1 now?", true);
  if (configureAgentToken) {
    const currentAgentToken = engineMap.TELEGRAM_TOKEN_AGENT_1 ?? "";
    const newAgentToken = await ask(
      rl,
      "Token value for TELEGRAM_TOKEN_AGENT_1 (agent-engine, Enter to keep current)",
      "",
    );
    if (newAgentToken) {
      setEnvValue(engineLines, "TELEGRAM_TOKEN_AGENT_1", newAgentToken);
    } else if (!currentAgentToken) {
      console.log("- No value set for TELEGRAM_TOKEN_AGENT_1 yet.");
    }
  }
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

function readLines(filePath) {
  const content = fs.readFileSync(filePath, "utf8");
  return content.split(/\r?\n/);
}

function writeLines(filePath, lines) {
  const normalized = [...lines];
  if (normalized.length === 0 || normalized[normalized.length - 1] !== "") {
    normalized.push("");
  }
  fs.writeFileSync(filePath, normalized.join("\n"), "utf8");
}

function parseEnvMap(lines) {
  const map: Record<string, string> = {};
  for (const line of lines) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!match) {
      continue;
    }

    const key = match[1];
    const value = unquote(match[2] ?? "");
    map[key] = value;
  }
  return map;
}

function setEnvValue(lines, key, value) {
  const safeValue = sanitizeValue(value);
  const pattern = new RegExp(`^\\s*${escapeRegex(key)}\\s*=`);
  for (let index = 0; index < lines.length; index += 1) {
    if (!pattern.test(lines[index])) {
      continue;
    }

    lines[index] = `${key}=${safeValue}`;
    return;
  }

  if (lines.length > 0 && lines[lines.length - 1] !== "") {
    lines.push("");
  }
  lines.push(`${key}=${safeValue}`);
}

function sanitizeValue(value) {
  return String(value ?? "")
    .replace(/[\r\n]/g, "")
    .trim();
}

function unquote(value) {
  const raw = String(value ?? "").trim();
  if (!raw) {
    return "";
  }

  if ((raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith("'") && raw.endsWith("'"))) {
    return raw.slice(1, -1);
  }

  return raw;
}

function nonEmpty(value, fallback) {
  const normalized = String(value ?? "").trim();
  return normalized || fallback;
}

function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function ask(rl, label, fallback) {
  const value = await rl.question(`${label}${fallback ? ` [${fallback}]` : ""}: `);
  const normalized = String(value ?? "").trim();
  if (!normalized) {
    return String(fallback ?? "").trim();
  }
  return normalized;
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

function relativeFromRepo(filePath) {
  const relative = path.relative(repoRoot, filePath);
  return relative || filePath;
}
