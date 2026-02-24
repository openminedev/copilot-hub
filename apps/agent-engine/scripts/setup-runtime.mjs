import fs from "node:fs/promises";
import path from "node:path";

const runtimeRoot = process.cwd();
const envExamplePath = path.join(runtimeRoot, ".env.example");
const envPath = path.join(runtimeRoot, ".env");
const registryExamplePath = path.join(runtimeRoot, "bot-registry.example.json");
const dataDir = path.join(runtimeRoot, "data");
const registryPath = path.join(dataDir, "bot-registry.json");
const secretsPath = path.join(dataDir, "secrets.json");

await ensureCopiedIfMissing(envPath, envExamplePath);
await fs.mkdir(dataDir, { recursive: true });
await ensureCopiedIfMissing(registryPath, registryExamplePath);
await ensureJsonFileIfMissing(secretsPath, {});

console.log("Setup complete.");
console.log("- Edit .env and set TELEGRAM_TOKEN_ADMIN.");
console.log("- Edit data/bot-registry.json and set tokenEnv for each channel.");
console.log("- Export matching environment variables (example: TELEGRAM_TOKEN_AGENT_1).");

async function ensureCopiedIfMissing(targetPath, sourcePath) {
  if (await fileExists(targetPath)) {
    console.log(`Keep existing: ${relative(targetPath)}`);
    return;
  }

  await fs.copyFile(sourcePath, targetPath);
  console.log(`Created: ${relative(targetPath)}`);
}

async function ensureJsonFileIfMissing(targetPath, value) {
  if (await fileExists(targetPath)) {
    console.log(`Keep existing: ${relative(targetPath)}`);
    return;
  }

  const json = `${JSON.stringify(value, null, 2)}\n`;
  await fs.writeFile(targetPath, json, "utf8");
  console.log(`Created: ${relative(targetPath)}`);
}

async function fileExists(targetPath) {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

function relative(targetPath) {
  return path.relative(runtimeRoot, targetPath).replace(/\\/g, "/");
}
