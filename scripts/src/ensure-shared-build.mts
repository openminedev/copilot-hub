#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "..", "..");

const requiredOutputs = [
  path.join(repoRoot, "packages", "core", "dist", "index.js"),
  path.join(repoRoot, "packages", "core", "dist", "workspace-policy.js"),
  path.join(repoRoot, "packages", "contracts", "dist", "index.js"),
  path.join(repoRoot, "packages", "contracts", "dist", "control-plane.js"),
  path.join(repoRoot, "apps", "agent-engine", "dist", "index.js"),
  path.join(repoRoot, "apps", "control-plane", "dist", "copilot-hub.js"),
];

await main();

async function main() {
  if (requiredOutputs.every((entry) => fs.existsSync(entry))) {
    return;
  }

  console.log("Shared package build artifacts are missing. Running 'npm run build'...");
  const result = spawnNpm(["run", "build"], {
    cwd: repoRoot,
    stdio: "inherit",
  });

  const code = Number.isInteger(result.status) ? result.status : 1;
  if (code !== 0) {
    if (result.error) {
      throw new Error(formatNpmSpawnError(result.error));
    }

    throw new Error(
      [
        "Failed to build shared packages.",
        "Install project dependencies with 'npm install', then retry.",
      ].join("\n"),
    );
  }

  const missingAfterBuild = requiredOutputs.filter((entry) => !fs.existsSync(entry));
  if (missingAfterBuild.length > 0) {
    throw new Error(
      [
        "Shared package build completed but required artifacts are still missing:",
        ...missingAfterBuild.map((entry) => `- ${path.relative(repoRoot, entry)}`),
      ].join("\n"),
    );
  }
}

function formatNpmSpawnError(error) {
  const code = String(error?.code ?? "")
    .trim()
    .toUpperCase();
  if (code === "ENOENT") {
    return "npm was not found. Install Node.js/npm, then retry.";
  }
  if (code === "EPERM") {
    return "npm cannot be executed (EPERM). Check permissions.";
  }
  const message = error instanceof Error ? error.message : String(error);
  return `Failed to execute 'npm run build': ${firstLine(message)}`;
}

function firstLine(value) {
  return (
    String(value ?? "")
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find(Boolean) ?? ""
  );
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
